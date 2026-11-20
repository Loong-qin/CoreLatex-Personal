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

let srv, owner, collab, clientModule, serial = 0;
const locationDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'location');
const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const storage = new Map();
const hasWebDependencies = fs.existsSync(new URL('../../web/node_modules/y-websocket', import.meta.url));
before(async () => {
  srv = await startTestServer();
  owner = await registerAndLogin(srv.baseUrl, 'collab-reconnect-owner');
  collab = await import('../src/collab.js');
  Object.defineProperty(globalThis, 'location', { configurable: true, writable: true, value: new URL(srv.baseUrl) });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: key => storage.delete(key),
  } });
  storage.set('corelatex_token', owner.token);
  if (hasWebDependencies) clientModule = await import('../../web/src/lib/collabClient.js');
});
after(async () => {
  clientModule?.detachAllCollab();
  await srv.close();
  for (const [name, descriptor] of [['location', locationDescriptor], ['localStorage', storageDescriptor]]) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
});
async function waitFor(predicate, message, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
async function fixture() {
  const created = await api(srv.baseUrl, 'POST', '/api/projects', { token: owner.token, body: { name: 'epoch ' + (++serial) } });
  assert.equal(created.status, 201);
  const project = created.data.project, dir = path.join(srv.dataDir, 'projects', String(project.id));
  const file = path.join(dir, 'main.tex');
  fs.writeFileSync(file, 'base');
  return { project, dir, file };
}
function send(ws, writer) {
  const encoder = encoding.createEncoder(); writer(encoder); ws.send(encoding.toUint8Array(encoder));
}
async function rawClient(t, f, token = owner.token) {
  const doc = new Y.Doc(), frames = [];
  const ws = new WebSocket(srv.baseUrl.replace('http:', 'ws:') + '/collab?project=' + f.project.publicId +
    '&file=main.tex&epochProtocol=1&token=' + encodeURIComponent(token));
  const closed = new Promise(resolve => ws.once('close', resolve));
  ws.on('message', bytes => {
    const decoder = decoding.createDecoder(new Uint8Array(bytes)), type = decoding.readVarUint(decoder);
    if (type === 4) { frames.push({ type, ...JSON.parse(decoding.readVarString(decoder)) }); return; }
    frames.push({ type });
    if (type !== 0) return;
    const reply = encoding.createEncoder(); encoding.writeVarUint(reply, 0);
    syncProtocol.readSyncMessage(decoder, reply, doc, 'remote');
    if (encoding.length(reply) > 1 && ws.readyState === WebSocket.OPEN) ws.send(encoding.toUint8Array(reply));
  });
  doc.on('update', (update, origin) => {
    if (origin !== 'remote' && ws.readyState === WebSocket.OPEN) send(ws, e => {
      encoding.writeVarUint(e, 0); syncProtocol.writeUpdate(e, update);
    });
  });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  await waitFor(() => frames.some(frame => frame.type === 4), 'epoch handshake');
  t.after(async () => { if (ws.readyState !== WebSocket.CLOSED) ws.close(); await closed; doc.destroy(); });
  const epoch = frames.find(frame => frame.type === 4).epoch;
  const acknowledge = (version = 1, value = epoch) => send(ws, e => {
    encoding.writeVarUint(e, 4); encoding.writeVarString(e, JSON.stringify({ version, epoch: value }));
  });
  const checkpoint = (value, epochValue = epoch, flush = false) => send(ws, e => {
    encoding.writeVarUint(e, 4); encoding.writeVarString(e, JSON.stringify({ version: 1, epoch: epochValue, checkpoint: value, flush }));
  });
  const sync = () => send(ws, e => { encoding.writeVarUint(e, 0); syncProtocol.writeSyncStep1(e, doc); });
  const barrier = () => new Promise(resolve => { ws.once('pong', resolve); ws.ping(); });
  return { ws, doc, frames, epoch, acknowledge, checkpoint, sync, barrier, closed };
}
async function connectReal(t, f) {
  if (!hasWebDependencies) { t.skip('real frontend provider integration requires installed web dependencies'); return null; }
  const session = clientModule.attachCollab(f.project.publicId, 'main.tex');
  t.after(() => session.destroy());
  await waitFor(() => session.handshakeReady && session.provider.synced && session.ytext.toString() === 'base', 'real provider initial two-way sync');
  return session;
}
function expectDisk(f, text) {
  collab.flushProjectRooms(f.project.id, { strict: true });
  return fs.readFileSync(f.file, 'utf8') === text;
}

test('epoch negotiation gates incoming updates and outgoing broadcasts until a valid acknowledgement', async t => {
  const f = await fixture(), waiting = await rawClient(t, f), peer = await rawClient(t, f);
  peer.acknowledge(); peer.sync();
  await waitFor(() => peer.doc.getText('content').toString() === 'base', 'peer sync');
  const stale = new Y.Doc(); stale.getText('content').insert(0, 'SHOULD NOT MERGE');
  const attempt = () => send(waiting.ws, e => { encoding.writeVarUint(e, 0); syncProtocol.writeUpdate(e, Y.encodeStateAsUpdate(stale)); });
  attempt(); waiting.acknowledge(2); attempt(); waiting.acknowledge(1, 'wrong-epoch'); attempt();
  await waiting.barrier();
  assert.equal(expectDisk(f, 'base'), true);
  peer.doc.getText('content').insert(0, 'peer:');
  await peer.barrier();
  await waiting.barrier();
  assert.deepEqual(waiting.frames.map(frame => frame.type), [4], 'no Yjs broadcast reaches a pre-ack client');
  waiting.acknowledge(); waiting.sync();
  await waitFor(() => waiting.doc.getText('content').toString() === 'peer:base', 'negotiated client sync');
  assert.equal(expectDisk(f, 'peer:base'), true);
  stale.destroy();
});

test('a valid persisted Yjs history keeps its epoch while changed disk text starts a new epoch', async t => {
  const f = await fixture(), first = await rawClient(t, f);
  first.acknowledge(); first.sync();
  await waitFor(() => first.doc.getText('content').toString() === 'base', 'first sync');
  first.ws.close(); await first.closed;
  collab.reloadProjectRooms(f.project.id);
  const restored = await rawClient(t, f);
  assert.equal(restored.epoch, first.epoch);
  restored.ws.close(); await restored.closed;
  fs.writeFileSync(f.file, 'external replacement');
  collab.reloadProjectRooms(f.project.id);
  const replaced = await rawClient(t, f);
  assert.notEqual(replaced.epoch, first.epoch);
});

test('real provider retains unsent edits and its Y.Doc on a same-epoch reconnect without duplicated text', async t => {
  const f = await fixture(), session = await connectReal(t, f);
  if (!session) return;
  const doc = session.doc, epoch = session.epoch, provider = session.provider;
  provider.disconnect();
  await waitFor(() => session.status === 'disconnected', 'provider disconnected');
  session.ytext.insert(0, 'offline:');
  provider.connect();
  await waitFor(() => session.handshakeReady && provider.synced && expectDisk(f, 'offline:base'), 'offline update synchronized');
  assert.equal(session.doc, doc); assert.equal(session.epoch, epoch);
  assert.equal(session.ytext.toString(), 'offline:base');
  await waitFor(() => !session.hasLocalEdits, 'reconnected edits durably acknowledged');
});

test('real provider preserves a recovery draft instead of replaying stale Yjs items after a room epoch changes', async t => {
  const f = await fixture(), session = await connectReal(t, f);
  if (!session) return;
  const doc = session.doc, epoch = session.epoch, provider = session.provider;
  provider.disconnect();
  await waitFor(() => session.status === 'disconnected', 'provider disconnected');
  session.ytext.insert(0, 'private offline:');
  fs.writeFileSync(f.file, 'replacement from server');
  collab.reloadProjectRooms(f.project.id);
  provider.connect();
  await waitFor(() => session.doc !== doc && session.handshakeReady && session.provider.synced &&
    session.ytext.toString() === 'replacement from server', 'new epoch restored safely');
  assert.notEqual(session.epoch, epoch);
  assert.ok(session.recoveryDrafts.some(draft => draft.epoch === epoch && draft.text === 'private offline:base'));
  assert.equal(expectDisk(f, 'replacement from server'), true);
});

test('real provider stops reconnecting to a renamed path without a recovery draft for durably saved text', async t => {
  const f = await fixture(), session = await connectReal(t, f);
  if (!session) return;
  session.ytext.insert(0, 'edited:');
  await waitFor(() => expectDisk(f, 'edited:base') && !session.hasLocalEdits, 'accepted edit durably saved');
  const renamed = await api(srv.baseUrl, 'PATCH', '/api/projects/' + f.project.publicId + '/files', {
    token: owner.token, body: { path: 'main.tex', newPath: 'renamed.tex' },
  });
  assert.equal(renamed.status, 200);
  await waitFor(() => session.provider.shouldConnect === false && /移动|删除/.test(session.connectionError), 'renamed path closes permanently');
  assert.deepEqual(session.recoveryDrafts, []);
  assert.equal(fs.readFileSync(path.join(f.dir, 'renamed.tex'), 'utf8'), 'edited:base');
  assert.equal(fs.existsSync(f.file), false);
  clientModule.detachCollab(f.project.publicId, 'main.tex', session);
  const reopened = clientModule.attachCollab(f.project.publicId, 'renamed.tex');
  t.after(() => reopened.destroy());
  await waitFor(() => reopened.handshakeReady && reopened.provider.synced && reopened.ytext.toString() === 'edited:base', 'renamed tab opens server content');
  reopened.ytext.insert(reopened.ytext.length, ':continued');
  await waitFor(() => {
    collab.flushProjectRooms(f.project.id, { strict: true });
    return fs.readFileSync(path.join(f.dir, 'renamed.tex'), 'utf8') === 'edited:base:continued';
  }, 'editing continues under the new path');
  assert.equal(fs.existsSync(f.file), false);
});


for (const failState of [false, true]) {
  test('checkpoint waits for both file and Yjs state persistence; retry after ' + (failState ? 'state' : 'file') + ' write failure', async t => {
    const f = await fixture(), client = await rawClient(t, f);
    client.acknowledge(); client.sync();
    await waitFor(() => client.doc.getText('content').toString() === 'base', 'client sync');
    client.doc.getText('content').insert(0, 'pending:');
    client.checkpoint(1); await client.barrier();
    const saved = () => client.frames.filter(frame => 'savedCheckpoint' in frame).map(frame => frame.savedCheckpoint);
    assert.deepEqual(saved(), []);
    const original = fs.writeFileSync;
    fs.writeFileSync = function(file, ...args) {
      if (failState ? String(file).includes('/.build/collab/') : String(file) === f.file) throw new Error('injected persistence failure');
      return original.call(this, file, ...args);
    };
    try { assert.throws(() => collab.flushProjectRooms(f.project.id, { strict: true }), /injected persistence failure/); }
    finally { fs.writeFileSync = original; }
    client.checkpoint(1); await client.barrier();
    assert.deepEqual(saved(), [], 'a failed save cannot acknowledge the recovery draft');
    collab.flushProjectRooms(f.project.id, { strict: true });
    await waitFor(() => saved().includes(1), 'successful retry acknowledged');
    assert.equal(fs.readFileSync(f.file, 'utf8'), 'pending:base');
    client.doc.getText('content').delete(0, 'pending:'.length);
    client.checkpoint(2); await client.barrier();
    assert.deepEqual(saved(), [1], 'deletions need their own durable acknowledgement');
    collab.flushProjectRooms(f.project.id, { strict: true });
    await waitFor(() => saved().includes(2), 'deletion acknowledged');
    assert.equal(fs.readFileSync(f.file, 'utf8'), 'base');
    client.checkpoint(100, 'wrong-epoch'); client.checkpoint(-1); client.checkpoint(2.5);
    await client.barrier();
    assert.deepEqual(saved(), [1, 2], 'invalid checkpoints do not change saved state');
  });
}

test('compile checkpoint flushes the preceding edit before the save debounce', async t => {
  const f = await fixture(), client = await rawClient(t, f);
  client.acknowledge(); client.sync();
  await waitFor(() => client.doc.getText('content').toString() === 'base', 'client sync');
  client.doc.getText('content').insert(0, 'compile:');
  client.checkpoint(1, client.epoch, true);
  await client.barrier();
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'compile:base');
  assert.ok(client.frames.some(frame => frame.savedCheckpoint === 1));
});

test('read-only connection cannot acknowledge a rejected document update as durable', async t => {
  const f = await fixture(), viewer = await registerAndLogin(srv.baseUrl, 'checkpoint-viewer-' + serial);
  const membership = await api(srv.baseUrl, 'POST', '/api/projects/' + f.project.publicId + '/members', {
    token: owner.token, body: { username: viewer.user.username, role: 'viewer' },
  });
  assert.equal(membership.status, 200);
  const client = await rawClient(t, f, viewer.token);
  client.acknowledge(); client.sync();
  await waitFor(() => client.doc.getText('content').toString() === 'base', 'read-only sync');
  client.doc.getText('content').insert(0, 'rejected:'); client.checkpoint(1);
  await client.barrier();
  collab.flushProjectRooms(f.project.id, { strict: true });
  await client.barrier();
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'base');
  assert.equal(client.frames.some(frame => 'savedCheckpoint' in frame), false);
});

test('real provider clears dirty only after durable confirmation and normal close has no recovery draft', async t => {
  const f = await fixture(), session = await connectReal(t, f);
  if (!session) return;
  session.ytext.insert(0, 'saved:');
  assert.equal(session.hasLocalEdits, true);
  await waitFor(() => expectDisk(f, 'saved:base') && !session.hasLocalEdits, 'edit durable confirmation');
  session.ytext.delete(0, 6);
  assert.equal(session.hasLocalEdits, true, 'deletion remains dirty after older insert confirmation');
  await waitFor(() => expectDisk(f, 'base') && !session.hasLocalEdits, 'deletion durable confirmation');
  session.destroy();
  assert.deepEqual(session.recoveryDrafts, []);
});
