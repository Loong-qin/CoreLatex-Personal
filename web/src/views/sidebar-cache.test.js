// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, h, nextTick, reactive } from 'vue';
import EditorView from './EditorView.vue';
const state = vi.hoisted(() => ({ store: null, mounts: {} }));
vi.mock('vue-router', () => ({ useRoute: () => ({ params: { id: 'test' } }), useRouter: () => ({ push: vi.fn() }) }));
vi.mock('../stores/editor.js', () => ({ useEditorStore: () => state.store }));
vi.mock('../stores/auth.js', () => ({ useAuthStore: () => ({ user: null }) }));
vi.mock('../stores/ui.js', () => ({ useUiStore: () => ({ error: vi.fn() }) }));
vi.mock('../stores/agent.js', () => ({ useAgentStore: () => ({ setProject: vi.fn(), loadSettings: async () => {}, loadChat: async () => {}, restoreActiveRun: async () => {}, clearLocal: vi.fn() }) }));
vi.mock('../lib/collabClient.js', () => ({ setCollabUser: vi.fn() }));
vi.mock('../lib/selectionMenu.js', () => ({ buildSelectionMenuItems: vi.fn() }));
vi.mock('../components/editor/FileTree.vue', () => ({ default: { props: ['active'], setup() { state.mounts.tree = (state.mounts.tree || 0) + 1; }, template: '<div class="cached-tree" :data-active="active"><input aria-label="file filter" /></div>' } }));
vi.mock('../components/editor/WorkspacePanel.vue', () => ({ default: { props: ['active'], setup() { state.mounts.workspace = (state.mounts.workspace || 0) + 1; }, template: '<div class="cached-workspace" :data-active="active" />' } }));
vi.mock('../components/editor/OutlinePanel.vue', () => ({ default: { setup() { state.mounts.outline = (state.mounts.outline || 0) + 1; }, template: '<div class="cached-outline" />' } }));
vi.mock('../components/editor/SearchPanel.vue', () => ({ default: { props: ['active'], setup() { state.mounts.search = (state.mounts.search || 0) + 1; }, template: '<input aria-label="search query" :data-active="active" />' } }));
vi.mock('../components/editor/ReviewPanel.vue', () => ({ default: { template: '<div class="cached-review" />' } }));
vi.mock('../components/editor/AgentPanel.vue', () => ({ default: { setup() { state.mounts.agent = (state.mounts.agent || 0) + 1; }, template: '<div class="cached-agent"><textarea aria-label="agent draft" /></div>' } }));
vi.mock('../components/editor/EditorToolbar.vue', () => ({ default: { template: '<div />' } }));
vi.mock('../components/editor/ChangesetBar.vue', () => ({ default: { template: '<div />' } }));
vi.mock('../components/editor/CodeEditor.vue', () => ({ default: { template: '<textarea aria-label="document" />' } }));
vi.mock('../components/editor/VisualView.vue', () => ({ default: { template: '<div />' } }));
vi.mock('../components/editor/StatusBar.vue', () => ({ default: { template: '<div />' } }));
vi.mock('../components/editor/OverviewBar.vue', () => ({ default: { template: '<div />' } }));
vi.mock('../components/editor/RightDrawer.vue', () => ({ default: { template: '<div />' } }));
let app, el;
const flush = async () => { await Promise.resolve(); await nextTick(); await Promise.resolve(); await nextTick(); };
const click = async (name) => { el.querySelector(`.icon-rail [aria-label="${name}"]`).click(); await flush(); };
beforeEach(() => {
  localStorage.clear(); Object.defineProperty(window, 'innerWidth', { value: 1440, configurable: true }); state.mounts = {};
  state.store = reactive({
    project: { name: 'Cached workbench' }, projectId: 'test', sidebar: 'tree', rightTab: 'pdf', myRole: 'owner', onlineUsers: [], memberCount: 1,
    viewMode: 'code', compile: { status: 'idle' }, tree: [],
    init: async () => true, restoreViewState: () => ({}), compileProject: async () => {}, loadPendingChangesets: vi.fn(), saveViewState: vi.fn(), reset: vi.fn(),
    setSidebar(name) { this.sidebar = this.sidebar === name ? null : name; }, setRightTab(name) { this.rightTab = this.rightTab === name ? null : name; },
  });
});
afterEach(() => { app?.unmount(); el?.remove(); app = null; });
async function mount() {
  el = document.createElement('div'); document.body.appendChild(el); app = createApp(EditorView);
  app.component('el-icon', { setup: (_, { slots }) => () => h('span', slots.default?.()) }); app.mount(el); await flush();
}
describe('sidebar component lifetime', () => {
  it('builds each panel only on first visit and preserves the tree, workspace, outline, filter and scroll across repeated rail switches', async () => {
    await mount();
    const tree = el.querySelector('.cached-tree'), workspace = el.querySelector('.cached-workspace'), outline = el.querySelector('.cached-outline');
    const filter = el.querySelector('[aria-label="file filter"]'); filter.value = 'sec/'; tree.scrollTop = 280;
    expect(state.mounts).toEqual({ tree: 1, workspace: 1, outline: 1 });
    expect(el.querySelector('[aria-label="agent draft"]')).toBeNull();
    for (let i = 0; i < 10; i++) { await click('CoreAgent'); await click('项目树'); }
    expect(state.mounts).toEqual({ tree: 1, workspace: 1, outline: 1, agent: 1 });
    expect(el.querySelector('.cached-tree')).toBe(tree); expect(el.querySelector('.cached-workspace')).toBe(workspace); expect(el.querySelector('.cached-outline')).toBe(outline);
    expect(filter.value).toBe('sec/'); expect(tree.scrollTop).toBe(280);
  });
  it('keeps unsent AI and search input when switching panels or closing and reopening the sidebar', async () => {
    await mount(); await click('CoreAgent');
    const draft = el.querySelector('[aria-label="agent draft"]'); draft.value = 'preserve my instruction';
    await click('文件搜索'); const search = el.querySelector('[aria-label="search query"]'); search.value = 'proof';
    await click('项目树'); await click('CoreAgent'); expect(el.querySelector('[aria-label="agent draft"]')).toBe(draft); expect(draft.value).toBe('preserve my instruction');
    await click('CoreAgent'); expect(el.querySelector('.side-panel').style.display).toBe('none');
    await click('CoreAgent'); expect(el.querySelector('[aria-label="agent draft"]')).toBe(draft);
    await click('文件搜索'); expect(el.querySelector('[aria-label="search query"]')).toBe(search); expect(search.value).toBe('proof');
    expect(state.mounts.agent).toBe(1); expect(state.mounts.search).toBe(1);
  });
  it('deactivates hidden tree shortcuts and search work, including when the whole sidebar is closed', async () => {
    await mount(); expect(el.querySelector('.cached-tree').dataset.active).toBe('true');
    await click('文件搜索'); expect(el.querySelector('.cached-tree').dataset.active).toBe('false'); expect(el.querySelector('.cached-workspace').dataset.active).toBe('false');
    expect(el.querySelector('[aria-label="search query"]').dataset.active).toBe('true');
    await click('文件搜索'); expect(el.querySelector('[aria-label="search query"]').dataset.active).toBe('false');
    await click('项目树'); expect(el.querySelector('.cached-tree').dataset.active).toBe('true');
    await click('项目树'); expect(el.querySelector('.cached-tree').dataset.active).toBe('false');
  });
});
