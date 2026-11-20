// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { api, ssePost } from '../api.js';
import { useAgentStore } from './agent.js';
import { useEditorStore } from './editor.js';

vi.mock('../api.js', () => ({
  api: { get: vi.fn(), post: vi.fn(), del: vi.fn() }, ssePost: vi.fn(), getToken: () => '', ApiError: Error,
}));
vi.mock('../lib/collabClient.js', () => ({
  detachAllCollab: vi.fn(), detachProjectCollab: vi.fn(), subscribeProjectPresence: vi.fn(() => vi.fn()), setPresenceListener: vi.fn(),
  pendingProjectEdits: vi.fn(),
}));
vi.mock('./ui.js', () => ({
  useUiStore: () => ({ error: vi.fn(), toast: vi.fn() }),
}));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
let streams;
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  setActivePinia(createPinia());
  streams = [];
  api.get.mockResolvedValue({ chatId: 1, messages: [] });
  ssePost.mockImplementation((path, body, onEvent, { signal }) => {
    const pending = deferred();
    streams.push({ ...pending, path, onEvent, signal, resolve: () => { onEvent({ type: 'done' }); pending.resolve(); } });
    return pending.promise;
  });
});

describe('agent project and stream lifecycle', () => {
  it('aborts the old project and ignores its late tokens, changesets and completion', async () => {
    const s = useAgentStore(), editor = useEditorStore();
    editor.projectId = 'a';
    const first = s.sendMessage('a', 'from a');
    expect(streams).toHaveLength(1);
    s.clearLocal(); // EditorView unmount
    editor.reset();
    editor.projectId = 'b';
    const second = s.sendMessage('b', 'from b');
    expect(streams[0].signal.aborted).toBe(true);
    streams[0].onEvent({ type: 'token', text: 'stale' });
    streams[0].onEvent({ type: 'changeset', changeset: { id: 9, status: 'pending', files: [] } });
    streams[0].onEvent({ type: 'done' });
    streams[0].resolve();
    await first;
    expect(s.streaming).toBe(true);
    expect(s.messages.map((m) => m.content)).toEqual(['from b']);
    expect(s.streamText).toBe('');
    expect(editor.pendingChangesets).toEqual([]);
    streams[1].onEvent({ type: 'token', text: 'fresh' });
    expect(s.streamText).toBe('fresh');
    streams[1].resolve();
    await second;
    expect(s.streaming).toBe(false);
    expect(api.get.mock.calls.every(([path]) => path.includes('/b/'))).toBe(true);
  });

  it('does not let an old rejected stream finalize or report an error in a new stream', async () => {
    const s = useAgentStore();
    const first = s.sendMessage('a', 'a');
    s.setProject('b');
    const second = s.sendMessage('b', 'b');
    streams[0].reject(new Error('late failure'));
    await first;
    expect(s.streaming).toBe(true);
    expect(s.lastError).toBe('');
    streams[1].resolve();
    await second;
  });

  it('ignores chat responses from an earlier project and earlier load', async () => {
    const s = useAgentStore();
    const a = deferred(), b1 = deferred(), b2 = deferred();
    api.get.mockReturnValueOnce(a.promise).mockReturnValueOnce(b1.promise).mockReturnValueOnce(b2.promise);
    const first = s.loadChat('a'), second = s.loadChat('b'), third = s.loadChat('b', { restoreRun: false });
    b2.resolve({ chatId: 3, messages: [{ content: 'newest b' }] });
    await third;
    a.resolve({ chatId: 1, messages: [{ content: 'a' }] });
    b1.resolve({ chatId: 2, messages: [{ content: 'older b' }] });
    await Promise.all([first, second]);
    expect(s.activeChatId).toBe(3);
    expect(s.messages[0].content).toBe('newest b');
  });

  it('does not replace optimistic messages with a history load started before sending', async () => {
    const s = useAgentStore();
    const history = deferred();
    api.get.mockReturnValueOnce(history.promise);
    const loading = s.loadChat('a');
    const sending = s.sendMessage('a', 'keep this');
    history.resolve({ chatId: 1, messages: [] });
    await loading;
    expect(s.messages[0].content).toBe('keep this');
    await s.loadChat('a');
    expect(api.get).toHaveBeenCalledTimes(1); // reopening a panel during streaming does not reload
    streams[0].resolve();
    await sending;
  });

  it('reports chat success only for the current completed project stream', async () => {
    const s = useAgentStore();
    const sending = s.sendMessage('a', 'send');
    streams[0].onEvent({ type: 'done' }); streams[0].resolve();
    expect(await sending).toBe(true);
    const older = s.sendMessage('a', 'older');
    streams[1].onEvent({ type: 'done' });
    s.clearLocal(); s.setProject('a'); streams[1].resolve();
    expect(await older).toBe(false);
  });

  it('returns false for failed or cancelled chat so its composer can restore the draft', async () => {
    const s = useAgentStore();
    const failed = s.sendMessage('a', 'retry');
    streams[0].onEvent({ type: 'error', message: 'model failed' });
    streams[0].onEvent({ type: 'done' }); streams[0].resolve();
    expect(await failed).toBe(false);
    const cancelled = s.sendMessage('a', 'stop');
    s.cancelStream(); streams[1].reject(new DOMException('aborted', 'AbortError'));
    expect(await cancelled).toBe(false);
    expect(await s.sendMessage('a', '')).toBe(false);
  });

  it('reports successful selection actions when done already finalized the stream', async () => {
    const s = useAgentStore();
    const action = s.runSelectionAction('a', 'polish', { file: 'main.tex', start: 0, end: 3 });
    streams[0].onEvent({ type: 'token', text: 'done' });
    streams[0].onEvent({ type: 'done' });
    streams[0].resolve();
    expect(await action).toBe(true);
    expect(s.streaming).toBe(false);
  });

  it('does not report selection success after an SSE error event', async () => {
    const s = useAgentStore();
    const action = s.runSelectionAction('a', 'explain');
    streams[0].onEvent({ type: 'error', message: 'model failed' });
    streams[0].onEvent({ type: 'done' });
    streams[0].resolve();
    expect(await action).toBe(false);
    expect(s.lastError).toBe('model failed');
  });

  it('does not report success from a completed old selection after the same project reopens', async () => {
    const s = useAgentStore();
    const action = s.runSelectionAction('a', 'explain');
    streams[0].onEvent({ type: 'done' });
    s.clearLocal();
    s.setProject('a');
    streams[0].resolve();
    expect(await action).toBe(false);
  });

  it('canceling a selection stream clears the running state and preserves partial output', async () => {
    const s = useAgentStore();
    const action = s.runSelectionAction('a', 'explain');
    streams[0].onEvent({ type: 'token', text: 'partial' });
    api.post.mockResolvedValue({ run: { state: 'cancelled' } });
    api.get.mockRejectedValue(new Error('history unavailable'));
    await s.cancelStream();
    expect(streams[0].signal.aborted).toBe(false); // Only server confirmation completes cancellation.
    streams[0].resolve();
    expect(await action).toBe(false);
    expect(s.streaming).toBe(false);
    expect(s.messages[0].content).toBe('partial');
    expect(s.lastError).toBe('');
  });

  it('ignores a reset response from the project that was left', async () => {
    const s = useAgentStore(), editor = useEditorStore();
    editor.projectId = 'a';
    s.setProject('a');
    const deletion = deferred();
    api.del.mockReturnValue(deletion.promise);
    const resetting = s.resetChat();
    s.setProject('b');
    s.messages = [{ content: 'b' }];
    deletion.resolve({});
    await resetting;
    expect(s.messages[0].content).toBe('b');
    expect(s.resetting).toBe(false);
  });
});
