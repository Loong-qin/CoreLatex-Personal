// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, h, nextTick, reactive } from 'vue';
import ElementPlus from 'element-plus';
import SubagentSettings from './SubagentSettings.vue';

const providers = [{ id: 'provider', name: '供应商', enabled: true, models: [
  { id: 'main', name: '主模型', model: 'main-model', reasoningLevels: ['low', 'medium', 'high'] },
  { id: 'worker', name: '子模型', model: 'worker-model', reasoningLevels: ['low', 'high'] },
] }];
let app, host, state;
const flush = async () => { for (let i = 0; i < 8; i++) { await Promise.resolve(); await nextTick(); } };
const selectors = () => [...host.querySelectorAll('.el-select')].filter(el => el.querySelector('[aria-label="子智能体模型"], [aria-label="子智能体思考强度"]'));
const display = index => selectors()[index]?.querySelector('.el-select__placeholder')?.textContent.trim();
const open = async index => { selectors()[index].querySelector('.el-select__wrapper').click(); await flush(); };
async function choose(label, index = 0) {
  const items = [...document.querySelectorAll('.el-select-dropdown__item')].filter(item => item.textContent.trim() === label);
  expect(items[index], `option ${label}`).toBeTruthy();
  items[index].click(); await flush();
}
async function mount(initial = {}) {
  state = reactive({ modelId: '', reasoningEffort: '', ...initial });
  host = document.createElement('div'); document.body.append(host);
  app = createApp({ render: () => h(SubagentSettings, {
    providers, activeModelId: 'main', ...state,
    onChange: patch => {
      if ('collaborationTier' in patch) state.tier = patch.collaborationTier;
      if ('maxModelConcurrency' in patch) state.maxConcurrency = patch.maxModelConcurrency;
      if ('subagentModelId' in patch) state.modelId = patch.subagentModelId;
      if ('subagentReasoningEffort' in patch) state.reasoningEffort = patch.subagentReasoningEffort;
    },
  }) });
  app.use(ElementPlus); app.mount(host); await flush();
}
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { app?.unmount(); host?.remove(); vi.unstubAllGlobals(); });

describe('real child-agent selection controls', () => {
  it('shows both inheritance labels when values are empty strings', async () => {
    await mount();
    expect(display(0)).toBe('跟随主智能体');
    expect(display(1)).toBe('跟随主智能体');
  });

  it('shows the fixed model and that model’s automatic reasoning level', async () => {
    await mount({ modelId: 'worker' });
    expect(display(0)).toBe('供应商 · 子模型');
    expect(display(1)).toBe('模型默认（低）');
  });

  it('selects a fixed model and effort, then restores inheritance for both', async () => {
    await mount();
    await open(0); await choose('供应商 · 子模型');
    expect(state.modelId).toBe('worker');
    expect(display(0)).toBe('供应商 · 子模型');
    expect(display(1)).toBe('模型默认（低）');
    await open(1); await choose('高');
    expect(state.reasoningEffort).toBe('high'); expect(display(1)).toBe('高');
    await open(1); await choose('模型默认（低）');
    expect(state.reasoningEffort).toBe(''); expect(display(1)).toBe('模型默认（低）');
    await open(0); await choose('跟随主智能体');
    expect(state.modelId).toBe(''); expect(state.reasoningEffort).toBe('');
    expect(display(0)).toBe('跟随主智能体'); expect(display(1)).toBe('跟随主智能体');
  });
});


it('selects an explicit collaboration tier without changing the worker model', async () => {
  await mount({ modelId: 'worker' });
  const input = host.querySelector('[aria-label="协作档位"]');
  input.closest('.el-select').querySelector('.el-select__wrapper').click(); await flush();
  await choose('轻量 · 仅增量审阅');
  expect(state.tier).toBe('lite'); expect(state.modelId).toBe('worker');
  expect(host.querySelector('[aria-label="模型并发数"]')).toBeTruthy();
  expect(host.querySelector('[aria-label="自动修复周期上限"]')).toBeNull();
  expect(host.textContent).toContain('编译错误默认自动修复并重新验证');
});
