import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as syncProtocol from 'y-protocols/sync';
import { diffLines } from 'diff';
import { startTestServer, api } from './helpers.js';

let srv, db, dbModule, changes, owner, token;
const file = 'X_suppl.tex';
const original = '\\subsection{Effect of the Poisoning Rate}\n\\label{old-label}\n'
  + Array.from({ length: 9 }, (_, i) => `unchanged ${i}\n`).join('')
  + 'Figure caption one.\n' + Array.from({ length: 9 }, (_, i) => `gap ${i}\n`).join('')
  + 'Figure caption two.\n';
const manualTitle = original.replace('Poisoning Rate', 'Poisoning').replace('old-label', 'supp_subsec:rate');

before(async () => {
  srv = await startTestServer();
  dbModule = await import('../src/db.js'); db = dbModule.getDb();
  changes = await import('../src/services/agent/changesets.js');
  const { signToken } = await import('../src/auth.js');
  owner = Number(db.prepare("INSERT INTO users(username,password_hash,role) VALUES('review-origin','unused','admin')").run().lastInsertRowid);
  token = signToken(db.prepare('SELECT * FROM users WHERE id=?').get(owner));
});
after(async () => { await srv.close(); dbModule.resetDb(); });

function fixture(content = original) {
  const publicId = randomUUID();
  const id = Number(db.prepare('INSERT INTO projects(name,owner_id,public_id) VALUES(?,?,?)').run('review-origin', owner, publicId).lastInsertRowid);
  const dir = path.join(srv.dataDir, 'projects', String(id));
  fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, file), content);
  return { id, publicId, dir, read: () => fs.readFileSync(path.join(dir, file), 'utf8') };
}
function ai(f, before, after) {
  const { id } = changes.createChangeset({ projectId: f.id, files: [{ path: file, before, after }] });
  changes.applyChangeset(id); return id;
}
async function snapshot(f) {
  const response = await api(srv.baseUrl, 'GET', `/api/projects/${f.publicId}/review/base?file=${file}`, { token });
  assert.equal(response.status, 200); return response.data;
}
function hunks(base, current) {
  let a = 1, b = 1, pending;
  const out = [];
  const close = () => { if (pending) { out.push(pending); pending = null; } };
  for (const part of diffLines(base, current)) {
    if (!part.added && !part.removed) { close(); a += part.count; b += part.count; continue; }
    pending ||= { baseFrom: a, baseTo: a - 1, docFrom: b, docTo: b - 1, before: '', after: '' };
    if (part.removed) { pending.before += part.value; a += part.count; pending.baseTo = a - 1; }
    if (part.added) { pending.after += part.value; b += part.count; pending.docTo = b - 1; }
  }
  close(); return out;
}
function decide(f, state, hunk, action = 'revert') {
  const { baseFrom, baseTo, docFrom, docTo } = hunk;
  return api(srv.baseUrl, 'POST', `/api/projects/${f.publicId}/review/hunk`, { token,
    body: { file, action, revision: state.revision, current: state.current, baseFrom, baseTo, docFrom, docTo } });
}
async function waitFor(predicate) {
  const deadline = Date.now() + 4000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Fixture collaboration timed out'); await new Promise((r) => setTimeout(r, 5)); }
}
async function connect(t, f) {
  const doc = new Y.Doc();
  const ws = new WebSocket(srv.baseUrl.replace(/^http/, 'ws') + `/collab?project=${f.publicId}&file=${file}&token=${encodeURIComponent(token)}`);
  ws.on('message', (data) => {
    const d = decoding.createDecoder(new Uint8Array(data));
    if (decoding.readVarUint(d) !== 0) return;
    const e = encoding.createEncoder(); encoding.writeVarUint(e, 0);
    syncProtocol.readSyncMessage(d, e, doc, 'server');
    if (encoding.length(e) > 1 && ws.readyState === WebSocket.OPEN) ws.send(encoding.toUint8Array(e));
  });
  doc.on('update', (update, origin) => {
    if (origin === 'server' || ws.readyState !== WebSocket.OPEN) return;
    const e = encoding.createEncoder(); encoding.writeVarUint(e, 0); syncProtocol.writeUpdate(e, update); ws.send(encoding.toUint8Array(e));
  });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const e = encoding.createEncoder(); encoding.writeVarUint(e, 0); syncProtocol.writeSyncStep1(e, doc); ws.send(encoding.toUint8Array(e));
  await waitFor(() => doc.getText('content').toString() === f.read());
  t.after(async () => {
    if (ws.readyState !== WebSocket.CLOSED) { const done = new Promise((r) => ws.once('close', r)); ws.close(); await done; }
    doc.destroy();
  });
  return doc;
}
async function human(t, f, content) {
  const doc = await connect(t, f), observer = await connect(t, f);
  doc.transact(() => { const text = doc.getText('content'); text.delete(0, text.length); text.insert(0, content); });
  await waitFor(() => observer.getText('content').toString() === content);
}

test('opening review before manual edits never leaves a baseline that later labels them AI', async () => {
  const f = fixture();
  assert.equal((await snapshot(f)).pending, false);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM review_bases WHERE project_id=?').get(f.id).n, 0);
  fs.writeFileSync(path.join(f.dir, file), manualTitle);
  const after = manualTitle.replace('caption one.', 'caption one revised by AI.');
  ai(f, manualTitle, after);
  const state = await snapshot(f);
  assert.equal(state.base, manualTitle);
  assert.equal(state.current, after);
  assert.equal(hunks(state.base, state.current).length, 1);
});

test('AI-only rejection keeps the exact manual title and label from the screenshot', async (t) => {
  const f = fixture();
  const after = original.replace('caption one.', 'caption one revised by AI.');
  ai(f, original, after);
  const mixed = after.replace('Poisoning Rate', 'Poisoning').replace('old-label', 'supp_subsec:rate');
  await human(t, f, mixed);
  const state = await snapshot(f);
  assert.equal(state.base, manualTitle);
  assert.equal(state.current, mixed);
  const only = hunks(state.base, state.current);
  assert.equal(only.length, 1);
  const result = await decide(f, state, only[0]);
  assert.equal(result.status, 200);
  assert.equal(f.read(), manualTitle);
});

test('two AI rounds separated by human changes retain both AI changes and exclude human text', async (t) => {
  const f = fixture();
  const first = original.replace('caption one.', 'caption one AI.');
  ai(f, original, first);
  const mixed = first.replace('Poisoning Rate', 'Poisoning').replace('old-label', 'supp_subsec:rate');
  await human(t, f, mixed);
  await snapshot(f); // flush accepted collaborative changes
  const second = mixed.replace('caption two.', 'caption two AI.');
  ai(f, mixed, second);
  let state = await snapshot(f);
  assert.equal(state.base, manualTitle);
  assert.equal(hunks(state.base, state.current).length, 2);
  assert.equal((await decide(f, state, hunks(state.base, state.current)[0], 'accept')).status, 200);
  state = await snapshot(f);
  assert.equal(hunks(state.base, state.current).length, 1);
  assert.equal((await decide(f, state, hunks(state.base, state.current)[0])).status, 200);
  assert.equal(f.read(), manualTitle.replace('caption one.', 'caption one AI.'));
});

test('an old review decision cannot overwrite a collaborator edit or silently approve it', async (t) => {
  const f = fixture();
  const after = original.replace('caption one.', 'caption one AI.');
  ai(f, original, after);
  const stale = await snapshot(f);
  const newer = after.replace('old-label', 'human-latest');
  await human(t, f, newer);
  const result = await decide(f, stale, hunks(stale.base, stale.current)[0]);
  assert.equal(result.status, 409);
  assert.equal((await snapshot(f)).current, newer);
});

test('legacy polluted review records are repaired without modifying document bytes', async () => {
  const f = fixture();
  const first = original.replace('caption one.', 'caption one AI.');
  ai(f, original, first);
  const mixed = first.replace('Poisoning Rate', 'Poisoning').replace('old-label', 'supp_subsec:rate');
  fs.writeFileSync(path.join(f.dir, file), mixed);
  const second = mixed.replace('caption two.', 'caption two AI.');
  ai(f, mixed, second);
  db.prepare('UPDATE review_bases SET base_content=?,head_content=NULL WHERE project_id=? AND file_path=?').run(original, f.id, file);
  const state = await snapshot(f);
  assert.equal(state.base, manualTitle);
  assert.equal(state.current, second);
  assert.equal(f.read(), second);
  assert.equal(hunks(state.base, state.current).length, 2);
});


test('legacy repair keeps a partially accepted AI block accepted and does not duplicate human edits', async (t) => {
  const f = fixture();
  const after = original.replace('caption one.', 'caption one AI.').replace('caption two.', 'caption two AI.');
  ai(f, original, after);
  let state = await snapshot(f);
  assert.equal((await decide(f, state, hunks(state.base, state.current)[0], 'accept')).status, 200);
  const mixed = after.replace('Poisoning Rate', 'Poisoning').replace('old-label', 'supp_subsec:rate');
  await human(t, f, mixed);
  state = await snapshot(f);
  const acceptedBase = manualTitle.replace('caption one.', 'caption one AI.');
  assert.equal(state.base, acceptedBase);
  db.prepare('UPDATE review_bases SET head_content=NULL WHERE project_id=? AND file_path=?').run(f.id, file);
  const repaired = await snapshot(f);
  assert.equal(repaired.base, acceptedBase);
  assert.equal(hunks(repaired.base, repaired.current).length, 1);
  assert.equal(f.read(), mixed);
});


test('hunk HTTP responses include authoritative pending changesets without a follow-up GET', async () => {
  const f = fixture();
  const after = original.replace('caption one.', 'caption one AI.').replace('caption two.', 'caption two AI.');
  const id = ai(f, original, after);
  const initial = await snapshot(f);
  const partial = await decide(f, initial, hunks(initial.base, initial.current)[0], 'accept');
  assert.equal(partial.status, 200);
  assert.equal(partial.data.pending, true);
  assert.deepEqual(partial.data.changesets.map(item => item.id), [id]);
  assert.equal(partial.data.changesets[0].status, 'pending');
  // Use the POST's own snapshot for the next decision. No refresh request is
  // needed either to continue reviewing or to remove the final pending entry.
  const final = await decide(f, partial.data, hunks(partial.data.base, partial.data.current)[0], 'accept');
  assert.equal(final.status, 200);
  assert.equal(final.data.pending, false);
  assert.deepEqual(final.data.changesets, []);
  assert.equal(changes.getChangeset(id).status, 'accepted');
  assert.equal(f.read(), after);
});
