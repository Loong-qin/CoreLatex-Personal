import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, api, registerAndLogin } from './helpers.js';

let srv, user, pid;
before(async () => {
  srv = await startTestServer();
  user = await registerAndLogin(srv.baseUrl, 'fileowner');
  const { data } = await api(srv.baseUrl, 'POST', '/api/projects', { token: user.token, body: { name: 'files' } });
  pid = data.project.publicId;
});
after(async () => { await srv.close(); });

test('文件树：新建文件/目录、层级结构、文本标记', async () => {
  await api(srv.baseUrl, 'POST', `/api/projects/${pid}/mkdir`, { token: user.token, body: { path: 'Fig' } });
  await api(srv.baseUrl, 'POST', `/api/projects/${pid}/files`, {
    token: user.token, body: { path: 'Fig/plot.tex', content: 'x' },
  });
  const { status, data } = await api(srv.baseUrl, 'GET', `/api/projects/${pid}/tree`, { token: user.token });
  assert.equal(status, 200);
  const fig = data.tree.find((n) => n.name === 'Fig');
  assert.ok(fig && fig.type === 'dir');
  assert.equal(fig.children[0].path, 'Fig/plot.tex');
  assert.equal(fig.children[0].text, true);
  assert.ok(data.tree.some((n) => n.name === 'main.tex'));
});

test('文件读写与保存覆盖', async () => {
  let r = await api(srv.baseUrl, 'POST', `/api/projects/${pid}/files`, {
    token: user.token, body: { path: 'a.tex', content: 'hello' },
  });
  assert.equal(r.status, 200);
  // 重复新建 409
  r = await api(srv.baseUrl, 'POST', `/api/projects/${pid}/files`, {
    token: user.token, body: { path: 'a.tex', content: 'x' },
  });
  assert.equal(r.status, 409);
  // overwrite 保存
  r = await api(srv.baseUrl, 'POST', `/api/projects/${pid}/files`, {
    token: user.token, body: { path: 'a.tex', content: 'v2', overwrite: true },
  });
  assert.equal(r.status, 200);
  const res = await api(srv.baseUrl, 'GET', `/api/projects/${pid}/file?path=a.tex`, { token: user.token, raw: true });
  assert.equal(await res.text(), 'v2');
});

test('路径安全：拒绝穿越与保留目录', async () => {
  for (const p of ['../x', '/etc/passwd', '.build/x.tex', '.versions/x']) {
    const r = await api(srv.baseUrl, 'POST', `/api/projects/${pid}/files`, {
      token: user.token, body: { path: p, content: 'x' },
    });
    assert.ok([400, 403].includes(r.status), `path=${p} got ${r.status}`);
  }
});

test('重命名/移动与删除', async () => {
  await api(srv.baseUrl, 'POST', `/api/projects/${pid}/files`, {
    token: user.token, body: { path: 'old.tex', content: 'o' },
  });
  let r = await api(srv.baseUrl, 'PATCH', `/api/projects/${pid}/files`, {
    token: user.token, body: { path: 'old.tex', newPath: 'Fig/new.tex' },
  });
  assert.equal(r.status, 200);
  r = await api(srv.baseUrl, 'DELETE', `/api/projects/${pid}/files?path=Fig/new.tex`, { token: user.token });
  assert.equal(r.status, 200);
  const res = await api(srv.baseUrl, 'GET', `/api/projects/${pid}/file?path=Fig/new.tex`, { token: user.token });
  assert.equal(res.status, 404);
});

test('上传：多文件含目录相对路径', async () => {
  const form = new FormData();
  form.append('files', new Blob(['% bib']), 'refs.bib');
  form.append('files', new Blob(['PNGDATA']), 'logo.png');
  form.append('paths', JSON.stringify(['refs.bib', 'assets/logo.png']));
  const r = await api(srv.baseUrl, 'POST', `/api/projects/${pid}/upload`, { token: user.token, body: form });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.saved.sort(), ['assets/logo.png', 'refs.bib']);
  const res = await api(srv.baseUrl, 'GET', `/api/projects/${pid}/file?path=assets/logo.png`, { token: user.token, raw: true });
  assert.equal(await res.text(), 'PNGDATA');
});


test('renaming the compilation entry and its directory preserves main file and human comments', async () => {
  const { data } = await api(srv.baseUrl, 'POST', '/api/projects', { token: user.token, body: { name: 'rename-entry' } });
  const id = data.project.publicId;
  const createComment = filePath => api(srv.baseUrl, 'POST', `/api/projects/${id}/reviews`, {
    token: user.token, body: { filePath, start: 0, end: 1, quotedText: '%', content: 'Please keep this comment attached.' },
  });
  assert.equal((await createComment('main.tex')).status, 201);
  let result = await api(srv.baseUrl, 'PATCH', `/api/projects/${id}/files`, {
    token: user.token, body: { path: 'main.tex', newPath: 'chapters/paper.tex' },
  });
  assert.equal(result.status, 200); assert.equal(result.data.mainFile, 'chapters/paper.tex');
  await api(srv.baseUrl, 'POST', `/api/projects/${id}/files`, {
    token: user.token, body: { path: 'chapters-old/keep.tex', content: 'keep' },
  });
  assert.equal((await createComment('chapters-old/keep.tex')).status, 201);
  result = await api(srv.baseUrl, 'PATCH', `/api/projects/${id}/files`, {
    token: user.token, body: { path: 'chapters', newPath: 'sections' },
  });
  assert.equal(result.status, 200); assert.equal(result.data.mainFile, 'sections/paper.tex');
  const project = await api(srv.baseUrl, 'GET', `/api/projects/${id}`, { token: user.token });
  assert.equal(project.data.project.mainFile, 'sections/paper.tex');
  const reviews = await api(srv.baseUrl, 'GET', `/api/projects/${id}/reviews`, { token: user.token });
  assert.deepEqual(reviews.data.reviews.map(r => r.filePath).sort(), ['chapters-old/keep.tex', 'sections/paper.tex']);
  const file = await api(srv.baseUrl, 'GET', `/api/projects/${id}/file?path=sections/paper.tex`, { token: user.token, raw: true });
  assert.equal(file.status, 200); assert.ok((await file.text()).includes('document'));
});

test('failed rename leaves compilation entry and comments at the original path', async () => {
  const { data } = await api(srv.baseUrl, 'POST', '/api/projects', { token: user.token, body: { name: 'rename-conflict' } });
  const id = data.project.publicId;
  await api(srv.baseUrl, 'POST', `/api/projects/${id}/files`, { token: user.token, body: { path: 'occupied.tex', content: 'occupied' } });
  const result = await api(srv.baseUrl, 'PATCH', `/api/projects/${id}/files`, {
    token: user.token, body: { path: 'main.tex', newPath: 'occupied.tex' },
  });
  assert.equal(result.status, 409);
  const project = await api(srv.baseUrl, 'GET', `/api/projects/${id}`, { token: user.token });
  assert.equal(project.data.project.mainFile, 'main.tex');
});
