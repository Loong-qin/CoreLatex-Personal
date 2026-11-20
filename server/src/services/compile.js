import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runProcess } from './process.js';
import { projectDir } from '../config.js';
import { getDb } from '../db.js';
import { HttpError } from '../util.js';
import { assertCompileQuota, recordCompileSeconds } from '../quotas.js';
import { parseLatexLog } from './latexLog.js';
import { flushProjectRooms } from '../collab.js';
import { createCompileLease, startCompileLease, finishCompileLease } from './maintenance.js';

import { resolveTexRuntime } from './texRuntimes.js';
import { assertRuntimeReady } from './runtimeEnvironment.js';
import { publishBuild, pruneBuilds } from './buildArtifacts.js';
import { captureCompilationInputs, compilationInputBoundary, readCompilationRecorder } from './compileInputs.js';

const ENGINES = new Set(['xelatex', 'pdflatex', 'lualatex']);
const PASS_TIMEOUT_MS = 120 * 1000;
const MAX_PASSES = 3;
const WORK_DIRECTORY = '.build/work';

// 每项目串行编译队列：projectId -> Promise
const queues = new Map();

function enqueueCompile({ project, user, kind, signal }, work) {
  signal?.throwIfAborted();
  assertRuntimeReady({ allowIndependentInstall: true });
  const db = getDb();
  const lease = createCompileLease(db, { projectId: project.id, userId: user.id, kind });
  const prev = queues.get(project.id) || Promise.resolve();
  const next = prev.catch(() => {}).then(async () => {
    signal?.throwIfAborted();
    startCompileLease(db, lease);
    return work();
  }).finally(() => finishCompileLease(db, lease));
  queues.set(project.id, next);
  const done = () => { if (queues.get(project.id) === next) queues.delete(project.id); };
  next.then(done, done);
  // The lease follows real execution/cleanup, not this caller's abort race.
  return waitForQueue(next, signal);
}

export function compileProject({ project, user, engine, texVersion, snapshotPdf = false, signal, afterCompile } = {}) {
  return enqueueCompile({ project, user, kind: 'compile', signal }, async () => {
    let result = await doCompile({ project, user, engine, texVersion, signal, captureInputs: snapshotPdf });
    if (snapshotPdf && result.status === 'success') {
      const base = path.basename(project.main_file || 'main.tex').replace(/\.tex$/i, '');
      result = snapshotCompilePdf(result, path.join(projectDir(project.id), WORK_DIRECTORY, base + '.pdf'));
    }
    if (afterCompile) await afterCompile(result);
    return result;
  });
}

// Cancellation releases the caller immediately without releasing this project's queue early.
function waitForQueue(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason || new DOMException('Operation cancelled', 'AbortError'));
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}

// ---------- 变更集预览编译：基线 + 暂存修改 的隔离副本 ----------

/** 独立复制项目树；可用时使用写时复制，预览写入不会改动正式文件。 */
function copyPreviewTree(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  let files = 0;
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (['.build', '.preview', '.versions', '.git'].includes(entry.name)) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) files += copyPreviewTree(s, d);
    else if (entry.isFile()) {
      fs.copyFileSync(s, d, fs.constants.COPYFILE_FICLONE);
      files += 1;
    }
  }
  return files;
}

/**
 * 变更集预览编译：把项目独立复制到隔离副本 .preview/，将暂存修改（staged:
 * [{path, after}]，after 为完整新内容）覆盖到副本后编译——正式文件与正式
 * 编译产物（.build/）均不受影响，智能体中途即可看到「改完后的真实效果」。
 * 与正式编译共用每项目串行队列，避免并发 latex 进程。
 */
export function previewCompileProject({ project, user, engine, texVersion, staged = [], snapshotPdf = false, signal, afterCompile } = {}) {
  return enqueueCompile({ project, user, kind: 'preview', signal }, async () => {
    const result = await doPreviewCompile({ project, user, engine, texVersion, staged, signal, captureInputs: snapshotPdf });
    const output = snapshotPdf && result.ok ? snapshotCompilePdf(result, result.pdfPath) : result;
    if (afterCompile) await afterCompile(output);
    return output;
  });
}

// 在编译队列释放前固定 PDF；异步转图期间后续编译可安全更新 .build/.preview。
// 调用方在使用后负责删除 snapshotDir，包括错误分支。
function snapshotCompilePdf(result, source) {
  const snapshotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'corelatex-pdf-preview-'));
  try {
    const pdfPath = path.join(snapshotDir, 'document.pdf');
    fs.copyFileSync(source, pdfPath);
    return { ...result, pdfPath, snapshotDir };
  } catch (error) {
    fs.rmSync(snapshotDir, { recursive: true, force: true });
    error.compileEvidence = { status: 'succeeded', attempted: true, stage: 'preview', previewStatus: 'failed',
      code: 'PDF_SNAPSHOT_ERROR', retryable: true, message: 'PDF 编译成功，但保存预览快照失败：' + error.message };
    throw error;
  }
}

async function startInputCapture(buildDir, base, signal) {
  return { recorderPath: path.join(buildDir, base + '.fls'), recorders: [],
    startedAt: await compilationInputBoundary(buildDir, { signal }) };
}

async function doPreviewCompile({ project, user, engine, texVersion, staged, signal, captureInputs }) {
  signal?.throwIfAborted();
  if (engine !== undefined && engine !== null && engine !== '' && !ENGINES.has(engine)) {
    throw new HttpError(400, '不支持的编译引擎');
  }
  assertCompileQuota(user);
  const runtime = resolveTexRuntime(texVersion || project.tex_version || 'system');
  flushProjectRooms(project.id);
  const dir = projectDir(project.id);
  const shadow = path.join(dir, '.preview');
  fs.rmSync(shadow, { recursive: true, force: true });
  copyPreviewTree(dir, shadow);

  // 应用暂存修改，仅写入独立预览副本
  for (const item of staged) {
    const rel = String(item.path || '').replace(/\\/g, '/');
    if (!rel || rel.split('/').includes('..') || path.isAbsolute(rel)) continue;
    const target = path.join(shadow, rel);
    if (target !== shadow && !target.startsWith(shadow + path.sep)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.rmSync(target, { force: true });
    fs.writeFileSync(target, Buffer.from(item.after ?? '', item.encoding === 'base64' ? 'base64' : 'utf8'));
  }

  const buildDir = path.join(shadow, '.build');
  fs.mkdirSync(buildDir, { recursive: true });
  const eng = engine || (ENGINES.has(project.compile_engine) ? project.compile_engine : 'pdflatex');
  const mainFile = project.main_file || 'main.tex';
  const base = path.basename(mainFile).replace(/\.tex$/i, '');
  for (const ext of ['.pdf', '.log', '.synctex.gz', '.synctex']) {
    try { fs.rmSync(path.join(buildDir, base + ext), { force: true }); } catch {}
  }

  const inputCapture = captureInputs ? await startInputCapture(buildDir, base, signal) : null;
  const startedAt = Date.now();
  const hasBib = hasBibFiles(shadow);
  let bibtexRan = false;
  let bibtexSucceeded = false;
  let log = '';
  let spawnError = null;
  let compileEvidence;
  let durationMs = 0;
  // Cancellation throws from runTex/runBibtex. Settle time once on every exit;
  // cancellation still propagates and never becomes a successful compilation.
  try {
    for (let pass = 1; pass <= MAX_PASSES; pass++) {
      const run = await runTex(eng, mainFile, shadow, signal, runtime, '.build', inputCapture);
      if (run.spawnError) spawnError = run.spawnError;
      if (run.compileEvidence) compileEvidence = run.compileEvidence;
      log = readLog(buildDir, base) || run.output;
      if (spawnError) break;
      if (pass >= MAX_PASSES) break;
      const needRerun = /Rerun to get|Rerun LaTeX/i.test(log);
      const citationUndef = /Citation[^\n]*undefined|undefined citations/i.test(log);
      if (citationUndef && hasBib && !bibtexRan) {
        bibtexRan = true;
        bibtexSucceeded = await runBibtex(base, buildDir, shadow, signal, runtime);
        continue;
      }
      if (needRerun || (citationUndef && hasBib)) continue;
      break;
    }

  } finally {
    durationMs = Date.now() - startedAt;
    recordCompileSeconds(user.id, durationMs / 1000);
  }

  const { errors, warnings } = parseLatexLog(log, shadow);
  if (spawnError && !errors.length) {
    errors.push({ file: '', line: 0, message: `编译失败: ${spawnError}` });
  }
  const pdfPath = path.join(buildDir, base + '.pdf');
  const ok = fs.existsSync(pdfPath) && errors.length === 0;
  const inputManifest = inputCapture && ok ? await captureCompilationInputs({ ...inputCapture,
    compileRoot: shadow, sourceRoot: dir, buildDir, stagedPaths: staged.map(item => item.path), signal, engine: eng,
    bibtexRan, unrecordedInputs: !inputCapture.startedAt || bibtexRan && !bibtexSucceeded,
    bibliographyLogPath: path.join(buildDir, base + '.blg'), runtime }) : undefined;
  return { ok, pdfPath, buildDir, base, engine: eng, texVersion: runtime.version, durationMs, errors, warnings, compileEvidence, inputManifest };
}

async function doCompile({ project, user, engine, texVersion, signal, captureInputs }) {
  signal?.throwIfAborted();
  if (engine !== undefined && engine !== null && engine !== '' && !ENGINES.has(engine)) {
    throw new HttpError(400, '不支持的编译引擎');
  }
  assertCompileQuota(user);
  const runtime = resolveTexRuntime(texVersion || project.tex_version || 'system');
  try {
    flushProjectRooms(project.id, { strict: true });
  } catch (error) {
    console.error(`[compile] 保存协作内容失败 (project ${project.id}): ${error.message}`);
    throw new HttpError(409, '协作内容尚未保存，请稍后重新编译');
  }

  const dir = projectDir(project.id);
  const buildDir = path.join(dir, WORK_DIRECTORY);
  fs.mkdirSync(buildDir, { recursive: true });
  const eng = engine || (ENGINES.has(project.compile_engine) ? project.compile_engine : 'pdflatex');
  const mainFile = project.main_file || 'main.tex';
  const base = path.basename(mainFile).replace(/\.tex$/i, '');

  // 清理旧产物，避免读到上一次的结果
  for (const ext of ['.pdf', '.log', '.synctex.gz', '.synctex']) {
    try { fs.rmSync(path.join(buildDir, base + ext), { force: true }); } catch {}
  }

  const inputCapture = captureInputs ? await startInputCapture(buildDir, base, signal) : null;
  const startedAt = Date.now();
  const hasBib = hasBibFiles(dir);
  let bibtexRan = false;
  let bibtexSucceeded = false;
  let output = '';
  let log = '';
  let spawnError = null;
  let compileEvidence;

  let durationMs = 0;
  // Cancellation throws from runTex/runBibtex. Settle time once on every exit;
  // cancellation still propagates and never becomes a successful compilation.
  try {
    for (let pass = 1; pass <= MAX_PASSES; pass++) {
      const run = await runTex(eng, mainFile, dir, signal, runtime, WORK_DIRECTORY, inputCapture);
      output = run.output;
      if (run.spawnError) spawnError = run.spawnError;
      if (run.compileEvidence) compileEvidence = run.compileEvidence;
      log = readLog(buildDir, base) || output;
      if (spawnError) break;
      if (pass >= MAX_PASSES) break;
      const needRerun = /Rerun to get|Rerun LaTeX/i.test(log);
      const citationUndef = /Citation[^\n]*undefined|undefined citations/i.test(log);
      if (citationUndef && hasBib && !bibtexRan) {
        bibtexRan = true;
        bibtexSucceeded = await runBibtex(base, buildDir, dir, signal, runtime);
        continue;
      }
      if (needRerun || (citationUndef && hasBib)) continue;
      break;
    }

  } finally {
    durationMs = Date.now() - startedAt;
    recordCompileSeconds(user.id, durationMs / 1000);
  }

  const { errors, warnings } = parseLatexLog(log, dir);
  if (spawnError && !errors.length) {
    errors.push({ file: '', line: 0, message: `编译失败: ${spawnError}` });
  }
  const pdfPath = path.join(buildDir, base + '.pdf');
  const pdfExists = fs.existsSync(pdfPath);
  const synctexAvailable = fs.existsSync(path.join(buildDir, base + '.synctex.gz'))
    || fs.existsSync(path.join(buildDir, base + '.synctex'));
  let status = pdfExists && errors.length === 0 ? 'success' : 'failed';
  const inputManifest = inputCapture && status === 'success' ? await captureCompilationInputs({ ...inputCapture,
    compileRoot: dir, buildDir, signal, engine: eng, bibtexRan,
    unrecordedInputs: !inputCapture.startedAt || bibtexRan && !bibtexSucceeded,
    bibliographyLogPath: path.join(buildDir, base + '.blg'), runtime }) : undefined;

  const db = getDb();
  const info = db
    .prepare('INSERT INTO compile_jobs (project_id, user_id, engine, status, duration_ms, tex_version, log_path) VALUES (?,?,?,?,?,?,NULL)')
    .run(project.id, user.id, eng, 'failed', durationMs, runtime.version);
  const jobId = Number(info.lastInsertRowid);
  let logPath = null;
  try {
    const rel = `.build/compile-${jobId}.log`;
    fs.writeFileSync(path.join(dir, rel), log || output || '');
    logPath = rel;
    db.prepare('UPDATE compile_jobs SET log_path = ? WHERE id = ?').run(logPath, jobId);
  } catch {}

  if (status === 'success') {
    try {
      publishBuild(dir, jobId, pdfPath);
    } catch (error) {
      console.error(`[compile] 无法发布构建产物 (job ${jobId}): ${error.message}`);
      errors.push({ file: '', line: 0, message: '保存 PDF 和 SyncTeX 构建产物失败，请重新编译' });
      status = 'failed';
    }
    if (status === 'success') {
      db.prepare("UPDATE compile_jobs SET status = 'success', published_pdf = 1 WHERE id = ?").run(jobId);
      pruneBuilds(dir);
    }
  }

  return {
    jobId,
    texVersion: runtime.version,
    compileEvidence,
    inputManifest,
    status,
    durationMs,
    errors,
    warnings,
    // 对外 URL 用 public_id:数字编号已不再作为项目访问标识(前端/网关按哈希解析)
    pdfUrl: status === 'success' ? `/api/projects/${project.public_id}/pdf?jobId=${jobId}` : '',
    pdfJobId: status === 'success' ? jobId : null,
    logUrl: `/api/projects/${project.public_id}/log?jobId=${jobId}`,
    synctexAvailable: status === 'success' && synctexAvailable,
  };
}

/** One pass; the process group is cancelled together with the owning agent. */
async function runTex(engine, mainFile, cwd, signal, runtime, outputDirectory, inputCapture) {
  signal?.throwIfAborted();
  try {
    if (inputCapture) {
      try { fs.rmSync(inputCapture.recorderPath, { force: true }); }
      catch { inputCapture.recorders.push({ recorded: true, reason: 'recorder-unreadable' }); }
    }
    const result = await runProcess(path.join(runtime.binDir, engine), [
      '-interaction=nonstopmode', '-file-line-error', '-synctex=1',
      '-no-shell-escape', ...(inputCapture ? ['-recorder'] : []), `-output-directory=${outputDirectory}`, mainFile,
    ], { cwd, signal, env: runtime.env, timeoutMs: PASS_TIMEOUT_MS });
    if (inputCapture) inputCapture.recorders.push(readCompilationRecorder(inputCapture.recorderPath, cwd, inputCapture.startedAt));
    return {
      output: result.stdout + result.stderr,
      spawnError: result.timedOut ? '编译超时，已强制终止'
        : result.exitCode !== 0 ? '编译进程异常退出（' + result.exitCode + '）' : null,
    };
  } catch (error) {
    signal?.throwIfAborted();
    return { output: '编译引擎启动失败: ' + error.message, spawnError: error.message,
      compileEvidence: { status: 'unavailable', attempted: false, stage: 'compile', code: 'COMPILER_UNAVAILABLE', retryable: false, message: '编译引擎无法启动：' + error.message } };
  }
}

async function runBibtex(base, buildDir, projectRoot, signal, runtime) {
  signal?.throwIfAborted();
  try {
    const result = await runProcess(path.join(runtime.binDir, 'bibtex'), [base], {
      cwd: buildDir, signal, timeoutMs: 60000,
      env: {
        ...runtime.env,
        BIBINPUTS: projectRoot + ':' + (process.env.BIBINPUTS || ''),
        BSTINPUTS: projectRoot + ':' + (process.env.BSTINPUTS || ''),
      },
    });
    return result.exitCode === 0;
  } catch {
    signal?.throwIfAborted();
    // Missing bibtex is represented in the final LaTeX diagnostics.
    return false;
  }
}

function readLog(buildDir, base) {
  try {
    return fs.readFileSync(path.join(buildDir, base + '.log'), 'utf8');
  } catch {
    return '';
  }
}

function hasBibFiles(dir) {
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (e.name.startsWith('.')) continue;
        stack.push(path.join(cur, e.name));
      } else if (e.isFile() && e.name.toLowerCase().endsWith('.bib')) {
        return true;
      }
    }
  }
  return false;
}
