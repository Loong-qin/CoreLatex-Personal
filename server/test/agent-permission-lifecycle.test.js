import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { startTestServer, registerAndLogin, api } from './helpers.js';

let srv, dbModule, db, owner, editor, llm, mode, held, requests;
const sse = value => 'data: ' + JSON.stringify({ choices: [{ index: 0, ...value }] }) + '\n\n';
const tool = (res, name, args) => res.end(sse({ delta: { tool_calls: [{ index: 0, id: 'call_' + requests, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }) + sse({ delta: {}, finish_reason: 'tool_calls' }) + 'data: [DONE]\n\n');
const finish = res => res.end(sse({ delta: { content: '已修改 notes.txt。' } }) + sse({ delta: {}, finish_reason: 'stop' }) + 'data: [DONE]\n\n');
const waitUntil = async predicate => {
  const until = Date.now() + 3000;
  while (!predicate()) { if (Date.now() > until) throw new Error('Timed out waiting for mock request'); await new Promise(resolve => setTimeout(resolve, 5)); }
};
before(async () => {
  srv = await startTestServer(); dbModule = await import('../src/db.js'); db = dbModule.getDb();
  owner = await registerAndLogin(srv.baseUrl, 'permission-owner');
  editor = await registerAndLogin(srv.baseUrl, 'permission-editor');
  llm = http.createServer((req, res) => {
    let raw = ''; req.on('data', c => raw += c); req.on('end', () => {
      requests++; res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const calls = JSON.parse(raw).messages.filter(m => m.role === 'assistant').flatMap(m => m.tool_calls || []);
      if (!calls.some(c => c.function.name === 'read_file')) return tool(res, 'read_file', { path: 'notes.txt' });
      if (!calls.some(c => c.function.name === 'edit_file')) {
        if (mode === 'hold-before-edit') { held = res; return; }
        return tool(res, 'edit_file', { path: 'notes.txt', search: 'Original text.', replace: 'Actual edit.' });
      }
      if (mode === 'hold-after-edit') { held = res; return; }
      finish(res);
    });
  });
  await new Promise(resolve => llm.listen(0, '127.0.0.1', resolve));
  for (const auth of [owner, editor]) {
    await api(srv.baseUrl, 'PUT', '/api/settings/ai', { token: auth.token, body: { provider: 'openai', model: 'permission-mock', apiKey: 'synthetic', baseUrl: 'http://127.0.0.1:' + llm.address().port + '/v1' } });
  }
});
after(async () => {
  llm.closeAllConnections(); await new Promise(resolve => llm.close(resolve));
  srv.server.closeAllConnections(); dbModule.resetDb(); await srv.close();
});
async function fixture(auth = owner, scenario = 'hold-before-edit') {
  mode = scenario; held = null; requests = 0;
  const { data } = await api(srv.baseUrl, 'POST', '/api/projects', { token: owner.token, body: { name: 'Permission run fixture' } });
  const project = data.project, endpoint = suffix => '/api/projects/' + project.publicId + suffix;
  const file = path.join(srv.dataDir, 'projects', String(project.id), 'notes.txt'); fs.writeFileSync(file, 'Original text.\n');
  const call = (method, suffix, body, token = owner.token) => api(srv.baseUrl, method, endpoint(suffix), { token, body });
  if (auth === editor) await call('POST', '/members', { username: 'permission-editor', role: 'editor' });
  const response = await api(srv.baseUrl, 'POST', endpoint('/agent/chat'), { token: auth.token, body: { message: '请修改文稿。' }, raw: true });
  const body = response.text();
  if (scenario !== 'normal') await waitUntil(() => held);
  return { project, file, call, events: async () => (await body).split('\n').filter(v => v.startsWith('data: ')).map(v => JSON.parse(v.slice(6))) };
}

for (const action of ['archive', 'delete']) test(action + ' waits for the affected run to stop before returning', { timeout: 5000 }, async () => {
  const f = await fixture();
  assert.equal((await f.call('POST', '/' + action, {})).status, 200);
  const events = await f.events();
  assert.equal(events.at(-1).state, 'cancelled'); assert.equal(fs.readFileSync(f.file, 'utf8'), 'Original text.\n');
  assert.equal((await f.call('GET', '/agent/runs/active')).data.run, null);
  assert.equal(requests, 2); assert.ok(events.some(e => e.type === 'token' && e.text.includes('权限已变化')));
});

for (const action of ['downgrade', 'remove']) test(action + ' stops the former editor run and prevents writes', { timeout: 5000 }, async () => {
  const f = await fixture(editor);
  const change = action === 'downgrade' ? await f.call('POST', '/members', { username: 'permission-editor', role: 'viewer' }) : await f.call('DELETE', '/members/' + editor.user.id);
  assert.equal(change.status, 200); assert.equal((await f.events()).at(-1).state, 'cancelled');
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'Original text.\n'); assert.equal(requests, 2);
});

test('archive preserves a completed edit as an unapplied proposal', { timeout: 5000 }, async () => {
  const f = await fixture(owner, 'hold-after-edit');
  assert.equal((await f.call('POST', '/archive', {})).status, 200);
  const events = await f.events(), changeset = events.find(e => e.type === 'changeset').changeset;
  assert.equal(events.at(-1).state, 'cancelled'); assert.equal(changeset.applied, false);
  assert.equal(changeset.files[0].applied, false); assert.equal(fs.readFileSync(f.file, 'utf8'), 'Original text.\n');
});

test('tool boundary checks reject permission changes outside project mutation routes', { timeout: 5000 }, async () => {
  const f = await fixture(editor);
  db.prepare("UPDATE project_members SET role='viewer' WHERE project_id=? AND user_id=?").run(f.project.id, editor.user.id);
  tool(held, 'edit_file', { path: 'notes.txt', search: 'Original text.', replace: 'Must not execute.' });
  const events = await f.events();
  assert.equal(events.at(-1).state, 'failed'); assert.equal(requests, 2);
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'Original text.\n');
  assert.ok(events.some(e => e.type === 'tool' && e.name === 'edit_file' && e.status === 'error'));
});

test('commit boundary preserves a draft if edit access is lost after the last tool', { timeout: 5000 }, async () => {
  const f = await fixture(editor, 'hold-after-edit');
  db.prepare("UPDATE project_members SET role='viewer' WHERE project_id=? AND user_id=?").run(f.project.id, editor.user.id);
  finish(held);
  const events = await f.events(), changeset = events.find(e => e.type === 'changeset').changeset;
  assert.equal(events.at(-1).state, 'failed'); assert.equal(changeset.applied, false);
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'Original text.\n');
});

test('a normal authorized run still automatically applies and completes', { timeout: 5000 }, async () => {
  const f = await fixture(owner, 'normal');
  assert.equal((await f.events()).at(-1).state, 'completed');
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'Actual edit.\n'); assert.equal(requests, 3);
});

test('removing an editor after a completed edit retains only its authorized checkpoint for project review', { timeout: 5000 }, async () => {
  const f = await fixture(editor, 'hold-after-edit');
  assert.equal((await f.call('DELETE', '/members/' + editor.user.id)).status, 200);
  const events = await f.events(), proposal = events.find(event => event.type === 'changeset')?.changeset;
  assert.equal(events.at(-1).state, 'cancelled'); assert.ok(proposal); assert.equal(proposal.applied, false);
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'Original text.\n');
  assert.equal(requests, 3);
  assert.equal((await f.call('GET', '/changesets', undefined, editor.token)).status, 403);
  assert.equal(db.prepare('SELECT after_content FROM changeset_files WHERE changeset_id=?').get(proposal.id).after_content, 'Actual edit.\n');
});

test('disabled account at the commit boundary cannot auto-apply but its completed checkpoint survives', { timeout: 5000 }, async () => {
  const f = await fixture(editor, 'hold-after-edit');
  db.prepare("UPDATE users SET status='disabled' WHERE id=?").run(editor.user.id);
  try {
    finish(held);
    const events = await f.events(), proposal = events.find(event => event.type === 'changeset')?.changeset;
    assert.equal(events.at(-1).state, 'failed'); assert.ok(proposal); assert.equal(proposal.applied, false);
    assert.equal(fs.readFileSync(f.file, 'utf8'), 'Original text.\n'); assert.equal(requests, 3);
    assert.equal((await f.call('GET', '/changesets', undefined, editor.token)).status, 403);
  } finally { db.prepare("UPDATE users SET status='active' WHERE id=?").run(editor.user.id); }
});
