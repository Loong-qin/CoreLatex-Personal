import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as syncProtocol from 'y-protocols/sync';

// Set the isolated directory before dynamically importing any server module.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'corelatex-changeset-safety-'));
process.env.CORELATEX_DATA_DIR = dataDir;
let dbModule;
let changes;
let db;
let owner;
let token;
let server;
let base;

before(async () => {
  dbModule = await import('../src/db.js');
  db = dbModule.getDb();
  changes = await import('../src/services/agent/changesets.js');
  const { setupCollab } = await import('../src/collab.js');
  const { signToken } = await import('../src/auth.js');
  owner = Number(db.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'admin')")
    .run('changeset-owner', 'unused-test-hash').lastInsertRowid);
  token = signToken(db.prepare('SELECT * FROM users WHERE id = ?').get(owner));
  server = http.createServer();
  setupCollab(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = 'ws://127.0.0.1:' + server.address().port;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  dbModule?.resetDb();
  assert.ok(dataDir.startsWith(path.join(os.tmpdir(), 'corelatex-changeset-safety-')));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function fixture(contents = { 'main.tex': 'A\n' }) {
  const publicId = randomUUID();
  const id = Number(db.prepare('INSERT INTO projects (name, owner_id, public_id) VALUES (?, ?, ?)')
    .run('safety', owner, publicId).lastInsertRowid);
  const dir = path.join(dataDir, 'projects', String(id));
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(contents)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return { id, publicId, dir, read: (rel = 'main.tex') => fs.readFileSync(path.join(dir, rel), 'utf8') };
}

function proposal(f, files, applied = true) {
  return changes.createChangeset({ projectId: f.id, files, applied }).id;
}

function one(f, before = 'A\n', after = 'B\n', file = 'main.tex', applied = true) {
  return proposal(f, [{ path: file, before, after }], applied);
}

function expectConflict(fn) {
  assert.throws(fn, (err) => err.status === 409);
}

async function waitFor(predicate) {
  const end = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('Timed out waiting for the isolated collaboration client');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function connect(t, f, file = 'main.tex') {
  const doc = new Y.Doc();
  const ws = new WebSocket(base + '/collab?project=' + f.publicId
    + '&file=' + encodeURIComponent(file) + '&token=' + encodeURIComponent(token));
  t.after(async () => {
    if (ws.readyState !== WebSocket.CLOSED) {
      const closed = new Promise((resolve) => ws.once('close', resolve));
      ws.close();
      await closed;
    }
    doc.destroy();
  });
  ws.on('message', (data) => {
    const decoder = decoding.createDecoder(new Uint8Array(data));
    if (decoding.readVarUint(decoder) !== 0) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 0);
    syncProtocol.readSyncMessage(decoder, encoder, doc, 'remote');
    if (encoding.length(encoder) > 1 && ws.readyState === WebSocket.OPEN) {
      ws.send(encoding.toUint8Array(encoder));
    }
  });
  doc.on('update', (update, origin) => {
    if (origin === 'remote' || ws.readyState !== WebSocket.OPEN) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 0);
    syncProtocol.writeUpdate(encoder, update);
    ws.send(encoding.toUint8Array(encoder));
  });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, 0);
  syncProtocol.writeSyncStep1(encoder, doc);
  ws.send(encoding.toUint8Array(encoder));
  await waitFor(() => doc.getText('content').toString() === f.read(file));
  return { ws, doc };
}

async function unsavedEdit(t, f, content, file = 'main.tex') {
  const editor = await connect(t, f, file);
  const observer = await connect(t, f, file);
  const oldDisk = f.read(file);
  editor.doc.transact(() => {
    const text = editor.doc.getText('content');
    text.delete(0, text.length);
    text.insert(0, content);
  });
  // The second client receiving the edit proves the server holds it in memory.
  await waitFor(() => observer.doc.getText('content').toString() === content);
  assert.equal(f.read(file), oldDisk, 'The edit must still be inside the save debounce window');
  return observer;
}

test('new changesets remain unapplied until actual disk writes', () => {
  const f = fixture();
  const id = one(f);
  assert.equal(changes.getChangeset(id).applied, false);
  assert.equal(changes.getChangeset(id).files[0].applied, false);
  changes.applyChangeset(id);
  assert.equal(changes.getChangeset(id).applied, true);
  assert.equal(changes.getChangeset(id).files[0].applied, true);
  assert.deepEqual(changes.applyChangeset(id), { applied: 0, skipped: [] });
  assert.equal(changes.getReviewBase(f.id, 'main.tex'), 'A\n');
});

test('automatic apply flushes unsaved collaborative edits and leaves conflicting proposals unapplied', async (t) => {
  const f = fixture();
  const id = one(f);
  const observer = await unsavedEdit(t, f, 'human\n');
  assert.deepEqual(changes.applyChangeset(id), { applied: 0, skipped: ['main.tex'] });
  assert.equal(f.read(), 'human\n');
  assert.equal(observer.doc.getText('content').toString(), 'human\n');
  const pending = changes.getChangeset(id);
  assert.equal(pending.applied, false);
  assert.equal(pending.files[0].applied, false);
  expectConflict(() => changes.acceptChangeset(id));
  changes.revertChangeset(id);
  assert.equal(f.read(), 'human\n', 'Discarding an unapplied proposal cannot restore its before snapshot');
});

test('confirmation refuses to overwrite unsaved collaborative edits', async (t) => {
  const f = fixture();
  const id = one(f, 'A\n', 'B\n', 'main.tex', false);
  await unsavedEdit(t, f, 'human confirmation\n');
  expectConflict(() => changes.acceptChangeset(id));
  assert.equal(f.read(), 'human confirmation\n');
  assert.equal(changes.getChangeset(id).status, 'pending');
});

test('revert refuses to overwrite later collaborative edits', async (t) => {
  const f = fixture();
  const id = one(f);
  changes.applyChangeset(id);
  await unsavedEdit(t, f, 'B\nhuman continuation\n');
  expectConflict(() => changes.revertChangeset(id));
  assert.equal(f.read(), 'B\nhuman continuation\n');
  assert.equal(changes.getReviewBase(f.id, 'main.tex'), 'A\nhuman continuation\n', 'Human additions belong to the shadow baseline, not the AI diff');
  assert.equal(changes.getChangeset(id).status, 'pending');
});

test('revert protects AI-created files subsequently edited by a person', async (t) => {
  const f = fixture({});
  const id = one(f, null, 'created by AI\n', 'new.tex');
  changes.applyChangeset(id);
  await unsavedEdit(t, f, 'created by AI\nhuman additions\n', 'new.tex');
  expectConflict(() => changes.revertChangeset(id));
  assert.equal(f.read('new.tex'), 'created by AI\nhuman additions\n');
});

test('unchanged creations can still be reverted and already restored files stay restored', () => {
  const f = fixture();
  const id = one(f, null, 'new\n', 'new.tex');
  changes.applyChangeset(id);
  assert.equal(changes.revertChangeset(id).status, 'reverted');
  assert.equal(fs.existsSync(path.join(f.dir, 'new.tex')), false);
  const second = one(f);
  changes.applyChangeset(second);
  fs.writeFileSync(path.join(f.dir, 'main.tex'), 'A\n');
  assert.equal(changes.revertChangeset(second).status, 'reverted');
  assert.equal(f.read(), 'A\n');
});

test('a conflict prevents partial multi-file confirmation or rollback', () => {
  const f = fixture({ 'one.tex': 'one\n', 'two.tex': 'two\n' });
  const id = proposal(f, [
    { path: 'one.tex', before: 'one\n', after: 'AI one\n' },
    { path: 'two.tex', before: 'two\n', after: 'AI two\n' },
  ], false);
  fs.writeFileSync(path.join(f.dir, 'two.tex'), 'human two\n');
  expectConflict(() => changes.acceptChangeset(id));
  assert.equal(f.read('one.tex'), 'one\n');
  assert.ok(changes.getChangeset(id).files.every((r) => r.status === 'pending' && !r.applied));
  fs.writeFileSync(path.join(f.dir, 'two.tex'), 'two\n');
  changes.acceptChangeset(id);
  const next = proposal(f, [
    { path: 'one.tex', before: 'AI one\n', after: 'next one\n' },
    { path: 'two.tex', before: 'AI two\n', after: 'next two\n' },
  ]);
  changes.applyChangeset(next);
  fs.writeFileSync(path.join(f.dir, 'two.tex'), 'human later\n');
  expectConflict(() => changes.revertChangeset(next));
  assert.equal(f.read('one.tex'), 'next one\n');
  assert.ok(changes.getChangeset(next).files.every((r) => r.status === 'pending'));
});

test('partial automatic apply tracks each file and discard preserves conflicting human creations', () => {
  const f = fixture();
  const id = proposal(f, [
    { path: 'main.tex', before: 'A\n', after: 'B\n' },
    { path: 'new.tex', before: null, after: 'AI creation\n' },
  ]);
  fs.writeFileSync(path.join(f.dir, 'new.tex'), 'human creation\n');
  assert.deepEqual(changes.applyChangeset(id), { applied: 1, skipped: ['new.tex'] });
  const mixed = changes.getChangeset(id);
  assert.equal(mixed.applied, false);
  assert.deepEqual(mixed.files.map((r) => r.applied), [true, false]);
  fs.writeFileSync(path.join(f.dir, 'main.tex'), 'human after AI\n');
  changes.acceptChangeset(id, 'main.tex');
  changes.revertChangeset(id, 'new.tex');
  assert.equal(f.read(), 'human after AI\n');
  assert.equal(f.read('new.tex'), 'human creation\n');
  assert.equal(changes.getChangeset(id).status, 'accepted');
});

test('new confirm-mode proposals survive pending listing and startup reconciliation', () => {
  const f = fixture({});
  const id = one(f, null, 'proposal\n', 'not-created.tex', false);
  assert.ok(changes.listChangesets(f.id).some((r) => r.id === id));
  changes.migratePendingReviews();
  assert.equal(changes.getChangeset(id).status, 'pending');
  assert.equal(changes.getChangeset(id).applied, false);
  changes.acceptChangeset(id);
  assert.equal(f.read('not-created.tex'), 'proposal\n');
});

test('rolling review retains the earliest baseline across AI rounds and reverse-order rollback', () => {
  const f = fixture();
  const first = one(f);
  changes.applyChangeset(first);
  const second = one(f, 'B\n', 'C\n');
  changes.applyChangeset(second);
  assert.equal(changes.getReviewBase(f.id, 'main.tex'), 'A\n');
  expectConflict(() => changes.revertChangeset(first));
  changes.revertChangeset(second);
  assert.equal(f.read(), 'B\n');
  assert.equal(changes.getReviewBase(f.id, 'main.tex'), 'A\n');
  changes.revertChangeset(first);
  assert.equal(f.read(), 'A\n');
  assert.equal(changes.getReviewBase(f.id, 'main.tex'), null);
});

test('accepting an earlier round advances the baseline for remaining pending changes', () => {
  const f = fixture();
  const first = one(f);
  changes.applyChangeset(first);
  const second = one(f, 'B\n', 'C\n');
  changes.applyChangeset(second);
  changes.acceptChangeset(first);
  assert.equal(f.read(), 'C\n');
  assert.equal(changes.getReviewBase(f.id, 'main.tex'), 'B\n');
  changes.revertChangeset(second);
  assert.equal(f.read(), 'B\n');
});

test('startup never replays old content or silently accepts pending changes', () => {
  const f = fixture();
  const id = one(f);
  changes.applyChangeset(id);
  changes.migratePendingReviews();
  assert.equal(changes.getReviewBase(f.id, 'main.tex'), 'A\n');
  changes.setReviewBase(f.id, 'main.tex', 'partially accepted baseline\n');
  fs.writeFileSync(path.join(f.dir, 'main.tex'), 'human after restart\n');
  changes.migratePendingReviews();
  assert.equal(f.read(), 'human after restart\n');
  assert.equal(changes.getReviewBase(f.id, 'main.tex'), 'partially accepted baseline\n');
  changes.deleteReviewBase(f.id, 'main.tex');
  changes.migratePendingReviews();
  assert.equal(changes.getReviewBase(f.id, 'main.tex'), 'A\n');
  fs.rmSync(path.join(f.dir, 'main.tex'));
  changes.migratePendingReviews();
  assert.equal(fs.existsSync(path.join(f.dir, 'main.tex')), false);
  assert.equal(changes.getChangeset(id).status, 'reverted');
});

test('legacy applied migration handles partial confirmation and remains idempotent', () => {
  const f = fixture({});
  const partial = proposal(f, [
    { path: 'accepted.tex', before: null, after: 'accepted\n' },
    { path: 'pending.tex', before: null, after: 'pending\n' },
  ], false);
  db.prepare("UPDATE changeset_files SET status = 'accepted' WHERE changeset_id = ? AND file_path = ?")
    .run(partial, 'accepted.tex');
  const automatic = one(f, null, 'automatic\n', 'automatic.tex');
  db.prepare('UPDATE changesets SET applied = 1 WHERE id = ?').run(automatic);
  db.exec('ALTER TABLE changeset_files DROP COLUMN applied');
  dbModule.resetDb();
  db = dbModule.getDb();
  const states = () => db.prepare('SELECT applied FROM changeset_files WHERE changeset_id = ? ORDER BY id')
    .all(partial).map((r) => r.applied);
  assert.deepEqual(states(), [1, 0]);
  assert.equal(db.prepare('SELECT applied FROM changeset_files WHERE changeset_id = ?').get(automatic).applied, 1);
  dbModule.resetDb();
  db = dbModule.getDb();
  assert.deepEqual(states(), [1, 0]);
});

for (const operation of ['apply', 'accept', 'revert']) {
  test(operation + ' rolls back disk and DB when a later file rename fails', async (t) => {
    const f = fixture({ 'one.tex': 'one\n', 'two.tex': 'two\n' });
    const id = proposal(f, [
      { path: 'one.tex', before: 'one\n', after: 'AI one\n' },
      { path: 'two.tex', before: 'two\n', after: 'AI two\n' },
    ]);
    if (operation === 'revert') changes.applyChangeset(id);
    const originalOne = f.read('one.tex'), originalTwo = f.read('two.tex');
    const observer = await connect(t, f, 'one.tex');
    const originalState = changes.getChangeset(id);
    const baseline = changes.getReviewBase(f.id, 'one.tex');
    const rename = fs.renameSync;
    let injected = false;
    fs.renameSync = (from, to) => {
      if (!injected && to === path.join(f.dir, 'two.tex') && String(from).endsWith('.after')) {
        injected = true;
        throw Object.assign(new Error('synthetic disk failure'), { code: 'EIO' });
      }
      return rename(from, to);
    };
    try {
      assert.throws(() => ({
        apply: changes.applyChangeset,
        accept: changes.acceptChangeset,
        revert: changes.revertChangeset,
      }[operation](id)), /synthetic disk failure/);
    } finally { fs.renameSync = rename; }
    assert.equal(injected, true);
    assert.equal(f.read('one.tex'), originalOne);
    assert.equal(f.read('two.tex'), originalTwo);
    assert.equal(observer.doc.getText('content').toString(), originalOne);
    assert.deepEqual(changes.getChangeset(id), originalState);
    assert.equal(changes.getReviewBase(f.id, 'one.tex'), baseline);
  });
}
test('a database failure after file swaps restores every file', () => {
  const f = fixture({ 'one.tex': 'one\n', 'two.tex': 'two\n' });
  const id = proposal(f, [
    { path:'one.tex',before:'one\n',after:'new one\n' },
    { path:'two.tex',before:'two\n',after:'new two\n' },
  ]);
  db.exec("CREATE TEMP TRIGGER reject_apply BEFORE UPDATE OF applied ON changeset_files WHEN NEW.applied=1 BEGIN SELECT RAISE(ABORT, 'synthetic DB failure'); END;");
  try { assert.throws(()=>changes.applyChangeset(id),/synthetic DB failure/); }
  finally { db.exec('DROP TRIGGER reject_apply'); }
  assert.equal(f.read('one.tex'),'one\n');
  assert.equal(f.read('two.tex'),'two\n');
  assert.ok(changes.getChangeset(id).files.every(row=>!row.applied));
});


test('manual replacement cannot be overwritten by an older collaborative save timer', async (t) => {
  const f = fixture(); const id = one(f); changes.applyChangeset(id);
  await unsavedEdit(t, f, 'B\nhuman pending\n');
  fs.writeFileSync(path.join(f.dir, 'main.tex'), 'explicit manual replacement\n');
  changes.reconcileContentReplaced(f.id, ['main.tex']);
  const snapshot = changes.getReviewSnapshot(f.id, 'main.tex');
  assert.equal(snapshot.pending, false);
  assert.equal(snapshot.current, 'explicit manual replacement\n');
  assert.equal(f.read(), 'explicit manual replacement\n');
  assert.equal(changes.getChangeset(id).status, 'accepted');
});


test('formal tool baselines flush live human edits and review only the new AI delta', async (t) => {
  const f = fixture({ 'main.tex': 'old title\noriginal body\n' });
  const first = await connect(t, f), second = await connect(t, f);
  const human = 'human title\noriginal body\n';
  first.doc.transact(() => {
    first.doc.getText('content').delete(0, first.doc.getText('content').length);
    first.doc.getText('content').insert(0, human);
  });
  await waitFor(() => second.doc.getText('content').toString() === human);
  // The live room has the manual text while its debounce has not written disk yet.
  assert.equal(f.read(), 'old title\noriginal body\n');
  const { executeTool } = await import('../src/services/agent/tools.js');
  const ctx = { project: db.prepare('SELECT * FROM projects WHERE id=?').get(f.id),
    user: db.prepare('SELECT * FROM users WHERE id=?').get(owner), projectDir: f.dir,
    workspaceDir: path.join(f.dir, '_workspace'), reads: new Map(), changesetBuffer: [], agentConfig: {} };
  assert.equal(await executeTool('read_file', { path: 'main.tex' }, ctx), human);
  assert.equal(f.read(), human);
  const result = await executeTool('edit_file', { path: 'main.tex', search: 'original body', replace: 'AI body' }, ctx);
  assert.equal(result.changed, true); assert.equal(result.staged, true); assert.equal(result.scope, 'project');
  assert.deepEqual(ctx.changesetBuffer, [{ path: 'main.tex', before: human, after: 'human title\nAI body\n', encoding: 'utf8' }]);
  const proposal = changes.createChangeset({ projectId: f.id, files: ctx.changesetBuffer });
  assert.deepEqual(changes.applyChangeset(proposal.id), { applied: 1, skipped: [] });
  const review = changes.getReviewSnapshot(f.id, 'main.tex');
  assert.equal(review.base, human);
  assert.equal(review.current, 'human title\nAI body\n');
  assert.equal(proposal.files[0].adds, 1); assert.equal(proposal.files[0].dels, 1);
});
