// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import CodeEditor from './CodeEditor.vue';
import { useEditorStore } from '../../stores/editor.js';
import { editorRuntime } from '../../lib/editorRuntime.js';
import { EditorView } from '@codemirror/view';
import { undo, undoDepth } from '@codemirror/commands';
import { diffDecoField } from '../../lib/diffDecorations.js';
import { api } from '../../api.js';
const collab = vi.hoisted(() => ({ session: null }));
vi.mock('./FilePreview.vue', () => ({ default: { render: () => null } }));
vi.mock('../../api.js', () => ({ api: { get: vi.fn(), post: vi.fn(), raw: vi.fn() } }));
vi.mock('../../stores/ui.js', () => ({ useUiStore: () => ({ error: vi.fn() }) }));
vi.mock('../../lib/collabClient.js', () => ({ attachCollab: () => collab.session, detachCollab: vi.fn(), detachProjectCollab: vi.fn(), subscribeProjectPresence: () => () => {}, detachAllCollab: vi.fn(), setPresenceListener: vi.fn() }));
let app, el, awareness, doc;
const flush = async () => { for (let i = 0; i < 5; i++) { await Promise.resolve(); await nextTick(); } };
const changesets = [{ id: 1, applied: true, status: 'pending', files: [{ filePath: 'main.tex', status: 'pending', applied: true }] }];
async function mount({ room, disk = room, synced = true }) {
  const pinia = createPinia(); setActivePinia(pinia);
  const s = useEditorStore(); s.projectId = 'a'; s.activeFile = 'main.tex'; s.openFiles = ['main.tex'];
  doc = new Y.Doc(); const ytext = doc.getText('codemirror'); if (room) ytext.insert(0, room);
  awareness = new Awareness(doc);
  const handlers = new Map();
  const provider = { synced, awareness, on(event, fn) { if (!handlers.has(event)) handlers.set(event, new Set()); handlers.get(event).add(fn); }, off(event, fn) { handlers.get(event)?.delete(fn); } };
  const emit = (event, value) => { for (const fn of [...(handlers.get(event) || [])]) fn(value); };
  collab.session = { doc, ytext, provider, resetCbs: new Set() };
  api.raw.mockResolvedValue({ text: async () => disk });
  api.get.mockResolvedValue({ changesets });
  el = document.createElement('div'); document.body.appendChild(el);
  app = createApp(CodeEditor); app.use(pinia); app.mount(el); await flush();
  return { s, provider, ytext, emit, view: editorRuntime.view };
}
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear();
  // jsdom does not implement DOM range geometry used by CodeMirror's selection layer.
  Range.prototype.getClientRects = () => [];
  Range.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 });
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
});
afterEach(() => { app?.unmount(); el?.remove(); awareness?.destroy(); doc?.destroy(); editorRuntime.register(null); vi.unstubAllGlobals(); delete Range.prototype.getClientRects; delete Range.prototype.getBoundingClientRect; });
describe('CodeEditor atomic review snapshots', () => {
  it('renders exactly the store snapshot with one GET and no unchanged context highlight', async () => {
    const current = 'human title\nAI first\ncontext\nAI second\n';
    const { s, view, ytext } = await mount({ room: current });
    api.get.mockResolvedValue({ base: 'human title\nold first\ncontext\nold second\n', current, revision: 2, pending: true });
    await s.openDiffReview([1], 'main.tex', true, true); await flush();
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(s.diffReview.hunks).toHaveLength(2);
    expect(view.state.field(diffDecoField).size).toBeGreaterThan(0);
    const lines = [...el.querySelectorAll('.cm-line.cm-diff-add')].map((n) => n.textContent);
    expect(lines).not.toContain('context'); expect(lines).not.toContain('human title');
    expect(ytext.toString()).toBe(current);
  });
  it.each([
    ['mixed LF/CRLF', 'human title\r\nAI first\ncontext\nAI second\n', 'human title\r\nold first\ncontext\nold second\n'],
    ['CRLF', 'human title\r\nAI first\r\ncontext\r\nAI second\r\n', 'human title\r\nold first\r\ncontext\r\nold second\r\n'],
  ])('reviews %s without normalizing the document or repeatedly refreshing', async (_kind, current, base) => {
    const { s, view, ytext } = await mount({ room: current });
    const updates = vi.fn(); doc.on('update', updates);
    api.get.mockResolvedValue({ base, current, revision: 2, pending: true });
    await s.openDiffReview([1], 'main.tex', true, true); await flush();
    expect(view.state.doc.toString()).toBe(current);
    expect(ytext.toString()).toBe(current);
    expect(s.diffReview).toMatchObject({ stale: false, current, revision: 2 });
    expect(s.diffReview.hunks.map(h => h.docFrom)).toEqual([2, 4]);
    expect(view.state.field(diffDecoField).size).toBeGreaterThan(0);
    const lines = [...el.querySelectorAll('.cm-line.cm-diff-add')].map(n => n.textContent);
    expect(lines.some(line => line.includes('AI first'))).toBe(true);
    expect(lines.some(line => line.includes('AI second'))).toBe(true);
    expect(lines.some(line => line.includes('context'))).toBe(false);
    await new Promise(resolve => setTimeout(resolve, 420)); await flush();
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(updates).not.toHaveBeenCalled();
    expect(undoDepth(view.state)).toBe(0);
  });

  it.each(['accept', 'revert'])('submits the exact mixed-newline snapshot when resolving a hunk with %s', async action => {
    const current = 'title\r\nAI body\nunchanged\n';
    const base = 'title\r\nold body\nunchanged\n';
    const { s, view, ytext } = await mount({ room: current });
    let pending = true;
    api.get.mockImplementation(async path => path.includes('/review/base')
      ? { base, current, revision: 7, pending }
      : { changesets: pending ? changesets : [] });
    await s.openDiffReview([1], 'main.tex', true, true); await flush();
    const updates = vi.fn(); doc.on('update', updates);
    s.navDiffHunk(1); await flush();
    api.post.mockImplementation(async () => {
      pending = false;
      const resolved = action === 'accept' ? current : base;
      return { base: resolved, current: resolved, revision: 8, pending: false, changesets: [] };
    });
    expect(await s.resolveCurrentHunk(action)).toBe(true); await flush();
    expect(api.post).toHaveBeenCalledOnce();
    expect(api.post).toHaveBeenCalledWith('/api/projects/a/review/hunk', {
      file: 'main.tex', action, revision: 7, current,
      baseFrom: 2, baseTo: 2, docFrom: 2, docTo: 2,
    });
    // The HTTP result must never replay text into the live room. A server-side
    // revert reaches the editor through its ordinary collaboration update.
    expect(view.state.doc.toString()).toBe(current);
    expect(ytext.toString()).toBe(current);
    expect(updates).not.toHaveBeenCalled();
    expect(s.diffReview).toBeNull();
  });

  it.each(['accept', 'revert'])('keeps the reading position at 0/5 and 0/4 after %s, then jumps on Next', async action => {
    const base = 'title\n' + Array.from({ length: 5 }, (_, i) => `old ${i + 1}\ncontext ${i + 1}\n`).join('');
    const current = base.replaceAll('old ', 'new ');
    const { s, view, ytext } = await mount({ room: current });
    view.dispatch({ selection: { anchor: 3 } });
    view.scrollDOM.scrollTop = 180;
    const scroll = vi.spyOn(EditorView, 'scrollIntoView');
    try {
      api.get.mockImplementation(async path => path.includes('/review/base')
        ? { base, current, revision: 7, pending: true } : { changesets });
      await s.openDiffReview([1], 'main.tex', true, true); await flush();
      expect(s.diffReview.hunks).toHaveLength(5);
      expect(s.diffReview.hunkIdx).toBe(-1);
      expect(scroll).not.toHaveBeenCalled();
      expect(view.state.selection.main.anchor).toBe(3);
      expect(view.scrollDOM.scrollTop).toBe(180);
      s.navDiffHunk(1); await flush();
      expect(scroll).toHaveBeenLastCalledWith(s.diffReview.hunks[0].from, { y: 'center', yMargin: 0 });
      s.gotoDiffHunk(2); await flush();
      scroll.mockClear();
      api.post.mockImplementation(async () => {
        const nextCurrent = action === 'revert' ? current.replace('new 3', 'old 3') : current;
        if (action === 'revert') {
          const from = current.indexOf('new 3');
          doc.transact(() => { ytext.delete(from, 5); ytext.insert(from, 'old 3'); });
        }
        return { base: action === 'accept' ? base.replace('old 3', 'new 3') : base,
          current: nextCurrent, revision: 8, pending: true, changesets };
      });
      expect(await s.resolveCurrentHunk(action)).toBe(true); await flush();
      expect(s.diffReview.hunks).toHaveLength(4);
      expect(s.diffReview.hunkIdx).toBe(-1);
      expect(scroll).not.toHaveBeenCalled();
      expect(view.state.selection.main.anchor).toBe(3);
      expect(view.scrollDOM.scrollTop).toBe(180);
      s.navDiffHunk(1); await flush();
      expect(s.diffReview.hunkIdx).toBe(0);
      expect(scroll).toHaveBeenLastCalledWith(s.diffReview.hunks[0].from, { y: 'center', yMargin: 0 });
    } finally { scroll.mockRestore(); }
  });

  it('keeps mixed-newline offsets aligned during local edits, remote edits and trailing deletion', async () => {
    const current = 'heading\r\nbody\ntail\r\n';
    const { view, ytext } = await mount({ room: current });
    const localOffset = current.indexOf('body') + 2;
    view.dispatch({ changes: { from: localOffset, insert: ' local ' } });
    const local = current.slice(0, localOffset) + ' local ' + current.slice(localOffset);
    expect(view.state.doc.toString()).toBe(local);
    expect(ytext.toString()).toBe(local);
    const remoteOffset = local.indexOf('tail');
    ytext.insert(remoteOffset, 'remote '); await flush();
    const remote = local.slice(0, remoteOffset) + 'remote ' + local.slice(remoteOffset);
    expect(view.state.doc.toString()).toBe(remote);
    expect(ytext.toString()).toBe(remote);
    expect(() => ytext.delete(ytext.length - 2, 2)).not.toThrow(); await flush();
    expect(view.state.doc.toString()).toBe(remote.slice(0, -2));
    expect(ytext.toString()).toBe(remote.slice(0, -2));
  });

  it.each(['\n', '\r\n'])('invalidates old coordinates after remote edits with %j line endings and re-fetches projected human changes', async separator => {
    const current = `title${separator}AI body\n`;
    const { s, view, ytext } = await mount({ room: current });
    api.get.mockResolvedValue({ base: `title${separator}old body\n`, current, revision: 2, pending: true });
    await s.openDiffReview([1], 'main.tex', true, true); await flush();
    const next = 'human intro\n' + current;
    api.get.mockResolvedValue({ base: `human intro\ntitle${separator}old body\n`, current: next, revision: 3, pending: true });
    ytext.insert(0, 'human intro\n'); await flush();
    expect(s.diffReview.stale).toBe(true);
    expect(view.state.field(diffDecoField).size).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 180)); await flush();
    expect(s.diffReview.stale).toBe(false);
    expect(s.diffReview.revision).toBe(3);
    expect(s.diffReview.hunks[0].docFrom).toBe(3);
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(ytext.toString()).toBe(next);
  });
  it('reapplies an initial reading ratio against a late room document, without timed retries', async () => {
    const disk = Array.from({ length: 100 }, (_, i) => `old ${i}`).join('\n');
    const room = Array.from({ length: 500 }, (_, i) => `new ${i}`).join('\n');
    const { s, provider, ytext, emit, view } = await mount({ room: '', disk, synced: false });
    Object.defineProperties(view.scrollDOM, { clientHeight: { configurable: true, value: 500 }, clientWidth: { configurable: true, value: 600 } });
    const scroll = vi.spyOn(EditorView, 'scrollIntoView');
    s.restoredAnchors = { 'main.tex': 0.6 }; await flush();
    expect(scroll).toHaveBeenLastCalledWith(view.state.doc.line(60).from, { y: 'start', yMargin: 0 });
    ytext.insert(0, room); provider.synced = true; emit('sync', true); await flush();
    expect(scroll).toHaveBeenLastCalledWith(view.state.doc.line(300).from, { y: 'start', yMargin: 0 });
    scroll.mockRestore();
  });
  it('cancels a saved ratio when the user navigates before the late handshake', async () => {
    const { s, provider, ytext, emit, view } = await mount({ room: '', disk: 'old\ntext', synced: false });
    Object.defineProperties(view.scrollDOM, { clientHeight: { configurable: true, value: 500 }, clientWidth: { configurable: true, value: 600 } });
    const scroll = vi.spyOn(EditorView, 'scrollIntoView');
    s.restoredAnchors = { 'main.tex': 0.6 }; await flush(); const count = scroll.mock.calls.length;
    view.scrollDOM.dispatchEvent(new Event('wheel'));
    ytext.insert(0, 'new\nserver\ntext'); provider.synced = true; emit('sync', true); await flush();
    expect(scroll).toHaveBeenCalledTimes(count); scroll.mockRestore();
  });
  it('does not add a late authoritative collaboration snapshot to user undo history', async () => {
    const { provider, ytext, emit, view } = await mount({ room: 'new server content\n', disk: 'outdated HTTP snapshot\n', synced: false });
    expect(undoDepth(view.state)).toBe(0);
    provider.synced = true; emit('sync', true); await flush();
    expect(view.state.doc.toString()).toBe('new server content\n');
    expect(undoDepth(view.state)).toBe(0); expect(undo(view)).toBe(false);
    expect(ytext.toString()).toBe('new server content\n');
  });
  it('never publishes an offline review snapshot over a newer collaboration room', async () => {
    const { s, provider, ytext, emit, view } = await mount({ room: 'new human text\n', disk: 'old disk\n', synced: false });
    api.get.mockResolvedValue({ base: 'old base\n', current: 'AI snapshot\n', revision: 2, pending: true });
    await s.openDiffReview([1], 'main.tex', true, true); await flush();
    expect(view.state.doc.toString()).toBe('AI snapshot\n');
    expect(ytext.toString()).toBe('new human text\n');
    // The new room arrives while review is still open, then the review is dismissed.
    provider.synced = true; emit('sync', true); await flush();
    expect(view.state.doc.toString()).toBe('new human text\n');
    s.closeDiffReview(); await flush();
    expect(ytext.toString()).toBe('new human text\n');
    expect(view.state.doc.toString()).toBe('new human text\n');
  });
});


describe('CodeEditor offline snapshot causality', () => {
  it('does not publish a delayed offline HTTP response after a live handshake and edit', async () => {
    const { s, provider, ytext, emit, view } = await mount({ room: '', disk: 'old disk\n', synced: false });
    let respond; api.raw.mockImplementationOnce(() => new Promise(resolve => { respond = resolve; }));
    s.pendingChangesets = [{ id: 99, status: 'pending', files: [] }]; await flush();
    expect(respond).toBeTypeOf('function');
    ytext.insert(0, 'new room\n'); provider.synced = true; emit('sync', true); await flush();
    view.dispatch({ changes: { from: view.state.doc.length, insert: 'new user paragraph\n' } });
    const updates = vi.fn(); doc.on('update', updates);
    respond({ text: async () => 'old disk\n' }); await flush();
    expect(view.state.doc.toString()).toBe('new room\nnew user paragraph\n');
    expect(ytext.toString()).toBe('new room\nnew user paragraph\n'); expect(updates).not.toHaveBeenCalled();
  });

  it('applies only the newest offline snapshot when responses arrive in reverse order', async () => {
    const { s, view, ytext } = await mount({ room: '', disk: 'initial', synced: false });
    let first, second;
    api.raw.mockImplementationOnce(() => new Promise(resolve => { first = resolve; }));
    s.pendingChangesets = [{ id: 1 }]; await flush();
    api.raw.mockImplementationOnce(() => new Promise(resolve => { second = resolve; }));
    s.pendingChangesets = [{ id: 2 }]; await flush();
    second({ text: async () => 'latest offline snapshot' }); await flush();
    first({ text: async () => 'older offline snapshot' }); await flush();
    expect(view.state.doc.toString()).toBe('latest offline snapshot'); expect(ytext.toString()).toBe('');
    expect(undoDepth(view.state)).toBe(0);
  });

  it('ignores an old project snapshot after its store changes projects', async () => {
    const { s, view } = await mount({ room: '', disk: 'project A', synced: false });
    let respond; api.raw.mockImplementationOnce(() => new Promise(resolve => { respond = resolve; }));
    s.pendingChangesets = [{ id: 1 }]; await flush();
    s.projectId = 'b'; respond({ text: async () => 'late A response' }); await flush();
    expect(view.state.doc.toString()).toBe('project A');
  });

  it('makes a disconnected editor read-only without destroying its text, then rebinds after sync', async () => {
    const { provider, ytext, emit, view } = await mount({ room: 'saved\n' });
    view.dispatch({ changes: { from: view.state.doc.length, insert: 'not delivered\n' } });
    provider.synced = false; emit('status', { status: 'disconnected' }); await flush();
    expect(view.state.readOnly).toBe(true); expect(view.state.doc.toString()).toBe('saved\nnot delivered\n');
    ytext.insert(0, 'remote edit\n');
    expect(view.state.doc.toString()).not.toContain('remote edit');
    provider.synced = true; emit('sync', true); await flush();
    expect(view.state.readOnly).toBe(false); expect(view.state.doc.toString()).toBe('remote edit\nsaved\nnot delivered\n');
  });

  it('offers recovery download without applying it, including memory-only storage failure', async () => {
    const { ytext } = await mount({ room: 'authoritative' });
    collab.session.recoveryDrafts = [{ id: 'draft', capturedAt: 1700000000000, text: 'unsent local draft' }];
    collab.session.recoveryStorageError = true;
    // Status callbacks refresh recovery metadata even if the room stays offline.
    collab.session.provider.synced = false;
    // Remount provides the same real recovery UI and an ordinary live room.
    app.unmount(); app = null;
    const pinia = createPinia(); setActivePinia(pinia);
    const s = useEditorStore(); s.projectId = 'a'; s.activeFile = 'main.tex'; s.openFiles = ['main.tex'];
    collab.session.provider.synced = true;
    collab.session.clearRecoveryDraft = vi.fn();
    app = createApp(CodeEditor); app.use(pinia); app.mount(el); await flush();
    expect(el.querySelector('.recovery-banner')?.textContent).toContain('暂存于内存');
    const createUrl = vi.fn(() => 'blob:recovery'); vi.stubGlobal('URL', { createObjectURL: createUrl, revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    [...el.querySelectorAll('.recovery-banner button')].find(button => button.textContent === '下载恢复稿').click();
    expect(createUrl).toHaveBeenCalledOnce(); expect(click).toHaveBeenCalledOnce(); expect(ytext.toString()).toBe('authoritative');
    [...el.querySelectorAll('.recovery-banner button')].find(button => button.textContent === '已恢复，清除').click();
    expect(collab.session.clearRecoveryDraft).toHaveBeenCalledWith('draft'); click.mockRestore();
  });
});
