import fs from 'node:fs';
import path from 'node:path';
import { projectDir } from '../config.js';
import { getDb } from '../db.js';
import { HttpError } from '../util.js';

const RETAINED_BUILDS = 10;

function publishedRoot(root) {
  return path.join(root, '.build', 'published');
}

export function publishBuild(root, jobId, sourcePdf) {
  const builds = publishedRoot(root);
  fs.mkdirSync(builds, { recursive: true });
  const stage = fs.mkdtempSync(path.join(builds, '.stage-'));
  try {
    fs.copyFileSync(sourcePdf, path.join(stage, 'document.pdf'), fs.constants.COPYFILE_FICLONE);
    const base = sourcePdf.slice(0, -4);
    const ext = ['.synctex.gz', '.synctex'].find(suffix => fs.existsSync(base + suffix));
    if (ext) fs.copyFileSync(base + ext, path.join(stage, 'document' + ext));
    fs.renameSync(stage, path.join(builds, String(jobId)));
  } finally {
    if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true, force: true });
  }
}

export function pruneBuilds(root) {
  const builds = publishedRoot(root);
  try {
    const entries = fs.readdirSync(builds);
    const ids = entries.filter(name => /^\d+$/.test(name))
      .sort((a, b) => Number(b) - Number(a));
    for (const name of [...ids.slice(RETAINED_BUILDS), ...entries.filter(name => name.startsWith('.stage-'))]) {
      fs.rmSync(path.join(builds, name), { recursive: true, force: true });
    }
  } catch (error) {
    console.warn('[compile] 无法清理旧构建产物:', error.message);
  }
}

export function findBuild(project, requestedJobId) {
  const legacy = requestedJobId === 'legacy';
  const explicit = requestedJobId !== undefined && !legacy;
  if (explicit && (typeof requestedJobId !== 'string' || !/^[1-9]\d*$/.test(requestedJobId)
      || !Number.isSafeInteger(Number(requestedJobId)))) throw new HttpError(400, '编译编号无效');
  const root = projectDir(project.id);
  const db = getDb();
  const jobs = db.prepare(explicit
    ? "SELECT id, tex_version, published_pdf FROM compile_jobs WHERE project_id = ? AND status = 'success' AND id = ?"
    : "SELECT id, tex_version, published_pdf FROM compile_jobs WHERE project_id = ? AND status = 'success' ORDER BY id DESC LIMIT 1");
  const job = explicit ? jobs.get(project.id, Number(requestedJobId)) : jobs.get(project.id);
  if (job?.published_pdf) {
    if (legacy) throw new HttpError(410, '此 PDF 的编译产物已过期，请刷新预览');
    const pdf = path.join(publishedRoot(root), String(job.id), 'document.pdf');
    if (fs.existsSync(pdf)) return { root, pdf, jobId: job.id, texVersion: job.tex_version };
    throw new HttpError(410, '此 PDF 的编译产物已过期，请重新编译');
  }
  if (explicit) throw new HttpError(404, '编译产物不存在');

  const base = path.basename(project.main_file || 'main.tex').replace(/\.tex$/i, '');
  const pdf = path.join(root, '.build', base + '.pdf');
  if (!fs.existsSync(pdf)) throw new HttpError(404, 'PDF 尚未生成，请先编译');
  return { root, pdf, jobId: 'legacy', texVersion: job?.tex_version || project.tex_version };
}
