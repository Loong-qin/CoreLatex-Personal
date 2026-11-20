import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, api, registerAndLogin } from './helpers.js';

let srv;
before(async () => { srv = await startTestServer(); });
after(async () => { await srv.close(); });

test('注册：首个用户成为管理员，后续为普通用户', async () => {
  const u1 = await registerAndLogin(srv.baseUrl, 'alice');
  assert.equal(u1.user.role, 'admin');
  const u2 = await registerAndLogin(srv.baseUrl, 'bob');
  assert.equal(u2.user.role, 'user');
});

test('注册：拒绝重复用户名与弱输入', async () => {
  const dup = await api(srv.baseUrl, 'POST', '/api/auth/register', { body: { username: 'alice', password: 'xxxx' } });
  assert.equal(dup.status, 409);
  const bad = await api(srv.baseUrl, 'POST', '/api/auth/register', { body: { username: 'a', password: 'xxxx' } });
  assert.equal(bad.status, 400);
});

test('登录：错误密码 401，未认证请求 401', async () => {
  const bad = await api(srv.baseUrl, 'POST', '/api/auth/login', { body: { username: 'alice', password: 'wrong' } });
  assert.equal(bad.status, 401);
  const noauth = await api(srv.baseUrl, 'GET', '/api/projects');
  assert.equal(noauth.status, 401);
});

test('me：返回用户与用量', async () => {
  const { token } = await registerAndLogin(srv.baseUrl, 'carol');
  const { status, data } = await api(srv.baseUrl, 'GET', '/api/auth/me', { token });
  assert.equal(status, 200);
  assert.equal(data.user.username, 'carol');
  assert.equal(data.usage.projectCount, 0);
});
