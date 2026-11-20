import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'corelatex-kimi-compat-'));
process.env.CORELATEX_DATA_DIR = dataDir;
let db, resetDb, runAgent, runSpecialistAgent, compressHistoryIfNeeded, toPiModel, completeSimple, convertMessages, llm, current, serial = 0;
const sse = value => `data: ${JSON.stringify(value)}\n\n`;
const textOf = message => typeof message.content === 'string' ? message.content
  : (message.content || []).filter(part => part.type === 'text').map(part => part.text).join('\n');

function reject(res, reason) {
  current.violations.push(reason);
  res.writeHead(400, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: reason, type: 'invalid_request_error' } }));
}

// This endpoint deliberately implements the stricter compatible-provider wire
// contract. A permissive mock would hide both the first-request role error and
// the second-request loss of a tool-calling assistant's original reasoning.
function handle(body, res) {
  current.requests.push(body);
  if (body.messages.some(message => message.role === 'developer'))
    return reject(res, 'Invalid request: role developer is not supported; use system.');
  if (body.messages[0]?.role !== 'system') return reject(res, 'Missing system prompt.');
  for (const message of body.messages) {
    if (message.role !== 'assistant' || !message.tool_calls?.length) continue;
    for (const call of message.tool_calls) {
      const expected = current.reasoning.get(call.id);
      if (!expected || message.reasoning_content !== expected)
        return reject(res, 'Missing or changed reasoning_content for the assistant tool call.');
    }
  }
  const n = current.requests.length;
  if (n > 6) return reject(res, 'Fixture request ceiling exceeded.');
  const reasoning = `KIMI_ORIGINAL_REASONING_${current.mode}_${n}: 逐项核对原文；保留空白。\nNext evidence.`;
  let tool;
  if (['coordinator', 'specialist'].includes(current.mode) && n <= 2)
    tool = { name: 'read_file', arguments: { path: 'main.tex' } };
  if (current.mode === 'specialist' && n === 3) tool = { name: 'submit_agent_report', arguments: {
    summary: '已读取 main.tex，两次读取内容一致。', verdict: 'pass', findings: [],
  } };
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  let output = sse({ choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: reasoning.slice(0, 19) } }] })
    + sse({ choices: [{ index: 0, delta: { reasoning_content: reasoning.slice(19) } }] });
  if (tool) {
    const id = `kimi_${current.mode}_${n}`;
    current.reasoning.set(id, reasoning);
    output += sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, type: 'function',
      function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] } }] });
  } else output += sse({ choices: [{ index: 0, delta: { content: current.mode === 'summary'
    ? 'KIMI_SUMMARY：保留先前目标与文件核查要求。' : 'KIMI_FINAL：main.tex 的两次读取内容一致。' } }] });
  output += sse({ choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }] })
    + sse({ choices: [], usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 } });
  res.end(output + 'data: [DONE]\n\n');
}

before(async () => {
  const database = await import('../src/db.js'); db = database.getDb(); resetDb = database.resetDb;
  ({ runAgent } = await import('../src/services/agent/agentLoop.js'));
  ({ runSpecialistAgent } = await import('../src/services/agent/specialistAgent.js'));
  ({ compressHistoryIfNeeded, toPiModel } = await import('../src/services/agent/context.js'));
  ({ completeSimple } = await import('@mariozechner/pi-ai'));
  ({ convertMessages } = await import('@mariozechner/pi-ai/openai-completions'));
  llm = http.createServer((req, res) => {
    let raw = ''; req.on('data', chunk => raw += chunk);
    req.on('end', () => {
      if (req.url !== '/v1/chat/completions') { res.writeHead(404).end(); return; }
      try { handle(JSON.parse(raw), res); }
      catch (error) { current.error = error; if (!res.headersSent) res.writeHead(500); res.end(); }
    });
  });
  await new Promise(resolve => llm.listen(0, '127.0.0.1', resolve));
});
after(async () => {
  llm?.closeAllConnections(); await new Promise(resolve => llm.close(resolve));
  resetDb(); fs.rmSync(dataDir, { recursive: true, force: true });
});

function fixture(mode) {
  current = { mode, requests: [], reasoning: new Map(), violations: [] };
  const n = ++serial;
  const uid = Number(db.prepare("INSERT INTO users(username,password_hash,role) VALUES(?,'unused','admin')")
    .run('kimi-owner-' + n).lastInsertRowid);
  db.prepare('INSERT INTO settings(user_id,agent_config,chinese_support) VALUES(?,?,0)')
    .run(uid, JSON.stringify({ graphOrchestration: false, allowWebAccess: false }));
  const pid = Number(db.prepare('INSERT INTO projects(name,owner_id,public_id) VALUES(?,?,?)')
    .run('Kimi compatibility', uid, 'kimi-fixture-' + n).lastInsertRowid);
  const cid = Number(db.prepare('INSERT INTO chats(project_id,user_id) VALUES(?,?)').run(pid, uid).lastInsertRowid);
  const projectDir = path.join(dataDir, 'projects', String(pid)); fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'main.tex'), 'KIMI_FILE_EVIDENCE\n');
  db.prepare("INSERT INTO chat_messages(chat_id,role,content) VALUES(?,'user','请读取 main.tex 并说明内容，无需修改。')").run(cid);
  return {
    db, user: db.prepare('SELECT * FROM users WHERE id=?').get(uid),
    project: db.prepare('SELECT * FROM projects WHERE id=?').get(pid),
    chat: db.prepare('SELECT * FROM chats WHERE id=?').get(cid), projectDir,
    messages: db.prepare('SELECT * FROM chat_messages WHERE chat_id=? ORDER BY id').all(cid),
    modelConfig: { id: 'kimi-fixture', provider: 'openai', model: 'k3-256k',
      baseUrl: `http://127.0.0.1:${llm.address().port}/v1`, apiKey: 'local-fixture',
      contextLength: 128000, maxTokens: 2048, temperature: 0.3, reasoningLevels: ['high'], reasoningEffort: 'high' },
  };
}

function assertWireContract(count, effort = 'high') {
  if (current.error) throw current.error;
  assert.deepEqual(current.violations, []);
  assert.equal(current.requests.length, count);
  for (const body of current.requests) {
    assert.equal(body.messages[0].role, 'system');
    assert.equal(body.messages.some(message => message.role === 'developer'), false);
    assert.equal(body.reasoning_effort, effort ?? undefined);
    assert.equal(body.thinking, undefined);
    assert.equal(body.temperature, undefined);
    assert.equal(body.max_tokens, undefined);
    assert.ok(Number.isSafeInteger(body.max_completion_tokens) && body.max_completion_tokens > 0);
  }
  if (count > 1) {
    const last = current.requests.at(-1);
    const replays = last.messages.filter(message => message.role === 'assistant' && message.tool_calls?.length);
    assert.equal(replays.length, 2, 'both earlier tool-calling turns must remain in the request');
    for (const message of replays) for (const call of message.tool_calls)
      assert.equal(message.reasoning_content, current.reasoning.get(call.id));
    assert.equal(last.messages.filter(message => message.role === 'tool' && textOf(message).includes('KIMI_FILE_EVIDENCE')).length, 2);
  }
}

test('Kimi coordinator sends system and preserves exact streamed reasoning through two real tool rounds', async () => {
  const f = fixture('coordinator'); const events = [];
  const result = await runAgent({ ...f, emit: event => events.push(event) });
  assertWireContract(3);
  assert.equal(result.status, 'completed');
  assert.match(db.prepare('SELECT content FROM chat_messages WHERE id=?').get(result.messageId).content, /KIMI_FINAL/);
  assert.equal(events.filter(event => event.type === 'tool' && event.name === 'read_file' && event.status === 'end').length, 2);
});

test('Kimi history compaction uses the same compatible system role and persists the returned summary', async () => {
  const f = fixture('summary');
  const insert = db.prepare('INSERT INTO chat_messages(chat_id,role,content) VALUES(?,?,?)');
  insert.run(f.chat.id, 'assistant', 'KIMI_OLD_DECISION');
  insert.run(f.chat.id, 'user', 'KIMI_CURRENT_REQUEST');
  const messages = db.prepare('SELECT * FROM chat_messages WHERE chat_id=? ORDER BY id').all(f.chat.id);
  const result = await compressHistoryIfNeeded({ ...f, messages, force: true, maxTokens: 2048 });
  assertWireContract(1);
  assert.equal(current.requests[0].tools, undefined);
  assert.match(JSON.stringify(current.requests[0].messages), /KIMI_OLD_DECISION/);
  assert.doesNotMatch(JSON.stringify(current.requests[0].messages), /KIMI_CURRENT_REQUEST/);
  assert.equal(result.compressed, true);
  assert.match(result.historySummary, /KIMI_SUMMARY/);
  assert.deepEqual(result.messages, [messages.at(-1)]);
  const saved = db.prepare('SELECT summary,summary_msg_id FROM chats WHERE id=?').get(f.chat.id);
  assert.equal(saved.summary, result.historySummary); assert.equal(saved.summary_msg_id, messages[1].id);
});

test('Kimi specialist uses system and retains each tool-turn reasoning before a real structured report', async () => {
  const f = fixture('specialist'); const events = [];
  const result = await runSpecialistAgent({
    task: { id: 'kimi-specialist', role: 'analyst', label: '核查', task: '读取 main.tex 并核对内容。', phase: 'analysis', scenario: 'answer' },
    ctx: { user: f.user, db, project: f.project, chatId: f.chat.id, projectDir: f.projectDir,
      workspaceDir: path.join(f.projectDir, '_workspace'), currentFile: 'main.tex',
      agentConfig: { allowWebAccess: false }, changesetBuffer: [], reads: new Map(), toolDisplays: new Map() },
    revision: 0, userRequest: '核对正文。', modelConfig: f.modelConfig, onEvent: event => events.push(event),
  });
  assertWireContract(3);
  assert.equal(result.report.verdict, 'pass'); assert.equal(result.toolCount, 2);
  assert.equal(events.filter(event => event.type === 'tool' && event.name === 'read_file' && event.status === 'end').length, 2);
  assert.equal(events.some(event => event.type === 'report'), true);
});

test('unconfigured K3 aliases still use system and native output limits without injecting reasoning or temperature', async () => {
  for (const model of ['k3.1-pro', 'k3.1-pro-highspeed']) {
    const f = fixture('unconfigured');
    const config = { ...f.modelConfig, model, reasoningLevels: undefined, reasoningEffort: undefined };
    const output = await completeSimple(toPiModel(config, config.maxTokens), {
      systemPrompt: '请简洁回答。', messages: [{ role: 'user', content: '确认接口。', timestamp: Date.now() }],
    }, { apiKey: config.apiKey, maxTokens: config.maxTokens, temperature: config.temperature, maxRetries: 0 });
    assert.equal(output.stopReason, 'stop', output.errorMessage);
    assertWireContract(1, null);
  }
});

test('a non-Kimi OpenAI-compatible endpoint also uses system when reasoning is configured', async () => {
  const f = fixture('generic');
  const config = { ...f.modelConfig, model: 'glm-fixture', reasoningLevels: ['low'], reasoningEffort: 'low' };
  const output = await completeSimple(toPiModel(config, config.maxTokens), {
    systemPrompt: '请简洁回答。', messages: [{ role: 'user', content: '确认通用兼容接口。', timestamp: Date.now() }],
  }, { apiKey: config.apiKey, maxTokens: config.maxTokens, temperature: config.temperature, maxRetries: 0 });
  assert.equal(output.stopReason, 'stop', output.errorMessage);
  assertWireContract(1, 'low');
});

test('native OpenAI keeps the SDK developer-role capability while other hosts receive system', () => {
  const f = fixture('native-profile');
  for (const baseUrl of [undefined, 'https://api.openai.com/v1']) {
    const model = toPiModel({ ...f.modelConfig, model: 'gpt-fixture', baseUrl });
    assert.notEqual(model.compat.supportsDeveloperRole, false);
    // OpenAI's native SDK capability defaults to true. Apply only the app's
    // override to that default, then exercise the SDK's real message converter.
    const messages = convertMessages(model, { systemPrompt: 'NATIVE_SYSTEM', messages: [] },
      { supportsDeveloperRole: true, ...model.compat });
    assert.equal(messages[0].role, 'developer');
    assert.equal(messages[0].content, 'NATIVE_SYSTEM');
  }
  const compatible = toPiModel({ ...f.modelConfig, model: 'gpt-fixture', baseUrl: 'https://api.openai.com.example.invalid/v1' });
  assert.equal(compatible.compat.supportsDeveloperRole, false);
});

test('Kimi K2.6 switch modes use thinking without reasoning_effort', async () => {
  for (const effort of ['enabled', 'disabled']) {
    const f = fixture('k2-switch');
    const config = { ...f.modelConfig, model: 'kimi-k2.6', reasoningLevels: ['enabled', 'disabled'], reasoningEffort: effort };
    const output = await completeSimple(toPiModel(config, config.maxTokens), {
      systemPrompt: '请简洁回答。', messages: [{ role: 'user', content: '确认思考模式。', timestamp: Date.now() }],
    }, { apiKey: config.apiKey, maxTokens: config.maxTokens, temperature: config.temperature, maxRetries: 0 });
    assert.equal(output.stopReason, 'stop', output.errorMessage);
    assert.deepEqual(current.violations, []); assert.equal(current.requests.length, 1);
    const body = current.requests[0];
    assert.equal(body.messages[0].role, 'system');
    assert.deepEqual(body.thinking, { type: effort });
    assert.equal(body.reasoning_effort, undefined); assert.equal(body.reasoning, undefined);
    assert.equal(body.temperature, undefined);
    assert.equal(body.max_tokens, 2048); assert.equal(body.max_completion_tokens, undefined);
  }
});

test('unsupported K2 strength and K3 medium are rejected locally instead of silently mapped', async () => {
  for (const [model, effort, message] of [['kimi-k2.6', 'high', /不支持 reasoning_effort/],
    ['k3-256k', 'medium', /Kimi K3.*low.*high.*max/]]) {
    const f = fixture('unsupported');
    const config = { ...f.modelConfig, model, reasoningLevels: [effort], reasoningEffort: effort };
    await assert.rejects(async () => completeSimple(toPiModel(config, config.maxTokens), {
      systemPrompt: '请简洁回答。', messages: [{ role: 'user', content: '确认模式。', timestamp: Date.now() }],
    }, { apiKey: config.apiKey, maxTokens: config.maxTokens, maxRetries: 0 }), message);
    assert.equal(current.requests.length, 0);
  }
});

test('OpenRouter keeps its nested reasoning protocol for routed Kimi models without sending a network request', async (t) => {
  let networkCalls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    networkCalls++;
    throw new Error('Unexpected network request in payload-only fixture');
  });
  for (const [model, effort] of [['moonshotai/kimi-k2.5', 'high'], ['moonshotai/k3-256k', 'max']]) {
    const f = fixture('openrouter'); let captured;
    const config = { ...f.modelConfig, model, baseUrl: 'https://openrouter.ai/api/v1',
      reasoningLevels: [effort], reasoningEffort: effort };
    const output = await completeSimple(toPiModel(config, config.maxTokens), {
      systemPrompt: '请简洁回答。', messages: [{ role: 'user', content: '确认聚合接口格式。', timestamp: Date.now() }],
    }, { apiKey: config.apiKey, maxTokens: config.maxTokens, maxRetries: 0,
      onPayload: payload => {
        captured = structuredClone(payload);
        throw new Error('OPENROUTER_PAYLOAD_CAPTURED_NETWORK_FORBIDDEN');
      },
    });
    assert.equal(output.stopReason, 'error');
    assert.match(output.errorMessage, /OPENROUTER_PAYLOAD_CAPTURED_NETWORK_FORBIDDEN/);
    assert.ok(captured, 'the routed model reaches payload creation instead of being rejected as native Kimi');
    assert.equal(captured.reasoning.effort, effort);
    assert.equal(captured.reasoning_effort, undefined); assert.equal(captured.thinking, undefined);
    assert.equal(captured.messages[0].role, 'system');
    assert.equal(captured.messages.some(message => message.role === 'developer'), false);
  }
  assert.equal(networkCalls, 0);
});
