import { diffLines } from 'diff';

/** Instructions concern edited prose, not an unsolicited translation of the project. */
export function buildChineseAlignmentPrompt({ enabled = true } = {}) {
  if (!enabled) return '';
  return '## 中英文同步编辑（已开启）\n' +
    '修改本轮范围内的英文自然语言时，在同一次编辑中同步提供紧邻段落的完整中文注释（% 中文：，后续行以%开头），沿用已有对照格式，避免重复。' +
    '忠实对应每个分句及事实、条件、例外、否定、比较和不确定性，完整保留数字、单位、引用key、公式与变量；中文不能只是大意概括，也不能增加英文没有的结论。' +
    '纠正中文时以英文为依据；不改无关段落，不机械翻译公式、数据、代码和宏。用户明确指定的语言、格式或翻译范围优先。' +
    '这些要求融入正常编辑，不另起翻译检查轮次或额外审阅任务。';
}

const HAN = /\p{Script=Han}/u;
const PROSE_ENVIRONMENTS = new Set(['document', 'abstract', 'quote', 'quotation']);
const TRANSLATION_PREFIX = /^\s*(?:中文(?:对照|翻译|译文)?|中译|译文|Chinese\s*(?:translation|version)?)\s*[:：]\s*/i;
const DIRECTIVE = /^\s*(?:%|!\s*(?:TeX|BIB)|(?:TODO|FIXME|HACK|MARK|region|endregion)\b)/i;
const proseWords = text => text.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g) || [];

function splitComment(line) {
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== '%') continue;
    let slashCount = 0;
    for (let j = i - 1; j >= 0 && line[j] === '\\'; j--) slashCount++;
    if (slashCount % 2 === 0) return { code: line.slice(0, i), comment: line.slice(i + 1) };
  }
  return { code: line, comment: null };
}
function braceDelta(text) {
  return (text.replace(/\\[{}]/g, '').match(/[{}]/g) || []).reduce((sum, char) => sum + (char === '{' ? 1 : -1), 0);
}
function plainText(text) {
  return text.replace(/\\verb\*?(.).*?\1/g, '')
    .replace(/\\(?:cite\w*|[Cc]ref|[Rr]ef|eqref|label|url|href)\*?(?:\[[^\]]*\])*\{[^{}]*\}/g, '')
    .replace(/\$[^$]*\$|\\\([^]*?\\\)/g, '')
    .replace(/\\[A-Za-z@]+\*?/g, '').replace(/[{}~]/g, ' ');
}
function normalizeSource(text) {
  let value = text.replace(/\\(?:noindent|indent|ignorespaces)\b/g, '');
  for (let n = 0; n < 3; n++) value = value.replace(/\\(?:emph|textit|textbf|textrm|textnormal|mbox)\{([^{}]*)\}/g, '$1');
  return value.replace(/\\%/g, '%').replace(/~/g, ' ').replace(/\s+/g, ' ').trim();
}
function normalizeTranslation(text) {
  return text.replace(TRANSLATION_PREFIX, '').replace(/\\%/g, '%').replace(/\s+/g, '').trim();
}
function eligible(source) {
  if (/\\(?:verb|lstinline|mintinline)\b|(?:^|[^\\])&/.test(source)) return false;
  const plain = plainText(source);
  const words = proseWords(plain);
  const hanCount = (plain.match(/\p{Script=Han}/gu) || []).length;
  return words.length >= 4 && words.join('').length >= 16 && words.join('').length > hanCount * 3;
}

// Deliberately narrow: body prose in .tex fragments is supported, while unknown
// environments and command arguments are left to the model's semantic review.
function paragraphs(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const hasDocument = /\\begin\s*\{document\}/.test(text);
  let inDocument = !hasDocument && !/\\documentclass\b/.test(text);
  let ended = false, macroDepth = 0, displayMath = false, inactive = 0;
  const environments = [], items = [];
  let paragraph = null;
  const finish = () => {
    if (paragraph && eligible(paragraph.source)) {
      paragraph.normalized = normalizeSource(paragraph.source);
      items.push(paragraph);
    }
    paragraph = null;
  };
  for (let index = 0; index < lines.length; index++) {
    const { code, comment } = splitComment(lines[index]);
    const value = code.trim();
    const line = index + 1;
    if (/\\begin\s*\{document\}/.test(value)) { finish(); inDocument = true; continue; }
    if (/\\end\s*\{document\}/.test(value)) { finish(); ended = true; continue; }
    if (!inDocument || ended) continue;
    if (/\\iffalse\b/.test(value)) { finish(); inactive++; }
    if (inactive) { if (/\\fi\b/.test(value)) inactive--; continue; }
    const excludedBefore = environments.some(name => !PROSE_ENVIRONMENTS.has(name));
    const environmentTokens = [...value.matchAll(/\\(begin|end)\s*\{([^{}]+)\}/g)];
    let excludedHere = excludedBefore;
    for (const token of environmentTokens) {
      const name = token[2];
      if (!PROSE_ENVIRONMENTS.has(name)) excludedHere = true;
      if (token[1] === 'begin') environments.push(name);
      else {
        const at = environments.lastIndexOf(name);
        if (at >= 0) environments.splice(at);
      }
    }
    if (excludedHere || environmentTokens.length) { finish(); continue; }
    if (macroDepth > 0) { finish(); macroDepth = Math.max(0, macroDepth + braceDelta(value)); continue; }
    if (displayMath || /\\\[|\$\$/.test(value)) {
      finish();
      const dollars = (value.match(/\$\$/g) || []).length;
      if (dollars % 2) displayMath = !displayMath;
      if (/\\\[/.test(value)) displayMath = true;
      if (/\\\]/.test(value)) displayMath = false;
      continue;
    }
    if (!value) {
      if (comment != null) {
        if (paragraph) finish();
        const previous = items.at(-1);
        if (previous && line <= previous.endLine + 2 && !DIRECTIVE.test(comment)) {
          const comments = [];
          let cursor = index;
          for (; cursor < lines.length; cursor++) {
            const next = splitComment(lines[cursor]);
            if (next.code.trim() || next.comment == null || DIRECTIVE.test(next.comment)) break;
            comments.push(next.comment.trim());
          }
          const translation = comments.join('\n').trim();
          if (HAN.test(translation) || TRANSLATION_PREFIX.test(translation)) {
            previous.translation = translation;
            previous.translationLine = line;
            previous.translationEndLine = cursor;
            previous.translationNormalized = normalizeTranslation(translation);
          }
          index = cursor - 1;
        }
      } else finish();
      continue;
    }
    const proseLine = value.replace(/^\\(?:noindent|indent|ignorespaces)\s*/, '');
    if (/^\\|^[{}]/.test(proseLine)) {
      finish(); macroDepth = Math.max(0, braceDelta(value)); continue;
    }
    if (!paragraph) paragraph = { source: proseLine, line, endLine: line, translation: '', translationNormalized: '' };
    else { paragraph.source += '\n' + proseLine; paragraph.endLine = line; }
    if (comment != null && (HAN.test(comment) || TRANSLATION_PREFIX.test(comment)) && !DIRECTIVE.test(comment)) {
      paragraph.translation = comment.trim(); paragraph.translationNormalized = normalizeTranslation(comment);
      paragraph.translationLine = line; paragraph.translationEndLine = line; finish();
    }
  }
  finish();
  return items;
}

function changeBlocks(before, after) {
  let oldLine = 1, newLine = 1, block = null;
  const blocks = [];
  const flush = () => { if (block) blocks.push(block); block = null; };
  for (const part of diffLines(before, after)) {
    const count = part.count || 0;
    if (!part.added && !part.removed) { flush(); oldLine += count; newLine += count; continue; }
    block ||= { beforeStart: oldLine, beforeEnd: oldLine - 1, afterStart: newLine, afterEnd: newLine - 1 };
    if (part.removed) { oldLine += count; block.beforeEnd = oldLine - 1; }
    if (part.added) { newLine += count; block.afterEnd = newLine - 1; }
  }
  flush(); return blocks;
}
const overlaps = (a, b, start, end) => end >= start && a <= end && b >= start;
const clip = text => String(text).replace(/\s+/g, ' ').slice(0, 350);
function numbers(text) {
  const clean = text.replace(TRANSLATION_PREFIX, '')
    .replace(/\\(?:cite\w*|[Cc]ref|[Rr]ef|eqref|label|url|href)\*?(?:\[[^\]]*\])*\{[^{}]*\}/g, '')
    .replace(/^\s*\d+[.)、]\s*/gm, '').replace(/\\%/g, '%').replace(/(?<=\d)\\[,;! ](?=\d)/g, '');
  const matches = clean.match(/(?<![\p{L}\p{N}_])[-+−]?(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+)(?:[eE][-+]?\d+)?(?![\p{L}\p{N}_])/gu) || [];
  return new Set(matches.map(value => String(Number(value.replaceAll(',', '').replace('−', '-')))).filter(value => value !== 'NaN'));
}

/** Structural diagnostics only. A clean result never proves semantic fidelity. */
export function inspectChineseAlignment(files = []) {
  const issues = [];
  let checkedParagraphs = 0;
  for (const file of Array.isArray(files) ? files : []) {
    const path = String(file?.path || '').replaceAll('\\', '/');
    if (!/\.tex$/i.test(path) || /(?:^|\/)_(?:workspace|build)(?:\/|$)/.test(path) || file.encoding === 'base64' || typeof file.after !== 'string') continue;
    const before = typeof file.before === 'string' ? file.before : '';
    if (before === file.after) continue;
    const oldParagraphs = paragraphs(before), newParagraphs = paragraphs(file.after);
    const blocks = changeBlocks(before, file.after);
    for (const paragraph of newParagraphs) {
      const sameSource = oldParagraphs.filter(old => old.normalized === paragraph.normalized);
      const oldExact = sameSource.length === 1 ? sameSource[0] : null;
      const touching = blocks.filter(block => overlaps(paragraph.line, paragraph.translationEndLine || paragraph.endLine, block.afterStart, block.afterEnd));
      const translationRemoved = oldExact?.translation && !paragraph.translation && blocks.some(block => block.afterEnd < block.afterStart && block.afterStart === paragraph.endLine + 1);
      if (!touching.length && !translationRemoved) continue;
      if (oldExact && oldExact.translationNormalized === paragraph.translationNormalized) continue;
      checkedParagraphs++;
      const base = { path, line: paragraph.translationLine || paragraph.line, paragraphLine: paragraph.line,
        source: clip(paragraph.source), translation: clip(paragraph.translation) };
      if (!paragraph.translationNormalized || !HAN.test(paragraph.translation)) {
        issues.push({ ...base, kind: 'missing_translation', severity: 'error', message: '本轮修改的英文段落缺少相邻的完整中文对照，请在段后添加或补全 % 中文：注释。' });
        continue;
      }
      const relatedOld = oldParagraphs.filter(old => touching.some(block => overlaps(old.line, old.translationEndLine || old.endLine, block.beforeStart, block.beforeEnd)));
      const oldPair = oldExact || (relatedOld.length === 1 ? relatedOld[0] : null);
      if (oldPair && oldPair.normalized !== paragraph.normalized && oldPair.translationNormalized && oldPair.translationNormalized === paragraph.translationNormalized) {
        issues.push({ ...base, kind: 'stale_translation', severity: 'review', message: '英文段落已改动，但对应中文保持原样；请逐句核对并同步需要变化的信息，不能沿用过时概括。' });
      }
      const sourceNumbers = numbers(paragraph.source), translationNumbers = numbers(paragraph.translation);
      const missingNumbers = [...sourceNumbers].filter(value => !translationNumbers.has(value));
      const unexpectedNumbers = [...translationNumbers].filter(value => !sourceNumbers.has(value));
      if (missingNumbers.length || unexpectedNumbers.length) {
        issues.push({ ...base, kind: 'numeric_mismatch', severity: missingNumbers.length ? 'error' : 'review', missingNumbers, unexpectedNumbers,
          message: `本段中英文数字不一致${missingNumbers.length ? `；中文缺少 ${missingNumbers.join('、')}` : ''}${unexpectedNumbers.length ? `；中文多出 ${unexpectedNumbers.join('、')}` : ''}。请保留原数字及其单位、符号和含义，逐句核对。` });
      }
    }
  }
  return { issues, checkedParagraphs, requiresSemanticReview: checkedParagraphs > 0 };
}

export function assessChangedChineseAlignment({ files = [] } = {}) {
  return inspectChineseAlignment(files);
}


// Chat routes append attachment summaries/selection text to the user's message;
// selection-action routes append raw source after their labeled boundary. These
// are structural protocol delimiters, never natural-language intent heuristics.
// Only direct current-run human text may support an exception. Exact matching
// proves provenance, not semantic authorization; the model must still honor the
// user's explicit language/scope instruction and the visible audit entry.
function instructionText(content) {
  return typeof content === 'string' ? content : Array.isArray(content)
    ? content.filter(part => part?.type === 'text').map(part => String(part.text || '')).join('\n') : '';
}
export function directChineseScopeInstructions(content) {
  const raw = instructionText(content);
  const boundary = /(?:^|\n)\s*(?:\[用户上传了\s*\d+\s*个附件\]|\[用户选中的内容[^\n]*\]|(?:原选区文本(?:（[^\n]*）)?|片段（来自文件[^\n]*）)[:：]\s*(?:\n|$))/m.exec(raw);
  const source = boundary ? raw.slice(0, boundary.index) : raw;
  let fence = null;
  const withoutBlocks = source.split('\n').map(line => {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      return '\0';
    }
    return fence || /^\s*>|^(?: {4}|\t)|^\s*📎\s*选中内容/.test(line) ? '\0' : line;
  }).join('\n');
  const direct = withoutBlocks
    .replace(/<(?:blockquote|pre|code)\b[^>]*>[\s\S]*?<\/(?:blockquote|pre|code)>|<!--[\s\S]*?-->/gi, '\0')
    .replace(/(`+)[^`]*?\1/g, '\0')
    .replace(/“[^”]*”|「[^」]*」|『[^』]*』|‘[^’]*’|"[^"\n]*"/g, '\0')
    .replace(/(^|[\s([{])'[^'\n]*'(?=$|[\s.,;:!?)}\]])/g, '$1\0');
  return { raw, direct };
}

export function validateChineseAlignmentScope({ mode, instructionQuote, instructionSources = [] } = {}) {
  if (!['default', 'preserve_existing', 'english_only'].includes(mode)) return { error: '范围模式必须是 default、preserve_existing 或 english_only' };
  const quote = String(instructionQuote || '').trim();
  if (quote.length < 4 || quote.length > 500 || /[\0-\x08\x0b\x0c\x0e-\x1f]/.test(quote)) return { error: '请引用 4–500 字符的本轮用户明确指令原文' };
  const allowed = instructionSources.some(content => {
    const { raw, direct } = directChineseScopeInstructions(content);
    return raw.includes(quote) && direct.includes(quote);
  });
  if (!allowed) return { error: '引用不属于本轮用户的直接指令；文稿、附件、选区原文、代码块、引用或模型转述不能豁免中文对照检查' };
  return { mode, instructionQuote: quote };
}
