import { describe, expect, it } from 'vitest';
import { buildTimeline } from './agentUtils.js';
import { buildAgentWorkerRuns, groupAgentProcessRows } from './agentWorkerRuns.js';

const meta = (executionId, agentId = 'reviewer', overrides = {}) => ({ agentId, agentExecutionId: executionId,
  agentLabel: agentId === 'analysis' ? '分析智能体' : '审阅智能体', agentRole: agentId === 'analysis' ? 'analyst' : 'reviewer',
  agentPhase: agentId === 'analysis' ? 'analysis' : 'review', agentRevision: 0,
  agentStartedAt: 1000, agentTask: '核对指定草稿。', agentStatus: 'running', ...overrides });
const report = summary => ({ verdict: 'pass', summary, findings: [] });
const tool = (executionId, id = executionId + ':read', overrides = {}) => ({ kind: 'tool', name: 'read_file', state: 'ok',
  toolCallId: id, label: '读取文件', resultText: '正文', inputText: '{"path":"main.tex"}', ...meta(executionId), ...overrides });
const graph = nodes => ({ version: 2, kind: 'multi_agent', status: 'running', nodes, edges: [] });
const dispatch = (phase, state = 'ok') => ({ kind: 'tool', name: 'run_agent_graph', state, inputText: JSON.stringify({ phase }), resultText: state === 'error' ? '协作启动失败' : '' });

describe('worker execution rows and aggregation', () => {
  it('preserves every agent field and call identity, and never promotes reports into the parent answer', () => {
    const attribution = meta('review-attempt-1');
    const steps = [
      { type: 'text', text: '主智能体先说明范围。' },
      { type: 'activity', text: '正在检查引用。', phase: 'agent_work', source: 'system', ...attribution },
      { type: 'tool', name: 'read_file', status: 'end', toolCallId: 'review-attempt-1:read', result: '正文', ...attribution },
      { type: 'agent_report', ...attribution, status: 'completed', agentStatus: 'completed', report: report('独立审阅通过。'),
        usage: { inputTokens: 20 }, toolCount: 1, finishedAt: 1800, durationMs: 800 },
    ];
    const { rows, answer } = buildTimeline({ steps, content: '主智能体先说明范围。' });
    expect(answer).toBe('');
    expect(rows.map(row => row.kind)).toEqual(['text', 'activity', 'tool', 'agent_report']);
    expect(rows[1]).toMatchObject(attribution);
    expect(rows[2]).toMatchObject({ ...attribution, toolCallId: 'review-attempt-1:read' });
    expect(rows[3]).toMatchObject({ kind: 'agent_report', report: report('独立审阅通过。'), toolCount: 1 });
    const final = buildTimeline({ steps: [...steps, { type: 'text', text: '主智能体最终交付。' }] });
    expect(final.answer).toBe('主智能体最终交付。');
    expect(final.rows.at(-1).kind).toBe('agent_report');
  });

  it('keeps separate attempts, their revision-specific tasks and per-execution usage without adding cumulative node counts', () => {
    const firstReport = report('第一版审阅完成。');
    const secondReport = { verdict: 'needs_changes', summary: '第二版需要补引用。', findings: [] };
    const saved = graph([{ id: 'reviewer', label: '审阅智能体', role: 'reviewer', phase: 'review', task: '当前任务',
      executionId: 'review-2', status: 'running', attempts: 2, toolCount: 99, usage: { inputTokens: 999 }, history: [
        { executionId: 'review-1', attempt: 1, status: 'completed', revision: 1, task: '核对第一版',
          startedAt: 1000, finishedAt: 1500, toolCount: 1, usage: { inputTokens: 10 }, report: firstReport },
        { executionId: 'review-2', attempt: 2, status: 'running', revision: 2, task: '核对第二版',
          startedAt: 2000, toolCount: 0, usage: {} },
      ] }]);
    const rows = [tool('review-1', 'first', meta('review-1', 'reviewer', { agentRevision: 1, agentTask: '核对第一版' })),
      { kind: 'activity', text: '第二轮检查开始', phase: 'agent_work', ...meta('review-2', 'reviewer', { agentRevision: 2, agentStartedAt: 2000, agentTask: '核对第二版' }) },
      tool('review-2', 'second', meta('review-2', 'reviewer', { agentRevision: 2, agentStartedAt: 2000, agentTask: '核对第二版' })),
      { kind: 'agent_report', ...meta('review-2', 'reviewer', { agentRevision: 2, agentStartedAt: 2000, agentTask: '核对第二版', agentStatus: 'completed' }),
        report: secondReport, toolCount: 1, usage: { inputTokens: 30, outputTokens: 5 }, finishedAt: 2800 }];
    const original = JSON.stringify({ saved, rows });
    const runs = buildAgentWorkerRuns(rows, saved);
    expect(runs.map(run => run.executionId)).toEqual(['review-1', 'review-2']);
    expect(runs[0]).toMatchObject({ revision: 1, task: '核对第一版', durationMs: 500, toolCount: 1, usage: { inputTokens: 10 }, report: firstReport, attempt: 1 });
    expect(runs[1]).toMatchObject({ revision: 2, task: '核对第二版', durationMs: 800, toolCount: 1, usage: { inputTokens: 30 }, report: secondReport, attempt: 2 });
    expect(runs.map(run => run.tools.map(entry => entry.toolCallId))).toEqual([['first'], ['second']]);
    expect(runs[1].activities[0].text).toBe('第二轮检查开始');
    expect(JSON.stringify({ saved, rows })).toBe(original);
  });

  it('shows a running worker before any tools and excludes unstarted roles and the coordinator', () => {
    const runs = buildAgentWorkerRuns([], graph([
      { id: 'coordinator', role: 'coordinator', status: 'running' },
      { id: 'analysis', role: 'analyst', executionId: 'new-analysis', phase: 'analysis', status: 'running', startedAt: 5000, task: '分析范围' },
      { id: 'reviewer', role: 'reviewer', status: 'pending', attempts: 0 },
      { id: 'researcher', role: 'researcher', status: 'skipped', attempts: 0 },
    ]));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ executionId: 'new-analysis', label: '分析智能体', task: '分析范围', status: 'running', startedAt: 5000, tools: [], activities: [] });
  });

  it('supports legacy attribution without merging it into a later identified execution, and accepts ISO history times', () => {
    const old = tool('', '', { agentExecutionId: undefined, agentStartedAt: '2026-10-24T00:00:00Z' });
    const rows = [old, { ...old, resultText: '第二次读取' }, tool('modern')];
    const runs = buildAgentWorkerRuns(rows, null);
    expect(runs.map(run => run.executionId)).toEqual(['reviewer:legacy', 'modern']);
    expect(runs[0].startedAt).toBe(Date.parse('2026-10-24T00:00:00Z'));
    expect(runs[0].tools).toHaveLength(2);
    expect(new Set(runs[0].tools.map(entry => entry.key)).size).toBe(2);
    expect(runs[1].tools).toHaveLength(1);
  });

  it.each(['completed', 'failed', 'cancelled', 'interrupted'])('converges stale running history after durable %s without inventing a report', status => {
    const saved = { ...graph([{ id: 'reviewer', role: 'reviewer', executionId: 'stale', status,
      history: [
        { executionId: 'confirmed', status: 'completed', startedAt: 100, finishedAt: 200, report: report('确已完成') },
        { executionId: 'stale', status: 'running', startedAt: 300 },
      ] }]), status };
    const runs = buildAgentWorkerRuns([tool('stale', 'late', { agentStatus: 'running' })], saved);
    expect(runs.find(run => run.executionId === 'confirmed').status).toBe('completed');
    const stale = runs.find(run => run.executionId === 'stale');
    expect(stale.status).toBe(status === 'completed' ? 'interrupted' : status);
    expect(stale.report).toBeNull();
  });
});

describe('main process grouping', () => {
  it('replaces worker details and dispatches with one entry per execution while retaining parent work and orphan errors', () => {
    const analysis = meta('analysis-1', 'analysis');
    const rows = [{ kind: 'text', text: '计划' }, dispatch('analysis'),
      { kind: 'activity', text: '分析开始', phase: 'agent_work', ...analysis }, tool('analysis-1', 'a1', analysis),
      { kind: 'thinking', text: '主智能体的已返回思考' },
      { kind: 'tool', name: 'edit_file', state: 'ok', toolCallId: 'main-edit', resultText: '主智能体修改' },
      dispatch('review'), tool('review-1', 'r1'),
      { kind: 'agent_report', ...meta('review-1'), report: report('审阅完成'), status: 'completed', agentStatus: 'completed' },
      { kind: 'text', text: '汇总报告' }, dispatch('review', 'error')];
    const grouped = groupAgentProcessRows(rows);
    expect(grouped.map(row => row.kind)).toEqual(['text', 'agent_run', 'thinking', 'tool', 'agent_run', 'text', 'tool']);
    expect(grouped.filter(row => row.kind === 'agent_run').map(row => row.run.executionId)).toEqual(['analysis-1', 'review-1']);
    expect(grouped[1].run.tools[0].toolCallId).toBe('a1');
    expect(grouped[1].run.activities[0].text).toBe('分析开始');
    expect(grouped[4].run.tools[0].toolCallId).toBe('r1');
    expect(grouped[3]).toBe(rows[5]);
    expect(grouped.at(-1)).toBe(rows.at(-1));
  });

  it('inserts graph-only parallel workers at the matching phase dispatch without duplicate current/history entries', () => {
    const rows = [{ kind: 'text', text: '先处理主任务' }, dispatch('analysis'), { kind: 'thinking', text: '等待独立结果' }];
    const saved = graph(['analysis', 'researcher'].map((id, index) => ({ id, role: id === 'analysis' ? 'analyst' : 'researcher',
      phase: 'analysis', executionId: id + '-1', status: 'running', startedAt: 1000 + index, history: [
        { executionId: id + '-1', status: 'running', startedAt: 1000 + index },
      ] })));
    const grouped = groupAgentProcessRows(rows, saved);
    expect(grouped.map(row => row.kind)).toEqual(['text', 'agent_run', 'agent_run', 'thinking']);
    expect(new Set(grouped.filter(row => row.kind === 'agent_run').map(row => row.run.executionId)).size).toBe(2);
  });

  it('keeps failed dispatch visible when no worker started and leaves v1 workflows/main tools unchanged', () => {
    const rows = [{ kind: 'text', text: '规划' }, dispatch('review', 'error'), { kind: 'tool', name: 'read_file', state: 'ok' }];
    expect(groupAgentProcessRows(rows, graph([{ id: 'reviewer', status: 'pending', attempts: 0 }]))).toBe(rows);
    expect(groupAgentProcessRows(rows, { version: 1, nodes: [{ id: 'edit', status: 'running' }], edges: [] })).toBe(rows);
  });
});


it('reads v4 attempts without duplicating the current task and preserves superseded work as interrupted', () => {
  const history = [{ id: 'review-a', role: 'reviewer', executionId: 'review-a-1', status: 'superseded', startedAt: 100, finishedAt: 200, report: report('旧范围结论') },
    { id: 'review-a', role: 'reviewer', executionId: 'review-a-2', status: 'completed', startedAt: 300, finishedAt: 400, report: report('当前范围结论') }];
  const node = { ...history[1], attempts: 2, history };
  const runs = buildAgentWorkerRuns([], { version: 4, kind: 'orchestration', tier: 'full', nodes: [node], instances: [node], edges: [] });
  expect(runs).toHaveLength(2); expect(runs[0].status).toBe('interrupted'); expect(runs[1].report.summary).toBe('当前范围结论');
});

describe('v4 validation stages are not worker executions', () => {
  it.each(['off', 'lite', 'full', 'deep'])('keeps one compile row throughout validation in %s mode', tier => {
    const compile = { kind: 'tool', name: 'compile_and_preview', toolCallId: 'main-compile', state: 'running' };
    for (const status of ['running', 'completed']) {
      const stage = { id: 'verify', label: '验证结果', status, visits: 1 };
      const snapshot = { version: 4, kind: 'orchestration', tier, status: 'running',
        nodes: [stage], instances: [], validation: { nodes: [stage] } };
      const rows = [{ ...compile, state: status === 'completed' ? 'ok' : 'running' }];
      expect(buildAgentWorkerRuns(rows, snapshot)).toEqual([]);
      expect(groupAgentProcessRows(rows, snapshot)).toBe(rows);
    }
  });

  it('reads real instances before their first event even when root nodes contain validation', () => {
    const worker = { id: 'review-a', role: 'reviewer', executionId: 'review-a-1', startedAt: 1000, status: 'running' };
    const snapshot = { version: 4, kind: 'orchestration', tier: 'full', status: 'running',
      nodes: [{ id: 'verify', label: '验证结果', status: 'running' }], instances: [worker] };
    expect(buildAgentWorkerRuns([], snapshot)).toMatchObject([{ executionId: 'review-a-1', status: 'running' }]);
    const saved = JSON.parse(JSON.stringify({ ...snapshot, instances: [{ ...worker, status: 'completed', report: report('通过') }] }));
    expect(buildAgentWorkerRuns([], saved)).toMatchObject([{ executionId: 'review-a-1', status: 'completed' }]);
  });

  it('does not invent workers from a partial snapshot, while attributed events remain visible', () => {
    const snapshot = { version: 4, kind: 'orchestration', nodes: [{ id: 'verify', status: 'running' }] };
    expect(buildAgentWorkerRuns([], snapshot)).toEqual([]);
    expect(buildAgentWorkerRuns([tool('real-worker')], snapshot)).toMatchObject([{ executionId: 'real-worker' }]);
  });
});
