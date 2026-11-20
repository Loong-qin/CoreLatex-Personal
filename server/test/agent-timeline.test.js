import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'corelatex-agent-timeline-'));
process.env.CORELATEX_DATA_DIR = dataDir;
let dbModule;
let db;
let runAgent;
let pruneContextImages;
let llm;
let mode = 'timeline';
let requests = 0;
let wireRequests = [];
let owner;
let onAbortChunk;
const sse = (data) => 'data: ' + JSON.stringify(data) + '\n\n';
const chunk = (delta, finishReason = null) => sse({
  choices: [{ index: 0, delta, finish_reason: finishReason }],
});
const finish = (reason, input, output, usage = {}) => chunk({}, reason)
  + sse({ model: 'gpt-mock-routed', choices: [], usage: { prompt_tokens: input, completion_tokens: output, ...usage } })
  + 'data: [DONE]\n\n';

before(async () => {
  dbModule = await import('../src/db.js');
  db = dbModule.getDb();
  ({ runAgent, pruneContextImages } = await import('../src/services/agent/agentLoop.js'));
  const id = Number(db.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'admin')")
    .run('timeline-owner', 'unused-test-hash').lastInsertRowid);
  owner = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  db.prepare('INSERT INTO settings (user_id) VALUES (?)').run(id);
  llm = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      requests++;
      const body = JSON.parse(raw);
      wireRequests.push(body);
      if (mode === 'secret-error') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: '401 rejected credential test-only' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (mode === 'image-once') {
        res.end(chunk({ role: 'assistant', content: 'I can inspect the attachment.' }) + finish('stop', 11, 4));
        return;
      }
      if (mode === 'abort') {
        res.write(chunk({ role: 'assistant', content: 'Unapproved partial text.' }), () => onAbortChunk?.());
        return; // The client deliberately aborts this unfinished stream.
      }
      if (mode.startsWith('failed-edit')) {
        const calls = body.messages.filter((m) => m.role === 'assistant').flatMap((m) => m.tool_calls || []);
        // Establish project context without reading the target, so this test
        // exercises edit_file's read-before-edit guard rather than workflow setup.
        if (!calls.some((c) => c.function.name === 'list_files')) {
          res.end(chunk({ tool_calls: [{ index: 0, id: 'list_context', type: 'function',
            function: { name: 'list_files', arguments: '{}' } }] }) + finish('tool_calls', 7, 3));
          return;
        }
        const corrected = body.messages.some((m) => m.role === 'user'
          && typeof m.content === 'string' && m.content.includes('【系统核对'));
        if (corrected && mode === 'failed-edit-corrected') {
          res.end(chunk({ role: 'assistant', content: '本轮尚未执行修改，编辑未通过先读检查。' }) + finish('stop', 11, 4));
        } else if (calls.some((c) => c.function.name === 'edit_file')) {
          // The tool failed, but this deliberately unreliable model still claims completion.
          res.end(chunk({ role: 'assistant', content: '已完成编辑，请审核。' }) + finish('stop', 11, 4));
        } else {
          res.end(chunk({ tool_calls: [{
            index: 0, id: 'failed_edit_1', type: 'function',
            function: { name: 'edit_file', arguments: JSON.stringify({
              path: 'main.tex', search: 'A real file.', replace: 'Changed without reading.',
            }) },
          }] }) + finish('tool_calls', 7, 3));
        }
        return;
      }
      if (body.messages.some((m) => m.role === 'tool')) {
        res.end(chunk({ role: 'assistant', content: 'Checked the file.' }) + finish('stop', 11, 4,
          { prompt_tokens_details: { cached_tokens: 8, cache_write_tokens: 3 }, completion_tokens_details: { reasoning_tokens: 2 } }));
      } else {
        const narrative = mode === 'silent-tool' ? '' : chunk({ role: 'assistant', content: 'Checking first.' });
        res.end(narrative
          + chunk({ tool_calls: [{
            index: 0, id: 'read_1', type: 'function',
            function: { name: 'read_file', arguments: JSON.stringify({ path: 'main.tex' }) },
          }] })
          + finish('tool_calls', 7, 3, { prompt_cache_hit_tokens: 4 }));
      }
    });
  });
  await new Promise((resolve) => llm.listen(0, '127.0.0.1', resolve));
});

after(async () => {
  llm?.closeAllConnections();
  if (llm) await new Promise((resolve) => llm.close(resolve));
  dbModule?.resetDb();
  assert.ok(dataDir.startsWith(path.join(os.tmpdir(), 'corelatex-agent-timeline-')));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function fixture() {
  const id = Number(db.prepare('INSERT INTO projects (name, owner_id, public_id) VALUES (?, ?, ?)')
    .run('timeline', owner.id, randomUUID()).lastInsertRowid);
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  const dir = path.join(dataDir, 'projects', String(id));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'main.tex'), 'A real file.\n');
  const chatId = Number(db.prepare('INSERT INTO chats (project_id, user_id) VALUES (?, ?)')
    .run(id, owner.id).lastInsertRowid);
  return { project, chat: db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId) };
}

async function run(f, emit = () => {}, signal, messages = [{ role: 'user', content: 'Inspect the file.' }]) {
  return runAgent({
    user: owner,
    ...f,
    messages,
    modelConfig: {
      provider: 'openai', providerId: 'timeline-provider', model: 'gpt-mock', apiKey: 'test-only',
      baseUrl: 'http://127.0.0.1:' + llm.address().port + '/v1',
      maxTokens: 512, contextLength: 100000,
    },
    emit,
    signal,
  });
}

function message(id) {
  const row = db.prepare('SELECT * FROM chat_messages WHERE id = ?').get(id);
  return { ...row, steps: JSON.parse(row.steps), calls: JSON.parse(row.tool_calls) };
}

test('assistant text is recorded before its tools, once per message; usage is counted once', async () => {
  mode = 'timeline';
  requests = 0;
  const f = fixture();
  const result = await run(f);
  const row = message(result.messageId);
  assert.deepEqual(row.steps.filter((s) => !['activity', 'workflow'].includes(s.type)).map((s) => s.type), ['text', 'tool', 'text']);
  assert.equal(row.steps.filter((s) => s.type === 'workflow').length, 1, 'standard workflow retains one current snapshot');
  assert.equal(row.steps.find((s) => s.type === 'workflow').graph.status, 'completed');
  assert.equal(row.content, 'Checking first.\n\nChecked the file.');
  assert.deepEqual(row.steps.filter((s) => s.type === 'text').map((s) => s.text),
    ['Checking first.', 'Checked the file.']);
  assert.equal(row.calls.length, 1);
  assert.equal(requests, 2, 'No duplicate completion checks or message recording');
  const usage = db.prepare('SELECT * FROM ai_usage WHERE chat_id = ? ORDER BY id').all(f.chat.id);
  assert.deepEqual(usage.map(r => [r.input_tokens, r.output_tokens, r.cache_read_tokens, r.cache_write_tokens]),
    [[7, 3, 4, 0], [11, 4, 5, 3]]);
  assert.ok(usage.every(r => r.user_id === owner.id && r.project_id === f.project.id && r.usage_status === 'reported'));
  assert.ok(usage.every(r => r.provider_id === 'timeline-provider' && r.model === 'gpt-mock-routed' && r.requested_model === 'gpt-mock'));
  assert.equal(new Set(usage.map(r => r.request_key)).size, requests);
});

test('messages without leading narration do not inherit text from a prior message', async () => {
  mode = 'silent-tool';
  const result = await run(fixture());
  const row = message(result.messageId);
  assert.deepEqual(row.steps.filter((s) => !['activity', 'workflow'].includes(s.type)).map((s) => s.type), ['tool', 'text']);
  assert.equal(row.content, 'Checked the file.');
});

test('unfinished text remains private when cancelled; the actual stop is saved once', { timeout: 10000 }, async () => {
  mode = 'abort';
  const f = fixture();
  const ac = new AbortController();
  const events = [];
  const written = new Promise(resolve => { onAbortChunk = resolve; });
  const running = run(f, event => events.push(event), ac.signal);
  await written;
  await new Promise(resolve => setTimeout(resolve, 25));
  ac.abort();
  const result = await running;
  onAbortChunk = null;
  const row = message(result.messageId);
  assert.equal(result.status, 'cancelled');
  assert.ok(!JSON.stringify(events).includes('Unapproved partial text.'));
  assert.ok(!row.content.includes('Unapproved partial text.'));
  assert.ok(!JSON.stringify(row.steps).includes('Unapproved partial text.'));
  assert.match(row.content, /已手动停止/);
  assert.equal(row.steps.filter(step => step.type === 'text' && step.text.includes('已手动停止')).length, 1);
  assert.deepEqual(db.prepare('SELECT status, usage_status FROM ai_usage WHERE chat_id = ?').all(f.chat.id),
    [{ status: 'aborted', usage_status: 'unknown' }]);
});

test('a rejected edit remains a failure and completion claims trigger correction', async () => {
  mode = 'failed-edit-corrected';
  requests = 0;
  wireRequests = [];
  const f = fixture();
  const events = [];
  const result = await run(f, (event) => events.push(event));
  const row = message(result.messageId);
  assert.deepEqual(row.calls.map((c) => c.name), ['list_files', 'edit_file']);
  assert.match(row.calls[1].result, /请先用 read_file/);
  const toolResult = wireRequests.flatMap((body) => body.messages).find((m) => m.role === 'tool' && m.tool_call_id === 'failed_edit_1');
  assert.ok(toolResult, 'The failed tool result must still reach the model');
  assert.match(toolResult.content, /请先用 read_file/);
  assert.equal(events.filter((event) => event.type === 'activity' && event.code === 'EXECUTION_CLAIM_UNSUPPORTED').length, 1,
    'A failed edit must not count toward successfulEdits');
  assert.equal(events.some(event => event.type === 'status' && /已拦截/.test(event.text)), false,
    'Unpublished candidate text does not emit a premature accusation while streaming');
  assert.equal(requests, 4, 'Context discovery, failed edit, false summary and one correction');
  assert.equal(result.changeset, null);
  assert.equal(events.some((event) => event.type === 'changeset'), false);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM changesets WHERE project_id = ?').get(f.project.id).n, 0);
  assert.equal(fs.readFileSync(path.join(dataDir, 'projects', String(f.project.id), 'main.tex'), 'utf8'), 'A real file.\n');
  assert.equal(row.steps[row.steps.length - 1].text, '本轮尚未执行修改，编辑未通过先读检查。');
  assert.ok(row.content.endsWith('本轮尚未执行修改，编辑未通过先读检查。'));
});

test('repeated completion claims after a failed edit end with an explicit system warning', async () => {
  mode = 'failed-edit-stubborn';
  requests = 0;
  wireRequests = [];
  const f = fixture();
  const events = [];
  const result = await run(f, (event) => events.push(event));
  const row = message(result.messageId);
  assert.deepEqual(row.calls.map((c) => c.name), ['list_files', 'edit_file']);
  assert.match(row.calls[1].result, /请先用 read_file/);
  assert.equal(events.filter((event) => event.type === 'activity' && event.phase === 'verification').length, 1);
  assert.equal(requests, 4, 'Context discovery, one failed edit, one false summary, and only one automatic correction');
  assert.equal(result.status, 'failed');
  assert.doesNotMatch(row.content, /已完成编辑，请审核/);
  assert.equal(result.changeset, null);
  assert.equal(events.some((event) => event.type === 'changeset'), false);
  assert.equal(fs.readFileSync(path.join(dataDir, 'projects', String(f.project.id), 'main.tex'), 'utf8'), 'A real file.\n');
  assert.match(row.steps[row.steps.length - 1].text, /系统核对未通过.*已停止自动重试/);
  assert.match(row.content, /没有可提交的有效修改，未生成审核项/);
});

test('the image soft budget retains a sole current image larger than the budget', () => {
  const data = 'A'.repeat(400 * 1024);
  const input = [{ role: 'user', content: [
    { type: 'text', text: 'Inspect the current image.' },
    { type: 'image', mimeType: 'image/png', data },
  ] }];
  const snapshot = structuredClone(input);
  const out = pruneContextImages(input, { byteBudget: 384 * 1024 });
  assert.equal(out[0].content.find((p) => p.type === 'image').data, data);
  assert.deepEqual(input, snapshot);
});

test('the image budget drops oldest images first without mutating messages or content arrays', () => {
  const input = [
    { role: 'user', content: [{ type: 'image', mimeType: 'image/png', data: 'OLD_0000' }] },
    { role: 'toolResult', toolCallId: 'preview', content: [
      { type: 'text', text: 'Keep this preview description.' },
      { type: 'image', mimeType: 'image/png', data: 'MID_0000' },
      { type: 'image', mimeType: 'image/png', data: 'NEW_0000' },
    ] },
  ];
  const snapshot = structuredClone(input);
  const out = pruneContextImages(input, { byteBudget: 10 });
  assert.deepEqual(out.flatMap((m) => m.content).filter((p) => p.type === 'image').map((p) => p.data), ['NEW_0000']);
  assert.equal(out[1].content[0].text, 'Keep this preview description.');
  assert.equal(out[1].toolCallId, 'preview');
  assert.deepEqual(input, snapshot);
  assert.notEqual(out[0], input[0]);
  assert.notEqual(out[1].content, input[1].content);
});

test('latest-message pruning preserves all images in the latest result and keeps the original history intact', () => {
  const input = [
    { role: 'user', content: [{ type: 'image', mimeType: 'image/png', data: 'OLD' }] },
    { role: 'toolResult', content: [
      { type: 'image', mimeType: 'image/png', data: 'PAGE_ONE' },
      { type: 'image', mimeType: 'image/png', data: 'PAGE_TWO' },
    ] },
    { role: 'user', content: 'Compare the current pages.' },
  ];
  const snapshot = structuredClone(input);
  const out = pruneContextImages(input, { latestMessageOnly: true });
  assert.equal(out[0].content[0].type, 'text');
  assert.deepEqual(out[1].content.map((p) => p.data), ['PAGE_ONE', 'PAGE_TWO']);
  assert.deepEqual(input, snapshot);
});

test('a sole over-budget user attachment actually reaches the first mock model request', async () => {
  mode = 'image-once';
  requests = 0;
  wireRequests = [];
  const data = 'A'.repeat(400 * 1024); // Synthetic transport payload; the mock does not decode pixels.
  const messages = [{ role: 'user', content: [
    { type: 'text', text: 'Inspect this attachment.' },
    { type: 'image', mimeType: 'image/png', data },
  ] }];
  const snapshot = structuredClone(messages);
  const result = await run(fixture(), undefined, undefined, messages);
  assert.equal(requests, 1);
  const image = wireRequests[0].messages.flatMap((m) => Array.isArray(m.content) ? m.content : [])
    .find((p) => p.type === 'image_url');
  assert.ok(image, 'The first model request must retain the current visual input');
  assert.equal(image.image_url.url, 'data:image/png;base64,' + data);
  assert.deepEqual(messages, snapshot, 'Preparing the request cannot rewrite the original attachment');
  assert.equal(message(result.messageId).content, 'I can inspect the attachment.');
});


test('gateway credential echoes are redacted from visible errors and stored history', async () => {
  mode = 'secret-error';
  const f = fixture();
  const events = [];
  const result = await run(f, (event) => events.push(event));
  assert.equal(result.status, 'failed');
  assert.equal(JSON.stringify(events).includes('test-only'), false);
  const row = message(result.messageId);
  assert.equal(row.content.includes('test-only'), false);
  assert.match(row.content, /密钥已隐藏/);
});
