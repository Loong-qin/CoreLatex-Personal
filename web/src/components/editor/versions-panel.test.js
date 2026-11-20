// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, h, nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import VersionsPanel from './VersionsPanel.vue';
import { api } from '../../api.js';
import { useEditorStore } from '../../stores/editor.js';

const ui = vi.hoisted(() => ({ error: vi.fn(), toast: vi.fn(), openContextMenu: vi.fn() }));
vi.mock('../../api.js', () => ({
  api: { get: vi.fn(), post: vi.fn() }, timeAgo: () => '刚刚',
}));
vi.mock('../../stores/ui.js', () => ({ useUiStore: () => ui }));
vi.mock('../../lib/collabClient.js', () => ({
  detachProjectCollab: vi.fn(), subscribeProjectPresence: () => () => {}, detachAllCollab: vi.fn(), setPresenceListener: vi.fn(),
}));
const file = (path, change = 'modified', adds = 4, dels = 13, binary = false) => ({ path, change, adds, dels, binary });
const version = (id, files = [file('sec/Experiments.tex')]) => ({
  id, seq: id + 100, message: '自动快照', adds: 4, dels: 13, files,
  userName: '作者', createdAt: '2026-10-22T10:00:00Z',
});
const versions = [version(2, [
  file('sec/Experiments.tex'), file('new.tex', 'added', 2, 0), file('old.tex', 'removed', 0, 3), file('Fig/plot.pdf', 'modified', 0, 0, true),
]), version(1, [])];
const patch = (text) => '--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old line\n+' + text + '\n';
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
const mounted = [];
const flush = async () => { await new Promise((resolve) => setTimeout(resolve, 0)); await nextTick(); };
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  api.get.mockImplementation(async (path) => path.endsWith('/versions')
    ? { versions }
    : { diffs: [
      { path: 'sec/Experiments.tex', patch: patch('<script>new line</script>') },
      { path: 'new.tex', patch: patch('new file') },
      { path: 'Fig/plot.pdf', binary: true },
    ] });
  api.post.mockResolvedValue({});
});
afterEach(() => {
  for (const { app, el } of mounted.splice(0)) { app.unmount(); el.remove(); }
});
async function mount() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const store = useEditorStore();
  store.projectId = 'a';
  const app = createApp(VersionsPanel);
  app.use(pinia);
  app.component('el-button', {
    props: ['disabled', 'loading'],
    setup(props, { attrs, slots }) { return () => h('button', { ...attrs, disabled: props.disabled || props.loading }, slots.default?.()); },
  });
  app.component('el-icon', { setup: (_, { slots }) => () => h('span', slots.default?.()) });
  for (const name of ['el-form', 'el-form-item']) app.component(name, { setup: (_, { slots }) => () => h('div', slots.default?.()) });
  app.component('el-input', { render: () => h('input') });
  app.component('el-dialog', {
    props: ['modelValue', 'title'],
    setup(props, { slots }) { return () => props.modelValue ? h('section', { class: 'test-dialog', 'data-title': props.title }, [
      h('h3', props.title), slots.default?.(), slots.footer?.(),
    ]) : null; },
  });
  const el = document.createElement('div');
  document.body.appendChild(el);
  app.mount(el);
  mounted.push({ app, el });
  await flush();
  return { el, store, app };
}
const button = (el, text) => [...el.querySelectorAll('button')].find((node) => node.textContent === text);
const summary = (el, index = 0) => el.querySelectorAll('.version-summary')[index];
const view = (el, path) => [...el.querySelectorAll('.file-view')].find((node) => node.getAttribute('aria-label') === '查看 ' + path + ' 的更改');

describe('version snapshot file details', () => {
  it('expands and collapses the card with an accessible native button and file summaries', async () => {
    const { el } = await mount();
    const control = summary(el);
    expect(control.tagName).toBe('BUTTON');
    expect(control.getAttribute('aria-expanded')).toBe('false');
    control.focus();
    expect(document.activeElement).toBe(control);
    // Keyboard activation of a native button dispatches the same detail=0 click.
    control.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
    await nextTick();
    expect(control.getAttribute('aria-expanded')).toBe('true');
    expect(el.querySelector('#' + control.getAttribute('aria-controls'))).not.toBeNull();
    const rows = el.querySelectorAll('.version-file');
    expect(rows).toHaveLength(4);
    expect(rows[0].textContent).toContain('sec/Experiments.tex');
    expect(rows[0].textContent).toContain('修改');
    expect(rows[0].querySelector('.adds').textContent).toBe('+4');
    expect(rows[0].querySelector('.dels').textContent).toBe('−13');
    expect(rows[1].textContent).toContain('新增');
    expect(rows[2].textContent).toContain('删除');
    expect(rows[3].textContent).toContain('二进制');
    control.click();
    await nextTick();
    expect(el.querySelector('.version-files')).toBeNull();
  });

  it('shows only the selected file diff without collapsing the card, and reuses immutable details', async () => {
    const { el } = await mount();
    summary(el).click();
    await nextTick();
    view(el, 'sec/Experiments.tex').click();
    await flush();
    expect(summary(el).getAttribute('aria-expanded')).toBe('true');
    expect(el.querySelector('.test-dialog').getAttribute('data-title')).toBe('v102 · sec/Experiments.tex');
    expect(el.querySelector('.diff-add').textContent).toBe('+<script>new line</script>');
    expect(el.querySelector('.diff-body script')).toBeNull();
    expect(el.querySelector('.diff-body input, .diff-body textarea, .diff-body [contenteditable]')).toBeNull();
    expect(el.querySelectorAll('.diff-file')).toHaveLength(1);
    button(el.querySelector('.test-dialog'), '关闭').click();
    await nextTick();
    view(el, 'new.tex').click();
    await flush();
    expect(el.querySelector('.diff-body').textContent).toContain('new file');
    expect(api.get.mock.calls.filter(([path]) => path === '/api/projects/a/versions/2')).toHaveLength(1);
  });

  it('explains binary differences and preserves empty snapshot states', async () => {
    const { el } = await mount();
    summary(el).click();
    await nextTick();
    view(el, 'Fig/plot.pdf').click();
    await flush();
    expect(el.querySelector('.binary-note').textContent).toContain('无法显示逐行文字差异');
    expect(el.querySelector('.diff-body')).toBeNull();
    button(el.querySelector('.test-dialog'), '关闭').click();
    summary(el, 1).click();
    await nextTick();
    expect(el.querySelector('.files-empty').textContent).toContain('没有文件变更');
  });

  it('retains menu actions, prevents expansion bubbling, and preserves restore behavior', async () => {
    const { el, store } = await mount();
    store.openFiles = ['keep.tex', 'removed.tex'];
    store.loadTree = vi.fn(async () => { store.tree = [{ path: 'keep.tex' }]; });
    el.querySelector('.v-menu').click();
    await nextTick();
    expect(summary(el).getAttribute('aria-expanded')).toBe('false');
    const items = ui.openContextMenu.mock.calls[0][2];
    expect(items.map((item) => item.label)).toEqual(['查看更改', '恢复此版本']);
    items[1].action();
    await nextTick();
    const dialog = el.querySelector('.test-dialog');
    expect(dialog.textContent).toContain('自动保存当前内容为安全快照');
    button(dialog, '恢复').click();
    await flush();
    expect(api.post).toHaveBeenCalledWith('/api/projects/a/versions/2/restore');
    expect(store.openFiles).toEqual(['keep.tex']);
    expect(ui.toast).toHaveBeenCalledWith('已恢复到 v102，编辑器内容已同步');
  });

  it('renders loading, retry and empty states for the list', async () => {
    const loading = deferred();
    api.get.mockReturnValueOnce(loading.promise);
    const { el } = await mount();
    expect(el.textContent).toContain('正在加载版本记录');
    loading.reject(new Error('版本列表不可用'));
    await flush();
    expect(el.querySelector('[role=alert]').textContent).toContain('版本列表不可用');
    api.get.mockResolvedValueOnce({ versions: [] });
    button(el, '重试').click();
    await flush();
    expect(el.textContent).toContain('暂无版本记录');
  });

  it('renders detail loading and error, and retries the same file', async () => {
    const { el } = await mount();
    const loading = deferred();
    api.get.mockReturnValueOnce(loading.promise);
    summary(el).click();
    await nextTick();
    view(el, 'sec/Experiments.tex').click();
    await nextTick();
    expect(el.querySelector('.test-dialog').textContent).toContain('正在加载文件差异');
    loading.reject(new Error('快照文件已丢失'));
    await flush();
    expect(el.querySelector('.test-dialog [role=alert]').textContent).toContain('快照文件已丢失');
    button(el.querySelector('.test-dialog'), '重试').click();
    await flush();
    expect(el.querySelector('.diff-body').textContent).toContain('new line');
  });

  it('deduplicates same-version detail requests and ignores a previous file selection', async () => {
    const { el } = await mount();
    const loading = deferred();
    api.get.mockReturnValueOnce(loading.promise);
    summary(el).click();
    await nextTick();
    view(el, 'sec/Experiments.tex').click();
    view(el, 'new.tex').click();
    loading.resolve({ diffs: [
      { path: 'sec/Experiments.tex', patch: patch('old selected') },
      { path: 'new.tex', patch: patch('latest selected') },
    ] });
    await flush();
    expect(el.querySelector('.test-dialog').getAttribute('data-title')).toBe('v102 · new.tex');
    expect(el.querySelector('.diff-body').textContent).toContain('latest selected');
    expect(el.querySelector('.diff-body').textContent).not.toContain('old selected');
    expect(api.get.mock.calls.filter(([path]) => path === '/api/projects/a/versions/2')).toHaveLength(1);
  });

  it('ignores list and detail responses after switching projects', async () => {
    const { el, store } = await mount();
    const detail = deferred();
    api.get.mockReturnValueOnce(detail.promise);
    summary(el).click();
    await nextTick();
    view(el, 'sec/Experiments.tex').click();
    const list = deferred();
    api.get.mockReturnValueOnce(list.promise);
    el.querySelector('[aria-label="刷新版本列表"]').click();
    api.get.mockResolvedValueOnce({ versions: [version(8, [file('next.tex')])] });
    store.reset();
    store.projectId = 'b';
    await flush();
    detail.resolve({ diffs: [{ path: 'sec/Experiments.tex', patch: patch('stale detail') }] });
    list.resolve({ versions: [version(99)] });
    await flush();
    expect(el.querySelector('.test-dialog')).toBeNull();
    expect(el.textContent).toContain('v108');
    expect(el.textContent).not.toContain('v199');
    expect(el.textContent).not.toContain('stale detail');
  });

  it('distinguishes an unavailable selected file from a genuinely empty snapshot diff', async () => {
    const { el } = await mount();
    api.get.mockResolvedValueOnce({ diffs: [] });
    summary(el).click();
    await nextTick();
    view(el, 'sec/Experiments.tex').click();
    await flush();
    expect(el.querySelector('.test-dialog').textContent).toContain('该文件差异不可用');
    expect(el.querySelector('.test-dialog').textContent).not.toContain('该快照没有');
    button(el.querySelector('.test-dialog'), '关闭').click();
    api.get.mockResolvedValueOnce({ diffs: [] });
    el.querySelectorAll('.v-menu')[1].click();
    ui.openContextMenu.mock.calls.at(-1)[2][0].action();
    await flush();
    expect(el.querySelector('.test-dialog').textContent).toContain('该快照没有可显示的文件差异');
  });

  it('does not let a delayed refresh replace a newer refresh in the same project', async () => {
    const { el, store } = await mount();
    const old = deferred(), latest = deferred();
    api.get.mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
    el.querySelector('[aria-label="刷新版本列表"]').click();
    store.versionsStamp++;
    await nextTick();
    latest.resolve({ versions: [version(5)] });
    await flush();
    old.resolve({ versions: [version(4)] });
    await flush();
    expect(el.textContent).toContain('v105');
    expect(el.textContent).not.toContain('v104');
  });

  it('renders the first snapshot against an empty tree, including a header-only empty added file', async () => {
    const first = { ...version(1, [
      file('main.tex', 'added', 2, 0),
      file('empty.tex', 'added', 0, 0),
    ]), seq: 1, adds: 2, dels: 0 };
    api.get.mockImplementation(async (path) => path.endsWith('/versions')
      ? { versions: [first] }
      : { version: first, diffs: [
        { path: 'main.tex', patch: 'Index: a/main.tex\n===================================================================\n--- a/main.tex\n+++ b/main.tex\n@@ -0,0 +1,2 @@\n+first line\n+second line\n' },
        { path: 'empty.tex', patch: 'Index: a/empty.tex\n===================================================================\n--- a/empty.tex\n+++ b/empty.tex\n' },
      ] });
    const { el } = await mount();
    expect(el.textContent).toContain('v1');
    summary(el).click();
    await nextTick();
    const rows = el.querySelectorAll('.version-file');
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector('.change-kind').textContent).toBe('新增');
    expect(rows[0].querySelector('.adds').textContent).toBe('+2');
    expect(rows[1].querySelector('.file-path').textContent).toBe('empty.tex');
    expect(rows[1].querySelector('.adds').textContent).toBe('+0');
    expect(rows[1].querySelector('.dels').textContent).toBe('−0');

    view(el, 'main.tex').click();
    await flush();
    expect(el.querySelector('.test-dialog').getAttribute('data-title')).toBe('v1 · main.tex');
    expect([...el.querySelectorAll('.diff-add')].map((line) => line.textContent)).toEqual(['+first line', '+second line']);
    expect(el.querySelector('.diff-del')).toBeNull();
    button(el.querySelector('.test-dialog'), '关闭').click();
    await nextTick();
    view(el, 'empty.tex').click();
    await flush();
    expect(el.querySelector('.test-dialog').getAttribute('data-title')).toBe('v1 · empty.tex');
    expect(el.querySelector('.diff-body').textContent).toContain('+++ b/empty.tex');
    expect(el.querySelector('.diff-add, .diff-del')).toBeNull();
    expect(el.querySelector('.test-dialog').textContent).not.toContain('差异不可用');
    expect(api.get.mock.calls.filter(([path]) => path === '/api/projects/a/versions/1')).toHaveLength(1);
  });

  it('does not let an older version response replace a newly opened version', async () => {
    const { el } = await mount();
    const old = deferred();
    api.get.mockReturnValueOnce(old.promise);
    el.querySelector('.v-menu').click();
    ui.openContextMenu.mock.calls.at(-1)[2][0].action();
    await nextTick();
    button(el.querySelector('.test-dialog'), '关闭').click();
    el.querySelectorAll('.v-menu')[1].click();
    ui.openContextMenu.mock.calls.at(-1)[2][0].action();
    await flush();
    expect(el.querySelector('.test-dialog').getAttribute('data-title')).toBe('v101 · 全部更改');
    old.resolve({ diffs: [{ path: 'stale.tex', patch: patch('stale') }] });
    await flush();
    expect(el.querySelector('.test-dialog').getAttribute('data-title')).toBe('v101 · 全部更改');
    expect(el.querySelector('.test-dialog').textContent).not.toContain('stale.tex');
  });
});
