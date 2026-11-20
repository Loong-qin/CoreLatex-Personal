import test from 'node:test';
import assert from 'node:assert/strict';
import { createMultiAgentGraph } from '../src/services/agent/multiAgentGraph.js';

const report = (verdict = 'pass', summary = '已独立检查') => ({ report: { summary, verdict, findings: [] }, toolCount: 1, usage: { input: 10, output: 3, cost: { total: 0.1 } } });
// Collaboration tests select their roles explicitly; the production default is direct execution.
const plan = (g, scenario = 'edit', extra = {}) => g.plan({ scenario, summary: '按照用户要求核查文稿并完成本轮任务',
  agents: ['analyst', ...(['edit', 'research'].includes(scenario) || extra.needsSources ? ['researcher'] : []),
    'reviewer', ...(['edit', 'compile', 'diagnose'].includes(scenario) ? ['verifier'] : [])], ...extra });
const item = (g, id) => g.snapshot().nodes.find(node => node.id === id);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

test('real workers run in two bounded forks and reviews receive detached dependency reports', async () => {
  const calls = [], gates = { analysis: deferred(), review: deferred() };
  let running = 0, peak = 0;
  const g = createMultiAgentGraph({ executeTask: async (task, context) => {
    calls.push({ task, context }); running++; peak = Math.max(peak, running);
    await gates[task.phase].promise; running--;
    if (task.phase === 'review') context.dependencies[0].report.summary = 'worker-local mutation';
    return report();
  } });
  assert.deepEqual(plan(g, 'edit', { sourcePaths: ['refs.bib'] }).agents, ['analyst', 'researcher', 'reviewer', 'verifier']);
  const analysis = g.execute({ phase: 'analysis' }); await tick();
  assert.deepEqual(calls.map(call => call.task.id), ['analysis', 'researcher']);
  assert.equal(g.snapshot().activeCount, 2);
  assert.match(g.beforeTool('edit_file'), /分析\/查证/);
  gates.analysis.resolve(); assert.equal((await analysis).ready, true);
  assert.equal(g.beforeTool('edit_file'), null);
  const review = g.execute({ phase: 'review' }); await tick();
  assert.deepEqual(calls.map(call => call.task.id), ['analysis', 'researcher', 'reviewer', 'verifier']);
  assert.match(g.beforeTool('run_in_workspace'), /等待/);
  assert.deepEqual(calls[2].context.dependencies.map(dep => dep.id), ['analysis', 'researcher']);
  gates.review.resolve(); assert.equal((await review).ready, true);
  assert.equal(peak, 2);
  assert.equal(item(g, 'analysis').report.summary, '已独立检查');
  assert.equal(item(g, 'reviewer').usage.input, 10);
  assert.equal(item(g, 'verifier').toolCount, 1);
  assert.equal(g.prepareCompletion().ready, true);
  g.finish('completed'); assert.equal(g.snapshot().status, 'completed');
  assert.equal(g.snapshot().activeCount, 0);
  assert.equal(g.snapshot().version, 2);
  assert.equal(g.snapshot().kind, 'multi_agent');
});

test('maxConcurrency=1 serializes workers and same-phase calls share the in-flight batch', async () => {
  const first = deferred(), calls = [];
  const g = createMultiAgentGraph({ maxConcurrency: 1, executeTask: async task => {
    calls.push(task.id); if (task.id === 'analysis') await first.promise; return report();
  } });
  plan(g, 'research');
  const a = g.execute({ phase: 'analysis' }), b = g.execute({ phase: 'analysis' });
  assert.equal(a, b); await tick(); assert.deepEqual(calls, ['analysis']);
  first.resolve(); await a; assert.deepEqual(calls, ['analysis', 'researcher']);
  await g.execute({ phase: 'analysis' }); assert.equal(calls.length, 2);
});

test('blocked dependencies prevent downstream workers and unchanged inputs cannot rerun them', async () => {
  const calls = []; let blocked = true, revision = 0;
  const g = createMultiAgentGraph({ getRevision: () => revision, executeTask: async task => {
    calls.push(task.id); return task.id === 'researcher' && blocked ? report('blocked', '缺少必要来源') : report();
  } });
  plan(g, 'research'); await g.execute({ phase: 'analysis' });
  assert.equal(item(g, 'researcher').status, 'failed');
  assert.equal((await g.execute({ phase: 'review' })).ready, false);
  assert.deepEqual(calls, ['analysis', 'researcher']);
  assert.deepEqual(item(g, 'reviewer').blockedBy, ['researcher']);
  blocked = false; await g.execute({ phase: 'analysis' });
  assert.deepEqual(calls, ['analysis', 'researcher']);
  assert.equal(item(g, 'researcher').report.verdict, 'blocked');
  revision++; await g.execute({ phase: 'analysis' }); await g.execute({ phase: 'review' });
  assert.deepEqual(calls, ['analysis', 'researcher', 'analysis', 'researcher', 'reviewer']);
  assert.equal(g.prepareCompletion().ready, true);
});

test('analysis needs_changes is useful context, while reviews must independently pass', async () => {
  let fixed = false, revision = 0;
  const g = createMultiAgentGraph({ getRevision: () => revision, executeTask: async task => report(
    task.phase === 'analysis' || task.id === 'reviewer' && !fixed ? 'needs_changes' : 'pass',
    task.phase === 'analysis' ? '建议修订论证' : fixed ? '修订已满足要求' : '论证仍有缺口') });
  plan(g); await g.execute({ phase: 'analysis' }); assert.equal(g.beforeTool('write_file'), null);
  assert.equal((await g.execute({ phase: 'review' })).ready, false);
  assert.match(g.prepareCompletion().reason, /论证仍有缺口/);
  fixed = true; await g.execute({ phase: 'review' });
  assert.equal(item(g, 'reviewer').attempts, 1);
  assert.equal(item(g, 'reviewer').report.verdict, 'needs_changes');
  revision++; await g.execute({ phase: 'review' }); assert.equal(g.prepareCompletion().ready, true);
  assert.equal(item(g, 'analysis').attempts, 1);
  assert.equal(item(g, 'verifier').attempts, 2);
  assert.equal(item(g, 'reviewer').attempts, 2);
  assert.equal(item(g, 'reviewer').toolCount, 2);
  assert.equal(item(g, 'reviewer').usage.cost.total, 0.2);
});

test('draft changes invalidate completed review reports but retain one-time analysis', async () => {
  let revision = 'draft-a'; const calls = [];
  const g = createMultiAgentGraph({ getRevision: () => revision, executeTask: async task => { calls.push(task.id); return report(); } });
  plan(g); await g.execute({ phase: 'analysis' }); await g.execute({ phase: 'review' });
  assert.equal(g.prepareCompletion().ready, true);
  revision = 'draft-b';
  assert.equal(item(g, 'reviewer').status, 'pending');
  assert.equal(item(g, 'reviewer').report, undefined);
  assert.equal(item(g, 'reviewer').lastRevision, 'draft-a');
  assert.equal(g.prepareCompletion().ready, false);
  await g.execute({ phase: 'review' }); assert.equal(g.prepareCompletion().ready, true);
  assert.equal(calls.filter(id => id === 'analysis').length, 1);
  assert.equal(item(g, 'verifier').revision, 'draft-b');
});

test('a revision change during worker execution makes its report stale instead of authorizing completion', async () => {
  let revision = 1; const barrier = deferred();
  const g = createMultiAgentGraph({ getRevision: () => revision, executeTask: async task => {
    if (task.phase === 'review') await barrier.promise;
    return report();
  } });
  plan(g, 'answer'); await g.execute({ phase: 'analysis' });
  const review = g.execute({ phase: 'review' }); await tick(); revision = 2; barrier.resolve();
  assert.equal((await review).ready, false);
  assert.equal(item(g, 'reviewer').report, undefined);
  assert.equal(item(g, 'reviewer').lastRevision, 1);
  assert.equal(g.prepareCompletion().ready, false);
  await g.execute({ phase: 'review' }); assert.equal(g.prepareCompletion().ready, true);
});

test('explicit replanning replaces selected roles, preserves history, and reuses unchanged reports', async () => {
  const calls = [];
  const g = createMultiAgentGraph({ executeTask: async task => { calls.push(task.id); return report(); } });
  plan(g, 'edit', { needsSources: true }); await g.execute({ phase: 'analysis' }); await g.execute({ phase: 'review' });
  plan(g, 'edit', { needsSources: true }); await g.execute({ phase: 'analysis' }); await g.execute({ phase: 'review' });
  assert.equal(calls.length, 4);
  const replanned = plan(g, 'answer');
  assert.deepEqual(replanned.agents, ['analyst', 'reviewer']); assert.equal(replanned.needsSources, false);
  assert.equal(g.prepareCompletion().ready, false);
  await g.execute({ phase: 'analysis' }); await g.execute({ phase: 'review' });
  assert.equal(g.prepareCompletion().ready, true);
  assert.equal(item(g, 'researcher').status, 'skipped');
  assert.equal(item(g, 'researcher').history[0].report.verdict, 'pass');
  assert.equal(item(g, 'verifier').attempts, 1);
});

test('adding source requirements after a prior review blocks edits until the newly required worker runs', async () => {
  const g = createMultiAgentGraph({ executeTask: async () => report() });
  plan(g, 'answer'); await g.execute({ phase: 'analysis' }); await g.execute({ phase: 'review' });
  plan(g, 'answer', { needsSources: true, sourcePaths: ['source.txt'] });
  assert.match(g.beforeTool('copy_to_project'), /查证/);
  assert.equal((await g.execute({ phase: 'review' })).ready, false);
  await g.execute({ phase: 'analysis' }); await g.execute({ phase: 'review' });
  assert.equal(item(g, 'analysis').attempts, 2);
  assert.equal(item(g, 'researcher').attempts, 1);
  assert.equal(g.prepareCompletion().ready, true);
});

test('completion followups include omitted execution and have a strict total limit', () => {
  const g = createMultiAgentGraph({ executeTask: async () => report() });
  assert.equal(g.prepareCompletion().failed, false);
  plan(g, 'answer'); assert.equal(g.prepareCompletion().failed, false);
  plan(g, 'edit'); assert.equal(g.prepareCompletion().failed, true);
  assert.equal(g.snapshot().status, 'failed');
  assert.ok(plan(g, 'answer').error);
  g.finish('completed'); assert.equal(g.snapshot().status, 'failed');
});

test('changed drafts keep scheduling beyond old execution quota while identical inputs reuse failures', async () => {
  let calls = 0, revision = 0;
  const g = createMultiAgentGraph({ maxExecutions: 3, getRevision: () => revision, executeTask: async () => { calls++; return report(); } });
  plan(g, 'edit'); await g.execute({ phase: 'analysis' });
  for (revision = 0; revision < 8; revision++) {
    assert.equal((await g.execute({ phase: 'review' })).ready, true);
    assert.equal(g.prepareCompletion().ready, true);
    const previous = calls; await g.execute({ phase: 'review' }); assert.equal(calls, previous);
  }
  assert.equal(calls, 18); assert.equal(item(g, 'reviewer').history.length, 8);
  assert.equal(g.snapshot().validationExecutionLimit, undefined);
});

test('invalid worker reports fail visibly and cannot be marked complete', async () => {
  const g = createMultiAgentGraph({ executeTask: async () => ({ report: { summary: 'trust me', verdict: 'pass' } }) });
  plan(g, 'answer'); await g.execute({ phase: 'analysis' });
  assert.equal(item(g, 'analysis').status, 'failed');
  assert.match(item(g, 'analysis').detail, /有效的结构化报告/);
  g.finish('completed'); assert.equal(g.snapshot().status, 'failed');
});

test('abort stops scheduling and ignores a late worker result even when the worker ignores cancellation', async () => {
  const controller = new AbortController(), late = deferred(), calls = [];
  const g = createMultiAgentGraph({ signal: controller.signal, maxConcurrency: 1, executeTask: async task => {
    calls.push(task.id); await late.promise; return report();
  } });
  plan(g, 'research'); const execution = g.execute({ phase: 'analysis' }); await tick();
  controller.abort(); await execution;
  assert.equal(g.snapshot().status, 'cancelled');
  assert.equal(g.snapshot().activeCount, 0);
  assert.deepEqual(calls, ['analysis']);
  late.resolve(); await tick();
  assert.equal(item(g, 'analysis').report, undefined);
  assert.notEqual(item(g, 'analysis').status, 'completed');
});

test('human waiting restores the coordinator, and cancellation cannot be converted to completion', async () => {
  const g = createMultiAgentGraph({ executeTask: async () => report() });
  plan(g, 'answer'); g.coordinatorToolStart('read_file'); g.wait();
  assert.equal(g.snapshot().status, 'waiting');
  assert.equal(item(g, 'coordinator').status, 'waiting');
  assert.equal((await g.execute({ phase: 'analysis' })).ready, false);
  g.resume(); assert.equal(item(g, 'coordinator').status, 'running');
  await g.execute({ phase: 'analysis' }); g.finish('cancelled'); g.finish('completed');
  assert.notEqual(g.snapshot().status, 'completed');
});

test('new user instructions invalidate all relevant agents and preserve earlier reports without a cumulative execution quota', async () => {
  const g = createMultiAgentGraph({ maxExecutions: 6, executeTask: async () => report() });
  plan(g, 'edit'); await g.execute({ phase: 'analysis' }); await g.execute({ phase: 'review' });
  assert.deepEqual(g.invalidate({ reason: '用户明确改为另一段', includeAnalysis: true }).invalidated, ['analysis', 'researcher', 'reviewer', 'verifier']);
  assert.equal(item(g, 'analysis').report, undefined);
  assert.equal(item(g, 'analysis').lastReport.verdict, 'pass');
  assert.equal(g.snapshot().executions, 4);
  assert.match(g.beforeTool('edit_file'), /analysis/);
  await g.execute({ phase: 'analysis' }); await g.execute({ phase: 'review' });
  assert.equal(g.snapshot().executions, 8);
  assert.equal(g.prepareCompletion().ready, true);
});

test('invalidate rejects in-flight changes and review-only invalidation does not repeat analysis', async () => {
  const barrier = deferred();
  const g = createMultiAgentGraph({ executeTask: async () => { await barrier.promise; return report(); } });
  plan(g, 'answer'); const running = g.execute({ phase: 'analysis' });
  assert.ok(g.invalidate({ includeAnalysis: true }).error);
  assert.ok(plan(g, 'research').error);
  barrier.resolve(); await running; await g.execute({ phase: 'review' });
  g.invalidate(); assert.equal(item(g, 'analysis').status, 'completed');
  await g.execute({ phase: 'review' }); assert.equal(item(g, 'analysis').attempts, 1);
  assert.equal(g.prepareCompletion().ready, true);
});

test('snapshots are detached, invalid input does not mutate plan, and diagnose verification asks for honest evidence', async () => {
  const snapshots = [], tasks = [];
  const g = createMultiAgentGraph({ onChange: value => snapshots.push(value), executeTask: async task => { tasks.push(task); return report(); } });
  assert.ok(plan(g, 'unknown').error);
  assert.ok(plan(g, 'research', { sourcePaths: ['../private'] }).error);
  plan(g, 'diagnose'); const before = g.snapshot(); before.nodes[0].status = 'completed';
  assert.equal(item(g, 'analysis').status, 'pending');
  await g.execute({ phase: 'analysis' }); await g.execute({ phase: 'review' });
  assert.match(tasks.find(task => task.id === 'verifier').task, /不要求修复编译错误/);
  assert.equal(snapshots[0].nodes[0].status, 'skipped');
  assert.equal(g.prepareCompletion().ready, true);
});

test('replanning a repair as diagnosis cannot relax the independent verification task', async () => {
  const tasks = [];
  const g = createMultiAgentGraph({ executeTask: async task => { tasks.push(task); return report(); } });
  plan(g, 'compile'); plan(g, 'diagnose');
  await g.execute({ phase: 'analysis' }); await g.execute({ phase: 'review' });
  assert.doesNotMatch(tasks.find(task => task.id === 'verifier').task, /不要求修复编译错误/);
});

test('every route defaults to direct execution without pretending skipped workers completed', async () => {
  for (const scenario of ['answer', 'compile', 'diagnose', 'edit', 'research']) {
    let calls = 0;
    const g = createMultiAgentGraph({ executeTask: async () => { calls++; return report(); } });
    const result = g.plan({ scenario, summary: '由主智能体直接处理', needsSources: true });
    assert.deepEqual(result.agents, []); assert.equal(result.next, 'direct');
    assert.equal(g.beforeTool('edit_file'), null);
    await g.execute({ phase: 'analysis' }); await g.execute({ phase: 'review' });
    assert.equal(g.prepareCompletion().ready, true); assert.equal(calls, 0);
    for (const n of g.snapshot().nodes.filter(n => n.id !== 'coordinator')) {
      assert.equal(n.status, 'skipped'); assert.equal(n.report, undefined);
      assert.match(n.detail, /主智能体直接处理，未分派此专项/);
    }
    g.finish('completed'); assert.equal(g.snapshot().status, 'completed');
    assert.equal(g.snapshot().executions, 0);
  }
  const edit = createMultiAgentGraph({ executeTask: async () => report() });
  plan(edit, 'edit', { agents: ['researcher'] });
  assert.equal(item(edit, 'researcher').status, 'pending');
  assert.match(item(edit, 'researcher').task, /本地正文.*不要求外部联网/);
  assert.doesNotMatch(item(edit, 'researcher').detail, /跳过|尚未规划/);
  assert.match(item(edit, 'reviewer').detail, /本轮未分派/);
});

test('worker execution instances preserve timestamps, per-attempt reports/usage, and old revisions', async () => {
  let revision = 0;
  const barrier = deferred(), tasks = [];
  const g = createMultiAgentGraph({ getRevision: () => revision, executeTask: async task => {
    tasks.push(task);
    if (task.id === 'analysis') await barrier.promise;
    return report();
  } });
  plan(g, 'answer');
  const running = g.execute({ phase: 'analysis' }); await tick();
  const active = item(g, 'analysis');
  assert.equal(active.executionId, 'analysis-1');
  assert.equal(typeof active.startedAt, 'number');
  assert.equal(active.finishedAt, null);
  assert.equal(active.history[0].status, 'running');
  assert.equal(tasks[0].startedAt, active.startedAt);
  assert.equal(tasks[0].scenario, 'answer');
  barrier.resolve(); await running; await g.execute({ phase: 'review' });
  const first = item(g, 'reviewer').history[0];
  assert.equal(first.executionId, 'reviewer-1');
  assert.equal(first.finishedAt - first.startedAt, first.durationMs);
  assert.equal(first.status, 'completed'); assert.equal(first.report.verdict, 'pass');
  assert.equal(first.toolCount, 1); assert.equal(first.usage.input, 10);
  revision++; await g.execute({ phase: 'review' });
  const current = item(g, 'reviewer');
  assert.equal(current.executionId, 'reviewer-2');
  assert.deepEqual(current.history[0], first);
  assert.deepEqual(current.history.map(entry => entry.revision), [0, 1]);
  assert.equal(current.toolCount, 2); assert.equal(current.history[1].toolCount, 1);
  assert.equal(current.usage.input, 20); assert.equal(current.history[1].usage.input, 10);
  g.invalidate({ includeAnalysis: true });
  assert.equal(item(g, 'reviewer').history.length, 2);
  assert.equal(item(g, 'analysis').history.length, 1);
  assert.equal(g.snapshot().nodes.reduce((sum, n) => sum + n.history.length, 0), g.snapshot().executions);
});

test('failed and cancelled worker instances keep a completed public audit entry without fake success', async () => {
  const failed = createMultiAgentGraph({ executeTask: async () => { throw new Error('公开的执行错误'); } });
  plan(failed, 'answer'); await failed.execute({ phase: 'analysis' });
  const entry = item(failed, 'analysis').history[0];
  assert.equal(entry.status, 'failed'); assert.match(entry.report.summary, /公开的执行错误/);
  assert.equal(entry.report.verdict, 'blocked'); assert.equal(typeof entry.finishedAt, 'number');
  const controller = new AbortController();
  const cancelled = createMultiAgentGraph({ signal: controller.signal, executeTask: async () => new Promise(() => {}) });
  plan(cancelled, 'answer'); const running = cancelled.execute({ phase: 'analysis' }); await tick();
  controller.abort(); await running;
  const cancelledEntry = item(cancelled, 'analysis').history[0];
  assert.equal(cancelledEntry.status, 'cancelled'); assert.equal(cancelledEntry.report.verdict, 'blocked');
  assert.equal(typeof cancelledEntry.finishedAt, 'number'); assert.ok(cancelledEntry.durationMs >= 0);
});

test('all worker outcomes are cached by draft and role scope, including provider exceptions', async () => {
  for (const outcome of ['pass', 'needs_changes', 'blocked', 'exception']) {
    let calls = 0, revision = 'draft-1';
    const g = createMultiAgentGraph({ getRevision: () => revision, executeTask: async () => {
      calls++; if (outcome === 'exception') throw new Error('provider unavailable');
      return report(outcome);
    } });
    plan(g, 'answer', { agents: ['reviewer'] });
    await g.execute({ phase: 'review' });
    const first = item(g, 'reviewer').history[0];
    for (let n = 0; n < 5; n++) await g.execute({ phase: 'review' });
    assert.equal(calls, 1, outcome); assert.deepEqual(item(g, 'reviewer').history[0], first);
    plan(g, 'answer', { agents: ['reviewer'], summary: '换个表述，职责范围不变' });
    await g.execute({ phase: 'review' }); assert.equal(calls, 1, 'display summary does not spend another worker execution');
    revision = 'draft-2'; await g.execute({ phase: 'review' }); assert.equal(calls, 2);
    plan(g, 'answer', { agents: ['reviewer'], assignments: { reviewer: '核查另一个明确任务' } });
    await g.execute({ phase: 'review' }); assert.equal(calls, 3);
    assert.deepEqual(item(g, 'reviewer').history.map(h => h.revision), ['draft-1', 'draft-2', 'draft-2']);
    assert.notEqual(item(g, 'reviewer').history[1].executionScope, item(g, 'reviewer').history[2].executionScope);
    const removal = plan(g, 'answer', { agents: [] });
    assert.deepEqual(removal.agents, outcome === 'pass' ? [] : ['reviewer']);
  }
});

test('role selection rejects invalid inputs and cannot erase a selected failing specialist', async () => {
  const g = createMultiAgentGraph({ executeTask: async () => report('needs_changes', '仍需修正') });
  assert.ok(plan(g, 'edit', { agents: 'reviewer' }).error);
  assert.ok(plan(g, 'edit', { agents: ['unknown'] }).error);
  assert.equal(g.snapshot().scenario, 'planning');
  plan(g, 'edit', { agents: ['reviewer'] });
  await g.execute({ phase: 'review' });
  plan(g, 'edit', { agents: [] });
  assert.equal(item(g, 'reviewer').status, 'completed');
  assert.equal(g.prepareCompletion().ready, false);
  assert.match(g.snapshot().detail, /仍需修正/);
});


const resourceBlocked = (code = 'time_limit') => ({ ...report('blocked', '调查时间已到，尚未完成专项'),
  resourceFailure: { code, usedTokens: 39000, elapsedMs: 600000, readPaths: ['main.tex'], sourceRead: true } });

test('legacy resource codes remain compatible without becoming new execution limits', async () => {
  for (const code of ['token_budget', 'turn_limit', 'tool_limit']) {
    const g = createMultiAgentGraph({ executeTask: async () => resourceBlocked(code) });
    plan(g, 'answer', { agents: ['analyst'] }); await g.execute({ phase: 'analysis' });
    assert.equal(g.takeOverResourceFailures({ phase: 'analysis' }).takenOver, false);
    assert.equal(g.takeOverResourceFailures({ phase: 'analysis', readPaths: ['main.tex'] }).takenOver, true);
    assert.equal(item(g, 'analysis').resourceFailure.code, code);
    assert.equal(item(g, 'analysis').history[0].resourceFailure.code, code);
    assert.equal(item(g, 'analysis').history[0].report.verdict, 'blocked');
  }
});

test('time-limited reports preserve pass, needs_changes and blocked verdicts without inventing failures or bypasses', async () => {
  for (const verdict of ['pass', 'needs_changes', 'blocked']) {
    const outcome = { ...resourceBlocked(), report: { summary: '依据已读取材料提交真实结论', verdict,
      findings: verdict === 'needs_changes' ? [{ severity: 'warning', path: 'main.tex', message: '真实问题仍需修改' }] : [] } };
    const g = createMultiAgentGraph({ executeTask: async () => outcome });
    plan(g, 'answer', { agents: ['reviewer'] }); const result = await g.execute({ phase: 'review' });
    const reviewer = item(g, 'reviewer');
    assert.equal(reviewer.report.verdict, verdict); assert.equal(reviewer.history[0].report.verdict, verdict);
    assert.equal(reviewer.status, verdict === 'blocked' ? 'failed' : 'completed');
    assert.equal(result.ready, verdict === 'pass');
    assert.equal(reviewer.resourceFailure?.code, verdict === 'blocked' ? 'time_limit' : undefined);
    assert.equal(g.takeOverResourceFailures({ phase: 'review', readPaths: ['main.tex'] }).takenOver, false);
    assert.equal(g.takeOverResourceFailures({ phase: 'review', readPaths: ['main.tex'], workflowReady: true }).takenOver, verdict === 'blocked');
    assert.equal(item(g, 'reviewer').report.verdict, verdict);
  }
});

test('coordinator may take over only resource-limited analysis using actual read/source evidence, preserving failure history', async () => {
  const g = createMultiAgentGraph({ executeTask: async () => resourceBlocked() });
  plan(g, 'edit', { agents: ['analyst', 'researcher'] }); await g.execute({ phase: 'analysis' });
  assert.equal(g.takeOverResourceFailures({ phase: 'analysis' }).takenOver, false);
  const analysis = g.takeOverResourceFailures({ phase: 'analysis', readPaths: new Set(['main.tex']) });
  assert.equal(analysis.takenOver, true); assert.equal(analysis.ready, false);
  assert.deepEqual(analysis.takenOverAgents.map(node => node.id), ['analysis']);
  const research = g.takeOverResourceFailures({ phase: 'analysis', readPaths: ['main.tex'], sourceRead: true });
  assert.equal(research.takenOver, true); assert.equal(research.ready, true);
  assert.equal(g.beforeTool('edit_file'), null);
  assert.equal(item(g, 'analysis').report.verdict, 'blocked');
  assert.equal(item(g, 'analysis').status, 'failed');
  assert.equal(item(g, 'analysis').history[0].report.verdict, 'blocked');
  assert.equal(item(g, 'analysis').takeover.by, 'coordinator');
  assert.equal(item(g, 'analysis').history[0].takeover.by, 'coordinator');
  assert.equal(item(g, 'analysis').history[0].status, 'failed');
  assert.equal(g.takeOverResourceFailures({ phase: 'analysis', readPaths: ['main.tex'], sourceRead: true }).takenOver, false);
  assert.equal(g.prepareCompletion().ready, true);
  g.finish('completed'); assert.equal(g.snapshot().status, 'completed');
});

test('ordinary blocked reports and real findings cannot be bypassed using coordinator takeover', async () => {
  for (const outcome of [report('blocked', '权限失效'), { ...resourceBlocked(), report: { summary: '编译错误', verdict: 'blocked', findings: [{ severity: 'error', message: '真实编译失败' }] } }]) {
    const g = createMultiAgentGraph({ executeTask: async () => outcome });
    plan(g, 'answer', { agents: ['analyst'] }); await g.execute({ phase: 'analysis' });
    assert.equal(g.takeOverResourceFailures({ phase: 'analysis', readPaths: ['main.tex'], sourceRead: true, workflowReady: true }).takenOver, false);
    assert.match(g.beforeTool('edit_file'), /分析/);
  }
});

test('review resource takeover requires complete workflow evidence for the current draft and does not fabricate independent pass', async () => {
  let revision = 'draft-1';
  const g = createMultiAgentGraph({ getRevision: () => revision, executeTask: async () => resourceBlocked() });
  plan(g, 'compile', { agents: ['reviewer', 'verifier'] }); await g.execute({ phase: 'review' });
  const facts = { phase: 'review', readPaths: ['main.tex'], compileSucceeded: true };
  assert.equal(g.takeOverResourceFailures(facts).takenOver, false);
  const review = g.takeOverResourceFailures({ ...facts, workflowReady: true });
  assert.equal(review.takenOver, true); assert.equal(review.ready, true);
  assert.equal(item(g, 'reviewer').report.verdict, 'blocked');
  assert.equal(item(g, 'verifier').report.verdict, 'blocked');
  assert.equal(g.prepareCompletion().ready, true);
  revision = 'draft-2';
  assert.equal(g.takeOverResourceFailures({ ...facts, workflowReady: true }).takenOver, false);
  assert.equal(item(g, 'reviewer').takeover, undefined);
  assert.equal(item(g, 'reviewer').history[0].takeover.by, 'coordinator');
  assert.equal(item(g, 'reviewer').history[0].report.verdict, 'blocked');
  assert.equal(g.prepareCompletion().ready, false);
});

test('new task requirements invalidate resource takeover and prevent reuse of unrelated failed evidence', async () => {
  const g = createMultiAgentGraph({ executeTask: async () => resourceBlocked() });
  plan(g, 'answer', { agents: ['analyst'] }); await g.execute({ phase: 'analysis' });
  assert.equal(g.takeOverResourceFailures({ phase: 'analysis', readPaths: ['main.tex'] }).ready, true);
  plan(g, 'answer', { agents: ['analyst'], assignments: { analyst: '全新要求，需要核查另一段内容' } });
  assert.equal(g.takeOverResourceFailures({ phase: 'analysis', readPaths: ['main.tex'] }).takenOver, false);
  assert.match(g.beforeTool('edit_file'), /分析/);
});


test('resource-only researcher can be deselected while narrowly reassigning analyst without repeating all work', async () => {
  const calls = [];
  const g = createMultiAgentGraph({ executeTask: async task => { calls.push(task.role); return resourceBlocked(); } });
  plan(g, 'edit', { agents: ['analyst', 'researcher'], needsSources: true, sourcePaths: ['refs.bib'] });
  await g.execute({ phase: 'analysis' });
  const oldResearch = item(g, 'researcher').history[0];
  const replanned = plan(g, 'edit', { agents: ['analyst'], needsSources: false, assignments: { analyst: '只检查目标段落术语是否一致' } });
  assert.deepEqual(replanned.agents, ['analyst']); assert.equal(replanned.needsSources, false);
  assert.deepEqual(replanned.sourcePaths, []);
  await g.execute({ phase: 'analysis' });
  assert.deepEqual(calls, ['analyst', 'researcher', 'analyst']);
  assert.deepEqual(item(g, 'researcher').history[0], oldResearch);
  assert.equal(item(g, 'researcher').status, 'skipped');
  assert.equal(item(g, 'analysis').attempts, 2);
});

test('changing one assignment only reruns that analyst and downstream reviews; explicit user invalidation still reruns unchanged scopes', async () => {
  const calls = [];
  const g = createMultiAgentGraph({ executeTask: async task => { calls.push(task.role); return report(); } });
  plan(g, 'edit'); await g.execute({ phase: 'analysis' }); await g.execute({ phase: 'review' });
  plan(g, 'edit', { summary: '显示摘要改写', assignments: { analyst: '仅分析第二段' } });
  assert.match(g.beforeTool('edit_file'), /分析/);
  await g.execute({ phase: 'analysis' }); await g.execute({ phase: 'review' });
  assert.deepEqual(calls, ['analyst', 'researcher', 'reviewer', 'verifier', 'analyst', 'reviewer', 'verifier']);
  g.invalidate({ includeAnalysis: true, reason: '用户更改了实际目标，分工字面保持不变' });
  await g.execute({ phase: 'analysis' }); await g.execute({ phase: 'review' });
  assert.deepEqual(calls.slice(-4), ['analyst', 'researcher', 'reviewer', 'verifier']);
});

test('completed roles may be deselected and selected again without wasting unchanged execution results', async () => {
  let calls = 0;
  const g = createMultiAgentGraph({ executeTask: async () => { calls++; return report(); } });
  plan(g, 'answer', { agents: ['analyst'] }); await g.execute({ phase: 'analysis' });
  plan(g, 'answer', { agents: [] }); assert.deepEqual(g.snapshot().agents, []);
  plan(g, 'answer', { agents: ['analyst'] }); await g.execute({ phase: 'analysis' });
  assert.equal(calls, 1); assert.equal(g.beforeTool('edit_file'), null);
});


test('new user goals invalidate deselected worker caches before a later re-selection', async () => {
  let calls = 0;
  const g = createMultiAgentGraph({ executeTask: async () => { calls++; return report(); } });
  plan(g, 'answer', { agents: ['analyst'] }); await g.execute({ phase: 'analysis' });
  plan(g, 'answer', { agents: [] });
  g.invalidate({ includeAnalysis: true, reason: '用户已更换目标' });
  plan(g, 'answer', { agents: ['analyst'] });
  assert.match(g.beforeTool('edit_file'), /分析/);
  await g.execute({ phase: 'analysis' });
  assert.equal(calls, 2); assert.equal(item(g, 'analysis').history.length, 2);
});


test('four editors use bounded concurrency without spending analysis and review execution capacity', async () => {
  let revision = 0, running = 0, peak = 0;
  const calls = [], gate = deferred();
  const g = createMultiAgentGraph({ maxExecutions: 6, maxConcurrency: 2, getRevision: () => revision,
    executeTask: async task => {
      calls.push(task); running++; peak = Math.max(peak, running);
      if (task.role === 'editor') await gate.promise;
      running--; return { ...report(), ...(task.role === 'editor' ? { proposedChanges: [{ path: task.scope[0].path, before: 'A', after: 'B' }] } : {}) };
    } });
  plan(g, 'edit'); await g.execute({ phase: 'analysis' });
  const tasks = Array.from({ length: 4 }, (_, index) => ({ id: `part-${index}`, task: `修订第${index}个文件`, scope: [{ path: `part-${index}.tex` }] }));
  const pending = g.executeEditors({ tasks }); await tick();
  assert.equal(calls.filter(t => t.role === 'editor').length, 2); assert.equal(g.snapshot().activeCount, 2);
  assert.match(g.beforeTool('run_parallel_edits'), /等待/);
  gate.resolve(); const edited = await pending;
  assert.equal(edited.ready, true); assert.equal(edited.results.length, 4); assert.equal(peak, 2);
  assert.deepEqual(edited.results.map(result => result.id), tasks.map(task => task.id));
  assert.ok(edited.results.every(result => result.proposedChanges.length === 1));
  assert.equal(g.snapshot().executions, 6); assert.equal(g.snapshot().validationExecutions, 2);
  revision++; assert.equal((await g.execute({ phase: 'review' })).ready, true);
  assert.equal(g.snapshot().executions, 8); assert.equal(g.snapshot().validationExecutions, 4);
  assert.equal(g.snapshot().validationExecutionLimit, undefined); assert.equal(g.prepareCompletion().ready, true);
  const editors = g.snapshot().nodes.filter(node => node.role === 'editor');
  assert.equal(editors.length, 4); assert.ok(editors.every(node => node.history.length === 1 && node.history[0].phase === 'edit'));
  assert.deepEqual(editors.map(node => node.editorTaskId), tasks.map(task => task.id));
});

test('cancelled editor fan-out never reports ready or starts its queued jobs', async () => {
  const abort = new AbortController(), gate = deferred(), calls = [];
  const g = createMultiAgentGraph({ signal: abort.signal, executeTask: async task => { calls.push(task); await gate.promise; return report(); } });
  plan(g, 'edit', { agents: [] });
  const tasks = Array.from({ length: 4 }, (_, index) => ({ id: String(index), task: '修订文件', scope: [{ path: `${index}.tex` }] }));
  const pending = g.executeEditors({ tasks }); await tick(); abort.abort();
  const result = await pending;
  assert.equal(result.ready, false); assert.equal(result.cancelled, true); assert.equal(calls.length, 2);
  gate.resolve(); await tick(); assert.equal(g.snapshot().activeCount, 0);
  assert.ok(g.snapshot().nodes.filter(node => node.role === 'editor').every(node => node.status !== 'completed'));
});


test('research without manuscript changes does not automatically run a revision reviewer', async () => {
  const calls = [];
  const g = createMultiAgentGraph({ executeTask: async task => { calls.push(task.role); return report(); } });
  await g.autoExecute({ phase: 'analysis', scenario: 'research', summary: '核对来源事实' });
  const review = await g.autoExecute({ phase: 'review', scenario: 'research', changedPaths: [] });
  assert.equal(review.ready, true);
  assert.deepEqual(calls.sort(), ['analyst', 'researcher']);
  assert.equal(item(g, 'reviewer').status, 'skipped');
  assert.equal(g.prepareCompletion().ready, true);
});

test('optional review suggestions never create a repair gate and the same draft reuses their result', async () => {
  let calls = 0;
  const g = createMultiAgentGraph({ executeTask: async task => {
    calls++;
    return task.role === 'reviewer' ? { report: { summary: '可以优化措辞。', verdict: 'needs_changes',
      findings: [{ category: 'suggestion', severity: 'warning', message: '建议更高雅的表达。' }] }, toolCount: 0 } : report();
  } });
  plan(g, 'edit', { agents: ['analyst', 'reviewer'] });
  await g.execute({ phase: 'analysis' }); await g.execute({ phase: 'review' });
  assert.equal(g.prepareCompletion().ready, true);
  assert.equal(item(g, 'reviewer').report.verdict, 'pass');
  assert.deepEqual(item(g, 'reviewer').report.findings, []);
  await g.execute({ phase: 'review' }); assert.equal(calls, 2);
});
