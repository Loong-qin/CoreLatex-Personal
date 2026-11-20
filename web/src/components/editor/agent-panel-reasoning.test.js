// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { createApp, h, nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { createRouter, createMemoryHistory } from 'vue-router';
import AgentPanel from './AgentPanel.vue';
import { useAgentStore } from '../../stores/agent.js';
const ui = vi.hoisted(() => ({ error: vi.fn(), toast: vi.fn(), confirm: vi.fn() }));
vi.mock('../../stores/ui.js', () => ({ useUiStore: () => ui }));
vi.mock('../../lib/collabClient.js', () => ({ detachProjectCollab: vi.fn(), subscribeProjectPresence: () => () => {}, detachAllCollab: vi.fn(), setPresenceListener: vi.fn() }));
let app, el;
async function mount(levels = ['low', 'medium', 'high', 'xhigh', 'max']) {
  const pinia = createPinia(); setActivePinia(pinia); const agent = useAgentStore();
  agent.loadSettings = async () => { agent.settings = { activeModelId: 'a', models: [{ id: 'a', model: 'A', hasKey: true, reasoningLevels: levels }, { id: 'b', model: 'B', hasKey: true, reasoningLevels: ['custom', 'max'] }] }; };
  agent.loadChat = vi.fn(); agent.setActiveModel = vi.fn(async id => { agent.settings.activeModelId = id; });
  el = document.createElement('div'); document.body.appendChild(el);
  app = createApp(AgentPanel); app.use(pinia); app.use(createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { render: () => null } }] }));
  app.component('el-select', { props: ['modelValue', 'disabled'], emits: ['update:modelValue'], render() { return h('select', { value: this.modelValue, disabled: this.disabled, onChange: event => this.$emit('update:modelValue', event.target.value) }, this.$slots.default?.()); } });
  app.component('el-option', { props: ['value', 'label'], render() { return h('option', { value: this.value }, this.label); } });
  app.component('el-input', { render() { return h('textarea'); } });
  app.component('el-button', { props: ['disabled'], render() { return h('button', { disabled: this.disabled }, this.$slots.default?.()); } });
  app.component('el-icon', { render() { return h('span'); } });
  app.mount(el); await Promise.resolve(); await nextTick(); return agent;
}
const select = async (selector, value) => { const element = el.querySelector(selector); element.value = value; element.dispatchEvent(new Event('change', { bubbles: true })); await nextTick(); };
afterEach(() => { app?.unmount(); el?.remove(); vi.clearAllMocks(); });
it('renders configured thinking levels beside the model picker and changes only the effort', async () => {
  const agent = await mount();
  expect(el.querySelector('[aria-label="思考强度"]').value).toBe('medium');
  expect([...el.querySelectorAll('.reasoning-select option')].map(option => option.textContent)).toEqual(['低', '中', '高', '极高', '最高']);
  await select('.reasoning-select', 'max'); expect(agent.activeReasoningEffort).toBe('max');
  expect(agent.activeModelId).toBe('a'); expect(agent.setActiveModel).not.toHaveBeenCalled();
  await select('.model-select', 'b'); expect(agent.setActiveModel).toHaveBeenCalledWith('b');
  expect([...el.querySelectorAll('.reasoning-select option')].map(option => option.value)).toEqual(['custom', 'max']);
  expect(el.querySelector('.reasoning-select').value).toBe('custom');
});
it('disables both selectors during execution or clearing a conversation', async () => {
  const agent = await mount(); agent.streaming = true; await nextTick();
  expect(el.querySelector('.reasoning-select').disabled).toBe(true); expect(el.querySelector('.model-select').disabled).toBe(true);
  agent.streaming = false; agent.resetting = true; await nextTick();
  expect(el.querySelector('.reasoning-select').disabled).toBe(true); expect(el.querySelector('.model-select').disabled).toBe(true);
});
it('does not offer thinking controls for a model with no configured levels', async () => {
  await mount([]); expect(el.querySelector('.reasoning-select')).toBeNull(); expect(el.querySelector('.model-select')).not.toBeNull();
});
