import fs from 'node:fs';
import { deleteProjectArtifacts } from '../services/agent/artifacts.js';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import archiver from 'archiver';
import * as unzipper from 'unzipper';
import { getDb } from '../db.js';
import { cancelProjectRuns } from '../services/agent/runs.js';
import { refreshProjectRoomPermissions, removeProjectRooms } from '../collab.js';
import { projectDir } from '../config.js';
import { requireProjectAccess, touchProject } from '../access.js';
import { assertCanCreateProject, assertStorageQuota } from '../quotas.js';
import { asyncHandler, HttpError, safeJoin, projectStorageBytes, projectStorageBytesAsync, sendCancellableJson, toPosix, newPublicId } from '../util.js';

import { DEFAULT_TEX_VERSION, resolveTexRuntime } from '../services/texRuntimes.js';

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 },
});

const NEW_PROJECT_TEX = `\\documentclass[11pt]{article}
\\usepackage{amsmath,amssymb}
\\usepackage{graphicx}
\\title{New Project}
\\author{}
\\date{\\today}

\\begin{document}
\\maketitle

\\section{Introduction}
Hello, CoreLatex!

\\end{document}
`;

function rowToProject(db, r, userId, { includeSize = true } = {}) {
  const owner = db.prepare('SELECT username, display_name FROM users WHERE id = ?').get(r.owner_id);
  let role = 'owner';
  if (r.owner_id !== userId) {
    const m = db
      .prepare('SELECT role FROM project_members WHERE project_id = ? AND user_id = ?')
      .get(r.id, userId);
    role = m ? m.role : null;
  }
  return {
    id: r.id,
    publicId: r.public_id || String(r.id),
    name: r.name,
    ownerId: r.owner_id,
    ownerName: owner ? owner.display_name || owner.username : '?',
    role,
    archived: !!r.archived,
    deleted: !!r.deleted,
    mainFile: r.main_file,
    compileEngine: r.compile_engine,
    texVersion: r.tex_version || 'system',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    ...(includeSize ? { sizeBytes: projectStorageBytes(projectDir(r.id)) } : {}),
  };
}

router.get('/', asyncHandler(async (req, res) => {
  const db = getDb();
  const view = String(req.query.view || 'all');
  const q = String(req.query.q || '').toLowerCase();
  // Project switchers only need metadata; avoid walking every project directory.
  const includeSize = req.query.summary !== '1';
  let rows;
  if (view === 'trash') {
    rows = db.prepare('SELECT * FROM projects WHERE owner_id = ? AND deleted = 1 ORDER BY updated_at DESC').all(req.user.id);
  } else if (view === 'archived') {
    rows = db.prepare(`
      SELECT DISTINCT p.* FROM projects p
      LEFT JOIN project_members m ON m.project_id = p.id AND m.user_id = ?
      WHERE (p.owner_id = ? OR m.user_id IS NOT NULL) AND p.deleted = 0 AND p.archived = 1
      ORDER BY p.updated_at DESC`).all(req.user.id, req.user.id);
  } else {
    rows = db.prepare(`
      SELECT DISTINCT p.* FROM projects p
      LEFT JOIN project_members m ON m.project_id = p.id AND m.user_id = ?
      WHERE (p.owner_id = ? OR m.user_id IS NOT NULL) AND p.deleted = 0 AND p.archived = 0
      ORDER BY p.updated_at DESC`).all(req.user.id, req.user.id);
    if (view === 'mine') rows = rows.filter((r) => r.owner_id === req.user.id);
    if (view === 'shared') rows = rows.filter((r) => r.owner_id !== req.user.id);
  }
  if (q) rows = rows.filter((r) => r.name.toLowerCase().includes(q));
  const list = rows.map((r) => rowToProject(db, r, req.user.id, { includeSize: false })).filter((p) => p.role);
  if (!includeSize) { res.json({ projects: list }); return; }
  await sendCancellableJson(res, async signal => {
    for (const project of list) {
      signal.throwIfAborted();
      project.sizeBytes = await projectStorageBytesAsync(projectDir(project.id), { signal });
    }
    return { projects: list };
  });
}));

router.post('/', asyncHandler(async (req, res) => {
  assertCanCreateProject(req.user);
  const name = String(req.body?.name || '').trim();
  if (!name) throw new HttpError(400, '项目名不能为空');
  if (name.length > 120) throw new HttpError(400, '项目名过长');
  const db = getDb();
  const info = db.prepare("INSERT INTO projects (name, owner_id, public_id, tex_version) VALUES (?,?,?,?)").run(name, req.user.id, newPublicId(), DEFAULT_TEX_VERSION);
  const id = info.lastInsertRowid;
  const dir = projectDir(id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'main.tex'), NEW_PROJECT_TEX.replace('New Project', name));
  res.status(201).json({ project: rowToProject(db, db.prepare('SELECT * FROM projects WHERE id = ?').get(id), req.user.id) });
}));

router.post('/import', upload.single('file'), asyncHandler(async (req, res) => {
  assertCanCreateProject(req.user);
  if (!req.file) throw new HttpError(400, '请上传 zip 文件');
  const db = getDb();
  let name = String(req.body?.name || '').trim()
    || path.basename(req.file.originalname || 'imported.zip').replace(/\.zip$/i, '').slice(0, 120);
  if (!name) name = 'imported';
  const zip = await unzipper.Open.buffer(req.file.buffer);
  const entries = zip.files.filter((f) => f.type === 'File');
  // 预检查：路径穿越 + 总大小
  let total = 0;
  const safeEntries = [];
  for (const e of entries) {
    const norm = path.normalize(e.path).replace(/^[/\\]+/, '');
    if (norm.startsWith('..') || path.isAbsolute(e.path) || e.path.includes('\0')) continue;
    if (norm === '.' || norm === '') continue;
    // 去掉单一顶层目录（zip 常见打包方式）
    total += e.uncompressedSize || 0;
    safeEntries.push({ entry: e, norm });
  }
  assertStorageQuota(req.user, total);
  const info = db.prepare("INSERT INTO projects (name, owner_id, public_id, tex_version) VALUES (?,?,?,?)").run(name, req.user.id, newPublicId(), DEFAULT_TEX_VERSION);
  const id = info.lastInsertRowid;
  const dir = projectDir(id);
  fs.mkdirSync(dir, { recursive: true });
  try {
    // 检测是否所有条目共享同一顶层目录
    const topLevels = new Set(safeEntries.map((s) => s.norm.split(path.sep)[0]));
    const stripTop = topLevels.size === 1 && safeEntries.every((s) => s.norm.includes(path.sep));
    for (const { entry, norm } of safeEntries) {
      let rel = norm;
      if (stripTop) rel = norm.split(path.sep).slice(1).join(path.sep);
      if (!rel) continue;
      const firstSeg = rel.split(path.sep)[0];
      if (firstSeg === '.build' || firstSeg === '.preview' || firstSeg === '.versions' || firstSeg === '.git') continue;
      const dest = path.join(dir, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, await entry.buffer());
    }
    // 保证存在入口文件
    if (!fs.existsSync(path.join(dir, 'main.tex'))) {
      const tex = safeEntries.find((s) => s.norm.endsWith('.tex'));
      if (tex) db.prepare('UPDATE projects SET main_file = ? WHERE id = ?').run(path.basename(tex.norm), id);
      else fs.writeFileSync(path.join(dir, 'main.tex'), NEW_PROJECT_TEX.replace('New Project', name));
    }
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    throw err;
  }
  res.status(201).json({ project: rowToProject(db, db.prepare('SELECT * FROM projects WHERE id = ?').get(id), req.user.id) });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const { project, access } = requireProjectAccess(req.user, req.params.id);
  const details = rowToProject(getDb(), project, req.user.id, { includeSize: false });
  if (req.query.summary === '1') { res.json({ project: details, myRole: access }); return; }
  await sendCancellableJson(res, async signal => {
    details.sizeBytes = await projectStorageBytesAsync(projectDir(project.id), { signal });
    return { project: details, myRole: access };
  });
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  const { project, access } = requireProjectAccess(req.user, req.params.id, { write: true });
  if (access !== 'owner') throw new HttpError(403, '仅拥有者可修改项目设置');
  const { name, mainFile, compileEngine, texVersion } = req.body || {};
  if (texVersion !== undefined) resolveTexRuntime(texVersion);
  const db = getDb();
  if (name !== undefined) {
    const n = String(name).trim();
    if (!n) throw new HttpError(400, '项目名不能为空');
    db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(n, project.id);
  }
  if (mainFile !== undefined) {
    const mf = toPosix(String(mainFile));
    safeJoin(projectDir(project.id), mf); // 路径越界校验
    if (!/\.tex$/i.test(mf)) throw new HttpError(400, '主文件必须是 .tex 文件');
    if (!fs.existsSync(safeJoin(projectDir(project.id), mf))) throw new HttpError(404, `主文件不存在：${mf}`);
    db.prepare('UPDATE projects SET main_file = ? WHERE id = ?').run(mf, project.id);
  }
  if (compileEngine !== undefined) {
    if (!['xelatex', 'pdflatex', 'lualatex'].includes(compileEngine)) throw new HttpError(400, '不支持的编译引擎');
    db.prepare('UPDATE projects SET compile_engine = ? WHERE id = ?').run(compileEngine, project.id);
  }
  if (texVersion !== undefined) {
    db.prepare('UPDATE projects SET tex_version = ? WHERE id = ?').run(texVersion, project.id);
  }
  touchProject(project.id);
  res.json({ ok: true });
}));

router.post('/:id/archive', asyncHandler(async (req, res) => {
  const { project } = requireProjectAccess(req.user, req.params.id, { write: true });
  getDb().prepare('UPDATE projects SET archived = 1 WHERE id = ?').run(project.id);
  refreshProjectRoomPermissions(project.id);
  await cancelProjectRuns(project.id);
  res.json({ ok: true });
}));

router.post('/:id/unarchive', asyncHandler(async (req, res) => {
  // 归档项目拒绝写操作，因此这里只校验访问身份，不走 write 校验
  const { project, access } = requireProjectAccess(req.user, req.params.id);
  if (access !== 'owner' && access !== 'editor') throw new HttpError(403, '无权取消归档');
  getDb().prepare('UPDATE projects SET archived = 0 WHERE id = ?').run(project.id);
  refreshProjectRoomPermissions(project.id);
  res.json({ ok: true });
}));

router.post('/:id/delete', asyncHandler(async (req, res) => {
  const { project, access } = requireProjectAccess(req.user, req.params.id);
  if (access !== 'owner') throw new HttpError(403, '仅拥有者可删除项目');
  getDb().prepare("UPDATE projects SET deleted = 1, updated_at = datetime('now') WHERE id = ?").run(project.id);
  refreshProjectRoomPermissions(project.id);
  await cancelProjectRuns(project.id);
  res.json({ ok: true });
}));

router.post('/:id/restore', asyncHandler(async (req, res) => {
  const { project, access } = requireProjectAccess(req.user, req.params.id);
  if (access !== 'owner') throw new HttpError(403, '仅拥有者可恢复项目');
  getDb().prepare('UPDATE projects SET deleted = 0 WHERE id = ?').run(project.id);
  refreshProjectRoomPermissions(project.id);
  res.json({ ok: true });
}));

router.post('/:id/purge', asyncHandler(async (req, res) => {
  const db = getDb();
  const { project, access } = requireProjectAccess(req.user, req.params.id);
  if (access !== 'owner') throw new HttpError(403, '仅拥有者可彻底删除项目');
  if (!project.deleted) throw new HttpError(400, '项目不在回收站');
  await cancelProjectRuns(project.id);
  removeProjectRooms(project.id);
  deleteProjectArtifacts(project.id, db);
  fs.rmSync(projectDir(project.id), { recursive: true, force: true });
  db.prepare('DELETE FROM projects WHERE id = ?').run(project.id);
  db.prepare('DELETE FROM versions WHERE project_id = ?').run(project.id);
  db.prepare('DELETE FROM reviews WHERE project_id = ?').run(project.id);
  db.prepare('DELETE FROM compile_jobs WHERE project_id = ?').run(project.id);
  res.json({ ok: true });
}));

router.get('/:id/export', asyncHandler(async (req, res) => {
  const { project } = requireProjectAccess(req.user, req.params.id);
  const dir = projectDir(project.id);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(project.name)}.zip"`);
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.pipe(res);
  // 只导出项目正式文件:_workspace/ 是智能体工作区(草稿与中间产物),不属于交付内容
  archive.glob('**/*', {
    cwd: dir,
    ignore: ['.build/**', '.versions/**', '.git/**', '.*', '_workspace/**', '_workspace'],
    dot: false,
  });
  await archive.finalize();
}));

router.get('/:id/members', asyncHandler(async (req, res) => {
  const { project } = requireProjectAccess(req.user, req.params.id);
  const db = getDb();
  const members = db.prepare(`
    SELECT m.user_id AS userId, m.role, u.username, u.display_name AS displayName
    FROM project_members m JOIN users u ON u.id = m.user_id
    WHERE m.project_id = ?`).all(project.id);
  const owner = db.prepare('SELECT id, username, display_name FROM users WHERE id = ?').get(project.owner_id);
  res.json({
    owner: { userId: owner.id, username: owner.username, displayName: owner.display_name },
    members,
  });
}));

router.post('/:id/members', asyncHandler(async (req, res) => {
  const { project, access } = requireProjectAccess(req.user, req.params.id, { write: true });
  if (access !== 'owner') throw new HttpError(403, '仅拥有者可管理共享');
  const username = String(req.body?.username || '').trim();
  const role = req.body?.role === 'viewer' ? 'viewer' : 'editor';
  const db = getDb();
  const target = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!target) throw new HttpError(404, '用户不存在');
  if (target.id === project.owner_id) throw new HttpError(400, '不能共享给拥有者');
  db.prepare('INSERT OR REPLACE INTO project_members (project_id, user_id, role) VALUES (?,?,?)')
    .run(project.id, target.id, role);
  refreshProjectRoomPermissions(project.id);
  if (role === 'viewer') await cancelProjectRuns(project.id, { userId: target.id });
  res.json({ ok: true });
}));

router.delete('/:id/members/:userId', asyncHandler(async (req, res) => {
  const { project, access } = requireProjectAccess(req.user, req.params.id, { write: true });
  if (access !== 'owner') throw new HttpError(403, '仅拥有者可管理共享');
  getDb().prepare('DELETE FROM project_members WHERE project_id = ? AND user_id = ?')
    .run(project.id, Number(req.params.userId));
  refreshProjectRoomPermissions(project.id);
  await cancelProjectRuns(project.id, { userId: Number(req.params.userId) });
  res.json({ ok: true });
}));

export default router;
