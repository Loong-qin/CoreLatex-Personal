// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, h, nextTick, reactive } from 'vue';
import FileTree from './FileTree.vue';
import WorkspacePanel from './WorkspacePanel.vue';
import SearchPanel from './SearchPanel.vue';
import ReviewPanel from './ReviewPanel.vue';
const state = vi.hoisted(() => ({ store: null, mounts: 0, api: { raw: vi.fn(), get: vi.fn() } }));
vi.mock('../../stores/editor.js', () => ({ useEditorStore: () => state.store }));
vi.mock('../../stores/ui.js', () => ({ useUiStore: () => ({ error: vi.fn(), toast: vi.fn() }) }));
vi.mock('../../api.js', () => ({ api: state.api, getToken: () => '', timeAgo: () => '' }));
vi.mock('../../stores/auth.js', () => ({ useAuthStore: () => ({ user: null }) }));
vi.mock('../../stores/agent.js', () => ({ useAgentStore: () => ({ streaming: false }) }));
vi.mock('../../lib/editorRuntime.js', () => ({ editorRuntime: { view: null, jumpToLine: vi.fn() }, useEditorRuntime: () => ({ view: null, jumpToLine: vi.fn() }) }));
let app, el, active;
const file = (path) => ({ path, name: path.split('/').pop(), type: 'file', size: 20 });
const flush = async () => { await Promise.resolve(); await nextTick(); await Promise.resolve(); await nextTick(); };
const content = { props: ['content'], template: '<span :title="content"><slot /></span>' };
const treeStub = {
  props: ['data'], emits: ['node-click'],
  setup(_, { expose }) { state.mounts++; expose({ store: { nodesMap: {} } }); },
  template: '<div data-tree-instance><button v-for="node in data.flatMap(g => g.children)" :key="node.path" @click="$emit(\'node-click\', node)">{{ node.path }}</button></div>',
};
beforeEach(() => {
  localStorage.clear(); state.mounts = 0; state.api.raw.mockReset(); state.api.get.mockReset();
  state.api.get.mockResolvedValue({ path: '_workspace', entries: [], nextCursor: null });
  state.store = reactive({ projectId: 'test', project: {}, sidebar: 'tree', treeVersion: 0, tree: [file('main.tex'), file('other.tex')], activeFile: '', readOnly: false,
    loadTree: vi.fn().mockResolvedValue(), loadReviews: vi.fn().mockResolvedValue(), loadPendingChangesets: vi.fn().mockResolvedValue(), openFile: vi.fn(), searchMatches: null });
});
afterEach(() => { app?.unmount(); el?.remove(); app = null; vi.useRealTimers(); });
async function mount(Component) {
  el = document.createElement('div'); document.body.appendChild(el); active = reactive({ value: true });
  app = createApp({ render: () => h(Component, { active: active.value }) });
  for (const name of ['el-tooltip', 'el-dialog', 'el-form', 'el-form-item', 'el-dropdown', 'el-dropdown-menu', 'el-dropdown-item']) app.component(name, content);
  app.component('el-button', { props: ['disabled', 'loading'], template: '<button :disabled="disabled || loading"><slot /></button>' });
  app.component('el-icon', { template: '<span><slot /></span>' });
  app.component('el-empty', { template: '<div />' });
  app.component('el-input', { props: ['modelValue', 'size'], emits: ['update:modelValue'], template: '<input :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />' });
  app.component('el-select', { template: '<select><slot /></select>' }); app.component('el-option', { template: '<option />' });
  app.component('el-checkbox', { props: ['size'], template: '<input type="checkbox" />' }); app.component('el-tree', treeStub);
  app.mount(el); await flush();
  if (Component === WorkspacePanel) { await new Promise(resolve => setTimeout(resolve, 170)); await flush(); }
}
describe('scroll state across panel visibility changes', () => {
  it.each([[FileTree, '.tree-scroll'], [WorkspacePanel, '.workspace-body'], [SearchPanel, '.search-body']])('preserves a hidden panel viewport instead of remembering the browser zero position', async (Component, selector) => {
    await mount(Component); const viewport = el.querySelector(selector); let width = 280, height = 240;
    Object.defineProperties(viewport, { clientWidth: { get: () => width }, clientHeight: { get: () => height }, scrollWidth: { value: 700 }, scrollHeight: { value: 1800 } });
    viewport.scrollTop = 640; viewport.scrollLeft = 32; viewport.dispatchEvent(new Event('scroll'));
    active.value = false; await flush(); width = 0; height = 0;
    viewport.scrollTop = 0; viewport.scrollLeft = 0; viewport.dispatchEvent(new Event('scroll'));
    width = 280; height = 240; active.value = true; await flush();
    expect(viewport.scrollTop).toBe(640); expect(viewport.scrollLeft).toBe(32);
  });
});
describe('cached project tree', () => {
  it('does not scan directories on mount, empty projects or project identity changes', async () => {
    state.store.tree = []; await mount(FileTree); expect(state.store.loadTree).not.toHaveBeenCalled();
    state.store.projectId = 'next'; await flush(); expect(state.store.loadTree).not.toHaveBeenCalled();
  });
  it('keeps the existing tree rendered throughout an asynchronous refresh', async () => {
    let done; state.store.loadTree.mockImplementation(() => new Promise(resolve => { done = resolve; }));
    await mount(FileTree); const tree = el.querySelector('[data-tree-instance]');
    el.querySelector('[title="刷新文件树"] button').click(); await flush();
    expect(state.store.loadTree).toHaveBeenCalledTimes(1); expect(el.querySelector('[data-tree-instance]')).toBe(tree); expect(state.mounts).toBe(1);
    done(); await flush(); expect(el.querySelector('[data-tree-instance]')).toBe(tree); expect(state.mounts).toBe(1);
  });
  it('ignores Delete from the rest of the page while its multi-selection is cached but hidden', async () => {
    await mount(FileTree);
    const buttons = el.querySelectorAll('[data-tree-instance] button'); buttons[0].click(); buttons[1].dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true })); await flush();
    expect(el.querySelector('.sel-count').textContent).toContain('2');
    active.value = false; await flush(); const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete' })); expect(confirm).not.toHaveBeenCalled();
    active.value = true; await flush(); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete' })); expect(confirm).toHaveBeenCalledTimes(1); confirm.mockRestore();
  });
});
describe('cached workspace', () => {
  it('does not handle global Delete while hidden', async () => {
    state.api.get.mockResolvedValue({ path: '_workspace', entries: [file('_workspace/a.md'), file('_workspace/b.md')], nextCursor: null });
    await mount(WorkspacePanel); const rows = el.querySelectorAll('.ws-row'); rows[0].click(); rows[1].dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true })); await flush();
    expect(el.querySelector('.sel-count').textContent).toContain('2'); active.value = false; await flush();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete' })); expect(confirm).not.toHaveBeenCalled(); confirm.mockRestore();
  });
});
describe('cached search', () => {
  it('pauses hidden searches and invalidates in-flight results, then retains its query on return', async () => {
    vi.useFakeTimers(); let resolve;
    state.api.raw.mockImplementationOnce(() => new Promise(done => { resolve = done; })).mockResolvedValue({ text: async () => 'needle' });
    await mount(SearchPanel); const query = el.querySelector('input'); query.value = 'needle'; query.dispatchEvent(new Event('input', { bubbles: true })); await flush();
    await vi.advanceTimersByTimeAsync(80); expect(state.api.raw).toHaveBeenCalledTimes(1);
    active.value = false; await flush(); resolve({ text: async () => 'needle' }); await flush(); expect(state.store.searchMatches).toBeNull();
    state.store.activeFile = 'other.tex'; state.store.treeVersion++; await flush(); await vi.advanceTimersByTimeAsync(200);
    expect(state.api.raw).toHaveBeenCalledTimes(1); expect(query.value).toBe('needle');
    active.value = true; await flush(); await vi.advanceTimersByTimeAsync(80); await flush();
    expect(state.api.raw).toHaveBeenCalledTimes(3); expect(el.querySelector('.panel-head').textContent).toContain('2 个结果');
  });
});


describe('cached reviews', () => {
  it('refreshes shared comments on return without discarding an unsent reply', async () => {
    state.store.reviews = [{ id: 1, status: 'open', filePath: 'main.tex', content: 'Please clarify this claim.' }];
    await mount(ReviewPanel); expect(state.store.loadReviews).toHaveBeenCalledTimes(1);
    const reply = el.querySelector('.r-reply-input'); reply.value = 'Reply in progress'; reply.dispatchEvent(new Event('input', { bubbles: true })); await flush();
    active.value = false; await flush(); state.store.treeVersion++; await flush(); expect(state.store.loadReviews).toHaveBeenCalledTimes(1);
    active.value = true; await flush(); expect(state.store.loadReviews).toHaveBeenCalledTimes(2); expect(el.querySelector('.r-reply-input')).toBe(reply); expect(reply.value).toBe('Reply in progress');
  });
});
