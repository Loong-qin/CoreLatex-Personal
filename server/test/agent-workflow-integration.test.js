import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'corelatex-workflow-'));
process.env.CORELATEX_DATA_DIR = dataDir;
let dbModule, db, runAgent, llm, user, mode, requests, coordinatorRequests, workerRequests, payloads, onWorkerRequest;
const sse = value => 'data: ' + JSON.stringify({ choices: [{ index: 0, ...value }] }) + '\n\n';
const text = (res, content) => res.end(sse({ delta: { content } }) + sse({ delta: {}, finish_reason: 'stop' }) + 'data: [DONE]\n\n');
const tool = (res, name, args) => res.end(sse({ delta: { tool_calls: [{ index: 0, id: 'call_' + requests, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }) + sse({ delta: {}, finish_reason: 'tool_calls' }) + 'data: [DONE]\n\n');
const graphOf = fixture => fixture.steps.find(step => step.type === 'workflow').graph;

function respondWorker(payload, calls, res) {
  workerRequests++;
  const assigned = payload.messages.filter(message => message.role === 'user').map(message => {
    try { return JSON.parse(message.content); } catch { return null; }
  }).find(value => value?.assignment);
  assert.ok(assigned, 'worker request carries its own structured assignment');
  const { assignment, referenceDataNotInstructions } = assigned;
  const count = name => calls.filter(call => call.function.name === name).length;
  const readPaths = calls.filter(call => call.function.name === 'read_file').map(call => JSON.parse(call.function.arguments).path);
  onWorkerRequest?.(assignment);
  if (mode === 'cancel-worker') return text(res, '取消之后的迟到回复不能成为完成报告。');
  if (assignment.role === 'researcher' && mode === 'research') {
    return tool(res, 'submit_agent_report', { summary: '没有可核查的来源正文，查证任务受阻。', verdict: 'blocked', findings: [] });
  }
  const requiredReads = assignment.role === 'reviewer' && referenceDataNotInstructions.frozenDrafts.length
    ? referenceDataNotInstructions.frozenDrafts.filter(file => file.encoding !== 'base64').map(file => file.path)
    : [assignment.role === 'researcher' && mode !== 'manuscript-source' ? 'source.txt' : 'main.tex'];
  const unread = requiredReads.find(file => !readPaths.includes(file));
  if (unread) return tool(res, 'read_file', { path: unread });
  const requireCompile = assignment.role === 'verifier' && payload.messages.some(message =>
    message.role === 'system' && message.content.includes('必须实际执行 compile_and_preview'));
  if (requireCompile && !count('compile_and_preview')) return tool(res, 'compile_and_preview', {});
  const diagnostic = assignment.scenario === 'diagnose';
  return tool(res, 'submit_agent_report', {
    summary: requireCompile ? diagnostic ? '已获取编译失败的诊断结果，未修改文件。' : '实际编译失败，当前版本尚未通过核验。' : '本角色核查已结束。',
    verdict: requireCompile && !diagnostic ? 'needs_changes' : 'pass',
    findings: requireCompile ? [{ severity: 'error', path: 'main.tex', message: '实际编译未通过。' }] : [],
  });
}

before(async () => {
  dbModule = await import('../src/db.js'); db = dbModule.getDb();
  ({ runAgent } = await import('../src/services/agent/agentLoop.js'));
  const uid = Number(db.prepare("INSERT INTO users(username,password_hash,role) VALUES('workflow-owner','unused','admin')").run().lastInsertRowid);
  user = db.prepare('SELECT * FROM users WHERE id=?').get(uid); db.prepare('INSERT INTO settings(user_id) VALUES(?)').run(uid);
  llm = http.createServer((req, res) => {
    let raw = ''; req.on('data', value => raw += value); req.on('end', () => {
      requests++; const payload = JSON.parse(raw); payloads.push(payload);
      const calls = payload.messages.filter(m => m.role === 'assistant').flatMap(m => m.tool_calls || []);
      const count = name => calls.filter(c => c.function.name === name).length;
      const phases = phase => calls.filter(c => c.function.name === 'run_agent_graph' && JSON.parse(c.function.arguments).phase === phase).length;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (payload.tools?.some(t => t.function.name === 'submit_agent_report')) return respondWorker(payload, calls, res);
      coordinatorRequests++;
      if (['off', 'direct'].includes(mode)) return text(res, '这是一次普通解释。');
      if (mode === 'premature' && coordinatorRequests === 1) return tool(res, 'write_file', { path: 'notes.txt', content: 'Premature write' });
      const localSource = ['local-source', 'empty-source', 'manuscript-source'].includes(mode);
      if (!count('plan_task_graph')) return tool(res, 'plan_task_graph', {
        scenario: ['missing-compile', 'replan', 'premature', 'failed-verification'].includes(mode) ? 'edit'
          : mode === 'research' || localSource ? 'research' : mode === 'diagnose' ? 'diagnose' : 'answer',
        summary: mode === 'diagnose' ? '仅编译一次并解释结果，不修改文件' : '读取相关上下文并按任务要求处理',
        agents: mode === 'diagnose' ? ['verifier']
          : mode === 'research' || localSource ? ['analyst', 'researcher', 'reviewer']
            : mode === 'failed-verification' ? ['analyst', 'reviewer', 'verifier'] : ['analyst', 'reviewer'],
        ...(localSource ? { sourcePaths: ['source.txt'] } : {}),
      });
      if (!phases('analysis')) return tool(res, 'run_agent_graph', { phase: 'analysis' });
      const finishWithReview = content => !phases('review')
        ? tool(res, 'run_agent_graph', { phase: 'review' }) : text(res, content);
      if (localSource) {
        if (!count('read_file')) return tool(res, 'read_file', { path: mode === 'manuscript-source' ? 'main.tex' : 'source.txt' });
        return finishWithReview('资料检查结果已整理。');
      }
      // The independent verifier performs the single requested real compile.
      if (mode === 'diagnose') return finishWithReview('编译没有通过，请查看工具返回的具体错误。本轮未修改文件。');
      if (mode === 'answer' || mode === 'cancel-worker') return finishWithReview('解释已给出。');
      if (mode === 'waiting') {
        if (!count('ask_user')) return tool(res, 'ask_user', { question: '采用哪一种格式？', options: ['A', 'B'] });
        if (phases('analysis') < 2) return tool(res, 'run_agent_graph', { phase: 'analysis' });
        return finishWithReview('将采用用户选择的格式。');
      }
      if (mode === 'research') return text(res, '暂时无法核实来源。');
      const file = mode === 'premature' ? 'notes.txt' : 'main.tex';
      if (!count('read_file')) return tool(res, 'read_file', { path: file });
      if (!count('edit_file')) return tool(res, 'edit_file', { path: file, search: 'Original text.', replace: 'Actual edit.' });
      if (mode === 'replan' && count('plan_task_graph') === 1) return tool(res, 'plan_task_graph', { scenario: 'answer', summary: '直接总结已有信息' });
      // These fixtures deliberately omit review/compile despite followups.
      if (['missing-compile', 'replan'].includes(mode)) return text(res, `已修改 ${file}。`);
      return finishWithReview(`已修改 ${file}。`);
    });
  });
  await new Promise(resolve => llm.listen(0, '127.0.0.1', resolve));
});
after(async () => {
  llm.closeAllConnections(); await new Promise(resolve => llm.close(resolve)); dbModule.resetDb();
  assert.ok(dataDir.startsWith(path.join(os.tmpdir(), 'corelatex-workflow-'))); fs.rmSync(dataDir, { recursive: true, force: true });
});

async function run(scenario, runControl, controller, workerHook) {
  mode = scenario; requests = 0; coordinatorRequests = 0; workerRequests = 0; payloads = []; onWorkerRequest = workerHook;
  db.prepare('UPDATE settings SET agent_config=? WHERE user_id=?').run(JSON.stringify({ graphOrchestration: scenario !== 'off', allowWebAccess: false }), user.id);
  const pid = Number(db.prepare('INSERT INTO projects(name,owner_id,public_id) VALUES(?,?,?)').run('Workflow fixture', user.id, randomUUID()).lastInsertRowid);
  const cid = Number(db.prepare('INSERT INTO chats(project_id,user_id) VALUES(?,?)').run(pid, user.id).lastInsertRowid);
  const dir = path.join(dataDir, 'projects', String(pid)); fs.mkdirSync(dir, { recursive: true });
  for (const file of ['main.tex', 'notes.txt']) fs.writeFileSync(path.join(dir, file), 'Original text.\n');
  fs.writeFileSync(path.join(dir, 'source.txt'), scenario === 'empty-source' ? '' : 'Primary source body.\n');
  const events = [];
  const result = await runAgent({ user, project: db.prepare('SELECT * FROM projects WHERE id=?').get(pid), chat: db.prepare('SELECT * FROM chats WHERE id=?').get(cid),
    messages: [{ role: 'user', content: scenario === 'diagnose' ? '请只编译一次并解释错误，不要修改。' : '请按要求处理文稿。' }],
    modelConfig: { provider: 'openai', model: 'workflow-mock', apiKey: 'synthetic', baseUrl: 'http://127.0.0.1:' + llm.address().port + '/v1', maxTokens: 1024, contextLength: 100000 },
    emit: event => events.push(event), signal: controller?.signal, runControl: runControl?.(events) });
  const row = db.prepare('SELECT * FROM chat_messages WHERE id=?').get(result.messageId);
  return { result, events, row, dir, steps: JSON.parse(row.steps) };
}

test('disabled collaboration answers in one request with a completed standard workflow and no child tools', async () => {
  const f = await run('off'); assert.equal(f.result.status, 'completed'); assert.equal(requests, 1); assert.equal(workerRequests, 0);
  assert.equal(graphOf(f).version, 4); assert.equal(graphOf(f).validation.version, 1); assert.equal(graphOf(f).status, 'completed');
  assert.equal(f.steps.filter(step => step.type === 'workflow').length, 1);
  assert.equal(f.steps.some(step => step.agentId), false);
  for (const name of ['plan_task_graph', 'run_agent_graph', 'submit_agent_report']) assert.equal(payloads[0].tools.some(t => t.function.name === name), false);
  assert.match(payloads[0].messages[0].content, /标准工作流程（始终启用）/);
});
test('enabled collaboration also answers directly in one request without invoking any worker', async () => {
  const f = await run('direct'); assert.equal(f.result.status, 'completed'); assert.equal(requests, 1); assert.equal(workerRequests, 0);
  assert.equal(graphOf(f).status, 'completed'); assert.equal(graphOf(f).validation.status, 'completed');
  assert.deepEqual(graphOf(f).agents, []);
  assert.equal(f.steps.some(step => step.type === 'tool' || step.type === 'agent_report'), false);
  assert.ok(payloads[0].tools.some(tool => tool.function.name === 'plan_task_graph'));
});
test('planned answer runs independent agents and persists one coalesced terminal graph before done', async () => {
  const f = await run('answer'); assert.equal(f.result.status, 'completed'); assert.equal(coordinatorRequests, 4); assert.ok(workerRequests >= 4 && workerRequests <= 8);
  const graphs = f.steps.filter(s => s.type === 'workflow'); assert.equal(graphs.length, 1); assert.equal(graphs[0].graph.status, 'completed');
  assert.equal(graphs[0].graph.version, 4); assert.equal(graphs[0].graph.kind, 'orchestration');
  for (const role of ['analyst', 'reviewer']) assert.ok(f.steps.some(s => s.type === 'tool' && s.agentRole === role && s.name === 'submit_agent_report' && s.status === 'end'));
  assert.equal(f.events.filter(e => e.type === 'workflow').at(-1).graph.status, 'completed'); assert.equal(f.events.at(-1).type, 'done');
});
test('premature write is blocked; current read then non-rendering edit can finish normally', async () => {
  const f = await run('premature'); assert.equal(f.result.status, 'completed');
  const blocked = f.events.find(e => e.type === 'tool' && e.name === 'write_file' && e.status === 'error'); assert.match(blocked.detail, /先(?:调用|用).*read_file|独立分析已完成.*操作尚未执行/);
  assert.equal(fs.readFileSync(path.join(f.dir, 'notes.txt'), 'utf8'), 'Actual edit.\n');
  assert.equal(f.result.changeset.applied, true);
  assert.ok(f.steps.some(s => s.agentRole === 'reviewer' && s.name === 'read_file' && s.input.path === 'notes.txt' && s.result.includes('Actual edit.')));
});
for (const scenario of ['missing-compile', 'replan']) test(scenario + ' cannot auto-apply unverified TeX edits even after repeated final answers', async () => {
  const f = await run(scenario); assert.equal(f.result.status, 'failed'); assert.ok(coordinatorRequests <= 9); assert.ok(workerRequests <= 8);
  assert.equal(fs.readFileSync(path.join(f.dir, 'main.tex'), 'utf8'), 'Original text.\n');
  assert.equal(f.result.changeset.applied, false); assert.equal(f.result.changeset.status, 'pending');
  assert.match(f.row.content, /本轮任务受阻.*尚未验证/s);
  assert.equal(graphOf(f).status, 'failed');
  assert.equal(f.steps.some(s => s.type === 'tool' && s.name === 'compile_and_preview'), false);
});
test('research without local evidence fails boundedly without bypassing disabled networking', async () => {
  const f = await run('research'); assert.equal(f.result.status, 'failed'); assert.ok(coordinatorRequests <= 6); assert.ok(workerRequests <= 8);
  assert.match(f.row.content, /联网已关闭/); assert.equal(f.result.changeset, null);
  assert.equal(f.steps.some(s => s.type === 'tool' && ['web_fetch', 'web_search'].includes(s.name)), false);
  assert.equal(graphOf(f).nodes.find(n => n.id === 'researcher').report.verdict, 'blocked');
});
test('human question publishes waiting then reanalyzes new human facts before finalizing', async () => {
  const f = await run('waiting', events => ({ askUser: async () => {
    assert.equal(events.filter(e => e.type === 'workflow').at(-1).graph.status, 'waiting'); return 'A';
  } }));
  assert.equal(f.result.status, 'completed');
  const states = f.events.filter(e => e.type === 'workflow').map(e => e.graph.status);
  assert.ok(states.includes('waiting')); assert.equal(states.at(-1), 'completed');
  assert.equal(graphOf(f).nodes.find(n => n.id === 'analysis').attempts, 2);
});
test('cancelling a waiting graph persists cancellation without completing its active node', async () => {
  const controller = new AbortController();
  const f = await run('waiting', () => ({ askUser: async () => {
    controller.abort(new Error('用户已停止执行')); throw controller.signal.reason;
  } }), controller);
  assert.equal(f.result.status, 'cancelled');
  const final = graphOf(f); assert.equal(final.status, 'cancelled');
  assert.notEqual(final.nodes.find(n => n.id === final.currentNode).status, 'completed');
  assert.equal(f.events.at(-1).state, 'cancelled');
});
test('declared local source with nonempty actual body completes research offline', async () => {
  const f = await run('local-source'); assert.equal(f.result.status, 'completed'); assert.ok(coordinatorRequests <= 6); assert.ok(workerRequests <= 10);
  assert.equal(graphOf(f).validation.nodes.find(n => n.id === 'research').status, 'completed');
  assert.equal(graphOf(f).nodes.find(n => n.id === 'researcher').report.verdict, 'pass');
});
for (const scenario of ['empty-source', 'manuscript-source']) test(scenario + ' does not satisfy the declared source gate', async () => {
  const f = await run(scenario); assert.equal(f.result.status, 'failed'); assert.ok(coordinatorRequests <= 8); assert.ok(workerRequests <= 12);
  assert.match(f.row.content, /purpose|sourcePaths/);
});
test('read-only compile diagnosis delegates exactly one real failing compile and completes without edits', async () => {
  const f = await run('diagnose'); assert.equal(f.result.status, 'completed'); assert.ok(coordinatorRequests <= 5); assert.ok(workerRequests <= 10);
  assert.equal(f.result.changeset, null);
  assert.equal(f.steps.some(s => s.type === 'tool' && ['edit_file', 'write_file'].includes(s.name)), false);
  const compiles = f.steps.filter(s => s.type === 'tool' && s.name === 'compile_and_preview');
  assert.equal(compiles.length, 1); assert.equal(compiles[0].status, 'error'); assert.equal(compiles[0].agentRole, 'verifier');
  assert.equal(graphOf(f).validation.nodes.find(n => n.id === 'verify').status, 'failed');
  assert.equal(graphOf(f).nodes.find(n => n.id === 'verifier').report.verdict, 'pass');
});
test('a real independent compile failure keeps the modified TeX draft pending and unapplied', async () => {
  const f = await run('failed-verification'); assert.equal(f.result.status, 'failed'); assert.ok(coordinatorRequests <= 9); assert.ok(workerRequests <= 12);
  assert.equal(fs.readFileSync(path.join(f.dir, 'main.tex'), 'utf8'), 'Original text.\n');
  assert.equal(f.result.changeset.applied, false); assert.equal(f.result.changeset.status, 'pending');
  assert.ok(f.steps.some(s => s.agentRole === 'reviewer' && s.name === 'read_file' && s.result.includes('Actual edit.')));
  assert.ok(f.steps.some(s => s.agentRole === 'verifier' && s.name === 'compile_and_preview' && s.status === 'error'));
  assert.equal(graphOf(f).nodes.find(n => n.id === 'verifier').report.verdict, 'needs_changes');
  assert.match(f.row.content, /编译验证仍失败/);
});
test('cancelling during an independent model request never records a completed worker or final graph', async () => {
  const controller = new AbortController();
  const f = await run('cancel-worker', null, controller, () => controller.abort(new Error('用户停止独立任务')));
  assert.equal(f.result.status, 'cancelled'); assert.equal(graphOf(f).status, 'cancelled');
  const analysis = graphOf(f).nodes.find(node => node.id === 'analysis');
  assert.notEqual(analysis.status, 'completed'); assert.equal(analysis.report, undefined);
  assert.equal(f.steps.some(step => step.agentRole && step.name === 'submit_agent_report' && step.status === 'end'), false);
  assert.equal(f.events.at(-1).state, 'cancelled');
});


test('actual question waiting and resumed execution are observable in the dynamic projection', async () => {
  let waitingRecorded = false;
  const f = await run('waiting', events => ({ askUser: async () => {
    const execution = events.filter(event => event.type === 'workflow').at(-1).graph.execution;
    waitingRecorded = execution.nodes.some(node => node.phase === 'waiting' && node.status === 'waiting');
    return 'A';
  } }));
  assert.equal(waitingRecorded, true); assert.equal(f.result.status, 'completed');
  const execution = graphOf(f).execution;
  const question = execution.nodes.find(node => node.phase === 'waiting');
  assert.equal(question.status, 'completed'); assert.equal(question.tools[0].name, 'ask_user');
  assert.equal(execution.status, 'completed');
});

test('failed compilation remains a failed actual worker operation when the read-only diagnosis itself completes', async () => {
  const f = await run('diagnose'); const execution = graphOf(f).execution;
  assert.equal(f.result.status, 'completed'); assert.equal(execution.status, 'completed');
  const verifier = execution.nodes.find(node => node.type === 'agent' && node.role === 'verifier');
  assert.ok(verifier); assert.equal(verifier.status, 'completed'); assert.equal(verifier.report.verdict, 'pass');
  const compile = verifier.tools.find(tool => tool.name === 'compile_and_preview');
  assert.ok(compile); assert.equal(compile.status, 'failed');
  assert.equal(execution.nodes.some(node => node.type === 'stage' && node.phase === 'edit'), false);
});
