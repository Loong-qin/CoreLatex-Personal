// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { api, ssePost, sseGet } from '../api.js';
import { useAgentStore } from './agent.js';
vi.mock('../api.js', () => ({ api: { get: vi.fn(), post: vi.fn(), del: vi.fn() }, ssePost: vi.fn(), sseGet: vi.fn(), getToken: () => '', ApiError: Error }));
vi.mock('../lib/collabClient.js', () => ({ detachProjectCollab: vi.fn(), subscribeProjectPresence: () => () => {}, detachAllCollab: vi.fn(), setPresenceListener: vi.fn() }));
vi.mock('./ui.js', () => ({ useUiStore: () => ({ error: vi.fn(), toast: vi.fn() }) }));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
beforeEach(() => {
  vi.clearAllMocks(); setActivePinia(createPinia());
  api.get.mockImplementation(async (path) => path.endsWith('/active') ? { run: null } : { chatId: 1, messages: [] });
});
afterEach(() => vi.useRealTimers());
function running() {
  const store = useAgentStore(); store.setProject('p'); const stream = store._beginStream();
  store._onEvent({ type: 'run', runId: 'r1', seq: 1, state: 'running' }, stream);
  return { store, stream };
}
describe('persistent agent runs', () => {
  it('reconnects only the event GET and deduplicates replayed sequence numbers', async () => {
    vi.useFakeTimers();
    const store = useAgentStore();
    ssePost.mockImplementation(async (_path, _body, emit) => {
      emit({ type: 'run', runId: 'r1', seq: 1, state: 'running' });
      emit({ type: 'token', runId: 'r1', seq: 2, text: 'first' });
      throw new TypeError('network disconnected');
    });
    sseGet.mockImplementation(async (path, emit) => {
      expect(path).toContain('/r1/events?after=2');
      emit({ type: 'token', runId: 'r1', seq: 2, text: 'DUPLICATE' });
      emit({ type: 'token', runId: 'r1', seq: 3, text: 'second' });
      emit({ type: 'run', runId: 'r1', seq: 4, state: 'completed' });
    });
    api.get.mockRejectedValue(new Error('history offline'));
    const send = store.sendMessage('p', 'hello');
    await vi.runAllTimersAsync(); await send;
    expect(ssePost).toHaveBeenCalledTimes(1); expect(sseGet).toHaveBeenCalledTimes(1);
    expect(store.messages.at(-1).content).toBe('firstsecond');
    expect(store.streaming).toBe(false);
  });
  it('limits failed reconnects to five without declaring the running task complete', async () => {
    vi.useFakeTimers();
    const { store, stream } = running();
    sseGet.mockRejectedValue(new TypeError('offline'));
    api.get.mockResolvedValue({ run: { id: 'r1', state: 'running' } });
    const retry = store._watchRun(stream, { initial: true });
    await vi.runAllTimersAsync(); await retry;
    expect(sseGet).toHaveBeenCalledTimes(5); expect(store.connectionLost).toBe(true);
    expect(store.streaming).toBe(true); expect(store.activeRunId).toBe('r1');
    expect(ssePost).not.toHaveBeenCalled();
  });
  it('finishes from the matching server snapshot when reconnects never deliver a terminal event', async () => {
    vi.useFakeTimers();
    const { store, stream } = running();
    store._onEvent({ type: 'question', runId: 'r1', seq: 2, questionId: 'stale', question: 'Still waiting?' }, stream);
    sseGet.mockResolvedValue(undefined);
    const saved = { id: 2, role: 'assistant', runId: 'r1', runState: 'completed', content: 'Saved answer' };
    api.get.mockImplementation(async path => path.endsWith('/r1')
      ? { run: { id: 'r1', state: 'completed', messageId: 2 } }
      : { chatId: 1, messages: [saved] });
    const retry = store._watchRun(stream, { initial: true });
    await vi.runAllTimersAsync(); await retry;
    expect(api.get).toHaveBeenCalledWith('/api/projects/p/agent/runs/r1', expect.objectContaining({ cache: 'no-store' }));
    expect(store.streaming).toBe(false);
    expect(store.connectionLost).toBe(false);
    expect(store.pendingQuestion).toBeNull();
    expect(store.runState).toBe('completed');
    expect(store.lastError).toBe('');
    expect(store.messages.at(-1)).toMatchObject(saved);
  });
  it('does not apply a disconnected run snapshot after its workspace has changed', async () => {
    const { store } = running();
    store.connectionLost = true;
    const pending = deferred();
    api.get.mockReturnValueOnce(pending.promise);
    const checking = store.refreshRunStatus();
    const signal = api.get.mock.calls.at(-1)[1].signal;
    store.setProject('other');
    const next = store._beginStream();
    store._onEvent({ type: 'run', runId: 'next', seq: 1, state: 'running' }, next);
    pending.resolve({ run: { id: 'r1', state: 'completed' } });
    await checking;
    expect(signal.aborted).toBe(true);
    expect(store.streaming).toBe(true);
    expect(store.activeRunId).toBe('next');
  });
  it('restores the active run after page load and replays from sequence zero', async () => {
    const pending = deferred();
    api.get.mockImplementation(async (path) => path.endsWith('/active')
      ? { run: { id: 'r1', state: 'waiting_for_user', messageId: 2, question: { questionId: 'q', question: 'Choose' } } }
      : { chatId: 1, messages: [{ id: 1, role: 'user', content: 'start' }, { id: 2, role: 'assistant', content: 'partial' }] });
    sseGet.mockReturnValue(pending.promise);
    const store = useAgentStore(); await store.loadChat('p');
    expect(store.streaming).toBe(true); expect(store.pendingQuestion.questionId).toBe('q');
    expect(store.messages.map((m) => m.id)).toEqual([1]);
    expect(sseGet.mock.calls[0][0]).toContain('/r1/events?after=0');
    store.clearLocal(); pending.resolve();
  });
  it('keeps the task locked until backend cancellation is confirmed', async () => {
    const { store, stream } = running(); const cancel = deferred(); api.post.mockReturnValue(cancel.promise);
    const request = store.cancelStream();
    expect(store.cancelling).toBe(true); expect(store.streaming).toBe(true); expect(stream.controller.signal.aborted).toBe(false);
    cancel.resolve({ run: { state: 'cancelled' } }); await request;
    expect(api.post).toHaveBeenCalledWith('/api/projects/p/agent/runs/r1/cancel', {});
    expect(store.streaming).toBe(false); expect(store.cancelling).toBe(false);
  });
  it('submits steering and a structured answer to the same run', async () => {
    const { store } = running(); api.post.mockResolvedValue({ run: { state: 'running' } });
    expect(await store.sendInput('Keep the equations')).toBe(true);
    expect(api.post).toHaveBeenLastCalledWith('/api/projects/p/agent/runs/r1/input', { message: 'Keep the equations' });
    store._onEvent({ type: 'question', runId: 'r1', seq: 2, questionId: 'q1', question: 'Which language?', options: ['Chinese', 'English'] });
    expect(await store.answerQuestion('Chinese')).toBe(true);
    expect(api.post).toHaveBeenLastCalledWith('/api/projects/p/agent/runs/r1/answer', { questionId: 'q1', answer: 'Chinese' });
    expect(store.pendingQuestion).toBeNull(); expect(ssePost).not.toHaveBeenCalled();
  });
  it('resets only current response text and never renders hidden provider reasoning', () => {
    const { store } = running();
    store._onEvent({ type: 'token', text: 'Previous response' });
    store._onEvent({ type: 'response_start' });
    store._onEvent({ type: 'activity', phase: 'planning', text: 'Read selected paragraphs' });
    store._onEvent({ type: 'token', text: 'Incomplete response' });
    store._onEvent({ type: 'thinking', text: 'PRIVATE_REASONING' });
    store._onEvent({ type: 'response_reset' });
    store._onEvent({ type: 'token', text: 'Retried answer' });
    expect(store.streamText).toBe('Previous responseRetried answer');
    expect(store.liveSteps.map((s) => s.text)).toEqual(['Previous response', 'Read selected paragraphs', 'Retried answer']);
  });
  it('correlates parallel same-name tools by toolCallId and preserves cancelled status', () => {
    const { store } = running();
    store._onEvent({ type: 'tool', name: 'read_file', toolCallId: 'a', status: 'start' });
    store._onEvent({ type: 'tool', name: 'read_file', toolCallId: 'b', status: 'start' });
    store._onEvent({ type: 'tool', name: 'read_file', toolCallId: 'a', status: 'cancelled', detail: 'Stopped' });
    expect(store.liveSteps[0].status).toBe('cancelled'); expect(store.liveSteps[1].status).toBe('start');
  });
});
