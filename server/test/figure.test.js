import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { startTestServer, api, registerAndLogin } from './helpers.js';

// 最小合法 PDF（无 xref，poppler 会自动重建）
const MIN_PDF = `%PDF-1.1
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >> endobj
trailer << /Root 1 0 R >>
%%EOF
`;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

const hasPdftoppm = !spawnSync('pdftoppm', ['-v']).error;

let srv, owner, pid;
before(async () => {
  srv = await startTestServer();
  owner = await registerAndLogin(srv.baseUrl, 'figowner');
  const { data } = await api(srv.baseUrl, 'POST', '/api/projects', { token: owner.token, body: { name: 'figures' } });
  pid = data.project.publicId;
});
after(async () => { await srv.close(); });

test('figure：权限与 404', async () => {
  // 未登录
  let r = await api(srv.baseUrl, 'GET', `/api/projects/${pid}/figure?path=x.pdf`);
  assert.equal(r.status, 401);
  // 非成员
  const stranger = await registerAndLogin(srv.baseUrl, 'figstranger');
  r = await api(srv.baseUrl, 'GET', `/api/projects/${pid}/figure?path=x.pdf`, { token: stranger.token });
  assert.equal(r.status, 403);
  // 不存在
  r = await api(srv.baseUrl, 'GET', `/api/projects/${pid}/figure?path=nope.pdf`, { token: owner.token });
  assert.equal(r.status, 404);
});

test('figure：非 PDF 文件按原样透传', async () => {
  const form = new FormData();
  form.append('files', new Blob([PNG_MAGIC]), 'logo.png');
  form.append('paths', JSON.stringify(['assets/logo.png']));
  await api(srv.baseUrl, 'POST', `/api/projects/${pid}/upload`, { token: owner.token, body: form });
  const res = await api(srv.baseUrl, 'GET', `/api/projects/${pid}/figure?path=assets/logo.png`, { token: owner.token, raw: true });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  const buf = Buffer.from(await res.arrayBuffer());
  assert.deepEqual(buf, PNG_MAGIC);
});

test('figure：PDF 经 pdftoppm 转 PNG 并缓存', { skip: !hasPdftoppm && 'pdftoppm 不可用' }, async () => {
  const form = new FormData();
  form.append('files', new Blob([Buffer.from(MIN_PDF, 'utf8')]), 'fig.pdf');
  form.append('paths', JSON.stringify(['Fig/fig.pdf']));
  await api(srv.baseUrl, 'POST', `/api/projects/${pid}/upload`, { token: owner.token, body: form });

  const res = await api(srv.baseUrl, 'GET', `/api/projects/${pid}/figure?path=Fig/fig.pdf`, { token: owner.token, raw: true });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  const buf = Buffer.from(await res.arrayBuffer());
  assert.deepEqual(buf.subarray(0, 4), PNG_MAGIC);

  // 第二次命中缓存（结果一致）
  const res2 = await api(srv.baseUrl, 'GET', `/api/projects/${pid}/figure?path=Fig/fig.pdf`, { token: owner.token, raw: true });
  assert.equal(res2.status, 200);
  const buf2 = Buffer.from(await res2.arrayBuffer());
  assert.deepEqual(buf2.subarray(0, 4), PNG_MAGIC);
});

test('figure：路径安全（拒绝穿越与保留目录）', async () => {
  for (const p of ['../x.pdf', '/etc/passwd', '.build/figures/x.png']) {
    const r = await api(srv.baseUrl, 'GET', `/api/projects/${pid}/figure?path=${encodeURIComponent(p)}`, { token: owner.token });
    assert.ok([400, 403].includes(r.status), `path=${p} got ${r.status}`);
  }
});
