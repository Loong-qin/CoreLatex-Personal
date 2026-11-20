// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, h, nextTick } from 'vue';
import SettingsView from './SettingsView.vue';
import { ElTooltip } from 'element-plus';

const services = vi.hoisted(() => ({
  agent: { loadSettings: vi.fn(), saveSettings: vi.fn(), loadSkills: vi.fn(), skills: [] },
  auth: { token: 'account-a', user: { id: 1 }, isAdmin: false },
  ui: { error: vi.fn(), toast: vi.fn() },
  sound: { previewCompletionSound: vi.fn(async () => true), setCompletionSoundEnabled: vi.fn() },
}));
vi.mock('../stores/agent.js', () => ({ useAgentStore: () => services.agent }));
vi.mock('../stores/auth.js', () => ({ useAuthStore: () => services.auth }));
vi.mock('../stores/ui.js', () => ({ useUiStore: () => services.ui }));
vi.mock('../lib/agentCompletionSound.js', () => services.sound);
vi.mock('../lib/collabClient.js', () => ({ setCollabUser: vi.fn() }));
vi.mock('../api.js', () => ({ api: { get: vi.fn(), put: vi.fn() }, getToken: () => services.auth.token }));
vi.mock('../components/ModelProviderSettings.vue', () => ({ default: { render: () => null } }));
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn(), back: vi.fn() }) }));

let app, host, pending, catalog;
const settings = (config = {}) => ({ ...catalog, chineseSupport: true,
  agentConfig: { graphOrchestration: false, completionSound: true, ...config } });
const flush = async () => { for (let i = 0; i < 6; i++) { await Promise.resolve(); await nextTick(); } };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function unmount() { app?.unmount(); app = null; }
function finishSave(index) { pending[index].resolve(settings(pending[index].patch.agentConfig)); }
const soundSwitch = () => host.querySelector('[role="switch"][aria-label="任务提醒声音"]');
const graphSwitch = () => host.querySelector('[role="switch"][aria-label="多智能体协作"]');
beforeEach(() => {
  vi.clearAllMocks(); vi.useFakeTimers(); localStorage.clear(); pending = [];
  catalog = { providers: [], models: [], activeModelId: '' };
  services.auth.token = 'account-a'; services.auth.user = { id: 1 };
  services.agent.loadSettings.mockResolvedValue(settings());
  services.agent.loadSkills.mockResolvedValue([]);
  services.agent.saveSettings.mockImplementation(patch => {
    const request = deferred(); pending.push({ ...request, patch: structuredClone(patch) }); return request.promise;
  });
});
afterEach(async () => {
  unmount();
  for (let i = 0; i < pending.length && i < 10; i++) { finishSave(i); await flush(); }
  host?.remove(); vi.clearAllTimers(); vi.useRealTimers();
});
async function mount({ loading = false } = {}) {
  host = document.createElement('div'); document.body.append(host);
  app = createApp(SettingsView, { embedded: true });
  app.directive('loading', {});
  app.component('el-tooltip', ElTooltip);
  app.component('el-switch', { props: ['modelValue'], emits: ['update:modelValue'], render() {
    return h('button', { ...this.$attrs, type: 'button', role: 'switch', 'aria-checked': String(!!this.modelValue),
      onClick: () => this.$emit('update:modelValue', !this.modelValue) });
  } });
  app.component('el-button', { props: ['disabled'], render() { return h('button', { disabled: this.disabled }, this.$slots.default?.()); } });
  app.component('el-dialog', { render: () => null });
  app.component('el-select', { props: ['modelValue', 'disabled'], emits: ['update:modelValue'], render() {
    return h('select', { ...this.$attrs, value: this.modelValue, disabled: this.disabled,
      onChange: event => this.$emit('update:modelValue', event.target.value) }, this.$slots.default?.());
  } });
  app.component('el-option', { props: ['value', 'label', 'disabled'], render() {
    return h('option', { value: this.value, disabled: this.disabled }, this.label);
  } });
  for (const name of ['el-form', 'el-form-item', 'el-input', 'el-input-number', 'el-table', 'el-table-column', 'el-pagination', 'el-tag', 'el-radio-group', 'el-radio-button', 'el-empty', 'el-card']) {
    app.component(name, { render() { return h('div', this.$slots.default?.()); } });
  }
  app.mount(host); await flush();
  if (!loading) {
    [...host.querySelectorAll('.settings-nav button')].find(button => button.textContent.includes('智能体设置')).click();
    await flush();
  }
}

describe('agent settings autosave', () => {
  it('keeps the latest sound switch off while an older graph save finishes, then saves the newer preference', async () => {
    await mount();
    graphSwitch().click(); await flush(); await vi.advanceTimersByTimeAsync(800);
    expect(pending).toHaveLength(1);
    expect(pending[0].patch.agentConfig).toMatchObject({ graphOrchestration: true, completionSound: true });
    soundSwitch().click(); await flush();
    expect(soundSwitch().getAttribute('aria-checked')).toBe('false');
    expect(services.sound.setCompletionSoundEnabled).toHaveBeenLastCalledWith(false);
    finishSave(0); await flush();
    expect(soundSwitch().getAttribute('aria-checked')).toBe('false');
    expect(graphSwitch().getAttribute('aria-checked')).toBe('true');
    expect(services.sound.setCompletionSoundEnabled).toHaveBeenLastCalledWith(false);
    await vi.advanceTimersByTimeAsync(800);
    expect(pending).toHaveLength(2);
    expect(pending[1].patch.agentConfig).toMatchObject({ graphOrchestration: true, completionSound: false });
    finishSave(1); await flush(); await vi.advanceTimersByTimeAsync(10000);
    expect(pending).toHaveLength(2);
  });

  it('flushes one debounced preference save on unmount without creating a save loop', async () => {
    await mount();
    soundSwitch().click(); await flush();
    expect(pending).toHaveLength(0);
    unmount();
    expect(pending).toHaveLength(1);
    expect(pending[0].patch.agentConfig.completionSound).toBe(false);
    finishSave(0); await flush(); await vi.advanceTimersByTimeAsync(10000);
    expect(pending).toHaveLength(1);
  });

  it('flushes newer edits once after an in-flight save finishes following unmount', async () => {
    await mount(); graphSwitch().click(); await flush(); await vi.advanceTimersByTimeAsync(800);
    soundSwitch().click(); await flush(); unmount();
    expect(pending).toHaveLength(1);
    finishSave(0); await flush();
    expect(pending).toHaveLength(2);
    expect(pending[1].patch.agentConfig.completionSound).toBe(false);
    finishSave(1); await flush(); await vi.advanceTimersByTimeAsync(10000);
    expect(pending).toHaveLength(2);
  });

  it('does not save default preferences when leaving before the initial account settings load', async () => {
    const initial = deferred(); services.agent.loadSettings.mockReturnValue(initial.promise);
    await mount({ loading: true }); unmount();
    expect(services.agent.saveSettings).not.toHaveBeenCalled();
    initial.resolve(settings({ completionSound: false, graphOrchestration: true }));
    await flush(); await vi.advanceTimersByTimeAsync(10000);
    expect(services.agent.saveSettings).not.toHaveBeenCalled();
  });

  it('does not send a queued old-account preference save after the signed-in account changes', async () => {
    await mount(); graphSwitch().click(); await flush(); await vi.advanceTimersByTimeAsync(800);
    soundSwitch().click(); await flush(); unmount();
    services.auth.token = 'account-b'; services.auth.user = { id: 2 };
    finishSave(0); await flush(); await vi.advanceTimersByTimeAsync(10000);
    expect(pending).toHaveLength(1);
  });

  it('does not retry a failed unmount save indefinitely or emit stale panel notifications', async () => {
    await mount(); soundSwitch().click(); await flush(); unmount();
    pending[0].reject(new Error('network offline')); await flush();
    await vi.advanceTimersByTimeAsync(10000);
    expect(pending).toHaveLength(1);
    expect(services.ui.error).not.toHaveBeenCalled();
    expect(services.ui.toast).not.toHaveBeenCalled();
  });
});

describe('compact multi-agent collaboration preference', () => {
  it('keeps only the collaboration label and switch, with the standard workflow explanation on hover and keyboard focus', async () => {
    await mount();
    const explanation = '开启后允许按需分派独立子任务；标准工作流程始终启用。';
    const row = host.querySelector('.graph-orchestration-row');
    expect(row.textContent.trim()).toBe('多智能体协作');
    expect(row.querySelector('small')).toBeNull();
    expect(host.querySelector('.workflow-examples')).toBeNull();
    expect(host.textContent).not.toContain(explanation);
    graphSwitch().focus(); await flush(); await vi.advanceTimersByTimeAsync(250); await flush();
    let tooltip = [...document.querySelectorAll('[role="tooltip"]')].find(node => node.textContent.includes(explanation));
    expect(tooltip).toBeTruthy();
    expect(tooltip.getAttribute('aria-hidden')).not.toBe('true');
    graphSwitch().blur(); await flush(); await vi.advanceTimersByTimeAsync(400);
    graphSwitch().dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    await flush(); await vi.advanceTimersByTimeAsync(250); await flush();
    tooltip = [...document.querySelectorAll('[role="tooltip"]')].find(node => node.textContent.includes(explanation));
    expect(tooltip.getAttribute('aria-hidden')).not.toBe('true');
    graphSwitch().click(); await flush();
    expect(host.querySelector('.workflow-examples')).toBeNull();
    expect(row.querySelectorAll('[role="switch"]')).toHaveLength(1);
  });

  it('describes faithful Chinese annotations updated with the body and saves the existing preference key', async () => {
    await mount();
    const toggle = host.querySelector('[role="switch"][aria-label="中文注释支持"]');
    const row = toggle.closest('.switch-row');
    expect(row.textContent).toContain('忠实对应英文正文');
    expect(row.textContent).toContain('修改正文时同步更新译注');
    expect(row.textContent).not.toMatch(/独立核验|强制对照/);
    toggle.click(); await flush(); await vi.advanceTimersByTimeAsync(800);
    expect(pending).toHaveLength(1);
    expect(pending[0].patch.chineseSupport).toBe(false);
    expect(pending[0].patch.agentConfig.graphOrchestration).toBe(false);
  });
});


it('loads existing MCP entries on HTTP without randomUUID instead of aborting settings initialization', async () => {
  vi.stubGlobal('crypto', { getRandomValues: bytes => { bytes.fill(12); return bytes; } });
  services.agent.loadSettings.mockResolvedValue({ ...settings(), mcpConfig: { servers: [{ name: 'local-files', command: 'node', args: ['server.js'], env: {} }] } });
  try {
    await mount();
    expect(services.ui.error).not.toHaveBeenCalled();
    expect(services.agent.loadSkills).toHaveBeenCalledOnce();
    [...host.querySelectorAll('.settings-nav button')].find(button => button.textContent.includes('MCP')).click(); await flush();
    expect(host.textContent).toContain('local-files');
  } finally { vi.unstubAllGlobals(); }
});

const workerModel = () => host.querySelector('select[aria-label="子智能体模型"]');
const workerEffort = () => host.querySelector('select[aria-label="子智能体思考强度"]');
async function choose(select, value) { select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })); await flush(); }
function loadWorkerSettings(config = {}) {
  catalog = { activeModelId: 'main', providers: [
    { id: 'primary', name: 'Primary', enabled: true, models: [
      { id: 'main', model: 'main-model', reasoningLevels: ['low', 'medium', 'high'] },
      { id: 'worker', name: 'Worker', model: 'worker-model', reasoningLevels: ['low', 'high', 'custom.deep:2'] },
      { id: 'plain', model: 'plain-model', reasoningLevels: [] },
      { id: 'disabled-model', model: 'hidden', enabled: false },
    ] },
    { id: 'disabled-provider', enabled: false, models: [{ id: 'unavailable', model: 'hidden' }] },
  ] };
  services.agent.loadSettings.mockResolvedValue(settings({ graphOrchestration: true, ...config }));
}

describe('subagent settings autosave and capabilities', () => {
  it('loads saved choices, filters unavailable models, resets incompatible effort on model switch and preserves main model', async () => {
    loadWorkerSettings({ subagentModelId: 'worker', subagentReasoningEffort: 'high' });
    await mount();
    expect(workerModel().value).toBe('worker'); expect(workerEffort().value).toBe('high');
    expect([...workerModel().options].map(option => option.value)).toEqual(['', 'main', 'worker', 'plain']);
    expect([...workerEffort().options].map(option => option.value)).toEqual(['', 'low', 'high', 'custom.deep:2']);
    expect(host.textContent).toContain('模型默认（低）');
    await choose(workerModel(), 'plain');
    expect(workerEffort().value).toBe(''); expect(workerEffort().disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(800);
    expect(pending[0].patch.agentConfig).toMatchObject({ subagentModelId: 'plain', subagentReasoningEffort: '' });
    expect(pending[0].patch).not.toHaveProperty('activeModelId');
    expect(pending[0].patch).not.toHaveProperty('providers');
    finishSave(0); await flush();
    services.agent.loadSettings.mockResolvedValue(settings(pending[0].patch.agentConfig));
    unmount(); host.remove(); await mount();
    expect(workerModel().value).toBe('plain'); expect(workerEffort().disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(1000); expect(pending).toHaveLength(1);
  });

  it('keeps newer worker choices while an older save completes and retains them when collaboration is disabled', async () => {
    loadWorkerSettings(); await mount();
    await choose(workerModel(), 'worker'); await choose(workerEffort(), 'high'); await vi.advanceTimersByTimeAsync(800);
    expect(pending).toHaveLength(1);
    await choose(workerEffort(), 'custom.deep:2');
    finishSave(0); await flush();
    expect(workerEffort().value).toBe('custom.deep:2');
    await vi.advanceTimersByTimeAsync(800);
    expect(pending[1].patch.agentConfig).toMatchObject({ subagentModelId: 'worker', subagentReasoningEffort: 'custom.deep:2' });
    finishSave(1); await flush();
    graphSwitch().click(); await flush(); expect(workerModel()).toBeNull();
    await vi.advanceTimersByTimeAsync(800);
    expect(pending[2].patch.agentConfig).toMatchObject({ graphOrchestration: false, subagentModelId: 'worker', subagentReasoningEffort: 'custom.deep:2' });
    finishSave(2); await flush(); graphSwitch().click(); await flush();
    expect(workerModel().value).toBe('worker'); expect(workerEffort().value).toBe('custom.deep:2');
  });

  it('offers explicit recovery for a saved unavailable model and an unsupported inherited effort', async () => {
    loadWorkerSettings({ subagentModelId: 'deleted-model', subagentReasoningEffort: 'custom.deep:2' }); await mount();
    expect(workerModel().value).toBe('deleted-model');
    expect(host.querySelector('[role="status"]').textContent).toContain('请重新选择');
    expect(workerEffort().disabled).toBe(false);
    await choose(workerModel(), '');
    expect(workerEffort().value).toBe('');
    expect(host.textContent).toContain('跟随主智能体当前档位');
    expect([...workerEffort().options].map(option => option.value)).toEqual(['', 'low', 'medium', 'high']);
    await vi.advanceTimersByTimeAsync(800);
    expect(pending[0].patch.agentConfig).toMatchObject({ subagentModelId: '', subagentReasoningEffort: '' });
    finishSave(0); await flush();
    expect(host.textContent).toContain('审查仅检测本轮新增或修改内容引入的冲突、事实性错误');
  });
});
