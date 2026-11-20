import { getDb } from './db.js';
import { HttpError } from './util.js';

/**
 * 返回用户与项目的关系：'owner' | 'editor' | 'viewer' | null
 * projectId 仅接受项目唯一哈希 public_id——数字自增编号不再作为访问标识(防枚举),
 * 旧数字链接一律 404。
 */
export function getProjectAccess(user, projectId) {
  const db = getDb();
  const key = String(projectId ?? '');
  if (!key || /^\d+$/.test(key)) return { project: null, access: null }; // 数字编号不解析
  const project = db.prepare('SELECT * FROM projects WHERE public_id = ?').get(key);
  if (!project) return { project: null, access: null };
  if (project.owner_id === user.id) return { project, access: 'owner' };
  const m = db
    .prepare('SELECT role FROM project_members WHERE project_id = ? AND user_id = ?')
    .get(project.id, user.id);
  return { project, access: m ? m.role : null };
}

/**
 * 校验访问权限。write=true 需要 owner/editor 且项目未删除未归档；
 * allowArchived=true 时放行归档项目（如编译：归档只读但允许重新编译）。
 */
export function requireProjectAccess(user, projectId, { write = false, allowArchived = false } = {}) {
  const { project, access } = getProjectAccess(user, projectId);
  if (!project) throw new HttpError(404, '项目不存在');
  if (!access) throw new HttpError(403, '无权访问该项目');
  if (write) {
    if (project.deleted) throw new HttpError(403, '项目已在回收站，请先恢复');
    if (project.archived && !allowArchived) throw new HttpError(403, '项目已归档，归档项目不可编辑');
    if (access !== 'owner' && access !== 'editor') throw new HttpError(403, '只读成员无法修改');
  }
  return { project, access };
}

export function touchProject(projectId) {
  getDb().prepare("UPDATE projects SET updated_at = datetime('now') WHERE id = ?").run(projectId);
}
