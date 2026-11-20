import { fileURLToPath } from 'node:url';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'corelatex-draft-integration-'));
process.env.CORELATEX_DATA_DIR = temp;
let dbModule, db, runAgent, server, mode, search, replace, observed, requests = 0, serial = 0, checkpointSeen;
const sse = (delta, finish) => 'data: ' + JSON.stringify({ choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }] }) + '\n\n';
before(async () => {
  dbModule = await import('../src/db.js'); db = dbModule.getDb();
  ({ runAgent } = await import('../src/services/agent/agentLoop.js'));
  server = http.createServer((req, res) => {
    let raw = ''; req.on('data', chunk => raw += chunk); req.on('end', () => {
      const payload = JSON.parse(raw); requests++;
      const calls = payload.messages.filter(item => item.role === 'assistant').flatMap(item => item.tool_calls || []);
      const read = calls.some(item => item.function.name === 'read_file'), edited = calls.some(item => item.function.name === 'edit_file');
      let tool;
      if (!read) tool = { name: 'read_file', arguments: JSON.stringify({ path: 'notes.txt' }) };
      else {
        observed = payload.messages.find(item => item.role === 'tool')?.content;
        if (mode === 'edit' && !edited) tool = { name: 'edit_file', arguments: JSON.stringify({ path: 'notes.txt', search, replace }) };
        if (edited) checkpointSeen = db.prepare('SELECT files_json FROM agent_drafts ORDER BY id DESC LIMIT 1').get()?.files_json.includes(replace);
      }
      const delta = tool ? { tool_calls: [{ index: 0, id: 'call-' + requests, type: 'function', function: tool }] }
        : { content: mode === 'edit' ? 'notes.txt 的措辞调整完成。' : '已读取 notes.txt。' };
      res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(sse(delta) + sse({}, tool ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
});
after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); dbModule.resetDb(); fs.rmSync(temp, { recursive: true, force: true }); });
function fixture(confirmBeforeApply = true) {
  const uid = Number(db.prepare("INSERT INTO users(username,password_hash,role) VALUES(?,'unused','admin')").run('draft-integration-' + ++serial).lastInsertRowid);
  db.prepare('INSERT INTO settings(user_id,agent_config) VALUES(?,?)').run(uid, JSON.stringify({ confirmBeforeApply }));
  const pid = Number(db.prepare('INSERT INTO projects(name,owner_id,public_id) VALUES(?,?,?)').run('draft integration', uid, 'draft-integration-' + serial).lastInsertRowid);
  const cid = Number(db.prepare('INSERT INTO chats(project_id,user_id) VALUES(?,?)').run(pid, uid).lastInsertRowid);
  const dir = path.join(temp, 'projects', String(pid)); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'notes.txt'), 'original');
  const events = [];
  return { user: db.prepare('SELECT * FROM users WHERE id=?').get(uid), project: db.prepare('SELECT * FROM projects WHERE id=?').get(pid),
    chat: db.prepare('SELECT * FROM chats WHERE id=?').get(cid), dir, events,
    modelConfig: { provider: 'openai', model: 'draft-fixture', apiKey: 'synthetic', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, maxTokens: 8192, contextLength: 256000 } };
}
async function run(f, instruction) {
  f.events.length = 0;
  const id = Number(db.prepare("INSERT INTO chat_messages(chat_id,role,content) VALUES(?,'user',?)").run(f.chat.id, instruction).lastInsertRowid);
  return runAgent({ ...f, messages: [{ id, role: 'user', content: instruction }], emit: event => f.events.push(event) });
}

test('real sequential runs continue unapplied drafts by identity and do not repeat read-only proposals', async () => {
  const f = fixture(); mode = 'edit'; search = 'original'; replace = 'pending';
  const first = await run(f, '把 notes.txt 的 original 改为 pending，留待审核。');
  assert.equal(first.status, 'completed'); assert.equal(first.changeset.applied, false); assert.equal(checkpointSeen, true);
  mode = 'read'; const read = await run(f, '继续上轮未应用草稿，只读取 notes.txt。');
  assert.equal(read.status, 'completed'); assert.equal(observed, 'pending'); assert.equal(read.changeset, null);
  assert.equal(f.events.some(event => event.type === 'changeset'), false);
  db.prepare('UPDATE settings SET agent_config=? WHERE user_id=?').run('{}', f.user.id);
  mode = 'edit'; search = 'pending'; replace = 'continued';
  const next = await run(f, '在上轮草稿基础上把 pending 改成 continued。');
  assert.equal(next.status, 'completed'); assert.equal(next.changeset.id, first.changeset.id); assert.equal(next.changeset.applied, false);
  assert.equal(fs.readFileSync(path.join(f.dir, 'notes.txt'), 'utf8'), 'original');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM changesets WHERE chat_id=?').get(f.chat.id).n, 1);
  assert.equal(db.prepare('SELECT after_content FROM changeset_files WHERE changeset_id=?').get(first.changeset.id).after_content, 'continued');
});

test('default auto-apply runs continue from current disk without restoring already-applied review history', async () => {
  const f = fixture(false); mode = 'edit'; search = 'original'; replace = 'first';
  const first = await run(f, '把 notes.txt 的 original 改为 first。');
  assert.equal(first.changeset.applied, true); assert.equal(fs.readFileSync(path.join(f.dir, 'notes.txt'), 'utf8'), 'first');
  search = 'first'; replace = 'second'; const second = await run(f, '把当前 notes.txt 的 first 改为 second。');
  assert.equal(second.status, 'completed'); assert.equal(observed, 'first'); assert.equal(second.changeset.applied, true);
  assert.notEqual(second.changeset.id, first.changeset.id); assert.equal(fs.readFileSync(path.join(f.dir, 'notes.txt'), 'utf8'), 'second');
});

test('a previous draft conflict is preserved while the new instruction reads current disk', async () => {
  const f = fixture(); mode = 'edit'; search = 'original'; replace = 'pending'; await run(f, '将 notes.txt 改为 pending。');
  const old = db.prepare('SELECT * FROM agent_drafts WHERE chat_id=?').get(f.chat.id);
  fs.writeFileSync(path.join(f.dir, 'notes.txt'), 'human'); const before = requests;
  mode = 'read';
  const result = await run(f, '请只读取当前文件，不覆盖人工修改。');
  assert.equal(result.status, 'completed'); assert.equal(requests, before + 2); assert.equal(observed, 'human');
  assert.equal(result.changeset, null); assert.equal(f.events.some(event => event.type === 'changeset'), false);
  const message = db.prepare('SELECT content,tool_calls,steps FROM chat_messages WHERE id=?').get(result.messageId);
  assert.deepEqual(JSON.parse(message.tool_calls).map(call => call.name), ['read_file']);
  const notice = JSON.parse(message.steps).find(step => step.phase === 'draft_recovery');
  assert.equal(notice.recovery.draftId, old.id); assert.match(notice.text, /保留/);
  const preserved = db.prepare('SELECT * FROM agent_drafts WHERE id=?').get(old.id);
  assert.equal(preserved.state, 'conflicted'); assert.equal(preserved.files_json, old.files_json);
  assert.equal(preserved.changeset_id, old.changeset_id); assert.equal(preserved.version, old.version);
  assert.equal(fs.readFileSync(path.join(f.dir, 'notes.txt'), 'utf8'), 'human');
  assert.equal(f.events.at(-1).state, 'completed');
});

test('an unauthorized run cannot write even an error reply into another user chat', async () => {
  const owner = fixture(), other = fixture(), before = requests;
  const count = db.prepare('SELECT COUNT(*) n FROM chat_messages WHERE chat_id=?').get(owner.chat.id).n;
  await assert.rejects(runAgent({ ...owner, user: other.user, messages: [], emit: () => {} }), error => error.status === 403);
  assert.equal(requests, before); assert.equal(db.prepare('SELECT COUNT(*) n FROM chat_messages WHERE chat_id=?').get(owner.chat.id).n, count);
});

test('killed process retains the full successful draft and restart recovers without replay or disk application', async () => {
  const crashDir = fs.mkdtempSync(path.join(os.tmpdir(), 'corelatex-draft-crash-'));
  const content = 'complete draft material\n'.repeat(3000) + 'COMPLETE_END_MARKER';
  let count = 0, reached; const ready = new Promise(resolve => reached = resolve);
  const llm = http.createServer((req, res) => { let raw = ''; req.on('data', part => raw += part); req.on('end', () => {
    JSON.parse(raw); count++;
    if (count === 3) { reached(); return; }
    const name = count === 1 ? 'read_file' : 'write_file', args = count === 1 ? { path: 'notes.txt' } : { path: 'notes.txt', content };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(sse({ tool_calls: [{ index: 0, id: 'crash-' + count, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }) + sse({}, 'tool_calls') + 'data: [DONE]\n\n');
  }); });
  let child;
  try {
    await new Promise(resolve => llm.listen(0, '127.0.0.1', resolve));
    child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/draft-crash.mjs', import.meta.url)), crashDir, `http://127.0.0.1:${llm.address().port}/v1`], { stdio: ['ignore', 'ignore', 'pipe'] });
    let diagnostic = ''; child.stderr.on('data', part => diagnostic += part);
    const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    let timer;
    try { await Promise.race([ready, exited.then(() => { throw new Error(diagnostic); }), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('crash fixture timeout')), 10000); })]); }
    finally { clearTimeout(timer); }
    child.kill('SIGKILL'); await exited;
    const probe = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/draft-crash.mjs', import.meta.url)), crashDir, 'recover'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = ''; probe.stdout.on('data', part => output += part); probe.stderr.on('data', part => errors += part);
    const code = await new Promise(resolve => probe.once('exit', resolve)); assert.equal(code, 0, errors);
    const result = JSON.parse(output.trim()); assert.equal(result.state, 'interrupted'); assert.equal(result.content, content);
    assert.equal(result.disk, 'original'); assert.equal(result.beforeChangesets, 0); assert.equal(result.resumed, true);
    assert.equal(count, 3); assert.equal(result.published, true); assert.equal(result.applied, false);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    llm.closeAllConnections(); await new Promise(resolve => llm.close(resolve)); fs.rmSync(crashDir, { recursive: true, force: true });
  }
});
