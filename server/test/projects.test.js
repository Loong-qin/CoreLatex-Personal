import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTestServer, api, registerAndLogin } from './helpers.js';

let srv;
let admin, bob;
before(async () => {
  srv = await startTestServer();
  admin = await registerAndLogin(srv.baseUrl, 'owner1');
  bob = await registerAndLogin(srv.baseUrl, 'user1');
});
after(async () => { await srv.close(); });

async function createProject(token, name = 'paper') {
  const { status, data } = await api(srv.baseUrl, 'POST', '/api/projects', { token, body: { name } });
  assert.equal(status, 201);
  return data.project;
}

test('项目生命周期：创建→列表→归档→删除→回收站→恢复→彻底删除', async () => {
  const p = await createProject(admin.token, 'lifecycle');
  assert.equal(p.name, 'lifecycle');
  assert.equal(p.role, 'owner');

  let { data } = await api(srv.baseUrl, 'GET', '/api/projects?view=all', { token: admin.token });
  assert.ok(data.projects.some((x) => x.id === p.id));

  // 归档
  await api(srv.baseUrl, 'POST', `/api/projects/${p.publicId}/archive`, { token: admin.token });
  ({ data } = await api(srv.baseUrl, 'GET', '/api/projects?view=all', { token: admin.token }));
  assert.ok(!data.projects.some((x) => x.id === p.id), '归档后不在所有项目');
  ({ data } = await api(srv.baseUrl, 'GET', '/api/projects?view=archived', { token: admin.token }));
  assert.ok(data.projects.some((x) => x.id === p.id));

  // 归档项目拒绝写入
  const w = await api(srv.baseUrl, 'POST', `/api/projects/${p.publicId}/files`, {
    token: admin.token, body: { path: 'x.tex', content: 'x' },
  });
  assert.equal(w.status, 403);

  await api(srv.baseUrl, 'POST', `/api/projects/${p.publicId}/unarchive`, { token: admin.token });

  // 删除→回收站→恢复→删除→彻底删除
  await api(srv.baseUrl, 'POST', `/api/projects/${p.publicId}/delete`, { token: admin.token });
  ({ data } = await api(srv.baseUrl, 'GET', '/api/projects?view=trash', { token: admin.token }));
  assert.ok(data.projects.some((x) => x.id === p.id));
  await api(srv.baseUrl, 'POST', `/api/projects/${p.publicId}/restore`, { token: admin.token });
  ({ data } = await api(srv.baseUrl, 'GET', '/api/projects?view=all', { token: admin.token }));
  assert.ok(data.projects.some((x) => x.id === p.id));
  await api(srv.baseUrl, 'POST', `/api/projects/${p.publicId}/delete`, { token: admin.token });
  const purge = await api(srv.baseUrl, 'POST', `/api/projects/${p.publicId}/purge`, { token: admin.token });
  assert.equal(purge.status, 200);
  const gone = await api(srv.baseUrl, 'GET', `/api/projects/${p.publicId}`, { token: admin.token });
  assert.equal(gone.status, 404);
});

test('共享：成员可见于"与我共享"，viewer 只读，非成员无权', async () => {
  const p = await createProject(admin.token, 'shared-proj');
  // 非成员不可见
  let r = await api(srv.baseUrl, 'GET', `/api/projects/${p.publicId}`, { token: bob.token });
  assert.equal(r.status, 403);
  // 添加 viewer
  r = await api(srv.baseUrl, 'POST', `/api/projects/${p.publicId}/members`, {
    token: admin.token, body: { username: 'user1', role: 'viewer' },
  });
  assert.equal(r.status, 200);
  r = await api(srv.baseUrl, 'GET', '/api/projects?view=shared', { token: bob.token });
  assert.ok(r.data.projects.some((x) => x.id === p.id));
  // viewer 可读不可写
  r = await api(srv.baseUrl, 'GET', `/api/projects/${p.publicId}/tree`, { token: bob.token });
  assert.equal(r.status, 200);
  r = await api(srv.baseUrl, 'POST', `/api/projects/${p.publicId}/files`, {
    token: bob.token, body: { path: 'evil.tex', content: 'x' },
  });
  assert.equal(r.status, 403);
  // 移除成员后无权
  const members = await api(srv.baseUrl, 'GET', `/api/projects/${p.publicId}/members`, { token: admin.token });
  const uid = members.data.members[0].userId;
  await api(srv.baseUrl, 'DELETE', `/api/projects/${p.publicId}/members/${uid}`, { token: admin.token });
  r = await api(srv.baseUrl, 'GET', `/api/projects/${p.publicId}`, { token: bob.token });
  assert.equal(r.status, 403);
});

test('项目设置：重命名、引擎校验、mainFile 校验', async () => {
  const p = await createProject(admin.token, 'settings-proj');
  let r = await api(srv.baseUrl, 'PATCH', `/api/projects/${p.publicId}`, {
    token: admin.token, body: { name: 'renamed', compileEngine: 'pdflatex' },
  });
  assert.equal(r.status, 200);
  r = await api(srv.baseUrl, 'PATCH', `/api/projects/${p.publicId}`, {
    token: admin.token, body: { compileEngine: 'badengine' },
  });
  assert.equal(r.status, 400);
  r = await api(srv.baseUrl, 'PATCH', `/api/projects/${p.publicId}`, {
    token: admin.token, body: { mainFile: '../evil.tex' },
  });
  assert.equal(r.status, 400);
});

test('项目数量配额：超限拒绝创建', async () => {
  const dave = await registerAndLogin(srv.baseUrl, 'dave');
  // admin 设置 dave 配额为 1（直接操作 DB 模拟，管理 API 在后续任务）
  const { getDb } = await import('../src/db.js');
  getDb().prepare('UPDATE users SET project_quota = 1 WHERE username = ?').run('dave');
  await createProject(dave.token, 'd1');
  const r = await api(srv.baseUrl, 'POST', '/api/projects', { token: dave.token, body: { name: 'd2' } });
  assert.equal(r.status, 403);
});

test('zip 导入导出', async () => {
  const p = await createProject(admin.token, 'zip-src');
  await api(srv.baseUrl, 'POST', `/api/projects/${p.publicId}/files`, {
    token: admin.token, body: { path: 'chapters/intro.tex', content: '\\section{Intro}' },
  });
  // 导出
  const res = await api(srv.baseUrl, 'GET', `/api/projects/${p.publicId}/export`, { token: admin.token, raw: true });
  assert.equal(res.status, 200);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.ok(buf.length > 100);
  // 导入（需要 form-data 构造 zip 上传）
  const form = new FormData();
  form.append('file', new Blob([buf], { type: 'application/zip' }), 'roundtrip.zip');
  const imp = await api(srv.baseUrl, 'POST', '/api/projects/import', { token: admin.token, body: form });
  assert.equal(imp.status, 201);
  const tree = await api(srv.baseUrl, 'GET', `/api/projects/${imp.data.project.publicId}/tree`, { token: admin.token });
  const names = JSON.stringify(tree.data.tree);
  assert.ok(names.includes('intro.tex'), '导入后保留目录结构');
  assert.ok(names.includes('main.tex'));
});

test('summary project lists preserve metadata and access filtering without scanning project files', async (t) => {
  const mine = await createProject(admin.token, 'summary-owned');
  const shared = await createProject(bob.token, 'summary-shared-archived');
  const privateProject = await createProject(bob.token, 'summary-private');
  assert.equal((await api(srv.baseUrl, 'POST', `/api/projects/${shared.publicId}/members`, {
    token: bob.token, body: { username: 'owner1', role: 'viewer' },
  })).status, 200);
  assert.equal((await api(srv.baseUrl, 'POST', `/api/projects/${shared.publicId}/archive`, { token: bob.token })).status, 200);
  const scans = [];
  const readDirectory = fs.readdirSync;
  const projectRoot = path.join(srv.dataDir, 'projects') + path.sep;
  t.mock.method(fs, 'readdirSync', function (directory, ...args) {
    if (String(directory).startsWith(projectRoot)) scans.push(String(directory));
    return readDirectory.call(this, directory, ...args);
  });
  const openDirectory = fs.promises.opendir;
  t.mock.method(fs.promises, 'opendir', function (directory, ...args) {
    if (String(directory).startsWith(projectRoot)) scans.push(String(directory));
    return openDirectory.call(this, directory, ...args);
  });
  for (const [view, expected] of [['all', mine], ['archived', shared]]) {
    const full = await api(srv.baseUrl, 'GET', `/api/projects?view=${view}&q=summary`, { token: admin.token });
    assert.equal(full.status, 200);
    assert.equal(full.data.projects.length, 1);
    assert.equal(full.data.projects[0].id, expected.id);
    assert.ok(full.data.projects[0].sizeBytes > 0);
    assert.ok(scans.length > 0, 'ordinary lists still provide the existing sizeBytes field');
    scans.length = 0;
    const summary = await api(srv.baseUrl, 'GET', `/api/projects?view=${view}&q=summary&summary=1`, { token: admin.token });
    assert.equal(summary.status, 200);
    const { sizeBytes, ...metadata } = full.data.projects[0];
    assert.deepEqual(summary.data.projects, [metadata]);
    assert.equal(summary.data.projects.some((project) => project.id === privateProject.id), false);
    assert.deepEqual(scans, [], 'summary lists must not recurse through any project directory');
  }
  const unauthenticated = await api(srv.baseUrl, 'GET', '/api/projects?summary=1');
  assert.equal(unauthenticated.status, 401);
});
