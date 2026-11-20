import { describe, it, expect } from 'vitest';
import { buildDiffRows } from './diffRows.js';

describe('buildDiffRows', () => {
  it('完全相同 → 全部上下文行，双行号', () => {
    const { rows, adds, dels } = buildDiffRows('a\nb\n', 'a\nb\n');
    expect(rows.map((r) => r.type)).toEqual(['ctx', 'ctx']);
    expect(rows[0]).toMatchObject({ oldNo: 1, newNo: 1, text: 'a' });
    expect(adds).toBe(0);
    expect(dels).toBe(0);
  });

  it('修改 → 删除行带旧号、新增行带新号', () => {
    const { rows, adds, dels } = buildDiffRows('a\nb\nc\n', 'a\nB\nc\n');
    const del = rows.find((r) => r.type === 'del');
    const add = rows.find((r) => r.type === 'add');
    expect(del).toMatchObject({ text: 'b', oldNo: 2 });
    expect(del.newNo).toBeUndefined();
    expect(add).toMatchObject({ text: 'B', newNo: 2 });
    expect(add.oldNo).toBeUndefined();
    expect(adds).toBe(1);
    expect(dels).toBe(1);
  });

  it('新文件（before 为空）→ 全部为新增行', () => {
    const { rows, adds, dels } = buildDiffRows('', 'x\ny\n');
    expect(rows.map((r) => r.type)).toEqual(['add', 'add']);
    expect(rows[0].newNo).toBe(1);
    expect(adds).toBe(2);
    expect(dels).toBe(0);
  });

  it('删除文件（after 为空）→ 全部为删除行', () => {
    const { rows, dels } = buildDiffRows('x\n', '');
    expect(rows.map((r) => r.type)).toEqual(['del']);
    expect(rows[0].oldNo).toBe(1);
    expect(dels).toBe(1);
  });

  it('空输入安全：null 视为空字符串', () => {
    expect(buildDiffRows(null, null).rows).toEqual([]);
    expect(buildDiffRows(undefined, 'a\n').adds).toBe(1);
  });
});
