import { describe, it, expect } from 'vitest';
import { searchInText } from './search.js';

describe('searchInText', () => {
  const text = 'Hello World\nhello again\nfoo bar hello';

  it('精确搜索忽略大小写，返回行列与预览', () => {
    const r = searchInText(text, 'hello');
    expect(r).toHaveLength(3);
    expect(r[0]).toMatchObject({ line: 0, col: 0 });
    expect(r[1]).toMatchObject({ line: 1, col: 0 });
    expect(r[2]).toMatchObject({ line: 2, col: 8 });
    expect(r[0].preview).toContain('Hello');
  });

  it('一行多处命中', () => {
    const r = searchInText('aXaXa', 'X', { caseSensitive: true });
    expect(r.map((x) => x.col)).toEqual([1, 3]);
  });

  it('模糊子序列匹配', () => {
    const r = searchInText(text, 'hlw', { fuzzy: true });
    expect(r.some((x) => x.line === 0)).toBe(true);
    expect(searchInText(text, 'zzz', { fuzzy: true })).toEqual([]);
  });

  it('空查询返回空', () => {
    expect(searchInText(text, '')).toEqual([]);
    expect(searchInText('', 'x')).toEqual([]);
  });
});
