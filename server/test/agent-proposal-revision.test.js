import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { startTestServer, api } from './helpers.js';

let srv, db, dbModule, changes, owner, token;
before(async () => {
  srv = await startTestServer(); dbModule = await import('../src/db.js'); db = dbModule.getDb();
  changes = await import('../src/services/agent/changesets.js');
  const { signToken } = await import('../src/auth.js');
  owner = Number(db.prepare("INSERT INTO users(username,password_hash,role) VALUES('proposal-revision','unused','admin')").run().lastInsertRowid);
  token = signToken(db.prepare('SELECT * FROM users WHERE id=?').get(owner));
});
after(async () => { await srv.close(); dbModule.resetDb(); });
function fixture(binary = false) {
  const publicId = randomUUID(), projectId = Number(db.prepare('INSERT INTO projects(name,owner_id,public_id) VALUES(?,?,?)').run('proposal revisions', owner, publicId).lastInsertRowid);
  const chatId = Number(db.prepare('INSERT INTO chats(project_id,user_id) VALUES(?,?)').run(projectId, owner).lastInsertRowid);
  const dir = path.join(srv.dataDir, 'projects', String(projectId)); fs.mkdirSync(dir, { recursive: true });
  const file = binary ? 'figure.png' : 'notes.txt', encoding = binary ? 'base64' : 'utf8';
  const before = binary ? Buffer.from([0,1,2]).toString('base64') : 'original';
  const shown = binary ? Buffer.from([0,3,4]).toString('base64') : 'shown';
  const newer = binary ? Buffer.from([0,5,6]).toString('base64') : 'not yet reviewed';
  fs.writeFileSync(path.join(dir, file), Buffer.from(before, encoding));
  const { id } = changes.createChangeset({ projectId, chatId, files: [{ path: file, before, after: shown, encoding }] });
  return { id, projectId, chatId, publicId, file, before, shown, newer, encoding,
    read: () => fs.readFileSync(path.join(dir, file)).toString(encoding),
    revise: () => changes.revisePendingChangeset({ id, projectId, chatId,
      fingerprint: changes.pendingChangesetState(id).fingerprint, files: [{ path: file, before, after: newer, encoding }] }) };
}
const request = (f, method, suffix = '', body) => api(srv.baseUrl, method, `/api/projects/${f.publicId}/changesets/${f.id}${suffix}`, { token, body });
const state = f => JSON.stringify(changes.pendingChangesetState(f.id));

for (const action of ['accept', 'revert']) for (const whole of [false, true]) test(`${action} rejects a stale or missing revision for ${whole ? 'whole proposal' : 'one file'} before any file or review mutation`, () => {
  const f = fixture(), stale = changes.getFileDiff(f.id, f.file); assert.equal(stale.proposalRevision, 0);
  f.revise(); assert.equal(changes.getChangeset(f.id).proposalRevision, 1);
  const beforeState = state(f);
  for (const revision of [undefined, stale.proposalRevision, null, false, '', '1', 1.5, -1, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => changes[action + 'Changeset'](f.id, whole ? undefined : f.file, revision), error => error.status === 409);
    assert.equal(state(f), beforeState); assert.equal(f.read(), f.before);
  }
  changes[action + 'Changeset'](f.id, whole ? undefined : f.file, 1);
  assert.equal(changes.getChangeset(f.id).status, action === 'accept' ? 'accepted' : 'reverted');
  assert.equal(f.read(), action === 'accept' ? f.newer : f.before);
});

test('binary diffs carry the exact version even when both revisions have identical byte sizes', async () => {
  const f = fixture(true), shown = (await request(f, 'GET', '/diff?file=' + f.file)).data;
  assert.equal(shown.proposalRevision, 0); f.revise();
  const next = (await request(f, 'GET', '/diff?file=' + f.file)).data;
  assert.equal(next.proposalRevision, 1); assert.equal(next.afterBytes, shown.afterBytes);
  assert.equal((await request(f, 'POST', '/accept', { filePath: f.file, expectedRevision: shown.proposalRevision })).status, 409);
  assert.equal(f.read(), f.before);
  assert.equal((await request(f, 'POST', '/accept', { filePath: f.file, expectedRevision: next.proposalRevision })).status, 200);
  assert.equal(f.read(), f.newer);
});

for (const action of ['accept', 'revert']) test(`HTTP ${action} requires the displayed revision and preserves legacy untouched proposal compatibility`, async () => {
  const f = fixture();
  const old = await request(f, 'GET', '/diff?file=' + f.file); assert.equal(old.status, 200); assert.equal(old.data.after, f.shown);
  f.revise();
  const listed = await api(srv.baseUrl, 'GET', `/api/projects/${f.publicId}/changesets`, { token });
  assert.equal(listed.data.changesets[0].proposalRevision, 1);
  assert.equal((await request(f, 'GET')).data.changeset.proposalRevision, 1);
  const unchanged = state(f);
  for (const body of [{}, { filePath: f.file }, { expectedRevision: 0 }, { filePath: f.file, expectedRevision: 0 }, { expectedRevision: null }]) {
    const result = await request(f, 'POST', '/' + action, body);
    assert.equal(result.status, 409); assert.match(result.data.error, /重新打开/);
    assert.equal(state(f), unchanged); assert.equal(f.read(), f.before);
  }
  const fresh = await request(f, 'GET', '/diff?file=' + f.file); assert.equal(fresh.data.after, f.newer);
  assert.equal((await request(f, 'POST', '/' + action, { expectedRevision: fresh.data.proposalRevision })).status, 200);
  const legacy = fixture();
  assert.equal((await request(legacy, 'POST', '/' + action, { expectedRevision: 1 })).status, 409);
  assert.equal((await request(legacy, 'POST', '/' + action, {})).status, 200);
});

test('old databases migrate proposal_revision to zero without changing pending proposal bytes', () => {
  const f = fixture();
  db.exec('ALTER TABLE changesets DROP COLUMN proposal_revision'); dbModule.resetDb(); db = dbModule.getDb();
  assert.equal(db.prepare('SELECT proposal_revision FROM changesets WHERE id=?').get(f.id).proposal_revision, 0);
  assert.equal(changes.getFileDiff(f.id, f.file).after, f.shown); assert.equal(f.read(), f.before);
});
