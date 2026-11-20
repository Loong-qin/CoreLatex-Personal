import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'corelatex-thinking-'));
process.env.CORELATEX_DATA_DIR = dataDir;
let dbModule, db, runAgent, createProviderThinkingCollector, user, llm, wire = [], scripts = [];
const sse = (delta, finish_reason) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, ...(finish_reason ? { finish_reason } : {}) }] })}\n\n`;
const done = (res, text = '本轮尚未执行修改。') => res.end(sse({ content: text }) + sse({}, 'stop') + 'data: [DONE]\n\n');
const thinking = (res, text) => res.write(sse({ reasoning_content: text }));
const tool = (res, name, input) => res.end(sse({ tool_calls: [{ index: 0, id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(input) } }] }) + sse({}, 'tool_calls') + 'data: [DONE]\n\n');

before(async () => {
  dbModule = await import('../src/db.js'); db = dbModule.getDb();
  ({ runAgent, createProviderThinkingCollector } = await import('../src/services/agent/agentLoop.js'));
  const id = Number(db.prepare("INSERT INTO users(username,password_hash,role) VALUES('thinking-test','unused','admin')").run().lastInsertRowid);
  user = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  db.prepare('INSERT INTO settings(user_id) VALUES(?)').run(id);
  llm = http.createServer((req, res) => {
    let body = ''; req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      wire.push(JSON.parse(body)); res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const action = scripts.shift();
      if (!action) return done(res, 'Unexpected extra mock request.');
      action(res);
    });
  });
  await new Promise((resolve) => llm.listen(0, '127.0.0.1', resolve));
});
after(async () => {
  llm.closeAllConnections(); await new Promise((resolve) => llm.close(resolve));
  dbModule.resetDb(); fs.rmSync(dataDir, { recursive: true, force: true });
});
function fixture() {
  const id = Number(db.prepare('INSERT INTO projects(name,owner_id,public_id) VALUES(?,?,?)').run('thinking', user.id, randomUUID()).lastInsertRowid);
  const project = db.prepare('SELECT * FROM projects WHERE id=?').get(id);
  const dir = path.join(dataDir, 'projects', String(id)); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'main.tex'), 'Actual project text.\n');
  const chatId = Number(db.prepare('INSERT INTO chats(project_id,user_id) VALUES(?,?)').run(id, user.id).lastInsertRowid);
  return { project, chat: db.prepare('SELECT * FROM chats WHERE id=?').get(chatId) };
}
async function run({ onEvent = () => {}, signal, provider = 'openai' } = {}) {
  wire = []; const events = []; const f = fixture();
  const result = await runAgent({ user, ...f, messages: [{ role: 'user', content: 'Inspect the project without editing.' }],
    modelConfig: { provider, model: 'gpt-thinking-test', apiKey: 'fixture-api-key', baseUrl: `http://127.0.0.1:${llm.address().port}/v1` },
    emit: (event) => { events.push(structuredClone(event)); onEvent(event); }, signal });
  const row = db.prepare('SELECT * FROM chat_messages WHERE id=?').get(result.messageId);
  return { result, events, row, steps: JSON.parse(row.steps) };
}

// These tests exercise the exact normalized SDK field boundary without ever
// serializing opaque signatures, encrypted provider objects or redacted blocks.
test('thinking collector reconciles each block, final rewrites and repeated final snapshots without duplication', () => {
  const out = []; const collector = createProviderThinkingCollector((event) => out.push(event), { now: () => 1000 });
  const partial = { content: [{ type: 'thinking', thinking: '', thinkingSignature: 'opaque-signature' }] };
  collector.update({ type: 'thinking_start', contentIndex: 0, partial });
  assert.equal(out.length, 0);
  collector.update({ type: 'thinking_delta', contentIndex: 0, delta: 'provider old text', partial });
  collector.update({ type: 'thinking_end', contentIndex: 0, content: 'provider old text', partial });
  assert.equal(out.filter((e) => e.delta).length, 1);
  const final = { stopReason: 'stop', content: [{ type: 'thinking', thinking: 'short final', thinkingSignature: 'opaque-signature' }, { type: 'text', text: 'answer' }, { type: 'thinking', thinking: 'second block' }] };
  collector.reconcile(final); collector.reconcile(final);
  const contentUpdates = out.filter((e) => e.delta);
  assert.equal(contentUpdates.length, 3);
  assert.deepEqual(contentUpdates[1], { blockIndex: 0, text: 'short final', delta: 'short final', replace: true, startedAt: 1000, durationMs: 0 });
  assert.deepEqual(contentUpdates[2], { blockIndex: 2, text: 'second block', delta: 'second block', replace: false });
  assert.ok(!JSON.stringify(out).includes('opaque-signature'));
});

test('redacted and signature-only blocks never produce thinking text', () => {
  const out = []; const collector = createProviderThinkingCollector((event) => out.push(event), { now: () => 1000 });
  const redacted = { type: 'thinking', redacted: true, thinking: '[Reasoning redacted]', thinkingSignature: 'encrypted-secret' };
  collector.update({ type: 'thinking_delta', contentIndex: 0, delta: 'must not appear', partial: { content: [redacted] } });
  collector.reconcile({ stopReason: 'stop', content: [redacted, { type: 'thinking', thinking: '', thinkingSignature: 'signature-only-secret' }, { type: 'thinking', thinking: '' }] });
  assert.deepEqual(out, []);
});

test('provider reasoning streams exactly once and persists separately from normal answer text', async () => {
  scripts = [(res) => { thinking(res, 'API returned first '); thinking(res, 'reasoning fragment.'); done(res, 'Normal answer.'); }];
  const { result, events, row, steps } = await run();
  assert.equal(result.status, 'completed'); assert.equal(wire.length, 1);
  assert.equal(events.filter((e) => e.type === 'model_thinking').map((e) => e.text).join(''), 'API returned first reasoning fragment.');
  const thought = steps.find((s) => s.type === 'model_thinking');
  assert.equal(thought.text, 'API returned first reasoning fragment.'); assert.equal(thought.source, 'provider');
  assert.equal(thought.blockIndex, 0); assert.ok(Number.isInteger(thought.durationMs) && thought.durationMs >= 0);
  assert.ok(Number.isInteger(thought.startedAt));
  assert.equal(row.content, 'Normal answer.');
  assert.equal(events.filter((e) => e.type === 'activity').length, 0);
});

test('no provider reasoning means no placeholder thinking or planning content', async () => {
  scripts = [(res) => done(res)];
  const { events, steps } = await run();
  assert.equal(events.filter((e) => ['model_thinking', 'activity'].includes(e.type)).length, 0);
  assert.equal(steps.filter((s) => ['model_thinking', 'activity'].includes(s.type)).length, 0);
});

test('retry removes only the failed response thinking and preserves completed earlier responses', async () => {
  scripts = [
    (res) => { thinking(res, 'First completed response.'); tool(res, 'read_file', { path: 'main.tex' }); },
    (res) => { thinking(res, 'Failed attempt fragment.'); setTimeout(() => res.destroy(), 40); },
    (res) => { thinking(res, 'Successful retry response.'); done(res); },
  ];
  const { result, events, steps } = await run();
  assert.equal(result.status, 'completed'); assert.equal(wire.length, 3);
  assert.ok(events.some((e) => e.type === 'model_thinking' && e.text === 'Failed attempt fragment.'));
  assert.ok(events.some((e) => e.type === 'response_reset'));
  assert.deepEqual(steps.filter((s) => s.type === 'model_thinking').map((s) => s.text), ['First completed response.', 'Successful retry response.']);
  assert.ok(steps.some((s) => s.type === 'activity' && s.phase === 'retry' && s.source === 'system'));
});

test('cancellation retains already returned provider thinking with no fabricated replacement', async () => {
  const controller = new AbortController();
  let persistedBeforeDisplay;
  scripts = [(res) => thinking(res, 'Visible before cancellation.')];
  const { result, steps } = await run({ signal: controller.signal, onEvent: (event) => {
    if (event.type === 'model_thinking') {
      persistedBeforeDisplay ??= JSON.parse(db.prepare("SELECT steps FROM chat_messages WHERE role = 'assistant' ORDER BY id DESC LIMIT 1").get().steps)
        .find((step) => step.type === 'model_thinking')?.text;
      controller.abort();
    }
  } });
  assert.equal(persistedBeforeDisplay, 'Visible before cancellation.');
  assert.equal(result.status, 'cancelled');
  assert.deepEqual(steps.filter((s) => s.type === 'model_thinking').map((s) => s.text), ['Visible before cancellation.']);
});

test('report_progress remains distinct model activity and masks the configured key in emitted and saved fields', async () => {
  scripts = [(res) => tool(res, 'report_progress', { summary: 'Inspect main.tex with fixture-api-key.' }), (res) => done(res)];
  const { events, row, steps } = await run();
  assert.equal(events.filter((e) => e.type === 'model_thinking').length, 0);
  assert.deepEqual(steps.filter((s) => s.type === 'activity'), [{ type: 'activity', text: 'Inspect main.tex with [密钥已隐藏].', phase: 'planning', source: 'model' }]);
  assert.ok(!JSON.stringify(events).includes('fixture-api-key'));
  assert.ok(!JSON.stringify(row).includes('fixture-api-key'));
});


test('thinking timing freezes at its own end and excludes later text, tools, and final reconciliation', () => {
  let now = 1000; const out = [];
  const collector = createProviderThinkingCollector((event) => out.push(event), { now: () => now });
  const partial = { content: [{ type: 'thinking', thinking: '' }] };
  collector.update({ type: 'thinking_start', contentIndex: 0, partial });
  now = 1300; collector.update({ type: 'thinking_delta', contentIndex: 0, delta: 'working', partial });
  now = 1700; collector.update({ type: 'thinking_end', contentIndex: 0, content: 'working', partial });
  assert.equal(out.at(-1).delta, ''); assert.equal(out.at(-1).durationMs, 700);
  const count = out.length;
  now = 3000; collector.update({ type: 'text_delta', contentIndex: 1, delta: 'answer' });
  now = 15000; collector.reconcile({ stopReason: 'stop', content: [{ type: 'thinking', thinking: 'working' }, { type: 'text', text: 'answer' }] });
  collector.finish(); assert.equal(out.length, count); assert.equal(out.at(-1).durationMs, 700);
  collector.reset(); now = 20000;
  collector.update({ type: 'thinking_delta', contentIndex: 0, delta: 'retry thinking', partial });
  now = 20500; collector.finish(); assert.equal(out.at(-1).durationMs, 500);
});

test('first text ends unclosed thinking timing and final correction preserves that duration', () => {
  let now = 1000; const out = [];
  const collector = createProviderThinkingCollector((event) => out.push(event), { now: () => now });
  const partial = { content: [{ type: 'thinking', thinking: '' }] };
  collector.update({ type: 'thinking_start', contentIndex: 0, partial });
  now = 1400; collector.update({ type: 'thinking_delta', contentIndex: 0, delta: 'long streamed text', partial });
  now = 2000; collector.update({ type: 'text_delta', contentIndex: 1, delta: 'answer' });
  now = 3000; collector.reconcile({ stopReason: 'stop', content: [{ type: 'thinking', thinking: 'short final' }] });
  assert.equal(out.at(-1).replace, true); assert.equal(out.at(-1).durationMs, 1000);
});

function anthropicBlocks(res, blocks) {
  const event = (type, body) => `event: ${type}\ndata: ${JSON.stringify({ type, ...body })}\n\n`;
  let out = event('message_start', { message: { id: 'anthropic-thinking-fixture', type: 'message', role: 'assistant', content: [], usage: { input_tokens: 1, output_tokens: 1 } } });
  for (const [index, block] of blocks.entries()) {
    if (block.type === 'tool_use') {
      out += event('content_block_start', { index, content_block: { type: 'tool_use', id: 'read-main', name: block.name, input: {} } });
      out += event('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
    } else {
      out += event('content_block_start', { index, content_block: { type: block.type, [block.type]: '' } });
      out += event('content_block_delta', { index, delta: { type: block.type + '_delta', [block.type]: block.text } });
    }
    out += event('content_block_stop', { index });
  }
  out += event('message_delta', { delta: { stop_reason: blocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 10 } });
  res.end(out + event('message_stop', {}));
}

test('thinking streams immediately; confirmed tool narration retains block order in persisted history', async () => {
  scripts = [
    (res) => anthropicBlocks(res, [
      { type: 'text', text: 'Text A.' }, { type: 'thinking', text: 'Thinking X.' },
      { type: 'text', text: 'Text B.' }, { type: 'thinking', text: 'Thinking Y.' },
      { type: 'text', text: 'Text C.' }, { type: 'tool_use', name: 'read_file', input: { path: 'main.tex' } },
    ]),
    (res) => anthropicBlocks(res, [{ type: 'thinking', text: 'Thinking Z.' }, { type: 'text', text: 'Text D.' }]),
  ];
  const { events, steps, row } = await run({ provider: 'anthropic' });
  assert.deepEqual(steps.filter((s) => s.type !== 'workflow').map((s) => [s.type, s.text || s.name]), [
    ['text', 'Text A.'], ['model_thinking', 'Thinking X.'], ['text', 'Text B.'],
    ['model_thinking', 'Thinking Y.'], ['text', 'Text C.'], ['tool', 'read_file'],
    ['model_thinking', 'Thinking Z.'], ['text', 'Text D.'],
  ]);
  assert.equal(row.content, 'Text A.Text B.Text C.\n\nText D.');
  assert.deepEqual(events.filter((e) => ['token', 'model_thinking'].includes(e.type) && e.text).map((e) => [e.type, e.blockIndex, e.text]), [
    ['model_thinking', 1, 'Thinking X.'], ['model_thinking', 3, 'Thinking Y.'],
    ['token', 0, 'Text A.'], ['token', 2, 'Text B.'], ['token', 4, 'Text C.'],
    ['model_thinking', 0, 'Thinking Z.'], ['token', 1, 'Text D.'],
  ]);
  for (const step of steps.filter((s) => s.type === 'model_thinking')) assert.ok(Number.isInteger(step.durationMs) && step.durationMs >= 0);
});
