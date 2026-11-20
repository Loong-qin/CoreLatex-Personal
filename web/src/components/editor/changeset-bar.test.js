// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, h, nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import ChangesetBar from './ChangesetBar.vue';
import { useEditorStore } from '../../stores/editor.js';
import { api } from '../../api.js';

const ui = vi.hoisted(() => ({ toast: vi.fn(), error: vi.fn(), confirm: vi.fn().mockResolvedValue(true) }));
vi.mock('../../api.js', async (original) => ({ ...(await original()), api: { get: vi.fn(), raw: vi.fn() } }));
vi.mock('../../stores/ui.js', () => ({ useUiStore: () => ui }));
vi.mock('../../lib/collabClient.js', () => ({
  detachProjectCollab: vi.fn(), subscribeProjectPresence: () => () => {}, detachAllCollab: vi.fn(), setPresenceListener: vi.fn(),
}));
const mounted = [];
const flush = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
};
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  api.get.mockImplementation(async (path) => path.includes('/diff?')
    ? { before: 'original\n', after: '<script>proposal</script>\n' }
    : { base: 'original\n', pending: true });
  api.raw.mockResolvedValue({ text: async () => 'changed\n' });
});
afterEach(() => {
  for (const { app, el } of mounted.splice(0)) { app.unmount(); el.remove(); }
});
const file = (filePath, applied) => ({ filePath, applied, status: 'pending', adds: 1, dels: 1 });
const cs = (id, applied, files) => ({ id, applied, files, status: 'pending' });
async function mount(changesets) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const store = useEditorStore();
  store.projectId = 'p';
  store.pendingChangesets = changesets;
  store.openDiffReview = vi.fn().mockResolvedValue(true);
  store.loadPendingChangesets = vi.fn().mockResolvedValue();
  store.acceptChangeset = vi.fn().mockResolvedValue();
  store.revertChangeset = vi.fn().mockResolvedValue();
  store.resolvePendingChangesets = vi.fn().mockResolvedValue(true);
  const app = createApp(ChangesetBar);
  app.use(pinia);
  app.component('el-button', {
    props: ['disabled'],
    setup(props, { attrs, slots }) {
      return () => h('button', { ...attrs, disabled: props.disabled }, slots.default?.());
    },
  });
  app.component('el-tag', { setup: (_, { slots }) => () => h('span', slots.default?.()) });
  app.component('el-dialog', {
    props: ['modelValue', 'title'],
    setup(props, { slots }) {
      return () => props.modelValue ? h('section', { class: 'test-dialog' }, [
        h('h3', props.title), slots.default?.(), slots.footer?.(),
      ]) : null;
    },
  });
  const el = document.createElement('div');
  document.body.appendChild(el);
  app.mount(el);
  mounted.push({ app, el });
  await flush();
  return { el, store };
}
const button = (el, text) => [...el.querySelectorAll('button')].find((b) => b.textContent === text);

describe('mixed applied state and proposal review', () => {
  it('counts pending files rather than batches, including binaries and same-file proposals', async () => {
    const binary = name => ({ ...file(`Fig/${name}.pdf`, true), binary: true, beforeBytes: 13000, afterBytes: 12000 });
    const { el, store } = await mount([
      cs(1, true, [file('main.tex', true), binary('steps-a'), binary('steps-b')]),
      cs(2, false, [file('main.tex', false), binary('steps-c')]),
      cs(3, true, [binary('budget-a')]),
      cs(4, true, [binary('budget-b')]),
      cs(5, true, [binary('budget-c'), file('main.tex', true)]),
    ]);
    expect(el.querySelector('.cs-summary').textContent).toContain('7 个文件');
    expect(el.querySelectorAll('.cs-file')).toHaveLength(7);
    store.pendingChangesets[0].files[0].status = 'accepted';
    store.pendingChangesets[0].files[1].status = 'reverted';
    await flush();
    expect(el.querySelector('.cs-summary').textContent).toContain('6 个文件');
    expect(el.querySelectorAll('.cs-file')).toHaveLength(6);
    expect(el.querySelector('.file-path').textContent).toBe('Fig/steps-b.pdf');
    expect([...el.querySelectorAll('.file-path')].filter(node => node.textContent === 'main.tex')).toHaveLength(1);
    for (const change of store.pendingChangesets) {
      for (const changed of change.files) changed.status = 'accepted';
    }
    await flush();
    expect(el.querySelector('.changeset-bar')).toBeNull();
  });

  it('reviews an applied file even when another file keeps its parent unapplied', async () => {
    const { el, store } = await mount([cs(1, false, [file('a.tex', true), file('b.tex', false)])]);
    const rows = el.querySelectorAll('.cs-file');
    expect(rows[0].textContent).toContain('已应用');
    expect(rows[1].textContent).toContain('待应用');
    button(rows[0], '审查').click();
    await flush();
    expect(store.openDiffReview).toHaveBeenCalledWith([1], 'a.tex', true);
    button(rows[1], '审查提案').click();
    await flush();
    expect(api.get).toHaveBeenCalledWith('/api/projects/p/changesets/1/diff?file=b.tex', { cache: 'no-store' });
    expect(el.querySelector('.proposal-diff').textContent).toContain('original');
    expect(el.querySelector('.proposal-diff').textContent).toContain('<script>proposal</script>');
    expect(el.querySelector('.proposal-diff script')).toBeNull();
    expect(el.querySelector('.proposal-diff input, .proposal-diff textarea, [contenteditable=true]')).toBeNull();
  });

  it('separates same-file proposals from live review and supports legacy parent flags', async () => {
    const { el, store } = await mount([
      cs(1, false, [file('a.tex', true)]),
      cs(2, true, [file('a.tex', false)]),
      cs(3, true, [file('a.tex', undefined)]),
    ]);
    button(el, '审查已应用').click();
    await flush();
    expect(store.openDiffReview).toHaveBeenCalledWith([1, 3], 'a.tex', true);
    button(el, '审查提案').click();
    await flush();
    const requests = api.get.mock.calls.map(([path]) => path).filter((path) => path.includes('/diff?'));
    expect(requests).toEqual(['/api/projects/p/changesets/2/diff?file=a.tex']);
  });

  it('closes an outdated proposal and requires a fresh review after a 409', async () => {
    const { el, store } = await mount([cs(1, false, [file('new.tex', false)])]);
    store.acceptChangeset.mockRejectedValue(Object.assign(new Error('请先处理冲突'), { status: 409 }));
    button(el, '审查提案').click();
    await flush();
    button(el, '应用此提案').click();
    await flush();
    expect(store.acceptChangeset).toHaveBeenCalledWith(1, 'new.tex', 0);
    expect(ui.error).toHaveBeenCalledWith(expect.stringContaining('重新打开'));
    expect(el.querySelector('.test-dialog')).toBeNull();
    expect(el.querySelector('.proposal-diff')).toBeNull();
  });

  it('discards only the viewed proposal file and closes after success', async () => {
    const { el, store } = await mount([cs(1, false, [file('new.tex', false), file('other.tex', false)])]);
    button(el.querySelector('.cs-file'), '审查提案').click();
    await flush();
    button(el, '放弃此提案').click();
    await flush();
    expect(store.revertChangeset).toHaveBeenCalledWith(1, 'new.tex', 0);
    expect(el.querySelector('.test-dialog')).toBeNull();
  });

  it('ignores proposal responses after switching projects', async () => {
    let resolve;
    const late = new Promise((r) => { resolve = r; });
    const { el, store } = await mount([cs(1, false, [file('new.tex', false)])]);
    api.get.mockReturnValue(late);
    button(el, '审查提案').click();
    store.reset();
    store.projectId = 'next';
    await nextTick();
    resolve({ before: '', after: 'stale' });
    await flush();
    expect(el.querySelector('.test-dialog')).toBeNull();
    expect(el.textContent).not.toContain('stale');
  });
});


describe('binary file review', () => {
  it('shows byte counts without reading binary data as text or opening CodeMirror review', async () => {
    const { el, store } = await mount([cs(1, true, [{ ...file('figure.png', true), binary: true, beforeBytes: 1024, afterBytes: 2048 }])]);
    store.loadTree = vi.fn(async () => {});
    expect(el.textContent).toContain('二进制文件'); expect(el.textContent).toContain('1.0 KB → 2.0 KB');
    expect(api.raw).not.toHaveBeenCalled(); expect(api.get).not.toHaveBeenCalled();
    expect(button(el, '审查')).toBeUndefined();
    button(el, '保留文件').click(); await flush();
    expect(store.resolvePendingChangesets).toHaveBeenCalledWith('accept', { filePath: 'figure.png', appliedOnly: true }); expect(store.openDiffReview).not.toHaveBeenCalled();
  });
  it('reviews binary proposals as whole files without textual diff rows', async () => {
    api.get.mockResolvedValue({ binary: true, before: null, after: null, beforeBytes: 0, afterBytes: 4096, patch: '' });
    const { el, store } = await mount([cs(2, false, [{ ...file('figure.pdf', false), binary: true, beforeBytes: 0, afterBytes: 4096 }])]);
    button(el, '审查提案').click(); await flush();
    expect(el.querySelector('.test-dialog').textContent).toContain('4.0 KB');
    expect(el.querySelector('.proposal-diff')).toBeNull();
    button(el, '应用此提案').click(); await flush();
    expect(store.acceptChangeset).toHaveBeenCalledWith(2, 'figure.pdf', 0);
  });
});

describe('whole review actions', () => {
  it('shows 0/5 and disables current-hunk actions until the user navigates', async () => {
    const { el, store } = await mount([cs(1, true, [file('a.tex', true)])]);
    store.diffReview = { filePath: 'a.tex', applied: true, hunkIdx: -1,
      hunks: Array.from({ length: 5 }, (_, from) => ({ from, adds: 1, dels: 1 })) };
    await flush();
    expect(el.querySelector('.rev-pos').textContent).toBe('0/5');
    expect(button(el, '保留此修改').disabled).toBe(true);
    expect(button(el, '撤销此修改').disabled).toBe(true);
    for (const flag of ['stale', 'refreshing', 'busy', 'reviewBusy']) {
      const target = flag === 'reviewBusy' ? store : store.diffReview;
      target[flag] = true; await flush();
      expect(el.querySelector('[title="上一处修改"]').disabled).toBe(true);
      expect(el.querySelector('[title="下一处修改"]').disabled).toBe(true);
      target[flag] = false; await flush();
    }
    el.querySelector('[title="下一处修改"]').click(); await flush();
    expect(el.querySelector('.rev-pos').textContent).toBe('1/5');
    expect(button(el, '保留此修改').disabled).toBe(false);
    expect(button(el, '撤销此修改').disabled).toBe(false);
    store.diffReview.hunks.pop(); store.diffReview.hunkIdx = -1; await flush();
    expect(el.querySelector('.rev-pos').textContent).toBe('0/4');
    el.querySelector('[title="下一处修改"]').click(); await flush();
    expect(el.querySelector('.rev-pos').textContent).toBe('1/4');
  });

  it('uses a single grouped store operation and suppresses rapid duplicate clicks', async () => {
    const { el, store } = await mount([cs(1, true, [file('a.tex', true)]), cs(2, true, [file('a.tex', true)])]);
    let finish; store.resolvePendingChangesets.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const keep = button(el, '全部保留'); keep.click(); keep.click(); await nextTick();
    expect(store.resolvePendingChangesets).toHaveBeenCalledTimes(1); expect(store.resolvePendingChangesets).toHaveBeenCalledWith('accept');
    expect(button(el, '全部撤销').disabled).toBe(true); expect(store.acceptChangeset).not.toHaveBeenCalled();
    finish(true); await flush(); expect(ui.toast).toHaveBeenCalledTimes(1); expect(ui.toast).toHaveBeenCalledWith('已保留全部待审修改');
  });
  it('refreshes a conflict quietly and reports it once without a success toast', async () => {
    const { el, store } = await mount([cs(1, true, [file('a.tex', true)])]);
    store.diffReview = { filePath: 'a.tex', hunks: [] };
    store.refreshDiffReview = vi.fn().mockResolvedValue(false);
    store.resolvePendingChangesets.mockRejectedValue(Object.assign(new Error('文档已变化'), { status: 409 }));
    button(el, '全部撤销').click(); button(el, '全部撤销').click(); await flush();
    expect(store.resolvePendingChangesets).toHaveBeenCalledTimes(1);
    expect(store.loadPendingChangesets).toHaveBeenCalledTimes(1); expect(store.refreshDiffReview).toHaveBeenCalledWith({ quiet: true });
    expect(ui.error).toHaveBeenCalledTimes(1); expect(ui.error).toHaveBeenCalledWith('文档已变化'); expect(ui.toast).not.toHaveBeenCalled();
  });
  it('explains partial processing if a remaining proposal or binary conflicts', async () => {
    const { el, store } = await mount([cs(1, true, [file('a.tex', true)])]);
    store.resolvePendingChangesets.mockRejectedValue(Object.assign(new Error('提案冲突'), { reviewPartial: true }));
    button(el, '全部保留').click(); await flush();
    expect(ui.error).toHaveBeenCalledTimes(1); expect(ui.error.mock.calls[0][0]).toContain('部分修改已处理'); expect(ui.toast).not.toHaveBeenCalled();
  });
});


describe('proposal review binds the version that was displayed', () => {
  it.each([true, false])('does not take a newer list version when resolving an old text diff (accept=%s)', async accept => {
    const original = { ...cs(8, false, [file('main.tex', false)]), proposalRevision: 2 };
    api.get.mockResolvedValue({ before: 'original\n', after: 'viewed version two\n', proposalRevision: 2 });
    const { el, store } = await mount([original]);
    button(el, '审查提案').click(); await flush();
    expect(el.querySelector('.proposal-diff').textContent).toContain('viewed version two');
    store.pendingChangesets = [{ ...original, proposalRevision: 3 }]; await flush();
    expect(el.querySelector('.proposal-diff').textContent).toContain('viewed version two');
    const operation = accept ? store.acceptChangeset : store.revertChangeset;
    operation.mockRejectedValue(Object.assign(new Error('提案版本已更新'), { status: 409 }));
    button(el, accept ? '应用此提案' : '放弃此提案').click(); await flush();
    expect(operation).toHaveBeenCalledWith(8, 'main.tex', 2);
    expect(el.querySelector('.test-dialog')).toBeNull();
    expect(ui.error).toHaveBeenCalledTimes(1); expect(ui.error.mock.calls[0][0]).toContain('重新打开'); expect(ui.toast).not.toHaveBeenCalled();
    api.get.mockResolvedValue({ before: 'original\n', after: 'new version three\n', proposalRevision: 3 });
    button(el, '审查提案').click(); await flush();
    expect(el.querySelector('.proposal-diff').textContent).toContain('new version three');
  });

  it('binds a binary proposal to the diff response version, including revision zero', async () => {
    api.get.mockResolvedValue({ binary: true, beforeBytes: 10, afterBytes: 20, proposalRevision: 0 });
    const original = { ...cs(4, false, [{ ...file('figure.pdf', false), binary: true }]), proposalRevision: 0 };
    const { el, store } = await mount([original]);
    button(el, '审查提案').click(); await flush();
    store.pendingChangesets = [{ ...original, proposalRevision: 1 }]; await flush();
    button(el, '应用此提案').click(); await flush();
    expect(store.acceptChangeset).toHaveBeenCalledWith(4, 'figure.pdf', 0);
  });
});

describe('collapsible file list keeps the editor area usable', () => {
  it('shows a bounded scrollable list by default and toggles collapse without dropping rows or the summary', async () => {
    const { el } = await mount([cs(1, true, [file('a.tex', true), file('b.tex', true), file('c.tex', true)])]);
    const list = el.querySelector('.cs-list');
    const toggle = el.querySelector('.cs-toggle');
    expect(list).toBeTruthy();
    expect(el.querySelectorAll('.cs-file').length).toBe(3);
    expect(el.querySelector('.cs-summary').textContent).toContain('3 个文件');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(list.style.display).not.toBe('none');
    toggle.click(); await flush();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(list.style.display).toBe('none');
    expect(el.querySelectorAll('.cs-file').length).toBe(3);
    expect(el.querySelector('.cs-summary').textContent).toContain('3 个文件');
    toggle.click(); await flush();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(list.style.display).not.toBe('none');
  });

  it('auto-expands the list when an inline review opens so hunk controls stay visible', async () => {
    const { el, store } = await mount([cs(1, true, [file('a.tex', true)])]);
    el.querySelector('.cs-toggle').click(); await flush();
    expect(el.querySelector('.cs-list').style.display).toBe('none');
    store.diffReview = { filePath: 'a.tex', applied: true, hunkIdx: 0, hunks: [{ from: 0, adds: 1, dels: 1 }] };
    await flush();
    expect(el.querySelector('.cs-list').style.display).not.toBe('none');
  });
});
