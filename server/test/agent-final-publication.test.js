import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'corelatex-final-publication-'));
process.env.CORELATEX_DATA_DIR = dataDir;
const PROGRESS = '我先核对当前内容，再按要求调整措辞。';
const CANDIDATE = '文字调整已完成，交付候选ALPHA。';
const REVISED = '文字调整已更新，交付候选BETA。';
const FINAL = '已结合独立审阅完成文字调整，最终交付OMEGA。';
const LIMITATION = '未取得入组附表，无法核对分组人数。';
const STEERING = '请在结论中说明这项记录属于试点。';
const BLOCKED = '独立审阅发现阻断问题，本轮尚未完成；请先修复报告中的问题，再继续验证。';
const DIRECT = '普通问题的解释如下：一个段落表达一个主要观点。';
let dbModule, db, runAgent, user, server, current;
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const textOf = message => typeof message.content === 'string' ? message.content
  : (message.content || []).filter(part => part.type === 'text').map(part => part.text).join('\n');
const chunk = value => 'data: ' + JSON.stringify({ choices: [{ index: 0, ...value }] }) + '\n\n';
const stop = (res, content) => res.end(chunk({ delta: { content } }) + chunk({ delta: {}, finish_reason: 'stop' }) + 'data: [DONE]\n\n');
const call = (res, name, input, prefix = '') => res.end((prefix ? chunk({ delta: { content: prefix } }) : '')
  + chunk({ delta: { tool_calls: [{ index: 0, id: 'call_' + current.requests, type: 'function', function: { name, arguments: JSON.stringify(input) } }] } })
  + chunk({ delta: {}, finish_reason: 'tool_calls' }) + 'data: [DONE]\n\n');
function assignment(payload) {
  for (const message of payload.messages) {
    if (message.role !== 'user') continue;
    try { const value = JSON.parse(textOf(message)); if (value.assignment) return value; } catch { /* Ordinary user input. */ }
  }
}
function respond(payload, res) {
  const f = current;
  const calls = payload.messages.filter(message => message.role === 'assistant').flatMap(message => message.tool_calls || []);
  const count = name => calls.filter(item => item.function.name === name).length;
  const job = assignment(payload);
  if (job) {
    if (!count('read_file')) return call(res, 'read_file', { path: 'notes.txt' });
    const reviewer = job.assignment.role === 'reviewer';
    const repaired = payload.messages.some(message => message.role === 'tool' && textOf(message).includes('Participants: 40, confirmed.'));
    const verdict = reviewer && f.mode === 'blocked' ? 'blocked'
      : reviewer && f.mode === 'repair' && !repaired ? 'needs_changes' : 'pass';
    if (reviewer) f.reports++;
    return call(res, 'submit_agent_report', {
      summary: verdict === 'pass' ? '已读取真实内容，独立核查结束。' : '本次人数与原始记录冲突，需要修正。',
      verdict,
      ...(reviewer && f.mode === 'limitation' ? { limitations: [LIMITATION] } : {}),
      findings: verdict === 'pass' ? [] : [{ severity: 'error', category: 'conflict', path: 'notes.txt', line: 1,
        side: 'after', message: '本次记录的 80 人与原始记录的 40 人冲突。',
        evidence: { source: 'notes.txt', quote: 'Participants: 40.' } }],
    });
  }
  if (f.mode === 'direct') return stop(res, DIRECT);
  if (!count('read_file')) return call(res, 'read_file', { path: 'notes.txt' }, PROGRESS);
  const changedBy = replacement => calls.filter(item => item.function.name === 'edit_file' && JSON.parse(item.function.arguments).replace === replacement)
    .some(item => payload.messages.some(message => message.role === 'tool' && message.tool_call_id === item.id && /"changed":true/.test(textOf(message))));
  if (!changedBy('Participants: 80.')) return call(res, 'edit_file', { path: 'notes.txt', search: 'Participants: 40.', replace: 'Participants: 80.' });
  if (f.mode === 'repair' && f.reports && !changedBy('Participants: 40, confirmed.'))
    return call(res, 'edit_file', { path: 'notes.txt', search: 'Participants: 80.', replace: 'Participants: 40, confirmed.' });
  if (f.mode === 'blocked' && f.reports) return stop(res, BLOCKED);
  if (!f.reports) return stop(res, CANDIDATE);
  if (f.mode === 'repair' && f.reports < 2) return stop(res, REVISED);
  if (f.mode === 'limitation') return stop(res, FINAL + LIMITATION);
  if (f.mode === 'steering' && payload.messages.some(message => message.role === 'user' && textOf(message) === STEERING)) {
    const phases = calls.filter(item => item.function.name === 'run_agent_graph').map(item => JSON.parse(item.function.arguments).phase);
    if (!phases.includes('analysis')) return call(res, 'run_agent_graph', { phase: 'analysis' });
    if (!phases.includes('review')) return call(res, 'run_agent_graph', { phase: 'review' });
    return stop(res, FINAL + '此记录属于试点。');
  }
  return stop(res, FINAL);
}

before(async () => {
  dbModule = await import('../src/db.js'); db = dbModule.getDb();
  ({ runAgent } = await import('../src/services/agent/agentLoop.js'));
  const uid = Number(db.prepare("INSERT INTO users(username,password_hash,role) VALUES('publication-owner','unused','admin')").run().lastInsertRowid);
  user = db.prepare('SELECT * FROM users WHERE id=?').get(uid);
  db.prepare('INSERT INTO settings(user_id) VALUES(?)').run(uid);
  server = http.createServer((req, res) => {
    let raw = ''; req.on('data', value => raw += value); req.on('end', () => {
      const f = current; f.requests++;
      const payload = JSON.parse(raw); f.payloads.push(payload);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (f.requests > 40) { f.controller.abort(new Error('Fixture exceeded 40 requests')); res.end(); return; }
      if (assignment(payload)?.assignment.role === 'reviewer' && !f.held) {
        f.held = true;
        f.release = () => { if (!res.writableEnded) respond(payload, res); };
        f.reviewStarted.resolve();
        return;
      }
      respond(payload, res);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
});
after(async () => {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); dbModule.resetDb();
  assert.ok(dataDir.startsWith(path.join(os.tmpdir(), 'corelatex-final-publication-')));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function start(t, mode, graphOrchestration = true) {
  db.prepare('UPDATE settings SET chinese_support=0,agent_config=? WHERE user_id=?')
    .run(JSON.stringify({ graphOrchestration, confirmBeforeApply: false, allowWebAccess: false, allowRunScripts: false }), user.id);
  const pid = Number(db.prepare('INSERT INTO projects(name,owner_id,public_id) VALUES(?,?,?)').run('Publication fixture', user.id, randomUUID()).lastInsertRowid);
  const cid = Number(db.prepare('INSERT INTO chats(project_id,user_id) VALUES(?,?)').run(pid, user.id).lastInsertRowid);
  const dir = path.join(dataDir, 'projects', String(pid)); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'Participants: 40.\n');
  const f = current = { mode, cid, dir, controller: new AbortController(), reviewStarted: deferred(), requests: 0, reports: 0, events: [], payloads: [], pendingInputs: [] };
  f.done = runAgent({ user, project: db.prepare('SELECT * FROM projects WHERE id=?').get(pid), chat: db.prepare('SELECT * FROM chats WHERE id=?').get(cid),
    messages: [{ role: 'user', content: mode === 'direct' ? '解释段落写作原则。' : '请更新 notes.txt 的参与人数并确保准确。' }],
    modelConfig: { provider: 'openai', model: 'publication-fixture', apiKey: 'synthetic', baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1', maxTokens: 1024, contextLength: 100000 },
    signal: f.controller.signal, emit: event => f.events.push(structuredClone(event)),
    runControl: { takeInputs() { return f.pendingInputs.splice(0); }, sealInputs() {
      f.sealed = true;
      if (mode === 'publish-failure') db.exec(`CREATE TEMP TRIGGER publication_failure_${cid} BEFORE INSERT ON changesets
        WHEN NEW.chat_id=${cid} BEGIN SELECT RAISE(ABORT, 'fixture proposal publish failed'); END`);
      if (mode === 'apply-failure') db.exec(`CREATE TEMP TRIGGER publication_failure_${cid} BEFORE UPDATE OF applied ON changeset_files
        WHEN NEW.applied=1 AND NEW.changeset_id IN (SELECT id FROM changesets WHERE chat_id=${cid})
        BEGIN SELECT RAISE(ABORT, 'fixture proposal apply failed'); END`);
      return true;
    } } });
  t.after(async () => {
    f.controller.abort(new Error('Fixture cleanup')); f.release?.();
    await f.done;
    db.exec(`DROP TRIGGER IF EXISTS publication_failure_${cid}`);
  });
  return f;
}
function reload(f) {
  // A new read-only connection exercises the persisted view used by reconnect
  // and history reload, instead of trusting only the in-memory event array.
  const connection = new Database(db.name, { readonly: true });
  try {
    const row = connection.prepare("SELECT * FROM chat_messages WHERE chat_id=? AND role='assistant' ORDER BY id DESC LIMIT 1").get(f.cid);
    return { ...row, steps: JSON.parse(row.steps) };
  } finally { connection.close(); }
}
function assertNoCandidate(f, row = reload(f)) {
  for (const token of ['交付候选ALPHA', '交付候选BETA']) {
    assert.ok(!JSON.stringify(f.events).includes(token), 'unapproved candidate must never reach an observable event');
    assert.ok(!row.content.includes(token), 'unapproved candidate must not survive database reload');
    assert.ok(!JSON.stringify(row.steps).includes(token), 'timeline must not persist the candidate');
  }
}
async function pendingReview(f) {
  await Promise.race([f.reviewStarted.promise, f.done.then(() => { throw new Error('Run ended before the held review'); })]);
  assert.ok(f.events.some(event => event.type === 'tool' && event.agentRole === 'analyst'), 'real specialist orchestration ran');
  assert.equal(f.events.some(event => event.type === 'done'), false);
  assertNoCandidate(f);
  assert.ok(f.events.some(event => event.type === 'token' && event.text.includes(PROGRESS)), 'tool-prefacing progress remains visible');
  assert.ok(reload(f).content.includes(PROGRESS), 'real progress remains reloadable while review is pending');
  const progress = f.events.findIndex(event => event.type === 'token' && event.text.includes(PROGRESS));
  const read = f.events.findIndex(event => event.type === 'tool' && !event.agentRole && event.name === 'read_file' && event.status === 'start');
  assert.ok(progress >= 0 && progress < read, 'progress precedes the corresponding tool execution');
}

test('clean automatic review publishes the verified candidate without another coordinator call', { timeout: 15000 }, async t => {
  const f = start(t, 'pass'); await pendingReview(f); f.release();
  const result = await f.done; const row = reload(f);
  assert.equal(result.status, 'completed');
  assert.ok(row.content.endsWith(CANDIDATE));
  assert.equal(row.steps.filter(step => step.type === 'text' && step.text.includes(CANDIDATE)).length, 1);
  assert.equal(f.payloads.filter(payload => !assignment(payload)).length, 4);
  const final = f.events.findIndex(event => event.type === 'token' && event.text.includes(CANDIDATE));
  const report = f.events.findIndex(event => event.type === 'agent_report' && event.agentRole === 'reviewer');
  assert.ok(report >= 0 && report < final, 'delivery follows the real reviewer report');
  assert.equal(f.events.at(-1).type, 'done');
});
test('needs_changes causes a real repair and re-review; only the updated final summary is published', { timeout: 15000 }, async t => {
  const f = start(t, 'repair'); await pendingReview(f); f.release();
  const result = await f.done; const row = reload(f);
  assert.equal(result.status, 'completed');
  assert.ok(!JSON.stringify([f.events, row]).includes(CANDIDATE));
  const reports = row.steps.filter(step => step.type === 'agent_report' && step.agentRole === 'reviewer');
  assert.deepEqual(reports.map(step => step.report.verdict), ['needs_changes', 'pass']);
  assert.equal(fs.readFileSync(path.join(f.dir, 'notes.txt'), 'utf8'), 'Participants: 40, confirmed.\n');
  assert.ok(row.content.endsWith(REVISED)); assert.equal(row.content.split(REVISED).length - 1, 1);
});
test('an independent pass with a new limitation sends the report back for an updated conclusion', { timeout: 15000 }, async t => {
  const f = start(t, 'limitation'); await pendingReview(f); f.release();
  const result = await f.done; const row = reload(f);
  assert.equal(result.status, 'completed'); assertNoCandidate(f, row);
  assert.ok(row.content.endsWith(FINAL + LIMITATION));
  assert.ok(f.payloads.filter(payload => !assignment(payload)).at(-1).messages.some(message =>
    message.role === 'user' && textOf(message).includes('独立协作报告') && textOf(message).includes(LIMITATION)));
});
test('steering received during a clean review supersedes the withheld conclusion', { timeout: 15000 }, async t => {
  const f = start(t, 'steering'); await pendingReview(f);
  f.pendingInputs.push({ role: 'user', content: STEERING, timestamp: Date.now() });
  f.release();
  const result = await f.done; const row = reload(f);
  assert.equal(result.status, 'completed'); assertNoCandidate(f, row);
  assert.ok(row.content.endsWith(FINAL + '此记录属于试点。'));
  assert.equal(f.reports, 2);
});
test('a blocked review discards the completed candidate and preserves an accurate failure explanation', { timeout: 15000 }, async t => {
  const f = start(t, 'blocked'); await pendingReview(f); f.release();
  const result = await f.done; const row = reload(f);
  assert.equal(result.status, 'failed'); assertNoCandidate(f, row);
  assert.ok(!row.content.includes(FINAL)); assert.match(row.content, /尚未完成|受阻/);
  assert.equal(result.changeset.applied, false);
  assert.equal(fs.readFileSync(path.join(f.dir, 'notes.txt'), 'utf8'), 'Participants: 40.\n');
  assert.equal(f.events.at(-1).state, 'failed');
});
test('cancellation while review is pending never publishes the withheld candidate', { timeout: 15000 }, async t => {
  const f = start(t, 'cancel'); await pendingReview(f); f.controller.abort(new Error('用户已停止执行'));
  const result = await f.done; const row = reload(f);
  assert.equal(result.status, 'cancelled'); assertNoCandidate(f, row);
  assert.match(row.content, /已手动停止/); assert.ok(!row.content.includes(FINAL));
  assert.equal(result.changeset.applied, false); assert.equal(f.events.at(-1).state, 'cancelled');
});
for (const mode of ['publish-failure', 'apply-failure']) test(mode + ' after review passes never releases a final success candidate', { timeout: 15000 }, async t => {
  const f = start(t, mode); await pendingReview(f); f.release();
  const result = await f.done; const row = reload(f);
  assert.equal(f.sealed, true, 'failure is injected after completion admission, not during editing');
  assert.equal(f.reports, 1); assert.equal(result.status, 'failed'); assertNoCandidate(f, row);
  assert.ok(!JSON.stringify(f.events).includes(FINAL)); assert.ok(!row.content.includes(FINAL));
  assert.match(row.content, /草稿检查点已保留.*无法更新待审提案/);
  const draft = db.prepare('SELECT * FROM agent_drafts WHERE chat_id=?').get(f.cid);
  assert.ok(JSON.parse(draft.files_json).some(file => file.after === 'Participants: 80.\n'), 'authorized full draft survives final publishing failure');
  assert.equal(fs.readFileSync(path.join(f.dir, 'notes.txt'), 'utf8'), 'Participants: 40.\n');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM changeset_files f JOIN changesets c ON c.id=f.changeset_id WHERE c.chat_id=? AND f.applied=1').get(f.cid).n, 0);
  assert.equal(f.events.at(-1).state, 'failed');
});
for (const enabled of [false, true]) test('ordinary direct response remains normal with collaboration ' + (enabled ? 'enabled' : 'disabled'), { timeout: 15000 }, async t => {
  const f = start(t, 'direct', enabled); const result = await f.done; const row = reload(f);
  assert.equal(result.status, 'completed'); assert.equal(f.requests, 1); assert.equal(f.reports, 0);
  assert.equal(row.content, DIRECT); assert.equal(f.events.filter(event => event.type === 'token').map(event => event.text).join(''), DIRECT);
  const tools = f.payloads[0].tools.map(tool => tool.function.name);
  const prompt = f.payloads[0].messages[0].content;
  for (const disabled of ['web_search', 'web_fetch', 'run_in_workspace', 'run_skill_script']) {
    assert.ok(!tools.includes(disabled));
    assert.ok(!prompt.includes(disabled));
  }
  assert.equal(f.events.at(-1).state, 'completed');
});
