// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { api, ssePost, sseGet } from '../api.js';
import { useAgentStore } from './agent.js';
import { createComposerDraftCache } from '../lib/agentComposerDrafts.js';
import { pendingProjectEdits } from '../lib/collabClient.js';

vi.mock('../api.js', () => ({ api: { get: vi.fn(), post: vi.fn(), del: vi.fn() }, ssePost: vi.fn(), sseGet: vi.fn(), getToken: () => '', ApiError: Error }));
vi.mock('../lib/collabClient.js', () => ({ detachProjectCollab: vi.fn(), subscribeProjectPresence: () => () => {}, detachAllCollab: vi.fn(), setPresenceListener: vi.fn(), pendingProjectEdits: vi.fn() }));
vi.mock('./ui.js', () => ({ useUiStore: () => ({ error: vi.fn(), toast: vi.fn() }) }));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
let store;
beforeEach(() => {
  vi.resetAllMocks(); setActivePinia(createPinia()); sessionStorage.clear(); store = useAgentStore();
  api.get.mockImplementation(async path => path.endsWith('/active') ? { run: null } : { chatId: 1, messages: [{ id: 2, role: 'assistant', content: 'Saved result' }] });
});
afterEach(() => { store.clearLocal(); vi.useRealTimers(); });

describe('request identity before the first SSE event', () => {
  it('keeps cancellation pending until the server confirms the known request stopped', async () => {
    const transport = deferred(), cancel = deferred(); let request, signal;
    ssePost.mockImplementation((_path, body, _emit, opts) => { request = body; signal = opts.signal; return transport.promise; });
    api.post.mockReturnValue(cancel.promise);
    const send = store.sendMessage('p', 'Stop before the first event');
    expect(request.requestId).toMatch(/^[0-9a-f-]{36}$/);
    const stopping = store.cancelStream();
    expect(api.post).toHaveBeenCalledWith(`/api/projects/p/agent/runs/${request.requestId}/cancel`, {});
    expect(store.streaming).toBe(true); expect(store.cancelling).toBe(true); expect(signal.aborted).toBe(false);
    cancel.resolve({ run: { state: 'cancelled' } }); await stopping;
    expect(store.streaming).toBe(false); transport.resolve(); expect(await send).toBe(false);
  });

  it('retries a cancel that arrived before registration after the first run event', async () => {
    const transport = deferred(); let request, emit;
    ssePost.mockImplementation((_path, body, onEvent) => { request = body; emit = onEvent; return transport.promise; });
    api.post.mockRejectedValueOnce(Object.assign(new Error('not registered'), { status: 404 }))
      .mockResolvedValueOnce({ run: { state: 'cancelled' } });
    const send = store.sendMessage('p', 'Stop while request is entering the server');
    await store.cancelStream(); expect(store.cancelling).toBe(true); expect(store.streaming).toBe(true);
    emit({ type: 'run', runId: request.requestId, seq: 1, state: 'running' }); await flush();
    expect(api.post).toHaveBeenCalledTimes(2); expect(store.streaming).toBe(false);
    transport.resolve(); expect(await send).toBe(false);
  });

  it('handles registration while the earlier not-found cancellation response is in flight', async () => {
    const transport = deferred(), firstCancel = deferred(); let request, emit;
    ssePost.mockImplementation((_path, body, onEvent) => { request = body; emit = onEvent; return transport.promise; });
    api.post.mockReturnValueOnce(firstCancel.promise).mockResolvedValueOnce({ run: { state: 'cancelled' } });
    const send = store.sendMessage('p', 'Race cancellation with registration');
    const stopping = store.cancelStream();
    emit({ type: 'run', runId: request.requestId, seq: 1, state: 'running' });
    firstCancel.reject(Object.assign(new Error('not registered yet'), { status: 404 }));
    await stopping; await flush();
    expect(api.post).toHaveBeenCalledTimes(2); expect(store.streaming).toBe(false);
    transport.resolve(); expect(await send).toBe(false);
  });

  it('replays an already completed request and clears its draft without resubmitting the POST', async () => {
    vi.useFakeTimers(); let id;
    ssePost.mockImplementation(async (_path, body) => { id = body.requestId; throw new TypeError('first event lost'); });
    sseGet.mockImplementation(async (path, emit) => {
      expect(path).toBe(`/api/projects/p/agent/runs/${id}/events?after=0`);
      emit({ type: 'run', runId: id, seq: 1, state: 'running' });
      emit({ type: 'token', runId: id, seq: 2, text: 'Saved result' });
      emit({ type: 'run', runId: id, seq: 3, state: 'completed' });
    });
    const drafts = createComposerDraftCache(); const draft = drafts.get('u:p'); draft.text = 'Only execute this once';
    const ticket = drafts.begin('u:p', draft); const send = store.sendMessage('p', ticket.text);
    await vi.runAllTimersAsync(); const success = await send; drafts.finish(ticket, success);
    expect(success).toBe(true); expect(draft.text).toBe(''); expect(sessionStorage.getItem('corelatex.agentDraft.u:p')).toBeNull();
    expect(ssePost).toHaveBeenCalledTimes(1); expect(store.messages.at(-1).content).toBe('Saved result');
    expect(api.get.mock.calls.some(([path]) => path.endsWith('/active'))).toBe(false);
  });

  it('keeps an unconfirmed request locked through initial 404s instead of declaring cancellation', async () => {
    vi.useFakeTimers();
    ssePost.mockRejectedValue(new TypeError('upload connection lost'));
    sseGet.mockRejectedValue(Object.assign(new Error('not registered yet'), { status: 404 }));
    api.post.mockRejectedValue(Object.assign(new Error('not registered yet'), { status: 404 }));
    const send = store.sendMessage('p', 'May have reached the server');
    await store.cancelStream(); await vi.runAllTimersAsync(); await send;
    expect(sseGet).toHaveBeenCalledTimes(5); expect(store.streaming).toBe(true);
    expect(store.cancelling).toBe(true); expect(store.connectionLost).toBe(true); expect(ssePost).toHaveBeenCalledTimes(1);
  });

  it.each(['chat', 'selection'])('recovers normal EOF without a first event (%s)', async kind => {
    vi.useFakeTimers(); let id;
    ssePost.mockImplementation(async (_path, body) => { id = body.requestId; });
    sseGet.mockImplementation(async (path, emit) => { expect(path).toContain(id); emit({ type: 'run', runId: id, state: 'completed', seq: 1 }); });
    const send = kind === 'chat' ? store.sendMessage('p', 'Recover empty transport')
      : store.runSelectionAction('p', 'explain', { file: 'main.tex', start: 0, end: 3 });
    await flush(); expect(store.streaming).toBe(true); expect(sseGet).not.toHaveBeenCalled();
    await vi.runAllTimersAsync(); expect(await send).toBe(true); expect(sseGet).toHaveBeenCalledTimes(1);
    expect(ssePost).toHaveBeenCalledTimes(1);
  });

  it('also recovers completed selection actions by their request identity', async () => {
    vi.useFakeTimers(); let id;
    ssePost.mockImplementation(async (_path, body) => { id = body.requestId; throw new TypeError('first event lost'); });
    sseGet.mockImplementation(async (path, emit) => { expect(path).toContain(id); emit({ type: 'run', runId: id, state: 'completed', seq: 1 }); });
    const send = store.runSelectionAction('p', 'explain', { file: 'main.tex', start: 0, end: 3 });
    await vi.runAllTimersAsync(); expect(await send).toBe(true); expect(ssePost).toHaveBeenCalledTimes(1);
  });

  it('sends the original selection only after its file save is acknowledged', async () => {
    const saving = deferred();
    const selection = { file: 'main.tex', start: 0, end: 3, selectionText: 'abc' };
    pendingProjectEdits.mockReturnValueOnce(saving.promise);
    ssePost.mockImplementation(async (_path, body, emit) => {
      emit({ type: 'run', runId: body.requestId, seq: 1, state: 'completed' });
    });
    const action = store.runSelectionAction('p', 'explain', selection);
    expect(pendingProjectEdits).toHaveBeenCalledWith('p', undefined, 'main.tex');
    expect(ssePost).not.toHaveBeenCalled();
    expect(await store.runSelectionAction('p', 'explain', selection)).toBe(false);
    saving.resolve();
    expect(await action).toBe(true);
    expect(ssePost).toHaveBeenCalledOnce();
    expect(ssePost.mock.calls[0][1]).toMatchObject({ action: 'explain', ...selection });
  });

  it('reports a selection save failure and releases the launch without starting a run', async () => {
    const saving = deferred();
    const selection = { file: 'main.tex', start: 0, end: 3, selectionText: 'abc' };
    pendingProjectEdits.mockReturnValueOnce(saving.promise);
    const action = store.runSelectionAction('p', 'explain', selection);
    saving.reject(new Error('selected file was not saved'));
    await expect(action).rejects.toThrow('selected file was not saved');
    expect(ssePost).not.toHaveBeenCalled();
    expect(sseGet).not.toHaveBeenCalled();
    expect(store.streaming).toBe(false);

    ssePost.mockImplementation(async (_path, body, emit) => {
      emit({ type: 'run', runId: body.requestId, seq: 1, state: 'completed' });
    });
    expect(await store.runSelectionAction('p', 'explain', selection)).toBe(true);
  });
});
