import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTestServer, registerAndLogin, api } from './helpers.js';

let server, owner, other, db, changes, review;
let serial = 0;
before(async () => {
  server = await startTestServer();
  owner = await registerAndLogin(server.baseUrl, 'review-batch-owner');
  other = await registerAndLogin(server.baseUrl, 'review-batch-other');
  db = (await import('../src/db.js')).getDb();
  changes = await import('../src/services/agent/changesets.js');
  review = await import('../src/services/agent/reviewState.js');
});
after(async () => { await server.close(); });
async function fixture(contents = { 'main.tex': 'title\nold one\ncontext\nold two\n' }) {
  const result = await api(server.baseUrl, 'POST', '/api/projects', { token: owner.token, body: { name: 'review-batch-' + (++serial) } });
  assert.equal(result.status, 201);
  const project = result.data.project;
  const dir = path.join(server.dataDir, 'projects', String(project.id));
  for (const [file, content] of Object.entries(contents)) fs.writeFileSync(path.join(dir, file), content);
  return { ...project, dir, read(file = 'main.tex') { return fs.readFileSync(path.join(dir, file), 'utf8'); } };
}
function apply(f, before, after, file = 'main.tex') {
  const proposal = changes.createChangeset({ projectId: f.id, files: [{ path: file, before, after }] });
  assert.deepEqual(changes.applyChangeset(proposal.id), { applied: 1, skipped: [] });
  return proposal.id;
}
function entry(f, filePath = 'main.tex') {
  const snapshot = changes.getReviewSnapshot(f.id, filePath);
  return { filePath, revision: snapshot.revision, current: snapshot.current };
}
function resolve(f, action, files = [entry(f)]) { return changes.resolveReviewFiles(f.id, { action, files }); }
function decideFirstHunk(f, action) {
  const snapshot = changes.getReviewSnapshot(f.id, 'main.tex');
  const first = review.reviewHunks(snapshot.base, snapshot.current)[0];
  return changes.resolveReviewHunk(f.id, 'main.tex', { ...first, revision: snapshot.revision, current: snapshot.current, action });
}
const original = 'title\nold one\ncontext\nold two\n';
const edited = 'title\nAI one\ncontext\nAI two\n';

test('HTTP batch resolves five applied rounds of one file using its current review snapshot', async () => {
  for (const action of ['accept', 'revert']) {
    const f = await fixture({ 'main.tex': 'title\noriginal body\n' });
    const ids = []; let before = f.read();
    for (let round = 1; round <= 5; round++) {
      const after = `title\nAI round ${round}\n`;
      ids.push(apply(f, before, after)); before = after;
    }
    const request = { action, files: [entry(f)] };
    const result = await api(server.baseUrl, 'POST', `/api/projects/${f.publicId}/review/resolve`, { token: owner.token, body: request });
    assert.equal(result.status, 200);
    assert.equal(result.data.ok, true); assert.equal(result.data.results[0].pending, false); assert.equal(result.data.results[0].resolved, true);
    assert.deepEqual(result.data.changesets, []);
    assert.equal(f.read(), action === 'accept' ? before : 'title\noriginal body\n');
    for (const id of ids) assert.equal(changes.getChangeset(id).status, action === 'accept' ? 'accepted' : 'reverted');
    const repeated = resolve(f, action, [entry(f)]);
    assert.equal(repeated.results[0].resolved, false);
    assert.equal(f.read(), action === 'accept' ? before : 'title\noriginal body\n');
  }
});

test('partial hunk acceptance survives batch rollback and legacy rollback cannot discard it', async () => {
  const f = await fixture(); const id = apply(f, original, edited);
  decideFirstHunk(f, 'accept');
  assert.throws(() => changes.revertChangeset(id), (error) => error.status === 409 && /审阅基线已推进/.test(error.message));
  assert.equal(f.read(), edited);
  resolve(f, 'revert');
  assert.equal(f.read(), 'title\nAI one\ncontext\nold two\n');
  assert.equal(changes.getChangeset(id).status, 'reverted');
});

test('partial hunk rejection can be followed by whole current-delta rollback without a historical conflict', async () => {
  const f = await fixture(); apply(f, original, edited);
  decideFirstHunk(f, 'revert');
  assert.equal(f.read(), 'title\nold one\ncontext\nAI two\n');
  const result = resolve(f, 'revert');
  assert.equal(result.results[0].pending, false);
  assert.equal(f.read(), original);
});

test('manual title and human-owned rewrites survive reverting the remaining AI delta', async () => {
  const f = await fixture(); apply(f, original, edited);
  fs.writeFileSync(path.join(f.dir, 'main.tex'), 'human title\nhuman one\ncontext\nAI two\n');
  const snapshot = changes.getReviewSnapshot(f.id, 'main.tex');
  assert.equal(snapshot.base, 'human title\nhuman one\ncontext\nold two\n');
  resolve(f, 'revert');
  assert.equal(f.read(), 'human title\nhuman one\ncontext\nold two\n');
});

test('resolving applied text does not accept or discard a pending unapplied proposal for the same path', async () => {
  const f = await fixture(); const applied = apply(f, original, edited);
  const proposal = changes.createChangeset({ projectId: f.id, files: [{ path: 'main.tex', before: edited, after: 'unapplied future proposal\n' }] });
  const result = resolve(f, 'revert');
  assert.equal(changes.getChangeset(applied).status, 'reverted');
  assert.equal(changes.getChangeset(proposal.id).status, 'pending');
  assert.equal(changes.getChangeset(proposal.id).files[0].applied, false);
  assert.deepEqual(result.changesets.map((change) => change.id), [proposal.id]);
  assert.equal(f.read(), original);
  assert.throws(() => changes.acceptChangeset(proposal.id), (error) => error.status === 409);
});

test('batch rollback deletes a pure AI-created file but retains a file with independent manual text', async () => {
  const pure = await fixture(); apply(pure, null, 'AI-created content\n', 'new.tex');
  const pureResult = resolve(pure, 'revert', [entry(pure, 'new.tex')]);
  assert.equal(fs.existsSync(path.join(pure.dir, 'new.tex')), false);
  assert.equal(pureResult.results[0].deleted, true);
  const repeated = resolve(pure, 'revert', [entry(pure, 'new.tex')]);
  assert.equal(repeated.results[0].deleted, true); assert.equal(repeated.results[0].resolved, false);
  assert.equal(fs.existsSync(path.join(pure.dir, 'new.tex')), false);
  const human = await fixture(); apply(human, null, 'AI-created content\n', 'new.tex');
  fs.appendFileSync(path.join(human.dir, 'new.tex'), 'human note\n');
  resolve(human, 'revert', [entry(human, 'new.tex')]);
  assert.equal(human.read('new.tex'), 'human note\n');
});

test('one stale file prevents all decisions in a multiple-file batch', async () => {
  const f = await fixture({ 'one.tex': 'old one\n', 'two.tex': 'old two\n' });
  const first = apply(f, 'old one\n', 'AI one\n', 'one.tex');
  const second = apply(f, 'old two\n', 'AI two\n', 'two.tex');
  const requests = [entry(f, 'one.tex'), entry(f, 'two.tex')];
  fs.writeFileSync(path.join(f.dir, 'two.tex'), 'human prefix\nAI two\n');
  assert.throws(() => resolve(f, 'revert', requests), (error) => error.status === 409);
  assert.equal(f.read('one.tex'), 'AI one\n'); assert.equal(f.read('two.tex'), 'human prefix\nAI two\n');
  assert.equal(changes.getChangeset(first).status, 'pending'); assert.equal(changes.getChangeset(second).status, 'pending');
  assert.equal(changes.getReviewSnapshot(f.id, 'one.tex').pending, true);
});

test('a later file write failure rolls back all files and review decisions together', async (t) => {
  const f = await fixture({ 'one.tex': 'old one\n', 'two.tex': 'old two\n' });
  const first = apply(f, 'old one\n', 'AI one\n', 'one.tex');
  const second = apply(f, 'old two\n', 'AI two\n', 'two.tex');
  const requests = [entry(f, 'one.tex'), entry(f, 'two.tex')];
  const realRename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (source, destination) => {
    if (String(source).endsWith('.after') && destination === path.join(f.dir, 'two.tex')) throw new Error('synthetic second-file rename failure');
    return realRename(source, destination);
  });
  assert.throws(() => resolve(f, 'revert', requests), /synthetic second-file/);
  assert.equal(f.read('one.tex'), 'AI one\n'); assert.equal(f.read('two.tex'), 'AI two\n');
  for (const id of [first, second]) assert.equal(changes.getChangeset(id).status, 'pending');
  for (const file of ['one.tex', 'two.tex']) assert.equal(changes.getReviewSnapshot(f.id, file).pending, true);
});

test('batch endpoint keeps project permissions and rejects duplicate or binary file requests', async () => {
  const f = await fixture(); apply(f, original, edited);
  const body = { action: 'revert', files: [entry(f)] };
  assert.equal((await api(server.baseUrl, 'POST', `/api/projects/${f.publicId}/review/resolve`, { token: other.token, body })).status, 403);
  assert.equal((await api(server.baseUrl, 'POST', `/api/projects/${f.publicId}/review/resolve`, { body })).status, 401);
  assert.throws(() => resolve(f, 'revert', [entry(f), entry(f)]), (error) => error.status === 400);
  const binary = changes.createChangeset({ projectId: f.id, files: [{ path: 'image.png', before: null, after: 'AAE=', encoding: 'base64' }] });
  changes.applyChangeset(binary.id);
  assert.throws(() => resolve(f, 'revert', [{ filePath: 'image.png', revision: 0, current: '' }]), (error) => error.status === 400);
  assert.equal(f.read(), edited);
  assert.deepEqual(fs.readFileSync(path.join(f.dir, 'image.png')), Buffer.from([0, 1]));
});


test('a database failure after file swaps rolls back every file, shadow and decision', async () => {
  const f = await fixture({ 'one.tex': 'old one\n', 'two.tex': 'old two\n' });
  const first = apply(f, 'old one\n', 'AI one\n', 'one.tex');
  const second = apply(f, 'old two\n', 'AI two\n', 'two.tex');
  const requests = [entry(f, 'one.tex'), entry(f, 'two.tex')];
  db.exec(`CREATE TEMP TRIGGER reject_review_batch BEFORE UPDATE OF status ON changeset_files
    WHEN NEW.changeset_id=${second} AND NEW.status='reverted'
    BEGIN SELECT RAISE(ABORT, 'synthetic review DB failure'); END;`);
  try { assert.throws(() => resolve(f, 'revert', requests), /synthetic review DB failure/); }
  finally { db.exec('DROP TRIGGER reject_review_batch'); }
  assert.equal(f.read('one.tex'), 'AI one\n'); assert.equal(f.read('two.tex'), 'AI two\n');
  for (const id of [first, second]) assert.equal(changes.getChangeset(id).status, 'pending');
  assert.deepEqual([entry(f, 'one.tex'), entry(f, 'two.tex')], requests);
});

test('empty AI-created text files retain their existence when no text delta remains', async () => {
  const f = await fixture(); apply(f, null, '', 'empty.tex');
  const result = resolve(f, 'revert', [entry(f, 'empty.tex')]);
  assert.equal(result.results[0].resolved, false);
  assert.equal(fs.existsSync(path.join(f.dir, 'empty.tex')), true);
  assert.equal(fs.statSync(path.join(f.dir, 'empty.tex')).size, 0);
});
