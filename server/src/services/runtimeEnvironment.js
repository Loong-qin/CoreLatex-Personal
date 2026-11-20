import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { DATA_DIR } from '../config.js';
import { HttpError } from '../util.js';

export const RUNTIME_DIR = path.join(DATA_DIR, 'runtime');
export const FONT_DIR = path.join(RUNTIME_DIR, 'fonts');
const GUARD_PROTOCOL = 2;
const INSTALL_GUARD = path.join(RUNTIME_DIR, 'install.guard');
const guardContext = new AsyncLocalStorage();
const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');

export function runtimeEnvironment(baseEnv = process.env) {
  const cache = path.join(RUNTIME_DIR, 'fontconfig-cache');
  const matplotlib = path.join(RUNTIME_DIR, 'matplotlib');
  for (const dir of [FONT_DIR, cache, matplotlib]) fs.mkdirSync(dir, { recursive: true });
  const config = path.join(RUNTIME_DIR, 'fonts.conf');
  const content = `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd"><fontconfig><include ignore_missing="yes">/etc/fonts/fonts.conf</include><dir>${xml(FONT_DIR)}</dir><cachedir>${xml(cache)}</cachedir></fontconfig>\n`;
  if (!fs.existsSync(config) || fs.readFileSync(config, 'utf8') !== content) {
    const tmp = config + '.' + randomUUID(); fs.writeFileSync(tmp, content); fs.renameSync(tmp, config);
  }
  return { ...baseEnv, FONTCONFIG_FILE: config, MPLCONFIGDIR: matplotlib };
}

export function getRuntimeResourceRevision() {
  try { return fs.readFileSync(path.join(RUNTIME_DIR, 'revision'), 'utf8').trim(); }
  catch (error) { if (error.code === 'ENOENT') return 'initial'; throw error; }
}
export function bumpRuntimeResourceRevision() {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  const value = randomUUID(), destination = path.join(RUNTIME_DIR, 'revision');
  const tmp = destination + '.' + value; fs.writeFileSync(tmp, value); fs.renameSync(tmp, destination);
  return value;
}

// The guard file must never be removed: unlinking it while a process has it
// locked would permit a second inode, and therefore a second installer.
// flock is held by a small helper whose stdin is also inherited by any owned
// installer processes. If the server dies, the lock stays held until those
// processes exit, even when they run in a detached process group.
export async function acquireRuntimeGuard(filename) {
  if (process.platform !== 'linux') throw new HttpError(503, '运行环境安装需要 Linux 系统文件锁（flock）。');
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const child = spawn('flock', ['--nonblock', '--conflict-exit-code', '73', filename, 'sh', '-c', 'printf READY; cat >/dev/null'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.on('error', () => {});
  child.stderr.resume();
  const exited = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  try {
    await new Promise((resolve, reject) => {
      let settled = false, output = '';
      const finish = error => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (error) reject(error); else resolve();
      };
      const timer = setTimeout(() => finish(new HttpError(503, '无法启动运行环境锁，请检查 flock。')), 5000);
      child.stdout.on('data', chunk => { output += chunk.toString(); if (output.includes('READY')) finish(); });
      child.once('error', () => finish(new HttpError(503, '缺少可用的 flock，无法安全安装运行环境。')));
      child.once('close', code => finish(code === 73
        ? new HttpError(409, '已有环境安装任务进行中，请等待完成后重试。')
        : new HttpError(503, '运行环境锁启动失败，请检查 flock。')));
    });
    return { child, exited };
  } catch (error) {
    child.stdin.destroy();
    try { child.kill(); } catch {}
    await exited;
    throw error;
  }
}

export async function releaseRuntimeGuard(guard) {
  if (!guard) return;
  // destroy closes only this process's descriptor. end() would shutdown the
  // shared socket for all inherited descriptors and release too early.
  guard.child.stdin.destroy();
  await guard.exited;
}

// Run a recovery action while holding the same guard as the installer. A
// missing/unsupported guard is unknown, not evidence that another owner died.
// Return true when the action ran, false if busy, and null on uncertainty.
export function tryWithRuntimeGuard(filename, script, args = []) {
  if (process.platform !== 'linux' || !fs.existsSync(filename)) return null;
  const result = spawnSync('flock', ['--nonblock', '--conflict-exit-code', '73', filename, process.execPath, '-e', script, ...args], {
    stdio: 'ignore', timeout: 5000,
  });
  if (result.status === 0) return true;
  if (result.status === 73) return false;
  return null;
}

export function withRuntimeJobGuard(jobId, guard, work) {
  const parent = guardContext.getStore() || {};
  return guardContext.run({ ...parent, jobId, guards: [...(parent.guards || []), guard] }, work);
}
export function runtimeGuardStreams() {
  return (guardContext.getStore()?.guards || []).map(guard => guard.child.stdin);
}
export function currentRuntimeInstallOwnerId() { return guardContext.getStore()?.installOwnerId; }

const clearStaleInstallLock = String.raw`
const fs = require('node:fs');
try {
  const owner = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
  if (owner.protocol !== 2 || owner.id !== process.argv[2]) process.exit(1);
  fs.unlinkSync(process.argv[1]);
} catch (error) { if (error.code !== 'ENOENT') process.exit(1); }
`;

export function assertRuntimeReady({ allowIndependentInstall = false } = {}) {
  const lock = path.join(RUNTIME_DIR, 'install.lock');
  if (!fs.existsSync(lock)) return;
  let owner;
  try { owner = JSON.parse(fs.readFileSync(lock, 'utf8')); } catch {}
  if (owner?.protocol === GUARD_PROTOCOL && typeof owner.id === 'string') {
    // A live guard is proof of a live owner even across PID/hostname changes.
    // The stale record is only removed while the guard itself is held.
    if (tryWithRuntimeGuard(INSTALL_GUARD, clearStaleInstallLock, [lock, owner.id]) === true) return;
  }
  // Legacy records have no reliable cross-process guard. An absent/reused PID
  // does not prove that a detached installer has also stopped, so unknown old
  // locks remain blocked for an administrator to inspect.
  if (allowIndependentInstall && owner?.blocksCompiles === false) return;
  throw new HttpError(503, '运行环境正在安装，请稍后重新编译。');
}

// The OS guard is authoritative for new owners. Legacy unknown/live owners
// remain blocked rather than being replaced based only on a hostname change.
export async function withRuntimeInstallLock(work, { blocksCompiles = true } = {}) {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  const lock = path.join(RUNTIME_DIR, 'install.lock');
  // Never recreate a missing guard while an owner marker exists: an unlinked
  // guard could still be held by a live installer through its old inode.
  if (fs.existsSync(lock) && !fs.existsSync(INSTALL_GUARD)) {
    throw new HttpError(409, '运行环境锁状态无法确认，请管理员检查后重试。');
  }
  const guard = await acquireRuntimeGuard(INSTALL_GUARD);
  const owner = { protocol: GUARD_PROTOCOL, id: randomUUID(), pid: process.pid, host: os.hostname(), blocksCompiles };
  let published = false;
  try {
    if (fs.existsSync(lock)) {
      let previous;
      try { previous = JSON.parse(fs.readFileSync(lock, 'utf8')); } catch {}
      const recoverable = previous?.protocol === GUARD_PROTOCOL && typeof previous.id === 'string';
      if (!recoverable) throw new HttpError(409, '存在无法确认状态的旧安装锁，请管理员检查后重试。');
      fs.unlinkSync(lock);
    }
    fs.writeFileSync(lock, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
    published = true;
    const { getDb } = await import('../db.js');
    const { assertWorkAdmission } = await import('./maintenance.js');
    const db = getDb();
    db.transaction(() => assertWorkAdmission(db)).immediate();
    const deadline = Date.now() + 150000;
    while (blocksCompiles && db.prepare('SELECT count(*) AS count FROM compile_leases').get().count) {
      if (Date.now() > deadline) throw new HttpError(409, '仍有编译任务执行，环境未修改，请稍后重试安装。');
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    const parent = guardContext.getStore() || {};
    return await guardContext.run({ ...parent, installOwnerId: owner.id, guards: [...(parent.guards || []), guard] }, work);
  } finally {
    // Keep the marker until all children inheriting the guard have exited.
    // After releasing, reacquire the guard and compare owner IDs before removal;
    // a new installer may have taken ownership in the meantime.
    await releaseRuntimeGuard(guard);
    if (published) tryWithRuntimeGuard(INSTALL_GUARD, clearStaleInstallLock, [lock, owner.id]);
  }
}
