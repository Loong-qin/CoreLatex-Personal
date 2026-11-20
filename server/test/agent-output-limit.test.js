import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'corelatex-output-limit-'));
process.env.CORELATEX_DATA_DIR = dataDir;
let dbModule, db, runAgent, llm, user, mode, requests;
const sse = value => 'data: ' + JSON.stringify({ choices: [{ index: 0, ...value }] }) + '\n\n';
const finish = (res, text, reason = 'stop') => res.end(sse({ delta: { content: text } }) + sse({ delta: {}, finish_reason: reason }) + 'data: [DONE]\n\n');
const tool = (res, name, args, reason = 'tool_calls') => res.end(sse({ delta: { tool_calls: [{ index: 0, id: 'call_' + requests, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }) + sse({ delta: {}, finish_reason: reason }) + 'data: [DONE]\n\n');

before(async () => {
  dbModule = await import('../src/db.js'); db = dbModule.getDb();
  ({ runAgent } = await import('../src/services/agent/agentLoop.js'));
  const id = Number(db.prepare("INSERT INTO users(username,password_hash,role) VALUES('output-limit-owner','unused','admin')").run().lastInsertRowid);
  user = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  db.prepare('INSERT INTO settings(user_id) VALUES(?)').run(id);
  llm = http.createServer((req, res) => {
    let raw = ''; req.on('data', c => raw += c); req.on('end', () => {
      requests++;
      const calls = JSON.parse(raw).messages.filter(m => m.role === 'assistant').flatMap(m => m.tool_calls || []);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (mode === 'text-only') return finish(res, '分析进行到一半，', 'length');
      if (!calls.some(c => c.function.name === 'read_file')) return tool(res, 'read_file', { path: 'notes.txt' });
      if (!calls.some(c => c.function.name === 'edit_file')) return tool(res, 'edit_file', { path: 'notes.txt', search: 'Original text.', replace: 'Actual edit.' }, mode === 'truncated-tool' ? 'length' : 'tool_calls');
      return finish(res, mode === 'normal' ? '已修改 notes.txt。' : '还需要继续修改另一部分，', mode === 'normal' ? 'stop' : 'length');
    });
  });
  await new Promise(resolve => llm.listen(0, '127.0.0.1', resolve));
});

after(async () => {
  llm?.closeAllConnections(); await new Promise(resolve => llm.close(resolve));
  dbModule.resetDb();
  assert.ok(dataDir.startsWith(path.join(os.tmpdir(), 'corelatex-output-limit-')));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function run(scenario) {
  mode = scenario; requests = 0;
  const pid = Number(db.prepare('INSERT INTO projects(name,owner_id,public_id) VALUES(?,?,?)').run('Output limit fixture', user.id, randomUUID()).lastInsertRowid);
  const cid = Number(db.prepare('INSERT INTO chats(project_id,user_id) VALUES(?,?)').run(pid, user.id).lastInsertRowid);
  const dir = path.join(dataDir, 'projects', String(pid)); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'Original text.\n');
  const events = [];
  const result = await runAgent({
    user, project: db.prepare('SELECT * FROM projects WHERE id=?').get(pid), chat: db.prepare('SELECT * FROM chats WHERE id=?').get(cid),
    messages: [{ role: 'user', content: '请修改文稿。' }],
    modelConfig: { provider: 'openai', model: 'output-limit-mock', apiKey: 'synthetic', baseUrl: 'http://127.0.0.1:' + llm.address().port + '/v1', maxTokens: 1024, contextLength: 100000 },
    emit: event => events.push(event),
  });
  return { result, events, disk: fs.readFileSync(path.join(dir, 'notes.txt'), 'utf8') };
}

test('length-limited text is failed without claiming completion or submitting changes', async () => {
  const f = await run('text-only');
  assert.equal(requests, 1); assert.equal(f.result.status, 'failed');
  assert.equal(f.events.at(-1).state, 'failed'); assert.equal(f.result.changeset, null);
  assert.equal(f.disk, 'Original text.\n');
  assert.ok(f.events.some(e => e.type === 'token' && e.text.includes('任务尚未完成')));
});

test('output limit retains already completed edits for review without applying them', async () => {
  const f = await run('edited');
  assert.equal(requests, 3); assert.equal(f.result.status, 'failed');
  assert.equal(f.events.at(-1).state, 'failed'); assert.equal(f.disk, 'Original text.\n');
  assert.ok(f.result.changeset); assert.equal(f.result.changeset.applied, false);
  assert.equal(f.result.changeset.status, 'pending');
  assert.equal(f.result.changeset.files[0].applied, false);
});

test('parseable tools in a length-limited response cannot run and cannot start another model turn', async () => {
  const f = await run('truncated-tool');
  assert.equal(requests, 2); assert.equal(f.result.status, 'failed');
  assert.equal(f.result.changeset, null); assert.equal(f.disk, 'Original text.\n');
  const blocked = f.events.find(e => e.type === 'tool' && e.name === 'edit_file' && e.status === 'error');
  assert.ok(blocked); assert.match(blocked.detail, /截断响应/);
});

test('ordinary stop still completes and automatically applies a genuine edit', async () => {
  const f = await run('normal');
  assert.equal(requests, 3); assert.equal(f.result.status, 'completed');
  assert.equal(f.events.at(-1).state, 'completed'); assert.equal(f.disk, 'Actual edit.\n');
  assert.equal(f.result.changeset.applied, true);
});
