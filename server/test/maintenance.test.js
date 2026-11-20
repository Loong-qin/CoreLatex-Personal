import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'corelatex-maintenance-'));
const dataDir = path.join(temp, 'data'), databasePath = path.join(dataDir, 'corelatex.db');
const binDir = path.join(temp, 'bin'); fs.mkdirSync(binDir);
process.env.CORELATEX_DATA_DIR = dataDir;
process.env.PATH = [binDir, path.dirname(process.execPath), process.env.PATH].join(path.delimiter);
const root = fileURLToPath(new URL('../../', import.meta.url));
const cli = path.join(root, 'scripts/maintenance.js');
let db, database, maintenance, runs, compileProject, previewCompileProject, serial = 0;
const token = () => randomBytes(32).toString('hex');
before(async () => {
  database = await import('../src/db.js'); db = database.getDb();
  maintenance = await import('../src/services/maintenance.js');
  runs = await import('../src/services/agent/runs.js');
  ({ compileProject, previewCompileProject } = await import('../src/services/compile.js'));
  fs.writeFileSync(path.join(binDir, 'pdflatex'), `#!/usr/bin/env node
const fs=require('node:fs');
const outputDirectory=process.argv.find(arg=>arg.startsWith('-output-directory=')).slice('-output-directory='.length);
fs.mkdirSync(outputDirectory,{recursive:true});
fs.writeFileSync(outputDirectory+'/main.pdf','%PDF-fixture');
fs.writeFileSync(outputDirectory+'/main.log','Output written on main.pdf');
fs.writeFileSync('engine-started','');
if(fs.existsSync('hold-engine')){const timer=setInterval(()=>{if(fs.existsSync('release-engine')){clearInterval(timer);process.exit(0)}},5);setTimeout(()=>process.exit(10),5000).unref()}
`, { mode: 0o755 });
});
afterEach(() => { db.prepare('DELETE FROM maintenance_gate').run(); });
after(() => { database.resetDb(); fs.rmSync(temp, { recursive: true, force: true }); });

function fixture() {
  const uid = Number(db.prepare("INSERT INTO users(username,password_hash,role) VALUES(?,'unused','admin')").run('maintenance-' + ++serial).lastInsertRowid);
  const pid = Number(db.prepare('INSERT INTO projects(name,owner_id,public_id) VALUES(?,?,?)').run('maintenance', uid, 'maintenance-' + serial).lastInsertRowid);
  const chatId = Number(db.prepare('INSERT INTO chats(project_id,user_id) VALUES(?,?)').run(pid, uid).lastInsertRowid);
  const dir = path.join(dataDir, 'projects', String(pid)); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'main.tex'), 'fixture');
  return { project: db.prepare('SELECT * FROM projects WHERE id=?').get(pid), user: db.prepare('SELECT * FROM users WHERE id=?').get(uid), chatId, dir };
}
const runArgs = f => ({ projectId: f.project.id, chatId: f.chatId, userId: f.user.id });
async function until(predicate, message = 'state', timeout = 3000) {
  const end = Date.now() + timeout;
  while (!predicate()) { if (Date.now() > end) throw new Error('Timed out: ' + message); await new Promise(resolve => setTimeout(resolve, 5)); }
}
function childProcess(args) {
  const child = spawn(process.execPath, args, { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', bytes => stdout += bytes); child.stderr.on('data', bytes => stderr += bytes);
  const finished = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr })); });
  return { child, finished, output: () => stdout };
}
const cliCall = args => childProcess([cli, ...args, '--database', databasePath]).finished;

test('maintenance refuses active runs without cancelling them, then atomically denies new work after cancellation', async () => {
  const f = fixture(), ownerToken = token(), run = runs.createRun(runArgs(f));
  const work = runs.startRun(run, async () => {
    await new Promise(resolve => run.controller.signal.addEventListener('abort', resolve, { once: true }));
    return { status: 'cancelled' };
  });
  assert.throws(() => maintenance.acquireMaintenance(db, { ownerToken }), error => error.status === 409 && error.work.runs[0].id === run.id);
  assert.equal(run.controller.signal.aborted, false); assert.equal(runs.runSnapshot(run.id).state, 'running');
  assert.equal(maintenance.maintenanceStatus(db).active, false);
  await runs.cancelRun(run.id); await work;
  maintenance.acquireMaintenance(db, { ownerToken });
  const count = db.prepare('SELECT count(*) n FROM agent_runs').get().n;
  assert.throws(() => runs.createRun(runArgs(f)), error => error.status === 503);
  assert.throws(() => compileProject(f), error => error.status === 503);
  assert.throws(() => previewCompileProject(f), error => error.status === 503);
  assert.equal(db.prepare('SELECT count(*) n FROM agent_runs').get().n, count);
  assert.deepEqual(maintenance.maintenanceStatus(db).compiles, []);
  assert.equal(fs.existsSync(path.join(f.dir, '.preview')), false);
  assert.equal(db.prepare('SELECT compile_seconds_used FROM users WHERE id=?').get(f.user.id).compile_seconds_used, 0);
});

test('only the owner renews or releases; expiry allows a new owner without an old release unlocking it', () => {
  const a = token(), b = token();
  maintenance.acquireMaintenance(db, { ownerToken: a, ttlMs: 5000 });
  assert.throws(() => maintenance.acquireMaintenance(db, { ownerToken: b }), error => error.status === 409);
  assert.throws(() => maintenance.releaseMaintenance(db, { ownerToken: b }), error => error.status === 409);
  assert.throws(() => maintenance.renewMaintenance(db, { ownerToken: b }), error => error.status === 409);
  assert.equal(maintenance.renewMaintenance(db, { ownerToken: a }).active, true);
  db.prepare('UPDATE maintenance_gate SET expires_at=?').run(Date.now() - 1);
  assert.equal(maintenance.maintenanceStatus(db).active, false);
  assert.throws(() => maintenance.renewMaintenance(db, { ownerToken: a }), error => error.status === 409);
  maintenance.withWorkAdmission(db, () => {});
  maintenance.acquireMaintenance(db, { ownerToken: b });
  assert.throws(() => maintenance.releaseMaintenance(db, { ownerToken: a }), error => error.status === 409);
  assert.equal(maintenance.maintenanceStatus(db).active, true);
  maintenance.releaseMaintenance(db, { ownerToken: b });
  assert.equal(maintenance.maintenanceStatus(db).active, false);
});

test('outer admission rollback removes run and initial journal and discards scheduler registration callbacks', () => {
  const f = fixture(); let run, committed = false;
  assert.throws(() => maintenance.withWorkAdmission(db, () => {
    run = runs.createRun(runArgs(f));
    maintenance.afterWorkAdmissionCommit(db, () => { committed = true; });
    throw new Error('transaction rollback fixture');
  }), /rollback fixture/);
  assert.equal(committed, false); assert.equal(runs.getRun(run.id), undefined);
  assert.equal(db.prepare('SELECT count(*) n FROM agent_run_events WHERE run_id=?').get(run.id).n, 0);
  assert.throws(() => maintenance.withWorkAdmission(db, () => Promise.resolve()), /must be synchronous/);
  maintenance.acquireMaintenance(db, { ownerToken: token() });
});

test('queued cancellation and executing cleanup keep leases until underlying work is actually finished', async () => {
  const f = fixture(), firstAbort = new AbortController(), queuedAbort = new AbortController();
  let releaseCleanup, inCleanup = false;
  const cleanup = new Promise(resolve => { releaseCleanup = resolve; });
  const first = compileProject({ ...f, signal: firstAbort.signal, afterCompile: async () => { inCleanup = true; await cleanup; } });
  await until(() => inCleanup, 'compile cleanup');
  const queued = previewCompileProject({ ...f, signal: queuedAbort.signal });
  const queuedRejected = assert.rejects(queued, error => error.name === 'AbortError');
  queuedAbort.abort(); await queuedRejected;
  assert.deepEqual(maintenance.maintenanceStatus(db).compiles.map(item => item.state).sort(), ['queued', 'running']);
  const firstRejected = assert.rejects(first, error => error.name === 'AbortError'); firstAbort.abort(); await firstRejected;
  assert.throws(() => maintenance.acquireMaintenance(db, { ownerToken: token() }), error => error.status === 409 && error.work.compiles.length === 2);
  releaseCleanup(); await until(() => maintenance.maintenanceStatus(db).compiles.length === 0, 'real cleanup releases leases');
  assert.equal(fs.existsSync(path.join(f.dir, '.preview')), false, 'cancelled queued preview never starts');
  maintenance.acquireMaintenance(db, { ownerToken: token() });
});

test('cancelled TeX process remains protected until its process cleanup settles and failed compiles release their lease', async () => {
  const f = fixture(), controller = new AbortController(); fs.writeFileSync(path.join(f.dir, 'hold-engine'), '');
  const promise = compileProject({ ...f, signal: controller.signal });
  await until(() => fs.existsSync(path.join(f.dir, 'engine-started')), 'engine starts');
  assert.throws(() => maintenance.acquireMaintenance(db, { ownerToken: token() }), error => error.status === 409);
  const rejected = assert.rejects(promise, error => error.name === 'AbortError'); controller.abort(); await rejected;
  await until(() => maintenance.maintenanceStatus(db).compiles.length === 0, 'engine stopped');
  await assert.rejects(compileProject({ ...f, engine: 'invalid' }), /不支持/);
  assert.deepEqual(maintenance.maintenanceStatus(db).compiles, []);
});

test('real application startup clears old process leases but preserves a deployed maintenance gate and owner', () => {
  const f = fixture(), ownerToken = token(); maintenance.acquireMaintenance(db, { ownerToken });
  db.prepare("INSERT INTO compile_leases VALUES('old-process','dead-process',?,?, 'compile','running',?)").run(f.project.id, f.user.id, Date.now());
  maintenance.initializeMaintenanceProcess(db);
  assert.deepEqual(maintenance.maintenanceStatus(db).compiles, []);
  assert.equal(maintenance.maintenanceStatus(db).active, true);
  assert.equal(maintenance.renewMaintenance(db, { ownerToken }).active, true);
});

test('CLI status does not run application restart migration or interrupt a live task', async () => {
  const f = fixture(), run = runs.createRun(runArgs(f));
  const work = runs.startRun(run, async () => { await new Promise(resolve => run.controller.signal.addEventListener('abort', resolve, { once: true })); });
  const before = db.prepare('SELECT last_seq FROM agent_runs WHERE id=?').get(run.id).last_seq;
  const result = await cliCall(['status']); assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).runs[0].id, run.id);
  assert.equal(runs.runSnapshot(run.id).state, 'running');
  assert.equal(db.prepare('SELECT last_seq FROM agent_runs WHERE id=?').get(run.id).last_seq, before);
  await runs.cancelRun(run.id); await work;
});

test('CLI command failure unlocks only its own gate and never prints the credential', async () => {
  const ownerFile = path.join(temp, 'failed-command.owner');
  const result = await childProcess([cli, 'with', '--database', databasePath, '--owner-file', ownerFile, '--', process.execPath, '-e', 'process.exit(7)']).finished;
  assert.equal(result.code, 7, result.stderr); assert.equal(maintenance.maintenanceStatus(db).active, false);
  const secret = fs.readFileSync(ownerFile, 'utf8').trim();
  assert.ok(/^[a-f0-9]{64}$/.test(secret)); assert.equal(fs.statSync(ownerFile).mode & 0o777, 0o600);
  assert.equal((result.stdout + result.stderr).includes(secret), false);
  const acquired = await cliCall(['acquire', '--owner-file', ownerFile]); assert.equal(acquired.code, 0, acquired.stderr);
  const stranger = path.join(temp, 'stranger.owner'); fs.writeFileSync(stranger, token(), { mode: 0o600 });
  assert.equal((await cliCall(['release', '--owner-file', stranger])).code, 1);
  assert.equal(maintenance.maintenanceStatus(db).active, true);
  assert.equal((await cliCall(['release', '--owner-file', ownerFile])).code, 0);
});

test('separate maintenance and compile admission processes cannot both win the same idle writer-lock race', async () => {
  const f = fixture();
  const serviceUrl = new URL('../src/services/maintenance.js', import.meta.url).href;
  const packageUrl = new URL('../package.json', import.meta.url).href;
  async function actor(action, ownerToken) {
    const source = `import {createRequire} from 'node:module';import * as m from ${JSON.stringify(serviceUrl)};
const D=createRequire(${JSON.stringify(packageUrl)})('better-sqlite3');const db=new D(${JSON.stringify(databasePath)},{timeout:5000});
console.log('READY');process.stdin.once('data',()=>{try{const value=${action === 'gate' ? `m.acquireMaintenance(db,{ownerToken:${JSON.stringify(ownerToken)}})` : `m.createCompileLease(db,{projectId:${f.project.id},userId:${f.user.id},kind:'compile'})`};console.log(JSON.stringify({ok:true,value}));}catch(e){console.log(JSON.stringify({ok:false,status:e.status,error:e.message}));}finally{db.close();process.stdin.destroy();}});`;
    const actor = childProcess(['--input-type=module', '-e', source]);
    await until(() => actor.output().includes('READY'), 'actor ready'); return actor;
  }
  for (let i = 0; i < 6; i++) {
    const [gate, compile] = await Promise.all([actor('gate', token()), actor('compile')]);
    gate.child.stdin.end('go'); compile.child.stdin.end('go');
    const results = await Promise.all([gate.finished, compile.finished]);
    const outputs = results.map(result => { assert.equal(result.code, 0, result.stderr); return JSON.parse(result.stdout.trim().split('\n').at(-1)); });
    assert.equal(outputs.filter(output => output.ok).length, 1, JSON.stringify(outputs));
    const state = maintenance.maintenanceStatus(db);
    assert.equal(state.active && state.compiles.length > 0, false);
    db.prepare('DELETE FROM maintenance_gate').run(); db.prepare('DELETE FROM compile_leases').run();
  }
});
