import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { getDb } from '../db.js';
import { projectDir } from '../config.js';
import { requireProjectAccess } from '../access.js';
import { asyncHandler, HttpError, safeJoin, toPosix, isReservedName } from '../util.js';
import { compileProject } from '../services/compile.js';
import { createSnapshot } from '../services/versions.js';
import { codeToPdf, pdfToCode } from '../services/synctex.js';
import { synctexLineMap } from '../services/synctexMap.js';
import { computeTexStats } from '../services/texStats.js';
import { findBuild } from '../services/buildArtifacts.js';

import { resolveTexRuntime } from '../services/texRuntimes.js';

const router = Router();

function pdfRuntime(build) {
  return resolveTexRuntime(build.texVersion || 'system', { allowDisabled: true });
}

// Preferences are saved independently of compilation. An in-flight compile
// keeps its captured engine/runtime; switching only affects the next request.
router.patch('/:id/compile/settings', asyncHandler(async (req, res) => {
  const { project } = requireProjectAccess(req.user, req.params.id, { write: true, allowArchived: true });
  const { engine, texVersion } = req.body || {};
  if (engine === undefined && texVersion === undefined) throw new HttpError(400, '请选择编译引擎或 TeX Live 版本');
  if (engine !== undefined && !['xelatex', 'pdflatex', 'lualatex'].includes(engine)) throw new HttpError(400, '不支持的编译引擎');
  if (texVersion !== undefined) resolveTexRuntime(texVersion);
  const db = getDb();
  db.transaction(() => {
    if (engine !== undefined) db.prepare('UPDATE projects SET compile_engine = ? WHERE id = ?').run(engine, project.id);
    if (texVersion !== undefined) db.prepare('UPDATE projects SET tex_version = ? WHERE id = ?').run(texVersion, project.id);
  })();
  const saved = db.prepare('SELECT compile_engine, tex_version FROM projects WHERE id = ?').get(project.id);
  res.json({ engine: saved.compile_engine, texVersion: saved.tex_version || 'system' });
}));

router.post('/:id/compile', asyncHandler(async (req, res) => {
  // 归档项目只读但允许重新编译
  const { project } = requireProjectAccess(req.user, req.params.id, { write: true, allowArchived: true });
  const result = await compileProject({ project, user: req.user, engine: req.body?.engine, texVersion: req.body?.texVersion,
    // The compile lease also covers its asynchronous snapshot finalization.
    // A release must not begin after the engine exits but before the zip closes.
    afterCompile: async (completed) => {
      if (completed.status !== 'success') return;
      try {
        await createSnapshot({ project, user: req.user, message: '自动快照（编译）', skipIfUnchanged: true });
      } catch (err) {
        console.error(`[versions] 自动快照失败 (project ${project.id}): ${err.message}`);
      }
    },
  });
  if (result.status === 'success' && req.body?.texVersion !== undefined && req.body?.persistSelection !== false) {
    getDb().prepare('UPDATE projects SET tex_version = ? WHERE id = ? AND tex_version = ? AND compile_engine = ?').run(result.texVersion, project.id, project.tex_version, project.compile_engine);
  }
  res.json(result);
}));

router.get('/:id/pdf', asyncHandler(async (req, res) => {
  const { project } = requireProjectAccess(req.user, req.params.id);
  const { pdf } = findBuild(project, req.query.jobId);
  res.set('Cache-Control', 'private, no-cache');
  res.sendFile(pdf);
}));

router.get('/:id/compile/output', asyncHandler(async (req, res) => {
  const { project } = requireProjectAccess(req.user, req.params.id);
  res.set('Cache-Control', 'private, no-store');
  const { jobId } = findBuild(project);
  const pdfUrl = `/api/projects/${project.public_id}/pdf${jobId ? `?jobId=${jobId}` : ''}`;
  res.json({ pdfUrl, pdfJobId: jobId });
}));

router.get('/:id/log', asyncHandler(async (req, res) => {
  const { project } = requireProjectAccess(req.user, req.params.id);
  const db = getDb();
  let job;
  if (req.query.jobId !== undefined && req.query.jobId !== '') {
    job = db.prepare('SELECT * FROM compile_jobs WHERE id = ? AND project_id = ?')
      .get(Number(req.query.jobId), project.id);
  } else {
    job = db.prepare('SELECT * FROM compile_jobs WHERE project_id = ? ORDER BY id DESC LIMIT 1')
      .get(project.id);
  }
  if (!job) throw new HttpError(404, '编译记录不存在');
  if (!job.log_path) throw new HttpError(404, '该次编译没有保存日志');
  const root = path.resolve(projectDir(project.id));
  const abs = path.resolve(root, job.log_path);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new HttpError(400, '非法路径');
  if (!fs.existsSync(abs)) throw new HttpError(404, '日志文件不存在');
  res.type('text/plain');
  fs.createReadStream(abs).pipe(res);
}));

router.get('/:id/compile/jobs', asyncHandler(async (req, res) => {
  const { project } = requireProjectAccess(req.user, req.params.id);
  const jobs = getDb().prepare(`
    SELECT j.id, j.project_id AS projectId, j.engine, j.tex_version AS texVersion, j.status,
           j.duration_ms AS durationMs, j.created_at AS createdAt, u.username
    FROM compile_jobs j LEFT JOIN users u ON u.id = j.user_id
    WHERE j.project_id = ? ORDER BY j.id DESC LIMIT 50`).all(project.id);
  res.json({ jobs });
}));

router.get('/:id/synctex/code', asyncHandler(async (req, res) => {
  const { project } = requireProjectAccess(req.user, req.params.id);
  const line = Number(req.query.line);
  const col = Number(req.query.col || 1);
  const file = String(req.query.file || '');
  if (!file || !Number.isSafeInteger(line) || line < 1 || !Number.isSafeInteger(col) || col < 1) {
    throw new HttpError(400, '参数无效');
  }
  const build = findBuild(project, req.query.jobId);
  const abs = safeJoin(build.root, file);
  const hit = await codeToPdf(build.pdf, abs, line, col, pdfRuntime(build), build.root);
  if (!hit) throw new HttpError(404, '无法定位到 PDF 位置');
  res.json(hit);
}));

router.get('/:id/synctex/pdf', asyncHandler(async (req, res) => {
  const { project } = requireProjectAccess(req.user, req.params.id);
  const page = Number(req.query.page);
  const x = Number(req.query.x);
  const y = Number(req.query.y);
  if (!Number.isInteger(page) || page < 1 || !Number.isFinite(x) || !Number.isFinite(y)) {
    throw new HttpError(400, '参数无效');
  }
  const build = findBuild(project, req.query.jobId);
  const hit = await pdfToCode(build.pdf, page, x, y, pdfRuntime(build), build.root);
  if (!hit) throw new HttpError(404, '无法定位到源码位置');
  const root = path.resolve(build.root);
  const resolved = path.resolve(hit.file);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new HttpError(404, '定位结果不在项目内');
  }
  const rel = toPosix(path.relative(root, resolved));
  if (!rel || isReservedName(rel.split('/')[0])) throw new HttpError(404, '定位结果不在项目内');
  res.json({ file: rel, line: hit.line, ...(hit.column > 0 ? { column: hit.column } : {}) });
}));

router.get('/:id/synctex/map', asyncHandler(async (req, res) => {
  const { project } = requireProjectAccess(req.user, req.params.id);
  const file = String(req.query.file || '');
  if (!file) throw new HttpError(400, '参数无效');
  const build = findBuild(project, req.query.jobId);
  const abs = safeJoin(build.root, file);
  const map = await synctexLineMap(build.pdf, abs, build.root);
  res.json(map || { lines: [] });
}));

router.get('/:id/stats', asyncHandler(async (req, res) => {
  const { project } = requireProjectAccess(req.user, req.params.id);
  const sources = [];
  const walk = (cur) => {
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) {
        if (e.name.startsWith('.') || isReservedName(e.name)) continue;
        walk(p);
      } else if (e.isFile() && e.name.toLowerCase().endsWith('.tex')) {
        try { sources.push(fs.readFileSync(p, 'utf8')); } catch {}
      }
    }
  };
  walk(projectDir(project.id));
  res.json(computeTexStats(sources));
}));

export default router;
