// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useAgentStore } from './agent.js';
import { buildTimeline } from '../lib/agentUtils.js';
import { buildAgentWorkerRuns } from '../lib/agentWorkerRuns.js';
vi.mock('../api.js', () => ({ api: { get: vi.fn(), post: vi.fn(), del: vi.fn() }, ssePost: vi.fn(), sseGet: vi.fn(), getToken: () => '', ApiError: Error }));
vi.mock('../lib/collabClient.js', () => ({ detachProjectCollab: vi.fn(), subscribeProjectPresence: () => () => {}, detachAllCollab: vi.fn(), setPresenceListener: vi.fn() }));
vi.mock('./ui.js', () => ({ useUiStore: () => ({ error: vi.fn(), toast: vi.fn() }) }));
beforeEach(() => { vi.clearAllMocks(); setActivePinia(createPinia()); });
const meta = executionId => ({ agentId: 'reviewer', agentLabel: '审阅智能体', agentRole: 'reviewer', agentExecutionId: executionId,
  agentPhase: 'review', agentRevision: 0, agentStartedAt: 1700000000000, agentTask: '核对草稿引用。', agentStatus: 'running' });
function start() {
  const store = useAgentStore(); store.setProject('p'); const stream = store._beginStream();
  store._onEvent({ type: 'run', runId: 'r', state: 'running' }, stream);
  return { store, stream };
}

describe('worker SSE persistence', () => {
  it('retains all metadata, replaces repeated reports by execution and preserves separate attempts through finalization', async () => {
    const { store, stream } = start();
    for (const executionId of ['first', 'second']) {
      const attribution = meta(executionId);
      store._onEvent({ type: 'activity', phase: 'agent_work', text: '独立核查开始', ...attribution }, stream);
      store._onEvent({ type: 'tool', name: 'read_file', toolCallId: executionId + ':read', status: 'start', ...attribution }, stream);
      store._onEvent({ type: 'tool', name: 'read_file', toolCallId: executionId + ':read', status: 'end', result: '读取真实草稿', ...attribution }, stream);
      for (const summary of ['初始报告', '完整报告']) store._onEvent({ type: 'agent_report', ...attribution,
        agentStatus: 'completed', status: 'completed', report: { summary, verdict: 'pass', findings: [] },
        usage: { inputTokens: 22 }, toolCount: 1, finishedAt: attribution.agentStartedAt + 200, durationMs: 200 }, stream);
    }
    expect(store.liveSteps).toHaveLength(6);
    expect(store.liveSteps.filter(step => step.type === 'agent_report')).toHaveLength(2);
    expect(store.liveSteps[0]).toMatchObject(meta('first'));
    expect(store.liveSteps[1]).toMatchObject({ ...meta('first'), result: '读取真实草稿', status: 'end' });
    const live = buildAgentWorkerRuns(buildTimeline({ steps: store.liveSteps }).rows);
    expect(live.map(run => run.executionId)).toEqual(['first', 'second']);
    expect(live[0]).toMatchObject({ report: { summary: '完整报告' }, toolCount: 1, durationMs: 200, usage: { inputTokens: 22 }, status: 'completed' });
    expect(live[0].tools[0].resultText).toBe('读取真实草稿');
    await store._finishStream(null, { reload: false, stream });
    const restored = buildAgentWorkerRuns(buildTimeline({ steps: JSON.parse(JSON.stringify(store.messages.at(-1).steps)) }).rows);
    expect(restored).toEqual(live);
    expect(store.streamText).toBe('');
    store.clearLocal();
  });

  it('does not merge same-name legacy tool completions across workers or drop inherited start metadata', () => {
    const { store, stream } = start();
    const a = meta('a'), b = { ...meta('b'), agentId: 'verifier', agentRole: 'verifier' };
    store._onEvent({ type: 'tool', name: 'read_file', status: 'start', ...a }, stream);
    store._onEvent({ type: 'tool', name: 'read_file', status: 'start', ...b }, stream);
    store._onEvent({ type: 'tool', name: 'read_file', status: 'end', detail: '审阅结果', agentId: 'reviewer', agentExecutionId: 'a' }, stream);
    expect(store.liveSteps[0]).toMatchObject({ ...a, status: 'end', detail: '审阅结果' });
    expect(store.liveSteps[1]).toMatchObject({ ...b, status: 'start' });
    store.clearLocal();
  });

  it('deduplicates old reports without execution ids only within the same legacy agent', () => {
    const { store, stream } = start();
    for (const agentId of ['reviewer', 'verifier', 'reviewer']) store._onEvent({ type: 'agent_report', agentId,
      status: 'failed', report: { verdict: 'blocked', summary: '资料缺失', findings: [] } }, stream);
    expect(store.liveSteps).toHaveLength(2);
    expect(buildAgentWorkerRuns(buildTimeline({ steps: store.liveSteps }).rows).map(run => run.executionId)).toEqual(['reviewer:legacy', 'verifier:legacy']);
    store.clearLocal();
  });
});
