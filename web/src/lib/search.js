// 文本搜索：精确（大小写可选）与模糊（子序列匹配）两种模式
// 返回 [{ line, col, preview }]，line/col 0 基
// maxPerFile 限制单文件命中数，避免短查询（如单字符）产生几十万条结果拖垮渲染

export function searchInText(text, query, { fuzzy = false, caseSensitive = false, maxPerFile = 200 } = {}) {
  const results = [];
  if (!text || !query) return results;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length && results.length < maxPerFile; i++) {
    const line = lines[i];
    if (fuzzy) {
      const col = fuzzyIndex(line, query, caseSensitive);
      if (col >= 0) results.push({ line: i, col, preview: makePreview(line, col, query.length) });
    } else {
      const hay = caseSensitive ? line : line.toLowerCase();
      const needle = caseSensitive ? query : query.toLowerCase();
      let from = 0;
      while (results.length < maxPerFile) {
        const idx = hay.indexOf(needle, from);
        if (idx < 0) break;
        results.push({ line: i, col: idx, preview: makePreview(line, idx, query.length) });
        from = idx + Math.max(1, needle.length);
      }
    }
  }
  return results;
}

/** 子序列模糊匹配，返回首个匹配字符位置，不匹配 -1 */
function fuzzyIndex(line, query, caseSensitive) {
  const hay = caseSensitive ? line : line.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  let qi = 0;
  let start = -1;
  for (let i = 0; i < hay.length && qi < needle.length; i++) {
    if (hay[i] === needle[qi]) {
      if (start < 0) start = i;
      qi++;
    }
  }
  return qi === needle.length ? start : -1;
}

function makePreview(line, col, len) {
  const W = 40;
  const s = Math.max(0, col - W);
  const e = Math.min(line.length, col + len + W);
  return (s > 0 ? '…' : '') + line.slice(s, e) + (e < line.length ? '…' : '');
}
