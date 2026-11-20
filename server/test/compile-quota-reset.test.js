import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import express from 'express';
import { api } from './helpers.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'corelatex-quota-reset-'));
process.env.CORELATEX_DATA_DIR = dataDir;
let db, getDb, resetDb, auth, quotas, server, baseUrl, admin, token;
let serial = 0;
const today = () => new Date().toISOString().slice(0, 10);

before(async () => {
  ({ getDb, resetDb } = await import('../src/db.js'));
  db = getDb();
  auth = await import('../src/auth.js');
  quotas = await import('../src/quotas.js');
  admin = auth.register({ username: 'quota-admin', password: 'pass1234' });
  token = auth.signToken(admin);
  const app = express();
  app.use(express.json());
  app.use('/api/admin', auth.requireAuth, (await import('../src/routes/admin.js')).default);
  app.use('/api/users', auth.requireAuth, (await import('../src/routes/users.js')).default);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  resetDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function fixture({ quota = 300, used = 300, bonus = 0, date = today() } = {}) {
  const user = auth.register({ username: `quota-user-${++serial}`, password: 'pass1234' });
  db.prepare(`UPDATE users SET compile_seconds_quota = ?, compile_seconds_used = ?,
    compile_seconds_bonus = ?, compile_reset_date = ? WHERE id = ?`).run(quota, used, bonus, date, user.id);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
}

test('admin reset keeps five used minutes and grants five more, consistently in API and enforcement', async () => {
  const user = fixture();
  assert.throws(() => quotas.assertCompileQuota(user), {
    status: 403, code: 'COMPILE_QUOTA_EXHAUSTED', retryable: false,
  });
  const reset = await api(baseUrl, 'POST', `/api/admin/users/${user.id}/reset-compile`, { token });
  assert.equal(reset.status, 200);
  assert.equal(reset.data.user.compileSecondsUsed, 300);
  assert.equal(reset.data.user.compileSecondsQuota, 600);
  assert.equal(reset.data.user.compileSecondsBaseQuota, 300);
  assert.equal(reset.data.user.compileSecondsBonus, 300);
  assert.equal(reset.data.user.compileSecondsRemaining, 300);
  assert.doesNotThrow(() => quotas.assertCompileQuota(user), 'existing agent user snapshot sees the grant');
  const usage = await api(baseUrl, 'GET', '/api/users/me/usage', { token: auth.signToken(user) });
  assert.equal(usage.data.compileSecondsUsed, 300);
  assert.equal(usage.data.compileSecondsQuota, 600);
  const users = await api(baseUrl, 'GET', '/api/admin/users', { token });
  assert.equal(users.data.users.find((u) => u.id === user.id).compileSecondsQuota, 600);
  quotas.recordCompileSeconds(user.id, 300);
  assert.throws(() => quotas.assertCompileQuota(user), { status: 403 });
  const second = await api(baseUrl, 'POST', `/api/admin/users/${user.id}/reset-compile`, { token });
  assert.equal(second.data.user.compileSecondsUsed, 600);
  assert.equal(second.data.user.compileSecondsQuota, 900);
  assert.equal(second.data.user.compileSecondsBaseQuota, 300, 'base quota must not inflate after resets');
});

test('batch reset grants once per selected user, preserves usage, skips admin, and honors newly configured base', async () => {
  const a = fixture({ used: 120 });
  const b = fixture({ used: 200 });
  const response = await api(baseUrl, 'POST', '/api/admin/users/batch', {
    token, body: { userIds: [a.id, a.id, b.id, admin.id], patch: { resetCompile: true, compileSecondsQuota: 600 } },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(response.data, { updated: 2, skippedAdmins: 1 });
  for (const [user, used] of [[a, 120], [b, 200]]) {
    const usage = quotas.usageForUser(user);
    assert.equal(usage.compileSecondsUsed, used);
    assert.equal(usage.compileSecondsQuota, 1200);
    assert.equal(usage.compileSecondsBonus, 600);
    assert.equal(usage.compileSecondsBaseQuota, 600);
  }
  assert.equal(db.prepare('SELECT compile_seconds_bonus AS bonus FROM users WHERE id = ?').get(admin.id).bonus, 0);
});

test('reset while compilation is in progress retains usage recorded afterwards', () => {
  const user = fixture({ used: 250 });
  quotas.assertCompileQuota(user); // compile starts with this user snapshot
  quotas.grantDailyCompileQuota(db, user.id);
  quotas.recordCompileSeconds(user.id, 75.5); // in-flight compile finishes
  const usage = quotas.usageForUser(user);
  assert.equal(usage.compileSecondsUsed, 326);
  assert.equal(usage.compileSecondsQuota, 600);
  assert.equal(usage.compileSecondsRemaining, 274.5);
  assert.doesNotThrow(() => quotas.assertCompileQuota(user));
});

test('day rollover expires bonus and yesterday usage; compilation finishing today survives later reads', () => {
  const user = fixture({ used: 800, bonus: 600, date: '2000-01-01' });
  const publicUser = auth.publicUser(user);
  assert.equal(publicUser.compileSecondsUsed, 0, 'admin list and login cannot show stale daily usage');
  assert.equal(publicUser.compileSecondsQuota, 300);
  quotas.recordCompileSeconds(user.id, 25);
  const usage = quotas.usageForUser(user);
  assert.equal(usage.compileSecondsUsed, 25);
  assert.equal(usage.compileSecondsQuota, 300);
  assert.equal(usage.compileSecondsBonus, 0);
  assert.equal(quotas.applyDailyCompileReset(db, user.id), false, 'reset must be idempotent within a day');
});

test('reset on first access of a new day grants only today allowance', () => {
  const user = fixture({ used: 900, bonus: 600, date: '2000-01-01' });
  quotas.grantDailyCompileQuota(db, user.id);
  const usage = quotas.usageForUser(user);
  assert.equal(usage.compileSecondsUsed, 0);
  assert.equal(usage.compileSecondsQuota, 600);
  assert.equal(usage.compileSecondsBonus, 300);
});

test('quota checks use updated base even when caller retained an older unlimited or limited user', () => {
  const unlimited = fixture({ quota: -1, used: 300 });
  db.prepare('UPDATE users SET compile_seconds_quota = 100 WHERE id = ?').run(unlimited.id);
  assert.throws(() => quotas.assertCompileQuota(unlimited), { status: 403 });
  const limited = fixture();
  db.prepare('UPDATE users SET compile_seconds_quota = 600 WHERE id = ?').run(limited.id);
  assert.doesNotThrow(() => quotas.assertCompileQuota(limited));
});

test('zero and unlimited quotas do not receive fictitious grants or lose usage', () => {
  for (const quota of [0, -1]) {
    const user = fixture({ quota, used: 40 });
    quotas.grantDailyCompileQuota(db, user.id);
    const usage = quotas.usageForUser(user);
    assert.equal(usage.compileSecondsUsed, 40);
    assert.equal(usage.compileSecondsQuota, quota);
    assert.equal(usage.compileSecondsBonus, 0);
    if (quota === 0) assert.throws(() => quotas.assertCompileQuota(user), { status: 403 });
    else assert.doesNotThrow(() => quotas.assertCompileQuota(user));
  }
});

test('ordinary users cannot grant their own allowance through single or batch endpoints', async () => {
  const user = fixture();
  const userToken = auth.signToken(user);
  assert.equal((await api(baseUrl, 'POST', `/api/admin/users/${user.id}/reset-compile`, { token: userToken })).status, 403);
  assert.equal((await api(baseUrl, 'POST', '/api/admin/users/batch', {
    token: userToken, body: { userIds: [user.id], patch: { resetCompile: true } },
  })).status, 403);
  assert.equal(quotas.usageForUser(user).compileSecondsQuota, 300);
});

test('existing databases migrate with zero bonus and preserve their recorded usage', () => {
  const user = fixture({ used: 123 });
  db.exec('ALTER TABLE users DROP COLUMN compile_seconds_bonus');
  resetDb();
  db = getDb();
  const usage = quotas.usageForUser(user);
  assert.equal(usage.compileSecondsUsed, 123);
  assert.equal(usage.compileSecondsQuota, 300);
  assert.equal(usage.compileSecondsBonus, 0);
});
