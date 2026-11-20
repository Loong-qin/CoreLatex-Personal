import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'corelatex-blocked-handoff-'));
const dataDir = path.join(temp, 'data'), bin = path.join(temp, 'bin');
const saved = { PATH: process.env.PATH, CORELATEX_DATA_DIR: process.env.CORELATEX_DATA_DIR, CORELATEX_HANDOFF_MARKERS: process.env.CORELATEX_HANDOFF_MARKERS };
process.env.CORELATEX_DATA_DIR = dataDir;
fs.mkdirSync(bin);
let dbModule, db, runAgent, llm, mode, requests, payloads, serial = 0;
const original = '\\documentclass{article}\n\\begin{document}\nOriginal text.\n\\end{document}\n';
const finalExplanation = '已暂存 main.tex 的文字修改。今日编译额度已用完，当前草稿尚未通过编译验证，也尚未应用。请管理员补充今日额度，或在次日额度恢复后从现有草稿继续验证，无需重做。';
const sse = value => 'data: ' + JSON.stringify({ choices: [{ index: 0, ...value }] }) + '\n\n';
const text = (res, content) => res.end(sse({ delta: { content } }) + sse({ delta: {}, finish_reason: 'stop' }) + 'data: [DONE]\n\n');
const tool = (res, name, args) => res.end(sse({ delta: { tool_calls: [{ index: 0, id: 'call_' + requests, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }) + sse({ delta: {}, finish_reason: 'tool_calls' }) + 'data: [DONE]\n\n');

function binary(name, body) {
  fs.writeFileSync(path.join(bin, name), '#!' + process.execPath + '\n' + body, { mode: 0o755 });
}

before(async () => {
  // No host TeX/rendering executable may accidentally satisfy these fixtures.
  process.env.PATH = bin;
  binary('pdflatex', String.raw`
const fs = require('node:fs'), path = require('node:path');
const marker = process.env.CORELATEX_HANDOFF_MARKERS;
fs.appendFileSync(path.join(marker, 'compiles'), 'compile\n');
const main = process.argv.at(-1), base = path.basename(main).replace(/\.tex$/i, '');
fs.mkdirSync('.build', {recursive: true});
fs.writeFileSync(path.join('.build', base + '.pdf'), '%PDF-1.4 fake\n' + fs.readFileSync(main, 'utf8'));
fs.writeFileSync(path.join('.build', base + '.log'), 'Output written on ' + base + '.pdf');
`);
  binary('pdfinfo', "console.log('Pages: 1');");
  binary('pdftoppm', "process.stderr.write('renderer unavailable in fixture'); process.exit(9);");
  dbModule = await import('../src/db.js'); db = dbModule.getDb();
  ({ runAgent } = await import('../src/services/agent/agentLoop.js'));
  llm = http.createServer((req, res) => {
    let raw = ''; req.on('data', chunk => raw += chunk); req.on('end', () => {
      requests++;
      const payload = JSON.parse(raw); payloads.push(payload);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const messages = payload.messages;
      const handoff = messages.some(m => m.role === 'user' && typeof m.content === 'string' && m.content.includes('【执行受阻交接】'));
      if (handoff) {
        if (mode === 'tool-handoff') return tool(res, 'write_file', { path: 'forbidden.txt', content: 'Do not write this.' });
        if (mode === 'missing-compile') return text(res, '已暂存 main.tex 的文字修改，但本轮没有实际执行编译，当前草稿尚未验证，也尚未应用。下一步需要对现有草稿执行编译验证，然后再决定是否应用。');
        if (mode === 'bad-handoff') return text(res, '编译成功，修改已应用到项目。');
        if (mode === 'unavailable') return text(res, '已暂存 main.tex 的文字修改。编译引擎无法启动，因此当前草稿尚未通过验证，也尚未应用。请恢复编译引擎后从已有草稿继续编译；这不是正文错误。');
        return text(res, finalExplanation);
      }
      const calls = messages.filter(m => m.role === 'assistant').flatMap(m => m.tool_calls || []);
      const has = name => calls.some(c => c.function.name === name);
      if (!has('read_file')) return tool(res, 'read_file', { path: 'main.tex' });
      if (!has('edit_file')) return tool(res, 'edit_file', { path: 'main.tex', search: 'Original text.', replace: 'Revised text.' });
      if (mode === 'missing-compile') return text(res, '已暂存 main.tex 的文字修改，尚未编译验证。');
      if (!has('compile_and_preview')) return tool(res, 'compile_and_preview', { pages: '1' });
      if (mode === 'snapshot-failed') return text(res, '已暂存 main.tex 的修改。编译成功，但保存 PDF 预览快照失败，尚未检查排版图像。');
      return text(res, '已暂存 main.tex 的修改。编译成功，但 PDF 页面渲染服务失败，尚未检查排版图像。');
    });
  });
  await new Promise(resolve => llm.listen(0, '127.0.0.1', resolve));
});

after(async () => {
  llm.closeAllConnections(); await new Promise(resolve => llm.close(resolve));
  dbModule.resetDb();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  fs.rmSync(temp, { recursive: true, force: true });
});

async function run(scenario) {
  mode = scenario; requests = 0; payloads = [];
  const quotaBlocked = ['quota', 'bad-handoff', 'tool-handoff'].includes(scenario);
  const uid = db.prepare(`INSERT INTO users(username,password_hash,role,compile_seconds_quota,compile_seconds_used,compile_reset_date)
    VALUES(?,'unused','user',300,?,?)`).run('handoff-' + ++serial, quotaBlocked ? 300 : 0, new Date().toISOString().slice(0, 10)).lastInsertRowid;
  db.prepare('INSERT INTO settings(user_id,agent_config,chinese_support) VALUES(?,?,0)').run(uid,
    JSON.stringify({ graphOrchestration: false, allowWebAccess: false, confirmBeforeApply: false }));
  const pid = db.prepare('INSERT INTO projects(name,owner_id,public_id,compile_engine) VALUES(?,?,?,?)')
    .run('Handoff fixture', uid, randomUUID(), scenario === 'unavailable' ? 'xelatex' : 'pdflatex').lastInsertRowid;
  const cid = db.prepare('INSERT INTO chats(project_id,user_id) VALUES(?,?)').run(pid, uid).lastInsertRowid;
  const dir = path.join(dataDir, 'projects', String(pid)); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'main.tex'), original);
  const markers = path.join(temp, 'markers-' + serial); fs.mkdirSync(markers);
  process.env.CORELATEX_HANDOFF_MARKERS = markers;
  const events = [];
  const result = await runAgent({
    user: db.prepare('SELECT * FROM users WHERE id=?').get(uid),
    project: db.prepare('SELECT * FROM projects WHERE id=?').get(pid),
    chat: db.prepare('SELECT * FROM chats WHERE id=?').get(cid),
    messages: [{ role: 'user', content: '请把 main.tex 中的 Original text. 修改为 Revised text.，然后编译验证。' }],
    modelConfig: { provider: 'openai', model: 'handoff-mock', apiKey: 'synthetic', baseUrl: 'http://127.0.0.1:' + llm.address().port + '/v1', maxTokens: 1024, contextLength: 100000 },
    emit: event => events.push(event),
  });
  const row = db.prepare('SELECT * FROM chat_messages WHERE id=?').get(result.messageId);
  return { result, row, steps: JSON.parse(row.steps), events, dir, markers };
}

const handoffRequests = () => payloads.filter(p => p.messages.some(m => m.role === 'user' && typeof m.content === 'string' && m.content.includes('【执行受阻交接】')));
const graphOf = f => f.steps.find(s => s.type === 'workflow').graph;
function assertPending(f, code) {
  assert.equal(f.result.status, 'failed');
  assert.equal(f.result.changeset.status, 'pending');
  assert.equal(f.result.changeset.applied, false);
  assert.equal(fs.readFileSync(path.join(f.dir, 'main.tex'), 'utf8'), original);
  assert.equal(f.steps.filter(s => s.type === 'tool' && s.name === 'compile_and_preview').length, 1);
  const handoffs = handoffRequests();
  assert.equal(handoffs.length, 1, 'one explanation request instead of repeated validation corrections');
  assert.equal(handoffs[0].tools?.length || 0, 0, 'the explanation request cannot execute tools');
  const prompt = handoffs[0].messages.filter(m => m.role === 'user').at(-1).content;
  assert.match(prompt, new RegExp(code));
  assert.match(prompt, /草稿将保留待审，未自动应用/);
  assert.match(prompt, /main\.tex/);
  const verify = graphOf(f).nodes.find(n => n.id === 'verify');
  assert.equal(verify.status, 'failed'); assert.equal(verify.blocked, true); assert.equal(verify.code, code);
  assert.doesNotMatch(f.row.content, /已达到.*(?:上限|纠正)|已尝试.*(?:两|2)次|补充执行机会/);
  assert.equal(f.events.at(-1).state, 'failed');
}

test('quota exhaustion after staged edit hands off once with concrete facts and keeps the draft unapplied', async () => {
  const f = await run('quota');
  assertPending(f, 'COMPILE_QUOTA_EXHAUSTED');
  assert.equal(requests, 4);
  assert.equal(fs.existsSync(path.join(f.markers, 'compiles')), false, 'quota blocks before an engine runs');
  assert.match(f.row.content, /今日编译额度已用完/);
  assert.match(f.row.content, /管理员补充今日额度/);
  assert.match(f.row.content, /无需重做/);
  assert.doesNotMatch(f.row.content, /主智能体未能生成/);
  assert.ok(f.events.some(e => e.type === 'activity' && e.phase === 'blocked' && e.code === 'COMPILE_QUOTA_EXHAUSTED'));
});

test('unavailable compiler produces a tool-free environment handoff without pretending LaTeX correction was exhausted', async () => {
  const f = await run('unavailable');
  assertPending(f, 'COMPILER_UNAVAILABLE');
  assert.equal(requests, 4);
  assert.match(f.row.content, /编译引擎无法启动/);
  assert.match(f.row.content, /恢复编译引擎/);
  assert.doesNotMatch(f.row.content, /主智能体未能生成|编译验证仍失败/);
});

test('a misleading handoff cannot claim compilation or application success and gets factual fallback', async () => {
  const f = await run('bad-handoff');
  assertPending(f, 'COMPILE_QUOTA_EXHAUSTED');
  assert.equal(requests, 4);
  assert.match(f.row.content, /主智能体未能生成有效的收尾说明/);
  assert.match(f.row.content, /已保留 1 个文件的修改草稿/);
  assert.doesNotMatch(f.row.content, /编译成功|修改已应用到项目/);
});

test('PDF preview failure retains successful compile proof and does not enter a source repair or quota handoff', async () => {
  const f = await run('preview-failed');
  assert.equal(requests, 4);
  assert.equal(handoffRequests().length, 0);
  assert.equal(f.result.status, 'completed');
  assert.equal(f.result.changeset.applied, true);
  assert.match(fs.readFileSync(path.join(f.dir, 'main.tex'), 'utf8'), /Revised text\./);
  assert.equal(fs.readFileSync(path.join(f.markers, 'compiles'), 'utf8').trim().split('\n').length, 1);
  const compile = f.steps.find(s => s.type === 'tool' && s.name === 'compile_and_preview');
  assert.equal(compile.status, 'error');
  assert.match(compile.result, /PDF 渲染失败/);
  assert.equal(graphOf(f).nodes.find(n => n.id === 'verify').status, 'completed');
  assert.match(f.row.content, /编译成功/);
  assert.match(f.row.content, /尚未检查排版图像/);
  assert.doesNotMatch(f.row.content, /完成声明尚无|编译验证仍失败|主智能体未能生成/);
});

test('a provider emitting a tool during the tool-free handoff cannot write or start another compile', async () => {
  const f = await run('tool-handoff');
  assertPending(f, 'COMPILE_QUOTA_EXHAUSTED');
  assert.equal(requests, 4);
  assert.equal(fs.existsSync(path.join(f.dir, 'forbidden.txt')), false);
  assert.equal(fs.existsSync(path.join(f.markers, 'compiles')), false);
  assert.match(f.row.content, /主智能体未能生成有效的收尾说明/);
});

test('failure to snapshot a successfully compiled PDF does not become a compiler-unavailable blocker', async () => {
  const copy = fs.copyFileSync;
  const hook = mock.method(fs, 'copyFileSync', (source, dest, ...args) => {
    if (String(source).endsWith('.pdf') && path.basename(String(dest)) === 'document.pdf') {
      const error = new Error('snapshot fixture permission denied'); error.code = 'EACCES'; throw error;
    }
    return copy(source, dest, ...args);
  });
  try {
    const f = await run('snapshot-failed');
    assert.equal(fs.readFileSync(path.join(f.markers, 'compiles'), 'utf8').trim().split('\n').length, 1);
    assert.equal(handoffRequests().length, 0, 'a failed PDF copy cannot erase successful compilation proof');
    assert.equal(graphOf(f).nodes.find(n => n.id === 'verify').status, 'completed');
    assert.match(f.row.content, /保存 PDF 预览快照失败/);
    assert.doesNotMatch(f.row.content, /编译引擎无法启动|COMPILER_UNAVAILABLE/);
  } finally { hook.mock.restore(); }
});

test('missing required compilation exhausts bounded correction then receives one truthful model handoff', async () => {
  const f = await run('missing-compile');
  assert.equal(f.result.status, 'failed');
  assert.equal(f.result.changeset.status, 'pending');
  assert.equal(f.result.changeset.applied, false);
  assert.equal(fs.readFileSync(path.join(f.dir, 'main.tex'), 'utf8'), original);
  assert.equal(f.steps.filter(s => s.type === 'tool' && s.name === 'compile_and_preview').length, 0);
  assert.equal(fs.existsSync(path.join(f.markers, 'compiles')), false);
  const handoffs = handoffRequests();
  assert.equal(handoffs.length, 1);
  assert.equal(handoffs[0].tools?.length || 0, 0);
  assert.equal(requests, 6, 'two correction requests, then one explanation request');
  const prompt = handoffs[0].messages.filter(m => m.role === 'user').at(-1).content;
  assert.match(prompt, /最新的正式排版文件尚未验证/);
  assert.match(prompt, /"limitReached":true/);
  assert.match(f.row.content, /本轮没有实际执行编译/);
  assert.match(f.row.content, /下一步需要对现有草稿执行编译验证/);
  assert.doesNotMatch(f.row.content, /主智能体未能生成|编译成功|已应用到项目|编译额度已用完/);
  assert.equal(graphOf(f).status, 'failed');
  assert.equal(graphOf(f).nodes.find(n => n.id === 'verify').status, 'failed');
});
