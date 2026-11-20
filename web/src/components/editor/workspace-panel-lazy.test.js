// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, h, nextTick, reactive } from 'vue';
import WorkspacePanel from './WorkspacePanel.vue';

const state = vi.hoisted(() => ({ store: null, api: { get: vi.fn(), post: vi.fn(), postForm: vi.fn(), del: vi.fn() }, prompt: vi.fn(), confirm: vi.fn() }));
vi.mock('../../stores/editor.js', () => ({ useEditorStore: () => state.store }));
vi.mock('../../stores/ui.js', () => ({ useUiStore: () => ({ error: vi.fn(), toast: vi.fn() }) }));
vi.mock('../../api.js', () => ({ api: state.api }));
vi.mock('../../lib/projectFileUrl.js', () => ({ downloadProjectFile: vi.fn(), downloadProjectExport: vi.fn() }));
vi.mock('element-plus', () => ({ ElMessageBox: { prompt: state.prompt, confirm: state.confirm } }));

const file = path => ({ name: path.split('/').pop(), path, type: 'file', size: 3, text: true });
const dir = path => ({ name: path.split('/').pop(), path, type: 'dir' });
const page = (path, entries = [], nextCursor = null) => ({ path, entries, nextCursor });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 8; i++) { await Promise.resolve(); await nextTick(); } await vi.advanceTimersByTimeAsync(1); };
let app, el, active;
beforeEach(() => {
  vi.useFakeTimers(); localStorage.clear(); vi.clearAllMocks();
  state.api.get.mockReset(); state.api.post.mockReset(); state.api.postForm.mockReset(); state.api.del.mockReset(); state.prompt.mockReset(); state.confirm.mockReset();
  state.store = reactive({ projectId: 'a', projectVersion: 1, project: { name: 'A' }, treeVersion: 0, treeLoaded: false, workspaceVersion: 0,
    readOnly: false, activeFile: '', openFile: vi.fn(), closeFile: vi.fn(), renamePath: vi.fn() });
  state.api.get.mockResolvedValue(page('_workspace'));
  state.api.post.mockResolvedValue({ ok: true });
});
afterEach(() => { app?.unmount(); el?.remove(); app = null; el = null; vi.useRealTimers(); });
async function mount(initial = true) {
  active = reactive({ value: initial }); el = document.createElement('div'); document.body.appendChild(el);
  app = createApp({ render: () => h(WorkspacePanel, { active: active.value }) });
  for (const name of ['el-tooltip', 'el-dropdown-menu']) app.component(name, { props: ['content'], template: '<span :title="content"><slot /></span>' });
  app.component('el-dropdown', { emits: ['command'], template: '<span @click.stop="$emit(\'command\', $event.target.dataset.command)"><slot /><slot name="dropdown" /></span>' });
  app.component('el-dropdown-item', { props: ['command', 'disabled'], template: '<button :data-command="command" :disabled="disabled"><slot /></button>' });
  app.component('el-button', { props: ['disabled'], template: '<button :disabled="disabled"><slot /></button>' });
  app.component('el-icon', { template: '<span><slot /></span>' });
  app.mount(el); await flush();
}
async function tick() { await vi.advanceTimersByTimeAsync(150); await flush(); }
const names = () => [...el.querySelectorAll('.workspace-name')].map(node => node.textContent);
function clickRow(name) {
  const target = [...el.querySelectorAll('.workspace-name')].find(node => node.textContent === name);
  if (!target) throw new Error('Missing row ' + name);
  target.closest('.ws-row').click();
}
function statusButton(text) {
  const target = [...el.querySelectorAll('.directory-status button')].find(node => node.textContent === text);
  if (!target) throw new Error('Missing status button ' + text);
  return target;
}

describe('workspace directory lazy loading', () => {
  it('delays the first listing, loads only the root and requests a child directory only after expansion', async () => {
    state.api.get.mockImplementation(async url => url.includes('path=_workspace%2Ffigures')
      ? page('_workspace/figures', [file('_workspace/figures/chart.txt')])
      : page('_workspace', [dir('_workspace/figures'), file('_workspace/note.md')]));
    await mount(); expect(state.api.get).not.toHaveBeenCalled(); await tick();
    expect(state.api.get).toHaveBeenCalledTimes(1); expect(names()).toEqual(['figures/', 'note.md']);
    clickRow('note.md'); expect(state.store.openFile).toHaveBeenCalledWith('_workspace/note.md');
    expect(state.api.get).toHaveBeenCalledTimes(1); // No file content fetch by the listing.
    clickRow('figures/'); await flush();
    expect(state.api.get).toHaveBeenCalledTimes(2); expect(names()).toEqual(['figures/', 'chart.txt', 'note.md']);
    expect(state.api.get.mock.calls[1][0]).toContain('path=_workspace%2Ffigures');
    clickRow('figures/'); await flush(); expect(names()).toEqual(['figures/', 'note.md']);
    clickRow('figures/'); await flush(); expect(state.api.get).toHaveBeenCalledTimes(2); // Reuse the already loaded page.
  });

  it('does not list an inactive workspace until it becomes visible', async () => {
    await mount(false); await tick(); expect(state.api.get).not.toHaveBeenCalled();
    active.value = true; await flush(); await tick(); expect(state.api.get).toHaveBeenCalledTimes(1);
  });

  it('loads additional pages on demand, deduplicates entries, and retries a failed page', async () => {
    state.api.get.mockResolvedValueOnce(page('_workspace', [file('_workspace/a.md')], 'next'))
      .mockRejectedValueOnce(new Error('网络中断'))
      .mockResolvedValueOnce(page('_workspace', [file('_workspace/a.md'), file('_workspace/b.md')]));
    await mount(); await tick(); expect(names()).toEqual(['a.md']);
    statusButton('加载更多').click(); await flush(); expect(el.textContent).toContain('网络中断');
    statusButton('重试').click(); await flush();
    expect(names()).toEqual(['a.md', 'b.md']);
    expect(state.api.get.mock.calls[2][0]).toContain('cursor=next');
    expect(el.querySelector('.directory-status')).toBeNull();
  });

  it('retries a failed child directory without reloading the root', async () => {
    state.api.get.mockResolvedValueOnce(page('_workspace', [dir('_workspace/sub')]))
      .mockRejectedValueOnce(new Error('暂时离线'))
      .mockResolvedValueOnce(page('_workspace/sub', [file('_workspace/sub/file.md')]));
    await mount(); await tick(); clickRow('sub/'); await flush();
    expect(el.textContent).toContain('暂时离线'); statusButton('重试').click(); await flush();
    expect(names()).toEqual(['sub/', 'file.md']); expect(state.api.get).toHaveBeenCalledTimes(3);
  });

  it('cancels a hidden pagination request and resumes the same cursor when shown again', async () => {
    const pending = deferred();
    state.api.get.mockResolvedValueOnce(page('_workspace', [file('_workspace/a.md')], 'next'))
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(page('_workspace', [file('_workspace/b.md')]));
    await mount(); await tick(); statusButton('加载更多').click(); await flush();
    const oldSignal = state.api.get.mock.calls[1][1].signal;
    active.value = false; await flush(); expect(oldSignal.aborted).toBe(true);
    active.value = true; await flush(); await tick();
    expect(state.api.get.mock.calls[2][0]).toContain('cursor=next'); expect(names()).toEqual(['a.md', 'b.md']);
    pending.resolve(page('_workspace', [file('_workspace/obsolete.md')])); await flush();
    expect(names()).toEqual(['a.md', 'b.md']);
  });

  it('cancels a stale project request and ignores its late result', async () => {
    const pending = deferred();
    state.api.get.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(page('_workspace', [file('_workspace/b.md')]));
    await mount(); await tick();
    const signal = state.api.get.mock.calls[0][1].signal;
    state.store.projectId = 'b'; state.store.projectVersion++; await flush(); expect(signal.aborted).toBe(true);
    await tick(); expect(state.api.get.mock.calls[1][0]).toContain('/api/projects/b/');
    pending.resolve(page('_workspace', [file('_workspace/a.md')])); await flush(); expect(names()).toEqual(['b.md']);
  });

  it('coalesces agent changes and defers workspace refreshes while hidden', async () => {
    state.api.get.mockResolvedValueOnce(page('_workspace', [file('_workspace/a.md')]))
      .mockResolvedValueOnce(page('_workspace', [file('_workspace/b.md')]))
      .mockResolvedValueOnce(page('_workspace', [file('_workspace/c.md')]));
    await mount(); await tick(); expect(names()).toEqual(['a.md']);
    state.store.workspaceVersion++; state.store.workspaceVersion++; await flush(); expect(state.api.get).toHaveBeenCalledTimes(1);
    await tick(); expect(state.api.get).toHaveBeenCalledTimes(2); expect(names()).toEqual(['b.md']);
    active.value = false; await flush(); state.store.workspaceVersion++; await flush(); await tick();
    expect(state.api.get).toHaveBeenCalledTimes(2);
    active.value = true; await flush(); await tick(); expect(state.api.get).toHaveBeenCalledTimes(3); expect(names()).toEqual(['c.md']);
  });

  it('refreshes the directory after uploading a workspace file', async () => {
    state.api.get.mockResolvedValueOnce(page('_workspace')).mockResolvedValueOnce(page('_workspace', [file('_workspace/new.txt')]));
    state.api.postForm.mockResolvedValue({ ok: true });
    await mount(); await tick();
    const input = el.querySelector('input[type=file]');
    Object.defineProperty(input, 'files', { configurable: true, value: [new File(['a'], 'new.txt')] });
    input.dispatchEvent(new Event('change', { bubbles: true })); await flush();
    expect(state.api.postForm).toHaveBeenCalledWith('/api/projects/a/upload', expect.any(FormData));
    expect(state.api.get).toHaveBeenCalledTimes(2); expect(names()).toEqual(['new.txt']);
  });

  it('refreshes the directory after renaming and deleting a workspace file', async () => {
    state.api.get.mockResolvedValueOnce(page('_workspace', [file('_workspace/old.md')]))
      .mockResolvedValueOnce(page('_workspace', [file('_workspace/new.md')]))
      .mockResolvedValueOnce(page('_workspace'));
    state.store.renamePath.mockResolvedValue(true); state.prompt.mockResolvedValue({ value: 'new.md' });
    state.confirm.mockResolvedValue(true); state.api.del.mockResolvedValue({ ok: true });
    await mount(); await tick();
    el.querySelector('[data-command="rename"]').click(); await flush();
    expect(state.store.renamePath).toHaveBeenCalledWith('_workspace/old.md', '_workspace/new.md');
    expect(names()).toEqual(['new.md']);
    el.querySelector('[data-command="remove"]').click(); await flush();
    expect(state.api.del).toHaveBeenCalledWith('/api/projects/a/files?path=_workspace%2Fnew.md');
    expect(names()).toEqual([]); expect(state.api.get).toHaveBeenCalledTimes(3);
  });

  it('refreshes workspace entries after a new directory without rescanning the project tree', async () => {
    state.prompt.mockResolvedValue({ value: 'drafts' });
    state.api.get.mockResolvedValueOnce(page('_workspace')).mockResolvedValueOnce(page('_workspace', [dir('_workspace/drafts')]));
    await mount(); await tick();
    el.querySelector('[title="新建目录"] button').click(); await flush();
    expect(state.api.post).toHaveBeenCalledWith('/api/projects/a/mkdir', { path: '_workspace/drafts' });
    expect(state.api.get).toHaveBeenCalledTimes(2); expect(names()).toEqual(['drafts/']);
  });
});
