import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { contextModelKey } from '../src/services/agent/context.js';
import { createContextUsageTracker, estimateRequestContext, readContextUsage, refreshSavedContextUsage } from '../src/services/agent/contextUsage.js';

const modelConfig = { id: 'entry-a', providerId: 'supplier-a', provider: 'openai', model: 'test-model', contextLength: 100000 };
function fixture(t) {
  const db = new Database(':memory:');
  db.exec("CREATE TABLE chats(id INTEGER PRIMARY KEY, summary TEXT, context_usage TEXT); INSERT INTO chats VALUES(1,'','')");
  t.after(() => db.close());
  const events = [];
  const tracker = createContextUsageTracker({ db, chatId: 1, modelConfig, emit: event => events.push(event) });
  const request = { requestId: 1, owner: 'coordinator', phase: 'investigation',
    context: { systemPrompt: '系统约束', tools: [{ name: 'read_file', parameters: { path: { type: 'string' } } }],
      messages: [{ role: 'user', content: '请读取文稿' }] } };
  const read = () => readContextUsage(db.prepare('SELECT * FROM chats').get(), modelConfig);
  return { db, events, tracker, request, read };
}

test('context counts the full reported input, includes cached prefixes, and excludes output/reasoning', t => {
  const { tracker, request, read, events } = fixture(t);
  tracker.onRequestStart(request);
  assert.equal(read().estimated, true);
  tracker.onRequestSettled({ entry: request, result: { stopReason: 'stop', usage: { input: 200, cacheRead: 70000, cacheWrite: 5000, output: 8000 } } });
  assert.equal(read().usedTokens, 75200);
  assert.equal(read().estimated, false);
  assert.equal(events.at(-1).type, 'context_usage');
  assert.equal(read().maxTokens, 100000);
});

test('worker and summary contexts never overwrite the main conversation', t => {
  const { tracker, request, read } = fixture(t);
  tracker.onRequestStart(request);
  const initial = read();
  for (const changed of [{ owner: 'reviewer' }, { phase: 'history_compaction' }]) {
    const other = { ...request, requestId: 2, ...changed };
    tracker.onRequestStart(other);
    tracker.onRequestSettled({ entry: other, result: { stopReason: 'stop', usage: { input: 99999, output: 5 } } });
    assert.deepEqual(read(), initial);
  }
});

test('missing usage, failure, and a late previous request do not replace the latest estimate with zero or stale data', t => {
  const { tracker, request, read } = fixture(t);
  tracker.onRequestStart(request);
  const second = { ...request, requestId: 2, context: { messages: [{ role: 'user', content: 'new context'.repeat(100) }] } };
  tracker.onRequestStart(second);
  const initial = read();
  tracker.onRequestSettled({ entry: request, result: { stopReason: 'stop', usage: { input: 10000 } } });
  for (const result of [{ stopReason: 'stop', usage: { input: 0, output: 0 } }, { stopReason: 'error', usage: { input: 10000 } }]) {
    tracker.onRequestSettled({ entry: second, result });
    assert.deepEqual(read(), initial);
  }
});

test('estimates include system/tool schemas and Unicode, without tokenizing image base64', () => {
  const text = estimateRequestContext({ messages: [{ content: '汉字'.repeat(100) }] }).usedTokens;
  assert.ok(text >= 300);
  const image = data => estimateRequestContext({ messages: [{ content: [{ type: 'image', data }] }] }).usedTokens;
  assert.equal(image('AA=='), image('A'.repeat(1000000)));
  const base = estimateRequestContext({ messages: [{ content: 'hello' }] }).usedTokens;
  assert.ok(estimateRequestContext({ systemPrompt: 'rules'.repeat(100), tools: [{ name: 'tool' }], messages: [{ content: 'hello' }] }).usedTokens > base);
});

test('saved history rebases after compaction and does not retain discarded live tool results', t => {
  const { tracker, request, read, db } = fixture(t);
  request.context.messages.push({ role: 'toolResult', content: 'file contents'.repeat(10000) });
  tracker.onRequestStart(request);
  const large = read().usedTokens;
  db.prepare('UPDATE chats SET summary=? WHERE id=1').run('保留用户约束的摘要');
  refreshSavedContextUsage({ db, chatId: 1, modelConfig, messages: [{ role: 'user', content: '继续' }] });
  assert.ok(read().usedTokens < large / 10);
  assert.equal(read().basis, 'history');
  assert.equal(read().estimated, true);
});

test('model, provider and window changes invalidate old measurements, while labels do not', t => {
  const { tracker, request, db } = fixture(t);
  tracker.onRequestStart(request);
  const chat = db.prepare('SELECT * FROM chats').get();
  for (const changed of [{ id: 'b' }, { providerId: 'another' }, { model: 'other' }, { contextLength: 200000 }]) {
    assert.equal(readContextUsage(chat, { ...modelConfig, ...changed }), null);
  }
  assert.ok(readContextUsage(chat, { ...modelConfig, name: 'renamed', apiKey: 'different' }));
  assert.equal(JSON.parse(chat.context_usage).modelKey, contextModelKey(modelConfig));
});

test('a cleared or malformed saved context is unknown and cannot be restored by old display state', t => {
  const { tracker, request, db, read } = fixture(t);
  tracker.onRequestStart(request);
  db.prepare("UPDATE chats SET context_usage='' WHERE id=1").run();
  assert.equal(read(), null);
  assert.equal(refreshSavedContextUsage({ db, chatId: 1, modelConfig, messages: [] }), null);
  db.prepare("UPDATE chats SET context_usage='invalid' WHERE id=1").run();
  assert.equal(read(), null);
  db.prepare('DELETE FROM chats').run();
  tracker.onRequestSettled({ entry: request, result: { stopReason: 'stop', usage: { input: 300 } } });
  assert.equal(read(), null);
});
