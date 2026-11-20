// LaTeX 大纲解析：扫描 \chapter/\section/\subsection/\subsubsection（含星号变体）
// 返回 [{ level, title, line }]，level: 0=chapter 1=section 2=subsection 3=subsubsection，line 为 0 基行号

const CMD_RE = /\\(chapter|section|subsection|subsubsection)\*?\s*(\[[^\]]*\])?\s*\{/g;

/** 从 openIdx（'{' 的位置）开始扫描平衡括号，返回 [内容, 结束位置] */
function scanBalanced(text, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') { i++; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return [text.slice(openIdx + 1, i), i];
    }
  }
  return [text.slice(openIdx + 1), text.length];
}

export function parseLatexOutline(text) {
  const items = [];
  if (!text) return items;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const src = stripComment(lines[i]);
    CMD_RE.lastIndex = 0;
    const m = CMD_RE.exec(src);
    if (m) {
      const level = { chapter: 0, section: 1, subsection: 2, subsubsection: 3 }[m[1]];
      const [arg] = scanBalanced(src, m.index + m[0].length - 1);
      const title = flattenLatex(arg).trim();
      if (title) items.push({ level, title, line: i });
    }
  }
  return items;
}

/** 去掉行内未转义 % 开始的注释 */
export function stripComment(line) {
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '%' && (i === 0 || line[i - 1] !== '\\')) return line.slice(0, i);
  }
  return line;
}

/** 将简单 LaTeX 片段展平为纯文本（去命令、留参数） */
export function flattenLatex(s) {
  return s
    .replace(/\\(?:textbf|textit|emph|underline|text|textrm|textsf|texttt)\{([^{}]*)\}/g, '$1')
    .replace(/\\[a-zA-Z]+\*?(?:\[[^\]]*\])?/g, '')
    .replace(/[{}]/g, '')
    .replace(/~/g, ' ');
}

/** 光标所在行对应的大纲索引（最后一个 line <= cursorLine 的项），无则 -1 */
export function activeOutlineIndex(items, cursorLine) {
  let idx = -1;
  for (let i = 0; i < items.length; i++) {
    if (items[i].line <= cursorLine) idx = i;
    else break;
  }
  return idx;
}
