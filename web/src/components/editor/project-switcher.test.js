// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, h, KeepAlive, nextTick, ref } from 'vue';
import ProjectSwitcher from './ProjectSwitcher.vue';
const mocks = vi.hoisted(() => ({ get: vi.fn(), push: vi.fn() }));
vi.mock('vue-router', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('../../api.js', () => ({ api: { get: (...args) => mocks.get(...args) } }));
let app, el, cachedVisible;
async function flush() { await Promise.resolve(); await Promise.resolve(); await nextTick(); }
async function mount(options = {}) {
  mocks.get.mockImplementation(path => Promise.resolve({ projects: path.includes('view=archived')
    ? [{ publicId: 'archived-paper', name: 'Old results', archived: true, role: 'owner', ownerName: 'Ada' }]
    : [{ publicId: 'current-paper', name: 'Current draft', role: 'owner', ownerName: 'Ada' }, { publicId: 'second-paper', name: 'Shared experiment', role: 'viewer', ownerName: 'Lin' }] }));
  el = document.createElement('div'); document.body.appendChild(el);
  const props = { project: { publicId: 'current-paper', name: 'Current draft' }, compact: !!options.compact, workspaceProjects: options.workspaceProjects };
  cachedVisible = ref(true);
  app = options.keepAlive ? createApp({ render: () => h(KeepAlive, null, { default: () => cachedVisible.value ? h(ProjectSwitcher, props) : null }) }) : createApp(ProjectSwitcher, props);
  app.component('el-icon', { render() { return h('span', this.$slots.default?.()); } });
  app.mount(el); await nextTick();
}
async function open() { const details = el.querySelector('details'); details.open = true; details.dispatchEvent(new Event('toggle')); await flush(); }
afterEach(() => { app?.unmount(); el?.remove(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe('single-page project workspaces', () => {
  it('loads only when opened and switches ordinary project links inside the current workspace', async () => {
    await mount(); expect(mocks.get).not.toHaveBeenCalled(); await open();
    expect(mocks.get).toHaveBeenCalledWith('/api/projects?view=all&summary=1');
    expect(mocks.get).toHaveBeenCalledWith('/api/projects?view=archived&summary=1');
    const current = el.querySelector('[aria-current="page"]');
    expect(current.textContent).toContain('Current draft'); expect(current.tagName).toBe('DIV');
    const link = el.querySelector('a[href="/project/second-paper"]');
    expect(link.target).toBe(''); expect(link.textContent).toContain('只读');
    expect(el.querySelector('a[href="/project/archived-paper"]').textContent).toContain('已归档 · 只读');
    const click = new MouseEvent('click', { button: 0, cancelable: true, bubbles: true });
    link.dispatchEvent(click); expect(click.defaultPrevented).toBe(true);
    expect(mocks.push).toHaveBeenCalledWith('/project/second-paper');
    expect(el.querySelector('details').open).toBe(false); expect(el.querySelector('summary').textContent).toContain('Current draft');
    await open(); expect(mocks.get).toHaveBeenCalledTimes(2);
  });
  it('keeps modified project clicks native and opens the project list in the same page by default', async () => {
    await mount(); await open();
    const link = el.querySelector('a[href="/project/second-paper"]');
    let preventedByApp;
    link.addEventListener('click', e => { preventedByApp = e.defaultPrevented; e.preventDefault(); }, { once: true });
    link.dispatchEvent(new MouseEvent('click', { ctrlKey: true, button: 0, cancelable: true, bubbles: true }));
    expect(preventedByApp).toBe(false); expect(mocks.push).not.toHaveBeenCalled();
    await open(); el.querySelector('.picker-footer').click();
    expect(mocks.push).toHaveBeenCalledWith('/');
    expect(el.querySelector('.picker-footer').target).toBe('');
  });
  it('anchors below the actual summary and keeps the picker within a narrow viewport', async () => {
    await mount();
    const rect = vi.spyOn(el.querySelector('summary'), 'getBoundingClientRect');
    rect.mockReturnValue({ left: 140, bottom: 130 });
    await open();
    const picker = el.querySelector('.project-picker');
    expect(picker.style.top).toBe('136px'); expect(picker.style.left).toBe('140px');
    rect.mockReturnValue({ left: 360, bottom: 137 });
    vi.stubGlobal('innerWidth', 390); vi.stubGlobal('innerHeight', 844);
    window.dispatchEvent(new Event('resize')); await nextTick();
    expect(picker.style.left).toBe('16px'); expect(picker.style.top).toBe('143px'); expect(picker.style.maxHeight).toBe('685px');
    el.querySelector('.picker-list').dispatchEvent(new Event('scroll', { bubbles: true }));
    expect(el.querySelector('details').open).toBe(true);
  });
  it('closes a cached picker on deactivation and removes its outside listener until it is active again', async () => {
    const add = vi.spyOn(document, 'addEventListener'), remove = vi.spyOn(document, 'removeEventListener');
    await mount({ keepAlive: true }); await open();
    const details = el.querySelector('details');
    const handler = add.mock.calls.find(([type]) => type === 'pointerdown')[1];
    cachedVisible.value = false; await nextTick();
    expect(details.open).toBe(false);
    expect(remove).toHaveBeenCalledWith('pointerdown', handler);
    cachedVisible.value = true; await nextTick(); await open();
    expect(el.querySelector('details').open).toBe(true);
    document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    expect(el.querySelector('details').open).toBe(false);
    add.mockRestore(); remove.mockRestore();
  });
  it('offers the same searchable switcher from a compact rail icon without the full project-name trigger', async () => {
    await mount({ compact: true });
    const summary = el.querySelector('summary');
    expect(el.querySelector('details').classList.contains('compact')).toBe(true);
    expect(summary.getAttribute('aria-label')).toBe('打开或切换项目');
    expect(summary.title).toContain('Current draft');
    expect(summary.querySelector('.current-project-name')).toBeNull();
    vi.spyOn(summary, 'getBoundingClientRect').mockReturnValue({ left: 6, right: 42, top: 200, bottom: 238 });
    await open();
    expect(el.querySelector('.project-picker').style.top).toBe('200px');
    expect(el.querySelector('.project-picker').style.left).toBe('50px');
    expect(el.querySelector('input[aria-label="筛选工作区项目"]')).toBeTruthy();
    el.querySelector('a[href="/project/second-paper"]').click();
    expect(mocks.push).toHaveBeenCalledWith('/project/second-paper');
  });
  it('filters by project name or owner and restores keyboard focus on Escape', async () => {
    await mount(); await open();
    const input = el.querySelector('input');
    expect(document.activeElement).toBe(input);
    input.value = 'Lin'; input.dispatchEvent(new Event('input', { bubbles: true })); await nextTick();
    expect(el.querySelectorAll('.picker-list li')).toHaveLength(1);
    expect(el.querySelector('.picker-list').textContent).toContain('Shared experiment');
    input.value = 'absent'; input.dispatchEvent(new Event('input', { bubbles: true })); await nextTick();
    expect(el.querySelector('.picker-list').textContent).toContain('没有匹配的项目');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(el.querySelector('details').open).toBe(false); expect(document.activeElement).toBe(el.querySelector('summary'));
  });
  it('allows retry after a failed load and closes when another control is used', async () => {
    await mount(); mocks.get.mockRejectedValueOnce(new Error('暂时断开')); await open();
    expect(el.querySelector('[role="alert"]').textContent).toContain('暂时断开');
    el.querySelector('.picker-error button').click(); await flush();
    expect(el.querySelector('a[href="/project/second-paper"]')).toBeTruthy();
    document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    expect(el.querySelector('details').open).toBe(false);
  });
  it('shows review counts and unread dots on the corresponding picker rows', async () => {
    await mount({ workspaceProjects: [
      { publicId: 'current-paper', pendingReviewCount: 2, unreadCompletion: true },
      { publicId: 'second-paper', unreadCompletion: true },
      { publicId: 'archived-paper', pendingReviewCount: 1, unreadCompletion: true },
    ] });
    await open();
    const current = el.querySelector('[aria-current="page"]');
    const next = el.querySelector('[href="/project/second-paper"]');
    const archived = el.querySelector('[href="/project/archived-paper"]');
    expect(current.querySelector('.project-notification-count').title).toBe('2 个待审阅文件');
    expect(current.querySelector('.project-notification-dot')).toBeNull();
    expect(next.querySelector('.project-notification-dot')).toBeTruthy();
    expect(next.getAttribute('aria-label')).toContain('有未读完成结果');
    expect(archived.querySelector('.project-notification-count').title).toBe('1 个待审阅文件');
    expect(archived.querySelector('.project-notification-dot')).toBeNull();
  });
});
