import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startTestServer, api, registerAndLogin } from './helpers.js';

let srv, llm, owner, other, project, db, model, key, calls = 0, hold = false, fail = false, entered;
const sse = value => 'data: ' + JSON.stringify(value) + '\n\n';
const endpoint = suffix => `/api/projects/${project.publicId}${suffix}`;
const call = (method, suffix, body, token = owner.token) => api(srv.baseUrl, method, endpoint(suffix), { token, body });
before(async () => {
  llm = http.createServer((req, res) => {
    let raw = '';
    req.on('data', value => raw += value);
    req.on('end', () => {
      calls++; entered?.();
      const body = JSON.parse(raw);
      if (hold) return;
      if (!body.stream) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ model: 'fixture-response', usage: { prompt_tokens: 100, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 80 } } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(sse({ choices: [{ index: 0, delta: { content: fail ? '' : '保留用户约束和已完成工作的摘要。' } }] })
        + sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
        + sse({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 80 } } }) + 'data: [DONE]\n\n');
    });
  });
  await new Promise(resolve => llm.listen(0, '127.0.0.1', resolve));
  srv = await startTestServer();
  ({ getDb: db } = await import('../src/db.js')); db = db();
  owner = await registerAndLogin(srv.baseUrl, 'context-owner');
  other = await registerAndLogin(srv.baseUrl, 'context-other');
  project = (await api(srv.baseUrl, 'POST', '/api/projects', { token: owner.token, body: { name: 'context-fixture' } })).data.project;
  await api(srv.baseUrl, 'PUT', '/api/settings/ai', { token: owner.token, body: {
    provider: 'openai', baseUrl: `http://127.0.0.1:${llm.address().port}/v1`, apiKey: 'fixture-secret', model: 'fixture-model',
  } });
  const { resolveModelConfig } = await import('../src/services/agent/models.js');
  const { contextModelKey } = await import('../src/services/agent/context.js');
  model = resolveModelConfig(db.prepare('SELECT * FROM settings WHERE user_id=?').get(owner.user.id));
  key = contextModelKey(model);
});
after(async () => {
  llm.closeAllConnections(); await new Promise(resolve => llm.close(resolve));
  srv.server.closeAllConnections(); await srv.close();
});

async function seed() {
  hold = false; fail = false;
  await call('DELETE', '/chat');
  const chat = db.prepare('SELECT * FROM chats WHERE project_id=? AND user_id=?').get(project.id, owner.user.id);
  for (const [role, content] of [['user', 'Old constraints '.repeat(100)], ['assistant', 'Old work'], ['user', 'Current request'], ['assistant', 'Current result']]) {
    db.prepare('INSERT INTO chat_messages(chat_id,role,content) VALUES(?,?,?)').run(chat.id, role, content);
  }
  const snapshot = { usedTokens: 70000, maxTokens: model.contextLength, fixedTokens: 2000, modelId: model.id, modelKey: key, estimated: false, updatedAt: Date.now() };
  db.prepare('UPDATE chats SET context_model_key=?,context_usage=? WHERE id=?').run(key, JSON.stringify(snapshot), chat.id);
  return chat;
}

test('manual compaction preserves messages, updates context, accounts for cache, and repeated no-op does not call provider', async () => {
  const chat = await seed(), before = calls;
  const result = await call('POST', '/agent/context/compact', { modelId: model.id });
  assert.equal(result.status, 200); assert.equal(result.data.compressed, true);
  assert.equal(result.data.contextUsage.estimated, true);
  assert.ok(result.data.contextUsage.usedTokens < 70000);
  const saved = db.prepare('SELECT * FROM chats WHERE id=?').get(chat.id);
  assert.ok(saved.summary_msg_id > 0); assert.match(saved.summary, /保留用户约束/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM chat_messages WHERE chat_id=?').get(chat.id).n, 4);
  const usage = db.prepare('SELECT * FROM ai_usage WHERE chat_id=? ORDER BY id DESC LIMIT 1').get(chat.id);
  assert.equal(usage.input_tokens, 100); assert.equal(usage.cache_read_tokens, 80); assert.equal(usage.phase, 'history_compaction');
  const repeated = await call('POST', '/agent/context/compact', { modelId: model.id });
  assert.equal(repeated.data.compressed, false); assert.equal(calls, before + 1);
  const loaded = await call('GET', '/chat');
  assert.deepEqual(loaded.data.contextUsage, result.data.contextUsage);
  assert.equal(loaded.data.messages.length, 4);
});

test('a failed summary preserves history and its measurement but still accounts for its reported usage', async () => {
  const chat = await seed(); fail = true;
  const before = db.prepare('SELECT * FROM chats WHERE id=?').get(chat.id);
  const result = await call('POST', '/agent/context/compact', { modelId: model.id });
  assert.equal(result.status, 502);
  const after = db.prepare('SELECT * FROM chats WHERE id=?').get(chat.id);
  assert.equal(after.summary, before.summary); assert.equal(after.summary_msg_id, before.summary_msg_id);
  assert.equal(after.context_usage, before.context_usage);
  assert.equal(db.prepare('SELECT input_tokens n FROM ai_usage WHERE chat_id=? ORDER BY id DESC LIMIT 1').get(chat.id).n, 100);
});

test('compaction holds the run admission lock, and clearing cancels it before resetting context', async () => {
  await seed(); hold = true;
  const started = new Promise(resolve => entered = resolve);
  const pending = call('POST', '/agent/context/compact', { modelId: model.id });
  await started; entered = null;
  assert.equal((await call('POST', '/agent/context/compact', { modelId: model.id })).status, 409);
  assert.equal((await call('POST', '/agent/chat', { message: 'must not run', modelId: model.id })).status, 409);
  assert.equal((await call('DELETE', '/chat')).status, 200);
  assert.equal((await pending).status, 409);
  const loaded = await call('GET', '/chat');
  assert.equal(loaded.data.contextUsage, null); assert.deepEqual(loaded.data.messages, []);
});

test('context and compaction follow project permissions', async () => {
  await seed(); const before = calls;
  for (const [method, suffix] of [['GET', '/chat'], ['POST', '/agent/context/compact']]) {
    const result = await call(method, suffix, method === 'POST' ? { modelId: model.id } : undefined, other.token);
    assert.ok([403, 404].includes(result.status));
  }
  assert.equal(calls, before);
});

test('connection tests count their actual provider request and full input separately', async () => {
  hold = false;
  const result = await api(srv.baseUrl, 'POST', '/api/settings/ai/test', { token: owner.token, body: { modelId: model.id } });
  assert.equal(result.status, 200); assert.equal(result.data.ok, true);
  const usage = db.prepare("SELECT * FROM ai_usage WHERE user_id=? AND phase='connection_test' ORDER BY id DESC LIMIT 1").get(owner.user.id);
  assert.equal(usage.input_tokens, 100); assert.equal(usage.output_tokens, 1); assert.equal(usage.cache_read_tokens, 80);
  assert.equal(usage.model, 'fixture-response'); assert.equal(usage.requested_model, model.model);
});

test('maintenance rejects connection tests before dispatching or recording usage', async () => {
  const { acquireMaintenance, releaseMaintenance } = await import('../src/services/maintenance.js');
  const ownerToken = 'c'.repeat(64);
  const beforeCalls = calls;
  const beforeRows = db.prepare('SELECT COUNT(*) AS n FROM ai_usage').get().n;
  acquireMaintenance(db, { ownerToken });
  try {
    const result = await api(srv.baseUrl, 'POST', '/api/settings/ai/test', { token: owner.token, body: { modelId: model.id } });
    assert.equal(result.status, 503);
    assert.equal(calls, beforeCalls);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ai_usage').get().n, beforeRows);
  } finally { releaseMaintenance(db, { ownerToken }); }
});

test('context follows the requested model and window without replacing a valid previous snapshot', async t => {
  const chat = await seed(), before = calls;
  const aiSettings = (method, body) => api(srv.baseUrl, method, '/api/settings/ai', { token: owner.token, body });
  const { data: original } = await aiSettings('GET');
  t.after(() => aiSettings('PUT', { providers: original.providers, activeModelId: original.activeModelId }));
  const providers = structuredClone(original.providers);
  const provider = providers.find(provider => provider.id === model.providerId);
  const alternate = { id: 'alternate', model: 'fixture-alternate', contextLength: 100000 };
  provider.models.push(alternate);
  assert.equal((await aiSettings('PUT', { providers, activeModelId: alternate.id })).status, 200);
  const snapshot = db.prepare('SELECT context_usage FROM chats WHERE id=?').get(chat.id).context_usage;
  const loaded = await call('GET', '/chat');
  assert.equal(loaded.status, 200);
  const usage = loaded.data.contextUsage;
  assert.equal(usage.modelId, alternate.id);
  assert.equal(usage.maxTokens, alternate.contextLength);
  assert.equal(usage.basis, 'history');
  assert.equal(usage.estimated, true);
  assert.ok(usage.usedTokens > 2000 && usage.usedTokens < 70000);
  const settingsForUi = (await aiSettings('GET')).data;
  assert.equal(usage.modelKey, settingsForUi.models.find(item => item.id === alternate.id).contextModelKey);
  const measured = await call('GET', `/agent/context?modelId=${model.id}`);
  assert.equal(measured.data.chatId, chat.id);
  assert.equal(measured.data.contextUsage.usedTokens, 70000);
  assert.equal(measured.data.contextUsage.estimated, false);
  assert.equal(measured.data.contextUsage.modelKey, key);
  assert.equal((await call('GET', `/chat?modelId=${model.id}`)).data.contextUsage.usedTokens, 70000);

  provider.models.find(item => item.id === model.id).contextLength = 160000;
  assert.equal((await aiSettings('PUT', { providers })).status, 200);
  const resized = (await call('GET', `/agent/context?modelId=${model.id}`)).data.contextUsage;
  assert.equal(resized.modelId, model.id);
  assert.equal(resized.maxTokens, 160000);
  assert.equal(resized.estimated, true);
  assert.equal(resized.usedTokens, usage.usedTokens);
  assert.equal(db.prepare('SELECT context_usage FROM chats WHERE id=?').get(chat.id).context_usage, snapshot);
  assert.equal(db.prepare('SELECT ai_active FROM settings WHERE user_id=?').get(owner.user.id).ai_active, alternate.id);
  assert.equal(calls, before);
});

test('legacy chats estimate replayable messages and summary without retaining compacted or tool payloads', async () => {
  const chat = await seed(), before = calls;
  const rows = db.prepare('SELECT id FROM chat_messages WHERE chat_id=? ORDER BY id').all(chat.id);
  db.prepare('UPDATE chats SET context_usage=?, summary=?, summary_msg_id=? WHERE id=?')
    .run('', '保留旧约束', rows[1].id, chat.id);
  const first = await call('GET', '/chat');
  assert.equal(first.status, 200);
  assert.equal(first.data.messages.length, 4);
  const { contextUsage } = first.data;
  assert.equal(contextUsage.modelId, model.id);
  assert.equal(contextUsage.maxTokens, model.contextLength);
  assert.equal(contextUsage.basis, 'history');
  assert.equal(contextUsage.estimated, true);
  assert.ok(contextUsage.usedTokens > 1000);

  db.prepare('UPDATE chat_messages SET content=? WHERE id=?').run('compacted '.repeat(12000), rows[1].id);
  db.prepare('UPDATE chat_messages SET steps=? WHERE id=?').run(JSON.stringify([{ type: 'tool', result: 'tool result '.repeat(12000) }]), rows[3].id);
  const next = (await call('GET', '/agent/context')).data.contextUsage;
  assert.equal(next.usedTokens, contextUsage.usedTokens);
  assert.equal(db.prepare('SELECT context_usage FROM chats WHERE id=?').get(chat.id).context_usage, '');
  const compact = await call('POST', '/agent/context/compact', { modelId: model.id });
  assert.equal(compact.status, 200);
  assert.equal(compact.data.compressed, false);
  assert.equal(compact.data.contextUsage.usedTokens, contextUsage.usedTokens);
  assert.equal(calls, before);
});

test('a streamed turn reports full provider input, then persists the next-turn estimate before completion', async () => {
  hold = false; fail = false;
  await call('DELETE', '/chat');
  const before = calls;
  const response = await api(srv.baseUrl, 'POST', endpoint('/agent/chat'), {
    token: owner.token, body: { message: '请简短打个招呼', modelId: model.id }, raw: true,
  });
  assert.equal(response.status, 200);
  const events = (await response.text()).split('\n').filter(line => line.startsWith('data: '))
    .map(line => JSON.parse(line.slice(6)));
  const usageEvents = events.filter(event => event.type === 'context_usage');
  assert.equal(calls, before + 1);
  const measured = usageEvents.find(event => event.contextUsage.estimated === false);
  assert.equal(measured.contextUsage.usedTokens, 100);
  assert.equal(measured.contextUsage.maxTokens, model.contextLength);
  assert.equal(measured.contextUsage.basis, 'request');
  assert.equal(measured.contextUsage.modelKey, key);
  const rebase = usageEvents.at(-1);
  assert.equal(rebase.chatId, measured.chatId);
  assert.equal(rebase.contextUsage.basis, 'history');
  assert.equal(rebase.contextUsage.estimated, true);
  assert.ok(usageEvents.every((event, index) => !index || event.contextUsage.updatedAt > usageEvents[index - 1].contextUsage.updatedAt));
  assert.equal(events.at(-1).type, 'done');
  assert.deepEqual((await call('GET', '/chat')).data.contextUsage, rebase.contextUsage);
});
