import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { Router } from 'express';
import multer from 'multer';
import mime from 'mime-types';
import { projectDir } from '../config.js';
import { getDb } from '../db.js';
import { flushProjectRooms, reloadProjectPathRooms } from '../collab.js';
import { requireProjectAccess, touchProject } from '../access.js';
import { assertStorageQuota } from '../quotas.js';
import { asyncHandler, HttpError, safeJoin, buildTree, isTextFile, sendCancellableJson, toPosix } from '../util.js';
import { reconcilePathRemoved, reconcilePathRenamed, reconcileContentReplaced } from '../services/agent/changesets.js';
import { buildProjectTreeWithoutWorkspace, listWorkspaceChildren } from '../services/fileListings.js';

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024, files: 1000 },
});

router.get('/:id/tree', asyncHandler(async (req, res) => {
  const { project } = requireProjectAccess(req.user, req.params.id);
  const root = projectDir(project.id);
  if (req.query.excludeWorkspace !== '1') { res.json({ tree: buildTree(root) }); return; }
  await sendCancellableJson(res, async signal => ({ tree: await buildProjectTreeWithoutWorkspace(root, { signal }) }));
}));

// The editor loads workspace metadata separately, one directory/page at a time.
router.get('/:id/workspace/children', asyncHandler(async (req, res) => {
  const { project } = requireProjectAccess(req.user, req.params.id);
  await sendCancellableJson(res, signal => listWorkspaceChildren(projectDir(project.id), {
    path: req.query.path === undefined ? '_workspace' : req.query.path,
    limit: req.query.limit,
    cursor: req.query.cursor,
    signal,
  }));
}));

/** 读取/下载文件。默认 inline（供图片预览），download=1 强制附件。 */
router.get('/:id/file', asyncHandler(async (req, res, next) => {
  const { project } = requireProjectAccess(req.user, req.params.id);
  const abs = safeJoin(projectDir(project.id), String(req.query.path || ''));
  let stat;
  try { stat = await fs.promises.stat(abs); }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw new HttpError(404, '文件不存在'); throw error; }
  if (!stat.isFile()) throw new HttpError(404, '文件不存在');
  res.setHeader('Content-Type', mime.lookup(abs) || 'application/octet-stream');
  if (req.query.download) {
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(path.basename(abs))}"`);
  }
  // sendFile supports range requests and closes its stream on disconnect.
  res.sendFile(abs, { dotfiles: 'allow' }, error => {
    if (!error || res.destroyed) return;
    if (res.headersSent) { res.destroy(error); return; }
    if (error.status === 416) { res.setHeader('Content-Range', `bytes */${stat.size}`); res.status(416).end(); return; }
    if (error.status === 404) { next(new HttpError(404, '文件不存在')); return; }
    next(error);
  });
}));

/** PDF 转 PNG 缓存（pdftoppm），按源文件 mtime+size 失效重建。 */
async function pdfToPng(abs, rel, dir) {
  const st = fs.statSync(abs);
  const cacheDir = path.join(dir, '.build', 'figures');
  const key = crypto.createHash('sha256').update(rel).digest('hex');
  const cacheFile = path.join(cacheDir, `${key}.png`);
  const metaFile = `${cacheFile}.json`;
  let fresh = false;
  if (fs.existsSync(cacheFile) && fs.existsSync(metaFile)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      fresh = meta.mtimeMs === st.mtimeMs && meta.size === st.size;
    } catch { /* 元数据损坏则重建 */ }
  }
  if (!fresh) {
    fs.mkdirSync(cacheDir, { recursive: true });
    const prefix = cacheFile.slice(0, -'.png'.length);
    await new Promise((resolve, reject) => {
      const child = spawn('pdftoppm', ['-png', '-singlefile', '-r', '150', abs, prefix]);
      child.on('error', () => reject(new HttpError(415, 'pdftoppm 不可用，无法预览 PDF 插图')));
      child.on('close', (code) => {
        if (code === 0 && fs.existsSync(cacheFile)) resolve();
        else reject(new HttpError(415, 'PDF 转换失败'));
      });
    });
    fs.writeFileSync(metaFile, JSON.stringify({ mtimeMs: st.mtimeMs, size: st.size }));
  }
  return cacheFile;
}

/** 插图预览：PDF 经 pdftoppm 转 PNG（带缓存），其余类型与 /:id/file 一致。 */
router.get('/:id/figure', asyncHandler(async (req, res) => {
  const { project } = requireProjectAccess(req.user, req.params.id);
  const dir = projectDir(project.id);
  let rel = String(req.query.path || '');
  let abs = safeJoin(dir, rel);
  // Match latex2html's existing extension order without loading a full tree.
  if (req.query.resolve === '1' && !/\.[a-zA-Z0-9]+$/.test(rel)) {
    for (const ext of ['.pdf', '.png', '.jpg', '.jpeg', '.webp']) {
      const candidate = safeJoin(dir, rel + ext);
      try {
        if ((await fs.promises.stat(candidate)).isFile()) { rel += ext; abs = candidate; break; }
      } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
    }
  }
  let stat;
  try { stat = await fs.promises.stat(abs); }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw new HttpError(404, '文件不存在'); throw error; }
  if (!stat.isFile()) throw new HttpError(404, '文件不存在');
  if (path.extname(abs).toLowerCase() !== '.pdf') {
    const mimeType = mime.lookup(abs) || 'application/octet-stream';
    res.setHeader('Content-Type', mimeType);
    fs.createReadStream(abs).pipe(res);
    return;
  }
  const png = await pdfToPng(abs, rel, dir);
  res.setHeader('Content-Type', 'image/png');
  fs.createReadStream(png).pipe(res);
}));

/** 新建或保存文本文件。overwrite 缺省 false（新建模式，已存在则 409）。 */
router.post('/:id/files', asyncHandler(async (req, res) => {
  const { project } = requireProjectAccess(req.user, req.params.id, { write: true });
  const rel = String(req.body?.path || '');
  const content = String(req.body?.content ?? '');
  const overwrite = !!req.body?.overwrite;
  const abs = safeJoin(projectDir(project.id), rel);
  if (fs.existsSync(abs) && !overwrite) throw new HttpError(409, '文件已存在');
  assertStorageQuota(req.user, Buffer.byteLength(content));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  // 覆盖已有文件时同样对账(新建文件没有遗留条目,调用是幂等无害的)
  if (overwrite) reconcileContentReplaced(project.id, [toPosix(rel)]);
  touchProject(project.id);
  res.json({ ok: true });
}));

router.post('/:id/mkdir', asyncHandler(async (req, res) => {
  const { project } = requireProjectAccess(req.user, req.params.id, { write: true });
  const abs = safeJoin(projectDir(project.id), String(req.body?.path || ''));
  if (fs.existsSync(abs)) throw new HttpError(409, '目录已存在');
  fs.mkdirSync(abs, { recursive: true });
  touchProject(project.id);
  res.json({ ok: true });
}));

/** 上传文件/目录。字段 files[]，body.paths 为与文件对应的相对路径 JSON 数组。 */
router.post('/:id/upload', upload.array('files', 1000), asyncHandler(async (req, res) => {
  const { project } = requireProjectAccess(req.user, req.params.id, { write: true });
  const dir = projectDir(project.id);
  const files = req.files || [];
  if (!files.length) throw new HttpError(400, '没有文件');
  let paths = [];
  try { paths = JSON.parse(req.body?.paths || '[]'); } catch {}
  const total = files.reduce((s, f) => s + f.size, 0);
  assertStorageQuota(req.user, total);
  const saved = [];
  const overwritten = [];
  for (let i = 0; i < files.length; i++) {
    const rel = paths[i] || files[i].originalname;
    const abs = safeJoin(dir, String(rel));
    if (fs.existsSync(abs)) overwritten.push(toPosix(path.relative(dir, abs)));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, files[i].buffer);
    saved.push(toPosix(path.relative(dir, abs)));
  }
  // 人工覆盖同步到影子基线；仍独立存在的 AI 修改继续待审。
  if (overwritten.length) reconcileContentReplaced(project.id, overwritten);
  touchProject(project.id);
  res.json({ ok: true, saved });
}));

/** 重命名/移动 {path, newPath} */
router.patch('/:id/files', asyncHandler(async (req, res) => {
  const { project } = requireProjectAccess(req.user, req.params.id, { write: true });
  const dir = projectDir(project.id);
  const src = safeJoin(dir, String(req.body?.path || ''));
  const dst = safeJoin(dir, String(req.body?.newPath || ''));
  if (!fs.existsSync(src)) throw new HttpError(404, '源不存在');
  if (fs.existsSync(dst)) throw new HttpError(409, '目标已存在');
  if (fs.statSync(src).isDirectory() && dst.startsWith(src + path.sep)) {
    throw new HttpError(400, '不能移动目录到其内部');
  }
  // Accepted editor updates must reach disk before moving its current bytes.
  // A failed save leaves both the old path and the dirty room intact.
  flushProjectRooms(project.id, { strict: true });
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const oldPath = toPosix(path.relative(dir, src));
  const newPath = toPosix(path.relative(dir, dst));
  const moved = (file) => file === oldPath ? newPath : file.startsWith(oldPath + '/') ? newPath + file.slice(oldPath.length) : file;
  const mainFile = moved(project.main_file);
  fs.renameSync(src, dst);
  // The compilation entry and human comments follow the same file. AI review
  // snapshots retain their existing invalidation policy below.
  const db = getDb();
  try {
    db.transaction(() => {
      if (mainFile !== project.main_file) db.prepare('UPDATE projects SET main_file = ? WHERE id = ?').run(mainFile, project.id);
      const update = db.prepare('UPDATE reviews SET file_path = ? WHERE id = ? AND project_id = ?');
      for (const review of db.prepare('SELECT id, file_path FROM reviews WHERE project_id = ?').all(project.id)) {
        const file = moved(review.file_path);
        if (file !== review.file_path) update.run(file, review.id, project.id);
      }
    })();
  } catch (error) {
    fs.renameSync(dst, src);
    throw error;
  }
  reloadProjectPathRooms(project.id, oldPath);
  reloadProjectPathRooms(project.id, newPath);
  // 旧路径上的待审条目作废(人工移动是最终决定,不迁移审查项到新路径)
  reconcilePathRenamed(project.id, oldPath);
  touchProject(project.id);
  res.json({ ok: true, path: oldPath, newPath, mainFile });
}));

router.delete('/:id/files', asyncHandler(async (req, res) => {
  const { project } = requireProjectAccess(req.user, req.params.id, { write: true });
  const rel = String(req.query.path || '');
  const abs = safeJoin(projectDir(project.id), rel);
  if (!fs.existsSync(abs)) throw new HttpError(404, '不存在');
  fs.rmSync(abs, { recursive: true, force: true });
  // 人工删除是最终决定:作废该路径遗留的待审条目与审查基线,防止幻影审查与重启复活
  reconcilePathRemoved(project.id, toPosix(rel));
  touchProject(project.id);
  res.json({ ok: true });
}));

export default router;
