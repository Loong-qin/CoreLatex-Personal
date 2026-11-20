import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startTestServer, api, registerAndLogin } from './helpers.js';

let srv, admin, owner, other;

before(async () => {
  srv = await startTestServer();
  admin = await registerAndLogin(srv.baseUrl, 'stats-admin');
  owner = await registerAndLogin(srv.baseUrl, 'stats-owner');
  other = await registerAndLogin(srv.baseUrl, 'stats-other');
  const { getDb } = await import('../src/db.js');
  const db = getDb();
  const insert = db.prepare(`
    INSERT INTO tool_usage (user_id, tool, skill, created_at)
    VALUES (?, ?, ?, datetime('now', ?))
  `);
  const usage = (user, tool, count, age = '-1 day', skill = '') => {
    for (let i = 0; i < count; i++) insert.run(user.user.id, tool, skill, age);
  };
  db.transaction(() => {
    // More than twelve higher-frequency tools, inserted in reverse name order.
    for (let i = 13; i >= 1; i--) usage(owner, `tool_${String(i).padStart(2, '0')}`, 3);
    usage(owner, 'ask_user', 2);
    for (let i = 1; i <= 13; i++) {
      usage(owner, 'read_skill', i, '-1 day', `skill_${String(i).padStart(2, '0')}`);
    }
    usage(owner, 'ask_user', 2, '+0 seconds');
    usage(owner, 'today_only', 2, '+0 seconds');
    usage(owner, 'three_days_only', 1, '-2 days');
    usage(owner, 'outside_three_days', 1, '-3 days');
    usage(owner, 'ask_user', 4, '-14 days');
    usage(owner, 'mid_range_only', 1, '-14 days');
    usage(owner, 'ask_user', 7, '-45 days');
    usage(owner, 'old_range_only', 1, '-45 days');
    usage(owner, 'ask_user', 100, '-120 days');
    usage(owner, 'outside_max_range', 1, '-120 days');
    usage(other, 'ask_user', 5);
    usage(other, 'other_user_only', 1);
    usage(admin, 'admin_only', 1);
  })();
});

after(async () => { await srv.close(); });

const stats = (user, query = '') => api(srv.baseUrl, 'GET', `/api/users/stats${query}`, { token: user.token });
const countOf = (rows, name) => rows.find(row => row.name === name)?.count;

test('stats returns all tool types, including low-frequency ask_user, with stable count/name order', async () => {
  const { status, data } = await stats(owner, '?days=7');
  assert.equal(status, 200);
  assert.equal(data.granularity, 'day');
  assert.equal(data.hourly.length, 0);
  assert.equal(data.tools.length, 18);
  assert.equal(countOf(data.tools, 'ask_user'), 4);
  assert.equal(countOf(data.tools, 'read_skill'), 91);
  assert.deepEqual(data.tools, [
    { name: 'read_skill', count: 91 },
    { name: 'ask_user', count: 4 },
    ...Array.from({ length: 13 }, (_, i) => ({ name: `tool_${String(i + 1).padStart(2, '0')}`, count: 3 })),
    { name: 'today_only', count: 2 },
    { name: 'outside_three_days', count: 1 },
    { name: 'three_days_only', count: 1 },
  ]);
  assert.equal(data.toolDaily.filter(row => row.name === 'ask_user').reduce((sum, row) => sum + row.count, 0), 4);
});

test('stats supports today and three calendar days with matching daily series', async () => {
  const today = (await stats(owner, '?days=1')).data;
  assert.equal(today.days, 1);
  assert.equal(today.granularity, 'hour');
  assert.equal(today.daily.length, 1);
  assert.ok(today.hourly.length >= 1 && today.hourly.length <= 24);
  assert.ok(today.hourly[0].time.endsWith('00:00'));
  assert.equal(countOf(today.toolHourly, 'today_only'), 2);
  assert.equal(countOf(today.toolHourly, 'read_skill'), undefined);
  assert.equal(countOf(today.tools, 'ask_user'), 2);
  assert.equal(countOf(today.tools, 'today_only'), 2);
  assert.equal(countOf(today.tools, 'read_skill'), undefined);
  assert.equal(countOf(today.tools, 'three_days_only'), undefined);

  const threeDays = (await stats(owner, '?days=3')).data;
  assert.equal(threeDays.days, 3);
  assert.equal(threeDays.granularity, 'hour');
  assert.equal(threeDays.daily.length, 3);
  assert.ok(threeDays.hourly.length > 48 && threeDays.hourly.length <= 72);
  assert.equal(countOf(threeDays.toolHourly, 'three_days_only'), 1);
  assert.equal(countOf(threeDays.toolHourly, 'outside_three_days'), undefined);
  assert.equal(countOf(threeDays.tools, 'ask_user'), 4);
  assert.equal(countOf(threeDays.tools, 'today_only'), 2);
  assert.equal(countOf(threeDays.tools, 'three_days_only'), 1);
  assert.equal(countOf(threeDays.tools, 'outside_three_days'), undefined);
  assert.equal(countOf(threeDays.tools, 'mid_range_only'), undefined);
});

test('stats retains requested date filtering, default window, and the 1-to-90-day bounds', async () => {
  const minimum = (await stats(owner, '?days=-1')).data;
  assert.equal(minimum.days, 1);
  assert.equal(countOf(minimum.tools, 'today_only'), 2);
  assert.equal(countOf(minimum.tools, 'mid_range_only'), undefined);

  const month = (await stats(owner)).data;
  assert.equal(month.days, 30);
  assert.equal(countOf(month.tools, 'ask_user'), 8);
  assert.equal(countOf(month.tools, 'mid_range_only'), 1);
  assert.equal(countOf(month.tools, 'old_range_only'), undefined);

  const quarter = (await stats(owner, '?days=365')).data;
  assert.equal(quarter.days, 90);
  assert.equal(countOf(quarter.tools, 'ask_user'), 15);
  assert.equal(countOf(quarter.tools, 'old_range_only'), 1);
  assert.equal(countOf(quarter.tools, 'outside_max_range'), undefined);
});

test('stats preserves self/admin scope and rejects unauthorized cross-user/global access', async () => {
  assert.equal((await api(srv.baseUrl, 'GET', '/api/users/stats')).status, 401);
  assert.equal((await stats(owner, '?scope=global')).status, 403);
  assert.equal((await stats(owner, `?userId=${other.user.id}`)).status, 403);

  const own = (await stats(owner, '?days=7')).data;
  assert.equal(own.scope, 'user');
  assert.equal(own.target.id, owner.user.id);
  assert.equal(countOf(own.tools, 'other_user_only'), undefined);
  assert.equal(countOf(own.tools, 'admin_only'), undefined);

  const selected = await stats(admin, `?scope=user&userId=${owner.user.id}&days=7`);
  assert.equal(selected.status, 200);
  assert.deepEqual(selected.data.tools, own.tools);
  assert.equal(selected.data.target.id, owner.user.id);

  const global = await stats(admin, '?scope=global&days=7');
  assert.equal(global.status, 200);
  assert.equal(global.data.scope, 'global');
  assert.equal(global.data.target, null);
  assert.equal(countOf(global.data.tools, 'ask_user'), 9);
  assert.equal(countOf(global.data.tools, 'other_user_only'), 1);
  assert.equal(countOf(global.data.tools, 'admin_only'), 1);
  assert.equal(countOf(global.data.tools, 'mid_range_only'), undefined);
});

test('stats keeps the skill top-twelve limit while tool and skill daily counts stay complete', async () => {
  const { status, data } = await stats(owner, '?days=7');
  assert.equal(status, 200);
  assert.deepEqual(data.skills, Array.from({ length: 12 }, (_, i) => ({
    name: `skill_${String(13 - i).padStart(2, '0')}`,
    count: 13 - i,
  })));
  assert.equal(data.skillDaily.length, 13);
  assert.equal(countOf(data.skillDaily, 'skill_01'), 1);
  assert.equal(countOf(data.tools, 'read_skill'), 91);
});

test('Beijing midnight controls every range and bucket independently of the server timezone', async t => {
  const boundaryUser = await registerAndLogin(srv.baseUrl, 'stats-beijing-boundary');
  const { getDb } = await import('../src/db.js');
  const db = getDb();
  const timestamps = ['2026-11-01 15:59:59', '2026-11-01 16:00:00', '2026-11-01 16:29:59'];
  timestamps.forEach((createdAt, index) => {
    db.prepare('INSERT INTO ai_usage(user_id,model,input_tokens,created_at) VALUES(?,?,?,?)')
      .run(boundaryUser.user.id, 'boundary-model', (index + 1) * 10, createdAt);
    db.prepare('INSERT INTO compile_jobs(project_id,user_id,status,duration_ms,created_at) VALUES(0,?,?,?,?)')
      .run(boundaryUser.user.id, 'succeeded', (index + 1) * 1000, createdAt);
    db.prepare('INSERT INTO tool_usage(user_id,tool,skill,created_at) VALUES(?,?,?,?)')
      .run(boundaryUser.user.id, 'read_skill', 'boundary-skill', createdAt);
  });
  // 00:30 on November 2 in Beijing, still November 1 in UTC.
  t.mock.method(Date, 'now', () => Date.parse('2026-11-01T16:30:00Z'));
  const previousTimezone = process.env.TZ;
  t.after(() => { if (previousTimezone === undefined) delete process.env.TZ; else process.env.TZ = previousTimezone; });
  let reference;
  for (const timezone of ['UTC', 'America/Los_Angeles']) {
    process.env.TZ = timezone;
    const { status, data } = await stats(boundaryUser, '?days=1');
    assert.equal(status, 200);
    assert.equal(data.timeZone, 'Asia/Shanghai'); assert.equal(data.utcOffset, '+08:00');
    assert.deepEqual(data.range, { start: '2026-11-02', end: '2026-11-02' });
    const usage = { aiInputTokens: 50, aiCacheReadTokens: 0, aiUncachedInputTokens: 50, aiOutputTokens: 0, aiTotalTokens: 50,
      aiRequests: 0, aiLegacyRuns: 2, aiUnknownUsageRequests: 0, aiPartialUsageRequests: 0 };
    assert.deepEqual(data.rangeTotals, usage);
    assert.deepEqual(data.daily, [{ day: '2026-11-02', ...usage, compiles: 2, compileSeconds: 5 }]);
    assert.deepEqual(data.hourly, [{ time: '2026-11-02 00:00', ...usage, compiles: 2, compileSeconds: 5 }]);
    assert.deepEqual(data.toolHourly, [{ time: '2026-11-02 00:00', name: 'read_skill', count: 2 }]);
    assert.deepEqual(data.skillHourly, [{ time: '2026-11-02 00:00', name: 'boundary-skill', count: 2 }]);
    assert.equal(data.models[0].legacyRuns, 2); assert.equal(data.models[0].requests, 0);
    assert.equal(data.tools[0].count, 2); assert.equal(data.skills[0].count, 2);
    assert.deepEqual(data.toolDaily, [{ day: '2026-11-02', name: 'read_skill', count: 2 }]);
    assert.deepEqual(data.skillDaily, [{ day: '2026-11-02', name: 'boundary-skill', count: 2 }]);
    if (reference) assert.deepEqual(data, reference);
    reference = data;
  }
  const threeDays = (await stats(boundaryUser, '?days=3')).data;
  assert.deepEqual(threeDays.range, { start: '2026-10-31', end: '2026-11-02' });
  assert.equal(threeDays.hourly.length, 49);
  assert.equal(threeDays.hourly[0].aiUncachedInputTokens, 0);
  assert.equal(threeDays.hourly[0].aiTotalTokens, 0);
  assert.equal(threeDays.hourly.at(-2).time, '2026-11-01 23:00');
  assert.equal(threeDays.hourly.at(-2).aiLegacyRuns, 1);
  assert.equal(threeDays.hourly.at(-1).aiLegacyRuns, 2);
  assert.equal(threeDays.tools[0].count, 3);
  const week = (await stats(boundaryUser, '?days=7')).data;
  assert.equal(week.daily.at(-2).aiLegacyRuns, 1); assert.equal(week.daily.at(-1).aiLegacyRuns, 2);
  assert.equal(week.hourly.length, 0);
});

test('usage endpoints count only attempted requests and preserve observed cache, unknowns and historical tokens', async () => {
  const target = await registerAndLogin(srv.baseUrl, 'stats-ai-ledger');
  const { getDb } = await import('../src/db.js');
  const { recordAiUsage } = await import('../src/quotas.js');
  const db = getDb(), userId = target.user.id;
  const startedAt = Date.now();
  const base = { provider: 'openai', providerId: 'supplier-one', model: 'shared-model', owner: 'coordinator', startedAt };
  const request = (details) => recordAiUsage({ userId, entry: { ...base, requestKey: randomUUID(), ...details } });
  const completed = { requestKey: randomUUID(), usage: { input: 7, output: 3, cacheRead: 40, cacheWrite: 5 }, status: 'stop' };
  request(completed);
  request(completed);
  request({ status: 'aborted' });
  request({ providerId: 'supplier-two', status: 'error', usage: { input: 10, output: 0, cacheRead: 4, cacheWrite: 0 } });
  request({ status: 'error', dispatched: false });
  db.prepare("INSERT INTO ai_usage(user_id,model,input_tokens,output_tokens,created_at) VALUES(?, 'legacy', 6, 2, datetime('now', '-2 days'))").run(userId);

  const { data } = await stats(target, '?days=1');
  assert.deepEqual(data.rangeTotals, { aiInputTokens: 66, aiCacheReadTokens: 44, aiUncachedInputTokens: 22,
    aiOutputTokens: 3, aiTotalTokens: 69,
    aiRequests: 3, aiLegacyRuns: 0, aiUnknownUsageRequests: 1, aiPartialUsageRequests: 1 });
  assert.equal(data.daily[0].aiUncachedInputTokens, 22);
  assert.equal(data.hourly.reduce((sum, row) => sum + row.aiUncachedInputTokens, 0), 22);
  assert.equal(data.totals.aiInputTokens, 72);
  assert.equal(data.totals.aiOutputTokens, 5);
  assert.equal(data.totals.aiUncachedInputTokens, 28);
  assert.equal(data.totals.aiTotalTokens, 77);
  assert.equal(data.totals.aiLegacyRuns, 1);
  assert.deepEqual(data.models.map(row => [row.model, row.providerId, row.requests, row.inputTokens, row.cacheReadTokens,
    row.uncachedInputTokens, row.outputTokens, row.totalTokens]),
    [['shared-model', 'supplier-one', 2, 52, 40, 12, 3, 55], ['shared-model', 'supplier-two', 1, 14, 4, 10, 0, 14]]);
  const account = await api(srv.baseUrl, 'GET', '/api/users/me/usage', { token: target.token });
  assert.deepEqual(account.data.ai, { inputTokens: 72, cacheReadTokens: 44, uncachedInputTokens: 28, outputTokens: 5, totalTokens: 77,
    requests: 3, legacyRuns: 1, unknownUsageRequests: 1, partialUsageRequests: 1 });
  const global = await api(srv.baseUrl, 'GET', '/api/admin/stats', { token: admin.token });
  const user = global.data.perUser.find(row => row.userId === userId);
  assert.equal(user.aiInputTokens, 72);
  assert.equal(user.aiUncachedInputTokens, 28);
  assert.equal(user.aiTotalTokens, 77);
  assert.equal(user.aiRequests, 3);
  assert.equal(user.aiLegacyRuns, 1);
});

test('model distribution resolves account-owned provider names without exposing settings or guessing ambiguous global names', async () => {
  const first = await registerAndLogin(srv.baseUrl, 'stats-provider-first');
  const second = await registerAndLogin(srv.baseUrl, 'stats-provider-second');
  const { getDb } = await import('../src/db.js');
  const { recordAiUsage } = await import('../src/quotas.js');
  const db = getDb();
  const putSettings = (user, name) => db.prepare('UPDATE settings SET ai_providers = ? WHERE user_id = ?').run(
    JSON.stringify({ version: 2, providers: [
      { id: 'shared-provider-id', name, apiFormat: 'openai', baseUrl: 'https://private-provider.test/v1', apiKey: 'stats-secret-key', models: [] },
      { id: 'protocol-mismatch', name: '错误协议名称', apiFormat: 'anthropic', models: [] },
    ] }), user.user.id);
  putSettings(first, '主供应商'); putSettings(second, '另一供应商');
  const add = (user, providerId, model = 'name-resolution-model') => recordAiUsage({ userId: user.user.id,
    entry: { requestKey: randomUUID(), provider: 'openai', providerId, model,
      status: 'stop', startedAt: Date.now(), usage: { input: 10, output: 2, cacheRead: 20, cacheWrite: 0 } } });
  add(first, 'shared-provider-id'); add(second, 'shared-provider-id');
  add(first, 'deleted-provider', 'missing-provider-model');
  add(first, 'protocol-mismatch', 'protocol-mismatch-model');
  const own = (await stats(first, '?days=1')).data;
  assert.equal(own.models.find(row => row.model === 'name-resolution-model').providerName, '主供应商');
  assert.equal(own.models.find(row => row.model === 'missing-provider-model').providerName, null);
  assert.equal(own.models.find(row => row.model === 'protocol-mismatch-model').providerName, null);
  const selected = (await stats(admin, `?scope=user&userId=${first.user.id}&days=1`)).data;
  assert.deepEqual(selected.models, own.models);
  const globalRows = (await stats(admin, '?scope=global&days=1')).data.models;
  const merged = globalRows.find(row => row.model === 'name-resolution-model');
  assert.equal(merged.requests, 2); assert.equal(merged.inputTokens, 60);
  assert.equal(merged.providerName, null);
  for (const response of [own, selected, { models: globalRows }]) {
    const encoded = JSON.stringify(response);
    for (const forbidden of ['stats-secret-key', 'private-provider.test', 'contributorIds', 'ai_providers', 'apiKey', 'baseUrl']) {
      assert.ok(!encoded.includes(forbidden), forbidden);
    }
  }
  putSettings(second, '主供应商');
  assert.equal((await stats(admin, '?scope=global&days=1')).data.models
    .find(row => row.model === 'name-resolution-model').providerName, '主供应商');
});

test('model distribution resolves stable migrated provider IDs and keeps unattributed history unknown', async () => {
  const target = await registerAndLogin(srv.baseUrl, 'stats-provider-legacy');
  const { getDb } = await import('../src/db.js');
  const { recordAiUsage } = await import('../src/quotas.js');
  const db = getDb();
  db.prepare('UPDATE settings SET ai_models = ?, ai_providers = ? WHERE user_id = ?').run(JSON.stringify([
    { id: 'old-model', model: 'legacy-name-resolution', provider: 'openai', baseUrl: 'https://legacy-provider.test/v1', apiKey: 'legacy-secret' },
  ]), '', target.user.id);
  recordAiUsage({ userId: target.user.id, entry: { requestKey: randomUUID(), provider: 'openai', providerId: 'p_legacy_old-model',
    model: 'legacy-name-resolution', status: 'stop', startedAt: Date.now(), usage: { input: 1, output: 1, cacheRead: 2, cacheWrite: 0 } } });
  db.prepare("INSERT INTO ai_usage (user_id, model, input_tokens) VALUES (?, 'unattributed-model', 5)").run(target.user.id);
  const { data } = await stats(target, '?days=1');
  assert.equal(data.models.find(row => row.model === 'legacy-name-resolution').providerName, 'legacy-provider.test');
  const legacy = data.models.find(row => row.model === 'unattributed-model');
  assert.equal(legacy.providerName, null); assert.equal(legacy.legacyRuns, 1); assert.equal(legacy.requests, 0);
  assert.ok(!JSON.stringify(data).includes('legacy-secret'));
});
