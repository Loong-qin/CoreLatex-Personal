import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { api, registerAndLogin, startTestServer } from './helpers.js';

const defaultId = 'default';
const selections = [
  { id: 'alpha', effort: 'low', reasoningLevels: ['low', 'medium'], contextLength: 64000, inputTokens: 120 },
  { id: 'beta', effort: 'high', reasoningLevels: ['medium', 'high'], contextLength: 96000, inputTokens: 240 },
];
const providerId = id => `provider-${id}`;
const upstreamModel = id => `fixture-model-${id}`;
const fixtureKey = id => `fixture-key-${id}`;
const marker = id => `isolation-fixture-${id}`;
const requests = [];
let server, gateway, owner, db, cancelRun, providers, heldRequests;

const settings = (method = 'GET', body) => api(server.baseUrl, method, '/api/settings/ai', { token: owner.token, body });
const call = (project, method, suffix, body, raw) => api(server.baseUrl, method, `/api/projects/${project.publicId}${suffix}`,
  { token: owner.token, body, raw });

async function createProject(name) {
  const result = await api(server.baseUrl, 'POST', '/api/projects', { token: owner.token, body: { name } });
  assert.equal(result.status, 201);
  return result.data.project;
}

async function readEvents(response) {
  assert.equal(response.status, 200);
  return (await response.text()).split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
}

function reply(res, payload, selection, worker, requestNumber) {
  const sentTools = payload.messages.flatMap(message => (message.tool_calls ?? []).map(tool => tool.function.name));
  let toolName, args;
  if (worker) {
    toolName = 'submit_agent_report';
    args = { summary: '可以给出简短说明。', verdict: 'pass', findings: [] };
  } else if (selection && !sentTools.includes('plan_task_graph')) {
    toolName = 'plan_task_graph';
    args = { scenario: 'answer', summary: '准备简短说明。', agents: ['analyst'] };
  } else if (selection && !sentTools.includes('run_agent_graph')) {
    toolName = 'run_agent_graph';
    args = { phase: 'analysis' };
  }
  const delta = toolName ? { tool_calls: [{ index: 0, id: `call_${requestNumber}`, type: 'function',
    function: { name: toolName, arguments: JSON.stringify(args) } }] } : { content: '简短说明。' };
  const sse = value => `data: ${JSON.stringify(value)}\n\n`;
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.end(sse({ choices: [{ index: 0, delta }] }) +
    sse({ choices: [{ index: 0, delta: {}, finish_reason: toolName ? 'tool_calls' : 'stop' }] }) +
    sse({ choices: [], usage: { prompt_tokens: worker ? 500 : selection?.inputTokens ?? 100, completion_tokens: 5 } }) +
    'data: [DONE]\n\n');
}

before(async () => {
  server = await startTestServer();
  db = (await import('../src/db.js')).getDb();
  ({ cancelRun } = await import('../src/services/agent/runs.js'));
  owner = await registerAndLogin(server.baseUrl, 'model-isolation-owner');
  gateway = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => raw += chunk);
    req.on('end', () => {
      const payload = JSON.parse(raw);
      const messages = JSON.stringify(payload.messages);
      const selection = selections.find(({ id }) => messages.includes(marker(id)));
      const worker = payload.tools?.some(tool => tool.function.name === 'submit_agent_report') ?? false;
      const requestNumber = requests.push({ id: selection?.id, worker, model: payload.model,
        effort: payload.reasoning_effort, path: req.url, authorization: req.headers.authorization });
      const gate = !worker && heldRequests?.get(selection?.id);
      if (!gate) return reply(res, payload, selection, worker, requestNumber);
      heldRequests.delete(selection.id);
      gate.arrived.resolve();
      void gate.release.promise.then(() => {
        if (gate.retry) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Temporary fixture failure' } }));
        } else reply(res, payload, selection, worker, requestNumber);
      });
    });
  });
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  providers = [{ id: defaultId, contextLength: 48000, reasoningLevels: ['medium'] }, ...selections]
    .map(({ id, contextLength, reasoningLevels }) => ({
      id: providerId(id), name: id, apiFormat: 'openai', apiKey: fixtureKey(id),
      baseUrl: `http://127.0.0.1:${gateway.address().port}/${id}/v1`,
      models: [{ id, model: upstreamModel(id), contextLength, maxTokens: 2048, reasoningLevels }],
    }));
  providers[0].models.push({ id: 'disabled', model: upstreamModel('disabled'), enabled: false });
});

beforeEach(async () => {
  requests.length = 0;
  const saved = await settings('PUT', { providers, activeModelId: defaultId,
    agentConfig: { collaborationTier: 'full', allowWebAccess: false, subagentModelId: '', subagentReasoningEffort: '' } });
  assert.equal(saved.status, 200);
});

after(async () => {
  for (const { id } of db.prepare("SELECT id FROM agent_runs WHERE state IN ('running','waiting_for_user','cancelling')").all()) {
    await cancelRun(id);
  }
  gateway.closeAllConnections();
  await new Promise(resolve => gateway.close(resolve));
  server.server.closeAllConnections();
  await server.close();
});

function assertProviderRequest(request, id, effort) {
  assert.equal(request.model, upstreamModel(id));
  assert.equal(request.path, `/${id}/v1/chat/completions`);
  assert.equal(request.authorization, `Bearer ${fixtureKey(id)}`);
  assert.equal(request.effort, effort);
}

test('concurrent project runs and inherited workers keep their models and efforts through retries and settings changes', { timeout: 15000 }, async t => {
  const [alpha, beta] = await Promise.all(selections.map(async selection => ({
    ...selection, project: await createProject(selection.id), requestId: randomUUID(),
    gate: { arrived: Promise.withResolvers(), release: Promise.withResolvers(), retry: selection.id === 'alpha' },
  })));
  const runs = [alpha, beta];
  heldRequests = new Map(runs.map(({ id, gate }) => [id, gate]));
  t.after(() => { for (const { gate } of runs) gate.release.resolve(); heldRequests = null; });
  const responses = await Promise.all(runs.map(({ project, requestId, id, effort }) => call(project, 'POST', '/agent/chat',
    { requestId, message: marker(id), modelId: id, reasoningEffort: effort }, true)));
  for (const response of responses) assert.equal(response.status, 200);
  await Promise.all(runs.map(({ gate }) => gate.arrived.promise));

  const oldDefault = (await settings()).data.activeModelId;
  const changed = await settings('PUT', { activeModelId: beta.id,
    agentConfig: { subagentModelId: beta.id, subagentReasoningEffort: 'medium' } });
  assert.equal(changed.status, 200);
  const replay = await call(alpha.project, 'POST', '/agent/chat', {
    requestId: alpha.requestId, message: marker(alpha.id), modelId: beta.id, reasoningEffort: beta.effort,
  }, true);
  const reconnected = await call(beta.project, 'GET', `/agent/runs/${beta.requestId}/events`, undefined, true);
  for (const { gate } of runs) gate.release.resolve();
  const [alphaEvents, betaEvents, replayEvents, reconnectedEvents] = await Promise.all([...responses, replay, reconnected].map(readEvents));

  assert.equal(oldDefault, defaultId);
  assert.deepEqual(replayEvents, alphaEvents);
  assert.deepEqual(reconnectedEvents, betaEvents);
  assert.ok(alphaEvents.some(event => event.type === 'activity' && event.phase === 'retry'));
  for (const [index, events] of [alphaEvents, betaEvents].entries()) {
    const { project, id, effort, contextLength, inputTokens } = runs[index];
    assert.equal(events.at(-1).state, 'completed');
    const ownRequests = requests.filter(request => request.id === id);
    assert.ok(ownRequests.some(request => !request.worker));
    assert.ok(ownRequests.some(request => request.worker));
    for (const request of ownRequests) assertProviderRequest(request, id, effort);
    const rows = db.prepare('SELECT provider_id, requested_model FROM ai_usage WHERE project_id=?').all(project.id);
    assert.equal(rows.length, ownRequests.length);
    assert.ok(rows.every(row => row.provider_id === providerId(id) && row.requested_model === upstreamModel(id)));

    const usage = events.filter(event => event.type === 'context_usage');
    assert.ok(usage.length > 0);
    assert.ok(usage.every(event => event.contextUsage.modelId === id && event.contextUsage.maxTokens === contextLength));
    const measured = usage.filter(event => !event.contextUsage.estimated);
    assert.ok(measured.length > 0);
    assert.ok(measured.every(event => event.contextUsage.usedTokens === inputTokens));
    const chat = await call(project, 'GET', `/chat?modelId=${id}`);
    assert.deepEqual(chat.data.contextUsage, usage.at(-1).contextUsage);
  }

  const next = await createProject('new default');
  const nextEvents = await readEvents(await call(next, 'POST', '/agent/chat', { message: 'Use the account default.' }, true));
  assert.equal(nextEvents.at(-1).state, 'completed');
  assertProviderRequest(requests.at(-1), beta.id, 'medium');
  assert.equal((await settings()).data.activeModelId, beta.id);
});

test('selection actions use the specified model without changing the account default', async () => {
  const project = await createProject('selection');
  const file = 'selection.tex';
  fs.writeFileSync(path.join(server.dataDir, 'projects', String(project.id), file), 'Example paragraph');
  const events = await readEvents(await call(project, 'POST', '/agent/selection-action', {
    action: 'explain', file, start: 0, end: 7, selectionText: 'Example', modelId: 'alpha', reasoningEffort: 'low',
  }, true));
  assert.equal(events.at(-1).state, 'completed');
  assertProviderRequest(requests.at(-1), 'alpha', 'low');
  assert.equal((await settings()).data.activeModelId, defaultId);
});

test('manual context compaction uses the specified model without changing the account default', async () => {
  const project = await createProject('compaction');
  const { data: { chatId } } = await call(project, 'GET', '/chat');
  const insert = db.prepare('INSERT INTO chat_messages(chat_id, role, content) VALUES(?,?,?)');
  insert.run(chatId, 'user', 'Previous question');
  insert.run(chatId, 'assistant', 'Previous answer');
  insert.run(chatId, 'user', 'Current question');
  const result = await call(project, 'POST', '/agent/context/compact', { modelId: 'alpha', reasoningEffort: 'low' });
  assert.equal(result.status, 200);
  assert.equal(result.data.compressed, true);
  assert.equal(result.data.contextUsage.modelId, 'alpha');
  assertProviderRequest(requests.at(-1), 'alpha', 'low');
  assert.equal((await settings()).data.activeModelId, defaultId);
});

test('invalid run selections fail before dispatching a request or recording a message', async () => {
  const project = await createProject('invalid model selections');
  for (const selection of [{ modelId: 'missing' }, { modelId: 'disabled' }, { modelId: 'alpha', reasoningEffort: 'high' }]) {
    const rejected = await call(project, 'POST', '/agent/chat', { message: 'Invalid selection.', ...selection });
    assert.equal(rejected.status, 400);
  }
  assert.equal(requests.length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM agent_runs WHERE project_id=?').get(project.id).n, 0);
  assert.deepEqual((await call(project, 'GET', '/chat')).data.messages, []);
  assert.equal((await settings()).data.activeModelId, defaultId);
});
