import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startTestServer, api, registerAndLogin } from './helpers.js';
import { parseModelSettings, resolveModelConfig } from '../src/services/agent/models.js';

let srv, user, mock, mockBase, db;
const requests = [];
const key = 'fixture-secret-123456789';
const model = (id, extra = {}) => ({ id, name: id, model: id, enabled: true, contextLength: 65536, maxTokens: 4096, vision: false, ...extra });
const provider = (id, models, extra = {}) => ({ id, name: id, apiFormat: 'openai', baseUrl: mockBase + '/v1', apiKey: key, enabled: true, models, ...extra });
const save = (body) => api(srv.baseUrl, 'PUT', '/api/settings/ai', { token: user.token, body });
const load = () => api(srv.baseUrl, 'GET', '/api/settings/ai', { token: user.token });
const row = () => db.prepare('SELECT * FROM settings WHERE user_id=?').get(user.user.id);

before(async () => {
  srv = await startTestServer();
  ({ getDb: db } = await import('../src/db.js'));
  db = db();
  user = await registerAndLogin(srv.baseUrl, 'provider-fixture');
  mock = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      requests.push({ path: req.url, auth: req.headers.authorization, anthropicKey: req.headers['x-api-key'], body: JSON.parse(body) });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));
  mockBase = 'http://127.0.0.1:' + mock.address().port;
});
after(async () => { mock?.closeAllConnections(); await new Promise((r) => mock.close(r)); await srv.close(); });

test('legacy models group shared credentials and retain identity, vision and sampling parameters', async () => {
  const old = [model('old-one', { provider: 'openai', baseUrl: mockBase + '/v1', apiKey: key }),
    model('old-two', { provider: 'openai', baseUrl: mockBase + '/v1', apiKey: key, temperature: 0.2 })];
  db.prepare("UPDATE settings SET ai_providers='[]',ai_models=?,ai_active='old-two' WHERE user_id=?").run(JSON.stringify(old), user.user.id);
  const { data } = await load();
  assert.equal(data.providers.length, 1);
  assert.equal(data.providers[0].models.length, 2);
  assert.deepEqual(data.models.map((m) => m.id), ['old-one', 'old-two']);
  assert.equal(data.activeModelId, 'old-two');
  assert.equal(data.models[0].vision, false);
  assert.equal(data.models[1].temperature, 0.2);
  assert.equal(JSON.stringify(data).includes(key), false);
  assert.equal('apiKey' in data.providers[0].models[0], false);
  assert.equal((await save({ providers: data.providers, activeModelId: data.activeModelId })).status, 200);
  assert.equal(resolveModelConfig(row(), 'old-one').apiKey, key);
});

test('provider credentials are shared, masks preserve secrets, and rotation affects all models', async () => {
  assert.equal((await save({ providers: [provider('shared', [model('a'), model('b')])], activeModelId: 'b' })).status, 200);
  const { data } = await load();
  assert.equal(data.providers[0].apiKey, '***6789');
  assert.equal((await save({ providers: data.providers, activeModelId: 'b' })).status, 200);
  assert.equal(resolveModelConfig(row(), 'a').apiKey, key);
  data.providers[0].apiKey = 'rotated-secret-4321';
  assert.equal((await save({ providers: data.providers })).status, 200);
  assert.equal(resolveModelConfig(row(), 'a').apiKey, 'rotated-secret-4321');
  assert.equal(resolveModelConfig(row(), 'b').apiKey, 'rotated-secret-4321');
});

test('disabled providers and models cannot be selected or silently substituted', async () => {
  const providers = [provider('off', [model('disabled')], { enabled: false }), provider('on', [model('enabled'), model('model-off', { enabled: false })])];
  assert.equal((await save({ providers })).status, 200);
  assert.equal((await load()).data.activeModelId, 'enabled');
  assert.throws(() => resolveModelConfig(row(), 'disabled'), /停用/);
  assert.throws(() => resolveModelConfig(row(), 'model-off'), /停用/);
  assert.throws(() => resolveModelConfig(row(), 'unknown'), /不存在/);
  assert.equal((await save({ activeModelId: 'disabled' })).status, 400);
});

test('deleting every provider stays empty instead of resurrecting legacy settings', async () => {
  assert.equal((await save({ providers: [] })).status, 200);
  const { data } = await load();
  assert.deepEqual(data.providers, []);
  assert.deepEqual(data.models, []);
  assert.equal(data.activeModelId, '');
  assert.throws(() => resolveModelConfig(row()), /配置并启用/);
});

test('duplicate model IDs, masked new keys and invalid URLs are rejected without replacing settings', async () => {
  await save({ providers: [provider('stable', [model('stable-model')])] });
  const before = row().ai_providers;
  for (const providers of [
    [provider('first', [model('duplicate')]), provider('second', [model('duplicate')])],
    [provider('new-masked', [model('masked')], { apiKey: '***1234' })],
    [provider('bad-url', [model('bad-url')], { baseUrl: 'file:///tmp' })],
  ]) assert.equal((await save({ providers })).status, 400);
  assert.equal(row().ai_providers, before);
});

test('saved-provider connection tests use the chosen model and matching protocol path', async () => {
  await save({ providers: [provider('anthropic', [model('claude-fixture')], { apiFormat: 'anthropic', baseUrl: mockBase + '/gateway/anthropic' })] });
  const result = await api(srv.baseUrl, 'POST', '/api/settings/ai/test', { token: user.token, body: { providerId: 'anthropic', modelId: 'claude-fixture' } });
  assert.equal(result.data.ok, true);
  assert.equal(requests.at(-1).path, '/gateway/anthropic/v1/messages');
  assert.equal(requests.at(-1).anthropicKey, key);
  assert.equal(requests.at(-1).body.model, 'claude-fixture');
  assert.equal((await api(srv.baseUrl, 'POST', '/api/settings/ai/test', { token: user.token, body: { providerId: 'anthropic', modelId: 'wrong' } })).status, 400);
});

test('model sampling overrides fall back to the saved global configuration', () => {
  const state = { ai_providers: JSON.stringify({ version: 2, providers: [provider('sampling', [model('defaults', { temperature: undefined, maxTokens: undefined })])] }),
    ai_active: 'defaults', agent_config: JSON.stringify({ temperature: 0.35, maxTokens: 2048 }) };
  const resolved = resolveModelConfig(state);
  assert.equal(resolved.temperature, 0.35);
  assert.equal(resolved.maxTokens, 2048);
});


test('reasoning levels round-trip ordered custom values without enabling legacy models', async () => {
  await save({ providers: [provider('reasoning', [model('plain'), model('enabled', {
    reasoningLevels: ['low', ' medium ', 'xhigh', 'max', 'vendor:deep-v2', 'medium', ''],
  })])] });
  const { data } = await load();
  assert.deepEqual(data.models.find(m => m.id === 'plain').reasoningLevels, []);
  assert.equal(resolveModelConfig(row(), 'plain').reasoningEffort, undefined);
  const levels = ['low', 'medium', 'xhigh', 'max', 'vendor:deep-v2'];
  assert.deepEqual(data.providers[0].models[1].reasoningLevels, levels);
  assert.deepEqual(data.models[1].reasoningLevels, levels);
  assert.equal(resolveModelConfig(row(), 'enabled').reasoningEffort, 'medium');
  assert.equal(resolveModelConfig(row(), 'enabled', 'max').reasoningEffort, 'max');
  assert.equal(resolveModelConfig(row(), 'enabled', 'vendor:deep-v2').reasoningEffort, 'vendor:deep-v2');
  assert.throws(() => resolveModelConfig(row(), 'plain', 'high'), /思考强度/);
  assert.throws(() => resolveModelConfig(row(), 'enabled', 'wrong'), /思考强度/);
  assert.throws(() => resolveModelConfig(row(), 'enabled', ['max']), /思考强度/);
  assert.equal((await save({ providers: data.providers })).status, 200);
  assert.deepEqual(parseModelSettings(row()).models[1].reasoningLevels, levels);
  data.providers[0].models[1].reasoningLevels = [];
  assert.equal((await save({ providers: data.providers })).status, 200);
  assert.equal(resolveModelConfig(row(), 'enabled').reasoningEffort, undefined);
});

test('invalid reasoning configurations reject provider and legacy saves without changing saved settings', async () => {
  await save({ providers: [provider('valid', [model('valid', { reasoningLevels: ['max'] })])] });
  const before = row().ai_providers;
  assert.equal(resolveModelConfig(row(), 'valid').reasoningEffort, 'max');
  for (const invalid of [null, 'low,high', [1], ['bad value'], ['a'.repeat(65)], Array(33).fill('low')]) {
    const providers = [provider('invalid', [model('invalid', { reasoningLevels: invalid })])];
    assert.equal((await save({ providers })).status, 400, JSON.stringify(invalid));
    assert.equal((await save({ models: [model('invalid', { reasoningLevels: invalid })] })).status, 400);
    assert.equal(row().ai_providers, before);
  }
});
