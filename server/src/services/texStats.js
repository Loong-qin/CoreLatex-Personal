/** LaTeX 源码字数/结构统计 */

// CJK 统一表意文字（含扩展 A、兼容表意）、日文假名、韩文音节：每字计 1 词
const CJK = /[㐀-䶿一-鿿豈-﫿぀-ヿ가-힯]/g;
const HEADING_CMDS = /\\(?:part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?/g;
const FIG_TABLE_BEGIN = /\\begin\{(?:figure|table)\*?\}/g;
const FIG_TABLE_ENV = /\\begin\{(?:figure|table)\*?\}[\s\S]*?\\end\{(?:figure|table)\*?\}/g;
const DISPLAY_ENV = /\\begin\{(equation|align|gather|multline|flalign|alignat|eqnarray)(\*?)\}[\s\S]*?\\end\{\1\2\}/g;
const DISPLAY_DOLLARS = /\$\$[\s\S]*?\$\$/g;
const DISPLAY_BRACKET = /\\\[([\s\S]*?)\\\]/g;
const INLINE_PAREN = /\\\(([\s\S]*?)\\\)/g;
const INLINE_DOLLAR = /(?<!\\)\$(?:\\.|[^$\\])*\$/g;
const COMMAND = /\\[a-zA-Z]+\*?|\\./g;

/** 统计文本词数：英文按空格分词（含字母数字的 token 计 1），CJK 每字 1 词 */
function countWords(text) {
  let count = 0;
  const cjk = text.match(CJK);
  if (cjk) count += cjk.length;
  const stripped = text.replace(CJK, ' ');
  for (const tok of stripped.split(/\s+/)) {
    if (tok && /[A-Za-z0-9]/.test(tok)) count++;
  }
  return count;
}

/** 剥离注释：未被 \ 转义的 % 到行尾 */
function stripComments(text) {
  return text.split('\n').map((line) => {
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '%') {
        let bs = 0;
        let j = i - 1;
        while (j >= 0 && line[j] === '\\') { bs++; j--; }
        if (bs % 2 === 0) return line.slice(0, i);
      }
    }
    return line;
  }).join('\n');
}

/** 从 openIdx（text[openIdx] === open）开始匹配配对括号，返回 close 之后的位置，失败 -1 */
function matchBracket(text, openIdx, open, close) {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === '\\') { i++; continue; }
    if (text[i] === open) depth++;
    else if (text[i] === close) {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** 提取标题命令及其花括号参数，返回 { args, spans }（spans 为需从正文剔除的区间） */
function extractHeadings(text) {
  const args = [];
  const spans = [];
  HEADING_CMDS.lastIndex = 0;
  let m;
  while ((m = HEADING_CMDS.exec(text))) {
    let i = m.index + m[0].length;
    while (i < text.length && /\s/.test(text[i])) i++;
    if (text[i] === '[') {
      const end = matchBracket(text, i, '[', ']');
      if (end < 0) continue;
      i = end;
      while (i < text.length && /\s/.test(text[i])) i++;
    }
    if (text[i] !== '{') continue;
    const end = matchBracket(text, i, '{', '}');
    if (end < 0) continue;
    args.push(text.slice(i + 1, end - 1));
    spans.push([m.index, end]);
  }
  return { args, spans };
}

/** 剔除区间（替换为空格避免 token 合并） */
function removeSpans(text, spans) {
  if (!spans.length) return text;
  const chars = text.split('');
  for (const [s, e] of spans) {
    for (let i = s; i < e; i++) chars[i] = ' ';
  }
  return chars.join('');
}

function countMatches(text, re) {
  re.lastIndex = 0;
  const m = text.match(re);
  return m ? m.length : 0;
}

/**
 * sources: 字符串数组（多个 .tex 内容）
 * 返回 {words, bodyWords, headingWords, otherWords, headings, figuresAndTables, inlineMath, displayMath}
 */
export function computeTexStats(sources) {
  const result = {
    words: 0, bodyWords: 0, headingWords: 0, otherWords: 0,
    headings: 0, figuresAndTables: 0, inlineMath: 0, displayMath: 0,
  };
  for (const src of sources || []) {
    const text = stripComments(String(src || ''));
    result.words += countWords(text);

    const { args, spans } = extractHeadings(text);
    result.headings += args.length;
    for (const a of args) result.headingWords += countWords(a);

    result.figuresAndTables += countMatches(text, FIG_TABLE_BEGIN);

    // 剔除数学区段并计数（先 display 后 inline，避免 $$ 被拆成两个 $）
    let body = text;
    body = body.replace(DISPLAY_ENV, () => { result.displayMath++; return ' '; });
    body = body.replace(DISPLAY_DOLLARS, () => { result.displayMath++; return ' '; });
    body = body.replace(DISPLAY_BRACKET, () => { result.displayMath++; return ' '; });
    body = body.replace(INLINE_PAREN, () => { result.inlineMath++; return ' '; });
    body = body.replace(INLINE_DOLLAR, () => { result.inlineMath++; return ' '; });

    // 剔除图表环境内容、标题命令及参数、剩余命令本身（保留花括号参数文本）
    body = body.replace(FIG_TABLE_ENV, ' ');
    body = removeSpans(body, spans);
    body = body.replace(COMMAND, ' ');

    result.bodyWords += countWords(body);
  }
  result.otherWords = Math.max(0, result.words - result.bodyWords - result.headingWords);
  return result;
}
