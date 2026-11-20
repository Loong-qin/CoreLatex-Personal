// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { api } from '../api.js';
import { useEditorStore } from './editor.js';
import { editorRuntime } from '../lib/editorRuntime.js';
import { pendingProjectEdits } from '../lib/collabClient.js';
const ui = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock('./ui.js', () => ({ useUiStore: () => ui }));

vi.mock('../api.js', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), raw: vi.fn() },
}));
vi.mock('../lib/collabClient.js', () => ({
  detachProjectCollab: vi.fn(), subscribeProjectPresence: () => () => {}, detachAllCollab: vi.fn(), setPresenceListener: vi.fn(), pendingProjectEdits: vi.fn(),
}));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
const changeset = (id, filePath = 'main.tex') => ({
  id, status: 'pending', applied: true,
  files: [{ filePath, status: 'pending' }],
});
beforeEach(() => {
  vi.resetAllMocks();
  editorRuntime.register(null);
  localStorage.clear();
  setActivePinia(createPinia());
});

describe('review refresh', () => {
  it('keeps aggregated review while any changeset for its file remains pending', async () => {
    const s = useEditorStore();
    s.projectId = 'a';
    s.diffReview = { changesetIds: [1, 2], filePath: 'main.tex', base: 'original', hunks: [1] };
    api.get.mockResolvedValue({ changesets: [changeset(2)] });
    await s.loadPendingChangesets();
    expect(s.diffReview).toMatchObject({ changesetIds: [2], filePath: 'main.tex', base: 'original', hunks: [1] });
    api.get.mockResolvedValue({ changesets: [changeset(2, 'other.tex')] });
    await s.loadPendingChangesets();
    expect(s.diffReview).toBeNull();
  });

  it('uses file applied state for mixed changesets and never auto-reviews pending proposals', async () => {
    const s = useEditorStore();
    s.projectId = 'a';
    s.activeFile = 'main.tex';
    s.openDiffReview = vi.fn().mockResolvedValue(true);
    s.pendingChangesets = [
      { ...changeset(1), files: [{ filePath: 'main.tex', status: 'pending', applied: false }] },
      { ...changeset(2), applied: false, files: [{ filePath: 'main.tex', status: 'pending', applied: true }] },
    ];
    s.upsertChangeset({ ...changeset(3), applied: false,
      files: [{ filePath: 'main.tex', status: 'pending', applied: true }] });
    expect(s.openDiffReview).toHaveBeenCalledWith([2, 3], 'main.tex', true, true);
    s.openDiffReview.mockClear();
    s.upsertChangeset({ ...changeset(4), applied: true,
      files: [{ filePath: 'main.tex', status: 'pending', applied: false }] });
    expect(s.openDiffReview).not.toHaveBeenCalled();
  });

  it('review refresh excludes unapplied proposals for the same file', async () => {
    const s = useEditorStore();
    s.projectId = 'a';
    s.diffReview = { changesetIds: [1], filePath: 'main.tex' };
    api.get.mockResolvedValue({ changesets: [
      { ...changeset(1), applied: false, files: [{ filePath: 'main.tex', status: 'pending', applied: true }] },
      { ...changeset(2), applied: true, files: [{ filePath: 'main.tex', status: 'pending', applied: false }] },
    ] });
    await s.loadPendingChangesets();
    expect(s.diffReview.changesetIds).toEqual([1]);
  });

  it('keeps review unchanged if refresh fails', async () => {
    const s = useEditorStore();
    s.projectId = 'a';
    s.diffReview = { changesetIds: [1], filePath: 'main.tex' };
    api.get.mockRejectedValue(new Error('offline'));
    await s.loadPendingChangesets();
    expect(s.diffReview?.changesetIds).toEqual([1]);
  });

  it('ignores older list responses and lists superseded by an SSE changeset', async () => {
    const s = useEditorStore();
    s.projectId = 'a';
    const old = deferred(), recent = deferred();
    api.get.mockReturnValueOnce(old.promise).mockReturnValueOnce(recent.promise);
    const first = s.loadPendingChangesets(), second = s.loadPendingChangesets();
    recent.resolve({ changesets: [changeset(2)] });
    await second;
    old.resolve({ changesets: [changeset(1)] });
    await first;
    expect(s.pendingChangesets.map((c) => c.id)).toEqual([2]);

    const snapshot = deferred();
    api.get.mockReturnValueOnce(snapshot.promise);
    const refresh = s.loadPendingChangesets();
    s.upsertChangeset(changeset(3));
    snapshot.resolve({ changesets: [changeset(2)] });
    await refresh;
    expect(s.pendingChangesets.map((c) => c.id)).toEqual([2, 3]);
  });

  it('does not reopen a closed review from a late base response', async () => {
    const s = useEditorStore();
    s.projectId = 'a';
    const request = deferred();
    api.get.mockReturnValue(request.promise);
    const open = s.openDiffReview([1], 'main.tex');
    s.closeDiffReview();
    request.resolve({ pending: true, base: 'old' });
    expect(await open).toBe(false);
    expect(s.diffReview).toBeNull();
  });
});

describe('project request lifecycle', () => {
  it('opens the main file without waiting for the project tree or review list', async () => {
    const s = useEditorStore();
    const tree = deferred(), reviews = deferred();
    api.get.mockImplementation((path) => {
      if (path === '/api/projects/a?summary=1') return Promise.resolve({ project: { publicId: 'a', mainFile: 'main.tex' }, myRole: 'owner' });
      if (path === '/api/projects/a/tree?excludeWorkspace=1') return tree.promise;
      if (path === '/api/projects/a/reviews') return reviews.promise;
      return Promise.resolve({ members: [] });
    });
    expect(await s.init('a')).toBe(true);
    expect(s.activeFile).toBe('main.tex'); expect(s.treeLoaded).toBe(false);
    expect(api.get.mock.calls.some(([path]) => path.includes('/tree?'))).toBe(false);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(s.treeLoading).toBe(true);
    expect(api.get.mock.calls.find(([path]) => path.includes('/tree?'))[1].signal).toBeInstanceOf(AbortSignal);
    tree.resolve({ tree: [{ path: 'main.tex', type: 'file' }] }); reviews.resolve({ reviews: [] });
    await Promise.resolve(); await Promise.resolve();
    expect(s.treeLoaded).toBe(true); expect(s.treeLoading).toBe(false);
  });
  it('aborts superseded trees, keeps the latest result and supports retry after failure', async () => {
    const s = useEditorStore(); s.projectId = 'a';
    const old = deferred(), newest = deferred();
    api.get.mockReturnValueOnce(old.promise).mockReturnValueOnce(newest.promise);
    const first = s.loadTree(); const firstSignal = api.get.mock.calls[0][1].signal;
    const second = s.loadTree(); expect(firstSignal.aborted).toBe(true);
    newest.resolve({ tree: [{ path: 'new.tex' }] }); expect(await second).toBe(true);
    old.resolve({ tree: [{ path: 'stale.tex' }] }); expect(await first).toBe(false);
    expect(s.tree).toEqual([{ path: 'new.tex' }]);
    api.get.mockRejectedValueOnce(new Error('暂时离线'));
    await expect(s.loadTree()).rejects.toThrow('暂时离线');
    expect(s.treeError).toBe('暂时离线'); expect(s.treeLoading).toBe(false); expect(s.tree).toEqual([{ path: 'new.tex' }]);
    api.get.mockResolvedValueOnce({ tree: [{ path: 'retry.tex' }] });
    expect(await s.loadTree()).toBe(true); expect(s.treeError).toBe(''); expect(s.tree).toEqual([{ path: 'retry.tex' }]);
  });

  it('does not let a previous project initialization replace the current project', async () => {
    const s = useEditorStore();
    const old = deferred();
    api.get.mockImplementation((path) => {
      if (path === '/api/projects/a?summary=1') return old.promise;
      if (path === '/api/projects/b?summary=1') return Promise.resolve({ project: { publicId: 'b', mainFile: 'b.tex' }, myRole: 'owner' });
      if (path.includes('/tree?')) return Promise.resolve({ tree: [{ path: 'b.tex' }] });
      if (path.endsWith('/reviews')) return Promise.resolve({ reviews: [] });
      return Promise.resolve({ members: [] });
    });
    const first = s.init('a');
    expect(await s.init('b')).toBe(true);
    old.resolve({ project: { publicId: 'a', mainFile: 'a.tex' }, myRole: 'owner' });
    expect(await first).toBe(false);
    expect(s.projectId).toBe('b');
    expect(s.activeFile).toBe('b.tex');
  });

  it('ignores old tree, compile and review mutations after reset, including the same project reopening', async () => {
    const s = useEditorStore();
    s.projectId = 'a';
    const tree = deferred(), compile = deferred(), accept = deferred();
    api.get.mockReturnValue(tree.promise);
    api.post.mockImplementation((path) => path.endsWith('/compile') ? compile.promise : accept.promise);
    const treeJob = s.loadTree(), compileJob = s.compileProject(), acceptJob = s.acceptChangeset(1);
    s.reset();
    s.projectId = 'a';
    s.tree = [{ path: 'new.tex' }];
    tree.resolve({ tree: [{ path: 'old.tex' }] });
    compile.resolve({ status: 'success', pdfUrl: '/old.pdf' });
    accept.resolve({ changeset: changeset(1) });
    await Promise.all([treeJob, compileJob, acceptJob]);
    expect(s.tree).toEqual([{ path: 'new.tex' }]);
    expect(s.compile.status).toBe('idle');
    expect(s.compile.pdfUrl).toBe('');
    expect(s.pendingChangesets).toEqual([]);
  });
});


describe('atomic review hunk actions', () => {
  const original = { base: 'title human\nold\ncontext\nother old\n', current: 'title human\nAI\ncontext\nother AI\n', revision: 7, pending: true };
  async function open(snapshot = original, selected = true) {
    const s = useEditorStore();
    s.projectId = 'a'; s.activeFile = 'main.tex';
    api.get.mockImplementation((path) => Promise.resolve(path.includes('/review/base') ? snapshot : { changesets: [changeset(1)] }));
    await s.openDiffReview([1], 'main.tex');
    if (selected) s.navDiffHunk(1);
    const view = { state: { doc: { toString: () => snapshot.current } }, dispatch: vi.fn() };
    editorRuntime.register(view);
    return { s, view };
  }
  it('keeps 0/N through refresh and hunk redraw until explicit navigation', async () => {
    const { s } = await open(original, false);
    expect(s.diffReview.hunkIdx).toBe(-1);
    expect(await s.saveCurrentHunk()).toBe(false);
    expect(await s.revertCurrentHunk()).toBe(false);
    expect(api.post).not.toHaveBeenCalled();
    await s.refreshDiffReview();
    s.setDiffReviewHunks(s.diffReview.hunks, true);
    expect(s.diffReview.hunkIdx).toBe(-1);
    s.diffReview.resume = s.diffReview.noJump = true;
    s.navDiffHunk(1);
    expect(s.diffReview).toMatchObject({ hunkIdx: 0, keepPos: false, resume: false, noJump: false });
    s.navDiffHunk(-1);
    expect(s.diffReview.hunkIdx).toBe(1);
    s.navDiffHunk(1);
    expect(s.diffReview.hunkIdx).toBe(0);
    const unselected = await open(original, false);
    unselected.s.navDiffHunk(-1);
    expect(unselected.s.diffReview.hunkIdx).toBe(1);
  });
  it.each(['navDiffHunk', 'gotoDiffHunk'])('%s waits until review coordinates are ready', async method => {
    const { s } = await open(original, false);
    for (const flag of ['refreshing', 'stale', 'busy', 'reviewBusy']) {
      const target = flag === 'reviewBusy' ? s : s.diffReview;
      target[flag] = true;
      const signal = s.diffReview.signal;
      s[method](method === 'navDiffHunk' ? 1 : 0);
      expect(s.diffReview.hunkIdx).toBe(-1);
      expect(s.diffReview.signal).toBe(signal);
      target[flag] = false;
    }
    s[method](method === 'navDiffHunk' ? 1 : 0);
    expect(s.diffReview.hunkIdx).toBe(0);
  });
  it('uses one atomic snapshot and never accepts changesets from empty local hunks', async () => {
    const { s } = await open();
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(s.diffReview).toMatchObject({ base: original.base, current: original.current, revision: original.revision });
    expect(s.diffReview.hunks).toHaveLength(2);
    s.setDiffReviewHunks([]);
    expect(s.diffReview).not.toBeNull();
    expect(api.post).not.toHaveBeenCalled();
    expect(api.put).not.toHaveBeenCalled();
  });
  it('waits for server acceptance and retains the other nearby hunk', async () => {
    const { s, view } = await open();
    const response = deferred(); api.post.mockReturnValue(response.promise);
    const operation = s.saveCurrentHunk();
    expect(s.diffReview.busy).toBe(true);
    expect(s.diffReview.base).toBe(original.base);
    expect(api.post).toHaveBeenCalledWith('/api/projects/a/review/hunk', {
      file: 'main.tex', action: 'accept', current: original.current, revision: 7,
      baseFrom: 2, baseTo: 2, docFrom: 2, docTo: 2,
    });
    response.resolve({ ...original, base: 'title human\nAI\ncontext\nother old\n', revision: 8 });
    expect(await operation).toBe(true);
    expect(s.diffReview.hunks).toHaveLength(1);
    expect(s.diffReview.hunkIdx).toBe(-1);
    expect(s.diffReview.hunks[0].docFrom).toBe(4);
    s.navDiffHunk(1);
    expect(s.diffReview).toMatchObject({ hunkIdx: 0, keepPos: false });
    expect(view.dispatch).not.toHaveBeenCalled();
    expect(api.put).not.toHaveBeenCalled();
  });
  it('reverts through server without dispatching any local document or Yjs transaction', async () => {
    const { s, view } = await open();
    api.post.mockResolvedValue({ ...original, current: 'title human\nold\ncontext\nother AI\n', revision: 8 });
    expect(await s.revertCurrentHunk()).toBe(true);
    expect(api.post.mock.calls[0][1].action).toBe('revert');
    expect(view.dispatch).not.toHaveBeenCalled();
    expect(s.diffReview.hunks).toHaveLength(1);
    expect(s.diffReview.hunkIdx).toBe(-1);
    expect(s.diffReview.current).toContain('title human\nold');
    s.navDiffHunk(1);
    expect(s.diffReview).toMatchObject({ hunkIdx: 0, keepPos: false });
  });
  it('rejects stale local coordinates and refreshes without submitting a hunk', async () => {
    const { s, view } = await open();
    const updated = { ...original, base: 'new human\n' + original.base, current: 'new human\n' + original.current, revision: 9 };
    view.state.doc.toString = () => updated.current;
    api.get.mockImplementation(async path => path.includes('/changesets?') ? { changesets: [changeset(1)] } : updated);
    expect(await s.revertCurrentHunk()).toBe(false);
    expect(api.post).not.toHaveBeenCalled();
    expect(s.diffReview.revision).toBe(9);
    expect(s.diffReview.hunks[0].docFrom).toBe(3);
    expect(ui.error).toHaveBeenCalledWith(expect.stringContaining('文档已变化'));
  });
  it('reports a server version conflict then fetches new coordinates without silently retrying', async () => {
    const { s } = await open();
    api.post.mockRejectedValue(Object.assign(new Error('review conflict'), { status: 409 }));
    api.get.mockImplementation(async path => path.includes('/changesets?') ? { changesets: [changeset(1)] } : { ...original, revision: 10 });
    expect(await s.saveCurrentHunk()).toBe(false);
    expect(s.diffReview.revision).toBe(10);
    expect(s.diffReview.busy).toBe(false);
    expect(api.post).toHaveBeenCalledTimes(1);
    expect(ui.error).toHaveBeenCalledWith('review conflict');
  });
  it('reports a conflict only once when its quiet snapshot refresh also fails', async () => {
    const { s } = await open();
    api.post.mockRejectedValue(Object.assign(new Error('review conflict'), { status: 409 }));
    api.get.mockRejectedValue(new Error('refresh offline'));
    expect(await s.saveCurrentHunk()).toBe(false);
    expect(ui.error).toHaveBeenCalledTimes(1); expect(ui.error).toHaveBeenCalledWith('review conflict');
    expect(s.diffReview.stale).toBe(true); expect(s.reviewBusy).toBe(false);
  });
  it('keeps pending state after a failed request and closes only from server pending:false', async () => {
    const { s } = await open();
    api.post.mockRejectedValueOnce(new Error('offline'));
    expect(await s.saveCurrentHunk()).toBe(false);
    expect(s.diffReview.base).toBe(original.base);
    expect(s.diffReview.hunks).toHaveLength(2);
    api.post.mockResolvedValue({ base: original.current, current: original.current, revision: 8, pending: false });
    api.get.mockResolvedValue({ changesets: [] });
    expect(await s.saveCurrentHunk()).toBe(true);
    expect(s.diffReview).toBeNull();
    expect(s.pendingChangesets).toEqual([]);
  });
  it('ignores a refresh response once the review has been closed', async () => {
    const { s } = await open();
    const response = deferred(); api.get.mockReturnValue(response.promise);
    const operation = s.refreshDiffReview();
    s.closeDiffReview(); response.resolve({ ...original, revision: 11 });
    expect(await operation).toBe(false);
    expect(s.diffReview).toBeNull();
  });
});

describe('atomic whole-file review grouping', () => {
  function setup() {
    const store = useEditorStore(); store.projectId = 'a';
    store.pendingChangesets = [changeset(1), changeset(2), changeset(3, 'other.tex')];
    store.loadTree = vi.fn().mockResolvedValue();
    api.get.mockImplementation(async path => path.includes('/changesets?') ? { changesets: [...store.pendingChangesets] } : { pending: true, revision: path.includes('other.tex') ? 8 : 7, current: path.includes('other.tex') ? 'other human + AI' : 'main human + AI' });
    return store;
  }
  it('deduplicates multiple AI rounds for a file and submits one atomic batch from fresh snapshots', async () => {
    const store = setup(); store.diffReview = { filePath: 'main.tex', stale: true };
    api.post.mockResolvedValue({ ok: true, changesets: [], results: [{ filePath: 'main.tex', pending: false, resolved: true }, { filePath: 'other.tex', pending: false, resolved: true }] });
    expect(await store.resolvePendingChangesets('revert')).toBe(true);
    expect(api.get).toHaveBeenCalledTimes(3);
    expect(api.get).toHaveBeenLastCalledWith('/api/projects/a/changesets?status=pending', { cache: 'no-store' });
    expect(api.post).toHaveBeenCalledTimes(1);
    expect(api.post).toHaveBeenCalledWith('/api/projects/a/review/resolve', { action: 'revert', files: [
      { filePath: 'main.tex', revision: 7, current: 'main human + AI' }, { filePath: 'other.tex', revision: 8, current: 'other human + AI' },
    ] });
    expect(store.diffReview).toBeNull(); expect(store.pendingChangesets).toEqual([]); expect(store.reviewBusy).toBe(false);
  });
  it('mutually excludes a second whole operation and hunk operation until the request finishes', async () => {
    const store = setup();
    store.diffReview = { filePath: 'main.tex', hunkIdx: 0, hunks: [{}], current: 'main human + AI', revision: 7 };
    editorRuntime.register({ state: { doc: { toString: () => 'main human + AI' } } });
    const pending = deferred(); api.post.mockReturnValue(pending.promise);
    const first = store.resolvePendingChangesets('accept'); await Promise.resolve(); await Promise.resolve();
    expect(await store.resolvePendingChangesets('revert')).toBe(false); expect(await store.saveCurrentHunk()).toBe(false);
    expect(store.reviewBusy).toBe(true);
    pending.resolve({ changesets: [], results: [{ filePath: 'main.tex', pending: false, resolved: true }] });
    expect(await first).toBe(true); expect(api.post).toHaveBeenCalledTimes(1); expect(store.reviewBusy).toBe(false);
  });
  it('does not automatically retry a stale batch or invoke old changeset writes', async () => {
    const store = setup(); const before = store.pendingChangesets.map(cs => cs.id);
    api.post.mockRejectedValue(Object.assign(new Error('review conflict'), { status: 409 }));
    await expect(store.resolvePendingChangesets('accept')).rejects.toMatchObject({ status: 409 });
    expect(api.post).toHaveBeenCalledTimes(1); expect(store.pendingChangesets.map(cs => cs.id)).toEqual(before); expect(store.reviewBusy).toBe(false);
  });
  it('separates unapplied proposals from the applied text batch and exposes a partial legacy failure', async () => {
    const store = setup(); const proposal = { ...changeset(4, 'proposal.tex'), applied: false };
    store.pendingChangesets.push(proposal);
    api.post.mockImplementation(async path => {
      if (path.endsWith('/review/resolve')) return { changesets: [proposal], results: [{ filePath: 'main.tex', pending: false, resolved: true }, { filePath: 'other.tex', pending: false, resolved: true }] };
      throw Object.assign(new Error('proposal conflict'), { status: 409 });
    });
    await expect(store.resolvePendingChangesets('accept')).rejects.toMatchObject({ status: 409, reviewPartial: true });
    expect(api.post.mock.calls[0][0]).toBe('/api/projects/a/review/resolve');
    expect(api.post.mock.calls[1]).toEqual(['/api/projects/a/changesets/4/accept', { filePath: 'proposal.tex', expectedRevision: 0 }]);
    expect(store.pendingChangesets).toEqual([proposal]); expect(store.reviewBusy).toBe(false);
  });
});


describe('file path lifecycle', () => {
  it('moves every open descendant, main file, comments and saved anchors with a directory', async () => {
    const s = useEditorStore(); s.projectId = 'a'; s.project = { mainFile: 'chapters/main.tex' };
    s.openFiles = ['chapters/main.tex', 'chapters/part.tex', 'chapters-old/keep.tex'];
    s.activeFile = 'chapters/part.tex';
    s.restoredAnchors = { 'chapters/main.tex': 0.4, 'chapters-old/keep.tex': 0.8 };
    s.reviews = [{ id: 1, filePath: 'chapters/part.tex' }, { id: 2, filePath: 'chapters-old/keep.tex' }];
    s.selection = { file: 'chapters/part.tex', text: 'outdated selection' };
    s.searchMatches = { file: 'chapters/part.tex', items: [1] };
    s.diffReview = { filePath: 'chapters/part.tex' };
    localStorage.setItem('corelatex.view.a', JSON.stringify({ anchors: { 'chapters/part.tex': 0.7, 'other.tex': 0.2 } }));
    api.patch.mockResolvedValue({ path: 'chapters', newPath: 'sections', mainFile: 'sections/main.tex' });
    api.get.mockResolvedValue({ changesets: [] });
    expect(await s.renamePath('chapters', 'sections')).toBe(true);
    expect(api.patch).toHaveBeenCalledWith('/api/projects/a/files', { path: 'chapters', newPath: 'sections' });
    expect(s.openFiles).toEqual(['sections/main.tex', 'sections/part.tex', 'chapters-old/keep.tex']);
    expect(s.activeFile).toBe('sections/part.tex'); expect(s.project.mainFile).toBe('sections/main.tex');
    expect(s.reviews.map(r => r.filePath)).toEqual(['sections/part.tex', 'chapters-old/keep.tex']);
    expect(s.restoredAnchors).toEqual({ 'sections/main.tex': 0.4, 'chapters-old/keep.tex': 0.8 });
    expect(s.restoreViewState()).toEqual({ file: 'sections/part.tex', openFiles: [...s.openFiles], anchors: { 'sections/part.tex': 0.7, 'other.tex': 0.2 } });
    expect(s.diffReview).toBeNull(); expect(s.selection).toBeNull(); expect(s.searchMatches).toBeNull();
    expect(api.put).not.toHaveBeenCalled(); // Reload via new collaboration rooms, never copy stale text.
  });
  it('does not close an unrelated active document or invalidate its selection on a single-file rename', async () => {
    const s = useEditorStore(); s.projectId = 'a'; s.project = { mainFile: 'main.tex' };
    s.openFiles = ['main.tex', 'appendix.tex']; s.activeFile = 'main.tex';
    s.selection = { file: 'main.tex', text: 'keep' };
    api.patch.mockResolvedValue({}); api.get.mockResolvedValue({ changesets: [] });
    await s.renamePath('appendix.tex', 'appendix-new.tex');
    expect(s.openFiles).toEqual(['main.tex', 'appendix-new.tex']);
    expect(s.activeFile).toBe('main.tex'); expect(s.selection.text).toBe('keep'); expect(s.project.mainFile).toBe('main.tex');
  });
  it('leaves open paths untouched when rename fails', async () => {
    const s = useEditorStore(); s.projectId = 'a'; s.openFiles = ['main.tex']; s.activeFile = 'main.tex';
    api.patch.mockRejectedValue(new Error('目标已存在'));
    await expect(s.renamePath('main.tex', 'other.tex')).rejects.toThrow('目标已存在');
    expect(s.openFiles).toEqual(['main.tex']); expect(s.activeFile).toBe('main.tex');
    expect(localStorage.getItem('corelatex.view.a')).toBeNull();
  });
  it('ignores rename responses after the project generation has been replaced', async () => {
    const s = useEditorStore(); s.projectId = 'a';
    const response = deferred(); api.patch.mockReturnValue(response.promise);
    const pending = s.renamePath('main.tex', 'other.tex');
    s.reset(); s.projectId = 'a'; s.openFiles = ['main.tex']; s.activeFile = 'main.tex';
    response.resolve({ path: 'main.tex', newPath: 'other.tex' });
    expect(await pending).toBe(false); expect(s.openFiles).toEqual(['main.tex']);
  });
  it('cannot reopen an old-path review from an outstanding snapshot after rename', async () => {
    const s = useEditorStore(); s.projectId = 'a';
    const response = deferred(); api.get.mockImplementation(path => path.includes('/review/base') ? response.promise : Promise.resolve({ changesets: [] }));
    const review = s.openDiffReview([1], 'main.tex');
    api.patch.mockResolvedValue({}); await s.renamePath('main.tex', 'renamed.tex');
    response.resolve({ pending: true, current: 'new', base: 'old', revision: 1 });
    expect(await review).toBe(false); expect(s.diffReview).toBeNull();
  });
});


describe('editor tab persistence', () => {
  it('overwrites remembered files when the last tab is closed, preserving reading anchors', () => {
    const s = useEditorStore(); s.projectId = 'a';
    s.openFile('main.tex'); s.setViewAnchor('main.tex', 0.6); s.saveViewState();
    expect(s.restoreViewState().openFiles).toEqual(['main.tex']);
    s.closeFile('main.tex'); s.saveViewState();
    expect(s.restoreViewState()).toEqual({ file: '', openFiles: [], anchors: { 'main.tex': 0.6 } });
  });
  it.each(['null', '[]', '"invalid"', '{invalid'])('repairs an unusable snapshot %s on the next save', raw => {
    const s = useEditorStore(); s.projectId = 'a';
    localStorage.setItem('corelatex.view.a', raw);
    expect(s.restoreViewState()).toEqual({});
    s.saveViewState();
    expect(s.restoreViewState()).toEqual({ file: '', openFiles: [] });
  });
});


describe('project compilation environment', () => {
  it('waits for local edits to reach the server before submitting the compile', async () => {
    const s = useEditorStore();
    s.projectId = 'a';
    const saved = deferred();
    pendingProjectEdits.mockReturnValueOnce(saved.promise);
    api.post.mockResolvedValue({ status: 'success', pdfUrl: '/pdf?jobId=5', pdfJobId: 5 });
    api.get.mockResolvedValue({});
    const compiling = s.compileProject();
    expect(api.post).not.toHaveBeenCalled();
    saved.resolve();
    await compiling;
    expect(s.compile.pdfJobId).toBe(5);
  });

  it('keeps the previous PDF identity and loads the failed build log after a failed compile', async () => {
    const s = useEditorStore();
    s.projectId = 'a';
    api.get.mockResolvedValueOnce({ pdfUrl: '/pdf?jobId=4', pdfJobId: 4 }).mockResolvedValue({});
    await s.loadPublishedPdf();
    const stamp = s.pdfStamp;
    api.post.mockResolvedValue({ status: 'failed', jobId: 5, pdfJobId: null, pdfUrl: '', logUrl: '/log?jobId=5' });
    api.raw.mockResolvedValue({ text: async () => 'compiler error' });
    await s.compileProject();
    expect(s.compile).toMatchObject({ pdfUrl: '/pdf?jobId=4', pdfJobId: 4, jobId: 5, status: 'failed' });
    expect(s.pdfStamp).toBe(stamp);
    await s.loadLog();
    expect(api.raw).toHaveBeenCalledWith('/log?jobId=5');
  });

  it('sends the selected TeX version without letting compile completion overwrite saved settings', async () => {
    const s = useEditorStore(); s.projectId = 'a'; s.project = { texVersion: '2024', compileEngine: 'xelatex' };
    api.post.mockResolvedValue({ status: 'success', texVersion: '2024', pdfUrl: '/a.pdf' }); api.get.mockResolvedValue({});
    await s.compileProject('xelatex', '2024');
    expect(api.post).toHaveBeenCalledWith('/api/projects/a/compile', {
      engine: 'xelatex', texVersion: '2024', persistSelection: false,
    }, { signal: expect.objectContaining({ aborted: false }) });
    expect(s.project.texVersion).toBe('2024'); expect(s.compile.texVersion).toBe('2024');
  });

  it('saves engine and version through the settings endpoint independently of compilation', async () => {
    const s = useEditorStore(); s.projectId = 'a'; s.project = { texVersion: '2024', compileEngine: 'xelatex' };
    api.patch.mockResolvedValue({ engine: 'pdflatex', texVersion: '2025' });
    expect(await s.saveCompileSettings({ engine: 'pdflatex', texVersion: '2025' })).toBe(true);
    expect(api.patch).toHaveBeenCalledWith('/api/projects/a/compile/settings', { engine: 'pdflatex', texVersion: '2025' },
      { signal: expect.objectContaining({ aborted: false }) });
    expect(s.project).toMatchObject({ compileEngine: 'pdflatex', texVersion: '2025' });
    expect(api.post).not.toHaveBeenCalled();
  });

  it('blocks a shortcut compile until a selection save finishes and then uses the visible settings', async () => {
    const s = useEditorStore(); s.projectId = 'a'; s.project = { texVersion: '2024', compileEngine: 'xelatex' };
    const response = deferred(); api.patch.mockReturnValue(response.promise);
    api.post.mockResolvedValue({ status: 'success', texVersion: '2025', pdfUrl: '/a.pdf' }); api.get.mockResolvedValue({});
    const saving = s.saveCompileSettings({ texVersion: '2025' });
    expect(s.compileSettingsSaving).toBe(true);
    await expect(s.compileProject()).rejects.toThrow('编译设置正在保存');
    expect(api.post).not.toHaveBeenCalled();
    response.resolve({ texVersion: '2025' });
    expect(await saving).toBe(true);
    expect(s.compileSettingsSaving).toBe(false);
    await s.compileProject();
    expect(api.post).toHaveBeenCalledWith('/api/projects/a/compile', {
      engine: 'xelatex', texVersion: '2025', persistSelection: false,
    }, { signal: expect.any(AbortSignal) });
  });

  it('aborts a stalled settings request after thirty seconds and unlocks compilation', async () => {
    vi.useFakeTimers();
    try {
      const s = useEditorStore(); s.projectId = 'a'; s.project = { texVersion: '2024', compileEngine: 'xelatex' };
      api.patch.mockImplementation((_url, _body, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      }));
      const saving = s.saveCompileSettings({ texVersion: '2025' });
      const rejection = expect(saving).rejects.toThrow('结果可能已生效，请刷新后确认');
      const signal = api.patch.mock.calls[0][2].signal;
      await vi.advanceTimersByTimeAsync(29999);
      expect(signal.aborted).toBe(false); expect(s.compileSettingsSaving).toBe(true);
      await vi.advanceTimersByTimeAsync(1); await rejection;
      expect(signal.aborted).toBe(true); expect(s.compileSettingsSaving).toBe(false);
      expect(s.project.texVersion).toBe('2024');
    } finally { vi.useRealTimers(); }
  });

  it('does not mark a settings change as saved if the response omits the value', async () => {
    const s = useEditorStore(); s.projectId = 'a'; s.project = { texVersion: '2024' };
    api.patch.mockResolvedValue({});
    await expect(s.saveCompileSettings({ texVersion: '2025' })).rejects.toThrow('保存结果无效');
    expect(s.project.texVersion).toBe('2024');
    expect(s.compileSettingsSaving).toBe(false);
  });

  it('does not let an old save release a new project save after reset', async () => {
    const s = useEditorStore(); s.projectId = 'a'; s.project = { texVersion: '2024' };
    const old = deferred(), current = deferred();
    api.patch.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const first = s.saveCompileSettings({ texVersion: '2025' });
    s.reset(); s.projectId = 'a'; s.project = { texVersion: '2024' };
    const second = s.saveCompileSettings({ texVersion: '2026' });
    old.resolve({ texVersion: '2025' });
    expect(await first).toBe(false);
    expect(s.compileSettingsSaving).toBe(true);
    current.resolve({ texVersion: '2026' });
    expect(await second).toBe(true);
    expect(s.compileSettingsSaving).toBe(false);
    expect(s.project.texVersion).toBe('2026');
  });

  it('keeps the last saved version when an older in-flight compile succeeds', async () => {
    const s = useEditorStore(); s.projectId = 'a'; s.project = { texVersion: '2024', compileEngine: 'xelatex' };
    const oldCompile = deferred(); api.post.mockReturnValue(oldCompile.promise); api.get.mockResolvedValue({});
    api.patch.mockResolvedValue({ engine: 'xelatex', texVersion: '2025' });
    const compiling = s.compileProject('xelatex', '2024');
    expect(s.compile.status).toBe('running');
    expect(await s.saveCompileSettings({ texVersion: '2025' })).toBe(true);
    expect(s.project.texVersion).toBe('2025');
    oldCompile.resolve({ status: 'success', texVersion: '2024', pdfUrl: '/a.pdf' });
    await compiling;
    expect(s.project.texVersion).toBe('2025'); expect(s.compile.texVersion).toBe('2024');
    expect(s.compile.pdfUrl).toBe('/a.pdf');
  });

  it('leaves saved project settings unchanged when the save request fails', async () => {
    const s = useEditorStore(); s.projectId = 'a'; s.project = { texVersion: '2024', compileEngine: 'xelatex' };
    api.patch.mockRejectedValue(new Error('版本未启用'));
    await expect(s.saveCompileSettings({ texVersion: '2025' })).rejects.toThrow('版本未启用');
    expect(s.project).toMatchObject({ texVersion: '2024', compileEngine: 'xelatex' });
    expect(api.post).not.toHaveBeenCalled();
  });

  it('ignores a saved response after the project has been replaced, even if the identifier is reused', async () => {
    const s = useEditorStore(); s.projectId = 'a'; s.project = { texVersion: '2024' };
    const response = deferred(); api.patch.mockReturnValue(response.promise);
    const pending = s.saveCompileSettings({ texVersion: '2025' });
    s.reset(); s.projectId = 'a'; s.project = { texVersion: '2026' };
    response.resolve({ texVersion: '2025' });
    expect(await pending).toBe(false); expect(s.project.texVersion).toBe('2026');
  });

  it('ignores an old compile response after switching projects', async () => {
    const s = useEditorStore(); s.projectId = 'a'; s.project = { texVersion: '2024' };
    const response = deferred(); api.post.mockReturnValue(response.promise);
    const pending = s.compileProject('xelatex', '2024');
    s.reset(); s.projectId = 'b'; s.project = { texVersion: '2026' };
    response.resolve({ status: 'success', texVersion: '2024', pdfUrl: '/old.pdf' });
    await pending;
    expect(s.project.texVersion).toBe('2026'); expect(s.compile.status).toBe('idle');
    expect(s.compile.pdfUrl).not.toBe('/old.pdf');
  });

  it('actually aborts a stalled request after ten minutes and exposes a timeout', async () => {
    vi.useFakeTimers();
    try {
      const s = useEditorStore(); s.projectId = 'a'; s.project = { texVersion: '2024' };
      api.post.mockImplementation((_url, _body, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      }));
      const pending = s.compileProject('xelatex', '2024');
      const rejection = expect(pending).rejects.toThrow('等待编译结果超时');
      const signal = api.post.mock.calls[0][2].signal;
      await vi.advanceTimersByTimeAsync(599999);
      expect(signal.aborted).toBe(false); expect(s.compile.status).toBe('running');
      await vi.advanceTimersByTimeAsync(1); await rejection;
      expect(signal.aborted).toBe(true); expect(s.compile.status).toBe('failed');
    } finally { vi.useRealTimers(); }
  });

  it('keeps request failures visible and clears them after a successful retry', async () => {
    const s = useEditorStore(); s.projectId = 'a'; s.project = { texVersion: '2024' };
    api.post.mockRejectedValueOnce(new Error('版本未启用'))
      .mockResolvedValueOnce({ status: 'success', texVersion: '2024', pdfUrl: '/a.pdf' });
    api.get.mockResolvedValue({});
    await expect(s.compileProject('xelatex', '2025')).rejects.toThrow('版本未启用');
    expect(s.compile.status).toBe('failed'); expect(s.project.texVersion).toBe('2024');
    expect(s.compile.errors).toEqual([{ source: 'request', file: '', line: 0, message: '版本未启用' }]);
    await s.compileProject('xelatex', '2024');
    expect(s.compile.status).toBe('success');
    expect(s.compile.errors).toEqual([]);
  });

  it('does not change saved settings when compilation fails', async () => {
    const s = useEditorStore(); s.projectId = 'a'; s.project = { texVersion: '2024' };
    api.post.mockResolvedValue({ status: 'failed', texVersion: '2025', errors: [{ message: 'LaTeX error' }] }); api.get.mockResolvedValue({});
    await s.compileProject('xelatex', '2025');
    expect(s.compile.texVersion).toBe('2025'); expect(s.project.texVersion).toBe('2024');
  });
});
