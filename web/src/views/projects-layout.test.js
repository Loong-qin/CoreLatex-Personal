// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, h, nextTick } from 'vue';
import ProjectsView from './ProjectsView.vue';

const mocks = vi.hoisted(() => ({ push: vi.fn(), get: vi.fn() }));
vi.mock('vue-router', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('../api.js', () => ({
  api: { get: (...args) => mocks.get(...args) },
  fmtBytes: n => `${n} B`, fmtSeconds: n => `${n} s`, timeAgo: () => '刚刚',
}));
vi.mock('../stores/auth.js', () => ({ useAuthStore: () => ({ user: { username: 'Researcher' }, usage: null, refreshUsage: vi.fn() }) }));
vi.mock('../stores/ui.js', () => ({ useUiStore: () => ({ error: vi.fn(), toast: vi.fn(), confirm: vi.fn() }) }));
vi.mock('../lib/collabClient.js', () => ({ setCollabUser: vi.fn() }));
vi.mock('../components/StatsPanel.vue', () => ({ default: { render: () => null } }));
vi.mock('./SettingsView.vue', () => ({ default: { render: () => null } }));
vi.mock('./AdminView.vue', () => ({ default: { render: () => null } }));
let app, el;
afterEach(() => { app?.unmount(); el?.remove(); localStorage.clear(); vi.clearAllMocks(); });
async function mount() {
  localStorage.setItem('corelatex.projectViewMode', 'card');
  mocks.get.mockResolvedValue({ projects: [{ id: 3, publicId: 'paper-id', name: 'Research paper', ownerName: 'Researcher', role: 'owner', sizeBytes: 100 }] });
  el = document.createElement('div'); document.body.appendChild(el);
  app = createApp(ProjectsView);
  app.component('el-dialog', { render: () => null });
  app.component('el-input', { render() { return h('input'); } });
  app.component('el-tooltip', { inheritAttrs: false, render() { return this.$slots.default?.(); } });
  app.component('el-dropdown', { render() { return h('div', [this.$slots.default?.(), this.$slots.dropdown?.()]); } });
  for (const name of ['el-icon', 'el-divider', 'el-card', 'el-radio-group', 'el-radio-button', 'el-button', 'el-dropdown-menu', 'el-dropdown-item', 'el-tag', 'el-progress', 'el-table-column', 'el-table', 'el-form-item', 'el-form', 'el-option', 'el-select']) {
    app.component(name, { render() { return h('div', this.$slots.default?.()); } });
  }
  app.directive('loading', {});
  app.mount(el); await Promise.resolve(); await nextTick();
}

describe('project workspace navigation', () => {
  it('keeps project links usable and labels the search and workspace navigation', async () => {
    await mount();
    expect(el.querySelector('.projects-heading h1').textContent).toContain('所有项目');
    expect(el.querySelector('.project-count').textContent).toBe('1');
    expect(el.querySelector('input[aria-label="搜索项目"]')).toBeTruthy();
    expect(el.querySelector('nav[aria-label="项目导航"]')).toBeTruthy();
    const link = el.querySelector('.proj-card-title');
    expect(link.getAttribute('href')).toBe('/project/paper-id');
    link.click();
    expect(mocks.push).toHaveBeenCalledWith('/project/paper-id');
  });
  it('keeps the complete project action menu without opening the card from its menu button', async () => {
    await mount();
    const menu = el.querySelector('button[aria-label="更多操作：Research paper"]');
    expect(menu).toBeTruthy(); menu.click();
    expect(mocks.push).not.toHaveBeenCalled();
    for (const label of ['打开', '重命名', '导出 ZIP', '共享', '归档', '删除']) expect(el.querySelector('.proj-more').textContent).toContain(label);
  });
  it('offers a new-tab action and keeps modified project title clicks native', async () => {
    await mount();
    const action = el.querySelector('a[aria-label="在新标签页打开：Research paper"]');
    expect(action.getAttribute('href')).toBe('/project/paper-id');
    expect(action.target).toBe('_blank'); expect(action.rel).toBe('noopener');
    const event = new MouseEvent('click', { ctrlKey: true, button: 0, cancelable: true, bubbles: true });
    const title = el.querySelector('.proj-card-title');
    let preventedByApp;
    title.addEventListener('click', e => { preventedByApp = e.defaultPrevented; e.preventDefault(); }, { once: true });
    title.dispatchEvent(event);
    expect(preventedByApp).toBe(false); expect(mocks.push).not.toHaveBeenCalled();
  });
  it('does not open deleted projects from the trash card', async () => {
    await mount();
    [...el.querySelectorAll('.nav-item')].find(n => n.textContent === '回收站').click();
    await Promise.resolve(); await nextTick();
    el.querySelector('.proj-card').click();
    expect(mocks.push).not.toHaveBeenCalled();
    expect(el.querySelector('.proj-card-title').tagName).toBe('SPAN');
    expect(el.querySelector('.project-new-tab')).toBeNull();
  });
  it('supports keyboard resizing and stops pointer resizing after cancellation', async () => {
    await mount();
    const separator = el.querySelector('[aria-label="调整项目侧栏宽度"]');
    separator.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })); await nextTick();
    expect(localStorage.getItem('corelatex.sidebarWidth')).toBe('240');
    separator.dispatchEvent(new MouseEvent('pointerdown', { clientX: 100, bubbles: true }));
    document.dispatchEvent(new MouseEvent('pointermove', { clientX: 130 })); await nextTick();
    expect(el.querySelector('.sidebar').style.width).toBe('270px');
    document.dispatchEvent(new MouseEvent('pointercancel')); await nextTick();
    document.dispatchEvent(new MouseEvent('pointermove', { clientX: 180 })); await nextTick();
    expect(el.querySelector('.sidebar').style.width).toBe('270px');
    expect(document.body.style.cursor).toBe('');
  });
});
