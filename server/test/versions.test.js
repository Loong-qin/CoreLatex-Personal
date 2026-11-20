import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import express from 'express';
import { api, registerAndLogin } from './helpers.js';

// 必须在 import 任何 src 模块前设置数据目录（config.js 在模块加载时固化 DATA_DIR）
process.env.CORELATEX_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'corelatex-versions-test-'));
const dataDir = process.env.CORELATEX_DATA_DIR;

// index.js 尚未挂载本批路由（由接线任务负责），测试镜像 index.js 的挂载方式自建 app。
let server;
let baseUrl;
let adminToken; // 首个注册用户 alice = admin
let adminUser;

before(async () => {
  const { getDb } = await import('../src/db.js');
  const { ensureDataDirs } = await import('../src/config.js');
  const { requireAuth } = await import('../src/auth.js');
  ensureDataDirs();
  getDb();
  const authRoutes = (await import('../src/routes/auth.js')).default;
  const projectRoutes = (await import('../src/routes/projects.js')).default;
  const fileRoutes = (await import('../src/routes/files.js')).default;
  const versionRoutes = (await import('../src/routes/versions.js')).default;
  const reviewRoutes = (await import('../src/routes/reviews.js')).default;
  const adminRoutes = (await import('../src/routes/admin.js')).default;

  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use('/api/auth', authRoutes);
  app.use('/api/projects', requireAuth, projectRoutes);
  app.use('/api/projects', requireAuth, fileRoutes);
  app.use('/api/projects', requireAuth, versionRoutes);
  app.use('/api/projects', requireAuth, reviewRoutes);
  app.use('/api/admin', requireAuth, adminRoutes);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err?.status) return res.status(err.status).json({ error: err.message });
    console.error('[test server error]', err);
    res.status(500).json({ error: '服务器内部错误' });
  });
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const a = await registerAndLogin(baseUrl, 'alice');
  adminToken = a.token;
  adminUser = a.user;
});

after(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function saveFile(token, pid, p, content) {
  const r = await api(baseUrl, 'POST', `/api/projects/${pid}/files`, {
    token, body: { path: p, content, overwrite: true },
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
}

test('版本：快照 → 再改 → diff → 恢复', async () => {
  const { data: created } = await api(baseUrl, 'POST', '/api/projects', {
    token: adminToken, body: { name: 'vtest' },
  });
  const pid = created.project.publicId;
  const pdir = path.join(dataDir, 'projects', String(created.project.id));

  await saveFile(adminToken, pid, 'main.tex', 'line1\nline2\n');
  const r1 = await api(baseUrl, 'POST', `/api/projects/${pid}/versions`, {
    token: adminToken, body: { message: '初始版本' },
  });
  assert.equal(r1.status, 201, JSON.stringify(r1.data));
  assert.equal(r1.data.version.message, '初始版本');
  assert.equal(r1.data.version.adds, 2); // 首版本 adds = 全部行数
  assert.equal(r1.data.version.dels, 0);
  assert.ok(fs.existsSync(path.join(pdir, '.versions', `v${r1.data.version.id}.zip`)), '快照 zip 已写盘');

  await saveFile(adminToken, pid, 'main.tex', 'line1\nline2\nline3\n');
  const r2 = await api(baseUrl, 'POST', `/api/projects/${pid}/versions`, {
    token: adminToken, body: {},
  });
  assert.equal(r2.status, 201);
  assert.equal(r2.data.version.message, '已更改 main.tex'); // 自动生成
  assert.equal(r2.data.version.adds, 1);
  assert.equal(r2.data.version.dels, 0);

  const list = await api(baseUrl, 'GET', `/api/projects/${pid}/versions`, { token: adminToken });
  assert.equal(list.status, 200);
  assert.equal(list.data.versions.length, 2);
  assert.equal(list.data.versions[0].id, r2.data.version.id); // id desc
  assert.equal(list.data.versions[0].userName, 'alice');
  assert.deepEqual(
    list.data.versions[0].files.map((f) => [f.path, f.adds, f.dels]),
    [['main.tex', 1, 0]]
  );

  const diff = await api(baseUrl, 'GET', `/api/projects/${pid}/versions/${r2.data.version.id}`, { token: adminToken });
  assert.equal(diff.status, 200);
  assert.equal(diff.data.version.id, r2.data.version.id);
  const d = diff.data.diffs.find((x) => x.path === 'main.tex');
  assert.ok(d, 'diff 含 main.tex');
  assert.ok(d.patch.includes('+line3'), `patch 含新增行: ${d.patch}`);
  assert.ok(d.patch.includes('--- a/main.tex'));

  const rr = await api(baseUrl, 'POST', `/api/projects/${pid}/versions/${r1.data.version.id}/restore`, { token: adminToken });
  assert.equal(rr.status, 200);
  assert.equal(rr.data.ok, true);
  assert.equal(fs.readFileSync(path.join(pdir, 'main.tex'), 'utf8'), 'line1\nline2\n');

  // 多文件自动 message + 权限
  await saveFile(adminToken, pid, 'a.tex', 'a\n');
  await saveFile(adminToken, pid, 'b.tex', 'b\n');
  const r3 = await api(baseUrl, 'POST', `/api/projects/${pid}/versions`, { token: adminToken, body: {} });
  // v3 相对 v2：main.tex 因恢复少一行（modified）+ 新增 a.tex/b.tex
  assert.equal(r3.data.version.message, '已更改 1 个文件，已添加 2 个文件');
  assert.equal(r3.data.version.dels, 1);

  const { token: stranger } = await registerAndLogin(baseUrl, 'stranger1');
  const denied = await api(baseUrl, 'GET', `/api/projects/${pid}/versions`, { token: stranger });
  assert.equal(denied.status, 403);
  const missing = await api(baseUrl, 'GET', `/api/projects/${pid}/versions/9999`, { token: adminToken });
  assert.equal(missing.status, 404);
});

test('评论：创建/列表/resolve/unresolve/删除权限/reanchor', async () => {
  const { data: created } = await api(baseUrl, 'POST', '/api/projects', {
    token: adminToken, body: { name: 'rtest' },
  });
  const pid = created.project.publicId;
  const { token: member } = await registerAndLogin(baseUrl, 'member1');
  const addM = await api(baseUrl, 'POST', `/api/projects/${pid}/members`, {
    token: adminToken, body: { username: 'member1', role: 'editor' },
  });
  assert.equal(addM.status, 200);

  // 校验
  const bad1 = await api(baseUrl, 'POST', `/api/projects/${pid}/reviews`, {
    token: adminToken, body: { filePath: 'main.tex', start: 0, end: 5, content: '' },
  });
  assert.equal(bad1.status, 400);
  const bad2 = await api(baseUrl, 'POST', `/api/projects/${pid}/reviews`, {
    token: adminToken, body: { filePath: 'main.tex', start: 9, end: 5, content: 'x' },
  });
  assert.equal(bad2.status, 400);

  const c1 = await api(baseUrl, 'POST', `/api/projects/${pid}/reviews`, {
    token: adminToken,
    body: { filePath: 'main.tex', start: 0, end: 5, quotedText: 'line1', content: '这里需要修改' },
  });
  assert.equal(c1.status, 201, JSON.stringify(c1.data));
  const rid = c1.data.review.id;
  assert.equal(c1.data.review.status, 'open');
  assert.equal(c1.data.review.quotedText, 'line1');
  assert.equal(c1.data.review.authorName, 'alice');

  const list = await api(baseUrl, 'GET', `/api/projects/${pid}/reviews?file=main.tex`, { token: adminToken });
  assert.equal(list.data.reviews.length, 1);
  assert.equal(list.data.reviews[0].start, 0);
  assert.equal(list.data.reviews[0].end, 5);

  // 新规则：批注需至少一条回复后才能标记完成（无回复 resolve 被拒 400）
  const blocked = await api(baseUrl, 'POST', `/api/projects/${pid}/reviews/${rid}/resolve`, { token: adminToken });
  assert.equal(blocked.status, 400);
  const rep = await api(baseUrl, 'POST', `/api/projects/${pid}/reviews/${rid}/replies`, {
    token: adminToken, body: { content: '已确认，可以完成' },
  });
  assert.equal(rep.status, 201);
  assert.equal(rep.data.reply.content, '已确认，可以完成');

  const rs = await api(baseUrl, 'POST', `/api/projects/${pid}/reviews/${rid}/resolve`, { token: adminToken });
  assert.equal(rs.data.review.status, 'done');
  assert.equal(rs.data.review.resolvedBy, adminUser.id);
  assert.ok(rs.data.review.resolvedAt);
  const urs = await api(baseUrl, 'POST', `/api/projects/${pid}/reviews/${rid}/unresolve`, { token: adminToken });
  assert.equal(urs.data.review.status, 'open');
  assert.equal(urs.data.review.resolvedBy, null);

  // 非作者非 owner（但是 editor）删除被拒
  const denied = await api(baseUrl, 'DELETE', `/api/projects/${pid}/reviews/${rid}`, { token: member });
  assert.equal(denied.status, 403);

  // member 自己建的评论可自删
  const c2 = await api(baseUrl, 'POST', `/api/projects/${pid}/reviews`, {
    token: member, body: { filePath: 'main.tex', start: 2, end: 8, content: 'member 的意见' },
  });
  assert.equal(c2.status, 201);
  const delOwn = await api(baseUrl, 'DELETE', `/api/projects/${pid}/reviews/${c2.data.review.id}`, { token: member });
  assert.equal(delOwn.status, 200);

  // 作者（也是 owner）删除成功
  const del = await api(baseUrl, 'DELETE', `/api/projects/${pid}/reviews/${rid}`, { token: adminToken });
  assert.equal(del.status, 200);

  // reanchor
  const c3 = await api(baseUrl, 'POST', `/api/projects/${pid}/reviews`, {
    token: adminToken, body: { filePath: 'main.tex', start: 0, end: 5, content: '重锚测试' },
  });
  const ra = await api(baseUrl, 'POST', `/api/projects/${pid}/reviews/reanchor`, {
    token: adminToken, body: { updates: [{ id: c3.data.review.id, start: 10, end: 20 }] },
  });
  assert.equal(ra.status, 200);
  const list2 = await api(baseUrl, 'GET', `/api/projects/${pid}/reviews`, { token: adminToken });
  const reanchored = list2.data.reviews.find((r) => r.id === c3.data.review.id);
  assert.equal(reanchored.start, 10);
  assert.equal(reanchored.end, 20);
});

test('管理后台：stats/建用户/配额/重置密码/禁用/删除', async () => {
  // 普通用户访问 403
  const { token: dave } = await registerAndLogin(baseUrl, 'dave1');
  const forbidden = await api(baseUrl, 'GET', '/api/admin/stats', { token: dave });
  assert.equal(forbidden.status, 403);
  const forbidden2 = await api(baseUrl, 'POST', '/api/admin/users', {
    token: dave, body: { username: 'xxx1', password: 'pass1234' },
  });
  assert.equal(forbidden2.status, 403);

  const stats = await api(baseUrl, 'GET', '/api/admin/stats', { token: adminToken });
  assert.equal(stats.status, 200, JSON.stringify(stats.data));
  for (const k of ['userCount', 'projectCount', 'totalStorageBytes', 'totalCompileSeconds', 'perUser']) {
    assert.ok(k in stats.data, `stats 缺字段 ${k}`);
  }
  assert.ok(Array.isArray(stats.data.perUser));
  assert.ok(stats.data.perUser.length >= 2);
  const pa = stats.data.perUser.find((u) => u.username === 'alice');
  for (const k of ['userId', 'username', 'displayName', 'projectCount', 'storageBytes', 'compileSecondsUsed']) {
    assert.ok(k in pa, `perUser 缺字段 ${k}`);
  }
  assert.ok(pa.projectCount >= 2, 'alice 有两个项目');

  // 创建用户；role=admin 被拒
  const badRole = await api(baseUrl, 'POST', '/api/admin/users', {
    token: adminToken, body: { username: 'fakeadmin', password: 'pass1234', role: 'admin' },
  });
  assert.equal(badRole.status, 400);
  const cu = await api(baseUrl, 'POST', '/api/admin/users', {
    token: adminToken, body: { username: 'carol', password: 'pass1234', displayName: 'Carol' },
  });
  assert.equal(cu.status, 201, JSON.stringify(cu.data));
  assert.equal(cu.data.user.role, 'user');
  const carolId = cu.data.user.id;

  // 配额生效：projectQuota=0 → 建项目 403（走已有 quota 逻辑）
  const pq = await api(baseUrl, 'PATCH', `/api/admin/users/${carolId}`, {
    token: adminToken, body: { projectQuota: 0 },
  });
  assert.equal(pq.status, 200);
  assert.equal(pq.data.user.projectQuota, 0);
  const carolLogin = await api(baseUrl, 'POST', '/api/auth/login', { body: { username: 'carol', password: 'pass1234' } });
  const carolToken = carolLogin.data.token;
  const blocked = await api(baseUrl, 'POST', '/api/projects', { token: carolToken, body: { name: 'blocked' } });
  assert.equal(blocked.status, 403);

  // 放开配额 + 其他字段
  const pq2 = await api(baseUrl, 'PATCH', `/api/admin/users/${carolId}`, {
    token: adminToken,
    body: { projectQuota: -1, compileSecondsQuota: 120, storageQuotaBytes: 104857600, displayName: 'Carol C' },
  });
  assert.equal(pq2.data.user.compileSecondsQuota, 120);
  assert.equal(pq2.data.user.storageQuotaBytes, 104857600);
  assert.equal(pq2.data.user.displayName, 'Carol C');
  const badStatus = await api(baseUrl, 'PATCH', `/api/admin/users/${carolId}`, {
    token: adminToken, body: { status: 'banned' },
  });
  assert.equal(badStatus.status, 400);

  // 重置编译计时
  const rc = await api(baseUrl, 'POST', `/api/admin/users/${carolId}/reset-compile`, { token: adminToken });
  assert.equal(rc.status, 200);
  const users1 = await api(baseUrl, 'GET', '/api/admin/users', { token: adminToken });
  assert.equal(users1.data.users.find((u) => u.id === carolId).compileSecondsUsed, 0);

  // 重置密码后新密码可登录
  const rp = await api(baseUrl, 'POST', `/api/admin/users/${carolId}/reset-password`, {
    token: adminToken, body: { password: 'newpass88' },
  });
  assert.equal(rp.status, 200);
  const relogin = await api(baseUrl, 'POST', '/api/auth/login', { body: { username: 'carol', password: 'newpass88' } });
  assert.equal(relogin.status, 200);
  const carolToken2 = relogin.data.token;

  // 禁用 → 登录 403 → 恢复
  const dis = await api(baseUrl, 'PATCH', `/api/admin/users/${carolId}`, {
    token: adminToken, body: { status: 'disabled' },
  });
  assert.equal(dis.status, 200);
  const disLogin = await api(baseUrl, 'POST', '/api/auth/login', { body: { username: 'carol', password: 'newpass88' } });
  assert.equal(disLogin.status, 403);
  await api(baseUrl, 'PATCH', `/api/admin/users/${carolId}`, { token: adminToken, body: { status: 'active' } });

  // admin 自我保护
  const disAdmin = await api(baseUrl, 'PATCH', `/api/admin/users/${adminUser.id}`, {
    token: adminToken, body: { status: 'disabled' },
  });
  assert.equal(disAdmin.status, 400);
  const delAdmin = await api(baseUrl, 'DELETE', `/api/admin/users/${adminUser.id}`, { token: adminToken });
  assert.equal(delAdmin.status, 400);

  // carol 建项目 → 删除 carol → 磁盘目录消失、登录失效
  const cp = await api(baseUrl, 'POST', '/api/projects', { token: carolToken2, body: { name: 'carol-proj' } });
  assert.equal(cp.status, 201);
  const carolPid = cp.data.project.id;
  const carolPdir = path.join(dataDir, 'projects', String(carolPid));
  assert.ok(fs.existsSync(carolPdir));
  const del = await api(baseUrl, 'DELETE', `/api/admin/users/${carolId}`, { token: adminToken });
  assert.equal(del.status, 200);
  assert.ok(!fs.existsSync(carolPdir), '删除用户后其项目磁盘目录已清理');
  const goneLogin = await api(baseUrl, 'POST', '/api/auth/login', { body: { username: 'carol', password: 'newpass88' } });
  assert.equal(goneLogin.status, 401);
});
