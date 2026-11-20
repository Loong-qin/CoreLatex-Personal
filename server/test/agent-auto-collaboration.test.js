import test from 'node:test';
import assert from 'node:assert/strict';
import { createMultiAgentGraph } from '../src/services/agent/multiAgentGraph.js';

const response = (verdict = 'pass') => ({ report: { verdict, summary: '已独立核对分配范围。', findings: [] }, toolCount: 1 });
const setup = (extra = {}) => {
  const calls = [];
  const graph = createMultiAgentGraph({ executeTask: async (task, context) => { calls.push({ task, context }); return response(); }, ...extra });
  graph.plan({ scenario: 'answer', summary: '用户当前请求', agents: [], automatic: true });
  return { graph, calls };
};
const args = { scenario: 'edit', summary: '用户当前请求' };

test('actual editing triggers independent analysis and review without model planning calls', async () => {
  let revision = 0;
  const { graph, calls } = setup({ getRevision: () => revision });
  const analyzed = await graph.autoExecute({ ...args, phase: 'analysis' });
  assert.equal(analyzed.executed, true); assert.equal(analyzed.ready, true);
  assert.deepEqual(calls.map(c => c.task.role), ['analyst']);
  revision++;
  const reviewed = await graph.autoExecute({ ...args, phase: 'review', changedPaths: ['main.tex'], requireCompile: true });
  assert.equal(reviewed.ready, true); assert.equal(reviewed.executed, true);
  assert.deepEqual(calls.map(c => c.task.role), ['analyst', 'reviewer', 'verifier']);
  assert.deepEqual(calls.at(-1).context.dependencies.map(d => d.role), ['analyst']);
  assert.equal(graph.prepareCompletion().ready, true);
  await graph.autoExecute({ ...args, phase: 'analysis' });
  await graph.autoExecute({ ...args, phase: 'review', changedPaths: ['main.tex'], requireCompile: true });
  assert.equal(calls.length, 3, 'review registration and unchanged inputs do not duplicate initial analysis');
  revision++;
  await graph.autoExecute({ ...args, phase: 'analysis' });
  await graph.autoExecute({ ...args, phase: 'review', changedPaths: ['main.tex'], requireCompile: true });
  assert.deepEqual(calls.map(c => c.task.role), ['analyst', 'reviewer', 'verifier', 'reviewer', 'verifier']);
});

test('plain answers and edits without net changes do not spawn decorative review workers', async () => {
  const { graph, calls } = setup();
  assert.equal((await graph.autoExecute({ phase: 'review' })).executed, false);
  assert.equal(calls.length, 0);
  await graph.autoExecute({ ...args, phase: 'analysis' });
  assert.equal((await graph.autoExecute({ ...args, phase: 'review', changedPaths: [] })).executed, false);
  assert.deepEqual(calls.map(c => c.task.role), ['analyst']);
});

test('source-backed work executes distinct analyst and researcher concurrently', async () => {
  const tasks = [];
  let running = 0, peak = 0;
  const { graph } = setup({ executeTask: async task => {
    tasks.push(task); running++; peak = Math.max(peak, running);
    await new Promise(resolve => setImmediate(resolve)); running--; return response();
  } });
  const input = { ...args, phase: 'analysis', needsSources: true, sourcePaths: ['source.txt'] };
  await graph.autoExecute(input);
  assert.equal(peak, 2);
  assert.deepEqual(tasks.map(t => t.role), ['analyst', 'researcher']);
  assert.notEqual(tasks[0].task, tasks[1].task);
  assert.match(tasks[1].task, /source.txt/);
  await graph.autoExecute(input); assert.equal(tasks.length, 2);
  await graph.autoExecute({ ...input, sourcePaths: ['source.txt', 'extra.txt'] });
  assert.equal(tasks.length, 4, 'new source scope requires new analysis');
});

test('explicit direct execution and explicitly selected roles override automatic role selection', async () => {
  for (const agents of [[], ['reviewer']]) {
    const { graph, calls } = setup();
    graph.plan({ ...args, agents });
    const result = await graph.autoExecute({ ...args, phase: 'analysis', needsSources: true });
    assert.deepEqual(result, { automatic: false, executed: false });
    await graph.execute({ phase: 'review' });
    assert.deepEqual(calls.map(c => c.task.role), agents);
  }
});

test('automatic failed specialists are cached until input changes and retain a blocked delivery', async () => {
  let calls = 0;
  const { graph } = setup({ executeTask: async () => { calls++; return response('blocked'); } });
  for (let i = 0; i < 4; i++) {
    assert.equal((await graph.autoExecute({ ...args, phase: 'analysis' })).ready, false);
  }
  assert.equal(calls, 1);
  assert.equal((await graph.autoExecute({ ...args, phase: 'review', changedPaths: ['main.tex'] })).ready, false);
  assert.equal(calls, 1, 'blocked dependencies do not start downstream review');
});

test('explicit scoped assignments reach only their intended worker and change the plan version', async () => {
  const { graph, calls } = setup();
  assert.ok(graph.plan({ ...args, agents: ['analyst'], assignments: { unknown: 'wrong role' } }).error);
  assert.ok(graph.plan({ ...args, agents: ['analyst'], assignments: { analyst: '' } }).error);
  graph.plan({ ...args, agents: ['analyst', 'researcher'], assignments: {
    analyst: '只核对 methods.tex 的段落结构', researcher: '只核对 data.csv 中的实验统计' } });
  await graph.execute({ phase: 'analysis' });
  assert.match(calls[0].task.task, /只核对 methods.tex/);
  assert.doesNotMatch(calls[0].task.task, /只核对 data.csv/);
  assert.match(calls[1].task.task, /只核对 data.csv/);
  const revision = graph.snapshot().planRevision;
  graph.plan({ ...args, agents: ['analyst', 'researcher'], assignments: { analyst: '只核对 results.tex 的结果描述' } });
  assert.ok(graph.snapshot().planRevision > revision);
  await graph.execute({ phase: 'analysis' });
  assert.match(calls[2].task.task, /只核对 results.tex/);
});
