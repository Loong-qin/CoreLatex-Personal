import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { startTestServer, api, registerAndLogin } from './helpers.js';

let srv, llm, owner, other, project, db, runs;
let calls = 0, hold = false;
const sse = obj => `data: ${JSON.stringify(obj)}\n\n`;
const events = text => text.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
const endpoint = suffix => `/api/projects/${project.publicId}${suffix}`;
const call = (method, suffix, body, token = owner.token) => api(srv.baseUrl, method, endpoint(suffix), { token, body });
const post = (suffix, body, token = owner.token) => api(srv.baseUrl, 'POST', endpoint(suffix), { token, body, raw: true });
const messageCount = () => db.prepare('SELECT COUNT(*) AS n FROM chat_messages').get().n;

before(async () => {
  llm = http.createServer((req, res) => {
    req.resume(); req.on('end', () => {
      calls++; res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (!hold) res.end(sse({ choices: [{ index: 0, delta: { content: 'Completed fixture.' } }] })
        + sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n');
    });
  });
  await new Promise(resolve => llm.listen(0, '127.0.0.1', resolve));
  srv = await startTestServer();
  ({ getDb: db } = await import('../src/db.js')); db = db(); runs = await import('../src/services/agent/runs.js');
  owner = await registerAndLogin(srv.baseUrl, 'request-owner'); other = await registerAndLogin(srv.baseUrl, 'request-other');
  project = (await api(srv.baseUrl, 'POST', '/api/projects', { token: owner.token, body: { name: 'request-identity-fixture' } })).data.project;
  await call('POST', '/members', { username: 'request-other', role: 'editor' });
  assert.equal((await api(srv.baseUrl, 'PUT', '/api/settings/ai', { token: owner.token, body: {
    provider: 'openai', baseUrl: `http://127.0.0.1:${llm.address().port}/v1`, apiKey: 'fixture-only', model: 'gpt-fixture',
  } })).status, 200);
});
after(async () => {
  for (const run of db.prepare("SELECT id FROM agent_runs WHERE state IN ('running','waiting_for_user','cancelling')").all()) await runs.cancelRun(run.id);
  llm.closeAllConnections(); await new Promise(resolve => llm.close(resolve));
  srv.server.closeAllConnections(); await srv.close();
});

test('validates request IDs before adding messages or starting model requests', async () => {
  const before = messageCount(), beforeCalls = calls;
  for (const requestId of ['', 'not-a-uuid', 42, '00000000-0000-0000-0000-000000000000']) {
    assert.equal((await call('POST', '/agent/chat', { requestId, message: 'invalid request' })).status, 400);
  }
  assert.equal(messageCount(), before); assert.equal(calls, beforeCalls);
});

test('uses the client request ID and replays completion without repeating messages, attachments or model calls', async () => {
  const requestId = randomUUID();
  const first = await post('/agent/chat', { requestId, message: 'Run exactly once' });
  const original = events(await first.text());
  assert.equal(first.status, 200); assert.ok(original.every(event => event.runId === requestId));
  assert.equal(original.at(-1).state, 'completed');
  const before = messageCount(), beforeCalls = calls;
  // An invalid attachment would be rejected by saveAgentAttachments if replay
  // did not happen before attachment processing.
  const repeated = await post('/agent/chat', { requestId, message: 'Run exactly once', files: [{ name: 'must-not-be-created.txt', data: 'INVALID!' }] });
  assert.equal(repeated.status, 200); assert.deepEqual(events(await repeated.text()), original);
  assert.equal(messageCount(), before); assert.equal(calls, beforeCalls);
  const unauthorized = await call('POST', '/agent/chat', { requestId, message: 'reuse another user identity' }, other.token);
  assert.equal(unauthorized.status, 409); assert.equal(messageCount(), before); assert.equal(calls, beforeCalls);
  const secondProject = (await api(srv.baseUrl, 'POST', '/api/projects', { token: owner.token, body: { name: 'different-project' } })).data.project;
  assert.equal((await api(srv.baseUrl, 'POST', `/api/projects/${secondProject.publicId}/agent/chat`, { token: owner.token, body: { requestId, message: 'wrong project' } })).status, 409);
  assert.equal(messageCount(), before); assert.equal(calls, beforeCalls);
});

test('selection retries replay the original run even after the source selection changes', async () => {
  const { projectDir } = await import('../src/config.js');
  const target = path.join(projectDir(project.id), 'identity-selection.tex');
  fs.writeFileSync(target, 'Original paragraph');
  const body = { requestId: randomUUID(), action: 'explain', file: 'identity-selection.tex', start: 0, end: 8, selectionText: 'Original' };
  const first = await post('/agent/selection-action', body); const original = events(await first.text());
  assert.equal(first.status, 200); assert.equal(original.at(-1).state, 'completed');
  const before = messageCount(), beforeCalls = calls;
  fs.writeFileSync(target, 'Changed paragraph');
  const repeated = await post('/agent/selection-action', body);
  assert.equal(repeated.status, 200); assert.deepEqual(events(await repeated.text()), original);
  assert.equal(messageCount(), before); assert.equal(calls, beforeCalls);
});

test('can cancel by the known request ID before consuming a single SSE event', async () => {
  hold = true;
  const requestId = randomUUID();
  const response = await post('/agent/chat', { requestId, message: 'Cancel before reading any event' });
  assert.equal(response.status, 200);
  const cancelled = await call('POST', `/agent/runs/${requestId}/cancel`, {});
  assert.equal(cancelled.status, 200); assert.equal(cancelled.data.run.state, 'cancelled');
  assert.equal(events(await response.text()).at(-1).state, 'cancelled');
  assert.equal((await call('GET', '/agent/runs/active')).data.run, null);
  hold = false;
});
