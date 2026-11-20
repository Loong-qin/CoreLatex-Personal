import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as syncProtocol from 'y-protocols/sync';
import { startTestServer, api, registerAndLogin } from './helpers.js';

let srv;

before(async () => {
  // startServer 内部已 setupCollab，无需重复挂载（重复挂载会导致同一 socket 两次 handleUpgrade）
  srv = await startTestServer();
});

after(async () => {
  await srv.close();
});

function wsUrl(project, file, token) {
  const base = srv.baseUrl.replace('http', 'ws');
  let u = `${base}/collab?project=${project}&file=${encodeURIComponent(file)}`;
  if (token) u += `&token=${encodeURIComponent(token)}`;
  return u;
}

/** 手工 y-protocols 客户端：本地 doc 变更 → 发 update；收 sync → 应用并应答 */
function connectSync(url) {
  const doc = new Y.Doc();
  const ws = new WebSocket(url);
  const opened = new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  ws.on('message', (data) => {
    const decoder = decoding.createDecoder(new Uint8Array(data));
    let type;
    try { type = decoding.readVarUint(decoder); } catch { return; }
    if (type !== 0) return; // awareness 不在测试中处理
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 0);
    try { syncProtocol.readSyncMessage(decoder, encoder, doc, 'remote'); } catch { return; }
    if (encoding.length(encoder) > 1 && ws.readyState === ws.OPEN) {
      ws.send(encoding.toUint8Array(encoder));
    }
  });
  doc.on('update', (update, origin) => {
    if (origin === 'remote' || ws.readyState !== ws.OPEN) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 0);
    syncProtocol.writeUpdate(encoder, update);
    ws.send(encoding.toUint8Array(encoder));
  });
  opened.then(() => {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 0);
    syncProtocol.writeSyncStep1(encoder, doc);
    ws.send(encoding.toUint8Array(encoder));
  }).catch(() => {});
  return { ws, doc, opened };
}

async function waitFor(cond, what, timeout = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    let ok = false;
    try { ok = cond(); } catch {}
    if (ok) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`等待超时: ${what}`);
}

test('协同：双客户端同步 + 断线落盘', async () => {
  const { token } = await registerAndLogin(srv.baseUrl, 'alice');
  const { data } = await api(srv.baseUrl, 'POST', '/api/projects', { token, body: { name: 'collab' } });
  const pid = data.project.publicId;
  const file = 'collab.tex';
  assert.equal((await api(srv.baseUrl, 'POST', `/api/projects/${pid}/files`, { token, body: { path: file, content: '' } })).status, 200);

  const A = connectSync(wsUrl(pid, file, token));
  await A.opened;
  const B = connectSync(wsUrl(pid, file, token));
  await B.opened;

  A.doc.getText('content').insert(0, 'hello collab\n');
  await waitFor(() => B.doc.getText('content').toString() === 'hello collab\n', 'B 同步 A 的插入');

  B.doc.getText('content').insert(0, '% from B\n');
  await waitFor(
    () => A.doc.getText('content').toString() === '% from B\nhello collab\n',
    'A 同步 B 的插入'
  );

  A.ws.close();
  B.ws.close();
  const diskPath = path.join(srv.dataDir, 'projects', String(data.project.id), file);
  await waitFor(
    () => fs.existsSync(diskPath) && fs.readFileSync(diskPath, 'utf8') === '% from B\nhello collab\n',
    '断线后磁盘文件与协同内容一致'
  );
});

test('协同：无 token 连接被拒（close 4403）', async () => {
  const ws = new WebSocket(wsUrl(1, 'x.tex', null));
  const code = await new Promise((resolve) => {
    ws.on('close', (c) => resolve(c));
    ws.on('error', () => resolve(-1));
  });
  assert.equal(code, 4403);
});

test('协同：viewer 只读，update 不生效', async () => {
  const { token: ownerToken } = await registerAndLogin(srv.baseUrl, 'vowner');
  const { token: viewerToken } = await registerAndLogin(srv.baseUrl, 'vview');
  const { data } = await api(srv.baseUrl, 'POST', '/api/projects', { token: ownerToken, body: { name: 'readonly' } });
  const pid = data.project.publicId;
  await api(srv.baseUrl, 'POST', `/api/projects/${pid}/members`, {
    token: ownerToken, body: { username: 'vview', role: 'viewer' },
  });
  const file = 'ro.tex';
  assert.equal((await api(srv.baseUrl, 'POST', `/api/projects/${pid}/files`, { token: ownerToken, body: { path: file, content: '' } })).status, 200);

  const A = connectSync(wsUrl(pid, file, ownerToken));
  await A.opened;
  A.doc.getText('content').insert(0, 'base content\n');

  const V = connectSync(wsUrl(pid, file, viewerToken));
  await V.opened;
  await waitFor(() => V.doc.getText('content').toString() === 'base content\n', 'viewer 同步初始内容');

  // viewer 本地写入并发送 update → 服务端应拒绝
  V.doc.getText('content').insert(0, 'HACK\n');
  await new Promise((r) => setTimeout(r, 500));

  // 新连接同步服务端状态：不得包含 viewer 的写入
  const C = connectSync(wsUrl(pid, file, ownerToken));
  await C.opened;
  await waitFor(() => C.doc.getText('content').toString().length > 0, 'C 完成初始同步');
  assert.equal(C.doc.getText('content').toString(), 'base content\n');

  A.ws.close();
  V.ws.close();
  C.ws.close();
});

let strictSerial = 0;
async function strictFixture(t, file = 'strict.tex') {
  const { token } = await registerAndLogin(srv.baseUrl, 'strictflush' + (++strictSerial));
  const { data } = await api(srv.baseUrl, 'POST', '/api/projects', { token, body: { name: 'strict flush' } });
  const project = data.project;
  assert.equal((await api(srv.baseUrl, 'POST', `/api/projects/${project.publicId}/files`, {
    token, body: { path: file, content: 'base\n' },
  })).status, 200);
  const A = connectSync(wsUrl(project.publicId, file, token));
  const B = connectSync(wsUrl(project.publicId, file, token));
  await Promise.all([A.opened, B.opened]);
  await waitFor(() => A.doc.getText('content').toString() === 'base\n' && B.doc.getText('content').toString() === 'base\n', '严格同步fixture初始状态');
  t.after(async () => {
    await Promise.all([A, B].map(client => new Promise(resolve => {
      if (client.ws.readyState === WebSocket.CLOSED) return resolve();
      client.ws.once('close', resolve); client.ws.close();
    })));
    A.doc.destroy(); B.doc.destroy();
  });
  const projectDir = path.join(srv.dataDir, 'projects', String(project.id));
  const ctx = { project: { id: project.id }, projectDir, changesetBuffer: [] };
  const disk = path.join(projectDir, file);
  const modules = {
    ...(await import('../src/collab.js')),
    ...(await import('../src/services/agent/parallelEdits.js')),
  };
  const create = () => modules.createParallelEditSession({ ctx, revision: 9,
    tasks: [{ id: 'editor', task: '修改明确分派的文件', scope: [{ path: file }] }] });
  const merge = session => modules.mergeParallelEdits({ ctx, session, revision: 9,
    results: [{ id: 'editor', proposedChanges: [{ path: file, before: session.files[0].draft,
      after: 'private editor proposal\n', encoding: 'utf8' }] }] });
  const update = async content => {
    A.doc.transact(() => { const text = A.doc.getText('content'); text.delete(0, text.length); text.insert(0, content); });
    await waitFor(() => B.doc.getText('content').toString() === content, '服务端已接收并广播编辑');
  };
  return { ...modules, project, ctx, disk, create, merge, update, clients: [A, B], token };
}

test('严格同步：冻结已接收的Yjs修改，合并前的新协作修改使整批草稿过期', async t => {
  const f = await strictFixture(t);
  await f.update('accepted before snapshot\n');
  const session = f.create();
  assert.equal(session.files[0].draft, 'accepted before snapshot\n');
  assert.equal(fs.readFileSync(f.disk, 'utf8'), 'accepted before snapshot\n');
  await f.update('newer user edit\n');
  assert.throws(() => f.merge(session), error => error.code === 'parallel_edit_stale');
  assert.equal(fs.readFileSync(f.disk, 'utf8'), 'newer user edit\n');
  assert.deepEqual(f.ctx.changesetBuffer, []);
});

test('严格同步：正文写盘失败阻止freeze和merge，保留dirty供恢复后重试', async t => {
  const f = await strictFixture(t), session = f.create();
  await f.update('accepted but pending\n');
  const write = fs.writeFileSync;
  const injected = Object.assign(new Error('simulated document write failure'), { code: 'EIO' });
  const mocked = t.mock.method(fs, 'writeFileSync', (destination, ...args) => {
    if (path.resolve(String(destination)) === f.disk) throw injected;
    return write(destination, ...args);
  });
  assert.doesNotThrow(() => f.flushProjectRooms(f.project.id), 'default mode keeps its nonthrowing behavior');
  assert.throws(() => f.flushProjectRooms(f.project.id, { strict: true }), error => error === injected);
  assert.throws(() => f.create(), error => error === injected);
  assert.throws(() => f.merge(session), error => error === injected);
  assert.equal(fs.readFileSync(f.disk, 'utf8'), 'base\n');
  assert.deepEqual(f.ctx.changesetBuffer, []);
  mocked.mock.restore();
  f.flushProjectRooms(f.project.id, { strict: true });
  assert.equal(fs.readFileSync(f.disk, 'utf8'), 'accepted but pending\n');
  assert.throws(() => f.merge(session), error => error.code === 'parallel_edit_stale');
});

test('严格同步：Yjs状态持久化失败保持dirty，恢复后完整保存才能继续', async t => {
  const f = await strictFixture(t), session = f.create();
  await f.update('accepted with state pending\n');
  const write = fs.writeFileSync;
  const statePrefix = path.join(f.ctx.projectDir, '.build', 'collab') + path.sep;
  const injected = Object.assign(new Error('simulated collaborative state failure'), { code: 'EIO' });
  let failures = 0;
  const mocked = t.mock.method(fs, 'writeFileSync', (destination, ...args) => {
    if (String(destination).startsWith(statePrefix)) { failures++; throw injected; }
    return write(destination, ...args);
  });
  assert.throws(() => f.flushProjectRooms(f.project.id, { strict: true }), error => error === injected);
  assert.throws(() => f.merge(session), error => error === injected);
  assert.equal(failures, 2, 'the failed state save must leave the room dirty for the next strict attempt');
  assert.equal(fs.readFileSync(f.disk, 'utf8'), 'accepted with state pending\n');
  assert.deepEqual(f.ctx.changesetBuffer, []);
  mocked.mock.restore();
  f.flushProjectRooms(f.project.id, { strict: true });
  const states = fs.readdirSync(path.join(f.ctx.projectDir, '.build', 'collab'));
  assert.ok(states.some(name => JSON.parse(fs.readFileSync(path.join(statePrefix, name), 'utf8')).diskHash));
  assert.equal(f.create().files[0].draft, 'accepted with state pending\n');
});

test('严格同步：dirty文件已删除时不复活也不丢弃已接收内容', async t => {
  const f = await strictFixture(t), session = f.create();
  await f.update('pending before deletion\n');
  fs.unlinkSync(f.disk);
  const deleted = error => error.code === 'COLLAB_FILE_DELETED';
  assert.throws(() => f.flushProjectRooms(f.project.id, { strict: true }), deleted);
  assert.throws(() => f.create(), deleted);
  assert.throws(() => f.merge(session), deleted);
  assert.equal(fs.existsSync(f.disk), false);
  assert.deepEqual(f.ctx.changesetBuffer, []);
  // Restoring a file is an explicit external recovery action. A subsequent
  // strict flush can still recover the accepted update because dirty survived.
  fs.writeFileSync(f.disk, 'explicitly restored placeholder\n');
  f.flushProjectRooms(f.project.id, { strict: true });
  assert.equal(fs.readFileSync(f.disk, 'utf8'), 'pending before deletion\n');
});

test('默认同步：已删除文件沿用原行为，不复活也不抛错', async t => {
  const f = await strictFixture(t);
  await f.update('pending legacy behavior\n');
  fs.unlinkSync(f.disk);
  assert.doesNotThrow(() => f.flushProjectRooms(f.project.id));
  assert.equal(fs.existsSync(f.disk), false);
  fs.writeFileSync(f.disk, 'manually restored new file\n');
  f.flushProjectRooms(f.project.id, { strict: true });
  assert.equal(fs.readFileSync(f.disk, 'utf8'), 'manually restored new file\n');
});

for (const directory of [false, true]) test('rename flushes accepted edits and closes all old rooms: ' + (directory ? 'directory' : 'file'), async t => {
  const f = await strictFixture(t, directory ? 'chapters/strict.tex' : 'strict.tex');
  let extra;
  if (directory) {
    assert.equal((await api(srv.baseUrl, 'POST', '/api/projects/' + f.project.publicId + '/files', {
      token: f.token, body: { path: 'chapters/extra.tex', content: 'extra base\n' },
    })).status, 200);
    extra = connectSync(wsUrl(f.project.publicId, 'chapters/extra.tex', f.token));
    await extra.opened;
    await waitFor(() => extra.doc.getText('content').toString() === 'extra base\n', 'extra room sync');
    extra.doc.getText('content').insert(0, 'pending:');
    // A ping follows the update on this WebSocket, proving the server received it.
    await new Promise(resolve => { extra.ws.once('pong', resolve); extra.ws.ping(); });
    t.after(() => { extra.ws.close(); extra.doc.destroy(); });
  }
  await f.update('accepted before rename\n');
  const result = await api(srv.baseUrl, 'PATCH', '/api/projects/' + f.project.publicId + '/files', {
    token: f.token, body: { path: directory ? 'chapters' : 'strict.tex', newPath: directory ? 'renamed' : 'renamed.tex' },
  });
  assert.equal(result.status, 200);
  const target = path.join(f.ctx.projectDir, directory ? 'renamed/strict.tex' : 'renamed.tex');
  assert.equal(fs.readFileSync(target, 'utf8'), 'accepted before rename\n');
  assert.equal(fs.existsSync(f.disk), false);
  await waitFor(() => f.clients.every(client => client.ws.readyState === WebSocket.CLOSED), 'old rooms closed after rename');
  if (extra) {
    await waitFor(() => extra.ws.readyState === WebSocket.CLOSED, 'all descendant rooms closed');
    assert.equal(fs.readFileSync(path.join(f.ctx.projectDir, 'renamed/extra.tex'), 'utf8'), 'pending:extra base\n');
  }
});

test('rename fails before moving a file when strict collaborative saving fails and can retry without losing text', async t => {
  const f = await strictFixture(t);
  await f.update('accepted pending rename\n');
  const write = fs.writeFileSync;
  const mocked = t.mock.method(fs, 'writeFileSync', (destination, ...args) => {
    if (path.resolve(String(destination)) === f.disk) throw Object.assign(new Error('rename fixture save failure'), { code: 'EIO' });
    return write(destination, ...args);
  });
  const request = () => api(srv.baseUrl, 'PATCH', '/api/projects/' + f.project.publicId + '/files', {
    token: f.token, body: { path: 'strict.tex', newPath: 'renamed.tex' },
  });
  assert.equal((await request()).status, 500);
  assert.equal(fs.readFileSync(f.disk, 'utf8'), 'base\n');
  assert.equal(fs.existsSync(path.join(f.ctx.projectDir, 'renamed.tex')), false);
  assert.ok(f.clients.every(client => client.ws.readyState === WebSocket.OPEN));
  mocked.mock.restore();
  assert.equal((await request()).status, 200);
  assert.equal(fs.readFileSync(path.join(f.ctx.projectDir, 'renamed.tex'), 'utf8'), 'accepted pending rename\n');
});
