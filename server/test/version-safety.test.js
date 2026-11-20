import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as syncProtocol from 'y-protocols/sync';
import * as unzipper from 'unzipper';
import { startTestServer, api, registerAndLogin } from './helpers.js';

let srv, owner, user, db, createSnapshot, restoreVersion, getVersionDiff, listVersions;
let serial = 0;
const clients = new Set();
const originalOpen = unzipper.Open.file;
const originalWrite = fs.writeFileSync;

before(async () => {
  srv = await startTestServer();
  owner = await registerAndLogin(srv.baseUrl, 'versionsafety');
  ({ getDb: db } = await import('../src/db.js'));
  db = db();
  user = db.prepare('SELECT * FROM users WHERE id = ?').get(owner.user.id);
  ({ createSnapshot, restoreVersion, getVersionDiff, listVersions } = await import('../src/services/versions.js'));
});

afterEach(async () => {
  unzipper.Open.file = originalOpen;
  fs.writeFileSync = originalWrite;
  for (const client of clients) {
    if (client.ws.readyState !== WebSocket.CLOSED) client.ws.close();
    await client.closed;
    client.doc.destroy();
  }
  clients.clear();
});
after(async () => { await srv.close(); });

async function fixture(content = 'old\n') {
  const created = await api(srv.baseUrl, 'POST', '/api/projects', {
    token: owner.token, body: { name: 'version safety ' + (++serial) },
  });
  assert.equal(created.status, 201);
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(created.data.project.id);
  const dir = path.join(srv.dataDir, 'projects', String(project.id));
  const main = path.join(dir, 'main.tex');
  fs.writeFileSync(main, content);
  return { project, dir, main };
}

function snapshotPath(version) {
  return db.prepare('SELECT snapshot_path FROM versions WHERE id = ?').get(version.id).snapshot_path;
}

async function contents(version) {
  const zip = await originalOpen(snapshotPath(version));
  const result = new Map();
  for (const entry of zip.files) {
    if (entry.type === 'File') result.set(entry.path, (await entry.buffer()).toString());
    else result.set(entry.path, null);
  }
  return result;
}

function pauseZip(zipPath) {
  let release, entered;
  const paused = new Promise((resolve) => { entered = resolve; });
  const resume = new Promise((resolve) => { release = resolve; });
  let used = false;
  unzipper.Open.file = async (...args) => {
    if (!used && args[0] === zipPath) {
      used = true;
      entered();
      await resume;
    }
    return originalOpen(...args);
  };
  return { paused, release };
}

async function waitFor(condition, what, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(what);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function connect(f, expected) {
  const doc = new Y.Doc();
  const url = new URL(srv.baseUrl.replace('http:', 'ws:') + '/collab');
  url.searchParams.set('project', f.project.public_id);
  url.searchParams.set('file', 'main.tex');
  url.searchParams.set('token', owner.token);
  const ws = new WebSocket(url);
  const closed = new Promise((resolve) => ws.once('close', resolve));
  const opened = new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  ws.on('message', (data) => {
    const decoder = decoding.createDecoder(new Uint8Array(data));
    if (decoding.readVarUint(decoder) !== 0) return;
    const reply = encoding.createEncoder();
    encoding.writeVarUint(reply, 0);
    syncProtocol.readSyncMessage(decoder, reply, doc, 'remote');
    if (encoding.length(reply) > 1 && ws.readyState === WebSocket.OPEN) ws.send(encoding.toUint8Array(reply));
  });
  doc.on('update', (update, origin) => {
    if (origin === 'remote' || ws.readyState !== WebSocket.OPEN) return;
    const message = encoding.createEncoder();
    encoding.writeVarUint(message, 0);
    syncProtocol.writeUpdate(message, update);
    ws.send(encoding.toUint8Array(message));
  });
  const client = { ws, doc, closed };
  clients.add(client);
  await opened;
  const message = encoding.createEncoder();
  encoding.writeVarUint(message, 0);
  syncProtocol.writeSyncStep1(message, doc);
  ws.send(encoding.toUint8Array(message));
  await waitFor(() => doc.getText('content').toString() === expected, 'initial sync');
  return client;
}

async function barrier(client) {
  await new Promise((resolve, reject) => {
    client.ws.once('pong', resolve);
    client.ws.ping(undefined, undefined, (error) => { if (error) reject(error); });
  });
}

test('snapshot statistics and archive use one frozen tree while later edits stay in the workspace', async () => {
  const f = await fixture();
  const first = await createSnapshot({ project: f.project, user });
  fs.writeFileSync(f.main, 'captured\n');
  fs.mkdirSync(path.join(f.dir, 'empty'));
  const gate = pauseZip(snapshotPath(first));
  const pending = createSnapshot({ project: f.project, user });
  try {
    await gate.paused;
    fs.writeFileSync(f.main, 'later\n');
    fs.writeFileSync(path.join(f.dir, 'later.tex'), 'later file\n');
    gate.release();
    const saved = await pending;
    const archived = await contents(saved);
    assert.equal(archived.get('main.tex'), 'captured\n');
    assert.equal(archived.has('later.tex'), false);
    assert.equal(archived.has('empty/'), true);
    assert.deepEqual(saved.files.map((file) => [file.path, file.adds, file.dels]), [['main.tex', 1, 1]]);
    const diff = await getVersionDiff(f.project.id, saved.id);
    assert.ok(diff.diffs[0].patch.includes('+captured'));
    assert.equal(diff.diffs[0].patch.includes('+later'), false);
    assert.equal(fs.readFileSync(f.main, 'utf8'), 'later\n');
  } finally {
    gate.release();
    await pending;
  }
});

test('overlapping snapshot requests are ordered against the preceding committed version', async () => {
  const f = await fixture();
  const initial = await createSnapshot({ project: f.project, user });
  fs.writeFileSync(f.main, 'first\n');
  const gate = pauseZip(snapshotPath(initial));
  const one = createSnapshot({ project: f.project, user });
  let two;
  try {
    await gate.paused;
    fs.writeFileSync(f.main, 'second\n');
    two = createSnapshot({ project: f.project, user });
    gate.release();
    const [first, second] = await Promise.all([one, two]);
    assert.equal(first.seq, 2);
    assert.equal(second.seq, 3);
    assert.equal((await contents(first)).get('main.tex'), 'first\n');
    assert.equal((await contents(second)).get('main.tex'), 'second\n');
    const diff = await getVersionDiff(f.project.id, second.id);
    assert.ok(diff.diffs[0].patch.includes('-first'));
    assert.ok(diff.diffs[0].patch.includes('+second'));
  } finally {
    gate.release();
    await one;
    if (two) await two;
  }
});

test('manual snapshots flush accepted collaborative edits before the debounce expires', async () => {
  const f = await fixture('base');
  const client = await connect(f, 'base');
  client.doc.getText('content').insert(0, 'pending:');
  await barrier(client);
  assert.equal(fs.readFileSync(f.main, 'utf8'), 'base');
  const saved = await createSnapshot({ project: f.project, user });
  assert.equal((await contents(saved)).get('main.tex'), 'pending:base');
  assert.equal(fs.readFileSync(f.main, 'utf8'), 'pending:base');
});

test('restore saves accepted edits as a recoverable version and preserves excluded files', async () => {
  const f = await fixture();
  const initial = await createSnapshot({ project: f.project, user });
  fs.writeFileSync(f.main, 'current\n');
  fs.mkdirSync(path.join(f.dir, 'assets'));
  fs.mkdirSync(path.join(f.dir, '.build'), { recursive: true });
  fs.writeFileSync(path.join(f.dir, '.private'), 'root private');
  fs.writeFileSync(path.join(f.dir, 'assets', '.private'), 'nested private');
  fs.writeFileSync(path.join(f.dir, '.build', 'keep'), 'build');
  fs.writeFileSync(path.join(f.dir, 'new.tex'), 'new content');
  const client = await connect(f, 'current\n');
  client.doc.getText('content').insert(0, 'pending:');
  await barrier(client);
  const restored = await restoreVersion(f.project.id, initial.id, { user });
  assert.equal(restored.ok, true);
  assert.equal(await client.closed, 1012);
  assert.equal(fs.readFileSync(f.main, 'utf8'), 'old\n');
  assert.equal(fs.existsSync(path.join(f.dir, 'new.tex')), false);
  assert.equal(fs.readFileSync(path.join(f.dir, '.private'), 'utf8'), 'root private');
  assert.equal(fs.readFileSync(path.join(f.dir, 'assets', '.private'), 'utf8'), 'nested private');
  assert.equal(fs.readFileSync(path.join(f.dir, '.build', 'keep'), 'utf8'), 'build');
  const backup = listVersions(f.project.id)[0];
  assert.ok(backup.message.includes('恢复前自动保存'));
  assert.equal((await contents(backup)).get('main.tex'), 'pending:current\n');
  assert.equal(backup.userName, owner.user.username);
  await restoreVersion(f.project.id, backup.id, { user });
  assert.equal(fs.readFileSync(f.main, 'utf8'), 'pending:current\n');
  assert.equal(fs.readFileSync(path.join(f.dir, 'new.tex'), 'utf8'), 'new content');
});

test('edits accepted while the target archive is loading abort restore with conflict and stay online', async () => {
  const f = await fixture();
  const initial = await createSnapshot({ project: f.project, user });
  fs.writeFileSync(f.main, 'current\n');
  const client = await connect(f, 'current\n');
  const gate = pauseZip(snapshotPath(initial));
  const pending = restoreVersion(f.project.id, initial.id, { user });
  const outcome = pending.then((value) => ({ value }), (error) => ({ error }));
  try {
    await gate.paused;
    client.doc.getText('content').insert(0, 'during:');
    await barrier(client);
    gate.release();
    const result = await outcome;
    assert.equal(result.error?.status, 409);
    assert.equal(fs.readFileSync(f.main, 'utf8'), 'during:current\n');
    assert.equal(client.ws.readyState, WebSocket.OPEN);
    assert.equal(listVersions(f.project.id).length, 1);
  } finally {
    gate.release();
    await outcome;
  }
});

test('edits accepted while the safety backup is being prepared abort restore without overwriting them', async () => {
  const f = await fixture();
  const initial = await createSnapshot({ project: f.project, user });
  fs.writeFileSync(f.main, 'current\n');
  const current = await createSnapshot({ project: f.project, user });
  const client = await connect(f, 'current\n');
  const gate = pauseZip(snapshotPath(current));
  const pending = restoreVersion(f.project.id, initial.id, { user });
  const outcome = pending.then((value) => ({ value }), (error) => ({ error }));
  try {
    await gate.paused;
    client.doc.getText('content').insert(0, 'during-backup:');
    await barrier(client);
    gate.release();
    const result = await outcome;
    assert.equal(result.error?.status, 409);
    assert.equal(fs.readFileSync(f.main, 'utf8'), 'during-backup:current\n');
    assert.equal(client.ws.readyState, WebSocket.OPEN);
    const backup = listVersions(f.project.id)[0];
    assert.ok(backup.message.includes('恢复前自动保存'));
    assert.equal((await contents(backup)).get('main.tex'), 'current\n');
  } finally {
    gate.release();
    await outcome;
  }
});

test('invalid paths or corrupt later entries are rejected before any working file is removed', async () => {
  for (const corrupt of [false, true]) {
    const f = await fixture('keep\n');
    const initial = await createSnapshot({ project: f.project, user });
    fs.writeFileSync(path.join(f.dir, 'also.tex'), 'keep also');
    unzipper.Open.file = async (zipPath) => zipPath === snapshotPath(initial) ? {
      files: [
        { path: 'main.tex', type: 'File', buffer: async () => Buffer.from('wrong') },
        corrupt
          ? { path: 'other.tex', type: 'File', buffer: async () => { throw new Error('corrupt archive entry'); } }
          : { path: '../outside.tex', type: 'File', buffer: async () => Buffer.from('unsafe') },
      ],
    } : originalOpen(zipPath);
    await assert.rejects(restoreVersion(f.project.id, initial.id, { user }),
      (error) => corrupt ? /corrupt archive/.test(error.message) : error.status === 400);
    assert.equal(fs.readFileSync(f.main, 'utf8'), 'keep\n');
    assert.equal(fs.readFileSync(path.join(f.dir, 'also.tex'), 'utf8'), 'keep also');
    assert.equal(listVersions(f.project.id).length, 1);
    unzipper.Open.file = originalOpen;
  }
});

test('a failed synchronous restore rolls back working contents and leaves its safety version', async () => {
  const f = await fixture();
  const initial = await createSnapshot({ project: f.project, user });
  fs.writeFileSync(f.main, 'current\n');
  fs.writeFileSync(path.join(f.dir, 'also.tex'), 'current extra');
  let failed = false;
  fs.writeFileSync = (file, content, ...args) => {
    if (!failed && file === f.main && String(content) === 'old\n') {
      failed = true;
      throw Object.assign(new Error('simulated disk failure'), { code: 'ENOSPC' });
    }
    return originalWrite(file, content, ...args);
  };
  await assert.rejects(restoreVersion(f.project.id, initial.id, { user }), (error) => error.status === 500);
  fs.writeFileSync = originalWrite;
  assert.equal(failed, true);
  assert.equal(fs.readFileSync(f.main, 'utf8'), 'current\n');
  assert.equal(fs.readFileSync(path.join(f.dir, 'also.tex'), 'utf8'), 'current extra');
  const backup = listVersions(f.project.id)[0];
  assert.ok(backup.message.includes('恢复前自动保存'));
  assert.equal((await contents(backup)).get('main.tex'), 'current\n');
});

for (const mode of ['removed-during-read', 'downgraded-during-backup', 'disabled-during-read']) {
  test('restore rechecks current authorization before replacing bytes: ' + mode, async () => {
    const f = await fixture('old snapshot\n');
    const initial = await createSnapshot({ project: f.project, user });
    fs.writeFileSync(f.main, 'current owner text\n');
    const last = mode === 'downgraded-during-backup' ? await createSnapshot({ project: f.project, user }) : initial;
    const member = await registerAndLogin(srv.baseUrl, 'restore-member-' + (++serial));
    assert.equal((await api(srv.baseUrl, 'POST', '/api/projects/' + f.project.public_id + '/members', {
      token: owner.token, body: { username: member.user.username, role: 'editor' },
    })).status, 200);
    const gate = pauseZip(snapshotPath(last));
    const pending = api(srv.baseUrl, 'POST', '/api/projects/' + f.project.public_id + '/versions/' + initial.id + '/restore', {
      token: member.token, body: {},
    });
    try {
      await gate.paused;
      if (mode.startsWith('removed')) {
        assert.equal((await api(srv.baseUrl, 'DELETE', '/api/projects/' + f.project.public_id + '/members/' + member.user.id, { token: owner.token })).status, 200);
      } else if (mode.startsWith('downgraded')) {
        assert.equal((await api(srv.baseUrl, 'POST', '/api/projects/' + f.project.public_id + '/members', {
          token: owner.token, body: { username: member.user.username, role: 'viewer' },
        })).status, 200);
      } else db.prepare("UPDATE users SET status='disabled' WHERE id=?").run(member.user.id);
      gate.release();
      assert.equal((await pending).status, 403);
      assert.equal(fs.readFileSync(f.main, 'utf8'), 'current owner text\n');
    } finally { gate.release(); await pending; }
  });
}

test('a queued restore rechecks access when it eventually starts', async () => {
  const f = await fixture('old snapshot\n');
  const initial = await createSnapshot({ project: f.project, user });
  fs.writeFileSync(f.main, 'current owner text\n');
  const gate = pauseZip(snapshotPath(initial));
  const blockingSnapshot = createSnapshot({ project: f.project, user });
  await gate.paused;
  const pending = restoreVersion(f.project.id, initial.id, { user }).then(value => ({ value }), error => ({ error }));
  db.prepare('UPDATE projects SET archived=1 WHERE id=?').run(f.project.id);
  try {
    gate.release();
    await blockingSnapshot;
    const outcome = await pending;
    assert.equal(outcome.error?.status, 403);
    assert.equal(fs.readFileSync(f.main, 'utf8'), 'current owner text\n');
  } finally { gate.release(); await blockingSnapshot; await pending; }
});
