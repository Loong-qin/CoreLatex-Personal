import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startTestServer, api, registerAndLogin } from './helpers.js';

let server, llm, base, user, toPiModel, streamSimple, modelReasoningOptions, generateSummary;
const requests = [];
const data = value => `data: ${JSON.stringify(value)}\n\n`;
const event = (name, value) => `event: ${name}\ndata: ${JSON.stringify(value)}\n\n`;
const config = (provider, model, effort, extra = {}) => ({ provider, model, name: model,
  baseUrl: `${base}/v1`, apiKey: 'local-fixture', contextLength: 65536, maxTokens: 8192, temperature: 0.3,
  reasoningLevels: effort ? [effort] : [], reasoningEffort: effort, ...extra });

before(async () => {
  server = await startTestServer();
  user = await registerAndLogin(server.baseUrl, 'reasoning-owner');
  ({ toPiModel } = await import('../src/services/agent/context.js'));
  ({ streamSimple } = await import('@mariozechner/pi-ai'));
  ({ generateSummary } = await import('@mariozechner/pi-coding-agent'));
  ({ modelReasoningOptions } = await import('../src/services/agent/reasoning.js'));
  llm = http.createServer((req, res) => {
    let raw = ''; req.on('data', chunk => raw += chunk); req.on('end', () => {
      const body = JSON.parse(raw); requests.push({ path: req.url, body });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (req.url.endsWith('/messages')) {
        res.end(event('message_start', { type: 'message_start', message: { id: 'm1', type: 'message', role: 'assistant',
          model: body.model, content: [], usage: { input_tokens: 4, output_tokens: 0 } } })
          + event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
          + event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '参数确认。' } })
          + event('content_block_stop', { type: 'content_block_stop', index: 0 })
          + event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } })
          + event('message_stop', { type: 'message_stop' }));
      } else res.end(data({ choices: [{ index: 0, delta: { role: 'assistant', content: '参数确认。' } }] })
        + data({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n');
    });
  });
  await new Promise(resolve => llm.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${llm.address().port}`;
});
after(async () => { llm?.closeAllConnections(); await new Promise(resolve => llm.close(resolve)); await server.close(); });

async function chat(modelConfig) {
  const output = await streamSimple(toPiModel(modelConfig, modelConfig.maxTokens), {
    systemPrompt: 'test', messages: [{ role: 'user', content: '解释参数', timestamp: Date.now() }],
  }, { apiKey: modelConfig.apiKey, maxTokens: modelConfig.maxTokens, temperature: modelConfig.temperature,
    ...modelReasoningOptions(modelConfig), maxRetries: 0 }).result();
  assert.equal(output.stopReason, 'stop', output.errorMessage);
  return requests.at(-1).body;
}

test('OpenAI sends the exact selected standard, max and custom effort without incompatible temperature', async () => {
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max', 'vendor:deep-v2']) {
    const body = await chat(config('openai', 'gateway-model', effort));
    assert.equal(body.reasoning_effort, effort);
    assert.equal('temperature' in body, false);
    assert.equal(body.model, 'gateway-model');
    assert.equal(requests.at(-1).path, '/v1/chat/completions');
  }
});

test('unconfigured and explicitly empty models retain the legacy request without reasoning fields', async () => {
  for (const provider of ['openai', 'anthropic']) for (const levels of [undefined, []]) {
    const modelConfig = config(provider, 'legacy-model', undefined, { reasoningLevels: levels });
    assert.equal(toPiModel(modelConfig).reasoning, false);
    const body = await chat(modelConfig);
    assert.equal(body.reasoning_effort, undefined); assert.equal(body.thinking, undefined);
    assert.equal(body.output_config, undefined); assert.equal(body.temperature, 0.3);
  }
});

test('Anthropic adaptive models retain native effort including max and explicitly configured custom gateway values', async () => {
  for (const [model, effort] of [['claude-opus-4-6', 'max'], ['claude-opus-4-7', 'xhigh'],
    ['claude-sonnet-5', 'max'], ['custom-anthropic-gateway', 'vendor-deep']]) {
    const body = await chat(config('anthropic', model, effort));
    assert.deepEqual(body.thinking, { type: 'adaptive' });
    assert.equal(body.output_config.effort, effort); assert.equal(body.max_tokens, 8192);
    assert.equal('temperature' in body, false);
    assert.equal(requests.at(-1).path, '/v1/messages');
  }
});

test('older Anthropic models use bounded numeric budgets and reject unsupported custom levels before HTTP', async () => {
  for (const [effort, budget] of [['low', 2048], ['medium', 8192], ['high', 16384], ['max', 65536]]) {
    const body = await chat(config('anthropic', 'claude-sonnet-4-5-20250929', effort, { maxTokens: 70000 }));
    assert.deepEqual(body.thinking, { type: 'enabled', budget_tokens: budget });
    assert.equal(body.output_config, undefined); assert.equal('temperature' in body, false);
    assert.ok(body.thinking.budget_tokens < body.max_tokens);
  }
  const bounded = await chat(config('anthropic', 'claude-3-7-sonnet-20250219', 'high', { maxTokens: 4096 }));
  assert.equal(bounded.thinking.budget_tokens, 4095);
  const count = requests.length;
  await assert.rejects(chat(config('anthropic', 'claude-sonnet-4-5', 'custom')), /不支持自定义/);
  await assert.rejects(chat(config('anthropic', 'claude-sonnet-4-5', 'high', { maxTokens: 1024 })), /大于 1024/);
  assert.equal(requests.length, count);
});

test('pi compaction uses the same adapter and preserves max/custom effort', async () => {
  for (const [provider, model, effort] of [['openai', 'gpt-custom', 'custom-max'], ['anthropic', 'claude-opus-4-6', 'max']]) {
    const mc = config(provider, model, effort);
    const summary = await generateSummary([{ role: 'user', content: '请汇总这个测试上下文。', timestamp: Date.now() }],
      toPiModel(mc, mc.maxTokens), mc.maxTokens, mc.apiKey, undefined, undefined, undefined, undefined, mc.reasoningEffort);
    assert.ok(summary.includes('参数确认'));
    const body = requests.at(-1).body;
    assert.equal(provider === 'openai' ? body.reasoning_effort : body.output_config.effort, effort);
  }
});

test('chat route validates the selected model effort before creating a run and the real coordinator sends it', async () => {
  const saved = await api(server.baseUrl, 'PUT', '/api/settings/ai', { token: user.token, body: {
    providers: [{ id: 'p', name: 'p', apiFormat: 'openai', baseUrl: base + '/v1', apiKey: 'local-fixture', models: [
      { id: 'r', model: 'route-model', reasoningLevels: ['low', 'max'], contextLength: 65536, maxTokens: 8192 },
    ] }], activeModelId: 'r', agentConfig: { graphOrchestration: false },
  } });
  assert.equal(saved.status, 200);
  const created = await api(server.baseUrl, 'POST', '/api/projects', { token: user.token, body: { name: 'reasoning-route' } });
  const pid = created.data.project.publicId;
  const count = requests.length;
  const rejected = await api(server.baseUrl, 'POST', `/api/projects/${pid}/agent/chat`, {
    token: user.token, body: { modelId: 'r', reasoningEffort: 'high', message: '解释思考强度参数。' },
  });
  assert.equal(rejected.status, 400); assert.equal(requests.length, count);
  const response = await api(server.baseUrl, 'POST', `/api/projects/${pid}/agent/chat`, {
    token: user.token, raw: true, body: { modelId: 'r', reasoningEffort: 'max', message: '解释思考强度参数。' },
  });
  assert.equal(response.status, 200);
  const stream = await response.text();
  assert.match(stream, /参数确认/);
  assert.equal(requests.at(-1).body.reasoning_effort, 'max');
  assert.equal(requests.at(-1).body.temperature, undefined);
});


test('native disabled effort and caller payload hooks cannot reintroduce conflicting thinking parameters', async () => {
  const noThinking = await chat(config('anthropic', 'claude-opus-4-6', 'none'));
  assert.deepEqual(noThinking.thinking, { type: 'disabled' });
  assert.equal(noThinking.output_config?.effort, undefined);
  assert.equal((await chat(config('openai', 'gpt-configured', 'none'))).reasoning_effort, 'none');
  const mc = config('anthropic', 'claude-sonnet-4-5', 'high');
  const result = await streamSimple(toPiModel(mc, mc.maxTokens), {
    messages: [{ role: 'user', content: '解释参数', timestamp: Date.now() }],
  }, { apiKey: mc.apiKey, ...modelReasoningOptions(mc),
    onPayload: payload => ({ ...payload, temperature: 0.1, output_config: { effort: 'custom', other: 'preserved' } }),
  }).result();
  assert.equal(result.stopReason, 'stop', result.errorMessage);
  const body = requests.at(-1).body;
  assert.equal(body.output_config.effort, undefined);
  assert.equal(body.output_config.other, 'preserved');
  assert.equal(body.temperature, undefined);
});
