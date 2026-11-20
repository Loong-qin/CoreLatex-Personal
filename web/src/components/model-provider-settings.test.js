// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, h, nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import ModelProviderSettings from './ModelProviderSettings.vue';
import { useAgentStore } from '../stores/agent.js';
vi.mock('../stores/ui.js', () => ({ useUiStore: () => ({ error: vi.fn(), toast: vi.fn(), confirm: vi.fn(async () => true) }) }));
vi.mock('../lib/collabClient.js', () => ({ detachProjectCollab: vi.fn(), subscribeProjectPresence: () => () => {}, detachAllCollab: vi.fn(), setPresenceListener: vi.fn() }));
let app, el;
afterEach(() => { app?.unmount(); el?.remove(); });
async function mount() {
  const pinia = createPinia(); setActivePinia(pinia); const agent = useAgentStore();
  agent.testConnection = vi.fn(async () => ({ ok: true, message: 'Connected' }));
  el = document.createElement('div'); document.body.appendChild(el);
  app = createApp(ModelProviderSettings, { providers: [
    { id: 'p1', name: 'Primary supplier', apiFormat: 'openai', baseUrl: 'https://example.test/v1', apiKey: '***abcd', models: [{ id: 'original-id', model: 'custom-model', name: 'Primary model', vision: false }] },
    { id: 'p2', name: 'Backup supplier', apiFormat: 'anthropic', models: [] },
  ], activeModelId: 'original-id' });
  app.use(pinia);
  app.component('el-input', { props: ['modelValue', 'size'], emits: ['update:modelValue'], render() { return h('input', { value: this.modelValue, onInput: e => this.$emit('update:modelValue', e.target.value) }); } });
  app.component('el-button', { props: ['disabled'], render() { return h('button', { disabled: this.disabled }, this.$slots.default?.()); } });
  app.component('el-dialog', { render() { return null; } });
  for (const name of ['el-form', 'el-form-item', 'el-select', 'el-option', 'el-switch', 'el-tag', 'el-input-number']) app.component(name, { render() { return h('div', this.$slots.default?.()); } });
  // Use the Pinia installed on the app for the actual component's service mock.
  const store = useAgentStore(pinia); store.testConnection = agent.testConnection;
  app.mount(el); await nextTick(); return store;
}
describe('provider and model settings UI', () => {
  it('shows a provider sidebar, shared connection config and its model list', async () => {
    await mount();
    expect(el.querySelectorAll('.provider-choice')).toHaveLength(2);
    expect(el.querySelector('.provider-heading h3').textContent).toBe('Primary supplier');
    expect(el.querySelector('.provider-model').textContent).toContain('custom-model');
    expect(el.querySelectorAll('.provider-model input[type=password]')).toHaveLength(0);
    el.querySelectorAll('.provider-choice')[1].click(); await nextTick();
    expect(el.querySelector('.provider-heading h3').textContent).toBe('Backup supplier');
    expect(el.querySelector('.models-empty')).toBeTruthy();
  });
  it('tests by saved provider/model IDs and disables testing for unsaved edits', async () => {
    const agent = await mount();
    const test = [...el.querySelectorAll('button')].find((b) => b.textContent === '测试连接');
    test.click(); await Promise.resolve(); await nextTick();
    expect(agent.testConnection).toHaveBeenCalledWith({ providerId: 'p1' });
    const input = el.querySelector('.provider-form input'); input.value = 'Renamed'; input.dispatchEvent(new Event('input', { bubbles: true })); await nextTick();
    expect(test.disabled).toBe(true); expect(el.textContent).toContain('先保存更改');
  });
});
