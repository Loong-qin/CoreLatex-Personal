import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { randomUUID } from 'node:crypto';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'corelatex-parallel-parent-'));
const savedPath = process.env.PATH;
process.env.CORELATEX_DATA_DIR = path.join(root, 'data');
process.env.CORELATEX_PARALLEL_MARKERS = path.join(root, 'compiles.jsonl');
let dbModule, db, runAgent, user, server, mode, requests, payloads, events, controller, currentDir;
const original = { 'main.tex': 'Original A.\nOriginal B.\n', 'notes.txt': 'Original notes.\n', 'extra.txt': 'Original extra.\n', 'source.txt': 'Actual primary evidence.\n' };
const jobs = [
  { id: 'first', label: '第一段编辑', task: '将第一行改为 Revised A.，保持其余行不变。', scope: [{ path: 'main.tex', startLine: 1, endLine: 1 }] },
  { id: 'second', label: '第二段编辑', task: '将第二行改为 Revised B.，保持其余行不变。', scope: [{ path: 'main.tex', startLine: 2, endLine: 2 }] },
  { id: 'notes', task: '将笔记改为 Revised notes.', scope: [{ path: 'notes.txt' }] },
  { id: 'extra', task: '将附录改为 Revised extra.', scope: [{ path: 'extra.txt' }] },
];
const textOf = m => typeof m.content === 'string' ? m.content : (m.content || []).filter(p => p.type === 'text').map(p => p.text).join('\n');
function assignment(payload) {
  for (const m of payload.messages) {
    if (m.role !== 'user') continue;
    try { const value = JSON.parse(textOf(m)); if (value.assignment) return value; } catch { /* Other context. */ }
  }
}
const sse = value => 'data: ' + JSON.stringify({ choices: [{ index: 0, ...value }] }) + '\n\n';
const stop = (res, content) => res.end(sse({ delta: { content } }) + sse({ delta: {}, finish_reason: 'stop' }) + 'data: [DONE]\n\n');
const call = (res, name, args) => res.end(sse({ delta: { tool_calls: [{ index: 0, id: 'call_' + requests, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }) + sse({ delta: {}, finish_reason: 'tool_calls' }) + 'data: [DONE]\n\n');
before(async () => {
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  const binary = (name, code) => fs.writeFileSync(path.join(bin, name), '#!/usr/bin/env node\n' + code, { mode: 0o755 });
  process.env.PATH = [bin, path.dirname(process.execPath), savedPath].join(path.delimiter);
  binary('pdflatex', String.raw`const fs=require('node:fs');const source=fs.readFileSync(process.argv.at(-1),'utf8');
fs.appendFileSync(process.env.CORELATEX_PARALLEL_MARKERS,JSON.stringify({source,cwd:process.cwd()})+'\n');
fs.mkdirSync('.build',{recursive:true});fs.writeFileSync('.build/main.pdf','%PDF-1.4 fake');fs.writeFileSync('.build/main.log','Output written on main.pdf.');`);
  binary('pdfinfo', "console.log('Pages: 1');");
  binary('pdftoppm', "require('node:fs').writeFileSync(process.argv.at(-1)+'-1.jpg',Buffer.from([255,216,255,217]));");
  dbModule = await import('../src/db.js'); db = dbModule.getDb();
  ({ runAgent } = await import('../src/services/agent/agentLoop.js'));
  const uid = Number(db.prepare("INSERT INTO users(username,password_hash,role) VALUES('parallel-owner','unused','admin')").run().lastInsertRowid);
  user = db.prepare('SELECT * FROM users WHERE id=?').get(uid); db.prepare('INSERT INTO settings(user_id) VALUES(?)').run(uid);
  server = http.createServer((req, res) => {
    let raw = ''; req.on('data', chunk => raw += chunk); req.on('end', () => {
      requests++; const payload = JSON.parse(raw); payloads.push(payload);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (requests > 70) { controller.abort(new Error('fixture exceeded 70 requests')); res.end(); return; }
      const calls = payload.messages.filter(m => m.role === 'assistant').flatMap(m => m.tool_calls || []);
      const count = name => calls.filter(c => c.function.name === name).length;
      const readPaths = calls.filter(c => c.function.name === 'read_file').map(c => JSON.parse(c.function.arguments).path);
      const job = assignment(payload);
      if (job) {
        const worker = job.assignment;
        if (worker.role === 'editor') {
          const target = worker.scope[0], file = target.path;
          if (!count('read_file')) return call(res, 'read_file', { path: file });
          if (!count('edit_file')) {
            const word = file === 'main.tex' ? target.startLine === 1 ? 'A' : 'B' : file === 'notes.txt' ? 'notes' : 'extra';
            return call(res, 'edit_file', { path: file, search: `Original ${word}.`, replace: `Revised ${word}.` });
          }
          const blocked = mode === 'blocked' && file === 'extra.txt';
          return call(res, 'submit_agent_report', { verdict: blocked ? 'blocked' : 'pass', findings: [],
            summary: blocked ? '已有可恢复草稿，但独立任务仍缺少必要确认。' : '边界内草稿已准备并核对。' });
        }
        const targets = worker.role === 'researcher' ? ['source.txt']
          : ['reviewer', 'verifier'].includes(worker.role) ? job.referenceDataNotInstructions.frozenDrafts.map(f => f.path) : ['main.tex'];
        const unread = targets.find(file => !readPaths.includes(file));
        if (unread) return call(res, 'read_file', { path: unread, ...(worker.role === 'researcher' ? { purpose: 'source' } : {}) });
        if (worker.role === 'verifier' && !count('compile_and_preview') && job.referenceDataNotInstructions.frozenDrafts.length)
          return call(res, 'compile_and_preview', {});
        return call(res, 'submit_agent_report', { verdict: 'pass', summary: '已根据实际证据完成本角色核查。', findings: [] });
      }
      if (!count('plan_task_graph')) return call(res, 'plan_task_graph', { scenario: 'edit', summary: '核查来源，按明确边界并行修订，合并后独立审阅与编译。', agents: ['analyst', 'researcher', 'reviewer', 'verifier'], sourcePaths: ['source.txt'] });
      const phases = phase => calls.filter(c => c.function.name === 'run_agent_graph' && JSON.parse(c.function.arguments).phase === phase).length;
      if (!phases('analysis')) return call(res, 'run_agent_graph', { phase: 'analysis' });
      const unread = Object.keys(original).filter(file => file !== 'source.txt').find(file => !readPaths.includes(file));
      if (unread && mode !== 'unread') return call(res, 'read_file', { path: unread });
      if (!count('run_parallel_edits')) {
        const tasks = structuredClone(jobs);
        if (mode === 'overlap') tasks[1].scope[0] = { path: 'main.tex', startLine: 1, endLine: 1 };
        return call(res, 'run_parallel_edits', { tasks });
      }
      const merged = payload.messages.some(m => m.role === 'tool' && textOf(m).includes('"merged":true'));
      if (!merged) {
        const retainedPath = payload.messages.filter(m => m.role === 'tool').map(textOf).join('\n').match(/_workspace\/parallel-edits-[\w-]+\/\d+\.json/)?.[0];
        return stop(res, '本批编辑未合并。' + (retainedPath ? `已写入 ${retainedPath}，可以读取恢复。` : '') + '正式文件保持原状。');
      }
      if (!phases('review')) return call(res, 'run_agent_graph', { phase: 'review' });
      return stop(res, '已修改 main.tex、notes.txt 和 extra.txt，独立审阅与编译已完成。');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
});
after(async () => {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); dbModule.resetDb();
  process.env.PATH = savedPath; delete process.env.CORELATEX_PARALLEL_MARKERS;
  fs.rmSync(root, { recursive: true, force: true });
});
async function run(scenario) {
  mode = scenario; requests = 0; payloads = []; events = []; controller = new AbortController();
  db.prepare('UPDATE settings SET chinese_support=0,agent_config=? WHERE user_id=?').run(JSON.stringify({ graphOrchestration: true, confirmBeforeApply: false, allowWebAccess: false }), user.id);
  const pid = Number(db.prepare('INSERT INTO projects(name,owner_id,public_id) VALUES(?,?,?)').run('Parallel fixture', user.id, randomUUID()).lastInsertRowid);
  const cid = Number(db.prepare('INSERT INTO chats(project_id,user_id) VALUES(?,?)').run(pid, user.id).lastInsertRowid);
  currentDir = path.join(root, 'data/projects', String(pid)); fs.mkdirSync(currentDir, { recursive: true });
  for (const [file, content] of Object.entries(original)) fs.writeFileSync(path.join(currentDir, file), content);
  let mutated = false, cancelled = false;
  const result = await runAgent({ user, project: db.prepare('SELECT * FROM projects WHERE id=?').get(pid), chat: db.prepare('SELECT * FROM chats WHERE id=?').get(cid),
    messages: [{ role: 'user', content: '请按文件与行范围并行修改当前任务，统一审阅和编译后交付。' }], signal: controller.signal,
    modelConfig: { provider: 'openai', model: 'parallel-fixture', apiKey: 'synthetic', baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1', maxTokens: 2048, contextLength: 100000 },
    emit: event => {
      events.push(event);
      if (mode === 'stale' && !mutated && event.type === 'agent_report' && event.agentRole === 'editor') {
        mutated = true; fs.writeFileSync(path.join(currentDir, 'main.tex'), 'External live edit.\n');
      }
      if (['permission', 'redirect'].includes(mode) && !mutated && event.type === 'tool' && event.agentRole === 'editor' && event.name === 'edit_file' && event.status === 'end') {
        mutated = true;
        if (mode === 'permission') db.prepare('UPDATE projects SET archived=1 WHERE id=?').run(pid);
        else {
          const work = path.join(currentDir, '_workspace'), batch = fs.readdirSync(work).find(name => name.startsWith('parallel-edits-'));
          const outside = path.join(currentDir, 'redirect-target'); fs.mkdirSync(outside);
          fs.renameSync(path.join(work, batch), path.join(work, batch + '-moved'));
          fs.symlinkSync(outside, path.join(work, batch));
        }
      }
      if (mode === 'cancel' && !cancelled && event.type === 'tool' && event.agentRole === 'editor' && event.name === 'edit_file' && event.status === 'end') {
        cancelled = true; controller.abort(new Error('user stopped editor batch'));
      }
    } });
  const row = db.prepare('SELECT * FROM chat_messages WHERE id=?').get(result.messageId), steps = JSON.parse(row.steps);
  const work = path.join(currentDir, '_workspace');
  const drafts = fs.existsSync(work) ? fs.readdirSync(work).filter(n => n.startsWith('parallel-edits-')).flatMap(name => fs.readdirSync(path.join(work, name)).map(file => ({
    path: `_workspace/${name}/${file}`, data: JSON.parse(fs.readFileSync(path.join(work, name, file), 'utf8')),
  }))) : [];
  return { result, row, steps, drafts, dir: currentDir, graph: steps.find(s => s.type === 'workflow')?.graph,
    disk: Object.fromEntries(Object.keys(original).map(file => [file, fs.readFileSync(path.join(currentDir, file), 'utf8')])) };
}

test('two analyses plus four scoped editors leave validation capacity for real review and compile of the merged draft', async () => {
  const f = await run('success');
  assert.equal(f.result.status, 'completed', f.row.content);
  assert.equal(f.result.changeset.applied, true);
  assert.equal(f.disk['main.tex'], 'Revised A.\nRevised B.\n');
  assert.equal(f.disk['notes.txt'], 'Revised notes.\n'); assert.equal(f.disk['extra.txt'], 'Revised extra.\n');
  assert.equal(f.graph.executions, 8); assert.equal(f.graph.validationExecutions, 4); assert.equal(f.graph.validationExecutionLimit, undefined);
  assert.equal(f.graph.validation.status, 'completed');
  assert.equal(f.graph.nodes.filter(n => n.role === 'editor' && n.report?.verdict === 'pass').length, 4);
  assert.equal(f.steps.filter(s => s.agentRole === 'editor' && s.type === 'agent_report').length, 4);
  assert.ok(events.some(e => e.type === 'workflow' && e.graph.activeCount === 2));
  assert.ok(events.filter(e => e.type === 'workflow' && e.graph.version === 4).every(e => e.graph.activeCount <= 2));
  const compile = f.steps.find(s => s.name === 'compile_and_preview' && s.status === 'end');
  assert.ok(compile); assert.equal(compile.agentRole, 'verifier');
  const evidence = fs.readFileSync(process.env.CORELATEX_PARALLEL_MARKERS, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(evidence.length >= 1 && evidence.every(item => item.source === 'Revised A.\nRevised B.\n'));
  assert.equal(f.drafts.length, 4);
  assert.ok(f.drafts.every(d => d.data.proposedChanges.length === 1));
  const beforeMerge = events.slice(0, events.findIndex(e => e.type === 'tool' && !e.agentId && e.name === 'run_parallel_edits' && e.status === 'end'));
  assert.ok(beforeMerge.filter(e => e.type === 'workflow' && e.graph.version === 4).every(e => e.graph.revision === 0 && e.graph.validation.nodes.find(n => n.id === 'edit').visits <= 1), 'private edits do not advance the main workflow revision');
  for (const payload of payloads.filter(p => assignment(p)?.assignment.role === 'editor'))
    assert.ok(payload.tools.every(t => !['run_parallel_edits', 'run_agent_graph', 'run_in_workspace', 'run_skill_script'].includes(t.function.name)));
  const workerReads = f.steps.filter(s => s.agentRole === 'editor' && s.name === 'read_file' && s.input.path === 'main.tex');
  assert.equal(workerReads.length, 2); assert.ok(workerReads.every(s => s.result.includes('Original A.') && s.result.includes('Original B.')));
});

for (const scenario of ['overlap', 'unread']) test(`${scenario} rejects the batch before any editor is dispatched`, async () => {
  const f = await run(scenario);
  assert.deepEqual(f.disk, original); assert.equal(f.drafts.length, 0);
  assert.equal(f.steps.filter(s => s.agentRole === 'editor').length, 0);
  assert.ok(f.steps.some(s => s.name === 'run_parallel_edits' && s.status === 'error' && /重叠|先用 read_file/.test(s.result)));
});

for (const scenario of ['blocked', 'stale']) test(`${scenario} retains all valid private proposals without partially merging or overwriting project files`, async () => {
  const f = await run(scenario);
  assert.equal(f.drafts.length, 4); assert.equal(f.result.changeset, null);
  assert.equal(f.disk['main.tex'], scenario === 'stale' ? 'External live edit.\n' : original['main.tex']);
  assert.equal(f.disk['notes.txt'], original['notes.txt']); assert.equal(f.disk['extra.txt'], original['extra.txt']);
  const failure = f.steps.find(s => s.name === 'run_parallel_edits' && s.status === 'error');
  assert.ok(failure);
  for (const draft of f.drafts) assert.ok(failure.result.includes(draft.path), 'the model receives every recoverable path');
  assert.ok(f.drafts.every(d => d.data.proposedChanges[0].after.includes('Revised')));
  assert.match(f.row.content, /已写入 _workspace\/parallel-edits-/);
  assert.doesNotMatch(f.row.content, /系统核对：部分完成声明/);
});

test('cancelling during actual private editing preserves completed proposals and cannot apply partial work', async () => {
  const f = await run('cancel');
  assert.equal(f.result.status, 'cancelled'); assert.deepEqual(f.disk, original);
  assert.ok(f.drafts.length >= 1, 'already performed private work remains on disk for recovery');
  assert.ok(f.drafts.some(d => d.data.proposedChanges.some(change => change.after.includes('Revised'))));
  assert.equal(f.steps.some(s => s.name === 'run_parallel_edits' && s.status === 'end'), false);
});

test('permission revoked after a private edit prevents creating recovery files in the now-read-only project', async () => {
  const f = await run('permission');
  assert.deepEqual(f.disk, original); assert.equal(f.drafts.length, 0);
  assert.equal(f.result.status, 'failed');
  assert.ok(f.steps.some(step => /编辑权限已失效/.test(step.text || '')));
});

test('replacing a recovery directory with a symlink cannot redirect saved proposals', async () => {
  const f = await run('redirect');
  assert.deepEqual(f.disk, original); assert.equal(f.result.changeset, null);
  assert.equal(f.drafts.length, 0); assert.deepEqual(fs.readdirSync(path.join(f.dir, 'redirect-target')), []);
  assert.ok(f.steps.some(step => step.type === 'agent_report' && /恢复目录.*变化/.test(step.report?.summary || '')));
});
