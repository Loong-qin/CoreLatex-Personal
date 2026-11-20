import { describe, expect, it } from 'vitest';
import { isWorkflowGraph, workflowForSteps, isExecutionGraph } from './agentWorkflow.js';
import { buildTimeline } from './agentUtils.js';

const snapshot = () => ({ version: 2, kind: 'multi_agent', status: 'running', activeCount: 2, maxConcurrency: 2, nodes: [
  { id: 'coordinator', role: 'coordinator', status: 'running' },
  { id: 'analysis', role: 'analyst', status: 'completed', report: { verdict: 'pass', summary: '已分析' } },
  { id: 'reviewer', role: 'reviewer', status: 'running', detail: '正在审阅' },
  { id: 'verifier', role: 'verifier', status: 'waiting' },
  { id: 'researcher', role: 'researcher', status: 'pending' },
], edges: [{ from: 'analysis', to: 'coordinator' }] });
const steps = graph => [{ type: 'workflow', graph }];

describe('persisted multi-agent workflow', () => {
  it('accepts both supported schemas and selects the latest valid snapshot', () => {
    const v1 = { version: 1, nodes: [], edges: [] }, v2 = snapshot();
    expect(isWorkflowGraph(v1)).toBe(true); expect(isWorkflowGraph(v2)).toBe(true);
    expect(isWorkflowGraph({ ...v2, kind: 'other' })).toBe(false);
    expect(workflowForSteps([...steps(v1), ...steps(v2)])).toBe(v2);
    expect(workflowForSteps([...steps(v2), ...steps({ version: 3 })])).toBe(v2);
    expect(workflowForSteps(null)).toBeNull();
  });

  it.each(['cancelled', 'failed', 'interrupted'])('reconciles all %s workers without overwriting completed reports or mutating history', state => {
    const original = snapshot(), saved = structuredClone(original);
    const graph = workflowForSteps(steps(original), state);
    expect(graph.status).toBe(state); expect(graph.activeCount).toBe(0);
    expect(graph.nodes.filter(node => ['pending', 'running', 'waiting'].includes(node.status))).toHaveLength(0);
    expect(graph.nodes[1]).toEqual(original.nodes[1]);
    expect(graph.nodes[2].status).toBe(state); expect(graph.nodes[3].status).toBe(state);
    expect(original).toEqual(saved);
  });

  it('does not infer unrecorded worker success from coordinator completion', () => {
    const graph = workflowForSteps(steps(snapshot()), 'completed');
    expect(graph.nodes[0].status).toBe('completed'); expect(graph.nodes[1].status).toBe('completed');
    expect(graph.nodes[2]).toMatchObject({ status: 'interrupted', detail: expect.stringContaining('无法确认') });
    expect(graph.nodes[3].status).toBe('interrupted'); expect(graph.nodes[4].status).toBe('skipped');
    expect(graph.nodes[2].report).toBeUndefined(); expect(graph.activeCount).toBe(0);
  });

  it('repairs stale active nodes even if the saved graph is already terminal and is idempotent', () => {
    const original = { ...snapshot(), status: 'cancelled' };
    const graph = workflowForSteps(steps(original));
    expect(graph.nodes[2].status).toBe('cancelled');
    expect(workflowForSteps(steps(graph), 'cancelled')).toBe(graph);
  });

  it('preserves v1 completion reconciliation for old task-flow records', () => {
    const graph = { version: 1, status: 'running', nodes: [{ id: 'edit', status: 'running' }], edges: [] };
    expect(workflowForSteps(steps(graph), 'completed').nodes[0].status).toBe('completed');
  });
});

describe('worker tool attribution', () => {
  it('retains worker identity in live and persisted tool rows with the shared Chinese tool name', () => {
    const call = { name: 'read_file', status: 'end', result: 'body', agentId: 'analysis', agentRole: 'analyst', agentLabel: '分析智能体', display: { version: 1, kind: 'read', title: 'read_file' } };
    const live = buildTimeline({ steps: [{ type: 'tool', ...call }] }).rows[0];
    const history = buildTimeline({ toolCalls: [call] }).rows[0];
    expect(live).toMatchObject({ label: '分析智能体 · 读取文件', agentId: 'analysis', agentRole: 'analyst', agentLabel: '分析智能体' });
    expect(history.label).toBe(live.label);
    expect(live.display.title).toBe('读取文件');
    const main = buildTimeline({ toolCalls: [{ ...call, agentId: undefined }] }).rows[0];
    expect(main.label).toBe('读取文件'); expect(main.agentId).toBeUndefined();
  });
});

describe('execution event projection compatibility', () => {
  const execution = () => ({version:3,kind:'execution',status:'running',activeCount:2,activeAgentCount:1,currentNode:'edit-1',nodes:[
    {id:'coordinator',type:'coordinator',status:'running'},
    {id:'edit-1',type:'stage',phase:'edit',status:'running'},
    {id:'agent-verify-1',type:'agent',executionId:'verify-1',status:'running'},
  ],edges:[{from:'coordinator',to:'edit-1',type:'sequence'}]});
  it('accepts valid nested and standalone execution records', () => {
    const graph={...snapshot(),execution:execution()};
    expect(isExecutionGraph(graph.execution)).toBe(true); expect(isWorkflowGraph(graph.execution)).toBe(true);
    expect(workflowForSteps(steps(graph))).toBe(graph);
    expect(workflowForSteps(steps(graph.execution))).toBe(graph.execution);
  });
  it('reconciles interrupted execution records without changing immutable history or inventing stage success', () => {
    const graph={...snapshot(),execution:execution()}, original=structuredClone(graph);
    const result=workflowForSteps(steps(graph),'completed');
    expect(result.execution.status).toBe('completed');
    expect(result.execution.nodes[0].status).toBe('completed');
    expect(result.execution.nodes[1].status).toBe('interrupted'); expect(result.execution.nodes[2].status).toBe('interrupted');
    expect(result.execution.activeAgentCount).toBe(0);expect(result.execution.activeCount).toBe(0);
    expect(result.execution.nodes[1].report).toBeUndefined(); expect(graph).toEqual(original);
    expect(workflowForSteps(steps(result),'completed')).toBe(result);
  });

});


describe('v4 orchestration projection', () => {
  it('reconciles interruptions without fabricating worker passes or losing the request ledger', () => {
    const original = { ...snapshot(), version: 4, kind: 'orchestration', tier: 'full', sequence: 12, accounting: { requests: [{ requestId: 1 }] } };
    const updated = workflowForSteps(steps(original), 'interrupted');
    expect(isWorkflowGraph(original)).toBe(true);
    expect(updated.nodes.find(n => n.id === 'reviewer').status).toBe('interrupted');
    expect(updated.nodes.find(n => n.id === 'reviewer').report).toBeUndefined();
    expect(updated.accounting).toEqual(original.accounting); expect(original.nodes[2].status).toBe('running');
  });
  it('retains standard workflow display while collaboration is off', () => {
    const graph = { version: 4, kind: 'orchestration', tier: 'off', nodes: [{ id: 'edit', status: 'running' }], edges: [] };
    expect(workflowForSteps(steps(graph), 'completed').nodes[0].status).toBe('completed');
  });
});
