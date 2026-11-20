// 项目列表视图的纯逻辑工具（视图映射 / 配额百分比 / 行操作）

export const PROJECT_VIEWS = [
  { key: 'all', label: '所有项目' },
  { key: 'mine', label: '我的项目' },
  { key: 'shared', label: '与我共享的' },
  { key: 'archived', label: '已归档项目' },
  { key: 'trash', label: '回收站' },
];

/** 视图 key → API 的 view 查询参数，非法值回落到 'all' */
export function viewQuery(view) {
  return PROJECT_VIEWS.some((v) => v.key === view) ? view : 'all';
}

/**
 * 配额使用百分比（0-100 整数）。
 * quota 为 null/负数（不限）时返回 null；quota 为 0 时有用量即 100。
 */
export function usagePercent(used, quota) {
  if (quota == null || quota < 0) return null;
  const u = Math.max(0, used || 0);
  if (quota === 0) return u > 0 ? 100 : 0;
  return Math.min(100, Math.round((u / quota) * 100));
}

const tokenNumberFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

export function formatTokens(n) {
  return tokenNumberFormat.format(Math.max(0, n || 0));
}

/**
 * 项目行可用操作列表。回收站视图只有 恢复/彻底删除；
 * 其余视图：打开/重命名/导出 + owner 可共享 + 归档或取消归档 + 删除。
 */
export function projectActions(project, view) {
  if (view === 'trash') return ['restore', 'purge'];
  const actions = ['open', 'rename', 'export'];
  if (project && project.role === 'owner') actions.push('share');
  actions.push(project && project.archived ? 'unarchive' : 'archive');
  actions.push('delete');
  return actions;
}
