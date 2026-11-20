import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskGraph, validateTaskPlan } from '../src/services/agent/taskGraph.js';
import { createOrchestrator } from '../src/services/agent/orchestrator.js';
import { createOrchestrationRuntime } from '../src/services/agent/orchestrationRuntime.js';
import { collaborationPolicy } from '../src/services/agent/orchestrationPolicy.js';

const result = (verdict = 'pass') => ({ report: { verdict, summary: '核对完成', findings: [] }, toolCount: 1 });
const spec = (taskId, archetype = 'reviewer', dependsOn = []) => ({ taskId, archetype, dependsOn, objective: '核对限定范围', readScope: [`${taskId}.txt`] });
const tick = () => new Promise(resolve => setImmediate(resolve));

test('plans reject cycles, duplicate IDs, implicit dependency semantics and unsafe scopes', () => {
  for (const tasks of [[spec('a'), spec('a')], [spec('a', 'editor')], [{ ...spec('a'), readScope: ['../escape'] }],
    [spec('a', 'analyst', [{ taskId: 'b', requires: 'pass' }]), spec('b', 'reviewer', [{ taskId: 'a', requires: 'pass' }])],
    [spec('a', 'analyst', [{ taskId: 'missing', requires: 'pass' }])]]) assert.ok(validateTaskPlan(tasks));
});

test('a ready dependant starts immediately while an unrelated analysis remains running', async () => {
  const starts = []; let releaseSlow;
  const slow = new Promise(resolve => { releaseSlow = resolve; });
  const graph = createTaskGraph({ executeTask: async task => { starts.push(task.id); if (task.id === 'slow') await slow; return result(); } });
  graph.plan({ tasks: [spec('quick', 'analyst'), spec('slow', 'analyst'), spec('review', 'reviewer', [{ taskId: 'quick', requires: 'pass' }])] });
  const pending = graph.execute(); await tick();
  assert.deepEqual(starts, ['quick', 'slow', 'review']);
  releaseSlow(); assert.equal((await pending).ready, true);
});

test('usable report allows findings downstream but pass dependencies remain blocked', async () => {
  const calls = [];
  const graph = createTaskGraph({ executeTask: async task => { calls.push(task.id); return result(task.id === 'analysis' ? 'needs_changes' : 'pass'); } });
  graph.plan({ tasks: [spec('analysis', 'analyst'), spec('usable', 'reviewer', [{ taskId: 'analysis', requires: 'usable_report' }]),
    spec('strict', 'reviewer', [{ taskId: 'analysis', requires: 'pass' }])] });
  assert.equal((await graph.execute()).ready, false); assert.deepEqual(calls, ['analysis', 'usable']);
  assert.match(graph.prepareCompletion().reason, /strict/);
});

test('one-slot scheduling completes dependencies without holding a slot during nested waits', async () => {
  const calls = [], graph = createTaskGraph({ maxConcurrency: 1, executeTask: async task => { calls.push(task.id); return result(); } });
  graph.plan({ tasks: [spec('a', 'analyst'), spec('b', 'reviewer', [{ taskId: 'a', requires: 'pass' }])] });
  assert.equal((await graph.execute()).ready, true); assert.deepEqual(calls, ['a', 'b']);
});

test('cancellation settles even if a worker ignores abort and never returns', async () => {
  const ac = new AbortController(), graph = createTaskGraph({ signal: ac.signal, executeTask: () => new Promise(() => {}) });
  graph.plan({ tasks: [spec('a')] }); const pending = graph.execute(); ac.abort();
  await pending; assert.equal(graph.snapshot().status, 'cancelled');
  assert.equal(graph.snapshot().activeCount, 0); assert.equal(graph.prepareCompletion().ready, false);
});

test('blocked and throwing attempts are cached, preserved in history and cannot be erased by replanning', async () => {
  for (const throws of [false, true]) {
    let calls = 0;
    const graph = createTaskGraph({ executeTask: async () => { calls++; if (throws) throw Error('no source'); return result('blocked'); } });
    graph.plan({ tasks: [spec('a')] }); await graph.execute(); await graph.execute();
    assert.equal(calls, 1); assert.ok(graph.plan({ tasks: [spec('b')] }).error);
    graph.invalidate({ includeAnalysis: true }); await graph.execute(); assert.equal(calls, 2);
    assert.equal(graph.snapshot().nodes.find(n => n.id === 'a').history.length, 2);
  }
});

test('late results after goal invalidation cannot complete the new obligation', async () => {
  let release;
  const graph = createTaskGraph({ executeTask: async () => { await new Promise(resolve => { release = resolve; }); return result(); } });
  graph.plan({ tasks: [spec('a')] }); const pending = graph.execute(); await tick();
  graph.invalidate({ includeAnalysis: true }); release(); await pending;
  const task = graph.snapshot().nodes.find(n => n.id === 'a');
  assert.equal(task.history[0].status, 'superseded'); assert.equal(task.status, 'pending'); assert.equal(graph.prepareCompletion().ready, false);
});

test('scoped review reuse cannot hide newly changed files outside the planned scopes', async () => {
  let changed = ['a.txt'], revision = 0, calls = 0;
  const graph = createTaskGraph({ getChangedPaths: () => changed, getRevision: () => revision,
    isReportCurrent: () => true, executeTask: async () => { calls++; return result(); } });
  graph.plan({ tasks: [spec('a')] }); await graph.execute();
  changed.push('b.txt'); revision++; await graph.execute(); assert.equal(calls, 1);
  assert.match(graph.prepareCompletion().reason, /b.txt/);
  assert.equal(graph.plan({ tasks: [spec('a'), spec('b')] }).planned, true); await graph.execute();
  assert.equal(graph.prepareCompletion().ready, true);
});

test('invalid instance plan cannot mutate validation requirements, and snapshots have a monotonic sequence', () => {
  const snapshots = [], runtime = createOrchestrationRuntime(), policy = collaborationPolicy({ collaborationTier: 'full' });
  const orchestrator = createOrchestrator({ policy, requestRuntime: runtime, onChange: value => snapshots.push(value) });
  orchestrator.enableWorkers({ executeTask: async () => result() });
  orchestrator.workflow.plan({ scenario: 'answer', summary: '解释' });
  assert.ok(orchestrator.plan({ scenario: 'research', summary: '核查', tasks: [spec('a', 'editor')] }).error);
  assert.equal(orchestrator.workflow.snapshot().scenario, 'answer');
  orchestrator.toolStart({ toolCallId: 'r1', name: 'read_file', input: { path: 'a.txt' } });
  const sequence = snapshots.map(s => s.sequence);
  assert.ok(sequence.every((n, i) => !i || n > sequence[i - 1]));
  assert.equal(snapshots.at(-1).kind, 'orchestration');
});

test('explicit lite only dispatches incremental review; full uses task instances; legacy remains compatible', async () => {
  for (const tier of ['lite', 'full']) {
    const calls = [], orchestrator = createOrchestrator({ policy: collaborationPolicy({ collaborationTier: tier }), requestRuntime: createOrchestrationRuntime() });
    const graph = orchestrator.enableWorkers({ executeTask: async task => { calls.push(task.role); return result(); } });
    await graph.autoExecute({ phase: 'analysis', scenario: 'edit', readScope: ['a.txt'] });
    await graph.autoExecute({ phase: 'review', scenario: 'edit', changedPaths: ['a.txt'], requireCompile: true });
    assert.deepEqual(calls, tier === 'lite' ? ['reviewer'] : ['analyst', 'reviewer', 'verifier']);
    assert.equal(graph.snapshot().version, 4);
    assert.equal((await graph.autoExecute({ phase: 'review', scenario: 'edit', changedPaths: ['a.txt'], requireCompile: true })).executed, false);
  }
});

test('automatic review uses current compilation evidence and still dispatches content review', async () => {
  for (const config of [{ graphOrchestration: true }, { collaborationTier: 'full' }, { collaborationTier: 'deep' }]) {
    const calls = [];
    const orchestrator = createOrchestrator({ policy: collaborationPolicy(config), requestRuntime: createOrchestrationRuntime() });
    const graph = orchestrator.enableWorkers({ executeTask: async task => { calls.push(task.role); return result(); } });
    const review = { phase: 'review', scenario: 'edit', summary: '核对改稿', changedPaths: ['main.tex'], requireCompile: true };
    assert.equal((await graph.autoExecute({ ...review, compileSucceeded: true })).ready, true);
    assert.deepEqual(calls, ['reviewer']);
    assert.equal((await graph.autoExecute({ ...review, compileSucceeded: false })).ready, true);
    assert.deepEqual(calls, ['reviewer', 'verifier']);
  }
});


test('changing a completed task preserves globally unique attempt identities across replanning', async () => {
  const graph = createTaskGraph({ executeTask: async () => result() });
  graph.plan({ tasks: [spec('a')] }); await graph.execute();
  graph.plan({ tasks: [{ ...spec('a'), objective: '核对新的验收条件' }] }); await graph.execute();
  const task = graph.snapshot().nodes.find(n => n.id === 'a');
  assert.deepEqual(task.history.map(h => h.executionId), ['a-1', 'a-2']); assert.equal(task.executionId, 'a-2');
});

test('changing scenario invalidates the same verifier specification', async () => {
  let calls = 0; const graph = createTaskGraph({ executeTask: async () => { calls++; return result(); } });
  graph.plan({ scenario: 'answer', tasks: [spec('a', 'verifier')] }); await graph.execute();
  graph.plan({ scenario: 'compile', tasks: [spec('a', 'verifier')] });
  assert.equal(graph.prepareCompletion().ready, false); await graph.execute(); assert.equal(calls, 2);
});

// ACT-06: instance-mode resource takeover mirrors the legacy role-graph evidence rules.
const resourceBlocked = (code = 'time_limit') => ({ ...result('blocked'),
  resourceFailure: { code, usedTokens: 39000, elapsedMs: 600000, readPaths: ['main.tex'], sourceRead: true } });
const node = (g, id) => g.snapshot().nodes.find(n => n.id === id);

test('instance analysis takeover requires real read/source evidence and preserves the blocked verdict', async () => {
  const graph = createTaskGraph({ executeTask: async () => resourceBlocked() });
  graph.plan({ tasks: [spec('analysis', 'analyst'), spec('researcher', 'researcher')] });
  await graph.execute({ phase: 'analysis' });
  assert.equal(graph.takeOverResourceFailures({ phase: 'analysis' }).takenOver, false);
  const analysis = graph.takeOverResourceFailures({ phase: 'analysis', readPaths: new Set(['main.tex']) });
  assert.equal(analysis.takenOver, true); assert.equal(analysis.ready, false);
  assert.deepEqual(analysis.takenOverAgents.map(n => n.id), ['analysis']);
  const research = graph.takeOverResourceFailures({ phase: 'analysis', readPaths: ['main.tex'], sourceRead: true });
  assert.equal(research.takenOver, true); assert.equal(research.ready, true);
  assert.equal(graph.beforeTool('edit_file'), null);
  assert.equal(node(graph, 'analysis').report.verdict, 'blocked');
  assert.equal(node(graph, 'analysis').status, 'completed');
  assert.equal(node(graph, 'analysis').history[0].report.verdict, 'blocked');
  assert.equal(node(graph, 'analysis').takeover.by, 'coordinator');
  assert.equal(node(graph, 'analysis').history[0].takeover.by, 'coordinator');
  assert.equal(graph.takeOverResourceFailures({ phase: 'analysis', readPaths: ['main.tex'], sourceRead: true }).takenOver, false);
  assert.equal(graph.prepareCompletion().ready, true);
  graph.finish('completed'); assert.equal(graph.snapshot().status, 'completed');
});

test('instance ordinary blocked and real-error findings cannot be bypassed by takeover', async () => {
  for (const outcome of [result('blocked'), { ...resourceBlocked(), report: { summary: '编译错误', verdict: 'blocked', findings: [{ severity: 'error', message: '真实编译失败' }] } }]) {
    const graph = createTaskGraph({ executeTask: async () => outcome });
    graph.plan({ tasks: [spec('analysis', 'analyst')] }); await graph.execute({ phase: 'analysis' });
    assert.equal(graph.takeOverResourceFailures({ phase: 'analysis', readPaths: ['main.tex'], sourceRead: true, workflowReady: true }).takenOver, false);
    assert.match(graph.beforeTool('edit_file'), /分析/);
  }
});

test('instance review takeover needs complete workflow evidence and does not fabricate independent pass', async () => {
  let revision = 0;
  const graph = createTaskGraph({ getRevision: () => revision, executeTask: async () => resourceBlocked() });
  graph.plan({ tasks: [spec('reviewer', 'reviewer'), spec('verifier', 'verifier')] });
  await graph.execute({ phase: 'review' });
  const facts = { phase: 'review', readPaths: ['main.tex'], compileSucceeded: true };
  assert.equal(graph.takeOverResourceFailures(facts).takenOver, false);
  const review = graph.takeOverResourceFailures({ ...facts, workflowReady: true });
  assert.equal(review.takenOver, true); assert.equal(review.ready, true);
  assert.equal(node(graph, 'reviewer').report.verdict, 'blocked');
  assert.equal(node(graph, 'verifier').report.verdict, 'blocked');
  assert.equal(graph.prepareCompletion().ready, true);
  revision = 1;
  assert.equal(graph.takeOverResourceFailures({ ...facts, workflowReady: true }).takenOver, false);
  assert.equal(graph.prepareCompletion().ready, false);
  assert.equal(node(graph, 'reviewer').history[0].takeover.by, 'coordinator');
  assert.equal(node(graph, 'reviewer').history[0].report.verdict, 'blocked');
});

test('instance takeover satisfies usable_report dependencies but never a required independent pass', async () => {
  const calls = [];
  const graph = createTaskGraph({ executeTask: async task => { calls.push(task.id); return task.id === 'analysis' ? resourceBlocked() : result(); } });
  graph.plan({ tasks: [spec('analysis', 'analyst'),
    spec('usable', 'reviewer', [{ taskId: 'analysis', requires: 'usable_report' }]),
    spec('strict', 'reviewer', [{ taskId: 'analysis', requires: 'pass' }])] });
  await graph.execute();
  assert.deepEqual(calls, ['analysis']);
  assert.equal(graph.takeOverResourceFailures({ phase: 'analysis', readPaths: ['main.tex'] }).takenOver, true);
  await graph.execute();
  assert.deepEqual(calls, ['analysis', 'usable']);
  assert.match(graph.prepareCompletion().reason, /strict/);
});

test('instance goal invalidation clears takeover and restores the analysis gate', async () => {
  const graph = createTaskGraph({ executeTask: async () => resourceBlocked() });
  graph.plan({ tasks: [spec('analysis', 'analyst')] }); await graph.execute({ phase: 'analysis' });
  assert.equal(graph.takeOverResourceFailures({ phase: 'analysis', readPaths: ['main.tex'] }).ready, true);
  graph.invalidate({ includeAnalysis: true });
  assert.equal(node(graph, 'analysis').takeover, undefined);
  assert.match(graph.beforeTool('edit_file'), /分析/);
});
