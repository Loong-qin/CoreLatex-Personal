import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import jwt from 'jsonwebtoken';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as syncProtocol from 'y-protocols/sync';
import { startTestServer, api, registerAndLogin } from './helpers.js';

let srv, admin, serial = 0;
const clients = new Set();

before(async () => {
  srv = await startTestServer();
  admin = await registerAndLogin(srv.baseUrl, 'collabadmin');
});
afterEach(async () => {
  for (const client of clients) {
    if (client.ws.readyState !== WebSocket.CLOSED) client.ws.close();
    await client.closed;
    client.doc.destroy();
  }
  clients.clear();
});
after(async () => { await srv.close(); });

async function waitFor(condition, what, timeout = 2500) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(what);
}

function connect(project, token, file = 'main.tex') {
  const doc = new Y.Doc();
  const url = new URL(srv.baseUrl.replace('http:', 'ws:') + '/collab');
  url.searchParams.set('project', project.publicId);
  url.searchParams.set('file', file);
  url.searchParams.set('token', token);
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
    if (encoding.length(reply) > 1 && ws.readyState === WebSocket.OPEN) {
      ws.send(encoding.toUint8Array(reply));
    }
  });
  doc.on('update', (update, origin) => {
    if (origin === 'remote' || ws.readyState !== WebSocket.OPEN) return;
    sendUpdate(ws, update);
  });
  opened.then(() => {
    const message = encoding.createEncoder();
    encoding.writeVarUint(message, 0);
    syncProtocol.writeSyncStep1(message, doc);
    ws.send(encoding.toUint8Array(message));
  }).catch(() => {});
  const client = { ws, doc, opened, closed };
  clients.add(client);
  return client;
}

function sendUpdate(ws, update) {
  const message = encoding.createEncoder();
  encoding.writeVarUint(message, 0);
  syncProtocol.writeUpdate(message, update);
  ws.send(encoding.toUint8Array(message));
}

async function barrier(client) {
  await new Promise((resolve, reject) => {
    client.ws.once('pong', resolve);
    client.ws.ping(undefined, undefined, (error) => { if (error) reject(error); });
  });
}

async function synced(project, token, expected = 'base', file = 'main.tex') {
  const client = connect(project, token, file);
  await client.opened;
  await waitFor(() => client.doc.getText('content').toString() === expected, 'initial document sync');
  return client;
}

async function request(method, route, token, body) {
  const result = await api(srv.baseUrl, method, route, { token, body });
  assert.ok(result.status >= 200 && result.status < 300, JSON.stringify(result));
  return result;
}

async function fixture(owner = admin) {
  const member = await registerAndLogin(srv.baseUrl, 'collabuser' + (++serial));
  const created = await request('POST', '/api/projects', owner.token, { name: 'permissions' });
  const project = created.data.project;
  await request('POST', '/api/projects/' + project.publicId + '/files', owner.token,
    { path: 'main.tex', content: 'base', overwrite: true });
  await request('POST', '/api/projects/' + project.publicId + '/members', owner.token,
    { username: member.user.username, role: 'editor' });
  const disk = path.join(srv.dataDir, 'projects', String(project.id), 'main.tex');
  return { member, project, disk, owner };
}

// Construct an independent update so a rejected optimistic edit cannot pollute
// the test client's own Y.Doc and mask whether the server accepted it.
async function attemptInsert(client, reference, text) {
  const candidate = new Y.Doc();
  Y.applyUpdate(candidate, Y.encodeStateAsUpdate(reference.doc));
  let update;
  candidate.on('update', (next) => { update = next; });
  candidate.getText('content').insert(0, text);
  sendUpdate(client.ws, update);
  await barrier(client);
  await barrier(reference);
  candidate.destroy();
}

test('existing editor connection follows downgrade and promotion without losing accepted edits', async () => {
  const { member, project, disk } = await fixture();
  const owner = await synced(project, admin.token);
  const editor = await synced(project, member.token);
  editor.doc.getText('content').insert(0, 'accepted:');
  await waitFor(() => owner.doc.getText('content').toString() === 'accepted:base', 'authorized edit');
  await request('POST', '/api/projects/' + project.publicId + '/members', admin.token,
    { username: member.user.username, role: 'viewer' });
  assert.equal(fs.readFileSync(disk, 'utf8'), 'accepted:base');
  await attemptInsert(editor, owner, 'forbidden:');
  assert.equal(owner.doc.getText('content').toString(), 'accepted:base');
  await request('POST', '/api/projects/' + project.publicId + '/members', admin.token,
    { username: member.user.username, role: 'editor' });
  await attemptInsert(editor, owner, 'restored:');
  assert.equal(owner.doc.getText('content').toString(), 'restored:accepted:base');
});

test('removed member disconnects before later document content and preserves pending authorized writes', async () => {
  const { member, project, disk } = await fixture();
  const owner = await synced(project, admin.token);
  const editor = await synced(project, member.token);
  editor.doc.getText('content').insert(0, 'accepted:');
  await waitFor(() => owner.doc.getText('content').toString() === 'accepted:base', 'authorized edit');
  await request('DELETE', '/api/projects/' + project.publicId + '/members/' + member.user.id, admin.token);
  assert.equal(await editor.closed, 4403);
  assert.equal(fs.readFileSync(disk, 'utf8'), 'accepted:base');
  owner.doc.getText('content').insert(0, 'secret:');
  await barrier(owner);
  assert.equal(editor.doc.getText('content').toString(), 'accepted:base');
  const denied = connect(project, member.token);
  assert.equal(await denied.closed, 4403);
});

test('archive and recycle-bin state immediately make existing editors read-only; restore permits edits', async () => {
  const { member, project } = await fixture();
  const owner = await synced(project, admin.token);
  const editor = await synced(project, member.token);
  for (const [restrict, restore] of [['archive', 'unarchive'], ['delete', 'restore']]) {
    await request('POST', '/api/projects/' + project.publicId + '/' + restrict, admin.token);
    const before = owner.doc.getText('content').toString();
    await attemptInsert(editor, owner, 'forbidden:');
    await attemptInsert(owner, editor, 'forbidden-owner:');
    assert.equal(owner.doc.getText('content').toString(), before);
    await request('POST', '/api/projects/' + project.publicId + '/' + restore, admin.token);
    await attemptInsert(editor, owner, 'restored:');
    assert.equal(owner.doc.getText('content').toString(), 'restored:' + before);
    // Bring the originating editor up to date before the next independent edit.
    const message = encoding.createEncoder();
    encoding.writeVarUint(message, 0);
    syncProtocol.writeSyncStep1(message, editor.doc);
    editor.ws.send(encoding.toUint8Array(message));
    await waitFor(() => editor.doc.getText('content').toString() === owner.doc.getText('content').toString(), 'editor resync');
  }
});

test('single and batch account disabling revoke existing document recipients', async () => {
  for (const batch of [false, true]) {
    const { member, project } = await fixture();
    const owner = await synced(project, admin.token);
    const editor = await synced(project, member.token);
    if (batch) {
      await request('POST', '/api/admin/users/batch', admin.token,
        { userIds: [member.user.id], patch: { status: 'disabled' } });
    } else {
      await request('PATCH', '/api/admin/users/' + member.user.id, admin.token, { status: 'disabled' });
    }
    assert.equal(await editor.closed, 4403);
    owner.doc.getText('content').insert(0, 'secret:');
    await barrier(owner);
    assert.equal(editor.doc.getText('content').toString(), 'base');
  }
});

test('deleting an account revokes shared connections and destroys its owned rooms', async () => {
  const account = await registerAndLogin(srv.baseUrl, 'deletedowner' + (++serial));
  const shared = await fixture();
  await request('POST', '/api/projects/' + shared.project.publicId + '/members', admin.token,
    { username: account.user.username, role: 'editor' });
  const sharedOwner = await synced(shared.project, admin.token);
  const sharedClient = await synced(shared.project, account.token);
  const owned = await fixture(account);
  const ownedClient = await synced(owned.project, account.token);
  ownedClient.doc.getText('content').insert(0, 'pending:');
  await barrier(ownedClient);
  await request('DELETE', '/api/admin/users/' + account.user.id, admin.token);
  assert.equal(await sharedClient.closed, 4403);
  assert.equal(await ownedClient.closed, 4403);
  sharedOwner.doc.getText('content').insert(0, 'secret:');
  await barrier(sharedOwner);
  assert.equal(sharedClient.doc.getText('content').toString(), 'base');
  assert.equal(fs.existsSync(path.dirname(owned.disk)), false);
});

test('permanent project deletion cannot be undone by a dirty room or its delayed close', async () => {
  const { project, disk } = await fixture();
  const owner = await synced(project, admin.token);
  owner.doc.getText('content').insert(0, 'pending:');
  await barrier(owner);
  await request('POST', '/api/projects/' + project.publicId + '/delete', admin.token);
  await request('POST', '/api/projects/' + project.publicId + '/purge', admin.token);
  assert.equal(await owner.closed, 4403);
  assert.equal(fs.existsSync(path.dirname(disk)), false);
  const denied = connect(project, admin.token);
  assert.equal(await denied.closed, 4403);
  assert.equal(fs.existsSync(path.dirname(disk)), false);
});

test('reload discards stale dirty state and delayed close cannot overwrite a replacement room', async () => {
  const { project, disk } = await fixture();
  const owner = await synced(project, admin.token);
  owner.doc.getText('content').insert(0, 'stale:');
  await barrier(owner);
  fs.writeFileSync(disk, 'external');
  const { reloadProjectRooms, flushProjectRooms } = await import('../src/collab.js');
  reloadProjectRooms(project.id);
  const fresh = await synced(project, admin.token, 'external');
  assert.equal(await owner.closed, 1012);
  assert.equal(fs.readFileSync(disk, 'utf8'), 'external');
  fresh.doc.getText('content').insert(0, 'fresh:');
  await barrier(fresh);
  flushProjectRooms(project.id);
  assert.equal(fs.readFileSync(disk, 'utf8'), 'fresh:external');
});

test('equivalent relative paths share one CRDT room', async () => {
  const { project, disk } = await fixture();
  const first = await synced(project, admin.token);
  const alias = await synced(project, admin.token, 'base', './main.tex');
  first.doc.getText('content').insert(0, 'one:');
  await waitFor(() => alias.doc.getText('content').toString() === 'one:base', 'path alias receives edit');
  alias.doc.getText('content').insert(0, 'two:');
  await waitFor(() => first.doc.getText('content').toString() === 'two:one:base', 'canonical path receives edit');
  const { flushProjectRooms } = await import('../src/collab.js');
  flushProjectRooms(project.id);
  assert.equal(fs.readFileSync(disk, 'utf8'), 'two:one:base');
});

test('expired login stops an idle connection receiving subsequent content', async () => {
  const { member, project } = await fixture();
  const { getJwtSecret } = await import('../src/config.js');
  const exp = Math.floor(Date.now() / 1000) + 2;
  const token = jwt.sign({ uid: member.user.id, exp }, getJwtSecret());
  const owner = await synced(project, admin.token);
  const shortLived = await synced(project, token);
  await waitFor(() => Date.now() >= exp * 1000, 'JWT expiration', 3000);
  owner.doc.getText('content').insert(0, 'secret:');
  await barrier(owner);
  assert.equal(await shortLived.closed, 4403);
  assert.equal(shortLived.doc.getText('content').toString(), 'base');
});

test('input and broadcast revalidation also stop permissions changed outside route hooks', async () => {
  const { member, project } = await fixture();
  const owner = await synced(project, admin.token);
  const editor = await synced(project, member.token);
  const { getDb } = await import('../src/db.js');
  const db = getDb();
  db.prepare("UPDATE project_members SET role = 'viewer' WHERE project_id = ? AND user_id = ?")
    .run(project.id, member.user.id);
  await attemptInsert(editor, owner, 'forbidden:');
  assert.equal(owner.doc.getText('content').toString(), 'base');
  db.prepare('DELETE FROM project_members WHERE project_id = ? AND user_id = ?')
    .run(project.id, member.user.id);
  owner.doc.getText('content').insert(0, 'secret:');
  await barrier(owner);
  assert.equal(await editor.closed, 4403);
  assert.equal(editor.doc.getText('content').toString(), 'base');
});
