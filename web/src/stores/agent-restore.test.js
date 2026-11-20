// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { api, sseGet, ssePost } from '../api.js';
import { createProjectAgentStore, useAgentStore } from './agent.js';

vi.mock('../api.js', () => ({
  api: { get: vi.fn(), post: vi.fn(), del: vi.fn() },
  sseGet: vi.fn(), ssePost: vi.fn(), getToken: () => '', ApiError: Error,
}));
vi.mock('../lib/collabClient.js', () => ({
  detachAllCollab: vi.fn(), detachProjectCollab: vi.fn(),
  subscribeProjectPresence: () => () => {}, setPresenceListener: vi.fn(),
}));
vi.mock('./ui.js', () => ({ useUiStore: () => ({ error: vi.fn(), toast: vi.fn() }) }));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
let stores;
beforeEach(() => {
  vi.clearAllMocks(); setActivePinia(createPinia()); stores = [];
  api.get.mockImplementation(async path => path.endsWith('/active') ? { run: null } : { chatId: 1, messages: [] });
  // Observers stay open until the workspace closes; no new model request starts.
  sseGet.mockImplementation((_path, _emit, { signal }) => new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })));
});
afterEach(() => stores.forEach(store => store.clearLocal()));
function storeFor(id) {
  const store = id ? createProjectAgentStore(id) : useAgentStore(); stores.push(store); return store;
}

describe('refresh-time agent restoration', () => {
  it('shares history and active discovery between restorer, editor and panel, adopting one observer', async () => {
    const store = storeFor(), history = deferred(), active = deferred();
    api.get.mockImplementation(path => path.endsWith('/active') ? active.promise : history.promise);
    const background = store.loadChat('a', { noStore: true, strictRestore: true });
    const editor = store.loadChat('a');
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.get).toHaveBeenCalledWith('/api/projects/a/chat', { cache: 'no-store' });
    history.resolve({ chatId: 10, messages: [{ id: 1, role: 'user', content: 'keep working' }] });
    await flush();
    const panel = store.loadChat('a');
    expect(api.get).toHaveBeenCalledTimes(2);
    active.resolve({ run: { id: 'run-a', state: 'waiting_for_user', question: { questionId: 'q-a', question: 'Continue?' } } });
    await Promise.all([background, editor, panel]);
    expect(sseGet).toHaveBeenCalledTimes(1);
    expect(sseGet.mock.calls[0][0]).toBe('/api/projects/a/agent/runs/run-a/events?after=0');
    expect(store.activeRunId).toBe('run-a');
    expect(store.pendingQuestion.questionId).toBe('q-a');
    expect(ssePost).not.toHaveBeenCalled();
  });

  it.each([false, true])('reports strict restoration failures independently of caller order (strict first: %s)', async strictFirst => {
    const store = storeFor(), active = deferred(), error = new Error('active discovery offline');
    api.get.mockImplementation(async path => path.endsWith('/active') ? active.promise : { chatId: 1, messages: [{ content: 'saved history' }] });
    const first = store.loadChat('a', { strictRestore: strictFirst });
    const second = store.loadChat('a', { strictRestore: !strictFirst });
    const results = Promise.allSettled([first, second]);
    await flush(); active.reject(error);
    const settled = await results;
    expect(settled[strictFirst ? 0 : 1]).toMatchObject({ status: 'rejected', reason: error });
    expect(settled[strictFirst ? 1 : 0].status).toBe('fulfilled');
    expect(store.messages[0].content).toBe('saved history');
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(sseGet).not.toHaveBeenCalled();
    // A failed attempt must not prevent a subsequent explicit recovery.
    api.get.mockResolvedValue({ run: null, chatId: 1, messages: [{ content: 'reconnected' }] });
    await store.loadChat('a', { strictRestore: true });
    expect(store.messages[0].content).toBe('reconnected');
    expect(api.get).toHaveBeenCalledTimes(4);
  });

  it('does not let a closed workspace reuse its pending history request after reopening the same project', async () => {
    const store = storeFor(), oldHistory = deferred(), newHistory = deferred();
    api.get.mockImplementationOnce(() => oldHistory.promise).mockImplementationOnce(() => newHistory.promise);
    const oldLoad = store.loadChat('a', { strictRestore: true });
    store.clearLocal();
    const freshLoad = store.loadChat('a', { strictRestore: true });
    expect(api.get).toHaveBeenCalledTimes(2);
    newHistory.resolve({ chatId: 2, messages: [{ content: 'fresh' }] });
    await freshLoad;
    oldHistory.resolve({ chatId: 1, messages: [{ content: 'stale' }] });
    await oldLoad;
    expect(store.activeChatId).toBe(2);
    expect(store.messages[0].content).toBe('fresh');
    expect(api.get).toHaveBeenCalledTimes(3); // Only fresh history discovers a run.
  });

  it('ignores late active-run discovery after close without reviving the old observer', async () => {
    const store = storeFor(), oldActive = deferred();
    api.get.mockImplementation(async path => path.endsWith('/active') ? oldActive.promise : { chatId: 1, messages: [] });
    const oldLoad = store.loadChat('a', { strictRestore: true });
    await flush(); store.clearLocal();
    api.get.mockImplementation(async path => path.endsWith('/active') ? { run: null } : { chatId: 2, messages: [{ content: 'fresh' }] });
    await store.loadChat('a', { strictRestore: true });
    oldActive.resolve({ run: { id: 'old-run', state: 'running' } });
    await oldLoad;
    expect(store.activeChatId).toBe(2); expect(store.streaming).toBe(false);
    expect(store.messages[0].content).toBe('fresh'); expect(sseGet).not.toHaveBeenCalled();
  });

  it('keeps final history-only reload separate from active-run restoration', async () => {
    const store = storeFor(), restoring = deferred(), finalHistory = deferred();
    api.get.mockImplementationOnce(() => restoring.promise).mockImplementationOnce(() => finalHistory.promise);
    const older = store.loadChat('a');
    const finishing = store.loadChat('a', { restoreRun: false });
    expect(api.get).toHaveBeenCalledTimes(2);
    finalHistory.resolve({ chatId: 2, messages: [{ content: 'completed result' }] });
    await finishing;
    restoring.resolve({ chatId: 1, messages: [] }); await older;
    expect(store.activeChatId).toBe(2); expect(store.messages[0].content).toBe('completed result');
    expect(api.get).toHaveBeenCalledTimes(2); expect(sseGet).not.toHaveBeenCalled();
  });

  it('restores different project stores concurrently without sharing history or event observers', async () => {
    const a = storeFor('a'), b = storeFor('b');
    api.get.mockImplementation(async path => {
      const project = path.includes('/a/') ? 'a' : 'b';
      return path.endsWith('/active') ? { run: { id: `run-${project}`, state: 'running' } }
        : { chatId: project, messages: [{ role: 'user', content: `project ${project}` }] };
    });
    await Promise.all([a.loadChat('a', { strictRestore: true }), b.loadChat('b', { strictRestore: true })]);
    expect(api.get).toHaveBeenCalledTimes(4); expect(sseGet).toHaveBeenCalledTimes(2);
    const [pathA, emitA] = sseGet.mock.calls.find(([path]) => path.includes('/a/'));
    const [pathB, emitB] = sseGet.mock.calls.find(([path]) => path.includes('/b/'));
    emitA({ type: 'token', runId: 'run-a', seq: 1, text: 'A update' });
    emitB({ type: 'token', runId: 'run-b', seq: 1, text: 'B update' });
    expect(pathA).toContain('/run-a/'); expect(pathB).toContain('/run-b/');
    expect(a.messages[0].content).toBe('project a'); expect(b.messages[0].content).toBe('project b');
    expect(a.streamText).toBe('A update'); expect(b.streamText).toBe('B update');
    expect(ssePost).not.toHaveBeenCalled();
  });
});


describe('lightweight active-run restoration', () => {
  it('does not fetch an idle project history until the chat is opened', async () => {
    const store = storeFor();
    api.get.mockImplementation(async path => path.endsWith('/active') ? { run: null } : { chatId: 10, messages: [{ role: 'user', content: 'saved history' }] });
    await store.restoreActiveRun('a', { strictRestore: true });
    expect(api.get.mock.calls.map(([path]) => path)).toEqual(['/api/projects/a/agent/runs/active']);
    expect(store.messages).toEqual([]);
    await store.loadChat('a');
    expect(api.get.mock.calls.map(([path]) => path)).toContain('/api/projects/a/chat');
    expect(store.messages[0].content).toBe('saved history');
  });

  it('restores an active run using the ordinary history and event replay', async () => {
    const store = storeFor();
    api.get.mockImplementation(async path => path.endsWith('/active')
      ? { run: { id: 'run-a', state: 'waiting_for_user', question: { questionId: 'q-a', question: 'Continue?' } } }
      : { chatId: 10, messages: [{ role: 'user', content: 'saved history' }] });
    await store.restoreActiveRun('a', { strictRestore: true });
    expect(api.get.mock.calls.map(([path]) => path)).toEqual([
      '/api/projects/a/agent/runs/active', '/api/projects/a/chat', '/api/projects/a/agent/runs/active',
    ]);
    expect(store.activeChatId).toBe(10); expect(store.activeRunId).toBe('run-a');
    expect(store.pendingQuestion.questionId).toBe('q-a'); expect(store.messages[0].content).toBe('saved history');
    expect(sseGet).toHaveBeenCalledOnce(); expect(ssePost).not.toHaveBeenCalled();
  });

  it('shares a concurrent idle probe and never fetches history', async () => {
    const store = storeFor(), active = deferred(); api.get.mockReturnValueOnce(active.promise);
    const first = store.restoreActiveRun('a'), second = store.restoreActiveRun('a', { strictRestore: true });
    expect(api.get).toHaveBeenCalledOnce(); active.resolve({ run: null });
    await Promise.all([first, second]);
    expect(api.get).toHaveBeenCalledOnce(); expect(store.streaming).toBe(false);
  });

  it('ignores a late probe after project close and reopen', async () => {
    const store = storeFor(), oldActive = deferred(); api.get.mockReturnValueOnce(oldActive.promise);
    const old = store.restoreActiveRun('a', { strictRestore: true });
    store.clearLocal();
    api.get.mockResolvedValueOnce({ run: null });
    await store.restoreActiveRun('a', { strictRestore: true });
    oldActive.resolve({ run: { id: 'stale', state: 'running' } }); await old;
    expect(api.get.mock.calls.map(([path]) => path)).toEqual(['/api/projects/a/agent/runs/active', '/api/projects/a/agent/runs/active']);
    expect(store.activeRunId).toBeNull(); expect(sseGet).not.toHaveBeenCalled();
  });

  it('does not let an old probe override a newer explicit history load', async () => {
    const store = storeFor(), oldActive = deferred(); let activeCalls = 0;
    api.get.mockImplementation(async path => {
      if (path.endsWith('/chat')) return { chatId: 2, messages: [{ role: 'user', content: 'opened history' }] };
      return ++activeCalls === 1 ? oldActive.promise : { run: null };
    });
    const old = store.restoreActiveRun('a');
    await store.loadChat('a');
    oldActive.resolve({ run: { id: 'stale', state: 'running' } }); await old;
    expect(store.messages[0].content).toBe('opened history'); expect(store.activeRunId).toBeNull();
    expect(sseGet).not.toHaveBeenCalled();
  });

  it('reports discovery errors to strict callers without inventing an idle state', async () => {
    const store = storeFor(); api.get.mockResolvedValueOnce({ unexpected: true });
    await expect(store.restoreActiveRun('a', { strictRestore: true })).rejects.toThrow('状态响应无效');
    expect(api.get).toHaveBeenCalledOnce(); expect(store.messages).toEqual([]);
    api.get.mockRejectedValueOnce(new Error('offline'));
    await store.restoreActiveRun('a');
    expect(store.lastError).toContain('打开面板重试');
    api.get.mockResolvedValueOnce({ run: null });
    await store.restoreActiveRun('a');
    expect(store.lastError).toBe('');
  });
});
