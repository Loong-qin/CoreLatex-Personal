import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { startTestServer, api, registerAndLogin } from './helpers.js';

let srv, llm, owner, db, maintenance, runs, fixtureRoot, otherDb;
let llmCalls = 0;
const previousPath = process.env.PATH;
const ownerToken = randomBytes(32).toString('hex');
const sse = value => `data: ${JSON.stringify(value)}\n\n`;
const count = table => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
const stateCounts = () => ({ chats: count('chats'), messages: count('chat_messages'), runs: count('agent_runs'), events: count('agent_run_events') });
const waitFor = async fn => {
  const end = Date.now() + 5000;
  while (!fn()) { if (Date.now() > end) throw new Error('fixture condition timed out'); await new Promise(resolve => setTimeout(resolve, 5)); }
};
const releaseGate = () => { if (maintenance.maintenanceStatus(db).active) maintenance.releaseMaintenance(db, { ownerToken }); };
const post = (project, suffix, body) => api(srv.baseUrl, 'POST', `/api/projects/${project.publicId}${suffix}`, { token: owner.token, body, raw: true });
async function fixture() {
  const reply = await api(srv.baseUrl, 'POST', '/api/projects', { token: owner.token, body: { name: 'admission-' + randomUUID() } });
  assert.equal(reply.status, 201);
  const project = reply.data.project;
  const row = db.prepare('SELECT * FROM projects WHERE public_id=?').get(project.publicId);
  db.prepare("UPDATE projects SET compile_engine='pdflatex', tex_version='system' WHERE id=?").run(row.id);
  const dir = path.join(srv.dataDir, 'projects', String(row.id));
  fs.writeFileSync(path.join(dir, 'selection.tex'), 'Selection fixture paragraph');
  return { ...project, id: row.id, dir };
}
function uploadFiles(project) {
  const dir = path.join(project.dir, '_workspace', 'uploads');
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
}

before(async () => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'corelatex-admission-http-'));
  const bin = path.join(fixtureRoot, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'pdflatex'), '#!/usr/bin/env node\n' + String.raw`
const fs = require('node:fs'); const path = require('node:path');
const base = path.basename(process.argv.at(-1)).replace(/\.tex$/i, '');
const outputDirectory = process.argv.find(arg => arg.startsWith('-output-directory=')).slice('-output-directory='.length);
fs.mkdirSync(outputDirectory, {recursive:true});
fs.writeFileSync(path.join(outputDirectory, base + '.pdf'), '%PDF-1.4\nfixture');
fs.writeFileSync(path.join(outputDirectory, base + '.log'), 'Output written on ' + base + '.pdf');
`, { mode: 0o755 });
  process.env.PATH = [bin, path.dirname(process.execPath), previousPath].join(path.delimiter);
  llm = http.createServer((req, res) => {
    req.resume(); req.on('end', () => {
      llmCalls++; res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(sse({ choices: [{ index: 0, delta: { content: 'Fixture response.' } }] })
        + sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n');
    });
  });
  await new Promise(resolve => llm.listen(0, '127.0.0.1', resolve));
  srv = await startTestServer();
  ({ getDb: db } = await import('../src/db.js')); db = db();
  maintenance = await import('../src/services/maintenance.js');
  runs = await import('../src/services/agent/runs.js');
  otherDb = new Database(db.name, { timeout: 0 });
  owner = await registerAndLogin(srv.baseUrl, 'admission-owner');
  const settings = await api(srv.baseUrl, 'PUT', '/api/settings/ai', { token: owner.token, body: {
    provider: 'openai', baseUrl: `http://127.0.0.1:${llm.address().port}/v1`, apiKey: 'fixture-only', model: 'fixture-model',
  } });
  assert.equal(settings.status, 200);
});

after(async () => {
  if (maintenance && db) releaseGate();
  for (const row of db?.prepare("SELECT id FROM agent_runs WHERE state IN ('running','waiting_for_user','cancelling')").all() || []) await runs.cancelRun(row.id);
  otherDb?.close();
  if (llm) { llm.closeAllConnections(); await new Promise(resolve => llm.close(resolve)); }
  if (srv) { srv.server.closeAllConnections(); await srv.close(); }
  process.env.PATH = previousPath;
  if (fixtureRoot) fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

test('maintenance rejects chat attachments and selection actions before creating any preparation artifacts', async () => {
  const project = await fixture(); const before = stateCounts(); const calls = llmCalls;
  maintenance.acquireMaintenance(db, { ownerToken });
  try {
    const response = await post(project, '/agent/chat', { requestId: randomUUID(), message: 'hold', files: [{ name: 'draft.txt', data: Buffer.from('draft').toString('base64') }] });
    assert.equal(response.status, 503); assert.match((await response.json()).error, /尚未启动|稍后重试/);
    const selection = await post(project, '/agent/selection-action', { requestId: randomUUID(), action: 'explain', file: 'selection.tex', start: 0, end: 9, selectionText: 'Selection' });
    assert.equal(selection.status, 503); await selection.text();
    assert.deepEqual(stateCounts(), before); assert.deepEqual(uploadFiles(project), []); assert.equal(llmCalls, calls);
    assert.equal(fs.existsSync(path.join(project.dir, '_workspace')), false);
  } finally { releaseGate(); }
});

test('attachment preparation and run creation hold the same admission lock against a second database connection', async t => {
  const project = await fixture(); const original = fs.writeFileSync; let observed = false;
  t.mock.method(fs, 'writeFileSync', function(file, ...args) {
    if (String(file).includes('_workspace/uploads/')) {
      observed = true; assert.equal(db.inTransaction, true);
      assert.throws(() => maintenance.acquireMaintenance(otherDb, { ownerToken }), error => error.code === 'SQLITE_BUSY');
    }
    return original.call(this, file, ...args);
  });
  const response = await post(project, '/agent/chat', { requestId: randomUUID(), message: 'hello', files: [{ name: 'context.txt', data: Buffer.from('context').toString('base64') }] });
  assert.equal(response.status, 200); const body = await response.text(); assert.match(body, /"state":"completed"/);
  assert.equal(observed, true); assert.equal(uploadFiles(project).length, 1);
  assert.equal(maintenance.maintenanceStatus(db).active, false);
});

test('a run insertion failure rolls back the user message, chat and this request attachments', async () => {
  const project = await fixture(); const before = stateCounts(); const calls = llmCalls;
  const dir = path.join(project.dir, '_workspace', 'uploads'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'existing.txt'), 'keep existing uploads');
  db.exec("CREATE TEMP TRIGGER fail_admission_run BEFORE INSERT ON agent_runs BEGIN SELECT RAISE(FAIL, 'fixture run insertion failure'); END");
  try {
    const response = await post(project, '/agent/chat', { requestId: randomUUID(), message: 'must roll back', files: [{ name: 'rollback.txt', data: Buffer.from('temporary').toString('base64') }] });
    assert.equal(response.status, 409); await response.text();
    assert.deepEqual(stateCounts(), before); assert.deepEqual(uploadFiles(project), ['existing.txt']); assert.equal(llmCalls, calls);
  } finally { db.exec('DROP TRIGGER fail_admission_run'); }
});

test('maintenance permits an idempotent replay without another message, attachment or model call', async () => {
  const project = await fixture(); const requestId = randomUUID();
  const first = await post(project, '/agent/chat', { requestId, message: 'hello' }); assert.equal(first.status, 200);
  const original = await first.text(); const before = stateCounts(); const calls = llmCalls;
  maintenance.acquireMaintenance(db, { ownerToken });
  try {
    const repeated = await post(project, '/agent/chat', { requestId, message: 'hello', files: [{ name: 'invalid.txt', data: '' }] });
    assert.equal(repeated.status, 200); assert.equal(await repeated.text(), original);
    assert.deepEqual(stateCounts(), before); assert.deepEqual(uploadFiles(project), []); assert.equal(llmCalls, calls);
  } finally { releaseGate(); }
});

test('the compile lease lasts through the automatic snapshot close, after the engine job is successful', async t => {
  const project = await fixture(); const original = fs.createWriteStream;
  let releaseClose, held = false;
  t.mock.method(fs, 'createWriteStream', function(file, ...args) {
    const output = original.call(this, file, ...args);
    if (String(file).includes('/.versions/')) {
      const emit = output.emit.bind(output);
      output.emit = function(event, ...values) {
        if (event === 'close') { held = true; releaseClose = () => emit(event, ...values); return true; }
        return emit(event, ...values);
      };
    }
    return output;
  });
  const operation = post(project, '/compile', {});
  try {
    await waitFor(() => held);
    const job = db.prepare('SELECT status FROM compile_jobs WHERE project_id=? ORDER BY id DESC LIMIT 1').get(project.id);
    assert.equal(job.status, 'success');
    assert.equal(maintenance.maintenanceStatus(otherDb).compiles.length, 1);
    assert.throws(() => maintenance.acquireMaintenance(otherDb, { ownerToken }), error => error.status === 409 && error.work.compiles.length === 1);
  } finally { releaseClose?.(); }
  const response = await operation; assert.equal(response.status, 200); assert.equal((await response.json()).status, 'success');
  assert.equal(maintenance.maintenanceStatus(otherDb).compiles.length, 0);
  assert.equal(maintenance.acquireMaintenance(otherDb, { ownerToken }).active, true); releaseGate();
});

test('maintenance rejects compile before engine jobs, snapshots or leases are created', async () => {
  const project = await fixture(); const jobs = count('compile_jobs'), versions = count('versions');
  maintenance.acquireMaintenance(db, { ownerToken });
  try {
    const response = await post(project, '/compile', {}); assert.equal(response.status, 503); await response.text();
    assert.equal(count('compile_jobs'), jobs); assert.equal(count('versions'), versions);
    assert.equal(maintenance.maintenanceStatus(db).compiles.length, 0);
  } finally { releaseGate(); }
});


test('invalid context preparation rolls back before a run exists, including files already staged by the request', async () => {
  const project = await fixture(); const before = stateCounts(); const calls = llmCalls;
  const response = await post(project, '/agent/chat', { requestId: randomUUID(), message: 'invalid context', currentFile: { toString: null }, files: [{ name: 'rollback-context.txt', data: Buffer.from('temporary context').toString('base64') }] });
  assert.equal(response.status, 400); assert.match((await response.json()).error, /currentFile/);
  assert.deepEqual(stateCounts(), before); assert.deepEqual(uploadFiles(project), []); assert.equal(llmCalls, calls);
  assert.equal(maintenance.maintenanceStatus(db).runs.length, 0);
});
