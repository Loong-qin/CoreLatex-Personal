// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { api, sseGet } from '../api.js';
import { useEditorStore } from './editor.js';
import { useAgentStore } from './agent.js';
import { editorRuntime } from '../lib/editorRuntime.js';

vi.mock('../api.js', () => ({ api: { get: vi.fn(), post: vi.fn(), del: vi.fn() }, ssePost: vi.fn(), sseGet: vi.fn(), getToken: () => '', ApiError: Error }));
vi.mock('../lib/collabClient.js', () => ({ detachAllCollab: vi.fn(), detachProjectCollab: vi.fn(), subscribeProjectPresence: () => () => {}, setPresenceListener: vi.fn() }));
vi.mock('./ui.js', () => ({ useUiStore: () => ({ error: vi.fn(), toast: vi.fn() }) }));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
const cs = (id, applied = true, files = ['main.tex']) => ({ id, status: 'pending', applied,
  files: files.map(filePath => ({ filePath, status: 'pending', applied, adds: 1, dels: 1 })) });
const accepted = value => ({ ...value, status: 'accepted', files: value.files.map(file => ({ ...file, status: 'accepted' })) });
const snapshot = { pending: true, base: 'original\n', current: 'changed\n', revision: 7 };
let editor, agent, authority;
beforeEach(() => {
  vi.resetAllMocks(); setActivePinia(createPinia()); localStorage.clear();
  editor = useEditorStore(); editor.projectId = 'p'; editor.loadTree = vi.fn().mockResolvedValue();
  agent = useAgentStore(); agent.setProject('p'); authority = [];
  api.get.mockImplementation(async path => path.includes('/changesets?') ? { changesets: structuredClone(authority) }
    : path.includes('/review/base') ? { ...snapshot } : { chatId: 1, messages: [] });
});
afterEach(() => { agent.clearLocal(); editorRuntime.register(null); });
function stream() {
  const value = agent._beginStream({ requestId: 'run-one' });
  agent._onEvent({ type: 'run', runId: 'run-one', seq: 1, state: 'running' }, value);
  return value;
}
function oldEvent(value, changeset, seq = 2) { agent._onEvent({ type: 'changeset', runId: 'run-one', seq, changeset }, value); }
async function openReview() {
  authority = [cs(1)]; editor.pendingChangesets = structuredClone(authority); editor.activeFile = 'main.tex';
  await editor.openDiffReview([1], 'main.tex');
  editor.navDiffHunk(1);
  editorRuntime.register({ state: { doc: { toString: () => snapshot.current } }, dispatch: vi.fn() });
}

describe('review confirmation is not rolled back by earlier snapshots', () => {
  it.each([true, false])('a delayed SSE body cannot resurrect a confirmed file (already applied: %s)', async applied => {
    const initial = cs(1, applied); authority = [initial]; const running = stream();
    await editor.loadPendingChangesets();
    api.post.mockImplementation(async () => { authority = []; return { changeset: accepted(initial) }; });
    await editor.acceptChangeset(1, 'main.tex');
    expect(editor.pendingChangesets).toEqual([]);
    oldEvent(running, initial); await flush();
    expect(editor.pendingChangesets).toEqual([]);
    agent._onEvent({ type: 'done', runId: 'run-one', seq: 3, state: 'completed' }, running); await flush();
    expect(editor.pendingChangesets).toEqual([]);
    expect(api.post).toHaveBeenCalledTimes(1);
    expect(api.get.mock.calls.filter(([path]) => path.includes('/changesets?')).every(([, options]) => options?.cache === 'no-store')).toBe(true);
  });

  it('keeps another pending file in the same submission and a genuine later submission for the same file', async () => {
    const initial = cs(1, false, ['main.tex', 'other.tex']); authority = [initial]; const running = stream();
    await editor.loadPendingChangesets();
    api.post.mockImplementation(async () => {
      authority = [{ ...initial, files: [{ ...initial.files[0], status: 'accepted', applied: true }, initial.files[1]] }];
      return { changeset: structuredClone(authority[0]) };
    });
    await editor.acceptChangeset(1, 'main.tex'); oldEvent(running, initial); await flush();
    expect(editor.pendingChangesets[0].files.map(file => [file.filePath, file.status])).toEqual([['main.tex', 'accepted'], ['other.tex', 'pending']]);
    authority.push(cs(2)); oldEvent(running, cs(2), 3); await flush();
    expect(editor.pendingChangesets.map(item => item.id)).toEqual([1, 2]);
    expect(editor.pendingChangesets[1].files[0].status).toBe('pending');
  });

  it('ignores a list requested before confirmation even when its pending snapshot arrives last', async () => {
    const stale = deferred(); authority = [cs(1)]; editor.pendingChangesets = structuredClone(authority);
    api.get.mockReturnValueOnce(stale.promise);
    const older = editor.loadPendingChangesets();
    api.post.mockImplementation(async () => { authority = []; return { changeset: accepted(cs(1)) }; });
    await editor.acceptChangeset(1, 'main.tex');
    stale.resolve({ changesets: [cs(1)] }); expect(await older).toBe(false);
    expect(editor.pendingChangesets).toEqual([]);
  });

  it('defers reads during confirmation and includes a new notification before releasing the action lock', async () => {
    const write = deferred(), fresh = deferred(); authority = [cs(1)]; editor.pendingChangesets = structuredClone(authority);
    const running = stream(); api.post.mockReturnValue(write.promise);
    const operation = editor.acceptChangeset(1, 'main.tex'); await flush();
    oldEvent(running, cs(2)); expect(await editor.loadPendingChangesets()).toBe(false);
    expect(api.get).not.toHaveBeenCalled(); expect(editor.reviewBusy).toBe(true);
    api.get.mockReturnValueOnce(fresh.promise); authority = [cs(2)];
    write.resolve({ changeset: accepted(cs(1)) }); await flush();
    expect(editor.reviewBusy).toBe(true);
    expect(await editor.acceptChangeset(2, 'main.tex')).toBe(false);
    fresh.resolve({ changesets: [cs(2)] }); await operation;
    expect(editor.reviewBusy).toBe(false); expect(editor.pendingChangesets.map(item => item.id)).toEqual([2]);
  });

  it('reconciles again when a new notification arrives during the post-confirmation read', async () => {
    const firstRead = deferred(); authority = [cs(1)]; editor.pendingChangesets = structuredClone(authority);
    const running = stream(); api.post.mockResolvedValue({ changeset: accepted(cs(1)) });
    api.get.mockReturnValueOnce(firstRead.promise);
    const operation = editor.acceptChangeset(1, 'main.tex'); await flush();
    authority = [cs(2)]; oldEvent(running, cs(2));
    firstRead.resolve({ changesets: [] }); await operation;
    expect(editor.pendingChangesets.map(item => item.id)).toEqual([2]); expect(editor.reviewBusy).toBe(false);
    expect(api.get).toHaveBeenCalledTimes(2);
  });

  it('does not let either an old or in-write base request restore a confirmed diff or clear a newer refresh flag', async () => {
    await openReview(); const oldBase = deferred(), duringBase = deferred(), write = deferred();
    api.get.mockImplementation(path => path.includes('/changesets?') ? Promise.resolve({ changesets: structuredClone(authority) }) : oldBase.promise);
    const first = editor.refreshDiffReview();
    api.post.mockReturnValue(write.promise); const operation = editor.acceptChangeset(1, 'main.tex');
    api.get.mockImplementation(path => path.includes('/changesets?') ? Promise.resolve({ changesets: structuredClone(authority) }) : duringBase.promise);
    const second = editor.refreshDiffReview(); expect(second).not.toBe(first);
    oldBase.resolve({ ...snapshot, revision: 8 }); expect(await first).toBe(false);
    expect(editor.diffReview.refreshing).toBe(true);
    authority = []; write.resolve({ changeset: accepted(cs(1)) }); await operation;
    expect(editor.diffReview).toBeNull(); expect(editor.pendingChangesets).toEqual([]);
    duringBase.resolve({ ...snapshot, revision: 9 }); expect(await second).toBe(false);
    expect(editor.diffReview).toBeNull();
  });

  it('a last-hunk response with revision zero stays closed and waits for the final pending list', async () => {
    await openReview(); const write = deferred(), lateBase = deferred(), finalList = deferred();
    api.post.mockReturnValue(write.promise);
    const operation = editor.saveCurrentHunk();
    api.get.mockImplementation(path => path.includes('/changesets?') ? finalList.promise : lateBase.promise);
    const stale = editor.refreshDiffReview();
    write.resolve({ pending: false, base: snapshot.current, current: snapshot.current, revision: 0 }); await flush();
    expect(editor.diffReview).toBeNull(); expect(editor.reviewBusy).toBe(true);
    finalList.resolve({ changesets: [] }); expect(await operation).toBe(true);
    expect(editor.pendingChangesets).toEqual([]); expect(editor.reviewBusy).toBe(false);
    lateBase.resolve({ ...snapshot }); expect(await stale).toBe(false); expect(editor.diffReview).toBeNull();
  });

  it('a confirmed final hunk stays resolved if the follow-up pending-list request fails', async () => {
    await openReview();
    api.post.mockResolvedValue({ pending: false, base: snapshot.current, current: snapshot.current, revision: 0, changesets: [] });
    api.get.mockRejectedValue(new TypeError('read response lost'));
    expect(await editor.saveCurrentHunk()).toBe(true);
    expect(editor.pendingChangesets).toEqual([]); expect(editor.diffReview).toBeNull(); expect(editor.reviewBusy).toBe(false);
    expect(await editor.saveCurrentHunk()).toBe(false); expect(api.post).toHaveBeenCalledTimes(1);
  });

  it('the hunk response preserves another pending file and an unapplied proposal even if reconciliation fails', async () => {
    await openReview();
    const partial = cs(1, true, ['main.tex', 'other.tex']); partial.files[0].status = 'accepted';
    const proposal = cs(2, false);
    api.post.mockResolvedValue({ pending: false, base: snapshot.current, current: snapshot.current, revision: 0, changesets: [partial, proposal] });
    api.get.mockRejectedValue(new TypeError('read response lost'));
    expect(await editor.saveCurrentHunk()).toBe(true);
    expect(editor.pendingChangesets).toEqual([partial, proposal]); expect(editor.diffReview).toBeNull();
    expect(editor.pendingChangesets[0].files[1].status).toBe('pending');
    expect(editor.pendingChangesets[1].files[0]).toMatchObject({ filePath: 'main.tex', applied: false, status: 'pending' });
  });

  it('batch acceptance cannot be reversed by a pending list already in flight', async () => {
    authority = [cs(1), cs(2, true, ['other.tex'])]; editor.pendingChangesets = structuredClone(authority);
    const stale = deferred(); api.get.mockReturnValueOnce(stale.promise); const older = editor.loadPendingChangesets();
    api.post.mockImplementation(async () => { authority = []; return { changesets: [], results: [{ filePath: 'main.tex', pending: false, resolved: true }, { filePath: 'other.tex', pending: false, resolved: true }] }; });
    await editor.resolvePendingChangesets('accept'); stale.resolve({ changesets: [cs(1), cs(2)] }); await older;
    expect(editor.pendingChangesets).toEqual([]); expect(api.post).toHaveBeenCalledTimes(1);
  });

  it('a lost write response still reconciles server acceptance instead of asking for the same review again', async () => {
    authority = [cs(1)]; editor.pendingChangesets = structuredClone(authority);
    api.post.mockImplementation(async () => { authority = []; throw new TypeError('response lost'); });
    await expect(editor.acceptChangeset(1, 'main.tex')).rejects.toThrow('response lost');
    expect(editor.pendingChangesets).toEqual([]); expect(editor.reviewBusy).toBe(false);
  });

  it('a previous project mutation cannot invalidate the next project pending-list request', async () => {
    const write = deferred(), newList = deferred(); api.post.mockReturnValue(write.promise);
    const old = editor.acceptChangeset(1, 'main.tex');
    editor.reset(); editor.projectId = 'next'; api.get.mockReturnValue(newList.promise);
    const reading = editor.loadPendingChangesets();
    write.resolve({ changeset: accepted(cs(1)) }); expect(await old).toBe(false);
    newList.resolve({ changesets: [cs(8)] }); expect(await reading).toBe(true);
    expect(editor.pendingChangesets.map(item => item.id)).toEqual([8]);
  });

  it('restoring an event observer reads current review state instead of replaying an accepted proposal', async () => {
    let emit;
    api.get.mockImplementation(async path => path.endsWith('/active') ? { run: { id: 'old-run', state: 'running' } }
      : path.includes('/changesets?') ? { changesets: [] } : { chatId: 1, messages: [] });
    sseGet.mockImplementation((_path, callback, { signal }) => {
      emit = callback; return new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    });
    await agent.loadChat('p');
    emit({ type: 'changeset', runId: 'old-run', seq: 2, changeset: cs(1, false) }); await flush();
    expect(editor.pendingChangesets).toEqual([]); expect(api.post).not.toHaveBeenCalled();
    expect(api.get).toHaveBeenCalledWith('/api/projects/p/changesets?status=pending', { cache: 'no-store' });
  });
});


describe('proposal resolution preserves the reviewed revision', () => {
  it.each(['accept', 'revert'])('a single %s binds the current list version at action start', async action => {
    const initial = { ...cs(10, false), proposalRevision: 4 };
    editor.pendingChangesets = [initial]; authority = [initial];
    const write = deferred(); api.post.mockReturnValueOnce(write.promise);
    const operation = action === 'accept' ? editor.acceptChangeset(10, 'main.tex') : editor.revertChangeset(10, 'main.tex');
    authority = [{ ...initial, proposalRevision: 5 }]; editor.pendingChangesets = structuredClone(authority);
    expect(api.post).toHaveBeenCalledWith(`/api/projects/p/changesets/10/${action}`, { filePath: 'main.tex', expectedRevision: 4 });
    write.reject(Object.assign(new Error('version changed'), { status: 409 }));
    await expect(operation).rejects.toMatchObject({ status: 409 });
    expect(editor.pendingChangesets[0].proposalRevision).toBe(5); expect(editor.reviewBusy).toBe(false);
  });

  it('uses an explicitly viewed revision zero instead of the newer pending-list revision', async () => {
    const latest = { ...cs(11, false), proposalRevision: 9 }; authority = [latest]; editor.pendingChangesets = [latest];
    api.post.mockRejectedValue(Object.assign(new Error('version changed'), { status: 409 }));
    await expect(editor.acceptChangeset(11, 'main.tex', 0)).rejects.toMatchObject({ status: 409 });
    expect(api.post).toHaveBeenCalledWith('/api/projects/p/changesets/11/accept', { filePath: 'main.tex', expectedRevision: 0 });
    expect(editor.pendingChangesets[0].proposalRevision).toBe(9);
  });

  it.each(['accept', 'revert'])('a batch %s freezes every revision before its first request', async action => {
    const initial = { ...cs(12, false, ['first.tex', 'second.tex']), proposalRevision: 2 };
    authority = [initial]; editor.pendingChangesets = structuredClone(authority);
    const firstWrite = deferred();
    api.post.mockReturnValueOnce(firstWrite.promise).mockRejectedValueOnce(Object.assign(new Error('version changed'), { status: 409 }));
    const operation = editor.resolvePendingChangesets(action); await flush();
    const order = action === 'accept' ? ['first.tex', 'second.tex'] : ['second.tex', 'first.tex'];
    expect(api.post).toHaveBeenNthCalledWith(1, `/api/projects/p/changesets/12/${action}`, { filePath: order[0], expectedRevision: 2 });
    // A new same-id continuation arrives while the first request is suspended.
    authority = [{ ...initial, proposalRevision: 3 }]; editor.pendingChangesets = structuredClone(authority);
    firstWrite.resolve({ changeset: structuredClone(authority[0]) });
    await expect(operation).rejects.toMatchObject({ status: 409, reviewPartial: true });
    expect(api.post).toHaveBeenNthCalledWith(2, `/api/projects/p/changesets/12/${action}`, { filePath: order[1], expectedRevision: 2 });
    expect(editor.pendingChangesets[0].proposalRevision).toBe(3); expect(editor.reviewBusy).toBe(false);
  });
});
