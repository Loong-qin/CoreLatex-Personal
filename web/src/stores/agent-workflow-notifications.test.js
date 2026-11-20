// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { api } from '../api.js';
import { useAgentStore } from './agent.js';
import { notifyAgentCompletion, notifyAgentQuestion, syncCompletionSoundPreference } from '../lib/agentCompletionSound.js';
import { workflowForSteps } from '../lib/agentWorkflow.js';

vi.mock('../api.js', () => ({ api: { get: vi.fn(), post: vi.fn(), del: vi.fn() }, ssePost: vi.fn(), sseGet: vi.fn(), getToken: () => '', ApiError: Error }));
vi.mock('../lib/agentCompletionSound.js', () => ({ notifyAgentCompletion: vi.fn(async () => true), notifyAgentQuestion: vi.fn(async () => true), getCompletionSoundRevision: () => 1, syncCompletionSoundPreference: vi.fn() }));
vi.mock('../lib/collabClient.js', () => ({ detachProjectCollab: vi.fn(), subscribeProjectPresence: () => () => {}, detachAllCollab: vi.fn(), setPresenceListener: vi.fn() }));
vi.mock('./ui.js', () => ({ useUiStore: () => ({ error: vi.fn(), toast: vi.fn() }) }));
beforeEach(() => { vi.clearAllMocks(); setActivePinia(createPinia()); api.get.mockRejectedValue(new Error('history offline')); });
function start() {
  const store = useAgentStore(); store.setProject('p');
  const stream = store._beginStream({ requestId: 'request-1' });
  store._onEvent({ type: 'run', state: 'running', runId: 'run-1', seq: 1 }, stream);
  return { store, stream };
}
const graph = { version: 1, scenario: 'edit', label: '文稿修改', status: 'running', currentNode: 'edit',
  nodes: [{ id: 'context', label: '读取上下文', status: 'completed' }, { id: 'edit', label: '修改', status: 'running' }], edges: [{ from: 'context', to: 'edit' }] };

describe('workflow snapshots and completion notifications', () => {
  it('coalesces graph updates, ignores duplicate events and preserves chronology around response resets', () => {
    const { store, stream } = start();
    store._onEvent({ type: 'workflow', seq: 2, graph }, stream);
    store._onEvent({ type: 'token', seq: 3, text: '正在修改。' }, stream);
    store._onEvent({ type: 'response_start', seq: 4 }, stream);
    store._onEvent({ type: 'workflow', seq: 5, graph: { ...graph, currentNode: 'verify' } }, stream);
    store._onEvent({ type: 'workflow', seq: 5, graph }, stream);
    store._onEvent({ type: 'response_reset', seq: 6 }, stream);
    expect(store.liveSteps.filter(step => step.type === 'workflow')).toHaveLength(1);
    expect(workflowForSteps(store.liveSteps).currentNode).toBe('verify');
    expect(store.liveSteps[1].text).toBe('正在修改。');
  });
  it('rings once for a live successful terminal run and ignores its subsequent done replay', () => {
    const { store, stream } = start();
    store._onEvent({ type: 'run', runId: 'run-1', seq: 2, state: 'completed' }, stream);
    store._onEvent({ type: 'done', runId: 'run-1', seq: 3, state: 'completed' }, stream);
    expect(notifyAgentCompletion).toHaveBeenCalledTimes(1);
    expect(notifyAgentCompletion).toHaveBeenCalledWith({ runId: 'run-1', projectId: 'p', state: 'completed', live: true });
  });
  it.each(['failed', 'cancelled', 'interrupted'])('keeps %s silent even when only done is delivered', state => {
    const { store, stream } = start();
    store._onEvent({ type: 'workflow', seq: 2, graph }, stream);
    store._onEvent({ type: 'done', seq: 3, state }, stream);
    expect(notifyAgentCompletion).not.toHaveBeenCalled();
    expect(store.messages.at(-1).runState).toBe(state);
    expect(workflowForSteps(store.messages.at(-1).steps, state).nodes[1].status).toBe(state);
  });
  it('does not treat a transport-only finish or an unqualified legacy done as confirmed success', async () => {
    let current = start();
    await current.store._finishStream(null, { reload: false, stream: current.stream });
    current = start();
    current.store._onEvent({ type: 'done' }, current.stream);
    expect(notifyAgentCompletion).not.toHaveBeenCalled();
  });
  it('arms restored active work but never completed history', async () => {
    const store = useAgentStore(); store.setProject('p');
    const stream = store._beginStream();
    store._adoptRun({ id: 'restored', state: 'waiting_for_user' }, stream);
    store._onEvent({ type: 'run', state: 'completed', runId: 'restored' }, stream);
    expect(notifyAgentCompletion).toHaveBeenCalledTimes(1);
    await new Promise(resolve => setTimeout(resolve, 0));
    vi.clearAllMocks();
    api.get.mockResolvedValue({ chatId: 1, messages: [{ id: 4, role: 'assistant', content: '已完成', runState: 'completed', steps: [{ type: 'workflow', graph }] }] });
    await store.loadChat('p', { restoreRun: false });
    expect(notifyAgentCompletion).not.toHaveBeenCalled();
  });
  it('loads the account sound preference into the shared player', async () => {
    api.get.mockResolvedValue({ agentConfig: { completionSound: false } });
    await useAgentStore().loadSettings();
    expect(syncCompletionSoundPreference).toHaveBeenLastCalledWith(false, 1);
  });
});

describe('live multi-agent graph transport', () => {
  it('coalesces v2 snapshots and retains distinct concurrent worker tool identities', () => {
    const { store, stream } = start();
    const multi = { version: 2, kind: 'multi_agent', status: 'running', activeCount: 2,
      nodes: [{ id: 'reviewer', status: 'running' }, { id: 'verifier', status: 'running' }], edges: [] };
    store._onEvent({ type: 'workflow', seq: 2, graph: multi }, stream);
    store._onEvent({ type: 'tool', seq: 3, name: 'read_file', status: 'start', toolCallId: 'reviewer:execution-1:call_1', agentId: 'reviewer', agentLabel: '审阅智能体', agentRole: 'reviewer' }, stream);
    store._onEvent({ type: 'tool', seq: 4, name: 'read_file', status: 'start', toolCallId: 'verifier:execution-2:call_1', agentId: 'verifier', agentLabel: '验证智能体', agentRole: 'verifier' }, stream);
    store._onEvent({ type: 'tool', seq: 5, name: 'read_file', status: 'end', toolCallId: 'reviewer:execution-1:call_1', detail: 'draft', agentId: 'reviewer', agentLabel: '审阅智能体' }, stream);
    store._onEvent({ type: 'workflow', seq: 6, graph: { ...multi, activeCount: 1 } }, stream);
    const tools = store.liveSteps.filter(step => step.type === 'tool');
    expect(tools).toHaveLength(2); expect(tools[0]).toMatchObject({ agentId: 'reviewer', agentLabel: '审阅智能体', status: 'end', detail: 'draft' });
    expect(tools[1]).toMatchObject({ agentId: 'verifier', agentLabel: '验证智能体', status: 'start' });
    expect(store.liveSteps.filter(step => step.type === 'workflow')).toHaveLength(1);
    expect(workflowForSteps(store.liveSteps).activeCount).toBe(1);
  });
  it('rejects an unsupported v2 kind rather than interpreting arbitrary data as an agent graph', () => {
    const { store, stream } = start();
    store._onEvent({ type: 'workflow', graph: { version: 2, kind: 'unknown', nodes: [], edges: [] } }, stream);
    expect(store.liveSteps.some(step => step.type === 'workflow')).toBe(false);
  });
});


describe('question attention notifications', () => {
  it('notifies once per new question and ignores duplicate sequence or question replay', () => {
    const { store, stream } = start();
    store._onEvent({ type: 'question', seq: 2, questionId: 'q1', question: '选择处理方式？' }, stream);
    store._onEvent({ type: 'question', seq: 2, questionId: 'q1', question: '选择处理方式？' }, stream);
    store._onEvent({ type: 'question', seq: 3, questionId: 'q1', question: '选择处理方式？' }, stream);
    expect(notifyAgentQuestion).toHaveBeenCalledTimes(1);
    expect(notifyAgentQuestion).toHaveBeenLastCalledWith({ runId: 'run-1', projectId: 'p', questionId: 'q1', live: true });
    store._onEvent({ type: 'question', seq: 4, questionId: 'q2', question: '继续编译？' }, stream);
    expect(notifyAgentQuestion).toHaveBeenCalledTimes(2);
    expect(store.pendingQuestion.questionId).toBe('q2');
  });
  it('restores active question/history silently and arms only questions after the restored snapshot', () => {
    const store = useAgentStore(); store.setProject('p'); const stream = store._beginStream();
    store._adoptRun({ id: 'restore', state: 'waiting_for_user', lastSeq: 10, question: { questionId: 'q2', question: '继续？' } }, stream);
    store._onEvent({ type: 'question', seq: 3, questionId: 'q1' }, stream);
    store._onEvent({ type: 'question', seq: 9, questionId: 'q2' }, stream);
    expect(notifyAgentQuestion).not.toHaveBeenCalled();
    store._onEvent({ type: 'question', seq: 11, questionId: 'q3' }, stream);
    expect(notifyAgentQuestion).toHaveBeenCalledTimes(1);
  });
  it('ignores questions from an inactive stream or an event without question identity', () => {
    const { store, stream } = start();
    store._onEvent({ type: 'question', question: 'missing ID' }, stream);
    store.setProject('another'); store._onEvent({ type: 'question', questionId: 'old' }, stream);
    expect(notifyAgentQuestion).not.toHaveBeenCalled();
  });
});
