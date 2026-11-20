
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'corelatex-tex-mirror-routes-'));
process.env.CORELATEX_DATA_DIR = path.join(temp, 'data');
let db, resetDb, server, base, adminToken, userToken, mirrorService, runtimeResources;

before(async () => {
  const dbModule = await import('../src/db.js');
  db = dbModule.getDb(); resetDb = dbModule.resetDb;
  const { signToken } = await import('../src/auth.js');
  for (const role of ['admin', 'user']) {
    const id = db.prepare('INSERT INTO users(username,password_hash,role) VALUES(?,?,?)').run('mirror-' + role, 'unused', role).lastInsertRowid;
    const token = signToken(db.prepare('SELECT * FROM users WHERE id = ?').get(id));
    if (role === 'admin') adminToken = token;
    else userToken = token;
  }
  mirrorService = await import('../src/services/texMirrors.js');
  runtimeResources = await import('../src/services/runtimeResources.js');
  const { createApp } = await import('../src/index.js');
  server = http.createServer(createApp());
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
});
after(async () => {
  server?.closeAllConnections();
  if (server) await new Promise(resolve => server.close(resolve));
  resetDb?.();
  assert.ok(temp.startsWith(path.join(os.tmpdir(), 'corelatex-tex-mirror-routes-')));
  fs.rmSync(temp, { recursive: true, force: true });
});

function request(pathname, { token, body, method = 'GET', transport = globalThis.fetch } = {}) {
  return transport(base + pathname, {
    method,
    headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

test('mirror configuration is administrator-only, validated and persisted in order', async () => {
  const endpoint = '/api/admin/runtime-resources/tex-mirrors';
  assert.equal((await request(endpoint)).status, 401);
  assert.equal((await request(endpoint, { token: userToken })).status, 403);
  assert.equal((await request(endpoint, { method: 'PUT', token: userToken, body: {} })).status, 403);
  const initial = await request(endpoint, { token: adminToken });
  assert.equal(initial.status, 200);
  const defaults = await initial.json();
  assert.ok(defaults.current.length >= 1);
  assert.ok(defaults.historic.every(url => url.includes('/{year}/')));

  const invalid = { current: [], historic: ['https://example.com/tex/{year}/tlnet-final'] };
  assert.equal((await request(endpoint, { method: 'PUT', token: adminToken, body: invalid })).status, 400);
  const badScheme = { current: ['http://example.com/tlnet'], historic: invalid.historic };
  assert.equal((await request(endpoint, { method: 'PUT', token: adminToken, body: badScheme })).status, 400);
  const wrongHistoric = { current: ['https://example.com/tlnet'], historic: ['https://example.com/tlnet'] };
  assert.equal((await request(endpoint, { method: 'PUT', token: adminToken, body: wrongHistoric })).status, 400);
  assert.deepEqual(await (await request(endpoint, { token: adminToken })).json(), defaults);

  const desired = {
    current: ['https://first.example.com/tlnet', 'https://second.example.com/tlnet'],
    historic: ['https://archive.example.com/tex/{year}/tlnet-final', 'https://backup.example.com/{year}/tlnet-final'],
  };
  const saved = await request(endpoint, { method: 'PUT', token: adminToken, body: desired });
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), desired);
  assert.deepEqual(await (await request(endpoint, { token: adminToken })).json(), desired);
  assert.deepEqual(mirrorService.getTexMirrorConfig(), desired);
  assert.deepEqual(JSON.parse(db.prepare("SELECT value FROM system_settings WHERE key = 'tex_mirrors'").get().value), desired);
  assert.deepEqual(mirrorService.texRepositories('2022'), [
    'https://archive.example.com/tex/2022/tlnet-final', 'https://backup.example.com/2022/tlnet-final',
  ]);
  assert.deepEqual(mirrorService.texRepositories('2026'), [
    ...desired.current, 'https://archive.example.com/tex/2026/tlnet-final', 'https://backup.example.com/2026/tlnet-final',
  ]);

  db.prepare("UPDATE users SET role = 'user' WHERE username = 'mirror-admin'").run();
  assert.equal((await request(endpoint, { token: adminToken })).status, 403);
  assert.equal((await request(endpoint, { method: 'PUT', token: adminToken, body: defaults })).status, 403);
  db.prepare("UPDATE users SET role = 'admin' WHERE username = 'mirror-admin'").run();
});

test('2022 is offered and accepted for installation without treating a failed download as success', async () => {
  const list = await request('/api/admin/tex/runtimes', { token: adminToken });
  assert.equal(list.status, 200);
  assert.ok((await list.json()).versions.some(item => item.version === '2022'));
  const nativeFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => { attempts++; throw new Error('offline test'); };
  try {
    const response = await request('/api/admin/runtime-resources/tex-versions', {
      method: 'POST', token: adminToken, body: { version: '2022' }, transport: nativeFetch,
    });
    assert.equal(response.status, 202);
    const { job } = await response.json();
    const deadline = Date.now() + 5000;
    let finished;
    do {
      finished = runtimeResources.listRuntimeJobs().find(item => item.id === job.id);
      if (finished && !['queued', 'running'].includes(finished.status)) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    } while (Date.now() < deadline);
    assert.equal(finished?.status, 'failed', 'network failure must remain visible');
    assert.ok(attempts >= 1);
    assert.equal(fs.existsSync(path.join(temp, 'data', 'runtime', 'texlive', '2022')), false);
  } finally {
    globalThis.fetch = nativeFetch;
  }
  assert.equal((await request('/api/admin/runtime-resources/tex-versions', {
    method: 'POST', token: adminToken, body: { version: '1900' },
  })).status, 400);
});
