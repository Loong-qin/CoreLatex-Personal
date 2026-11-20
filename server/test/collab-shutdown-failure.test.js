import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as syncProtocol from 'y-protocols/sync';
import { startTestServer, api, registerAndLogin } from './helpers.js';

async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Collaboration state timeout'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
async function connect(srv, project, token) {
  const doc = new Y.Doc();
  const ws = new WebSocket(srv.baseUrl.replace('http:', 'ws:') + '/collab?project=' + project.publicId + '&file=main.tex&token=' + encodeURIComponent(token));
  const closed = new Promise(resolve => ws.once('close', resolve));
  ws.on('message', bytes => {
    const decoder = decoding.createDecoder(new Uint8Array(bytes));
    if (decoding.readVarUint(decoder) !== 0) return;
    const response = encoding.createEncoder(); encoding.writeVarUint(response, 0);
    syncProtocol.readSyncMessage(decoder, response, doc, 'remote');
    if (encoding.length(response) > 1 && ws.readyState === WebSocket.OPEN) ws.send(encoding.toUint8Array(response));
  });
  doc.on('update', (update, origin) => {
    if (origin === 'remote' || ws.readyState !== WebSocket.OPEN) return;
    const message = encoding.createEncoder(); encoding.writeVarUint(message, 0); syncProtocol.writeUpdate(message, update);
    ws.send(encoding.toUint8Array(message));
  });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const message = encoding.createEncoder(); encoding.writeVarUint(message, 0); syncProtocol.writeSyncStep1(message, doc); ws.send(encoding.toUint8Array(message));
  await until(() => doc.getText('content').toString() === 'base');
  return { ws, doc, closed };
}

test('client disconnect after a strict shutdown save failure cannot discard dirty accepted text', async () => {
  const srv = await startTestServer();
  const owner = await registerAndLogin(srv.baseUrl, 'shutdown-dirty-owner');
  const { data } = await api(srv.baseUrl, 'POST', '/api/projects', { token: owner.token, body: { name: 'shutdown dirty' } });
  const project = data.project, file = path.join(srv.dataDir, 'projects', String(project.id), 'main.tex');
  fs.writeFileSync(file, 'base');
  const { closeCollabForShutdown } = await import('../src/collab.js');
  const clients = [];
  try {
    clients.push(await connect(srv, project, owner.token), await connect(srv, project, owner.token));
    clients[0].doc.getText('content').insert(0, 'accepted before shutdown:');
    await until(() => clients[1].doc.getText('content').toString() === 'accepted before shutdown:base');
    fs.unlinkSync(file);
    assert.throws(() => closeCollabForShutdown(), error => error.code === 'COLLAB_FILE_DELETED');
    for (const client of clients) client.ws.close();
    await Promise.all(clients.map(client => client.closed));
    assert.equal(fs.existsSync(file), false, 'disconnect does not recreate the deleted file');
    // Recovery restores the path. The retry must still own and save the exact
    // previously accepted document after its last client has disconnected.
    fs.writeFileSync(file, 'base');
    closeCollabForShutdown();
    assert.equal(fs.readFileSync(file, 'utf8'), 'accepted before shutdown:base');
  } finally {
    for (const client of clients) { if (client.ws.readyState !== WebSocket.CLOSED) client.ws.close(); await client.closed; client.doc.destroy(); }
    await srv.close();
  }
});
