import { describe, it, expect } from 'vitest';
import { viewQuery, usagePercent, projectActions, PROJECT_VIEWS } from '../lib/projectUtils.js';

describe('viewQuery', () => {
  it('合法视图原样返回', () => {
    for (const v of PROJECT_VIEWS) expect(viewQuery(v.key)).toBe(v.key);
  });
  it('非法/空值回落到 all', () => {
    expect(viewQuery('nonsense')).toBe('all');
    expect(viewQuery('')).toBe('all');
    expect(viewQuery(undefined)).toBe('all');
  });
});

describe('usagePercent', () => {
  it('quota 为 -1（不限）返回 null', () => {
    expect(usagePercent(100, -1)).toBeNull();
    expect(usagePercent(100, null)).toBeNull();
  });
  it('正常计算并截断到 100', () => {
    expect(usagePercent(50, 200)).toBe(25);
    expect(usagePercent(300, 200)).toBe(100);
  });
  it('quota 为 0 时有用量即 100，无用量为 0', () => {
    expect(usagePercent(1, 0)).toBe(100);
    expect(usagePercent(0, 0)).toBe(0);
  });
});

describe('projectActions', () => {
  const owner = { role: 'owner', archived: false };
  const editor = { role: 'editor', archived: true };

  it('回收站视图只有 恢复/彻底删除', () => {
    expect(projectActions(owner, 'trash')).toEqual(['restore', 'purge']);
  });
  it('owner 未归档：含 share 与 archive', () => {
    const a = projectActions(owner, 'all');
    expect(a).toContain('open');
    expect(a).toContain('share');
    expect(a).toContain('archive');
    expect(a).not.toContain('unarchive');
    expect(a).toContain('delete');
  });
  it('非 owner 已归档：无 share，显示 unarchive', () => {
    const a = projectActions(editor, 'archived');
    expect(a).not.toContain('share');
    expect(a).toContain('unarchive');
    expect(a).not.toContain('archive');
  });
});
