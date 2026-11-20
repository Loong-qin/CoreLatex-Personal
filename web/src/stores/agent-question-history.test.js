// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { api, ssePost, sseGet } from '../api.js';
import { useAgentStore, bindAgentContext } from './agent.js';
import { unansweredMessage } from '../lib/agentRunInputs.js';
vi.mock('../api.js', () => ({ api: { get: vi.fn(), post: vi.fn(), del: vi.fn() }, ssePost: vi.fn(), sseGet: vi.fn(), getToken: () => '', ApiError: Error }));
vi.mock('../lib/collabClient.js', () => ({ detachProjectCollab: vi.fn(), subscribeProjectPresence: () => () => {}, detachAllCollab: vi.fn(), setPresenceListener: vi.fn() }));
vi.mock('./ui.js', () => ({ useUiStore: () => ({ error: vi.fn(), toast: vi.fn() }) }));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const answer = (questionId = 'q1', id = 3, text = 'Use option A') => ({ type: 'answer', inputKind: 'answer', chatMessageId: id, runId: 'r1', parentMessageId: 2, questionId, question: 'Which format?', answer: text, inputText: text, consumed: true });
const prompt = { id: 1, role: 'user', content: 'Review the appendix' };
const report = { id: 2, role: 'assistant', runId: 'r1', runState: 'completed', content: 'Review completed.' };
const saved = receipt => ({ ...receipt, id: receipt.chatMessageId, role: 'user', content: `[回答] ${receipt.question}\n${receipt.answer}` });
let store;
beforeEach(() => {
  vi.clearAllMocks(); setActivePinia(createPinia()); store = useAgentStore();
  api.get.mockRejectedValue(new Error('history offline'));
});
afterEach(() => store.clearLocal());
function running() {
  store.setProject('p'); store.messages = [prompt];
  const stream = store._beginStream();
  store._onEvent({ type: 'run', runId: 'r1', messageId: 2, seq: 1, state: 'running' }, stream);
  store._onEvent({ type: 'question', runId: 'r1', seq: 2, questionId: 'q1', question: 'Which format?' }, stream);
  return stream;
}

describe('answers remain part of their original run', () => {
  it('deduplicates SSE plus HTTP acknowledgements and survives done/history ordering without starting another model request', async () => {
    const stream = running(), request = deferred(), receipt = answer(); api.post.mockReturnValue(request.promise);
    const accepted = store.answerQuestion(receipt.answer);
    store._onEvent({ ...receipt, seq: 3 }, stream);
    expect(store.pendingQuestion).toBeNull(); expect(store.messages.filter(m => m.inputKind === 'answer')).toHaveLength(1);
    store._onEvent({ ...receipt, seq: 3 }, stream);
    api.get.mockResolvedValue({ chatId: 1, messages: [prompt, report, saved(receipt)] });
    store._onEvent({ type: 'token', runId: 'r1', seq: 4, text: report.content }, stream);
    store._onEvent({ type: 'done', runId: 'r1', messageId: 2, seq: 5 }, stream); await flush();
    request.resolve({ run: { id: 'r1', state: 'completed' }, answer: receipt });
    expect(await accepted).toBe(true);
    expect(store.messages.map(m => m.id)).toEqual([1, 3, 2]);
    expect(store.messages.at(-1).content).toBe(report.content);
    expect(unansweredMessage(store.messages)).toBeNull();
    expect(api.post).toHaveBeenCalledTimes(1); expect(ssePost).not.toHaveBeenCalled();
  });

  it('accepts a late HTTP success after completion and a failed history reload, placing the answer before its local final report', async () => {
    const stream = running(), request = deferred(); api.post.mockReturnValue(request.promise);
    const accepted = store.answerQuestion('Use option A');
    store._onEvent({ type: 'token', runId: 'r1', seq: 3, text: report.content }, stream);
    store._onEvent({ type: 'done', runId: 'r1', messageId: 2, seq: 4 }, stream); await flush();
    request.resolve({ run: { id: 'r1', state: 'completed' }, answer: answer() });
    expect(await accepted).toBe(true); expect(store.streaming).toBe(false);
    expect(store.messages.map(m => m.id)).toEqual([1, 3, 2]); expect(unansweredMessage(store.messages)).toBeNull();
    expect(ssePost).not.toHaveBeenCalled();
  });

  it('trusts a durable answer event when its HTTP response is lost and keeps a later question open', async () => {
    const stream = running(), request = deferred(); api.post.mockReturnValue(request.promise);
    const accepted = store.answerQuestion('Use option A');
    store._onEvent({ ...answer(), seq: 3 }, stream);
    store._onEvent({ type: 'question', runId: 'r1', seq: 4, questionId: 'q2', question: 'Keep captions?' }, stream);
    request.reject(new TypeError('HTTP disconnected'));
    expect(await accepted).toBe(true); expect(store.lastError).toBe(''); expect(store.pendingQuestion.questionId).toBe('q2');
    api.post.mockResolvedValue({ run: { id: 'r1', state: 'running' }, answer: answer('q2', 4, 'Keep them') });
    expect(await store.answerQuestion('Keep them')).toBe(true);
    store._onEvent({ ...answer('q2', 4, 'Keep them'), seq: 5 }, stream);
    expect(store.messages.filter(m => m.inputKind === 'answer').map(m => m.id)).toEqual([3, 4]);
    expect(store.pendingQuestion).toBeNull(); expect(ssePost).not.toHaveBeenCalled();
  });

  it('keeps genuinely rejected answers pending with their error visible', async () => {
    running(); api.post.mockRejectedValue(new Error('Answer rejected'));
    expect(await store.answerQuestion('Use option A')).toBe(false);
    expect(store.pendingQuestion.questionId).toBe('q1'); expect(store.lastError).toBe('Answer rejected');
    expect(store.messages).toEqual([prompt]);
  });

  it('updates consumed steering monotonically despite a later unconsumed HTTP receipt, while retaining two identical submissions', async () => {
    const stream = running(); store.pendingQuestion = null;
    const receipt = { type: 'input', inputKind: 'steering', inputId: 7, chatMessageId: 3, runId: 'r1', parentMessageId: 2, inputText: 'Keep equations', consumed: false };
    const request = deferred(); api.post.mockReturnValue(request.promise); const accepted = store.sendInput('Keep equations');
    store._onEvent({ ...receipt, seq: 3 }, stream);
    store._onEvent({ type: 'input_consumed', runId: 'r1', seq: 4, inputIds: [7] }, stream);
    request.resolve({ run: { id: 'r1', state: 'running' }, input: receipt }); expect(await accepted).toBe(true);
    expect(store.messages.find(m => m.id === 3).consumed).toBe(true);
    store._onEvent({ ...receipt, inputId: 8, chatMessageId: 4, seq: 5 }, stream);
    store._onEvent({ type: 'token', runId: 'r1', seq: 6, text: report.content }, stream);
    store._onEvent({ type: 'run', runId: 'r1', seq: 7, state: 'cancelled' }, stream); await flush();
    expect(store.messages.map(m => m.id)).toEqual([1, 3, 2, 4]);
    expect(unansweredMessage(store.messages)).toMatchObject({ id: 4, consumed: false });
    expect(ssePost).not.toHaveBeenCalled();
  });

  it('restores answered-question history and deduplicates replay without replaying a model request', async () => {
    const pending = deferred(), receipt = answer();
    api.get.mockImplementation(async path => path.endsWith('/active')
      ? { run: { id: 'r1', state: 'waiting_for_user', messageId: 2, question: { questionId: 'q2', question: 'Keep captions?' } } }
      : { chatId: 1, messages: [prompt, { ...report, runState: 'waiting_for_user' }, saved(receipt)] });
    sseGet.mockImplementation(async (_path, emit) => { emit({ ...receipt, seq: 3 }); emit({ type: 'question', runId: 'r1', seq: 4, questionId: 'q2', question: 'Keep captions?' }); await pending.promise; });
    await store.loadChat('p');
    expect(store.messages.map(m => m.id)).toEqual([1, 3]); expect(store.pendingQuestion.questionId).toBe('q2');
    expect(sseGet).toHaveBeenCalledTimes(1); expect(ssePost).not.toHaveBeenCalled();
    store.clearLocal(); pending.resolve();
  });

  it('does not restore cleared answers when their HTTP acknowledgement arrives after resetChat', async () => {
    const stream = running(), request = deferred(); api.post.mockReturnValue(request.promise);
    bindAgentContext(store, { editor: { projectId: 'p' }, ui: { error: vi.fn(), toast: vi.fn() } });
    const accepted = store.answerQuestion('Use option A');
    store._onEvent({ type: 'token', runId: 'r1', seq: 3, text: report.content }, stream);
    store._onEvent({ type: 'done', runId: 'r1', messageId: 2, seq: 4 }, stream); await flush();
    api.del.mockResolvedValue({ ok: true }); await store.resetChat(); expect(store.messages).toEqual([]);
    request.resolve({ run: { id: 'r1', state: 'completed' }, answer: answer() });
    expect(await accepted).toBe(true); expect(store.messages).toEqual([]); expect(unansweredMessage(store.messages)).toBeNull();
  });

  it('places a previous run late receipt before its report without changing the current question', async () => {
    const stream = running(), request = deferred(); api.post.mockReturnValue(request.promise);
    const accepted = store.answerQuestion('Use option A');
    store._onEvent({ type: 'token', runId: 'r1', seq: 3, text: report.content }, stream);
    store._onEvent({ type: 'done', runId: 'r1', messageId: 2, seq: 4 }, stream); await flush();
    store.messages.push({ id: 5, role: 'user', content: 'Next task' });
    const next = store._beginStream();
    store._onEvent({ type: 'run', runId: 'r2', messageId: 6, seq: 1, state: 'running' }, next);
    store._onEvent({ type: 'question', runId: 'r2', seq: 2, questionId: 'next-q', question: 'Another question?' }, next);
    request.resolve({ run: { id: 'r1', state: 'completed' }, answer: answer() });
    expect(await accepted).toBe(true); expect(store.messages.map(m => m.id)).toEqual([1, 3, 2, 5]);
    expect(store.pendingQuestion.questionId).toBe('next-q'); expect(store.activeRunId).toBe('r2'); expect(store.streaming).toBe(true);
  });

  it('does not let a late acknowledgement cross project lifecycles', async () => {
    running(); const request = deferred(); api.post.mockReturnValue(request.promise);
    const accepted = store.answerQuestion('Use option A'); store.setProject('other');
    request.resolve({ run: { id: 'r1', state: 'completed' }, answer: answer() });
    expect(await accepted).toBe(true); expect(store.projectId).toBe('other'); expect(store.messages).toEqual([]);
  });
});
