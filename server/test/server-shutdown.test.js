import { fileURLToPath } from 'node:url';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as syncProtocol from 'y-protocols/sync';

const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'corelatex-shutdown-'));
process.env.CORELATEX_DATA_DIR = folder;
let db, resetDb, signToken, serial = 0;
before(async () => {
  const database = await import('../src/db.js'); db = database.getDb(); resetDb = database.resetDb;
  ({ signToken } = await import('../src/auth.js'));
});
after(() => { resetDb(); fs.rmSync(folder, { recursive: true, force: true }); });
const waitFor = async predicate => { const end = Date.now() + 5000; while (!predicate()) { if (Date.now() >= end) throw new Error('shutdown fixture timed out'); await new Promise(resolve => setTimeout(resolve, 5)); } };
async function fixture(t) {
  const uid = Number(db.prepare("INSERT INTO users(username,password_hash,role) VALUES(?,'unused','admin')").run('shutdown-' + ++serial).lastInsertRowid);
  const publicId = 'shutdown-' + serial, pid = Number(db.prepare('INSERT INTO projects(name,owner_id,public_id) VALUES(?,?,?)').run('shutdown', uid, publicId).lastInsertRowid);
  const dir = path.join(folder, 'projects', String(pid)); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'notes.txt'); fs.writeFileSync(file, 'original');
  const token = signToken(db.prepare('SELECT * FROM users WHERE id=?').get(uid));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/index.js', import.meta.url))], {
    env: { ...process.env, PORT: '0', HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', exited = null;
  child.stdout.on('data', part => stdout += part); child.stderr.on('data', part => stderr += part);
  child.once('exit', (code, signal) => exited = { code, signal });
  t.after(async () => { if (!exited) { child.kill('SIGKILL'); await new Promise(resolve => child.once('exit', resolve)); } });
  await waitFor(() => /listening at http:\/\/127.0.0.1:\d+/.test(stdout) || exited);
  assert.equal(exited, null, stderr);
  const port = Number(stdout.match(/listening at http:\/\/127.0.0.1:(\d+)/)[1]), base = 'http://127.0.0.1:' + port;
  assert.equal((await (await fetch(base + '/api/health')).json()).maintenanceProtocol, 1);
  return { child, base, file, token, publicId, errors: () => stderr, exited: () => exited,
    done: async () => { await waitFor(() => exited); assert.deepEqual(exited, { code: 0, signal: null }, stderr); } };
}
async function connect(t, f) {
  const doc = new Y.Doc(), ws = new WebSocket(f.base.replace('http:', 'ws:') + `/collab?project=${f.publicId}&file=notes.txt&token=${encodeURIComponent(f.token)}`);
  ws.on('error', () => {});
  ws.on('message', data => {
    const decoder = decoding.createDecoder(new Uint8Array(data)); if (decoding.readVarUint(decoder) !== 0) return;
    const encoder = encoding.createEncoder(); encoding.writeVarUint(encoder, 0); syncProtocol.readSyncMessage(decoder, encoder, doc, 'remote');
    if (encoding.length(encoder) > 1 && ws.readyState === WebSocket.OPEN) ws.send(encoding.toUint8Array(encoder));
  });
  doc.on('update', (update, origin) => {
    if (origin === 'remote' || ws.readyState !== WebSocket.OPEN) return;
    const encoder = encoding.createEncoder(); encoding.writeVarUint(encoder, 0); syncProtocol.writeUpdate(encoder, update); ws.send(encoding.toUint8Array(encoder));
  });
  await new Promise(resolve => ws.once('open', resolve));
  const encoder = encoding.createEncoder(); encoding.writeVarUint(encoder, 0); syncProtocol.writeSyncStep1(encoder, doc); ws.send(encoding.toUint8Array(encoder));
  await waitFor(() => doc.getText('content').toString() === 'original');
  t.after(() => { ws.terminate(); doc.destroy(); });
  return { doc, ws };
}

test('SIGTERM stops an idle real server promptly with a successful exit instead of waiting for forced kill', async t => {
  const f = await fixture(t), start = Date.now(); f.child.kill('SIGTERM'); await f.done();
  assert.ok(Date.now() - start < 3000);
});

test('SIGTERM strictly saves collaborative edits already broadcast before their debounce timer fires', async t => {
  const f = await fixture(t), first = await connect(t, f), observer = await connect(t, f);
  first.doc.getText('content').insert(8, ' accepted');
  await waitFor(() => observer.doc.getText('content').toString() === 'original accepted');
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'original');
  f.child.kill('SIGTERM'); await f.done();
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'original accepted');
});

test('failed shutdown flush keeps accepted edits in memory and refuses new HTTP work until persistence can succeed', async t => {
  const f = await fixture(t), first = await connect(t, f), observer = await connect(t, f);
  first.doc.getText('content').insert(8, ' recover');
  await waitFor(() => observer.doc.getText('content').toString() === 'original recover');
  fs.unlinkSync(f.file); f.child.kill('SIGTERM');
  await waitFor(() => f.errors().includes('尚未安全落盘'));
  assert.equal(f.exited(), null);
  assert.equal((await fetch(f.base + '/api/projects')).status, 503);
  assert.equal((await (await fetch(f.base + '/api/health')).json()).shuttingDown, true);
  fs.writeFileSync(f.file, 'original'); await f.done();
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'original recover');
});

test('SIGTERM waits for a background question and renderer cleanup lease with no HTTP observer, preserving answer access', async t => {
  const f = await fixture(t), project = db.prepare('SELECT * FROM projects WHERE public_id=?').get(f.publicId);
  const chatId = Number(db.prepare('INSERT INTO chats(project_id,user_id) VALUES(?,?)').run(project.id, project.owner_id).lastInsertRowid);
  const runId = 'background-' + project.id, leaseId = 'renderer-' + project.id;
  db.prepare("INSERT INTO agent_runs(id,project_id,chat_id,user_id,state) VALUES(?,?,?,?,'waiting_for_user')").run(runId, project.id, chatId, project.owner_id);
  db.prepare("INSERT INTO compile_leases(id,process_id,project_id,user_id,kind,state,created_at) VALUES(?,'fixture',?,?,'preview','running',?)").run(leaseId, project.id, project.owner_id, Date.now());
  f.child.kill('SIGTERM'); await waitFor(() => f.errors().includes('等待已启动任务结束'));
  assert.equal(f.exited(), null);
  assert.equal((await (await fetch(f.base + '/api/health')).json()).shuttingDown, false);
  assert.equal((await fetch(f.base + '/api/projects')).status, 401);
  assert.equal(db.prepare('SELECT state FROM agent_runs WHERE id=?').get(runId).state, 'waiting_for_user');
  db.prepare("UPDATE agent_runs SET state='completed' WHERE id=?").run(runId);
  await new Promise(resolve => setTimeout(resolve, 1100)); assert.equal(f.exited(), null);
  db.prepare('DELETE FROM compile_leases WHERE id=?').run(leaseId); await f.done();
});
