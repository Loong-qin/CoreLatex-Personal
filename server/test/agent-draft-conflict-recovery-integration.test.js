import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import Database from 'better-sqlite3';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'corelatex-draft-conflict-run-'));
process.env.CORELATEX_DATA_DIR = dataDir;
const ORIGINAL = 'ORIGINAL_CURRENT_FILE\n';
const HUMAN = 'CURRENT_HUMAN_REVISION\n';
const PRIVATE = 'OLD_PRIVATE_DRAFT_MUST_REMAIN_COMPLETE\n'.repeat(1000) + 'OLD_DRAFT_END';
let dbModule, db, runAgent, openAgentDraft, revertChangeset, server, current, serial = 0;
const textOf = message => typeof message.content === 'string' ? message.content
  : (message.content || []).filter(part => part.type === 'text').map(part => part.text).join('\n');
const sse = (delta, finishReason) => 'data: ' + JSON.stringify({ choices: [{ index: 0, delta, ...(finishReason ? { finish_reason: finishReason } : {}) }] }) + '\n\n';

before(async () => {
  dbModule = await import('../src/db.js'); db = dbModule.getDb();
  ({ runAgent } = await import('../src/services/agent/agentLoop.js'));
  ({ openAgentDraft } = await import('../src/services/agent/draftPersistence.js'));
  ({ revertChangeset } = await import('../src/services/agent/changesets.js'));
  server = http.createServer((req, res) => {
    let raw = ''; req.on('data', chunk => raw += chunk); req.on('end', () => {
      const payload = JSON.parse(raw); current.payloads.push(payload);
      const calls = payload.messages.filter(message => message.role === 'assistant').flatMap(message => message.tool_calls || []);
      const read = calls.some(call => call.function.name === 'read_file');
      const delta = read ? { content: '已读取当前 notes.txt；本轮尚未执行修改。' }
        : { tool_calls: [{ index: 0, id: 'read-current-' + current.payloads.length, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'notes.txt' }) } }] };
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(sse(delta) + sse({}, read ? 'stop' : 'tool_calls') + 'data: [DONE]\n\n');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
});
after(async () => {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); dbModule.resetDb();
  assert.ok(dataDir.startsWith(path.join(os.tmpdir(), 'corelatex-draft-conflict-run-')));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function fixture() {
  const suffix = ++serial;
  const uid = Number(db.prepare("INSERT INTO users(username,password_hash,role) VALUES(?,'unused','admin')").run('conflict-run-' + suffix).lastInsertRowid);
  db.prepare('INSERT INTO settings(user_id,agent_config,chinese_support) VALUES(?,?,0)').run(uid, JSON.stringify({ graphOrchestration: false, confirmBeforeApply: false, allowWebAccess: false }));
  const pid = Number(db.prepare('INSERT INTO projects(name,owner_id,public_id) VALUES(?,?,?)').run('Conflict run', uid, 'conflict-run-' + suffix).lastInsertRowid);
  const cid = Number(db.prepare('INSERT INTO chats(project_id,user_id) VALUES(?,?)').run(pid, uid).lastInsertRowid);
  const dir = path.join(dataDir, 'projects', String(pid)); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'notes.txt'), ORIGINAL);
  fs.writeFileSync(path.join(dir, 'appendix.txt'), 'APPENDIX_ORIGINAL\n');
  return { user: db.prepare('SELECT * FROM users WHERE id=?').get(uid), project: db.prepare('SELECT * FROM projects WHERE id=?').get(pid),
    chat: db.prepare('SELECT * FROM chats WHERE id=?').get(cid), dir, events: [], payloads: [] };
}
function seedCheckpoint(f, { published = false, twoFiles = false } = {}) {
  const ctx = { db, user: f.user, project: f.project, chatId: f.chat.id, projectDir: f.dir, changesetBuffer: [] };
  const handle = openAgentDraft(ctx);
  ctx.changesetBuffer.push({ path: 'notes.txt', before: ORIGINAL, after: PRIVATE, encoding: 'utf8' });
  if (twoFiles) ctx.changesetBuffer.push({ path: 'appendix.txt', before: 'APPENDIX_ORIGINAL\n', after: 'UNAPPLIED_APPENDIX\n', encoding: 'utf8' });
  handle.checkpoint(); if (published) handle.publish();
  return db.prepare('SELECT * FROM agent_drafts WHERE id=?').get(handle.id);
}
async function run(f, instruction, extra = {}) {
  current = f; f.events = []; f.payloads = [];
  return runAgent({ user: f.user, project: f.project, chat: f.chat, messages: [{ role: 'user', content: instruction }],
    modelConfig: { provider: 'openai', model: 'conflict-run-fixture', apiKey: 'synthetic', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, maxTokens: 4096, contextLength: 128000 },
    emit: event => f.events.push(structuredClone(event)), ...extra });
}
function reload(messageId) {
  const connection = new Database(db.name, { readonly: true });
  try {
    const row = connection.prepare('SELECT * FROM chat_messages WHERE id=?').get(messageId);
    return { ...row, steps: JSON.parse(row.steps), calls: JSON.parse(row.tool_calls) };
  } finally { connection.close(); }
}
function assertPreserved(old, state = 'conflicted') {
  const saved = db.prepare('SELECT * FROM agent_drafts WHERE id=?').get(old.id);
  assert.equal(saved.state, state);
  for (const key of ['id', 'project_id', 'chat_id', 'user_id', 'version', 'published_version', 'changeset_id', 'review_fingerprint', 'files_json'])
    assert.equal(saved[key], old[key], 'preserve original draft ' + key);
  return saved;
}
function assertReadCurrent(f, result, text, instruction) {
  assert.equal(result.status, 'completed'); assert.equal(result.changeset, null);
  assert.equal(f.payloads.length, 2, 'one actual read and one final response; no replayed edits');
  assert.ok(f.payloads[0].messages.some(message => textOf(message).includes(instruction)), 'the new instruction really reaches the model');
  const read = f.payloads[1].messages.filter(message => message.role === 'tool').map(textOf).join('\n');
  assert.equal(read, text);
  assert.ok(!JSON.stringify(f.payloads).includes('OLD_PRIVATE_DRAFT_MUST_REMAIN_COMPLETE'), 'quarantined draft bytes are not injected into new model context');
  assert.equal(f.events.some(event => event.type === 'changeset'), false);
  const row = reload(result.messageId);
  assert.deepEqual(row.calls.map(call => call.name), ['read_file']);
  assert.equal(f.events.at(-1).state, 'completed');
  return row;
}

test('an unpublished checkpoint conflict preserves every old byte and lets a new instruction read current disk', async () => {
  const f = fixture(), old = seedCheckpoint(f);
  assert.equal(old.changeset_id, null); assert.equal(old.published_version, 0);
  fs.writeFileSync(path.join(f.dir, 'notes.txt'), HUMAN);
  const instruction = 'NEW_INSTRUCTION_ONLY：读取当前 notes.txt 并解释，不要修改。';
  const result = await run(f, instruction);
  const row = assertReadCurrent(f, result, HUMAN, instruction); assertPreserved(old);
  const notices = f.events.filter(event => event.type === 'activity' && event.phase === 'draft_recovery');
  assert.equal(notices.length, 1); assert.equal(notices[0].recovery.draftId, old.id);
  assert.equal(notices[0].code, 'DRAFT_RECOVERY_ISOLATED');
  assert.equal(notices[0].recovery.chatId, f.chat.id); assert.equal(notices[0].recovery.projectId, f.project.public_id);
  assert.equal(notices[0].recovery.version, old.version);
  assert.match(notices[0].text, /保留/); assert.match(notices[0].text, /当前文件|当前.*继续/);
  assert.deepEqual(row.steps.filter(step => step.type === 'activity' && step.phase === 'draft_recovery'), notices);
  assert.match(JSON.stringify(f.payloads[0].messages), /旧草稿冲突已隔离/, 'the coordinator is explicitly anchored to current files after isolation');
  assert.ok(!JSON.stringify(f.events).includes('OLD_PRIVATE_DRAFT_MUST_REMAIN_COMPLETE'));
  assert.ok(!JSON.stringify(row).includes('OLD_PRIVATE_DRAFT_MUST_REMAIN_COMPLETE'));
  assert.equal(fs.readFileSync(path.join(f.dir, 'notes.txt'), 'utf8'), HUMAN);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM changesets WHERE chat_id=?').get(f.chat.id).n, 0);
});

test('a partially reviewed proposal is not re-adopted or re-submitted on subsequent read-only rounds', async () => {
  const f = fixture(), old = seedCheckpoint(f, { published: true, twoFiles: true });
  revertChangeset(old.changeset_id, 'appendix.txt', 0);
  const reviewBefore = db.prepare('SELECT * FROM changeset_files WHERE changeset_id=? ORDER BY id').all(old.changeset_id);
  const proposalBefore = db.prepare('SELECT * FROM changesets WHERE id=?').get(old.changeset_id);
  for (const suffix of ['FIRST', 'SECOND', 'THIRD']) {
    const instruction = suffix + '_CURRENT_DISK：仅读取 notes.txt。';
    const result = await run(f, instruction);
    assertReadCurrent(f, result, ORIGINAL, instruction); assertPreserved(old);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM agent_drafts WHERE chat_id=?').get(f.chat.id).n, 1, 'the legacy proposal must not become another active draft');
    assert.equal(db.prepare("SELECT COUNT(*) n FROM agent_drafts WHERE chat_id=? AND state='active'").get(f.chat.id).n, 0);
    assert.deepEqual(db.prepare('SELECT * FROM changeset_files WHERE changeset_id=? ORDER BY id').all(old.changeset_id), reviewBefore);
    assert.deepEqual(db.prepare('SELECT * FROM changesets WHERE id=?').get(old.changeset_id), proposalBefore);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM changesets WHERE chat_id=?').get(f.chat.id).n, 1);
  }
});

test('pre-cancelled requests leave a conflicting active checkpoint untouched', async () => {
  const f = fixture(), old = seedCheckpoint(f); fs.writeFileSync(path.join(f.dir, 'notes.txt'), HUMAN);
  const controller = new AbortController(); controller.abort(new Error('用户已停止执行'));
  await assert.rejects(run(f, 'Cancelled instruction', { signal: controller.signal }), /用户已停止执行/);
  assertPreserved(old, 'active'); assert.equal(f.payloads.length, 0); assert.deepEqual(f.events, []);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM chat_messages WHERE chat_id=?').get(f.chat.id).n, 0);
});

test('disabled credentials cannot quarantine a draft or write a recovery notice', async () => {
  const f = fixture(), old = seedCheckpoint(f); fs.writeFileSync(path.join(f.dir, 'notes.txt'), HUMAN);
  db.prepare("UPDATE users SET status='disabled' WHERE id=?").run(f.user.id);
  await assert.rejects(run(f, 'Unauthorized instruction'), error => error.status === 403);
  assertPreserved(old, 'active'); assert.equal(f.payloads.length, 0); assert.deepEqual(f.events, []);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM chat_messages WHERE chat_id=?').get(f.chat.id).n, 0);
});

test('another chat never receives the owner chat draft or its recovery metadata', async () => {
  const f = fixture(), old = seedCheckpoint(f); fs.writeFileSync(path.join(f.dir, 'notes.txt'), HUMAN);
  await run(f, 'Owner chat starts a fresh read.'); assertPreserved(old);
  const cid = Number(db.prepare('INSERT INTO chats(project_id,user_id) VALUES(?,?)').run(f.project.id, f.user.id).lastInsertRowid);
  const other = { ...f, chat: db.prepare('SELECT * FROM chats WHERE id=?').get(cid), events: [], payloads: [] };
  const instruction = 'UNRELATED_CHAT_ONLY：读取当前文件。';
  const result = await run(other, instruction); const row = assertReadCurrent(other, result, HUMAN, instruction);
  assert.equal(other.events.some(event => event.phase === 'draft_recovery'), false);
  assert.equal(row.steps.some(step => step.phase === 'draft_recovery'), false);
  assert.ok(!JSON.stringify(other.events).includes('OLD_PRIVATE_DRAFT_MUST_REMAIN_COMPLETE'));
  assertPreserved(old);
});

test('another user cannot trigger recovery in a chat they do not own', async () => {
  const f = fixture(), intruder = fixture(), old = seedCheckpoint(f); fs.writeFileSync(path.join(f.dir, 'notes.txt'), HUMAN);
  await assert.rejects(run(f, 'Foreign instruction', { user: intruder.user }), error => error.status === 403);
  assertPreserved(old, 'active'); assert.equal(f.payloads.length, 0); assert.deepEqual(f.events, []);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM chat_messages WHERE chat_id=?').get(f.chat.id).n, 0);
});
