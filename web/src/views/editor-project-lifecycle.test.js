// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, h, nextTick, reactive } from 'vue';
import EditorView from './EditorView.vue';
import { api } from '../api.js';
import { buildSelectionMenuItems } from '../lib/selectionMenu.js';
const state = vi.hoisted(() => ({
  store: null, mounts: {}, route: null, agent: null, runtime: null,
  push: vi.fn(), error: vi.fn(), toast: vi.fn(), prompt: vi.fn(), openContextMenu: vi.fn(),
}));
vi.mock('vue-router', () => ({ useRoute: () => state.route, useRouter: () => ({ push: state.push }) }));
vi.mock('../stores/editor.js', () => ({ useEditorStore: () => state.store }));
vi.mock('../stores/auth.js', () => ({ useAuthStore: () => ({ user: null }) }));
vi.mock('../stores/ui.js', () => ({ useUiStore: () => ({ error: state.error, toast: state.toast, openContextMenu: state.openContextMenu }) }));
vi.mock('../stores/agent.js', () => ({ useAgentStore: () => state.agent }));
vi.mock('../api.js', () => ({ api: { head: vi.fn(), get: vi.fn(), post: vi.fn() } }));
vi.mock('../lib/collabClient.js', () => ({ setCollabUser: vi.fn() }));
vi.mock('../lib/editorRuntime.js', () => ({ useEditorRuntime: () => state.runtime }));
vi.mock('../lib/selectionMenu.js', () => ({ buildSelectionMenuItems: vi.fn() }));
vi.mock('element-plus', () => ({ ElMessageBox: { prompt: state.prompt } }));
vi.mock('../components/editor/FileTree.vue', () => ({ default: { props: ['active'], setup() { state.mounts.tree = (state.mounts.tree || 0) + 1; }, template: '<div class="cached-tree" :data-active="active"><input aria-label="file filter" /></div>' } }));
vi.mock('../components/editor/WorkspacePanel.vue', () => ({ default: { props: ['active'], setup() { state.mounts.workspace = (state.mounts.workspace || 0) + 1; }, template: '<div class="cached-workspace" :data-active="active" />' } }));
vi.mock('../components/editor/OutlinePanel.vue', () => ({ default: { setup() { state.mounts.outline = (state.mounts.outline || 0) + 1; }, template: '<div class="cached-outline" />' } }));
vi.mock('../components/editor/SearchPanel.vue', () => ({ default: { props: ['active'], setup() { state.mounts.search = (state.mounts.search || 0) + 1; }, template: '<input aria-label="search query" :data-active="active" />' } }));
vi.mock('../components/editor/ReviewPanel.vue', () => ({ default: { template: '<div class="cached-review" />' } }));
vi.mock('../components/editor/AgentPanel.vue', () => ({ default: { setup() { state.mounts.agent = (state.mounts.agent || 0) + 1; }, template: '<div class="cached-agent"><textarea aria-label="agent draft" /></div>' } }));
vi.mock('../components/editor/EditorToolbar.vue', () => ({ default: { template: '<div />' } }));
vi.mock('../components/editor/ChangesetBar.vue', () => ({ default: { template: '<div />' } }));
vi.mock('../components/editor/CodeEditor.vue', () => ({
  default: {
    setup(_, { emit }) {
      const selection = () => ({ projectId: state.store.projectId, filePath: state.store.activeFile, from: 1, to: 6, text: 'words' });
      return () => h('textarea', {
        'aria-label': 'document',
        onClick: () => emit('add-review', selection()),
        onContextmenu: () => emit('context-menu', { ...selection(), x: 50, y: 50 }),
      });
    },
  },
}));
vi.mock('../components/editor/VisualView.vue', () => ({ default: { template: '<div />' } }));
vi.mock('../components/editor/StatusBar.vue', () => ({ default: { template: '<div />' } }));
vi.mock('../components/editor/OverviewBar.vue', () => ({ default: { template: '<div />' } }));
vi.mock('../components/editor/RightDrawer.vue', () => ({ default: { template: '<div />' } }));
vi.mock('../components/editor/ProjectSwitcher.vue', () => ({ default: { template: '<span />' } }));
let app, el;
const flush = async () => { for (let i = 0; i < 4; i++) { await Promise.resolve(); await nextTick(); } };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); state.mounts = {};
  state.route = reactive({ params: { id: 'A' } });
  state.agent = { setProject: vi.fn(), loadSettings: vi.fn(async () => {}), loadChat: vi.fn(async () => {}), restoreActiveRun: vi.fn(async () => {}), clearLocal: vi.fn() };
  state.runtime = reactive({ view: null, projectId: null, filePath: '' });
  api.head.mockResolvedValue({ ok: true });
  state.store = reactive({
    project: { name: 'Project A' }, projectId: 'A', projectVersion: 0, sidebar: 'tree', rightTab: 'pdf', myRole: 'owner', onlineUsers: [], memberCount: 1,
    viewMode: 'code', compile: { status: 'idle' }, tree: [], addReview: vi.fn(async () => {}),
    init: vi.fn(async () => { state.store.projectVersion++; return true; }), restoreViewState: vi.fn(() => ({})), compileProject: vi.fn(async () => {}),
    loadPendingChangesets: vi.fn(), saveViewState: vi.fn(), reset: vi.fn(() => { state.store.projectVersion++; }),
    openFile(path) { if (!this.openFiles.includes(path)) this.openFiles.push(path); this.activeFile = path; },
    closeFile(path) { this.openFiles = this.openFiles.filter(file => file !== path); if (this.activeFile === path) this.activeFile = this.openFiles[0] || ''; },
    setSidebar(name) { this.sidebar = this.sidebar === name ? null : name; }, setRightTab(name) { this.rightTab = this.rightTab === name ? null : name; },
  });
});
afterEach(() => { app?.unmount(); el?.remove(); app = null; });
async function mount() {
  el = document.createElement('div'); document.body.appendChild(el); app = createApp(EditorView);
  app.component('el-icon', { setup: (_, { slots }) => () => h('span', slots.default?.()) }); app.mount(el); await flush();
  await new Promise(resolve => setTimeout(resolve, 0)); await flush();
}
describe('project editor async ownership', () => {
  it('starts restored work only for the mounted project and saves it on departure', async () => {
    await mount();
    expect(state.agent.setProject).toHaveBeenCalledWith('A');
    expect(state.agent.restoreActiveRun).toHaveBeenCalledWith('A');
    expect(state.agent.loadChat).not.toHaveBeenCalled();
    expect(state.store.compileProject).toHaveBeenCalledOnce();
    expect(document.title).toBe('Project A · CoreLatex');
    state.store.project.name = 'Renamed A'; await flush();
    expect(document.title).toBe('Renamed A · CoreLatex');
    app.unmount(); app = null;
    expect(document.title).toBe('CoreLatex');
    expect(state.store.saveViewState).toHaveBeenCalledOnce();
    expect(state.agent.clearLocal).toHaveBeenCalledOnce();
    expect(state.store.reset).toHaveBeenCalledOnce();
  });
  it.each(['resolve', 'reject'])('ignores a late init %s after leaving, without compiling or redirecting the new page', async (settle) => {
    const pending = deferred();
    state.store.init.mockImplementation(() => { state.store.projectVersion++; return pending.promise; });
    await mount(); app.unmount(); app = null;
    state.route.params.id = 'B'; state.store.projectId = 'B'; state.store.projectVersion++;
    pending[settle](settle === 'resolve' ? true : new Error('old project failed')); await flush();
    expect(state.agent.setProject).not.toHaveBeenCalled();
    expect(state.agent.restoreActiveRun).not.toHaveBeenCalled();
    expect(state.agent.loadChat).not.toHaveBeenCalled();
    expect(state.store.restoreViewState).not.toHaveBeenCalled();
    expect(state.store.compileProject).not.toHaveBeenCalled();
    expect(state.error).not.toHaveBeenCalled(); expect(state.push).not.toHaveBeenCalled();
  });
  it('does not clear another project generation when an old view is disposed', async () => {
    await mount(); state.store.projectId = 'B'; state.store.projectVersion++;
    document.title = 'Project B · CoreLatex';
    app.unmount(); app = null;
    expect(document.title).toBe('Project B · CoreLatex');
    expect(state.store.saveViewState).not.toHaveBeenCalled();
    expect(state.agent.clearLocal).not.toHaveBeenCalled();
    expect(state.store.reset).not.toHaveBeenCalled();
  });

  it('uses the context menu selection file after the active tab changes', async () => {
    const pending = deferred();
    state.prompt.mockReturnValueOnce(pending.promise);
    state.store.reviewMode = true;
    state.store.activeFile = 'main.tex';
    await mount();
    el.querySelector('textarea[aria-label="document"]').dispatchEvent(new MouseEvent('contextmenu'));
    const [{ onAddReview }] = buildSelectionMenuItems.mock.lastCall;
    state.store.activeFile = 'other.tex';
    onAddReview();
    state.store.activeFile = 'chapter.tex';
    pending.resolve({ value: ' Please include a definition. ' });
    await flush();
    expect(state.store.addReview).toHaveBeenCalledWith({
      filePath: 'main.tex', start: 1, end: 6, quotedText: 'words', content: 'Please include a definition.',
    });
  });

  it('ignores a review dialog confirmation after its project is replaced', async () => {
    const pending = deferred();
    state.prompt.mockReturnValueOnce(pending.promise);
    state.store.activeFile = 'main.tex';
    await mount();
    el.querySelector('textarea[aria-label="document"]').click();
    expect(state.prompt).toHaveBeenCalledOnce();
    state.store.projectId = 'B';
    state.store.projectVersion++;
    pending.resolve({ value: 'Add a reference' });
    await flush();
    expect(state.store.addReview).not.toHaveBeenCalled();
  });
});


describe('project editor startup ordering', () => {
  it('waits for the active text snapshot before automatically compiling once', async () => {
    state.store.project.mainFile = 'main.tex'; state.store.openFiles = ['main.tex']; state.store.activeFile = 'main.tex';
    await mount();
    expect(state.store.compileProject).not.toHaveBeenCalled();
    state.runtime.projectId = 'A'; state.runtime.filePath = 'main.tex'; state.runtime.view = { requestMeasure: vi.fn() }; await flush();
    expect(state.store.compileProject).toHaveBeenCalledOnce();
    state.runtime.view = null; await flush(); state.runtime.view = { requestMeasure: vi.fn() }; await flush();
    expect(state.store.compileProject).toHaveBeenCalledOnce();
  });
  it('falls back to the main file when the restored active workspace file no longer exists', async () => {
    state.store.project.mainFile = 'main.tex'; state.store.treeLoaded = false; state.store.treeVersion = 0;
    state.store.openFiles = ['main.tex']; state.store.activeFile = 'main.tex'; state.store.restoredAnchors = {};
    state.store.restoreViewState.mockReturnValue({ file: '_workspace/deleted.txt', openFiles: ['_workspace/deleted.txt'] });
    api.head.mockRejectedValueOnce(Object.assign(new Error('文件不存在'), { status: 404 }));
    await mount();
    expect(api.head).toHaveBeenCalledWith('/api/projects/A/file?path=_workspace%2Fdeleted.txt', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(state.store.openFiles).toEqual(['main.tex']); expect(state.store.activeFile).toBe('main.tex');
    expect(state.store.compileProject).not.toHaveBeenCalled();
    state.runtime.projectId = 'A'; state.runtime.filePath = 'main.tex'; state.runtime.view = { requestMeasure: vi.fn() }; await flush();
    expect(state.store.compileProject).toHaveBeenCalledOnce();
  });
  it('does not let a late workspace existence result override the user switching files', async () => {
    state.store.project.mainFile = 'main.tex'; state.store.treeLoaded = false; state.store.treeVersion = 0;
    state.store.openFiles = ['main.tex']; state.store.activeFile = 'main.tex'; state.store.restoredAnchors = {};
    state.store.restoreViewState.mockReturnValue({ file: '_workspace/old.txt', openFiles: ['_workspace/old.txt', 'main.tex'] });
    const pending = deferred(); api.head.mockReturnValueOnce(pending.promise);
    await mount(); const signal = api.head.mock.calls[0][1].signal;
    state.store.activeFile = 'main.tex'; await flush(); expect(signal.aborted).toBe(true);
    pending.reject(Object.assign(new Error('文件不存在'), { status: 404 })); await flush();
    expect(state.store.activeFile).toBe('main.tex'); expect(state.store.openFiles).toEqual(['_workspace/old.txt', 'main.tex']);
  });
  it('preserves workspace tabs and reconciles remembered project tabs after the tree arrives', async () => {
    state.store.project.mainFile = 'main.tex'; state.store.treeLoaded = false; state.store.treeVersion = 0;
    state.store.openFiles = ['main.tex']; state.store.activeFile = 'main.tex'; state.store.restoredAnchors = {};
    state.store.restoreViewState.mockReturnValue({ file: '_workspace/note.md', openFiles: ['missing.tex', '_workspace/note.md'], anchors: { '_workspace/note.md': 0.5 } });
    await mount();
    expect(state.store.openFiles).toEqual(['missing.tex', '_workspace/note.md']);
    expect(state.store.activeFile).toBe('_workspace/note.md');
    state.store.openFiles.push('new.tex'); state.store.activeFile = 'new.tex';
    state.store.tree = [{ path: 'main.tex', type: 'file' }, { path: 'new.tex', type: 'file' }]; state.store.treeLoaded = true; state.store.treeVersion++;
    await flush();
    expect(state.store.openFiles).toEqual(['_workspace/note.md', 'new.tex']); expect(state.store.activeFile).toBe('new.tex');
    expect(state.store.restoredAnchors).toEqual({ '_workspace/note.md': 0.5 });
  });
});

describe('restored editor tabs', () => {
  const prepare = (snapshot) => {
    state.store.openFiles = ['main.tex']; state.store.activeFile = 'main.tex'; state.store.restoredAnchors = {};
    state.store.tree = [{ path: 'main.tex' }, { kind: 'group', children: [{ path: 'sections/part.tex' }] }];
    state.store.restoreViewState.mockReturnValue(snapshot);
  };
  it('keeps the default main file on first visit without a saved tab list', async () => {
    prepare({}); await mount();
    expect(state.store.openFiles).toEqual(['main.tex']); expect(state.store.activeFile).toBe('main.tex');
  });
  it('honors an explicitly empty workspace after closing every tab', async () => {
    prepare({ file: '', openFiles: [], anchors: { 'main.tex': 0.6 } }); await mount();
    expect(state.store.openFiles).toEqual([]); expect(state.store.activeFile).toBe('');
    expect(state.store.restoredAnchors).toEqual({}); expect(state.store.compileProject).toHaveBeenCalledOnce();
  });
  it('selects a surviving tab if the previously active file was removed', async () => {
    prepare({ file: 'removed.tex', openFiles: ['removed.tex', 'sections/part.tex', 'sections/part.tex'], anchors: { 'sections/part.tex': 0.4, 'removed.tex': 0.8 } });
    await mount();
    expect(state.store.openFiles).toEqual(['sections/part.tex']); expect(state.store.activeFile).toBe('sections/part.tex');
    expect(state.store.restoredAnchors).toEqual({ 'sections/part.tex': 0.4 });
  });
  it('falls back to the main file when every remembered file has disappeared', async () => {
    prepare({ file: 'removed.tex', openFiles: ['removed.tex'] }); await mount();
    expect(state.store.openFiles).toEqual(['main.tex']); expect(state.store.activeFile).toBe('main.tex');
  });
  it('ignores malformed tab lists without aborting project initialization', async () => {
    prepare({ openFiles: 'main.tex' }); await mount();
    expect(state.store.activeFile).toBe('main.tex'); expect(state.error).not.toHaveBeenCalled();
    expect(state.store.compileProject).not.toHaveBeenCalled();
    state.runtime.projectId = 'A'; state.runtime.filePath = 'main.tex'; state.runtime.view = { requestMeasure: vi.fn() }; await flush();
    expect(state.store.compileProject).toHaveBeenCalledOnce();
  });
});
