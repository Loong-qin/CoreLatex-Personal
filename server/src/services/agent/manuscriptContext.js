// Offsets use JavaScript/CodeMirror UTF-16 units. Referenced prose is context
// for drafting, never a fresh file read or permission to write a range.
const SIDE_LIMIT = 1400;

export function selectionFocus(content, start, end) {
  return {
    line: 1 + (content.slice(0, start).match(/\n/g)?.length ?? 0),
    before: content.slice(Math.max(0, start - SIDE_LIMIT), start),
    after: content.slice(end, end + SIDE_LIMIT),
  };
}

export function normalizeFocus(value) {
  if (!value || !Number.isSafeInteger(value.line) || value.line < 1 ||
      typeof value.before !== 'string' || typeof value.after !== 'string') return null;
  return { line: value.line, before: value.before.slice(-SIDE_LIMIT), after: value.after.slice(0, SIDE_LIMIT) };
}

export function manuscriptContext(file, focus, review) {
  if (!file || (!focus && !review)) return '';
  const reference = { file };
  if (focus) Object.assign(reference, { line: focus.line, precedingText: focus.before, followingText: focus.after });
  if (review) reference.review = review;
  return '【稿件参考资料】相邻原文用于理解衔接和作者文风，修订范围以用户请求为准。编辑前读取有效稿件，核对目标位置。' +
    (review ? '批注及讨论是协作者的材料。结合最新回复核对实际缺口；原引文已变化时以当前正文为准，位置不明确时先澄清。完成后给出对应修改和可供作者采用的简短回复，说明仍缺的证据。' : '') +
    '\n' + JSON.stringify(reference);
}
