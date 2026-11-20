import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, api, registerAndLogin } from './helpers.js';
let srv, user;
before(async () => { srv = await startTestServer(); user = await registerAndLogin(srv.baseUrl, 'agent-feature-settings'); });
after(async () => { await srv.close(); });
const save = body => api(srv.baseUrl, 'PUT', '/api/settings/ai', { token: user.token, body });
const load = () => api(srv.baseUrl, 'GET', '/api/settings/ai', { token: user.token });

test('graph and sound switches persist independently without resetting tool permissions', async () => {
  assert.equal((await save({ agentConfig: { allowRunScripts: false, allowWebAccess: false, graphOrchestration: true, completionSound: false } })).status, 200);
  assert.equal((await save({ agentConfig: { graphOrchestration: false } })).status, 200);
  const { data } = await load();
  assert.deepEqual(data.agentConfig, { allowRunScripts: false, allowWebAccess: false, graphOrchestration: false, completionSound: false });
  assert.equal((await save({ agentConfig: { completionSound: true } })).status, 200);
  assert.equal((await load()).data.agentConfig.graphOrchestration, false);
});
test('rejects malformed toggle values without overwriting the saved preferences', async () => {
  for (const key of ['graphOrchestration', 'completionSound']) {
    for (const value of ['false', 1, null]) assert.equal((await save({ agentConfig: { [key]: value } })).status, 400);
  }
  const { data } = await load();
  assert.equal(data.agentConfig.completionSound, true);
  assert.equal(data.agentConfig.graphOrchestration, false);
});


test('collaboration settings ignore retired repair limits and legacy clients can still disable orchestration', async () => {
  assert.equal((await save({ agentConfig: { collaborationTier: 'lite', maxModelConcurrency: 1, repairCycles: 0 } })).status, 200);
  assert.equal((await load()).data.agentConfig.graphOrchestration, true);
  assert.equal(Object.hasOwn((await load()).data.agentConfig, 'repairCycles'), false);
  assert.equal((await save({ agentConfig: { graphOrchestration: false } })).status, 200);
  assert.equal((await load()).data.agentConfig.collaborationTier, 'off');
  for (const config of [{ collaborationTier: 'invalid' }, { maxModelConcurrency: 0 }, { orchestrationBudgetUsd: -2 }])
    assert.equal((await save({ agentConfig: config })).status, 400);
  assert.equal((await load()).data.agentConfig.collaborationTier, 'off');
});

test('legacy saved repair limits are hidden and removed on the next settings save without losing permissions', async () => {
  const { getDb } = await import('../src/db.js');
  const db = getDb();
  db.prepare('UPDATE settings SET agent_config=? WHERE user_id=?').run(JSON.stringify({
    repairCycles: 0, collaborationTier: 'off', allowRunScripts: false, confirmBeforeApply: true,
  }), user.user.id);
  assert.equal(Object.hasOwn((await load()).data.agentConfig, 'repairCycles'), false);
  assert.equal((await save({ agentConfig: { completionSound: false, repairCycles: 0 } })).status, 200);
  const stored = JSON.parse(db.prepare('SELECT agent_config FROM settings WHERE user_id=?').get(user.user.id).agent_config);
  assert.equal(Object.hasOwn(stored, 'repairCycles'), false);
  assert.equal(stored.allowRunScripts, false); assert.equal(stored.confirmBeforeApply, true);
});
