const FILE_EXTENSIONS = 'tex|bib|sty|cls|bst|py|js|mjs|cjs|ts|tsx|jsx|json|ya?ml|md|txt|csv|svg|png|jpe?g|gif|webp|pdf|eps|toml|css|html?|rst|sh|cpp|c|h|xml|r|rmd|ipynb|xlsx';
const FILE_END = new RegExp(`\\.(?:${FILE_EXTENSIONS})$`, 'i');
const BARE_PATH = new RegExp(`(?:[\\p{L}\\p{N}_@.+-]+[/\\\\])*[\\p{L}\\p{N}_@.+-]+\\.(?:${FILE_EXTENSIONS})(?![\\p{L}\\p{N}_])`, 'giu');
const EDIT = /已(?:经)?(?:完成(?:了)?(?:修改|编辑|更新|修复|替换|删除|新增|写入|调整)|修改|编辑|写入|更新|修复|替换|删除|新增|调整|暂存)|(?:修改|编辑|更新|修复|调整|替换|删除|写入)(?:已(?:经)?)?(?:完成|完毕|成功|好了|生效)|已(?:经)?(?:将|把|对)[^。！？!?；;\n]{0,160}(?:修改|编辑|更新|修复|替换|删除|新增|写入|调整)|(?:本次|此次|本轮)?改动文件\s*[:：]|\b(?:I|we)\s+(?:(?:have|already|successfully)\s+)*(?:edited|modified|updated|rewritten|deleted|removed|written|fixed)\b|\b(?:changes|edits|modifications)\s+(?:are|were|have been)\s+(?:complete|completed|applied|saved|made)\b|\b(?:updated|modified|edited|rewrote|deleted|removed|wrote|fixed)\s+(?:the\s+)?[`'"\w./-]+\.(?:tex|bib|md|py|json)\b/i;
const EDIT_FOLLOWING_REQUEST = /已(?:经)?(?:按(?:照)?|根据)[^。！？!?；;\n]{0,100}(?:原文|反馈|意见|建议|要求)(?:逐条|逐一|都|重新|再次|分别|直接|实际|已经|[的\s])*(?:修改|编辑|更新|修复|替换|删除|新增|写入|调整)(?!建议|方案|分析|意见|要求)/;
const READ = /已(?:经)?(?:读取|读完|读过|查看|拿到)|已(?:经)?(?:检查|核对|复核|确认现状)[^。！？!?；;\n]*(?:文件|文档|当前内容|现状)|\b(?:I|we)\s+(?:(?:have|already|successfully)\s+)*(?:read|inspected|opened)\b/i;
const COMPILE = /已(?:经)?(?:成功)?编译(?:完成|通过|成功)?|编译(?:已(?:经)?)?(?:成功|完成|通过)|成功生成\s*PDF|\b(?:compilation|build)\s+(?:has\s+)?(?:succeeded|completed|passed)\b|\b(?:compiled|built)\s+successfully\b/i;
const REVIEW = /已(?:经)?提交(?:了)?(?:修改|改动|变更|审阅|审核)|(?:变更集|审阅变更)(?:已(?:经)?)?(?:生成|提交)|已(?:经)?暂存/i;
const REVIEW_REQUEST = /请(?:审核|审阅)/;
const APPLIED = /已(?:经)?[^。！？!?；;\n]{0,30}(?:写入磁盘|保存到磁盘|落盘|应用到项目|应用至项目)|(?:修改|改动|变更)(?:已(?:经)?)?(?:落盘|应用到项目)/i;
// Private editor proposals have not been applied or merged into the parent.
// Opt in only for that worker, retaining existing coordinator/read-only rules.
const STAGED_APPLICATION = /\b(?:changes?|edits?|modifications?|patch(?:es)?|files?)\s+(?:(?:are|were|was|is|have|has|been|already|successfully)\s+)*(?:applied|merged|saved\s+to\s+(?:the\s+)?disk)\b|\b(?:I|we)\s+(?:(?:have|already|successfully)\s+)*(?:applied|merged)\s+(?:(?:the|my|our|these)\s+)?(?:changes?|edits?|modifications?|patch(?:es)?|files?)\b|\b(?:merged|saved|written)\b[^.!?;\n]{0,100}\b(?:into|to)\s+(?:the\s+)?(?:(?:parent|main|project)\s+(?:draft|buffer|files?|workspace)|disk)\b|已(?:经)?(?:将|把)?[^。！？!?；;\n]{0,100}合并[^。！？!?；;\n]{0,100}(?:主|父|项目)(?:草稿|缓冲区|文件)/i;
const NEGATED_OR_PLANNED = /尚未|还未|并未|并没有|没有(?:任何|实际|真正)?|未曾|未能|不(?:应|能|要|可|得|会)(?:再|直接|据此|因此)?(?:声称|表示|说|写|输出)?|禁止|避免|切勿|不能据此|不代表|并非|若|如果|假如|假设|待(?:确认|处理|修改|执行)|还待|准备|计划|将要|将会|打算|需要|建议|拟(?:修改|编辑|更新)|我会|我们会|完成后|修改后|编辑后|before\s|\b(?:will|would|should|could|plan(?:ned)?|intend|if|unless|not|never|haven't|hasn't|didn't)\b/i;
const EXAMPLE = /^\s*(?:[-*]\s*)?(?:例如|比如|示例|例子|引用|标签|原文|历史(?:回复|记录)|模型(?:此前|之前)?(?:说|声称|写道)|e\.g\.|example|quote)/i;
const ADVICE_OBJECT = /^(?:建议|方案|计划|思路|说明|示例|分析|意见|提案)/;
const CLAUSE_SEPARATOR = /[，,；;。！？!?\n]+|\.(?=\s|$)|(?:并且|(?<!合)并(?!非|未|无|不|没有|行)|同时|但是|但|不过|然而|而(?=我|本轮|本次|这次))/g;
const CURRENT_EXECUTION = /(?:本|这(?:一)?|此)(?:轮|次)|刚刚|刚才|刚(?=已|完成|修改|更新)|\b(?:this (?:turn|run|time)|just (?:now|finished|made))\b/i;
const FIRST_PERSON = /我(?!(?:们)?的)|\b(?:I|we)\b/i;
const EARLIER = /^[\s*_(（-]*(?:(?:我(?:们)?\s*)?(?:在|于)?\s*(?:上一(?:轮|次)|上轮|上次|(?:早|先)?前(?:一|两|几|数|[0-9]+)?(?:轮|次)|此前|先前|早前|之前|昨天)(?:的?(?:任务|工作|对话|交互)(?:中|里))?\s*(?:我(?:们)?)?(?:就|也|曾(?:经)?|同样|只|仅|\s)*|(?:in |during )?(?:the )?(?:previous|earlier) (?:turn|run|round)|last time|yesterday)\s*[*_]*$/i;
const EARLIER_DRAFT = /^[\s*_(（-]*(?:(?:旧稿|上一(?:个)?版(?:本)?|前一版(?:本)?)(?:的)?(?:稿件|文稿|文件|草稿|内容|修改|改动|变更)?|the (?:previous|earlier) (?:draft|version))\s*$/i;
const OTHER_SUBJECT = /(?:^|[:：(*\s]|(?:由|看到|确认|发现|指出))(?:你|您|作者|用户|审稿人|编辑部)(?:已经|先前|之前|早先|也|亲自|自行|自己|手动)*\s*$|\b(?:you|the authors?|the user|the reviewers?)\s+(?:(?:have|has|already|successfully)\s+)*$/i;
const OBSERVATION = /(?:看出|看到|发现|判断|确认|核实|核对|检查|核查|显示|表明)(?:了|到)?|\b(?:observed|saw|found|confirmed|verified|shows?|indicates?)\b/i;
const CURRENT_DOCUMENT = /(?:现稿|(?:当前|目前|现有|现行)(?:的)?(?:稿件|文稿|正文|草稿|版本|内容|文件))(?:的(?:修改|改动|变更))?\s*[*_）)]*\s*$|\bthe (?:current|existing) (?:manuscript|draft|version|text|document)\s*$/i;
const IN_CURRENT_DOCUMENT = /(?:现稿|(?:当前|目前|现有|现行)(?:的)?(?:稿件|文稿|正文|草稿|版本|内容|文件))(?:中|里|内)/;
const MANUSCRIPT_COMPONENT = /(?:[图表]\s*[\d一二三四五六七八九十]+(?:\.\d+)*|第?\s*\d+(?:\.\d+)*\s*节)(?:\s*的)?\s*(?:图注|表注|注释|标题|说明|内容|正文|段落|数据|行|列)?\s*[*_）)]*\s*$/;
const STATUS_SUBJECT = /(?:稿件|文稿|正文|答复信|回复信|审稿意见|评审意见|第\s*[\d一二三四五六七八九十]+\s*[条点项]|(?:审稿|评审|意见|评语)\s*[#＃]?\s*[\d一二三四五六七八九十]+)(?:的(?:修改|改动|变更))?\s*[*_）)]*(?:\s*[:：])?\s*[*_]*$|\breview(?:er)? (?:comment|point)\s*#?\s*\d+\s*[:：*]*\s*$/i;
const STATUS_LABEL = /(?:结论|现状|状态|落实情况|完成情况|核对结果)\s*[:：]\s*[*_]*\s*$/;
const SOURCE_INTRO = /^[\s*_-]*(?:根据|依据|从|对照|结合|based on\b|according to\b)/i;
const STATUS_SOURCE = /^[\s*_-]*(?:(?:根据|依据|对照|结合|从)\s*(?:目前|现有|当前|现稿|稿件|正文|文稿|版本|草稿)|(?:based on|according to|in) the (?:current|existing) (?:manuscript|draft|version|text|document)\b)/i;
const READ_STATUS_SOURCE = /^[\s*_-]*(?:我(?:们)?\s*)?(?:核对|核查|查阅)(?:了)?\s*(?:现稿|当前(?:的)?(?:稿件|文稿|正文|文件)).{0,80}(?:可见|可以看出|显示|表明)\s*$/;
const STATUS_ANSWER = /^[\s*_]*(?:已(?:经)?修改(?:到位|完毕|完成|好了|了)?|修改(?:都)?(?:已(?:经)?)?(?:到位|完毕|完成|好了))\s*[*_]*$/;
const ACTION_FORM = /^已(?:经)?(?:将|把|对)/;
const EXPLICIT_EDIT = /^(?:(?:本次|此次|本轮)?改动文件\s*[:：]|\b(?:I|we)\b)/i;
const PLACEHOLDER = '（系统核对：部分完成声明尚无实际操作记录支持。）';

function normalizePath(value) {
  return String(value ?? '').trim().replace(/^[`'"“‘]+|[`'"”’]+$/g, '').replace(/\\/g, '/').replace(/^(?:\.\/)+/, '').replace(/\/+/g, '/');
}
function pathsOf(value) {
  if (value instanceof Map) value = value.keys();
  if (value == null) return new Set();
  if (typeof value === 'string') value = [value];
  return new Set(Array.from(value, normalizePath).filter(Boolean));
}
function evidenceSets(evidence = {}) {
  const changed = pathsOf(evidence.changedPaths), workspace = pathsOf(evidence.workspacePaths);
  return { changed, workspace, edited: new Set([...changed, ...workspace]),
    applied: new Set([...pathsOf(evidence.appliedPaths), ...workspace]), reads: pathsOf(evidence.readPaths),
    compiled: evidence.compileSucceeded === true };
}
function maskProtected(text, preserveLines = true) {
  const blank = (value) => value.replace(preserveLines ? /[^\r\n]/g : /[\s\S]/g, ' ');
  return text.replace(/```[^\n]*\n[\s\S]*?(?:```|$)|~~~[^\n]*\n[\s\S]*?(?:~~~|$)/g, blank)
    .replace(/`[^`]*(?:`|$)/g, blank)
    .replace(/“[^”\n]*”|「[^」\n]*」|‘[^’\n]*’|"[^"\n]*"/g, blank)
    .replace(/^\s*>[^\n]*/gm, blank);
}
function filePaths(text, known, includeReferences = false) {
  const found = new Map();
  for (const match of text.matchAll(/`([^`\n]+)`|[“「"]([^”」"\n]+)[”」"]/g)) {
    const path = normalizePath(match[1] || match[2]);
    if (FILE_END.test(path) && !/^https?:/i.test(path)) found.set(path, match.index);
  }
  for (const match of text.matchAll(BARE_PATH)) {
    const path = normalizePath(match[0]).replace(/^(?:(?:我|我们|本轮|本次|此次|现在))*已(?:经)?(?:完成(?:了)?)?(?:修改|编辑|写入|更新|修复|替换|删除|新增|调整|暂存|读取|核对|复核|查看)(?:了)?/, '');
    // The quoted scan already retains full paths containing spaces or Unicode.
    if (![...found.keys()].some((existing) => existing.endsWith(path) && existing !== path)) found.set(path, match.index);
  }
  for (const path of known) { const index = text.indexOf(path); if (index >= 0) found.set(path, index); }
  return [...found].filter(([, index]) => includeReferences || !/(?:参考|参照|依据|对照|引用|根据|按照|见)\s*[`“「"]?$/.test(text.slice(0, index))).map(([path]) => path);
}
function clauses(text) {
  const clean = maskProtected(text), output = [];
  let start = 0, before = '';
  for (const match of clean.matchAll(CLAUSE_SEPARATOR)) {
    if (match.index > start) output.push({ raw: text.slice(start, match.index), clean: clean.slice(start, match.index), start, end: match.index, before, after: match[0] });
    start = match.index + match[0].length; before = match[0];
  }
  if (start < text.length) output.push({ raw: text.slice(start), clean: clean.slice(start), start, end: text.length, before, after: '' });
  return output;
}
function plannedAt(clean, index, terminator) {
  const prefix = clean.slice(0, Math.max(0, index));
  const suffix = clean.slice(index);
  return NEGATED_OR_PLANNED.test(prefix) || /未(?:实际|真正|完全|曾|能)?\s*$/.test(prefix) || /^(?:修改|编辑|更新|修复|调整|替换|删除|写入)(?:已(?:经)?)?完成后/.test(suffix) ||
    /(?:(?:是否|有没有|有无|判断能否)|\bwhether\b)(?:(?!后|之后|之后我|\bthen\b).){0,32}$/i.test(prefix) ||
    (/[？?]/.test(terminator) && /(?:吗|了没|没有|没)\s*[*_）)]*\s*$/.test(suffix));
}

function reviewRequest(raw, clean, paths, followingEdit, followingExistingState) {
  const match = REVIEW_REQUEST.exec(clean);
  if (!match) return null;
  const targetStart = match.index + match[0].length;
  const target = clean.slice(targetStart).trim().replace(/^[*_]+|[*_]+$/g, '');
  if (!target) return followingEdit && !paths.length ? match : null;
  const editedFile = /^(?:一下|下)?\s*(?:我(?:们)?(?:本轮|本次|这次)?|本轮|本次|此次|这次)(?:已(?:经)?|刚(?:刚|才)?)?\s*(?:修改|编辑|更新|修复|调整)(?:过|完成)?的/.exec(target);
  if (editedFile && (paths.length || /^(?:文件|稿件|正文|工作区)/.test(target.slice(editedFile[0].length).trim()))) return match;
  const editTarget = /^(?:一下|下)?\s*(?:(本轮|本次|此次|这次)(?:的)?\s*|(?:上述|以上|这些|这份|该)(?:的)?\s*|(我(?:们)?(?:本轮|本次|这次|刚刚|刚才)?(?:对.{0,100}的|(?:所)?做(?:出)?的|的))\s*)?(?:修改|改动|变更)/.exec(target);
  const rawTarget = raw.slice(targetStart).trim().replace(/^[*_]+|[*_]+$/g, '');
  const namedTarget = !editTarget && paths.length && /^(?:一下|下)?\s*(?:(本轮|本次|此次|这次)\s*在\s*)?(.{1,180}?)\s*的\s*(?:修改|改动|变更)/.exec(rawTarget);
  if (!editTarget && (!namedTarget || !paths.includes(normalizePath(namedTarget[2].replace(/^「|」$/g, ''))))) return null;
  if (followingExistingState && !(editTarget ? editTarget[1] || editTarget[2] : namedTarget[1])) return null;
  const object = editTarget ? target.slice(editTarget[0].length).trim() : rawTarget.slice(namedTarget[0].length).trim();
  return !ADVICE_OBJECT.test(object) && !/^(?:状态|现状|情况|进度|依据)/.test(object) ? match : null;
}

function bareEditMatch(raw, clean, paths, previousPast, before) {
  if (!previousPast) return null;
  const match = /^\s*[*_]*(?:修改|编辑|写入|更新|修复|替换|删除|新增|调整)/.exec(clean);
  if (!match) return null;
  const object = clean.slice(match[0].length);
  const noun = ADVICE_OBJECT.exec(object) || /^(?:日期|时间|日志|记录|历史|结果|范围|清单|线)/.exec(object);
  if (/^的/.test(object) || (noun && /^(?:见|详见|如下|如下表|说明如下|为|是)/.test(object.slice(noun[0].length)))) return null;
  const target = normalizePath(raw.slice(match[0].length));
  const directFile = paths.some(path => target.startsWith(path));
  return /^(?:并|并且|同时)$/.test(before) || (/^[，,]+$/.test(before) && (/^了/.test(object) || directFile)) ? match : null;
}

function completionOfAdvice(clean, match) {
  const operation = /^已(?:经)?完成(?:了)?(?:修改|编辑|更新|修复|调整|替换|删除|新增)/.exec(match[0]);
  const object = clean.slice(match.index + match[0].length);
  const advice = ADVICE_OBJECT.exec(object);
  if (!advice) return false;
  const rest = object.slice(advice[0].length);
  return operation ? !/^(?:文件|文档|草稿|表格|章节|一节)/.test(rest) :
    /^已(?:经)?(?:将|把)/.test(match[0]) && /^(?:整理|列出|汇总|总结|归纳)成?(?:了)?(?:以下|下方|下列|如下|一份清单)/.test(rest);
}

function earlierOrOtherActor(clean, match, inheritedTime) {
  const prefix = clean.slice(0, match.index);
  // "上一轮的建议本轮已修改" still claims an action this turn.
  if (CURRENT_EXECUTION.test(prefix + match[0])) return false;
  return EARLIER.test(prefix) || inheritedTime ||
    (!FIRST_PERSON.test(prefix + match[0]) && (EARLIER_DRAFT.test(prefix) || OTHER_SUBJECT.test(prefix)));
}

function readsSupportStatus(paths, reads) {
  return reads.size > 0 && paths.every(path => reads.has(path));
}

function observedEditStatus(raw, clean, match, paths, facts, source) {
  const prefix = clean.slice(0, match.index);
  const observation = OBSERVATION.exec(prefix);
  // "我确认现稿已修改" attributes the confirmation, not the edit, to the speaker.
  const actor = observation ? prefix.slice(observation.index + observation[0].length) : prefix;
  const component = MANUSCRIPT_COMPONENT.test(prefix);
  const currentDocument = CURRENT_DOCUMENT.test(prefix) || (component && IN_CURRENT_DOCUMENT.test(prefix));
  const statusSubjectOrLabel = component || STATUS_SUBJECT.test(prefix) || STATUS_LABEL.test(prefix);
  // After the first conclusion, only another stated subject continues the comparison.
  const inheritsSource = source !== null && (!source.continued || statusSubjectOrLabel);
  if (CURRENT_EXECUTION.test(actor) || FIRST_PERSON.test(actor) || EXPLICIT_EDIT.test(match[0]) ||
      (ACTION_FORM.test(match[0]) && !currentDocument && !(inheritsSource && statusSubjectOrLabel))) return false;
  if (!readsSupportStatus([...paths, ...(source?.paths || [])], facts.reads)) return false;
  return currentDocument || inheritsSource || (observation && statusSubjectOrLabel) ||
    (facts.reviewStatusOnly && (STATUS_ANSWER.test(clean) || statusSubjectOrLabel ||
      filePaths(raw.slice(0, match.index), facts.reads).length > 0));
}
function isProvidedTextRead(raw, paths) {
  if (paths.length || /文件|文档|\b(?:file|document)s?\b/i.test(raw)) return false;
  return /(?:你|您|用户)(?:刚刚|已经|刚|所|本轮)?(?:提供|发来|发送|输入|附上)?的?(?:需求|请求|消息|问题|文字|文本|内容|上下文|说明|材料|指令)|(?:提供|贴出|粘贴|输入|发来|消息中|对话中).{0,20}(?:文本|文字|内容|消息|请求|需求|说明|问题)|(?:本轮|这条)?消息|对话上下文|\b(?:your|the user'?s|provided|pasted|supplied)\s+(?:provided\s+)?(?:request|message|text|prompt|instructions?|question|input|context)\b/i.test(raw);
}

/** Validate narrated execution against successful current-run evidence only.
 * This is a deterministic completion-claim guard, not a factual/semantic judge.
 */
export function assessExecutionClaims(text, evidence = {}) {
  const source = String(text ?? ''), sets = evidenceSets(evidence), issues = [];
  const known = new Set([...sets.edited, ...sets.reads, ...sets.applied]);
  const statusFacts = { reads: sets.reads, reviewStatusOnly: evidence.reviewStatusOnly === true };
  let hasClaims = false, previousEditMode = null, previousPast = false;
  let previousTime = false, previousStatePaths = null, previousWasState = false;
  const seen = new Set();
  function check(kind, mode, raw, paths, supported, start, end) {
    hasClaims = true;
    const failures = paths.length ? paths.filter((path) => !supported.has(path)) : supported.size ? [] : [null];
    for (const path of failures) {
      const key = `${kind}:${mode}:${path || ''}:${raw}`; if (seen.has(key)) continue; seen.add(key);
      issues.push({ kind, ...(path ? { path } : {}), sentence: raw.trim(), reason: mode, start, end });
    }
  }
  for (const { raw, clean, start, end, before, after } of clauses(source)) {
    const comma = /^[，,]+$/.test(before);
    const inheritedTime = comma && previousTime;
    const statusSource = comma && previousStatePaths !== null ? { paths: previousStatePaths, continued: previousWasState } : null;
    previousTime = false; previousStatePaths = null;
    if (!clean.trim() || EXAMPLE.test(clean)) { previousEditMode = null; previousPast = false; previousWasState = false; continue; }
    const paths = filePaths(raw, known);
    const editMatch = EDIT.exec(clean) || EDIT_FOLLOWING_REQUEST.exec(clean),
      reviewMatch = REVIEW.exec(clean) || reviewRequest(raw, clean, paths, previousEditMode, previousWasState),
      appliedMatch = APPLIED.exec(clean) || (evidence.stagedOnly === true ? STAGED_APPLICATION.exec(clean) : null);
    const bareEdit = bareEditMatch(raw, clean, paths, previousPast, before);
    const listOnly = previousEditMode && paths.length && !clean.replace(/[`'"“”「」\s\w./\\+-]/g, '').replace(/(?:和|及|与|等|文件)/g, '').trim();
    const claim = appliedMatch || reviewMatch || editMatch || bareEdit || (listOnly ? { index: 0, 0: '' } : null);
    const mode = appliedMatch ? 'applied' : reviewMatch ? 'review' : listOnly ? previousEditMode : 'edit';
    const readMatch = READ.exec(clean) || (paths.length ? /已(?:经)?(?:检查|核对|复核|确认)/.exec(clean) : null) ||
      (previousPast && /^(?:并|并且|同时)$/.test(before) && /^\s*(?:核对|复核|读取|查看)/.test(clean) && paths.length ? { index: 0, 0: '' } : null);
    previousEditMode = null; previousPast = false; previousWasState = false;
    if (claim && !plannedAt(clean, claim.index, after) && !completionOfAdvice(clean, claim)) {
      const observed = mode === 'edit' && editMatch && observedEditStatus(raw, clean, editMatch, filePaths(raw, known, true), statusFacts, statusSource);
      if (observed && statusSource) previousStatePaths = statusSource.paths;
      previousWasState = Boolean(observed) || earlierOrOtherActor(clean, claim, inheritedTime);
      if (!previousWasState) {
        check('edit', mode, raw, paths, mode === 'applied' ? sets.applied : mode === 'review' ? sets.changed : sets.edited, start, end);
        previousEditMode = mode; previousPast = true;
      }
    }
    if (readMatch && !plannedAt(clean, readMatch.index, after) && !earlierOrOtherActor(clean, readMatch, inheritedTime) &&
        !isProvidedTextRead(raw, paths)) { check('read', 'read', raw, paths, sets.reads, start, end); previousPast = true; }
    const compileMatch = COMPILE.exec(clean);
    if (compileMatch && !plannedAt(clean, compileMatch.index, after) && !earlierOrOtherActor(clean, compileMatch, inheritedTime)) {
      hasClaims = true;
      if (!sets.compiled) issues.push({ kind: 'compile', sentence: raw.trim(), reason: 'compile', start, end });
    }
    if (!claim && !compileMatch && EARLIER.test(clean)) previousTime = true;
    if (!claim && !compileMatch) {
      const source = STATUS_SOURCE.test(clean) || READ_STATUS_SOURCE.test(clean);
      const refs = source || SOURCE_INTRO.test(clean) ? filePaths(raw, known, true) : [];
      if (source || refs.length > 0) previousStatePaths = refs;
    }
  }
  return { issues, hasClaims };
}

function completeUnits(raw, final) {
  const clean = maskProtected(raw, false), units = []; let start = 0;
  for (const match of clean.matchAll(/[。！？!?；;\n]+|\.(?=\s|$)/g)) {
    const end = match.index + match[0].length;
    // A dot inside a file path or an inline code span is never a sentence end.
    units.push(raw.slice(start, end)); start = end;
  }
  if (final && start < raw.length) { units.push(raw.slice(start)); start = raw.length; }
  return { units, pendingText: raw.slice(start) };
}

const WHOLE_RUN = /^[\s*_#>-]*(?:(?:在)?(?:本轮(?:任务)?|这(?:一)?轮(?:任务)?|(?:本次|这次|此次)任务|整个任务)|(?:in |during )?(?:this|the entire) (?:turn|run|task))/i;
const FOLLOW_UP_STAGE = /^(?:\s|[*_：:])*(?:在)?(?:补查|补充(?:核查|验证|查证)|(?:本次|这次|该次)(?:补查|核查)|(?:该|这一|当前)(?:步骤|阶段)|(?:during )?(?:this|the) follow[- ]?up)/i;
const RESEARCH_ONLY = /^(?:\s|[*_：:])*(?:(?:我(?:们)?)?(?:只|仅(?:仅)?)(?:(?:完成|进行|做)(?:了)?(?:补充)?(?:来源|资料|文献)(?:的)?(?:核查|核对|核实|查证)|(?:核查|核对)(?:了)?(?:来源|资料|文献))(?:工作)?|(?:(?:I|we) )?only (?:checked|verified|reviewed) (?:the )?(?:sources|references))[\s*_]*$/i;
const CHINESE_DENIAL = '(?:我(?:们)?)?(?:并没有|没有|并未|尚未|未曾|未|无)(?:实际)?';
const FILE_EDIT = '(?:修改|编辑|改动|变更|改写|更新)';
const PROJECT_FILES = '(?:任何)?(?:项目|正式)?文件';
const NO_PROJECT_FILE_CHANGES = new RegExp(`^${CHINESE_DENIAL}(?:${FILE_EDIT}(?:过)?${PROJECT_FILES}|` +
  `(?:执行|进行|产生|新增|做出?)?${PROJECT_FILES}(?:的)?${FILE_EDIT}|` +
  `对${PROJECT_FILES}(?:进行|作出?|做出?)?(?:任何)?${FILE_EDIT}|(?:产生|做出?)项目${FILE_EDIT})$`);
const NO_ENGLISH_FILE_CHANGES = /^(?:(?:(?:I|we) )?(?:did not|didn't) (?:edit|modify|change|update) (?:any )?(?:project )?files|no (?:project )?file (?:edits|changes|modifications) (?:were |have been )?made)$/i;
const NO_FIGURE_FILE_CHANGES = new RegExp(`^${CHINESE_DENIAL}(?:${FILE_EDIT}(?:过)?(?:任何)?图文件|` +
  `(?:新增|产生|进行|做出?)?(?:任何)?(?:正文(?:或|与|和))?图文件(?:的)?${FILE_EDIT})$`);
const NO_NAMED_FILE_CHANGE = new RegExp(`^(?:${CHINESE_DENIAL}${FILE_EDIT}|` +
  `(?:(?:I|we) )?(?:did not|didn't) (?:edit|modify|change|update)\\b)\\s*(.+)$`, 'i');
const NO_NAMED_FILE_CHANGE_ZH = new RegExp(`^${CHINESE_DENIAL}对\\s*(.+?)\\s*(?:进行|作出?|做出?)?(?:任何)?${FILE_EDIT}$`);
const NO_COMPILE = /^(?:\s|[*_：:])*(?:(?:我(?:们)?)?(?:并未|没有|尚未|未曾|未)(?:实际|执行|完成|进行|过|任何|\s)*编译(?:验证|核验)?|编译(?:未|没有|尚未)(?:成功|通过|完成)|(?:(?:I|we) )?(?:did not|didn't) (?:compile|build))[\s*_]*$/i;
const FIGURE_PATH = /\.(?:svg|eps|png|jpe?g|webp|tiff?|bmp|gif|tikz|pgf|asy)$/i;
const FIGURE_PDF_PATH = /(?:^|[/_.-])(?:fig(?:ure)?s?|plots?|charts?|images?|graphics?)(?=[/_.-]|\d).*\.pdf$/i;

function deniesChangedFiles(statement, rawStatement, changedPaths) {
  if (!changedPaths.size) return false;
  const plain = statement.replace(/^[\s*_：:]+|[\s*_]+$/g, '');
  const chinese = plain.replace(/\s/g, '');
  if (NO_PROJECT_FILE_CHANGES.test(chinese) || NO_ENGLISH_FILE_CHANGES.test(plain)) return true;
  if (NO_FIGURE_FILE_CHANGES.test(chinese)) {
    return [...changedPaths].some(name => FIGURE_PATH.test(name) || FIGURE_PDF_PATH.test(name));
  }
  // A named path must be the entire object. A changed file says nothing about
  // whether its original wording, data, or parameters were edited.
  const raw = rawStatement.replace(/^[\s*_：:]+|[\s*_]+$/g, '');
  const target = (NO_NAMED_FILE_CHANGE.exec(raw) || NO_NAMED_FILE_CHANGE_ZH.exec(raw))?.[1];
  return Boolean(target && changedPaths.has(normalizePath(target.trim().replace(/^[「『]|[」』]$/g, ''))));
}

/** Keep phase-specific statements while removing claims contradicted by this
 * run's recorded operations, without buying another provider response. */
export function reconcileFollowUpConclusion(text, { changedPaths, compileSucceeded, compiledEarlier } = {}) {
  const source = String(text ?? ''), changed = pathsOf(changedPaths);
  if (!changed.size && !compileSucceeded && !compiledEarlier) return source;
  return completeUnits(source, true).units.map(unit => {
    const parts = clauses(unit);
    let wholeRun = false;
    const kept = parts.filter(part => {
      const scope = WHOLE_RUN.exec(part.clean);
      wholeRun = !!scope || (wholeRun && /^[，,]+$/.test(part.before));
      const statement = part.clean.slice(scope?.[0].length || 0);
      if (!wholeRun || FOLLOW_UP_STAGE.test(statement) || /额外|再次|重新|additional|again/i.test(statement)) return true;
      if (RESEARCH_ONLY.test(statement)) return false;
      if (compileSucceeded && NO_COMPILE.test(statement)) return false;
      return !deniesChangedFiles(statement, part.raw.slice(scope?.[0].length || 0), changed);
    });
    if (kept.length === parts.length) return unit;
    if (!kept.length) return unit.match(/[\r\n]+$/)?.[0] || '';
    const statements = kept.filter(part => !WHOLE_RUN.test(part.clean) || part.clean.replace(WHOLE_RUN, '').trim());
    const end = unit.slice(parts.at(-1).end);
    return statements.map((part, index) => part.raw + (index === statements.length - 1 ? end : part.after)).join('');
  }).join('');
}

/** Project raw provider narration into safe visible text. The caller retains raw
 * for correction context; incremental calls can recompute with updated evidence.
 * Incomplete tail sentences stay buffered, including split completion keywords.
 */
export function splitVerifiedNarration(raw, { final = false, evidence = {} } = {}) {
  const source = String(raw ?? ''), { units, pendingText } = completeUnits(source, final);
  const completed = units.join('');
  // Assess the complete published prefix together: a path list may continue
  // across a semicolon/newline and inherit its completion verb from earlier.
  const { issues, hasClaims } = assessExecutionClaims(completed, evidence);
  if (!issues.length) return { visibleText: completed, pendingText, issues, hasClaims };
  const spans = [...new Map(issues.map((issue) => [issue.start, issue])).values()].sort((a, b) => a.start - b.start);
  let visibleText = '', cursor = 0, placeholderUsed = false, blocked = false;
  for (const span of spans) {
    const before = completed.slice(cursor, span.start);
    if (!blocked || /[^\s，,；;。！？!?]/.test(before)) visibleText += before;
    if (!placeholderUsed) { visibleText += PLACEHOLDER; placeholderUsed = true; }
    cursor = span.end; blocked = true;
  }
  const tail = completed.slice(cursor);
  visibleText += /[^\s，,；;。！？!?]/.test(tail) ? tail : tail.replace(/[^\r\n]/g, '');
  return { visibleText, pendingText, issues, hasClaims };
}
