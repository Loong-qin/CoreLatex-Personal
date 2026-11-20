import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'corelatex-review-state-'));
process.env.CORELATEX_DATA_DIR = dataDir;
let dbModule, db, changes, state, owner;
before(async () => {
  dbModule = await import('../src/db.js'); db = dbModule.getDb();
  changes = await import('../src/services/agent/changesets.js');
  state = await import('../src/services/agent/reviewState.js');
  owner = Number(db.prepare("INSERT INTO users(username,password_hash,role) VALUES('review-state','unused','admin')").run().lastInsertRowid);
});
after(() => {
  dbModule?.resetDb();
  assert.ok(dataDir.startsWith(path.join(os.tmpdir(), 'corelatex-review-state-')));
  fs.rmSync(dataDir, { recursive: true, force: true });
});
function fixture(content) {
  const id = Number(db.prepare('INSERT INTO projects(name,owner_id,public_id) VALUES(?,?,?)').run('review-state', owner, randomUUID()).lastInsertRowid);
  const dir = path.join(dataDir, 'projects', String(id)); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'main.tex'); fs.writeFileSync(file, content);
  return { id, file, read: () => fs.readFileSync(file, 'utf8') };
}
function ai(f, before, after, apply = true) {
  const { id } = changes.createChangeset({ projectId: f.id, files: [{ path: 'main.tex', before, after }] });
  if (apply) changes.applyChangeset(id);
  return id;
}
function snapshot(f) { return changes.getReviewSnapshot(f.id, 'main.tex'); }
function decide(f, snap, action, index = 0) {
  const hunk = state.reviewHunks(snap.base, snap.current)[index];
  assert.ok(hunk);
  return changes.resolveReviewHunk(f.id, 'main.tex', { ...hunk, action, revision: snap.revision, current: snap.current });
}

const boundaries = [
  ['insert into empty file', '', 'AI'],
  ['delete whole file content', 'old', ''],
  ['remove trailing newline', 'old\n', 'old'],
  ['append trailing newline', 'old', 'old\n'],
  ['insert blank line at end', 'old\n', 'old\n\n'],
  ['remove blank line at end', 'old\n\n', 'old\n'],
  ['insert only blank line', '', '\n'],
  ['replace final unterminated line', 'keep\nold', 'keep\nAI'],
  ['delete final unterminated line', 'keep\nold', 'keep\n'],
  ['preserve CRLF', 'keep\r\nold\r\n', 'keep\r\nAI\r\n'],
];
for (const [name, beforeText, afterText] of boundaries) {
  for (const action of ['accept', 'revert']) test(`${action} uses exact bytes: ${name}`, () => {
    const f = fixture(beforeText); const id = ai(f, beforeText, afterText);
    const result = decide(f, snapshot(f), action);
    const expected = action === 'accept' ? afterText : beforeText;
    assert.equal(f.read(), expected);
    assert.equal(result.current, expected); assert.equal(result.base, expected); assert.equal(result.pending, false);
    assert.equal(changes.getChangeset(id).status, 'accepted');
    assert.equal(changes.getReviewBase(f.id, 'main.tex'), null);
  });
}

test('manual ownership completes applied review bookkeeping without consuming unapplied proposals', () => {
  const f = fixture('old\n'); const applied = ai(f, 'old\n', 'AI\n');
  const proposal = ai(f, 'AI\n', 'unapplied\n', false);
  fs.writeFileSync(f.file, 'human\n');
  assert.equal(snapshot(f).pending, false);
  assert.equal(changes.getChangeset(applied).status, 'accepted');
  assert.equal(changes.getChangeset(proposal).status, 'pending');
  assert.equal(changes.getChangeset(proposal).files[0].applied, false);
  assert.equal(changes.getReviewBase(f.id, 'main.tex'), null);
});

test('manual upload keeps independent AI regions but invalidates stale unapplied proposals', () => {
  const beforeText = 'title\nkeep\nold\n'; const afterText = 'title\nkeep\nAI\n';
  const f = fixture(beforeText); const applied = ai(f, beforeText, afterText);
  const proposal = ai(f, afterText, afterText + 'unapplied\n', false);
  fs.writeFileSync(f.file, 'human title\nkeep\nAI\n');
  assert.deepEqual(changes.reconcileContentReplaced(f.id, ['main.tex']), ['main.tex']);
  const snap = snapshot(f);
  assert.equal(snap.base, 'human title\nkeep\nold\n'); assert.equal(snap.pending, true);
  assert.equal(changes.getChangeset(applied).status, 'pending');
  assert.equal(changes.getChangeset(proposal).status, 'reverted');
  decide(f, snap, 'revert');
  assert.equal(f.read(), 'human title\nkeep\nold\n');
});

test('unversioned baseline writes and forged hunk coordinates cannot change review or bytes', () => {
  const f = fixture('old\n'); ai(f, 'old\n', 'AI\n');
  const snap = snapshot(f);
  assert.throws(() => changes.updateReviewBase(f.id, 'main.tex', { content: 'wrong\n' }), (e) => e.status === 409);
  assert.throws(() => changes.resolveReviewHunk(f.id, 'main.tex', {
    action: 'revert', revision: snap.revision, current: snap.current, baseFrom: 1, baseTo: 999, docFrom: 1, docTo: 999,
  }), (e) => e.status === 409);
  assert.throws(() => changes.resolveReviewHunk(f.id, 'main.tex', {
    ...state.reviewHunks(snap.base, snap.current)[0], action: 'revert', revision: snap.revision, current: 'outdated',
  }), (e) => e.status === 409);
  assert.deepEqual(snapshot(f), snap); assert.equal(f.read(), 'AI\n');
});

test('a failed hunk file transaction rolls back bytes, shadow, and revision', () => {
  const f = fixture('old\n'); ai(f, 'old\n', 'AI\n');
  const snap = snapshot(f); const originalRename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (String(from).endsWith('.after')) throw new Error('injected hunk write failure');
    return originalRename(from, to);
  };
  try { assert.throws(() => decide(f, snap, 'revert'), /injected hunk write failure/); }
  finally { fs.renameSync = originalRename; }
  assert.equal(f.read(), 'AI\n'); assert.deepEqual(snapshot(f), snap);
});


test('review revisions cannot repeat after cleanup and restart for identical current text', () => {
  const f = fixture('first human baseline\n'); ai(f, 'first human baseline\n', 'same AI output\n');
  const stale = snapshot(f); const staleHunk = state.reviewHunks(stale.base, stale.current)[0];
  decide(f, stale, 'accept');
  assert.equal(changes.getReviewBase(f.id, 'main.tex'), null);
  // Persist the clock independently of the deleted baseline, including across restart.
  dbModule.resetDb(); db = dbModule.getDb();
  fs.writeFileSync(f.file, 'second human baseline\n');
  ai(f, 'second human baseline\n', 'same AI output\n');
  const latest = snapshot(f);
  assert.equal(latest.current, stale.current);
  assert.notEqual(latest.base, stale.base);
  for (const key of ['baseFrom', 'baseTo', 'docFrom', 'docTo']) {
    assert.equal(state.reviewHunks(latest.base, latest.current)[0][key], staleHunk[key]);
  }
  assert.ok(latest.revision > stale.revision);
  assert.throws(() => changes.resolveReviewHunk(f.id, 'main.tex', {
    ...staleHunk, action: 'revert', revision: stale.revision, current: stale.current,
  }), (e) => e.status === 409);
  assert.deepEqual(snapshot(f), latest); assert.equal(f.read(), latest.current);
});

test('legacy default revisions are allocated before snapshots and survive baseline reconstruction', () => {
  const f = fixture('old\n'); ai(f, 'old\n', 'AI\n');
  const stale = snapshot(f);
  db.prepare('DELETE FROM review_bases WHERE project_id=?').run(f.id);
  changes.ensureReviewBase(f.id, 'main.tex', 'old\n');
  assert.equal(state.reviewRow(f.id, 'main.tex').revision, 0);
  const rebuilt = snapshot(f);
  assert.ok(rebuilt.revision > stale.revision);
  assert.equal(rebuilt.base, stale.base); assert.equal(rebuilt.current, stale.current);
  assert.throws(() => decide(f, stale, 'accept'), (e) => e.status === 409);
  assert.deepEqual(snapshot(f), rebuilt);
});


test('hunk responses retain unfinished and newly created proposals while removing only settled changesets', () => {
  for (const action of ['accept', 'revert']) {
    const original = 'old one\nunchanged context\nold two\n';
    const edited = 'AI one\nunchanged context\nAI two\n';
    const f = fixture(original), firstId = ai(f, original, edited);
    const first = decide(f, snapshot(f), action);
    assert.equal(first.pending, true);
    assert.deepEqual(first.changesets.map(item => item.id), [firstId]);
    assert.equal(first.changesets[0].files[0].status, 'pending');
    assert.equal(state.reviewHunks(first.base, first.current).length, 1);

    // Other work can arrive after the first decision. The next response must
    // return current server state, not remove entries by file or old list IDs.
    const proposalId = ai(f, first.current, first.current + 'unapplied next task\n', false);
    const otherFile = path.join(path.dirname(f.file), 'other.tex');
    fs.writeFileSync(otherFile, 'old other\n');
    const { id: otherId } = changes.createChangeset({ projectId: f.id,
      files: [{ path: 'other.tex', before: 'old other\n', after: 'AI other\n' }] });
    changes.applyChangeset(otherId);

    const final = decide(f, first, action);
    assert.equal(final.pending, false);
    assert.deepEqual(final.changesets.map(item => item.id), [otherId, proposalId]);
    assert.deepEqual(final.changesets, changes.listChangesets(f.id, 'pending'));
    assert.equal(changes.getChangeset(firstId).status, 'accepted');
    assert.equal(changes.getChangeset(proposalId).files[0].applied, false);
    assert.equal(changes.getChangeset(otherId).files[0].status, 'pending');
    assert.equal(f.read(), action === 'accept' ? edited : original);
  }
});
