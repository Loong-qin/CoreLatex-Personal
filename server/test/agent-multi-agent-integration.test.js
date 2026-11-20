import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { randomUUID } from 'node:crypto';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'corelatex-multi-integration-'));
process.env.CORELATEX_DATA_DIR = dataDir;
let dbModule, db, runAgent, user, server, mode, requests, payloads, events, controller, advanceClock;
const textOf = m => typeof m.content === 'string' ? m.content : (m.content || []).filter(p => p.type === 'text').map(p => p.text).join('\n');
const sse = value => 'data: ' + JSON.stringify({ choices: [{ index: 0, ...value }] }) + '\n\n';
const stop = (res, content) => res.end(sse({ delta: { content } }) + sse({ delta: {}, finish_reason: 'stop' }) + 'data: [DONE]\n\n');
const call = (res, name, args, inputTokens = 0) => res.end(sse({ delta: { tool_calls: [{ index: 0, id: 'call_' + requests, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }) +
  sse({ delta: {}, finish_reason: 'tool_calls' }) +
  (inputTokens ? 'data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: inputTokens, completion_tokens: 10, total_tokens: inputTokens + 10 } }) + '\n\n' : '') +
  'data: [DONE]\n\n');
const participantConflict = () => ({ severity: 'error', category: 'conflict', path: 'notes.txt', line: 1, side: 'after',
  message: '新增的 80 人与原始记录的 40 人冲突。', evidence: { source: 'notes.txt', quote: 'The study includes 40 participants.' } });
function scopedEdits(mode) {
  if (mode === 'whole-file-patch') return [{ path: 'notes.txt', search: 'Original introduction.\n\nOriginal methods.\n\nOriginal results.',
    replace: 'Revised introduction.\n\nRevised methods.\n\nRevised results.' }];
  if (!['bounded-batch', 'large-batch', 'consecutive-edits'].includes(mode)) return [];
  const lines = mode === 'bounded-batch' ? 10 : 13;
  return ['Methods', 'Results'].map(section => {
    const search = Array.from({ length: lines }, (_, index) => `${section} line ${index + 1}.`).join('\n');
    return { path: 'notes.txt', search, replace: search.replace(section, 'Revised ' + section.toLowerCase()) };
  });
}
function assignment(payload) {
  for (const message of payload.messages) {
    if (message.role !== 'user') continue;
    try { const job = JSON.parse(textOf(message)); if (job.assignment) return job; } catch { /* Only structured assignment is relevant. */ }
  }
}
before(async () => {
  dbModule = await import('../src/db.js'); db = dbModule.getDb();
  ({ runAgent } = await import('../src/services/agent/agentLoop.js'));
  const uid = Number(db.prepare("INSERT INTO users(username,password_hash,role) VALUES('multi-owner','unused','admin')").run().lastInsertRowid);
  user = db.prepare('SELECT * FROM users WHERE id=?').get(uid); db.prepare('INSERT INTO settings(user_id) VALUES(?)').run(uid);
  server = http.createServer((req, res) => {
    let raw = ''; req.on('data', chunk => raw += chunk); req.on('end', () => {
      requests++; const payload = JSON.parse(raw); payloads.push(payload);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (requests > 40) {
        controller.abort(new Error('Integration fixture exceeded 40 model requests without completion'));
        res.end(); return;
      }
      const calls = payload.messages.filter(m => m.role === 'assistant').flatMap(m => m.tool_calls || []);
      const count = name => calls.filter(c => c.function.name === name).length;
      const job = assignment(payload);
      if (job) {
        const highUsageRole = mode === 'analysis-high-tokens' ? 'analyst' : mode === 'review-high-tokens' ? 'reviewer' : null;
        if (job.assignment.role === highUsageRole) {
          // Each response fits the model context. Across genuine reads, actual
          // provider usage crosses both 80k and 200k before normal reporting.
          const inputByRead = [40000, 50000, 75000, 75000];
          if (!job.reportInstruction && count('read_file') < inputByRead.length)
            return call(res, 'read_file', { path: 'notes.txt' }, inputByRead[count('read_file')]);
          return call(res, 'submit_agent_report', { summary: '已读取实际内容并完成独立核查。', verdict: 'pass', findings: [] }, 10000);
        }
        const longRole = mode === 'analysis-long-investigation' ? 'analyst' : mode === 'review-long-investigation' ? 'reviewer' : null;
        if (job.assignment.role === longRole) {
          if (!job.reportInstruction && count('read_file') < 13) return call(res, 'read_file', { path: 'notes.txt' }, 1000);
          return call(res, 'submit_agent_report', { summary: '已在调查时限内完成实际核查。', verdict: 'pass', findings: [] }, 1000);
        }
        const timedRole = mode.startsWith('analysis-time-') ? 'analyst' : mode.startsWith('review-time-') ? 'reviewer' : null;
        if (job.assignment.role === timedRole) {
          if (!job.reportInstruction) {
            if (count('read_file') >= 2) {
              controller.abort(new Error('The next request at 600000ms must be report-only')); res.end(); return;
            }
            // Already-started work completes. A request at 599999ms can still
            // investigate, but the following request at exactly 600000ms reports.
            advanceClock(count('read_file') ? 1 : 599999);
            return call(res, 'read_file', { path: 'notes.txt' }, 1000);
          }
          const repaired = job.referenceDataNotInstructions?.frozenDrafts?.some(file => file.diff?.includes('+The study includes 40 participants in total.'));
          const verdict = mode.endsWith('-pass') || mode === 'review-time-needs-changes' && repaired ? 'pass'
            : mode === 'review-time-needs-changes' ? 'needs_changes' : 'blocked';
          const findings = verdict === 'needs_changes' ? [participantConflict()]
            : mode === 'review-time-error' ? [participantConflict()] : [];
          return call(res, 'submit_agent_report', { summary: verdict === 'pass' ? '已完成真实核查并汇报。'
            : verdict === 'needs_changes' ? '已定位需修正的真实问题。' : '调查时限已到，未完成独立核查。', verdict, findings }, 1000);
        }
        if (mode === 'cancel' && job.assignment.role === 'analyst') {
          controller.abort(new Error('用户已停止执行')); res.end(); return;
        }
        if (job.assignment.role === 'researcher' && !count('read_file')) return call(res, 'read_file', { path: 'notes.txt' });
        const changed = job.referenceDataNotInstructions?.frozenDrafts || [];
        const alreadyRead = calls.filter(c => c.function.name === 'read_file').map(c => JSON.parse(c.function.arguments).path);
        const next = changed.find(file => !alreadyRead.includes(file.path));
        if (next && ['reviewer', 'verifier'].includes(job.assignment.role)) return call(res, 'read_file', { path: next.path });
        if (mode === 'worker-write' && job.assignment.role === 'analyst' && !count('write_file')) return call(res, 'write_file', { path: 'notes.txt', content: 'UNAUTHORIZED' });
        if (mode === 'suggestion-only' && job.assignment.role === 'reviewer') return call(res, 'submit_agent_report', {
          summary: '建议继续改善措辞。', verdict: 'needs_changes', findings: [{ category: 'suggestion', severity: 'warning',
            path: 'notes.txt', line: 1, message: '可以让表达更高雅。' }],
        });
        if (mode === 'blocked-review' && job.assignment.role === 'reviewer') return call(res, 'submit_agent_report', {
          summary: '当前修改存在已核实的阻断问题。', verdict: 'blocked',
          findings: [participantConflict()],
        });
        const needsChanges = job.assignment.role === 'reviewer' && ['repair', 'stubborn', 'auto-repair'].includes(mode) && changed.length &&
          !payload.messages.some(m => m.role === 'tool' && textOf(m).includes('The study includes 40 participants in total.'));
        return call(res, 'submit_agent_report', { summary: needsChanges ? '请修正已定位的文字问题。' : '已按职责核对任务与当前内容。',
          verdict: needsChanges ? 'needs_changes' : 'pass', findings: needsChanges ? [participantConflict()] : [] });
      }
      if (['off', 'direct'].includes(mode)) return stop(res, '普通解答。');
      if (mode === 'source-check') {
        if (!payload.messages.some(message => message.role === 'tool' && /The study includes 40 participants/.test(textOf(message))))
          return call(res, 'read_file', { path: 'notes.txt', purpose: 'source' });
        return stop(res, '原始记录列出 40 名参与者。');
      }
      const scoped = scopedEdits(mode);
      if (scoped.length) {
        if (!count('read_file')) return call(res, 'read_file', { path: 'notes.txt' });
        const pending = scoped.filter(edit => !calls.some(item => item.function.name === 'edit_file' &&
          JSON.parse(item.function.arguments).search === edit.search &&
          payload.messages.some(message => message.role === 'tool' && message.tool_call_id === item.id && /"changed":true/.test(textOf(message)))));
        if (!pending.length) return stop(res, '已修改 notes.txt。');
        const edits = mode === 'consecutive-edits' ? pending.slice(0, 1) : pending;
        const toolCalls = edits.map((edit, index) => ({ index, id: `call_${requests}_${index}`, type: 'function',
          function: { name: 'edit_file', arguments: JSON.stringify(edit) } }));
        return res.end(sse({ delta: { tool_calls: toolCalls } }) + sse({ delta: {}, finish_reason: 'tool_calls' }) + 'data: [DONE]\n\n');
      }
      if (['direct-edit', 'expanded-edit', 'off-edit', 'auto-repair', 'suggestion-only', 'analysis-high-tokens', 'review-high-tokens', 'analysis-long-investigation', 'review-long-investigation', 'analysis-time-limit', 'review-time-limit', 'analysis-time-pass', 'review-time-pass', 'review-time-needs-changes', 'review-time-error', 'blocked-review'].includes(mode)) {
        if (!count('read_file')) return call(res, 'read_file', { path: 'notes.txt' });
        if (mode === 'expanded-edit' && count('read_file') === 1) return call(res, 'read_file', { path: 'constraints.txt' });
        const changedBy = replacement => calls.filter(c => c.function.name === 'edit_file' && JSON.parse(c.function.arguments).replace === replacement)
          .some(c => payload.messages.some(m => m.role === 'tool' && m.tool_call_id === c.id && /"changed":true/.test(textOf(m))));
        // A deferred tool is a report handoff, not a successful edit. The model
        // must consume the independent findings before it decides to call again.
        if (!changedBy('The study includes 80 participants.')) return call(res, 'edit_file', { path: 'notes.txt', search: 'The study includes 40 participants.', replace: 'The study includes 80 participants.' });
        if (['auto-repair', 'review-time-needs-changes'].includes(mode) && !changedBy('The study includes 40 participants in total.') &&
          payload.messages.some(m => m.role === 'user' && textOf(m).includes('独立协作报告') && textOf(m).includes('needs_changes')))
          return call(res, 'edit_file', { path: 'notes.txt', search: 'The study includes 80 participants.', replace: 'The study includes 40 participants in total.' });
        if (['blocked-review', 'review-time-error'].includes(mode)) return stop(res, '独立审阅发现阻断问题，暂存修改尚未通过审阅，未应用到正式文件。');
        if (['analysis-time-limit', 'review-time-limit'].includes(mode) && payload.messages.some(m => textOf(m).includes('【子任务资源交接】')))
          return stop(res, '已修改 notes.txt。子智能体因调查时限未完成独立核查，已由主智能体依据实际读取与标准流程验证接管。');
        return stop(res, '已修改 notes.txt。');
      }
      const editing = ['edit', 'edit-research', 'repair', 'stubborn'].includes(mode);
      if (!count('plan_task_graph')) return call(res, 'plan_task_graph', {
        scenario: editing ? 'edit' : 'answer', summary: '独立分析后按需求处理，并交叉审阅。',
        agents: mode === 'edit-research' ? ['analyst', 'researcher', 'reviewer', 'verifier']
          : editing ? ['analyst', 'reviewer', 'verifier'] : ['analyst', 'reviewer'],
      });
      const graphs = calls.filter(c => c.function.name === 'run_agent_graph').map(c => JSON.parse(c.function.arguments).phase);
      if (!graphs.includes('analysis')) return call(res, 'run_agent_graph', { phase: 'analysis' });
      if (editing) {
        if (!count('read_file')) return call(res, 'read_file', { path: 'notes.txt' });
        if (!count('edit_file')) return call(res, 'edit_file', { path: 'notes.txt', search: 'The study includes 40 participants.', replace: 'The study includes 80 participants.' });
      }
      if (!graphs.includes('review')) return call(res, 'run_agent_graph', { phase: 'review' });
      if (mode === 'repair') {
        if (count('edit_file') === 1) return call(res, 'edit_file', { path: 'notes.txt', search: 'The study includes 80 participants.', replace: 'The study includes 40 participants in total.' });
        if (graphs.filter(p => p === 'review').length === 1) return call(res, 'run_agent_graph', { phase: 'review' });
      }
      return stop(res, editing ? '已修改 notes.txt。' : '解释与独立审阅已完成。');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
});
after(async () => {
  server?.closeAllConnections(); await new Promise(resolve => server.close(resolve)); dbModule.resetDb();
  assert.ok(dataDir.startsWith(path.join(os.tmpdir(), 'corelatex-multi-integration-'))); fs.rmSync(dataDir, { recursive: true, force: true });
});
async function run(scenario, config = {}) {
  mode = scenario; requests = 0; payloads = []; events = []; controller = new AbortController();
  db.prepare('UPDATE settings SET chinese_support=0,agent_config=? WHERE user_id=?').run(JSON.stringify({ graphOrchestration: !['off', 'off-edit'].includes(mode), confirmBeforeApply: false, allowWebAccess: false, ...config }), user.id);
  const pid = Number(db.prepare('INSERT INTO projects(name,owner_id,public_id) VALUES(?,?,?)').run('Multi fixture', user.id, randomUUID()).lastInsertRowid);
  const cid = Number(db.prepare('INSERT INTO chats(project_id,user_id) VALUES(?,?)').run(pid, user.id).lastInsertRowid);
  const dir = path.join(dataDir, 'projects', String(pid)); fs.mkdirSync(dir, { recursive: true });
  const original = scopedEdits(mode).map(edit => edit.search).join('\n\n') || 'The study includes 40 participants.';
  fs.writeFileSync(path.join(dir, 'notes.txt'), original + '\n');
  if (mode === 'expanded-edit') fs.writeFileSync(path.join(dir, 'constraints.txt'), 'The methods section follows the group export.\n');
  const result = await runAgent({ user, project: db.prepare('SELECT * FROM projects WHERE id=?').get(pid), chat: db.prepare('SELECT * FROM chats WHERE id=?').get(cid),
    messages: [{ role: 'user', content: '请处理当前任务，保留文件范围。' }], signal: controller.signal,
    modelConfig: { provider: 'openai', model: 'multi-fixture', apiKey: 'synthetic', baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1', maxTokens: 1024, contextLength: 100000 }, emit: event => events.push(event) });
  const row = db.prepare('SELECT * FROM chat_messages WHERE id=?').get(result.messageId); const steps = JSON.parse(row.steps);
  return { result, row, steps, disk: fs.readFileSync(path.join(dir, 'notes.txt'), 'utf8'), graph: steps.find(s => s.type === 'workflow')?.graph };
}
async function runWithClock(t, scenario) {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  advanceClock = elapsed => { now += elapsed; };
  try { return await run(scenario); }
  finally { advanceClock = null; }
}
function assertReporting(f, role, attempts = 1) {
  const activity = f.steps.filter(step => step.code === 'SPECIALIST_REPORTING' && step.agentRole === role);
  assert.equal(activity.length, attempts, 'each real execution enters reporting once');
  assert.ok(activity.every(step => step.phase === 'reporting' && step.agentStatus === 'running'));
  assert.ok(activity.every(step => step.elapsedMs === 600000 && Number.isFinite(step.deadlineAt)));
  assert.ok(activity.every(step => /10分钟.*汇报/.test(step.text)));
  assert.equal(new Set(activity.map(step => step.agentExecutionId)).size, attempts);
  assert.ok(events.some(event => event.type === 'workflow' && event.graph.execution?.nodes.some(node =>
    node.role === role && node.status === 'running' && /汇报/.test(node.detail))), 'reporting is an in-progress detail, not a failure');
  const reportRequests = payloads.filter(payload => assignment(payload)?.assignment.role === role && assignment(payload).reportInstruction);
  assert.equal(reportRequests.length, attempts);
  assert.ok(reportRequests.every(payload => payload.tools.length === 1 && payload.tools[0].function.name === 'submit_agent_report'));
}
test('switch off preserves single-agent behavior and completes the always-on standard workflow', async () => {
  const f = await run('off'); assert.equal(f.result.status, 'completed'); assert.equal(requests, 1); assert.equal(f.graph.version, 4); assert.equal(f.graph.tier, 'off'); assert.equal(f.graph.validation.version, 1); assert.equal(f.graph.status, 'completed');
  assert.equal(payloads[0].tools.some(t => ['run_agent_graph', 'plan_task_graph'].includes(t.function.name)), false);
});
test('switch on does not turn a simple direct answer into worker calls or planning turns', async () => {
  const f = await run('direct'); assert.equal(f.result.status, 'completed'); assert.equal(requests, 1);
  assert.equal(payloads.map(assignment).filter(Boolean).length, 0); assert.deepEqual(f.graph.agents, []);
  assert.equal(f.graph.validation.status, 'completed'); assert.equal(f.steps.some(step => step.type === 'agent_report'), false);
  assert.ok(f.graph.nodes.filter(node => node.role !== 'coordinator').every(node => node.status === 'skipped'));
});
test('switch off performs a local edit without additional workers', async () => {
  const f = await run('off-edit'); assert.equal(f.result.status, 'completed'); assert.equal(requests, 3);
  assert.equal(f.disk, 'The study includes 80 participants.\n'); assert.equal(f.result.changeset.applied, true);
  assert.equal(payloads.map(assignment).filter(Boolean).length, 0);
  assert.deepEqual(f.steps.filter(step => step.type === 'tool').map(step => step.name), ['read_file', 'edit_file']);
});
test('legacy collaboration forwards early analysis and admits an unchanged answer after clean review', async () => {
  const f = await run('direct-edit'); assert.equal(f.result.status, 'completed');
  assert.equal(f.disk, 'The study includes 80 participants.\n'); assert.equal(f.result.changeset.applied, true);
  assert.deepEqual(f.steps.filter(step => step.type === 'agent_report').map(step => step.agentRole), ['analyst', 'reviewer']);
  const primary = payloads.filter(p => !assignment(p));
  assert.equal(primary.flatMap(p => p.messages.flatMap(m => m.tool_calls || []))
    .some(c => ['plan_task_graph', 'run_agent_graph'].includes(c.function.name)), false);
  assert.ok(primary.some(p => p.messages.some(m => m.role === 'tool' && textOf(m).includes('独立分析已完成'))));
  assert.equal(primary.length, 4, 'clean review needs no extra coordinator response');
  const edits = f.steps.filter(step => step.name === 'edit_file' && !step.agentId);
  assert.equal(edits.filter(step => step.status === 'error').length, 1, 'first write is deferred until the coordinator has the report');
  assert.equal(edits.filter(step => step.status === 'end').length, 1, 'the file is changed only once');
  assert.ok(f.steps.some(step => step.agentId === 'reviewer' && step.name === 'read_file' && step.result.includes('The study includes 80 participants.')));
  assert.equal(f.graph.validation.scenario, 'edit'); assert.equal(f.graph.status, 'completed');
  assert.equal(payloads.map(assignment).filter(Boolean).some(job => job.assignment.role === 'researcher'), false);
});
for (const [scenario, role] of [['analysis-high-tokens', 'analyst'], ['review-high-tokens', 'reviewer']]) {
  test(scenario + ' continues actual worker tools and reporting beyond 80k and 200k despite the removed legacy setting', async () => {
    const previous = process.env.CORELATEX_SPECIALIST_TOKEN_BUDGET;
    // Old deployments may still carry this variable. It must not regain an
    // execution limit now that cumulative usage is accounting only.
    process.env.CORELATEX_SPECIALIST_TOKEN_BUDGET = '16000';
    let f;
    try { f = await run(scenario); }
    finally {
      if (previous === undefined) delete process.env.CORELATEX_SPECIALIST_TOKEN_BUDGET;
      else process.env.CORELATEX_SPECIALIST_TOKEN_BUDGET = previous;
    }
    assert.equal(f.result.status, 'completed'); assert.equal(f.disk, 'The study includes 80 participants.\n');
    assert.equal(f.result.changeset.applied, true); assert.equal(f.graph.validation.status, 'completed');
    const node = f.graph.nodes.find(item => item.role === role);
    assert.equal(node.status, 'completed'); assert.equal(node.report.verdict, 'pass');
    assert.equal(node.resourceFailure, undefined); assert.equal(node.takeover, undefined);
    assert.equal(node.visits, 1); assert.equal(node.history.length, 1);
    assert.equal(node.usage.inputTokens, 250000); assert.equal(node.usage.outputTokens, 50);
    assert.deepEqual(node.history[0].usage, node.usage);
    assert.equal(node.history[0].status, 'completed'); assert.equal(node.history[0].report.verdict, 'pass');
    const workerRequests = payloads.filter(payload => assignment(payload)?.assignment.role === role);
    assert.equal(workerRequests.length, 5, 'tools continue after 90k and a normal report follows more than 200k cumulative usage');
    assert.ok(workerRequests.every(payload => !assignment(payload).reportInstruction), 'token totals never force report-only mode');
    assert.equal(new Set(workerRequests.map(payload => assignment(payload).assignment.executionId)).size, 1);
    const reads = f.steps.filter(step => step.type === 'tool' && step.agentRole === role && step.name === 'read_file');
    assert.equal(reads.length, 4); assert.ok(reads.every(step => step.status === 'end'));
    assert.ok(reads.every(step => step.result.includes(role === 'analyst' ? 'The study includes 40 participants.' : 'The study includes 80 participants.')));
    const report = f.steps.find(step => step.type === 'agent_report' && step.agentRole === role);
    assert.equal(report.report.verdict, 'pass'); assert.deepEqual(report.usage, node.usage);
    assert.equal(f.steps.some(step => step.code === 'SPECIALIST_RESOURCE_TAKEOVER'), false);
    assert.equal(payloads.filter(payload => !assignment(payload)).some(payload => payload.messages.some(message => textOf(message).includes('【子任务资源交接】'))), false);
    assert.equal(f.steps.filter(step => step.name === 'edit_file' && !step.agentId && step.status === 'end').length, 1);
  });
}
for (const [scenario, role, phase] of [['analysis-time-limit', 'analyst', 'analysis'], ['review-time-limit', 'reviewer', 'review']]) {
  test(scenario + ' hands resource exhaustion back to the coordinator while preserving the failed specialist record', async t => {
    const f = await runWithClock(t, scenario);
    assert.equal(f.result.status, 'completed'); assert.equal(f.disk, 'The study includes 80 participants.\n');
    assert.equal(f.result.changeset.applied, true); assert.equal(f.graph.validation.status, 'completed');
    const node = f.graph.nodes.find(item => item.role === role);
    assert.equal(node.status, 'failed'); assert.equal(node.report.verdict, 'blocked');
    assert.equal(node.resourceFailure.code, 'time_limit'); assert.equal(node.resourceFailure.usedTokens, 3030);
    assert.equal(node.resourceFailure.tokenLimit, undefined); assert.deepEqual(node.resourceFailure.readPaths, ['notes.txt']);
    assert.equal(node.resourceFailure.toolCount, 1, 'a new business call returned at the deadline cannot start; prior read evidence is retained');
    assert.equal(node.takeover.by, 'coordinator'); assert.equal(node.takeover.phase, phase);
    assert.deepEqual(node.takeover.originalFailure, node.resourceFailure);
    assert.deepEqual(node.takeover.evidence.readPaths, ['notes.txt']);
    assert.equal(node.takeover.evidence.workflowReady, phase === 'review');
    assert.equal(node.visits, 1, 'a resource failure does not cause the same assignment to be dispatched again');
    assert.equal(node.history.length, 1); assert.deepEqual(node.history[0].report, node.report);
    assert.equal(node.history[0].status, 'failed'); assert.deepEqual(node.history[0].resourceFailure, node.resourceFailure);
    const reports = f.steps.filter(step => step.type === 'agent_report');
    assert.deepEqual(reports.map(step => [step.agentRole, step.report.verdict]),
      role === 'analyst' ? [['analyst', 'blocked'], ['reviewer', 'pass']] : [['analyst', 'pass'], ['reviewer', 'blocked']]);
    assert.deepEqual(reports.find(step => step.agentRole === role).report, node.report);
    const workers = payloads.map(assignment).filter(job => job?.assignment.role === role);
    assert.equal(workers.length, 3, 'the next request at the soft deadline submits the report');
    assert.equal(workers.filter(job => job.reportInstruction).length, 1, 'only the last turn is reserved for a report');
    assert.equal(new Set(workers.map(job => job.assignment.executionId)).size, 1);
    assertReporting(f, role);
    const primary = payloads.filter(payload => !assignment(payload));
    assert.ok(primary.some(payload => payload.messages.some(message => textOf(message).includes('【子任务资源交接】') &&
      textOf(message).includes('"verdict":"blocked"') && textOf(message).includes('"takenOver":true'))));
    assert.match(f.row.content, /调查时限未完成独立核查/);
    const edits = f.steps.filter(step => step.name === 'edit_file' && !step.agentId);
    assert.equal(edits.filter(step => step.status === 'end').length, 1, 'the coordinator completes the intended edit once');
    const firstTakeover = events.find(event => event.type === 'workflow' && event.graph.nodes.some(item => item.role === role && item.takeover));
    assert.ok(firstTakeover);
    if (phase === 'review') {
      assert.equal(firstTakeover.graph.validation.nodes.find(item => item.id === 'verify').status, 'completed');
      assert.equal(firstTakeover.graph.validation.currentNode, 'deliver', 'review takeover follows successful standard workflow gates');
      assert.equal(node.takeover.revision, f.graph.revision);
    } else {
      assert.ok(edits.some(step => step.status === 'error' && step.result.includes('【子任务资源交接】')),
        'the deferred write returns the resource handoff before the coordinator decides to retry');
    }
  });
}
for (const [scenario, role] of [['analysis-long-investigation', 'analyst'], ['review-long-investigation', 'reviewer']]) {
  test(scenario + ' continues beyond six turns and twelve actual business tools before a normal report', async () => {
    const f = await run(scenario);
    assert.equal(f.result.status, 'completed'); assert.equal(f.disk, 'The study includes 80 participants.\n');
    const node = f.graph.nodes.find(item => item.role === role);
    assert.equal(node.status, 'completed'); assert.equal(node.report.verdict, 'pass');
    assert.equal(node.toolCount, 13); assert.equal(node.resourceFailure, undefined); assert.equal(node.takeover, undefined);
    const workers = payloads.filter(payload => assignment(payload)?.assignment.role === role);
    assert.equal(workers.length, 14); assert.ok(workers.every(payload => !assignment(payload).reportInstruction));
    const reads = f.steps.filter(step => step.agentRole === role && step.name === 'read_file');
    assert.equal(reads.length, 13); assert.ok(reads.every(step => step.status === 'end'));
    assert.equal(f.steps.filter(step => step.agentRole === role && step.type === 'agent_report').length, 1);
  });
}
for (const [scenario, role] of [['analysis-time-pass', 'analyst'], ['review-time-pass', 'reviewer']]) {
  test(scenario + ' accepts a genuine timed report without treating the deadline as failure', async t => {
    const f = await runWithClock(t, scenario);
    assert.equal(f.result.status, 'completed'); assert.equal(f.disk, 'The study includes 80 participants.\n');
    const node = f.graph.nodes.find(item => item.role === role);
    assert.equal(node.status, 'completed'); assert.equal(node.report.verdict, 'pass');
    assert.equal(node.resourceFailure, undefined); assert.equal(node.takeover, undefined); assert.equal(node.visits, 1);
    assert.equal(payloads.filter(payload => assignment(payload)?.assignment.role === role).length, 3);
    assert.equal(f.steps.filter(step => step.agentRole === role && step.type === 'agent_report').length, 1);
    assertReporting(f, role);
  });
}
test('a timed needs_changes report reaches the coordinator and the repaired revision receives its own real report', async t => {
  const f = await runWithClock(t, 'review-time-needs-changes');
  assert.equal(f.result.status, 'completed'); assert.equal(f.disk, 'The study includes 40 participants in total.\n');
  const reports = f.steps.filter(step => step.type === 'agent_report' && step.agentRole === 'reviewer');
  assert.deepEqual(reports.map(step => step.report.verdict), ['needs_changes', 'pass']);
  assert.notEqual(reports[0].agentExecutionId, reports[1].agentExecutionId);
  assert.notEqual(reports[0].agentRevision, reports[1].agentRevision);
  const reviewer = f.graph.nodes.find(item => item.role === 'reviewer');
  assert.equal(reviewer.takeover, undefined); assert.equal(reviewer.resourceFailure, undefined);
  assert.equal(reviewer.visits, 2); assert.equal(reviewer.lastReport.verdict, 'needs_changes');
  assertReporting(f, 'reviewer', 2);
});
test('a timed blocked report with a real error is not converted to coordinator success', async t => {
  const f = await runWithClock(t, 'review-time-error');
  assert.equal(f.result.status, 'failed'); assert.equal(f.disk, 'The study includes 40 participants.\n');
  assert.equal(f.result.changeset.applied, false); assert.equal(f.result.changeset.status, 'pending');
  const node = f.graph.nodes.find(item => item.role === 'reviewer');
  assert.equal(node.report.verdict, 'blocked'); assert.equal(node.report.findings[0].severity, 'error');
  assert.equal(node.takeover, undefined); assert.equal(node.resourceFailure, undefined);
  assertReporting(f, 'reviewer');
});
test('a real blocked review finding cannot be bypassed through resource takeover', async () => {
  const f = await run('blocked-review');
  assert.equal(f.result.status, 'failed'); assert.equal(f.disk, 'The study includes 40 participants.\n');
  assert.equal(f.result.changeset.applied, false); assert.equal(f.result.changeset.status, 'pending');
  const node = f.graph.nodes.find(item => item.role === 'reviewer');
  assert.equal(node.report.verdict, 'blocked'); assert.equal(node.report.findings[0].severity, 'error');
  assert.equal(node.report.findings[0].path, 'notes.txt'); assert.equal(node.takeover, undefined); assert.equal(node.resourceFailure, undefined);
  assert.equal(node.visits, 1); assert.equal(node.history.length, 1);
  assert.deepEqual(node.history[0].report, node.report);
  assert.equal(payloads.filter(payload => !assignment(payload)).some(payload => payload.messages.some(message => textOf(message).includes('【子任务资源交接】'))), false);
  assert.ok(requests < 20, 'the unresolved finding ends with a bounded handoff rather than repeated worker dispatch');
  assert.match(f.row.content, /阻断问题/);
});
test('automatic review findings reach the coordinator and the repaired revision is reviewed before application', async () => {
  const f = await run('auto-repair');
  assert.equal(f.result.status, 'completed'); assert.equal(f.disk, 'The study includes 40 participants in total.\n');
  assert.equal(f.result.changeset.applied, true);
  const reports = f.steps.filter(step => step.type === 'agent_report');
  assert.deepEqual(reports.map(step => [step.agentRole, step.report.verdict]),
    [['analyst', 'pass'], ['reviewer', 'needs_changes'], ['reviewer', 'pass']]);
  assert.notEqual(reports[1].agentRevision, reports[2].agentRevision);
});
test('enabled graph runs real isolated analyst and reviewer calls and persists their reports', async () => {
  const f = await run('answer'); assert.equal(f.result.status, 'completed');
  const workers = payloads.map(assignment).filter(Boolean); assert.ok(workers.some(j => j.assignment.role === 'analyst')); assert.ok(workers.some(j => j.assignment.role === 'reviewer'));
  assert.equal(f.graph.version, 4); assert.equal(f.graph.kind, 'orchestration'); assert.equal(f.graph.schemaVersion, 4); assert.equal(f.graph.status, 'completed');
  assert.equal(f.graph.nodes.find(n => n.id === 'analysis').report.verdict, 'pass');
  assert.equal(f.graph.nodes.find(n => n.id === 'reviewer').report.verdict, 'pass');
  assert.equal(f.steps.filter(s => s.type === 'workflow').length, 1);
  assert.ok(f.steps.some(s => s.name === 'submit_agent_report' && s.agentId === 'analysis'));
  assert.ok(workers.every(j => !JSON.stringify(j).includes('roundNote')));
});
test('edits are independently read by review agents before automatic application', async () => {
  const f = await run('edit'); assert.equal(f.result.status, 'completed'); assert.equal(f.disk, 'The study includes 80 participants.\n'); assert.equal(f.result.changeset.applied, true);
  assert.ok(f.steps.some(s => s.name === 'read_file' && s.agentId === 'reviewer' && s.result.includes('The study includes 80 participants.')));
  assert.ok(f.steps.some(s => s.name === 'read_file' && s.agentId === 'verifier'));
  assert.ok(events.some(e => e.type === 'workflow' && e.graph.activeCount === 2));
  assert.ok(f.graph.nodes.find(n => n.id === 'reviewer').revision > 0);
  assert.equal(f.graph.nodes.find(n => n.id === 'researcher').status, 'skipped');
  assert.equal(payloads.map(assignment).filter(Boolean).some(job => job.assignment.role === 'researcher'), false);
});
test('a repaired draft invalidates prior review and is checked again before application', async () => {
  const f = await run('repair'); assert.equal(f.result.status, 'completed'); assert.equal(f.disk, 'The study includes 40 participants in total.\n');
  const reviewer = f.graph.nodes.find(n => n.id === 'reviewer'); assert.equal(reviewer.visits, 2); assert.equal(reviewer.report.verdict, 'pass');
  assert.equal(reviewer.lastReport.verdict, 'needs_changes'); assert.equal(reviewer.revision, f.graph.revision);
});
test('unresolved independent review prevents automatic application and keeps the real draft', async () => {
  const f = await run('stubborn'); assert.equal(f.result.status, 'failed'); assert.equal(f.disk, 'The study includes 40 participants.\n');
  assert.equal(f.result.changeset.applied, false); assert.equal(f.result.changeset.status, 'pending'); assert.ok(requests < 25);
  assert.match(f.row.content, /审阅|智能体/); assert.equal(f.graph.status, 'failed');
});
test('specialists never receive mutation or recursive delegation capabilities', async () => {
  const f = await run('worker-write'); assert.equal(f.disk, 'The study includes 40 participants.\n');
  for (const payload of payloads.filter(p => assignment(p))) {
    assert.equal(payload.tools.some(t => ['write_file', 'edit_file', 'run_in_workspace', 'run_agent_graph', 'ask_user'].includes(t.function.name)), false);
  }
  assert.ok(f.steps.some(s => s.name === 'write_file' && s.agentId === 'analysis' && s.status === 'error'));
});
test('cancelling a real worker cancels the whole graph without fabricating successful reports', async () => {
  const f = await run('cancel'); assert.equal(f.result.status, 'cancelled'); assert.equal(f.graph.status, 'cancelled');
  assert.notEqual(f.graph.nodes.find(n => n.id === 'analysis').status, 'completed'); assert.equal(f.disk, 'The study includes 40 participants.\n');
});

test('explicit local evidence specialist reads actual source and persists per-execution work records', async () => {
  const f = await run('edit-research'); assert.equal(f.result.status, 'completed');
  const researcher = f.graph.nodes.find(node => node.id === 'researcher');
  assert.equal(researcher.status, 'completed'); assert.equal(researcher.report.verdict, 'pass');
  assert.ok(f.steps.some(step => step.agentId === 'researcher' && step.name === 'read_file' && step.status === 'end'));
  const records = f.steps.filter(step => step.type === 'agent_report');
  assert.equal(records.length, 4);
  assert.equal(new Set(records.map(record => record.agentExecutionId)).size, 4);
  for (const record of records) {
    assert.ok(Number.isFinite(record.startedAt)); assert.ok(Number.isFinite(record.finishedAt)); assert.ok(record.finishedAt >= record.startedAt);
    assert.equal(record.durationMs, record.finishedAt - record.startedAt); assert.equal(record.status, 'completed');
    const node = f.graph.nodes.find(node => node.id === record.agentId);
    assert.ok(node.history.some(attempt => attempt.executionId === record.agentExecutionId && attempt.report?.verdict === record.report.verdict));
    assert.ok(f.steps.some(step => step.type === 'activity' && step.agentExecutionId === record.agentExecutionId && step.phase === 'agent_work'));
  }
});
test('repeated reviews have separate work records and immutable reports for both revisions', async () => {
  const f = await run('repair'); assert.equal(f.result.status, 'completed');
  const records = f.steps.filter(step => step.type === 'agent_report' && step.agentId === 'reviewer');
  assert.equal(records.length, 2); assert.notEqual(records[0].agentExecutionId, records[1].agentExecutionId);
  assert.equal(records[0].report.verdict, 'needs_changes'); assert.equal(records[1].report.verdict, 'pass');
  assert.notEqual(records[0].agentRevision, records[1].agentRevision);
  const history = f.graph.nodes.find(node => node.id === 'reviewer').history;
  assert.equal(history.length, 2); assert.equal(history[0].report.verdict, 'needs_changes'); assert.equal(history[1].report.verdict, 'pass');
});


for (const scenario of ['off-edit', 'direct-edit']) test(scenario + ' projects observed stages and actual automatic workers', async () => {
  const f = await run(scenario); const execution = f.graph.execution;
  assert.equal(execution.version, 3); assert.equal(execution.kind, 'execution'); assert.equal(execution.status, 'completed');
  const automatic = scenario === 'direct-edit';
  const workers = execution.nodes.filter(node => node.type === 'agent');
  assert.deepEqual(workers.map(node => node.role).sort(), automatic ? ['analyst', 'reviewer'] : []);
  assert.equal(execution.responseCount, automatic ? 4 : 3);
  assert.ok(execution.nodes.some(node => node.type === 'stage' && node.phase === 'context'));
  assert.ok(execution.nodes.some(node => node.type === 'stage' && node.phase === 'edit'));
  const snapshots = events.filter(event => event.type === 'workflow' && event.graph.execution).map(event => event.graph.execution);
  assert.ok(snapshots.some(graph => graph.toolCount === 0 && !graph.nodes.some(node => node.type === 'stage')));
  assert.ok(snapshots.some(graph => graph.nodes.some(node => node.phase === 'context' && node.status === 'running')));
  assert.ok(snapshots.some(graph => graph.nodes.some(node => node.phase === 'edit' && node.status === 'running')));
  assert.deepEqual(snapshots.at(-1), execution);
});

test('execution graph includes actual chosen workers and their report handoffs without unused role placeholders', async () => {
  const f = await run('edit'); const execution = f.graph.execution;
  const workers = execution.nodes.filter(node => node.type === 'agent');
  assert.deepEqual(workers.map(node => node.role).sort(), ['analyst', 'reviewer', 'verifier']);
  const records = f.steps.filter(step => step.type === 'agent_report');
  assert.deepEqual(new Set(workers.map(node => node.executionId)), new Set(records.map(record => record.agentExecutionId)));
  assert.ok(workers.every(node => node.status === 'completed' && Number.isFinite(node.startedAt) && Number.isFinite(node.finishedAt)));
  assert.ok(workers.every(node => execution.edges.some(edge => edge.to === node.id && edge.type === 'dispatch')));
  assert.ok(workers.every(node => execution.edges.some(edge => edge.from === node.id && edge.type === 'handoff')));
  assert.ok(events.some(event => event.type === 'workflow' && event.graph.execution?.activeAgentCount === 2));
  assert.equal(execution.nodes.some(node => node.role === 'researcher'), false);
});

test('execution graph preserves both actual reviewer attempts across a repair rather than overwriting the first verdict', async () => {
  const f = await run('repair'); const execution = f.graph.execution;
  const reviews = execution.nodes.filter(node => node.type === 'agent' && node.role === 'reviewer');
  assert.equal(reviews.length, 2); assert.notEqual(reviews[0].id, reviews[1].id);
  assert.deepEqual(reviews.map(node => node.report.verdict), ['needs_changes', 'pass']);
  assert.notEqual(reviews[0].revision, reviews[1].revision);
  assert.ok(execution.nodes.filter(node => node.phase === 'edit').length >= 2);
  assert.ok(execution.edges.some(edge => edge.from === reviews[0].id && edge.type === 'handoff'));
});

test('a cancelled worker is terminal in the persisted execution projection without a fake success', async () => {
  const f = await run('cancel'); const execution = f.graph.execution;
  assert.equal(execution.status, 'cancelled'); assert.equal(execution.activeCount, 0); assert.equal(execution.activeAgentCount, 0);
  const worker = execution.nodes.find(node => node.type === 'agent');
  assert.ok(worker); assert.equal(worker.status, 'cancelled'); assert.notEqual(worker.report?.verdict, 'pass');
  assert.equal(execution.nodes.find(node => node.type === 'delivery').status, 'cancelled');
  assert.equal(events.at(-1).type, 'done');
});


test('a style-only reviewer report completes without requesting additional manuscript edits', async () => {
  const f = await run('suggestion-only');
  assert.equal(f.result.status, 'completed');
  const reviews = f.steps.filter(step => step.type === 'agent_report' && step.agentRole === 'reviewer');
  assert.equal(reviews.length, 1); assert.equal(reviews[0].report.verdict, 'pass');
  assert.deepEqual(reviews[0].report.findings, []);
  assert.equal(f.graph.nodes.find(node => node.role === 'reviewer').visits, 1);
  assert.equal(f.disk, 'The study includes 80 participants.\n');
});


test('single-file edits use incremental review by default and deep still requests independent analysis', async t => {
  for (const tier of ['full', 'lite', 'deep']) {
    const f = await run('direct-edit', { collaborationTier: tier, maxModelConcurrency: 1 });
    assert.equal(f.result.status, 'completed'); assert.match(f.disk, /80 participants/);
    const roles = payloads.map(assignment).filter(Boolean).map(job => job.assignment.role);
    assert.equal(roles.includes('analyst'), tier === 'deep'); assert.ok(roles.includes('reviewer'));
    assert.equal(roles.includes('researcher'), false);
    assert.equal(f.graph.tier, tier); assert.ok(f.graph.instances.some(task => task.id === 'reviewer' && task.report?.reportId));
    const ledger = f.graph.accounting;
    assert.equal(ledger.requests.length, requests); assert.equal(ledger.modelPool.active, 0);
    const coordinatorRequests = ledger.requests.filter(request => request.owner === 'coordinator').length;
    assert.equal(coordinatorRequests, tier === 'deep' ? 4 : 3);
    t.diagnostic(JSON.stringify({ fixture: 'single-file-edit', tier, requests, coordinatorRequests, workerRequests: requests - coordinatorRequests, repairCycles: ledger.repair.used }));
    assert.ok(ledger.requests.some(request => request.owner.startsWith('reviewer-')));
    const reviewer = payloads.map(assignment).find(job => job?.assignment.role === 'reviewer');
    assert.ok(reviewer.taskContract.priorUserRequirements.some(item => item.text.includes('保留文件范围')));
  }
});

test('standard collaboration requests analysis when the observed edit depends on multiple files', async () => {
  const f = await run('expanded-edit', { collaborationTier: 'full' });
  assert.equal(f.result.status, 'completed');
  assert.deepEqual(f.steps.filter(step => step.type === 'agent_report').map(step => step.agentRole), ['analyst', 'reviewer']);
  const analyst = payloads.map(assignment).find(job => job?.assignment.role === 'analyst');
  assert.deepEqual(analyst.taskContract.readScope, ['notes.txt', 'constraints.txt']);
});

for (const [mode, edits, roles] of [
  ['whole-file-patch', ['error', 'end'], ['analyst', 'reviewer']],
  ['large-batch', ['error', 'error', 'end', 'end'], ['analyst', 'reviewer']],
  ['consecutive-edits', ['end', 'error', 'end'], ['analyst', 'reviewer']],
  ['bounded-batch', ['end', 'end'], ['reviewer']],
]) test('standard collaboration scopes ' + mode + ' using the full replacement footprint', async () => {
  const f = await run(mode, { collaborationTier: 'full' });
  assert.equal(f.result.status, 'completed');
  assert.deepEqual(f.steps.filter(step => step.name === 'edit_file' && !step.agentRole).map(step => step.status), edits);
  assert.deepEqual(f.steps.filter(step => step.type === 'agent_report').map(step => step.agentRole), roles);
  if (mode === 'large-batch') {
    const deferredWrites = f.steps.filter(step => step.name === 'edit_file' && step.status === 'error');
    assert.match(deferredWrites[0].result, /独立分析已完成/);
    assert.match(deferredWrites[1].result, /请先阅读本轮前置分析/);
  }
  assert.equal(f.disk, scopedEdits(mode).map(edit => edit.replace).join('\n\n') + '\n');
});

test('standard collaboration assigns independent source checks without a duplicate analyst', async () => {
  const f = await run('source-check', { collaborationTier: 'full' });
  assert.equal(f.result.status, 'completed');
  assert.deepEqual(f.steps.filter(step => step.type === 'agent_report').map(step => step.agentRole), ['researcher']);
  assert.equal(f.graph.validation.nodes.find(node => node.id === 'research').status, 'completed');
});

test('legacy zero limits do not prevent lite reviewers from repairing and rechecking a real defect', async () => {
  const f = await run('auto-repair', { collaborationTier: 'lite', repairCycles: 0 });
  assert.equal(f.result.status, 'completed'); assert.match(f.disk, /40 participants in total/);
  assert.equal(f.graph.accounting.repair.used, 1);
  assert.equal(f.graph.accounting.repair.limit, null);
  const reviewer = f.graph.instances.find(task => task.id === 'reviewer');
  assert.equal(reviewer.history.length, 2); assert.equal(reviewer.report.verdict, 'pass');
});

test('instance review findings are repaired once and reviewed against the changed draft', async () => {
  const f = await run('auto-repair', { collaborationTier: 'full' });
  assert.equal(f.result.status, 'completed'); assert.match(f.disk, /40 participants in total/);
  const ledger = f.graph.accounting;
  assert.equal(ledger.repair.used, 1); assert.equal(ledger.requests.length, requests);
  assert.equal(f.graph.instances.find(task => task.id === 'reviewer').history.length, 2);
});
