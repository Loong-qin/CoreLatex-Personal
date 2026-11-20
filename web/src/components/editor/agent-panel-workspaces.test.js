// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, h, nextTick, ref } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { createRouter, createMemoryHistory } from 'vue-router';
import AgentPanel from './AgentPanel.vue';
import { createProjectAgentStore, bindAgentContext } from '../../stores/agent.js';
import { createProjectEditorStore } from '../../stores/editor.js';
import { useAuthStore } from '../../stores/auth.js';
import { createEditorRuntime } from '../../lib/editorRuntime.js';
import { PROJECT_CONTEXT } from '../../lib/projectContext.js';
import { composerDrafts } from '../../lib/agentComposerDrafts.js';
import { api, ssePost } from '../../api.js';
const ui = vi.hoisted(() => ({ error: vi.fn(), toast: vi.fn(), confirm: vi.fn() }));
vi.mock('../../stores/ui.js', () => ({ useUiStore: () => ui }));
vi.mock('../../api.js', () => ({ api: { get: vi.fn() }, ssePost: vi.fn(), getToken: () => 'workspace-session', ApiError: Error }));
vi.mock('../../lib/collabClient.js', () => ({ detachAllCollab: vi.fn(), detachProjectCollab: vi.fn(), subscribeProjectPresence: vi.fn(() => vi.fn()), setPresenceListener: vi.fn() }));
const mounted = [];
const flush = async () => { for (let i = 0; i < 3; i++) { await Promise.resolve(); await nextTick(); } };
async function panel(key, pinia) {
  const editor = createProjectEditorStore(key, pinia), agent = createProjectAgentStore(key, pinia), runtime = createEditorRuntime();
  editor.projectId = key; editor.activeFile = `main-${key}.tex`; runtime.getDocText = () => `document-${key}`;
  agent.loadChat = vi.fn(async () => {});
  bindAgentContext(agent, { editor, ui });
  const active = ref(true), context = { projectId: key, editor, agent, runtime, active };
  const el = document.createElement('div'); document.body.appendChild(el);
  const app = createApp(AgentPanel); app.use(pinia); app.provide(PROJECT_CONTEXT, context);
  app.use(createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { render: () => null } }] }));
  app.component('el-input', { props: ['modelValue', 'disabled'], emits: ['update:modelValue'], render() { return h('textarea', { value: this.modelValue, disabled: this.disabled, onInput: (e) => this.$emit('update:modelValue', e.target.value) }); } });
  app.component('el-button', { props: ['disabled'], render() { return h('button', { disabled: this.disabled }, this.$slots.default?.()); } });
  app.component('el-select', {
    props: ['modelValue', 'disabled'], emits: ['update:modelValue'],
    render() { return h('select', { value: this.modelValue, disabled: this.disabled, onChange: e => this.$emit('update:modelValue', e.target.value) }, this.$slots.default?.()); },
  });
  app.component('el-option', { props: ['value', 'label'], render() { return h('option', { value: this.value }, this.label); } });
  app.component('el-icon', { render() { return h('span', this.$slots.default?.()); } });
  app.mount(el); const state = { el, app, editor, agent, runtime, active }; mounted.push(state); await flush(); return state;
}
async function send(panel, text) {
  const textarea = panel.el.querySelector('textarea'); textarea.value = text; textarea.dispatchEvent(new Event('input', { bubbles: true })); await flush();
  [...panel.el.querySelectorAll('button')].find((button) => button.textContent === '发送').click();
}
async function pick(panel, selector, value) {
  const field = panel.el.querySelector(selector);
  field.value = value;
  field.dispatchEvent(new Event('change', { bubbles: true }));
  await flush();
}
afterEach(() => { mounted.splice(0).forEach(({ app, el, agent }) => { app.unmount(); agent.clearLocal(); el.remove(); }); composerDrafts.clearAccount(9998); localStorage.clear(); vi.clearAllMocks(); });
describe('AgentPanel workspace injection', () => {
  it('sends each project choice and keeps the inactive stream alive across panel switches', async () => {
    const pinia = createPinia(); setActivePinia(pinia); useAuthStore(pinia).user = { id: 9998 };
    api.get.mockImplementation(async path => path === '/api/settings/ai' ? { activeModelId: 'a', models: [
      { id: 'a', model: 'A', hasKey: true, reasoningLevels: ['medium', 'high'] },
      { id: 'b', model: 'B', hasKey: true, reasoningLevels: ['medium', 'max'] },
    ] } : { chatId: 1, messages: [] });
    const streams = new Map(); ssePost.mockImplementation((path, body, onEvent, { signal }) => new Promise((resolve) => { streams.set(path, { body, onEvent, signal, resolve }); }));
    const a = await panel('panel-a', pinia), b = await panel('panel-b', pinia);
    b.active.value = false;
    await pick(a, '.model-select', 'b');
    await pick(a, '.reasoning-select', 'max');
    await send(a, 'task A'); await flush();
    const streamA = streams.get('/api/projects/panel-a/agent/chat');
    expect(streamA.body).toMatchObject({ message: 'task A', currentFile: 'main-panel-a.tex', currentContent: 'document-panel-a', modelId: 'b', reasoningEffort: 'max' });
    a.active.value = false; b.active.value = true;
    await flush();
    expect(b.el.querySelector('.model-select').value).toBe('a');
    await pick(b, '.reasoning-select', 'high');
    await send(b, 'task B'); await flush();
    const streamB = streams.get('/api/projects/panel-b/agent/chat');
    expect(streamB.body).toMatchObject({ currentContent: 'document-panel-b', modelId: 'a', reasoningEffort: 'high' });
    streamA.onEvent({ type: 'token', text: 'background A' }); await flush();
    expect(a.agent.streamText).toBe('background A'); expect(b.agent.streamText).toBe('');
    expect(streamA.signal.aborted).toBe(false); expect(streamB.signal.aborted).toBe(false);
    a.active.value = true; b.active.value = false; await flush();
    expect(a.el.textContent).toContain('background A');
    expect(a.el.querySelector('.model-select').value).toBe('b');
    expect(a.el.querySelector('.reasoning-select').value).toBe('max');
    streamA.onEvent({ type: 'done' }); streamA.resolve(); streamB.onEvent({ type: 'done' }); streamB.resolve(); await flush();
    expect(a.agent.streaming).toBe(false); expect(b.agent.streaming).toBe(false);
    a.editor.sidebar = 'tree'; await flush();
    a.editor.sidebar = 'agent'; await flush();
    expect(a.el.querySelector('.model-select').value).toBe('b');
    expect(a.el.querySelector('.reasoning-select').value).toBe('max');
  });
});
