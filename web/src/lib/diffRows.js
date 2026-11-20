// 变更集行内 diff：before/after 全文 → 带旧/新行号的行序列（ctx/add/del）。
// 编辑器内的行内 diff 装饰见 diffDecorations.js（在真实文档上叠加，不改文档）。
import { diffLines } from 'diff';

/**
 * buildDiffRows(before, after) → { rows, adds, dels }
 * rows: [{ type: 'ctx'|'add'|'del', text, oldNo?, newNo? }]
 * 行号规则：ctx 双号；del 只有旧号；add 只有新号。
 */
export function buildDiffRows(before, after) {
  const rows = [];
  let oldNo = 0;
  let newNo = 0;
  let adds = 0;
  let dels = 0;
  const push = (type, raw) => {
    // diff 库的 value 保留结尾换行；末行无换行时原样保留
    const lines = raw.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    for (const text of lines) {
      const row = { type, text };
      if (type !== 'add') row.oldNo = ++oldNo;
      if (type !== 'del') row.newNo = ++newNo;
      if (type === 'add') adds++;
      if (type === 'del') dels++;
      rows.push(row);
    }
  };
  for (const part of diffLines(String(before ?? ''), String(after ?? ''))) {
    push(part.added ? 'add' : part.removed ? 'del' : 'ctx', part.value);
  }
  return { rows, adds, dels };
}
