import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { startTestServer, api, registerAndLogin } from './helpers.js';
import { resolveModelConfig, resolveSubagentModelConfig } from '../src/services/agent/models.js';

let srv, db, user, runAgent, gateway, providers, mode, requests, controller;
const mainKey = 'fixture-main-private-9812', workerKey = 'fixture-worker-private-3187';
const textOf = m => typeof m.content === 'string' ? m.content : (m.content || []).filter(p => p.type === 'text').map(p => p.text).join('\n');
const assignment = payload => payload.messages.flatMap(m => {
  try { const job = JSON.parse(textOf(m)); return job.assignment ? [job] : []; } catch { return []; }
})[0];
const row = () => db.prepare('SELECT * FROM settings WHERE user_id=?').get(user.user.id);
const save = body => api(srv.baseUrl, 'PUT', '/api/settings/ai', { token: user.token, body });
const load = () => api(srv.baseUrl, 'GET', '/api/settings/ai', { token: user.token });
function respond(res, payload, name, args, text = '') {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  if (payload.model === 'worker-anthropic') {
    const event = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
    res.end(event('message_start', { message: { id: 'msg_test', type: 'message', role: 'assistant', model: payload.model, content: [],
      usage: { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 17, cache_creation_input_tokens: 9 } } }) +
      event('content_block_start', { index: 0, content_block: name ? { type: 'tool_use', id: 'tool_' + requests.length, name, input: {} } : { type: 'text', text: '' } }) +
      event('content_block_delta', { index: 0, delta: name ? { type: 'input_json_delta', partial_json: JSON.stringify(args) } : { type: 'text_delta', text } }) +
      event('content_block_stop', { index: 0 }) + event('message_delta', { delta: { stop_reason: name ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }) + event('message_stop', {}));
  } else {
    const sse = value => 'data: ' + JSON.stringify({ choices: [{ index: 0, ...value }] }) + '\n\n';
    res.end(sse({ delta: name ? { tool_calls: [{ index: 0, id: 'call_' + requests.length, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } : { content: text } }) +
      sse({ delta: {}, finish_reason: name ? 'tool_calls' : 'stop' }) + 'data: [DONE]\n\n');
  }
}
before(async () => {
  srv = await startTestServer();
  db = (await import('../src/db.js')).getDb();
  ({ runAgent } = await import('../src/services/agent/agentLoop.js'));
  user = await registerAndLogin(srv.baseUrl, 'worker-config');
  gateway = http.createServer((req, res) => {
    let raw = ''; req.on('data', c => raw += c); req.on('end', () => {
      const payload = JSON.parse(raw), job = assignment(payload);
      requests.push({ payload, job, headers: req.headers, path: req.url });
      if (requests.length > 45) { controller.abort(new Error('fixture exceeded request limit')); res.end(); return; }
      const calls = payload.messages.filter(m => m.role === 'assistant').flatMap(m => [
        ...(m.tool_calls || []).map(c => ({ name: c.function.name, args: JSON.parse(c.function.arguments) })),
        ...(Array.isArray(m.content) ? m.content.filter(c => c.type === 'tool_use').map(c => ({ name: c.name, args: c.input })) : []),
      ]);
      const count = name => calls.filter(c => c.name === name).length;
      const call = (name, args) => respond(res, payload, name, args);
      if (job) {
        if (mode === 'worker-error') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'invalid fixture key ' + workerKey + ' and ' + mainKey } })); return;
        }
        const target = job.assignment.role === 'editor' ? job.assignment.scope[0].path : 'notes.txt';
        if (!count('read_file')) return call('read_file', { path: target });
        if (job.assignment.role === 'editor' && !count('edit_file')) return call('edit_file', { path: target, search: 'Original.', replace: 'Revised.' });
        return call('submit_agent_report', { verdict: 'pass', summary: mode === 'report-secret' ? '核查完成 ' + mainKey + ' ' + workerKey : '已按实际内容完成核查。', findings: [] });
      }
      if (!count('plan_task_graph')) return call('plan_task_graph', { scenario: mode === 'parallel' ? 'edit' : 'answer', summary: '核查本地内容。', agents: ['analyst', 'researcher', 'reviewer', 'verifier'] });
      const phases = calls.filter(c => c.name === 'run_agent_graph').map(c => c.args.phase);
      if (!phases.includes('analysis')) return call('run_agent_graph', { phase: 'analysis' });
      if (mode === 'worker-error') return respond(res, payload, null, null, '子智能体模型请求失败，未完成核查。');
      if (mode === 'parallel') {
        const unread = ['notes.txt', 'extra.txt'].find(file => !calls.some(c => c.name === 'read_file' && c.args.path === file));
        if (unread) return call('read_file', { path: unread });
        if (!count('run_parallel_edits')) return call('run_parallel_edits', { tasks: ['notes.txt', 'extra.txt'].map((file, i) => ({ id: 'edit-' + i, task: '将 Original. 改为 Revised.，其余不变。', scope: [{ path: file }] })) });
      }
      if (!phases.includes('review')) return call('run_agent_graph', { phase: 'review' });
      return respond(res, payload, null, null, mode === 'parallel' ? '已修改 notes.txt 和 extra.txt。' : '核查已完成。');
    });
  });
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  const baseUrl = 'http://127.0.0.1:' + gateway.address().port + '/v1';
  providers = [
    { id: 'main-provider', name: 'Main', apiFormat: 'openai', baseUrl, apiKey: mainKey, enabled: true,
      models: [{ id: 'main', model: 'main-openai', name: 'Main', enabled: true, contextLength: 100000, maxTokens: 2048, reasoningLevels: ['low', 'medium', 'high'] }] },
    { id: 'worker-provider', name: 'Worker', apiFormat: 'anthropic', baseUrl, apiKey: workerKey, enabled: true,
      models: [{ id: 'worker', model: 'worker-anthropic', name: 'Worker', enabled: true, contextLength: 120000, maxTokens: 4096, reasoningLevels: ['low', 'high'] }] },
  ];
});
after(async () => { gateway.closeAllConnections(); await new Promise(resolve => gateway.close(resolve)); await srv.close(); });

async function configure(agentConfig = {}) {
  const result = await save({ providers, activeModelId: 'main', chineseSupport: false,
    agentConfig: { graphOrchestration: true, allowWebAccess: false, subagentModelId: '', subagentReasoningEffort: '', ...agentConfig } });
  assert.equal(result.status, 200, JSON.stringify(result.data));
}
async function run(scenario) {
  mode = scenario; requests = []; controller = new AbortController();
  const pid = Number(db.prepare('INSERT INTO projects(name,owner_id,public_id) VALUES(?,?,?)').run('Worker fixture', user.user.id, randomUUID()).lastInsertRowid);
  const cid = Number(db.prepare('INSERT INTO chats(project_id,user_id) VALUES(?,?)').run(pid, user.user.id).lastInsertRowid);
  const directory = path.join(srv.dataDir, 'projects', String(pid)); fs.mkdirSync(directory, { recursive: true });
  for (const file of ['notes.txt', 'extra.txt']) fs.writeFileSync(path.join(directory, file), 'Original.\n');
  const events = [];
  const result = await runAgent({ user: db.prepare('SELECT * FROM users WHERE id=?').get(user.user.id),
    project: db.prepare('SELECT * FROM projects WHERE id=?').get(pid), chat: db.prepare('SELECT * FROM chats WHERE id=?').get(cid),
    messages: [{ role: 'user', content: mode === 'parallel' ? '修改这两个文本文件。' : '核查这些文本。' }], modelConfig: resolveModelConfig(row(), 'main', 'high'),
    signal: controller.signal, emit: event => events.push(event) });
  const message = db.prepare('SELECT * FROM chat_messages WHERE id=?').get(result.messageId);
  const usage = db.prepare('SELECT * FROM ai_usage WHERE chat_id = ? ORDER BY id').all(cid);
  return { result, events, message, usage };
}

test('worker preferences round-trip, retain secrets server-side and resolve provider capabilities independently', async () => {
  await configure({ subagentModelId: 'worker', subagentReasoningEffort: 'high' });
  const { data } = await load();
  assert.equal(data.agentConfig.subagentModelId, 'worker'); assert.equal(data.agentConfig.subagentReasoningEffort, 'high');
  assert.ok(!JSON.stringify(data).includes(workerKey));
  const primary = resolveModelConfig(row(), 'main', 'medium'), worker = resolveSubagentModelConfig(row(), primary);
  assert.equal(worker.provider, 'anthropic'); assert.equal(worker.apiKey, workerKey); assert.equal(worker.reasoningEffort, 'high');
  assert.equal(worker.contextLength, 120000); assert.equal(worker.maxTokens, 4096); assert.equal(primary.model, 'main-openai');
});
test('automatic worker effort inherits the actual request or uses the fixed model default', async () => {
  await configure();
  const primary = resolveModelConfig(row(), 'main', 'high');
  assert.equal(resolveSubagentModelConfig(row(), primary).reasoningEffort, 'high');
  await configure({ subagentReasoningEffort: 'low' });
  assert.equal(resolveSubagentModelConfig(row(), primary).reasoningEffort, 'low');
  assert.throws(() => resolveSubagentModelConfig(row(), { ...primary, reasoningLevels: ['medium'], reasoningEffort: 'medium' }), /子智能体.*思考强度/);
  await configure({ subagentModelId: 'worker' });
  assert.equal(resolveSubagentModelConfig(row(), primary).reasoningEffort, 'low');
});
test('invalid, disabled and removed worker selections are rejected atomically, explicit reset restores deletion', async () => {
  await configure({ subagentModelId: 'worker', subagentReasoningEffort: 'high' });
  const before = row();
  for (const agentConfig of [{ subagentModelId: null }, { subagentModelId: [] }, { subagentModelId: 'missing' },
    { subagentReasoningEffort: 1 }, { subagentReasoningEffort: 'unsupported' }]) assert.equal((await save({ agentConfig })).status, 400);
  assert.equal(row().agent_config, before.agent_config);
  const disabled = structuredClone(providers); disabled[1].enabled = false;
  assert.equal((await save({ providers: disabled })).status, 400);
  assert.equal((await save({ providers: [providers[0]] })).status, 400);
  assert.equal(row().ai_providers, before.ai_providers);
  assert.equal((await save({ providers: [providers[0]], agentConfig: { subagentModelId: '', subagentReasoningEffort: '' } })).status, 200);
});
test('every read-only specialist uses the chosen provider and effort while main requests remain unchanged', async () => {
  await configure({ subagentModelId: 'worker', subagentReasoningEffort: 'high' });
  const f = await run('normal'); assert.equal(f.result.status, 'completed');
  const children = requests.filter(r => r.job), primary = requests.filter(r => !r.job);
  assert.deepEqual([...new Set(children.map(r => r.job.assignment.role))].sort(), ['analyst', 'researcher', 'reviewer', 'verifier']);
  for (const request of children) {
    assert.equal(request.payload.model, 'worker-anthropic'); assert.equal(request.headers['x-api-key'], workerKey);
    assert.equal(request.payload.output_config?.effort, 'high'); assert.equal(request.payload.max_tokens, 4096);
    assert.equal(request.path, '/v1/messages');
  }
  for (const request of primary) {
    assert.equal(request.payload.model, 'main-openai'); assert.equal(request.headers.authorization, 'Bearer ' + mainKey);
    assert.equal(request.payload.reasoning_effort, 'high');
  }
  const workerUsage = f.usage.filter(row => row.provider_id === 'worker-provider');
  const primaryUsage = f.usage.filter(row => row.provider_id === 'main-provider');
  assert.equal(f.usage.length, requests.length);
  assert.equal(workerUsage.length, children.length);
  assert.equal(primaryUsage.length, primary.length);
  for (const row of workerUsage) {
    assert.equal(row.model, 'worker-anthropic'); assert.equal(row.provider, 'anthropic');
    assert.notEqual(row.owner, 'coordinator');
    assert.deepEqual([row.input_tokens, row.output_tokens, row.cache_read_tokens, row.cache_write_tokens], [31, 5, 17, 9]);
  }
  assert.ok(primaryUsage.every(row => row.owner === 'coordinator' && row.model === 'main-openai' && row.usage_status === 'unknown'));
});
test('parallel editor workers use the same explicit subagent configuration', async () => {
  await configure({ subagentModelId: 'worker', subagentReasoningEffort: 'low' });
  const f = await run('parallel'); assert.equal(f.result.status, 'completed');
  const editors = requests.filter(r => r.job?.assignment.role === 'editor'); assert.ok(editors.length >= 6);
  assert.ok(editors.every(r => r.payload.model === 'worker-anthropic' && r.payload.output_config?.effort === 'low'));
});
test('both provider keys are redacted from worker tool events, persisted reports and parent context', async () => {
  await configure({ subagentModelId: 'worker' });
  const f = await run('report-secret'); assert.equal(f.result.status, 'completed');
  const output = JSON.stringify({ events: f.events, message: f.message, primaryPayloads: requests.filter(r => !r.job).map(r => r.payload) });
  assert.ok(!output.includes(mainKey)); assert.ok(!output.includes(workerKey)); assert.match(output, /密钥已隐藏/);
});
test('provider failures remain failed and redact both provider keys from delivery and history', async () => {
  await configure({ subagentModelId: 'worker' });
  const f = await run('worker-error'); assert.equal(f.result.status, 'failed');
  const output = JSON.stringify({ events: f.events, message: f.message });
  assert.ok(!output.includes(mainKey)); assert.ok(!output.includes(workerKey)); assert.match(output, /密钥已隐藏/);
});
