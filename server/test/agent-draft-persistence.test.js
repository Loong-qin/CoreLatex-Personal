import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'corelatex-draft-test-'));
process.env.CORELATEX_DATA_DIR = temp;
let db, resetDb, openAgentDraft, getPiTools, changes, serial = 0;
before(async () => {
  const database = await import('../src/db.js'); db = database.getDb(); resetDb = database.resetDb;
  ({ openAgentDraft } = await import('../src/services/agent/draftPersistence.js'));
  ({ getPiTools } = await import('../src/services/agent/tools.js'));
  changes = await import('../src/services/agent/changesets.js');
});
after(() => { resetDb(); fs.rmSync(temp, { recursive: true, force: true }); });
function fixture() {
  const userId = Number(db.prepare("INSERT INTO users(username,password_hash,role) VALUES(?,'unused','admin')").run('draft-' + ++serial).lastInsertRowid);
  const projectId = Number(db.prepare('INSERT INTO projects(name,owner_id,public_id) VALUES(?,?,?)').run('draft', userId, 'draft-' + serial).lastInsertRowid);
  const chatId = Number(db.prepare('INSERT INTO chats(project_id,user_id) VALUES(?,?)').run(projectId, userId).lastInsertRowid);
  const projectDir = path.join(temp, 'projects', String(projectId)), workspaceDir = path.join(projectDir, '_workspace');
  fs.mkdirSync(workspaceDir, { recursive: true }); fs.writeFileSync(path.join(projectDir, 'notes.txt'), 'original');
  return { db, user: db.prepare('SELECT * FROM users WHERE id=?').get(userId), project: db.prepare('SELECT * FROM projects WHERE id=?').get(projectId),
    chatId, projectDir, workspaceDir, changesetBuffer: [], reads: new Map(), agentConfig: { confirmBeforeApply: true } };
}
const nextRun = ctx => ({ ...ctx, changesetBuffer: [], reads: new Map(), toolDisplays: new Map(), assertDraftCurrent: undefined, checkpointDraft: undefined });
const call = async (ctx, name, args) => (await getPiTools(ctx).find(tool => tool.name === name).execute('call-' + ++serial, args)).content[0].text;
async function stage(ctx, content = 'draft') { await call(ctx, 'read_file', { path: 'notes.txt' }); await call(ctx, 'write_file', { path: 'notes.txt', content }); }

test('multiple human-edited baselines can be rebased one at a time without publishing unresolved conflicts', async () => {
  const ctx = fixture(), draft = openAgentDraft(ctx); await stage(ctx);
  fs.writeFileSync(path.join(ctx.projectDir, 'second.txt'), 'second original');
  await call(ctx, 'read_file', { path: 'second.txt' });
  await call(ctx, 'write_file', { path: 'second.txt', content: 'second draft' });
  const proposal = draft.publish(), initial = JSON.stringify(changes.pendingChangesetState(proposal.id));
  for (const file of ['notes.txt', 'second.txt']) fs.writeFileSync(path.join(ctx.projectDir, file), 'human ' + file);
  for (const file of ['notes.txt', 'second.txt']) {
    const oldDraft = JSON.parse(await call(ctx, 'read_file', { path: file }));
    const current = JSON.parse(await call(ctx, 'read_file', { path: file, view: 'project' }));
    const result = JSON.parse(await call(ctx, 'write_file', { path: file, content: current.text + '\n' + oldDraft.text,
      rebase: { projectHash: current.contentHash, draftHash: oldDraft.contentHash } }));
    assert.equal(result.rebased, true);
    if (file === 'notes.txt') {
      assert.throws(() => draft.publish(), /磁盘版本/);
      assert.equal(JSON.stringify(changes.pendingChangesetState(proposal.id)), initial);
    }
  }
  assert.equal(draft.publish().id, proposal.id);
  const saved = JSON.parse(db.prepare('SELECT files_json FROM agent_drafts WHERE id=?').get(draft.id).files_json);
  assert.equal(saved.length, 2); assert.ok(saved.every(file => file.before === 'human ' + file.path));
  assert.equal(fs.readFileSync(path.join(ctx.projectDir, 'notes.txt'), 'utf8'), 'human notes.txt');
});

test('complete text and binary edits are durable before tool success and recover without applying', async () => {
  const ctx = fixture(), draft = openAgentDraft(ctx);
  const large = 'full draft\n'.repeat(7000) + 'COMPLETE_TAIL'; await stage(ctx, large);
  fs.writeFileSync(path.join(ctx.workspaceDir, 'figure.png'), Buffer.from([0, 255, 127, 1]));
  await call(ctx, 'copy_to_project', { workspacePath: 'figure.png', targetPath: 'figure.png' });
  const saved = JSON.parse(db.prepare('SELECT files_json FROM agent_drafts WHERE id=?').get(draft.id).files_json);
  assert.equal(saved[0].after, large); assert.equal(saved[1].after, 'AP9/AQ==');
  assert.equal(fs.readFileSync(path.join(ctx.projectDir, 'notes.txt'), 'utf8'), 'original');
  const resumed = nextRun(ctx), recovery = openAgentDraft(resumed);
  assert.equal(recovery.resumed, true); assert.equal(recovery.id, draft.id);
  assert.match(await call(resumed, 'read_file', { path: 'notes.txt', offset: 7001 }), /^COMPLETE_TAIL/);
  assert.deepEqual(resumed.changesetBuffer, saved);
});

test('continuation updates the identified proposal version, preserving baseline and not republishing read-only rounds', async () => {
  const ctx = fixture(), draft = openAgentDraft(ctx); await stage(ctx);
  const first = draft.publish(); assert.equal(first.changed, true);
  const other = nextRun(ctx), continued = openAgentDraft(other);
  assert.equal(await call(other, 'read_file', { path: 'notes.txt' }), 'draft');
  assert.equal(continued.publish().changed, false);
  await call(other, 'edit_file', { path: 'notes.txt', search: 'draft', replace: 'revised' });
  const second = continued.publish(); assert.equal(second.id, first.id); assert.equal(second.version, first.version + 1);
  const rows = db.prepare('SELECT * FROM changeset_files WHERE changeset_id=?').all(first.id);
  assert.equal(rows.length, 1); assert.equal(rows[0].before_content, 'original'); assert.equal(rows[0].after_content, 'revised');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM changesets WHERE chat_id=?').get(ctx.chatId).n, 1);
});

test('checkpoint failure rejects the tool, restores memory and read hashes, and cannot claim a saved edit', async () => {
  const ctx = fixture(), draft = openAgentDraft(ctx); await stage(ctx);
  const before = structuredClone(ctx.changesetBuffer), reads = [...ctx.reads], version = draft.version;
  db.exec("CREATE TEMP TRIGGER fail_checkpoint BEFORE UPDATE ON agent_drafts BEGIN SELECT RAISE(ABORT, 'disk full fixture'); END");
  try { await assert.rejects(call(ctx, 'write_file', { path: 'notes.txt', content: 'must not survive' }), /disk full fixture/); }
  finally { db.exec('DROP TRIGGER fail_checkpoint'); }
  assert.deepEqual(ctx.changesetBuffer, before); assert.deepEqual([...ctx.reads], reads); assert.equal(draft.version, version);
  assert.equal(await call(ctx, 'read_file', { path: 'notes.txt' }), 'draft');
  await call(ctx, 'write_file', { path: 'notes.txt', content: 'saved later' });
  assert.equal(draft.version, version + 1);
});

test('a rejected parallel merge rolls back its full parent draft and cannot pass checkpoint failure', async () => {
  const ctx = fixture(); openAgentDraft(ctx); await stage(ctx);
  ctx.runParallelEdits = async () => { ctx.changesetBuffer[0].after = 'parallel'; return { scope: 'project', changed: true }; };
  ctx.checkpointDraft = () => { throw new Error('checkpoint unavailable'); };
  await assert.rejects(call(ctx, 'run_parallel_edits', { tasks: [{ id: 'a', task: 'edit', scope: [{ path: 'notes.txt' }] }, { id: 'b', task: 'edit', scope: [{ path: 'other.txt' }] }] }), /checkpoint unavailable/);
  assert.equal(ctx.changesetBuffer[0].after, 'draft');
});

test('startup isolates a changed disk baseline; active handles allow inspection but reject ordinary mutations', async () => {
  const ctx = fixture(), draft = openAgentDraft(ctx); await stage(ctx); const proposal = draft.publish();
  const original = db.prepare('SELECT * FROM agent_drafts WHERE id=?').get(draft.id);
  const originalProposal = JSON.stringify(changes.pendingChangesetState(proposal.id));
  fs.writeFileSync(path.join(ctx.projectDir, 'notes.txt'), 'human edit');
  assert.equal(JSON.parse(await call(ctx, 'read_file', { path: 'notes.txt' })).conflict, true);
  assert.equal(JSON.parse(await call(ctx, 'read_file', { path: 'notes.txt', view: 'project' })).text, 'human edit');
  for (const [name, args] of [['write_file', { path: 'notes.txt', content: 'overwrite' }], ['compile_and_preview', {}]])
    await assert.rejects(call(ctx, name, args), /磁盘版本/);
  const fresh = nextRun(ctx), next = openAgentDraft(fresh);
  assert.equal(next.resumed, false); assert.equal(next.id, null); assert.deepEqual(fresh.changesetBuffer, []);
  assert.deepEqual(next.recoveries, [{ id: draft.id, version: draft.version, changesetId: proposal.id,
    reason: 'notes.txt 的磁盘版本在草稿生成后已改变', paths: ['notes.txt'] }]);
  assert.deepEqual(db.prepare('SELECT * FROM agent_drafts WHERE id=?').get(draft.id), { ...original, state: 'conflicted' });
  assert.equal(await call(fresh, 'read_file', { path: 'notes.txt' }), 'human edit');
  for (let i = 0; i < 3; i++) {
    const empty = openAgentDraft(nextRun(ctx));
    assert.equal(empty.resumed, false); assert.deepEqual(empty.recoveries, []);
    assert.equal(empty.publish().changed, false);
  }
  assert.equal(db.prepare('SELECT COUNT(*) n FROM agent_drafts WHERE chat_id=?').get(ctx.chatId).n, 1);
  await call(fresh, 'write_file', { path: 'notes.txt', content: 'new instruction result' });
  const newProposal = next.publish(); assert.notEqual(newProposal.id, proposal.id); assert.notEqual(next.id, draft.id);
  assert.equal(db.prepare('SELECT before_content FROM changeset_files WHERE changeset_id=?').get(newProposal.id).before_content, 'human edit');
  assert.equal(JSON.stringify(changes.pendingChangesetState(proposal.id)), originalProposal);
  assert.equal(fs.readFileSync(path.join(ctx.projectDir, 'notes.txt'), 'utf8'), 'human edit');
});

test('partial review isolates the old identity without resurrecting decisions or rewriting review history', async () => {
  const ctx = fixture(), draft = openAgentDraft(ctx); await stage(ctx);
  await call(ctx, 'write_file', { path: 'new.txt', content: 'new draft' });
  const proposal = draft.publish(); changes.acceptChangeset(proposal.id, 'notes.txt');
  const state = JSON.stringify(changes.pendingChangesetState(proposal.id));
  await assert.rejects(call(ctx, 'read_file', { path: 'notes.txt', view: 'project' }), /审核状态/);
  await assert.rejects(call(ctx, 'write_file', { path: 'new.txt', content: 'different' }), /审核状态/);
  const fresh = nextRun(ctx), recovery = openAgentDraft(fresh);
  assert.equal(recovery.resumed, false); assert.equal(recovery.id, null);
  assert.match(recovery.recoveries[0].reason, /审核状态/); assert.deepEqual(fresh.changesetBuffer, []);
  assert.equal(await call(fresh, 'read_file', { path: 'notes.txt' }), 'draft');
  assert.equal(JSON.stringify(changes.pendingChangesetState(proposal.id)), state);
  assert.equal(JSON.parse(db.prepare('SELECT files_json FROM agent_drafts WHERE id=?').get(draft.id).files_json).length, 2);
  changes.revertChangeset(proposal.id, 'new.txt');
  const resumed = nextRun(ctx); assert.equal(openAgentDraft(resumed).resumed, false);
  assert.deepEqual(resumed.changesetBuffer, []); assert.equal(await call(resumed, 'read_file', { path: 'notes.txt' }), 'draft');
});

test('legacy single untouched pending proposal is adopted by id, ambiguous proposals are blocked', async () => {
  const ctx = fixture();
  const legacy = changes.createChangeset({ projectId: ctx.project.id, chatId: ctx.chatId, files: [{ path: 'notes.txt', before: 'original', after: 'legacy' }] });
  const draft = openAgentDraft(ctx); assert.equal(draft.resumed, true); assert.equal(draft.publish().id, legacy.id);
  assert.equal(await call(ctx, 'read_file', { path: 'notes.txt' }), 'legacy');
  const ambiguous = fixture();
  for (const after of ['one', 'two']) changes.createChangeset({ projectId: ambiguous.project.id, chatId: ambiguous.chatId, files: [{ path: 'notes.txt', before: 'original', after }] });
  assert.throws(() => openAgentDraft(ambiguous), /多个未应用/);
});

test('concurrent versions conflict and fresh authorization isolates users and chats', async () => {
  const ctx = fixture(), original = openAgentDraft(ctx); await stage(ctx);
  const second = nextRun(ctx), oldVersion = openAgentDraft(second);
  await call(ctx, 'write_file', { path: 'notes.txt', content: 'next version' });
  await assert.rejects(call(second, 'read_file', { path: 'notes.txt' }), /另一个执行/);
  assert.ok(original.version > oldVersion.version);
  const otherChat = Number(db.prepare('INSERT INTO chats(project_id,user_id) VALUES(?,?)').run(ctx.project.id, ctx.user.id).lastInsertRowid);
  const other = { ...nextRun(ctx), chatId: otherChat }; assert.equal(openAgentDraft(other).resumed, false);
  assert.equal(await call(other, 'read_file', { path: 'notes.txt' }), 'original');
  const outsider = fixture(); db.prepare("INSERT INTO project_members(project_id,user_id,role) VALUES(?,?,'editor')").run(ctx.project.id, outsider.user.id);
  assert.throws(() => openAgentDraft({ ...nextRun(ctx), user: outsider.user }), /会话/);
  db.prepare("UPDATE users SET status='disabled' WHERE id=?").run(ctx.user.id);
  await assert.rejects(call(ctx, 'read_file', { path: 'notes.txt' }), /禁用/);
});

test('reverting all draft edits withdraws its proposal instead of leaving an obsolete pending copy', async () => {
  const ctx = fixture(), draft = openAgentDraft(ctx); await stage(ctx); const first = draft.publish();
  const resumed = nextRun(ctx), next = openAgentDraft(resumed);
  await call(resumed, 'read_file', { path: 'notes.txt' });
  await call(resumed, 'write_file', { path: 'notes.txt', content: 'original' });
  const withdrawn = next.publish(); assert.equal(withdrawn.id, first.id); assert.equal(withdrawn.changed, true);
  assert.equal(changes.getChangeset(first.id).status, 'reverted');
  assert.deepEqual(nextRun(ctx).changesetBuffer, []);
});

test('workspace writes keep their direct behavior and do not create formal checkpoints', async () => {
  const ctx = fixture(), draft = openAgentDraft(ctx);
  await call(ctx, 'write_file', { path: '_workspace/draft.txt', content: 'working note' });
  assert.equal(draft.id, null); assert.equal(fs.readFileSync(path.join(ctx.workspaceDir, 'draft.txt'), 'utf8'), 'working note');
});

for (const entity of ['chats', 'projects', 'users']) test(`permanent ${entity} deletion removes only the matching full draft`, async () => {
  const removed = fixture(), kept = fixture();
  const removedDraft = openAgentDraft(removed); openAgentDraft(kept); await stage(removed); await stage(kept);
  const key = entity === 'chats' ? removed.chatId : entity === 'projects' ? removed.project.id : removed.user.id;
  if (entity === 'users') db.prepare('UPDATE projects SET owner_id=? WHERE id=?').run(kept.user.id, removed.project.id);
  db.prepare(`DELETE FROM ${entity} WHERE id=?`).run(key);
  assert.throws(() => removedDraft.preserveCheckpoint(), /已经删除/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM agent_drafts WHERE chat_id=?').get(removed.chatId).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM agent_drafts WHERE chat_id=?').get(kept.chatId).n, 1);
});

test('recovered text and image bytes reach the real compile preview through the same isolated draft', async () => {
  const ctx = fixture();
  fs.writeFileSync(path.join(ctx.projectDir, 'main.tex'), 'disk source');
  const draft = openAgentDraft(ctx);
  await call(ctx, 'read_file', { path: 'main.tex' });
  await call(ctx, 'write_file', { path: 'main.tex', content: 'pending source' });
  fs.writeFileSync(path.join(ctx.workspaceDir, 'figure.png'), Buffer.from([0, 255, 1]));
  await call(ctx, 'copy_to_project', { workspacePath: 'figure.png', targetPath: 'figure.png' });
  draft.publish();
  const resumed = nextRun(ctx); openAgentDraft(resumed);
  const bin = path.join(temp, 'draft-compile-bin'), marker = path.join(temp, 'draft-compile-input');
  fs.mkdirSync(bin, { recursive: true });
  const binary = (name, body) => fs.writeFileSync(path.join(bin, name), '#!' + process.execPath + '\n' + body, { mode: 0o755 });
  binary('pdflatex', `const fs=require('node:fs');fs.mkdirSync('.build',{recursive:true});fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({text:fs.readFileSync('main.tex','utf8'),image:fs.readFileSync('figure.png').toString('base64')}));fs.writeFileSync('.build/main.pdf','%PDF-1.4 fake');fs.writeFileSync('.build/main.log','Output written on main.pdf');`);
  binary('pdfinfo', "console.log('Pages: 1');");
  binary('pdftoppm', "require('node:fs').writeFileSync(process.argv.at(-1)+'-1.jpg',Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+lm3sAAAAASUVORK5CYII=','base64'));");
  const oldPath = process.env.PATH; process.env.PATH = bin + path.delimiter + oldPath;
  try {
    const out = await call(resumed, 'compile_and_preview', { pages: [1] });
    assert.match(out, /编译成功/);
    assert.deepEqual(JSON.parse(fs.readFileSync(marker, 'utf8')), { text: 'pending source', image: 'AP8B' });
    assert.equal(fs.readFileSync(path.join(ctx.projectDir, 'main.tex'), 'utf8'), 'disk source');
    assert.equal(fs.existsSync(path.join(ctx.projectDir, 'figure.png')), false);
  } finally { process.env.PATH = oldPath; }
});

test('deferred COMMIT failure preserves database and in-memory versions, and a later checkpoint can recover', async () => {
  const ctx = fixture(), draft = openAgentDraft(ctx); await stage(ctx); const version = draft.version;
  db.exec(`CREATE TABLE draft_test_parent(id INTEGER PRIMARY KEY);
    CREATE TABLE draft_test_child(id INTEGER REFERENCES draft_test_parent(id) DEFERRABLE INITIALLY DEFERRED);
    CREATE TEMP TRIGGER fail_draft_commit AFTER UPDATE ON agent_drafts BEGIN INSERT INTO draft_test_child(id) VALUES(99); END`);
  try {
    await assert.rejects(call(ctx, 'write_file', { path: 'notes.txt', content: 'unsaved' }), /FOREIGN KEY/);
    assert.equal(draft.version, version); assert.equal(ctx.changesetBuffer[0].after, 'draft');
    assert.equal(db.prepare('SELECT version FROM agent_drafts WHERE id=?').get(draft.id).version, version);
  } finally { db.exec('DROP TRIGGER fail_draft_commit; DROP TABLE draft_test_child; DROP TABLE draft_test_parent;'); }
  await call(ctx, 'write_file', { path: 'notes.txt', content: 'saved' }); assert.equal(draft.version, version + 1);
});

test('a read-only continuation still detects changes after its last tool before final publication', async () => {
  const ctx = fixture(), draft = openAgentDraft(ctx); await stage(ctx); draft.publish();
  const other = nextRun(ctx), resumed = openAgentDraft(other);
  await call(other, 'read_file', { path: 'notes.txt' }); fs.writeFileSync(path.join(ctx.projectDir, 'notes.txt'), 'external write');
  assert.throws(() => resumed.publish(), /磁盘版本/);
});

test('stale handles cannot publish a second proposal after another handle publishes the same version', async () => {
  const ctx = fixture(), first = openAgentDraft(ctx); await stage(ctx);
  const second = openAgentDraft(nextRun(ctx)); first.publish();
  assert.throws(() => second.publish(), /发布状态/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM changesets WHERE chat_id=?').get(ctx.chatId).n, 1);
});

for (const restriction of ['archive', 'viewer', 'removed', 'disabled']) test(`final checkpoint preservation after ${restriction} cannot authorize another tool or consume unsaved memory`, async () => {
  const ctx = fixture();
  if (['viewer', 'removed'].includes(restriction)) {
    const owner = fixture().user;
    db.prepare('UPDATE projects SET owner_id=? WHERE id=?').run(owner.id, ctx.project.id);
    db.prepare("INSERT INTO project_members(project_id,user_id,role) VALUES(?,?,'editor')").run(ctx.project.id, ctx.user.id);
  }
  const draft = openAgentDraft(ctx); await stage(ctx, 'authorized checkpoint');
  if (restriction === 'archive') db.prepare('UPDATE projects SET archived=1 WHERE id=?').run(ctx.project.id);
  else if (restriction === 'viewer') db.prepare("UPDATE project_members SET role='viewer' WHERE project_id=? AND user_id=?").run(ctx.project.id, ctx.user.id);
  else if (restriction === 'removed') db.prepare('DELETE FROM project_members WHERE project_id=? AND user_id=?').run(ctx.project.id, ctx.user.id);
  else db.prepare("UPDATE users SET status='disabled' WHERE id=?").run(ctx.user.id);
  // A late untrusted in-memory update is never part of the preserved proposal.
  ctx.changesetBuffer[0].after = 'unauthorized later memory';
  assert.throws(() => draft.checkpoint(), error => error.status === 403);
  assert.throws(() => draft.publish(), error => error.status === 403);
  if (['removed', 'disabled'].includes(restriction)) {
    await assert.rejects(call(ctx, 'read_file', { path: 'notes.txt' }), error => error.status === 403);
    assert.throws(() => openAgentDraft(nextRun(ctx)), error => error.status === 403);
  }
  const kept = draft.preserveCheckpoint();
  assert.equal(kept.changed, true); assert.equal(changes.getChangeset(kept.id).applied, false);
  assert.equal(db.prepare('SELECT after_content FROM changeset_files WHERE changeset_id=?').get(kept.id).after_content, 'authorized checkpoint');
  assert.equal(fs.readFileSync(path.join(ctx.projectDir, 'notes.txt'), 'utf8'), 'original');
});

test('restricted final preservation still refuses to rewrite a concurrently reviewed proposal', async () => {
  const ctx = fixture(), draft = openAgentDraft(ctx); await stage(ctx, 'first'); const first = draft.publish();
  await call(ctx, 'write_file', { path: 'notes.txt', content: 'later checkpoint' });
  changes.acceptChangeset(first.id); db.prepare("UPDATE users SET status='disabled' WHERE id=?").run(ctx.user.id);
  assert.throws(() => draft.preserveCheckpoint(), /审核状态/);
  assert.equal(changes.getChangeset(first.id).status, 'accepted');
  assert.equal(db.prepare('SELECT after_content FROM changeset_files WHERE changeset_id=?').get(first.id).after_content, 'first');
  assert.equal(JSON.parse(db.prepare('SELECT files_json FROM agent_drafts WHERE id=?').get(draft.id).files_json)[0].after, 'later checkpoint');
});


test('an unpublished full checkpoint is retained byte-for-byte when the next instruction uses changed files', async () => {
  const ctx = fixture(), draft = openAgentDraft(ctx); await stage(ctx, 'unpublished full draft');
  const original = db.prepare('SELECT * FROM agent_drafts WHERE id=?').get(draft.id);
  assert.equal(original.changeset_id, null); assert.equal(original.published_version, 0);
  fs.writeFileSync(path.join(ctx.projectDir, 'notes.txt'), 'current human text');
  const fresh = nextRun(ctx), recovery = openAgentDraft(fresh);
  assert.equal(recovery.resumed, false); assert.equal(recovery.recoveries[0].changesetId, null);
  assert.deepEqual(db.prepare('SELECT * FROM agent_drafts WHERE id=?').get(draft.id), { ...original, state: 'conflicted' });
  assert.equal(await call(fresh, 'read_file', { path: 'notes.txt' }), 'current human text');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM changesets WHERE chat_id=?').get(ctx.chatId).n, 0);
});

test('reviewing an older published version cannot discard the newer unpublished checkpoint', async () => {
  const ctx = fixture(), draft = openAgentDraft(ctx); await stage(ctx, 'published'); const proposal = draft.publish();
  await call(ctx, 'write_file', { path: 'notes.txt', content: 'unpublished later bytes' });
  changes.acceptChangeset(proposal.id);
  const original = db.prepare('SELECT * FROM agent_drafts WHERE id=?').get(draft.id);
  const proposalState = JSON.stringify(changes.pendingChangesetState(proposal.id));
  const fresh = nextRun(ctx), recovery = openAgentDraft(fresh);
  assert.match(recovery.recoveries[0].reason, /未发布的后续版本/);
  assert.deepEqual(db.prepare('SELECT * FROM agent_drafts WHERE id=?').get(draft.id), { ...original, state: 'conflicted' });
  assert.equal(JSON.stringify(changes.pendingChangesetState(proposal.id)), proposalState);
  assert.equal(await call(fresh, 'read_file', { path: 'notes.txt' }), 'published');
});

for (const state of ['closed', 'conflicted']) test(`legacy adoption excludes a proposal already held by a ${state} draft`, async () => {
  const ctx = fixture(), draft = openAgentDraft(ctx); await stage(ctx); const proposal = draft.publish();
  db.prepare('UPDATE agent_drafts SET state=? WHERE id=?').run(state, draft.id);
  const fresh = nextRun(ctx), next = openAgentDraft(fresh);
  assert.equal(next.resumed, false); assert.equal(next.id, null); assert.deepEqual(next.recoveries, []);
  assert.equal(await call(fresh, 'read_file', { path: 'notes.txt' }), 'original');
  assert.equal(changes.getChangeset(proposal.id).status, 'pending');
});

test('unsafe checkpoint paths are not hidden by an earlier recoverable disk conflict', async () => {
  const ctx = fixture(), draft = openAgentDraft(ctx); await stage(ctx);
  const files = JSON.parse(db.prepare('SELECT files_json FROM agent_drafts WHERE id=?').get(draft.id).files_json);
  files.push({ path: '../outside.txt', before: null, after: 'unsafe', encoding: 'utf8' });
  db.prepare('UPDATE agent_drafts SET files_json=? WHERE id=?').run(JSON.stringify(files), draft.id);
  fs.writeFileSync(path.join(ctx.projectDir, 'notes.txt'), 'human');
  assert.throws(() => openAgentDraft(nextRun(ctx)));
  assert.equal(db.prepare('SELECT state FROM agent_drafts WHERE id=?').get(draft.id).state, 'active');
});

for (const interruption of ['version', 'io', 'cancel', 'permission']) test(`startup ${interruption} failure cannot detach an active draft`, async () => {
  const ctx = fixture(), draft = openAgentDraft(ctx); await stage(ctx);
  fs.writeFileSync(path.join(ctx.projectDir, 'notes.txt'), 'human');
  const read = fs.readFileSync, ac = new AbortController();
  let intercepted = false;
  fs.readFileSync = function(file, ...args) {
    if (!intercepted && file === path.join(ctx.projectDir, 'notes.txt')) {
      intercepted = true;
      if (interruption === 'version') db.prepare('UPDATE agent_drafts SET version=version+1 WHERE id=?').run(draft.id);
      if (interruption === 'io') { const error = new Error('fixture read denied'); error.code = 'EACCES'; throw error; }
      if (interruption === 'cancel') ac.abort(new Error('fixture cancellation'));
      if (interruption === 'permission') db.prepare("UPDATE users SET status='disabled' WHERE id=?").run(ctx.user.id);
    }
    return read.call(this, file, ...args);
  };
  try {
    assert.throws(() => openAgentDraft({ ...nextRun(ctx), signal: ac.signal }),
      interruption === 'version' ? /另一个执行/ : interruption === 'io' ? /read denied/ : interruption === 'cancel' ? /cancellation/ : /禁用/);
  } finally { fs.readFileSync = read; }
  assert.equal(db.prepare('SELECT state FROM agent_drafts WHERE id=?').get(draft.id).state, 'active');
});

test('failed recovery transaction retains the active checkpoint and does not report an archive', async () => {
  const ctx = fixture(), draft = openAgentDraft(ctx); await stage(ctx);
  fs.writeFileSync(path.join(ctx.projectDir, 'notes.txt'), 'human');
  db.exec("CREATE TEMP TRIGGER fail_archive BEFORE UPDATE OF state ON agent_drafts WHEN NEW.state='conflicted' BEGIN SELECT RAISE(ABORT,'archive unavailable'); END");
  try { assert.throws(() => openAgentDraft(nextRun(ctx)), /archive unavailable/); }
  finally { db.exec('DROP TRIGGER fail_archive'); }
  assert.equal(db.prepare('SELECT state FROM agent_drafts WHERE id=?').get(draft.id).state, 'active');
  assert.equal(openAgentDraft(nextRun(ctx)).recoveries[0].id, draft.id);
});


for (const restriction of ['viewer', 'archive']) test(`${restriction} access may not retire an old checkpoint on startup`, async () => {
  const ctx = fixture();
  if (restriction === 'viewer') {
    const owner = fixture().user;
    db.prepare('UPDATE projects SET owner_id=? WHERE id=?').run(owner.id, ctx.project.id);
    db.prepare("INSERT INTO project_members(project_id,user_id,role) VALUES(?,?,'editor')").run(ctx.project.id, ctx.user.id);
  }
  const draft = openAgentDraft(ctx); await stage(ctx);
  fs.writeFileSync(path.join(ctx.projectDir, 'notes.txt'), 'human');
  if (restriction === 'viewer') db.prepare("UPDATE project_members SET role='viewer' WHERE project_id=? AND user_id=?").run(ctx.project.id, ctx.user.id);
  else db.prepare('UPDATE projects SET archived=1 WHERE id=?').run(ctx.project.id);
  assert.throws(() => openAgentDraft(nextRun(ctx)), error => error.status === 403);
  assert.equal(db.prepare('SELECT state FROM agent_drafts WHERE id=?').get(draft.id).state, 'active');
});
