import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { runProcess } from './process.js';
import { HttpError } from '../util.js';
import { resolveTexRuntime } from './texRuntimes.js';
import { texRepositories, verifyTexRepository } from './texMirrors.js';
import { FONT_DIR, RUNTIME_DIR, runtimeEnvironment, bumpRuntimeResourceRevision, withRuntimeInstallLock, acquireRuntimeGuard, releaseRuntimeGuard, tryWithRuntimeGuard, withRuntimeJobGuard } from './runtimeEnvironment.js';

function checkProcess(result, message) {
  if (result.exitCode !== 0) throw new HttpError(422, `${message}：${(result.stderr || result.stdout || `退出码 ${result.exitCode}`).slice(-2500)}`);
  return result;
}

async function checkInstallAccess(signal, beforeInstall) {
  signal?.throwIfAborted();
  await beforeInstall?.();
  signal?.throwIfAborted();
}
export async function listRuntimeFonts() {
  const result = checkProcess(await runProcess('fc-list', ['--format', '%{family}\t%{style}\t%{file}\n'], { env: runtimeEnvironment(), timeoutMs: 15000 }), '无法读取字体清单');
  const seen = new Set();
  return result.stdout.split('\n').filter(Boolean).map(line => {
    const [family, style, file] = line.split('\t');
    return { family, style, file, managed: !!file?.startsWith(FONT_DIR + path.sep) };
  }).filter(font => {
    const key = font.family + '\t' + font.style + '\t' + font.file;
    if (seen.has(key)) return false; seen.add(key); return true;
  }).sort((a, b) => a.family.localeCompare(b.family));
}

export async function installFontFiles(files, { signal, beforeInstall } = {}) {
  if (!Array.isArray(files) || !files.length || files.length > 12) throw new HttpError(400, '请选择 1–12 个 TTF、OTF 或 TTC 字体文件');
  for (const file of files) {
    const extension = path.extname(file.originalname || '').toLowerCase();
    if (!['.ttf', '.otf', '.ttc'].includes(extension) || !Buffer.isBuffer(file.buffer) || file.buffer.length < 12 || file.buffer.length > 30 * 1024 * 1024) {
      throw new HttpError(400, '字体仅支持 TTF、OTF、TTC，每个文件不超过 30 MB');
    }
    if (!['00010000', '4f54544f', '74746366', '74727565'].includes(file.buffer.subarray(0, 4).toString('hex'))) throw new HttpError(400, '文件内容不是有效的 OpenType/TrueType 字体');
  }
  return withRuntimeInstallLock(async () => {
    await checkInstallAccess(signal, beforeInstall);
    const env = runtimeEnvironment();
    const temp = fs.mkdtempSync(path.join(RUNTIME_DIR, '.font-upload-'));
    try {
      const staged = [];
      for (const file of files) {
        signal?.throwIfAborted();
        const hash = createHash('sha256').update(file.buffer).digest('hex');
        const filename = hash + path.extname(file.originalname).toLowerCase();
        const candidate = path.join(temp, filename);
        fs.writeFileSync(candidate, file.buffer);
        const scanned = checkProcess(await runProcess('fc-scan', ['--format', '%{family}\n', candidate], { env, signal, timeoutMs: 15000 }), '字体校验失败');
        if (!scanned.stdout.trim()) throw new HttpError(400, '字体文件没有可识别的字体族');
        staged.push({ candidate, destination: path.join(FONT_DIR, filename) });
      }
      const added = staged.filter(file => !fs.existsSync(file.destination));
      await checkInstallAccess(signal, beforeInstall);
      if (added.length) {
        bumpRuntimeResourceRevision();
        for (const file of added) if (fs.existsSync(file.candidate)) fs.renameSync(file.candidate, file.destination);
      }
      // Retry cache updates even when a prior attempt already persisted the file.
      checkProcess(await runProcess('fc-cache', ['-f', FONT_DIR], { env, signal, timeoutMs: 60000 }), '更新字体缓存失败');
      await checkInstallAccess(signal, beforeInstall);
      // New Python processes rebuild discovery from fontconfig; other matplotlib
      // preferences and user files remain intact.
      for (const name of fs.readdirSync(env.MPLCONFIGDIR)) {
        if (/^fontlist-v\d+(?:\.\d+)*\.json$/.test(name)) fs.unlinkSync(path.join(env.MPLCONFIGDIR, name));
      }
      const fonts = (await listRuntimeFonts()).filter(font => font.managed);
      return { changed: added.length > 0, fonts };
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  });
}

export async function installTexPackages({ version = '2024', packages }, { signal, beforeInstall, persistRepository = true } = {}) {
  if (!Array.isArray(packages) || !packages.length || packages.length > 50 || packages.some(name => typeof name !== 'string' || !/^[a-z0-9][a-z0-9+_.-]{0,99}$/.test(name))) {
    throw new HttpError(400, '请提供 1–50 个有效的 TeX Live 宏包名称，不接受命令或 URL');
  }
  packages = [...new Set(packages)];
  version = String(version);
  return withRuntimeInstallLock(async () => {
    await checkInstallAccess(signal, beforeInstall);
    // Resolve inside the lock so an installation/configuration race cannot use
    // a stale binary path or install into an unmanaged system distribution.
    const runtime = resolveTexRuntime(version);
    if (!runtime.managed) throw new HttpError(409, '系统 TeX 由操作系统维护。请先安装并启用持久化 TeX Live 版本，再为该版本安装宏包。');
    const tlmgr = path.join(runtime.binDir, 'tlmgr');
    const env = runtimeEnvironment(runtime.env);
    const check = async () => {
      const result = checkProcess(await runProcess(tlmgr, ['info', '--only-installed', '--data', 'name', ...packages], { env, signal, timeoutMs: 60000 }), '读取宏包清单失败');
      return new Set(result.stdout.split(/\s+/));
    };
    const existing = await check();
    if (packages.every(name => existing.has(name))) return { changed: false, version, packages, output: '所选宏包已安装' };

    const failures = [];
    let revisionBumped = false;
    for (const repository of texRepositories(version)) {
      await checkInstallAccess(signal, beforeInstall);
      try {
        // A repository must identify itself as this exact release before tlmgr
        // may mutate any files; current-year mirrors cannot serve old projects.
        await verifyTexRepository(version, repository, { signal });
        await checkInstallAccess(signal, beforeInstall);
        if (!revisionBumped) { bumpRuntimeResourceRevision(); revisionBumped = true; }
        const installed = checkProcess(await runProcess(tlmgr, ['--repository', repository, 'install', ...packages], {
          env, signal, timeoutMs: 15 * 60 * 1000, maxOutputBytes: 128 * 1024,
        }), '安装 TeX 宏包失败');
        const verified = await check();
        const missing = packages.filter(name => !verified.has(name));
        if (missing.length) throw new HttpError(422, '安装结束但仍未找到宏包：' + missing.join(', '));
        if (persistRepository) {
          await checkInstallAccess(signal, beforeInstall);
          checkProcess(await runProcess(tlmgr, ['option', 'repository', repository], { env, signal, timeoutMs: 60000 }), '保存 TeX 镜像失败');
        }
        return { changed: true, version, packages, repository, output: installed.stdout.slice(-12000) };
      } catch (error) {
        await checkInstallAccess(signal, beforeInstall);
        failures.push(repository + '：' + String(error?.message || error).slice(-400));
      }
    }
    throw new HttpError(422, '安装 TeX 宏包失败，所有同版本镜像均不可用：' + failures.join('；').slice(-2500));
  });
}

const jobsPath = () => { const dir = path.join(RUNTIME_DIR, 'jobs'); fs.mkdirSync(dir, { recursive: true }); return dir; };
const activeJobs = new Map();
let startingJob = false;
export function activeRuntimeJobCount() { return activeJobs.size + (startingJob ? 1 : 0); }
function saveJob(job) {
  const filename = path.join(jobsPath(), job.id + '.json'), temp = filename + '.' + randomUUID();
  fs.writeFileSync(temp, JSON.stringify(job)); fs.renameSync(temp, filename);
}
const recoverJob = String.raw`
const fs = require('node:fs');
const filename = process.argv[1];
try {
  const job = JSON.parse(fs.readFileSync(filename, 'utf8'));
  if (job.status === 'running' && job.guardProtocol === 2) {
    job.status = 'failed'; job.error = '服务中断了安装，请检查环境后重试'; job.finishedAt = new Date().toISOString();
    const temp = filename + '.' + process.pid + '-' + Math.random().toString(16).slice(2);
    fs.writeFileSync(temp, JSON.stringify(job)); fs.renameSync(temp, filename);
  }
} catch (error) { if (error.code !== 'ENOENT') process.exit(1); }
`;
export function listRuntimeJobs() {
  return fs.readdirSync(jobsPath()).filter(name => /^[\da-f-]+\.json$/.test(name)).map(name => {
    const filename = path.join(jobsPath(), name), fileId = name.slice(0, -5);
    let job; try { job = JSON.parse(fs.readFileSync(filename, 'utf8')); } catch { return null; }
    if (job.id !== fileId) return null;
    if (job.status === 'running' && !activeJobs.has(job.id)) {
      if (job.guardProtocol === 2) {
        // Reread and update only under the job guard so a concurrent successful
        // completion cannot be overwritten by stale recovery information.
        const recovered = tryWithRuntimeGuard(path.join(jobsPath(), fileId + '.guard'), recoverJob, [filename]);
        if (recovered === true) {
          try { job = JSON.parse(fs.readFileSync(filename, 'utf8')); } catch { return null; }
        } else if (recovered === null) {
          job.status = 'unknown'; job.message = '安装任务状态无法自动确认，请管理员检查后重试';
        }
      } else {
        // Older jobs have no guard; even a dead PID cannot prove that their
        // detached installer process has stopped. Do not alter the stored job.
        job.status = 'unknown'; job.message = '旧版安装任务状态无法自动确认，请管理员检查后重试';
      }
    }
    const { pid, host, guardProtocol, ...visible } = job; return visible;
  }).filter(Boolean).sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 30);
}
export async function startRuntimeJob(type, details, action) {
  if (startingJob || activeJobs.size) throw new HttpError(409, '已有环境安装任务进行中，请等待完成后重试');
  startingJob = true;
  const job = { id: randomUUID(), type, ...details, status: 'running', startedAt: new Date().toISOString(), pid: process.pid, host: os.hostname(), guardProtocol: 2 };
  let guard;
  try {
    // Acquire before persisting the job: another server can safely determine
    // whether this exact job survived, independent of hostname or PID reuse.
    guard = await acquireRuntimeGuard(path.join(jobsPath(), job.id + '.guard'));
    saveJob(job);
    const promise = Promise.resolve().then(() => withRuntimeJobGuard(job.id, guard, () => action(message => { job.message = String(message).slice(-2000); saveJob(job); }))).then(result => {
      job.status = 'succeeded'; job.result = result; job.message = result?.changed === false ? '已安装，无需重复安装' : '安装完成';
    }, error => { job.status = 'failed'; job.error = String(error.message || error).slice(-4000); }).finally(async () => {
      job.finishedAt = new Date().toISOString();
      try { saveJob(job); } finally { await releaseRuntimeGuard(guard); activeJobs.delete(job.id); }
    });
    activeJobs.set(job.id, promise);
    promise.catch(error => console.error('[runtime job]', error));
    const { pid, host, guardProtocol, ...visible } = job; return visible;
  } catch (error) {
    if (guard) await releaseRuntimeGuard(guard);
    throw error;
  } finally { startingJob = false; }
}
