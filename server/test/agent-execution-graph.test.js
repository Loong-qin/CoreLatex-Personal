import test from 'node:test';
import assert from 'node:assert/strict';
import { createExecutionGraph } from '../src/services/agent/executionGraph.js';

function fixture(options = {}) {
  let time = 1_000;
  const changes = [];
  const graph = createExecutionGraph({ task: '处理本轮明确任务', now: () => time, onChange: value => changes.push(value), ...options });
  return { graph, changes, advance: (ms = 10) => { time += ms; } };
}
function tool(graph, name, id, { succeeded = true, ...extra } = {}) {
  const event = { name, toolCallId: id, ...extra };
  graph.toolStart(event); graph.toolEnd({ ...event, succeeded, status: succeeded ? 'end' : 'error' });
}
const stages = graph => graph.snapshot().nodes.filter(node => node.type === 'stage');
const agents = graph => graph.snapshot().nodes.filter(node => node.type === 'agent');
const task = (id, executionId = id + '-1') => ({ id, executionId, role: id === 'analysis' ? 'analyst' : id, label: id + '智能体', task: '处理独立专项', phase: 'analysis', revision: 1, startedAt: 1010 });
const report = summary => ({ summary, verdict: 'pass', findings: [] });

test('the graph starts with only the actual coordinator and grows from observed work', () => {
  const { graph } = fixture();
  const initial = graph.snapshot();
  assert.equal(initial.version, 3); assert.equal(initial.kind, 'execution');
  assert.deepEqual(initial.nodes.map(node => node.id), ['coordinator']);
  assert.deepEqual(initial.edges, []); assert.equal(initial.stageCount, 0); assert.equal(initial.toolCount, 0);
  graph.responseStart(); graph.responseEnd(); graph.finish('completed');
  const final = graph.snapshot();
  assert.deepEqual(final.nodes.map(node => node.type), ['coordinator', 'delivery']);
  assert.equal(final.responseCount, 1); assert.equal(final.activeAgentCount, 0); assert.equal(final.status, 'completed');
  assert.equal(final.nodes.some(node => ['analyst', 'researcher', 'reviewer', 'verifier'].includes(node.role)), false);
});

test('consecutive reads merge into one real phase while different work creates new phases', () => {
  const { graph } = fixture();
  tool(graph, 'read_file', 'read-1', { input: { path: 'intro.tex' } });
  const readStageId = stages(graph)[0].id;
  tool(graph, 'read_file', 'read-2', { input: { path: 'results.tex' } });
  assert.equal(stages(graph).length, 1); assert.equal(stages(graph)[0].id, readStageId);
  assert.equal(stages(graph)[0].toolCount, 2); assert.equal(stages(graph)[0].visits, 2);
  assert.deepEqual(stages(graph)[0].tools.map(item => item.summary), ['intro.tex', 'results.tex']);
  tool(graph, 'run_in_workspace', 'command-1');
  assert.deepEqual(stages(graph).map(node => node.phase), ['context', 'command']);
  assert.equal(graph.snapshot().toolCount, 3);
  assert.ok(graph.snapshot().edges.some(edge => edge.from === readStageId && edge.to === stages(graph)[1].id));
});

test('failed compile, repair and revalidation preserve the failed attempt and actual loop', () => {
  const { graph, advance } = fixture();
  tool(graph, 'compile_and_preview', 'compile-1', { succeeded: false, summary: 'Undefined control sequence' });
  const failedId = stages(graph)[0].id; advance(20);
  tool(graph, 'edit_file', 'repair-1'); advance(20);
  tool(graph, 'compile_and_preview', 'compile-2');
  graph.finish('completed');
  const phases = stages(graph);
  assert.deepEqual(phases.map(node => [node.phase, node.status]), [['verify', 'failed'], ['edit', 'completed'], ['verify', 'completed']]);
  assert.equal(phases[0].id, failedId); assert.notEqual(phases[0].id, phases[2].id);
  assert.match(phases[0].detail, /Undefined control sequence/);
  assert.ok(graph.snapshot().edges.some(edge => edge.from === failedId && edge.to === phases[1].id && /失败/.test(edge.label)));
  assert.equal(graph.snapshot().toolCount, 3);
});

test('parallel child executions fork from their real dispatch and join through their returned reports', () => {
  const { graph, advance } = fixture();
  graph.toolStart({ name: 'run_agent_graph', toolCallId: 'dispatch-1' });
  const dispatch = stages(graph)[0];
  graph.agentStart(task('analysis')); graph.agentStart(task('researcher'));
  const running = graph.snapshot();
  assert.equal(running.activeAgentCount, 2);
  for (const child of agents(graph)) assert.ok(running.edges.some(edge => edge.from === dispatch.id && edge.to === child.id && edge.type === 'dispatch'));
  assert.equal(running.edges.some(edge => edge.from.startsWith('agent-') && edge.to.startsWith('agent-')), false);
  tool(graph, 'read_file', 'child-read-1', { executionId: 'analysis-1', input: { path: 'main.tex' } });
  tool(graph, 'read_file', 'child-read-1', { executionId: 'researcher-1', input: { path: 'source.txt' } });
  advance(100);
  graph.agentEnd({ executionId: 'analysis-1', report: report('范围明确'), toolCount: 1 });
  assert.equal(graph.snapshot().activeAgentCount, 1);
  graph.agentEnd({ executionId: 'researcher-1', report: report('来源已核查'), toolCount: 1 });
  graph.toolEnd({ name: 'run_agent_graph', toolCallId: 'dispatch-1', succeeded: true });
  graph.responseStart();
  const integration = stages(graph).find(node => node.phase === 'integration');
  assert.ok(integration);
  for (const child of agents(graph)) assert.ok(graph.snapshot().edges.some(edge => edge.from === child.id && edge.to === integration.id && edge.type === 'handoff'));
  graph.responseEnd(); graph.finish('completed');
  assert.equal(agents(graph).length, 2); assert.equal(graph.snapshot().activeAgentCount, 0);
  assert.deepEqual(agents(graph).map(node => node.toolCount), [1, 1]);
  assert.equal(graph.snapshot().toolCount, 3);
});

test('reused collaboration results do not invent another child execution or replace prior reports', () => {
  const { graph } = fixture();
  graph.agentStart(task('reviewer'));
  graph.agentEnd({ executionId: 'reviewer-1', report: report('首次真实审阅'), toolCount: 1 });
  graph.responseStart(); graph.responseEnd();
  tool(graph, 'run_agent_graph', 'cached-dispatch');
  graph.agentStart(task('reviewer'));
  graph.agentEnd({ executionId: 'reviewer-1', report: report('不应覆盖历史报告'), toolCount: 3 });
  assert.equal(agents(graph).length, 1); assert.equal(agents(graph)[0].report.summary, '首次真实审阅');
  assert.equal(agents(graph)[0].toolCount, 1);
});

test('a new revision keeps a separate child execution and old verdict', () => {
  const { graph } = fixture();
  graph.agentStart(task('reviewer', 'reviewer-1'));
  graph.agentEnd({ executionId: 'reviewer-1', report: { ...report('需要修复'), verdict: 'needs_changes' } });
  graph.responseStart(); graph.responseEnd(); tool(graph, 'edit_file', 'repair');
  graph.agentStart({ ...task('reviewer', 'reviewer-2'), revision: 2 });
  graph.agentEnd({ executionId: 'reviewer-2', report: report('修订通过') });
  assert.deepEqual(agents(graph).map(node => [node.executionId, node.report.verdict]), [['reviewer-1', 'needs_changes'], ['reviewer-2', 'pass']]);
});

test('duplicate tool events with stable call IDs are idempotent and worker IDs namespace calls', () => {
  const { graph, changes } = fixture();
  const call = { name: 'read_file', toolCallId: 'same' };
  graph.toolStart(call); graph.toolStart(call); graph.toolEnd({ ...call, succeeded: true });
  const before = graph.snapshot(), published = changes.length;
  graph.toolEnd({ ...call, succeeded: true }); graph.toolStart(call);
  assert.deepEqual(graph.snapshot(), before); assert.equal(changes.length, published);
  graph.agentStart(task('researcher'));
  tool(graph, 'read_file', 'same', { executionId: 'researcher-1' });
  assert.equal(graph.snapshot().toolCount, 2); assert.equal(agents(graph)[0].toolCount, 1);
});

test('an observed tool completion can reconstruct one call without a start, but never a synthetic worker', () => {
  const { graph } = fixture();
  graph.toolEnd({ name: 'read_file', toolCallId: 'recovered', succeeded: true });
  graph.toolEnd({ name: 'read_file', toolCallId: 'recovered', succeeded: true });
  graph.toolEnd({ name: 'web_fetch', toolCallId: 'unknown-child', executionId: 'not-started', succeeded: true });
  assert.equal(graph.snapshot().toolCount, 1); assert.equal(stages(graph)[0].tools[0].status, 'completed');
  assert.equal(agents(graph).length, 0);
});

test('cancellation finalizes open work and ignores all late successes and reports', () => {
  const { graph } = fixture();
  graph.toolStart({ name: 'run_agent_graph', toolCallId: 'fork' });
  graph.agentStart(task('verifier'));
  graph.toolStart({ name: 'compile_and_preview', executionId: 'verifier-1', toolCallId: 'compile' });
  graph.finish('cancelled', '用户停止执行');
  const stopped = graph.snapshot();
  assert.equal(stopped.status, 'cancelled'); assert.equal(stopped.activeCount, 0); assert.equal(stopped.activeAgentCount, 0);
  assert.equal(agents(graph)[0].status, 'cancelled'); assert.equal(agents(graph)[0].tools[0].status, 'cancelled');
  graph.toolEnd({ name: 'compile_and_preview', executionId: 'verifier-1', toolCallId: 'compile', succeeded: true });
  graph.agentEnd({ executionId: 'verifier-1', status: 'completed', report: report('迟到结果') });
  graph.responseStart(); graph.note('迟到状态'); graph.agentStart(task('reviewer')); graph.finish('completed');
  assert.deepEqual(graph.snapshot(), stopped);
});

test('unfinished work is never converted into success by a terminal completed event', () => {
  const { graph } = fixture();
  graph.agentStart(task('verifier'));
  graph.toolStart({ name: 'compile_and_preview', executionId: 'verifier-1', toolCallId: 'compile' });
  graph.finish('completed');
  assert.equal(agents(graph)[0].status, 'interrupted');
  assert.equal(agents(graph)[0].tools[0].status, 'interrupted');
});

test('snapshots, observer payloads and caller-owned reports remain detached from the live graph', () => {
  const { graph, changes } = fixture();
  graph.agentStart(task('reviewer'));
  const returned = report('真实结论');
  graph.agentEnd({ executionId: 'reviewer-1', report: returned, usage: { input: 10 } });
  returned.summary = '外部改写';
  const snapshot = graph.snapshot(); snapshot.nodes.find(node => node.type === 'agent').report.summary = '快照改写';
  changes.at(-1).nodes.length = 0;
  assert.equal(agents(graph)[0].report.summary, '真实结论'); assert.equal(agents(graph)[0].usage.input, 10);
});

test('bounded graph stages and retained tool details do not lose total executed-call counts', () => {
  const { graph } = fixture({ maxStages: 2 });
  for (let i = 0; i < 50; i++) tool(graph, i % 2 ? 'compile_and_preview' : 'edit_file', 'call-' + i);
  graph.finish('completed');
  const snapshot = graph.snapshot();
  assert.equal(snapshot.toolCount, 50); assert.equal(snapshot.nodes.find(node => node.id === 'coordinator').toolCount, 50);
  assert.ok(stages(graph).length <= 3); assert.ok(stages(graph).some(node => node.aggregated));
  assert.ok(stages(graph).every(node => node.tools.length <= 8));
  assert.equal(new Set(snapshot.nodes.map(node => node.id)).size, snapshot.nodes.length);
});

test('cancelling while handling a child report cannot mark the integration response completed', () => {
  const g=createExecutionGraph();
  g.agentStart({id:'analysis',role:'analyst',label:'分析智能体',executionId:'analysis-1'});
  g.agentEnd({executionId:'analysis-1',status:'completed',report:{verdict:'pass',summary:'已返回可验证报告',findings:[]}});
  g.responseStart();
  const current=g.snapshot().currentNode; assert.notEqual(current,'coordinator');
  g.finish('cancelled');
  assert.equal(g.snapshot().nodes.find(node=>node.id===current).status,'cancelled');
});
test('public snapshots redact text in task, progress, tool summaries and nested reports', () => {
  const g=createExecutionGraph({task:'private-key request',redact:text=>text.replaceAll('private-key','[redacted]')});
  g.note('private-key progress');
  g.toolStart({name:'read_file',toolCallId:'read-1',summary:'private-key file'});
  g.agentStart({id:'reviewer',role:'reviewer',label:'审阅智能体',executionId:'reviewer-1',task:'private-key task'});
  g.agentEnd({executionId:'reviewer-1',report:{verdict:'pass',summary:'private-key report',findings:[{message:'private-key finding'}]}});
  assert.equal(JSON.stringify(g.snapshot()).includes('private-key'),false);
});


test('model retries update only the actual actor and never invent another child execution', () => {
  const { graph } = fixture();
  graph.agentStart(task('researcher'));
  graph.note('子智能体重新连接', { executionId: 'researcher-1', phase: 'retry' });
  graph.note('主智能体重新连接', { phase: 'retry' });
  assert.equal(agents(graph).length, 1);
  assert.equal(agents(graph)[0].retryCount, 1); assert.equal(agents(graph)[0].phase, 'retry');
  assert.equal(graph.snapshot().nodes.find(node => node.id === 'coordinator').retryCount, 1);
  assert.equal(graph.snapshot().toolCount, 0);
});

test('failed report-integration response preserves its failure instead of closing it successfully', () => {
  const { graph } = fixture();
  graph.agentStart(task('reviewer'));
  graph.agentEnd({ executionId: 'reviewer-1', report: report('专项报告') });
  graph.responseStart(); graph.responseEnd({ succeeded: false }); graph.finish('failed');
  assert.equal(stages(graph).find(node => node.phase === 'integration').status, 'failed');
});

for (const status of ['cancelled', 'failed']) test(status + ' during an unfinished report integration must not fabricate completion', () => {
  const { graph } = fixture();
  graph.agentStart(task('reviewer'));
  graph.agentEnd({ executionId: 'reviewer-1', report: report('专项报告') });
  graph.responseStart(); graph.finish(status);
  assert.equal(stages(graph).find(node => node.phase === 'integration').status, status);
});
