// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, h, nextTick, reactive } from 'vue';
import ProjectsView from './ProjectsView.vue';

const state = vi.hoisted(() => ({ get: vi.fn(), push: vi.fn(), error: vi.fn(), auth: null }));
vi.mock('vue-router', () => ({ useRouter: () => ({ push: state.push }) }));
vi.mock('../api.js', () => ({
  api: { get: (...args) => state.get(...args) },
  fmtBytes: value => `${value} B`, fmtSeconds: value => `${value} s`, timeAgo: () => '刚刚',
}));
vi.mock('../stores/auth.js', () => ({ useAuthStore: () => state.auth }));
vi.mock('../stores/ui.js', () => ({ useUiStore: () => ({ error: state.error, toast: vi.fn(), confirm: vi.fn() }) }));
vi.mock('../lib/collabClient.js', () => ({ setCollabUser: vi.fn() }));
vi.mock('../components/StatsPanel.vue', () => ({ default: { render: () => null } }));
vi.mock('./SettingsView.vue', () => ({ default: { render: () => null } }));
vi.mock('./AdminView.vue', () => ({ default: { render: () => null } }));

let app, el;
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i=0; i<8; i++) { await Promise.resolve(); await nextTick(); } };
const project = (id, name = id) => ({ id, publicId: id, name, role: 'owner', ownerName: 'Owner' });
beforeEach(() => {
  localStorage.clear(); vi.clearAllMocks(); localStorage.setItem('corelatex.projectViewMode', 'card');
  state.auth = reactive({ user: { username: 'owner' }, usage: null, refreshUsage: vi.fn(async () => {}) });
});
afterEach(() => { app?.unmount(); app = null; el?.remove(); el = null; });
async function mount() {
  el = document.createElement('div'); document.body.appendChild(el); app = createApp(ProjectsView);
  app.component('el-dialog', { render: () => null });
  app.component('el-input', { render() { return h('input'); } });
  app.component('el-tooltip', { inheritAttrs: false, render() { return this.$slots.default?.(); } });
  app.component('el-dropdown', { render() { return h('div', [this.$slots.default?.(), this.$slots.dropdown?.()]); } });
  for (const name of ['el-icon','el-divider','el-card','el-radio-group','el-radio-button','el-button','el-dropdown-menu','el-dropdown-item','el-tag','el-progress','el-table-column','el-table','el-form-item','el-form','el-option','el-select'])
    app.component(name, { render() { return h('div', this.$slots.default?.()); } });
  app.directive('loading', {}); app.mount(el); await flush();
}

describe('progressive project listing', () => {
  it('shows project metadata immediately while exact sizes are still loading', async () => {
    const sizes = deferred();
    state.auth.usage = { projectCount: 1, projectQuota: 2, storageUsed: null, storageQuota: 1024, compileSecondsUsed: 0, compileSecondsQuota: -1 };
    state.get.mockImplementation(path => path.includes('summary=1') ? Promise.resolve({ projects: [project('a', 'Paper A')] }) : sizes.promise);
    await mount();
    expect(state.get).toHaveBeenCalledTimes(2);
    expect(state.get.mock.calls[0][0]).toContain('summary=1');
    expect(state.get.mock.calls[1][0]).not.toContain('summary=1');
    expect(el.querySelector('.proj-card-title').textContent).toBe('Paper A');
    expect(el.querySelector('.proj-card-meta').textContent).toContain('计算中…');
    expect(el.querySelector('.usage-card').textContent).toContain('计算中…');
    sizes.resolve({ projects: [{ ...project('a', 'stale name'), sizeBytes: 42 }] }); await flush();
    expect(el.querySelector('.proj-card-title').textContent).toBe('Paper A');
    expect(el.querySelector('.proj-card-meta').textContent).toContain('42 B');
  });

  it('keeps the project list when background size calculation fails', async () => {
    const sizes = deferred(); state.get.mockImplementation(path => path.includes('summary=1') ? Promise.resolve({ projects: [project('a')] }) : sizes.promise);
    await mount(); sizes.reject(new Error('stats unavailable')); await flush();
    expect(el.querySelector('.proj-card-title').textContent).toBe('a');
    expect(el.querySelector('.proj-card-meta').textContent).toContain('—');
    expect(state.error).not.toHaveBeenCalled();
  });

  it('cancels old statistics and ignores late results after a view change', async () => {
    const oldSizes = deferred(), newSizes = deferred();
    state.get.mockImplementation(path => path.includes('view=trash')
      ? path.includes('summary=1') ? Promise.resolve({ projects: [project('b')] }) : newSizes.promise
      : path.includes('summary=1') ? Promise.resolve({ projects: [project('a')] }) : oldSizes.promise);
    await mount();
    const oldSignal = state.get.mock.calls[1][1].signal;
    [...el.querySelectorAll('.nav-item')].find(node => node.textContent === '回收站').click(); await flush();
    expect(oldSignal.aborted).toBe(true); expect(el.querySelector('.proj-card-title').textContent).toBe('b');
    oldSizes.resolve({ projects: [{ ...project('a'), sizeBytes: 99 }] }); await flush();
    expect(el.querySelector('.proj-card-title').textContent).toBe('b'); expect(el.textContent).not.toContain('99 B');
    newSizes.resolve({ projects: [{ ...project('b'), sizeBytes: 13 }] }); await flush();
    expect(el.querySelector('.proj-card-meta').textContent).toContain('13 B');
  });

  it('aborts unfinished size and usage work on navigation away', async () => {
    const sizes = deferred(), usage = deferred(); state.auth.refreshUsage.mockReturnValueOnce(usage.promise);
    state.get.mockImplementation(path => path.includes('summary=1') ? Promise.resolve({ projects: [project('a')] }) : sizes.promise);
    await mount();
    const sizeSignal = state.get.mock.calls[1][1].signal;
    const usageSignal = state.auth.refreshUsage.mock.calls[0][0].signal;
    app.unmount(); app = null;
    expect(sizeSignal.aborted).toBe(true); expect(usageSignal.aborted).toBe(true);
    sizes.resolve({ projects: [{ ...project('a'), sizeBytes: 99 }] }); usage.resolve(); await flush();
  });

  it('keeps the previous project list if a later summary request fails', async () => {
    state.get.mockImplementation(path => path.includes('view=trash')
      ? Promise.reject(new Error('offline')) : Promise.resolve({ projects: [{ ...project('a'), sizeBytes: 10 }] }));
    await mount();
    [...el.querySelectorAll('.nav-item')].find(node => node.textContent === '回收站').click(); await flush();
    expect(el.querySelector('.proj-card-title').textContent).toBe('a');
    expect(state.error).toHaveBeenCalledWith('offline');
  });
  it('does not start a second size scan for an empty or already-sized response', async () => {
    state.get.mockResolvedValueOnce({ projects: [{ ...project('a'), sizeBytes: 10 }] });
    await mount(); expect(state.get).toHaveBeenCalledTimes(1);
    expect(el.querySelector('.proj-card-meta').textContent).toContain('10 B');
  });

  it('shows exact AI token totals, input, output and requests in the sidebar', async () => {
    state.auth.usage = { projectCount: 0, projectQuota: 2, storageUsed: 0, storageQuota: 1024,
      compileSecondsUsed: 0, compileSecondsQuota: -1, ai: { totalTokens: 60_203_584,
        inputTokens: 60_000_000, cacheReadTokens: 40_000_000, uncachedInputTokens: 20_000_000,
        outputTokens: 203_584, requests: 2 } };
    state.get.mockResolvedValue({ projects: [] });
    await mount();

    const usage = el.querySelector('.usage-card');
    expect(usage.querySelector('.usage-ai-total').textContent).toContain('总 Token 60,203,584');
    expect(usage.querySelector('.token-input > dd').textContent).toBe('60,000,000');
    expect(usage.textContent).not.toContain('缓存');
    expect(usage.querySelector('.token-input + .token-metric dd').textContent).toBe('203,584');
    expect(usage.textContent).toContain('请求 2 次');
  });
});
