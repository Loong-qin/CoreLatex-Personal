import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { once } from 'node:events';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'corelatex-recovery-test-'));
process.env.CORELATEX_DATA_DIR = root;
let env, resources, tex, resetDb;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const guardPath = () => path.join(root, 'runtime', 'install.guard');
const lockPath = () => path.join(root, 'runtime', 'install.lock');
const jobsPath = () => path.join(root, 'runtime', 'jobs');
async function until(predicate, timeout = 15000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await sleep(25);
  }
  assert.fail('timed out waiting for recovery');
}

before(async () => {
  env = await import('../src/services/runtimeEnvironment.js');
  resources = await import('../src/services/runtimeResources.js');
  tex = await import('../src/services/texRuntimes.js');
  const db = await import('../src/db.js'); db.getDb(); resetDb = db.resetDb;
});
after(() => {
  resetDb?.();
  assert.ok(root.startsWith(path.join(os.tmpdir(), 'corelatex-recovery-test-')));
  fs.rmSync(root, { recursive: true, force: true });
});

test('new guard distinguishes a live owner from a stale record with reused PID or changed hostname', async () => {
  const live = await env.acquireRuntimeGuard(guardPath());
  const owner = { protocol: 2, id: randomUUID(), pid: process.pid, host: 'previous-container', blocksCompiles: true };
  fs.writeFileSync(lockPath(), JSON.stringify(owner));
  try {
    assert.throws(() => env.assertRuntimeReady(), /安装/);
    await assert.rejects(env.withRuntimeInstallLock(async () => {}), /安装/);
    assert.equal(fs.existsSync(lockPath()), true);
  } finally { await env.releaseRuntimeGuard(live); }
  assert.doesNotThrow(() => env.assertRuntimeReady());
  assert.equal(fs.existsSync(lockPath()), false, 'only a free guard permits stale marker cleanup');
  fs.writeFileSync(lockPath(), JSON.stringify({ ...owner, host: os.hostname(), pid: process.pid, id: randomUUID() }));
  assert.doesNotThrow(() => env.assertRuntimeReady(), 'same PID reused by the new service is still recoverable');
  assert.equal(fs.existsSync(lockPath()), false);
});

test('unknown legacy locks are retained even when the recorded process is absent', async () => {
  const owner = { id: randomUUID(), host: os.hostname(), pid: 99999999, blocksCompiles: true };
  fs.writeFileSync(lockPath(), JSON.stringify(owner));
  try {
    assert.throws(() => env.assertRuntimeReady(), /安装/);
    await assert.rejects(env.withRuntimeInstallLock(async () => {}), /旧安装锁/);
    assert.deepEqual(JSON.parse(fs.readFileSync(lockPath(), 'utf8')), owner);
  } finally { fs.unlinkSync(lockPath()); }
});

test('a missing install guard with an owner marker fails closed without creating a replacement inode', async () => {
  const backup = guardPath() + '.fixture';
  fs.renameSync(guardPath(), backup);
  fs.writeFileSync(lockPath(), JSON.stringify({ protocol: 2, id: randomUUID(), blocksCompiles: true }));
  try {
    assert.throws(() => env.assertRuntimeReady(), /安装/);
    await assert.rejects(env.withRuntimeInstallLock(async () => {}), /无法确认/);
    assert.equal(fs.existsSync(guardPath()), false);
  } finally { fs.unlinkSync(lockPath()); fs.renameSync(backup, guardPath()); }
});

test('guard marker remains until inherited installer processes exit', async () => {
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const work = env.withRuntimeInstallLock(async () => {
    const child = spawn('sh', ['-c', 'sleep 0.7'], { stdio: ['ignore', 'ignore', 'ignore', ...env.runtimeGuardStreams()] });
    child.on('error', () => {});
    started();
  });
  await ready;
  await sleep(80);
  assert.equal(fs.existsSync(lockPath()), true, 'marker must remain while inherited guard is live');
  assert.throws(() => env.assertRuntimeReady(), /安装/);
  await assert.rejects(env.withRuntimeInstallLock(async () => {}), /安装/);
  await work;
  assert.doesNotThrow(() => env.assertRuntimeReady());
  assert.equal(fs.existsSync(lockPath()), false);
});

test('a killed server retains its install and job guards until an orphaned installer exits', async () => {
  const ready = path.join(root, 'child-ready'), jobFile = path.join(root, 'child-job');
  const resourcesUrl = pathToFileURL(fileURLToPath(new URL('../src/services/runtimeResources.js', import.meta.url))).href;
  const envUrl = pathToFileURL(fileURLToPath(new URL('../src/services/runtimeEnvironment.js', import.meta.url))).href;
  const processUrl = pathToFileURL(fileURLToPath(new URL('../src/services/process.js', import.meta.url))).href;
  const script = `
    import fs from 'node:fs';
    const { startRuntimeJob } = await import(${JSON.stringify(resourcesUrl)});
    const { withRuntimeInstallLock } = await import(${JSON.stringify(envUrl)});
    const { runProcess } = await import(${JSON.stringify(processUrl)});
    const job = await startRuntimeJob('interruption-test', {}, async () => withRuntimeInstallLock(async () => {
      await runProcess('sh', ['-c', 'echo ready > "$1"; sleep 4', '-', ${JSON.stringify(ready)}], { timeoutMs: 9000 });
      return { changed: true };
    }));
    fs.writeFileSync(${JSON.stringify(jobFile)}, job.id);
    await new Promise(() => {});
  `;
  const worker = spawn(process.execPath, ['--input-type=module', '-e', script], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; worker.stderr.on('data', chunk => { stderr += chunk; });
  try {
    await until(() => fs.existsSync(ready) && fs.existsSync(jobFile) || worker.exitCode !== null);
    assert.equal(worker.exitCode, null, stderr);
    const id = fs.readFileSync(jobFile, 'utf8');
    const exited = once(worker, 'exit'); worker.kill('SIGKILL'); await exited;
    const lock = JSON.parse(fs.readFileSync(lockPath(), 'utf8'));
    fs.writeFileSync(lockPath(), JSON.stringify({ ...lock, host: 'replaced-container', pid: process.pid }));
    const file = path.join(jobsPath(), id + '.json');
    const job = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...job, host: 'replaced-container', pid: process.pid }));
    assert.throws(() => env.assertRuntimeReady(), /安装/, 'orphan still holds the install guard');
    assert.equal(resources.listRuntimeJobs().find(item => item.id === id).status, 'running', 'orphan still holds the job guard');
    await assert.rejects(env.withRuntimeInstallLock(async () => {}), /安装/);
    await until(() => { try { env.assertRuntimeReady(); return true; } catch { return false; } });
    assert.equal(resources.listRuntimeJobs().find(item => item.id === id).status, 'failed');
    assert.equal(fs.existsSync(lockPath()), false);
  } finally {
    if (worker.exitCode === null && worker.signalCode === null) worker.kill('SIGKILL');
  }
});

test('job recovery keeps active and unknown guards and marks only stopped jobs failed', async () => {
  fs.mkdirSync(jobsPath(), { recursive: true });
  const id = randomUUID(), filename = path.join(jobsPath(), id + '.json');
  const guard = await env.acquireRuntimeGuard(path.join(jobsPath(), id + '.guard'));
  const job = { id, type: 'fonts', status: 'running', startedAt: new Date().toISOString(), host: 'other', pid: process.pid, guardProtocol: 2 };
  fs.writeFileSync(filename, JSON.stringify(job));
  assert.equal(resources.listRuntimeJobs().find(item => item.id === id).status, 'running');
  await env.releaseRuntimeGuard(guard);
  assert.equal(resources.listRuntimeJobs().find(item => item.id === id).status, 'failed');
  const unknown = { ...job, id: randomUUID() };
  fs.writeFileSync(path.join(jobsPath(), unknown.id + '.json'), JSON.stringify(unknown));
  assert.equal(resources.listRuntimeJobs().find(item => item.id === unknown.id).status, 'unknown', 'missing guard is uncertain and must not be reported as stopped');
  const legacy = { ...job, id: randomUUID(), host: os.hostname(), pid: 99999999 };
  delete legacy.guardProtocol;
  fs.writeFileSync(path.join(jobsPath(), legacy.id + '.json'), JSON.stringify(legacy));
  const legacyResult = resources.listRuntimeJobs().find(item => item.id === legacy.id);
  assert.equal(legacyResult.status, 'unknown');
  assert.match(legacyResult.message, /无法自动确认/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(jobsPath(), legacy.id + '.json'), 'utf8')).status, 'running', 'unknown is a view, not a persisted failure');
});

test('only recognized incomplete TeX trees are quarantined; other directories stay untouched', async () => {
  const target = path.join(tex.TEX_RUNTIME_ROOT, '2025');
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, '.corelatex-installing'), JSON.stringify({ protocol: 2, version: '2025', ownerId: randomUUID() }));
  fs.writeFileSync(path.join(target, 'preserve-me'), 'downloaded data');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('offline', { status: 503 });
  try {
    await assert.rejects(tex.installTexVersion('2025'), /下载失败/);
    const archives = fs.readdirSync(tex.TEX_RUNTIME_ROOT).filter(name => name.startsWith('.interrupted-2025-'));
    assert.equal(archives.length, 1);
    assert.equal(fs.readFileSync(path.join(tex.TEX_RUNTIME_ROOT, archives[0], 'preserve-me'), 'utf8'), 'downloaded data');
    assert.equal(fs.existsSync(target), false);
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'unmanaged'), 'untouched');
    await assert.rejects(tex.installTexVersion('2025'), /目录已存在/);
    assert.equal(fs.readFileSync(path.join(target, 'unmanaged'), 'utf8'), 'untouched');
    assert.equal(fs.readdirSync(tex.TEX_RUNTIME_ROOT).filter(name => name.startsWith('.interrupted-2025-')).length, 1);
  } finally { globalThis.fetch = originalFetch; }
});
