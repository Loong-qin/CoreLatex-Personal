// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, KeepAlive, nextTick, ref } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { createRouter, createMemoryHistory } from 'vue-router';
import AgentPanel from './AgentPanel.vue';
import { useAgentStore } from '../../stores/agent.js';
import { useEditorStore } from '../../stores/editor.js';
import { useAuthStore } from '../../stores/auth.js';
import { composerDrafts } from '../../lib/agentComposerDrafts.js';
vi.mock('../../lib/collabClient.js', () => ({ detachAllCollab: vi.fn(), detachProjectCollab: vi.fn(), subscribeProjectPresence: vi.fn(() => vi.fn()), setPresenceListener: vi.fn() }));
const mounted = [];
const flush = async () => { for (let i = 0; i < 5; i++) { await Promise.resolve(); await nextTick(); } };
const message = (id) => ({ id, role: 'user', content: `message ${id}` });
const visible = (el) => el.isConnected && !el.closest('.synthetic-hidden') && el.style.display !== 'none';
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function () { return visible(this) ? this.classList.contains('messages') ? 200 : 100 : 0; });
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function () {
    if (!visible(this)) return 0;
    if (this.classList.contains('messages')) return 800 + this.querySelectorAll('.msg-wrap').length * 200;
    return this.classList.contains('thinking-content') ? 600 : 100;
  });
});
afterEach(() => { mounted.splice(0).forEach(({ app, host }) => { app.unmount(); host.remove(); }); composerDrafts.clearAccount(9995); vi.restoreAllMocks(); });
async function mount(prepare) {
  const pinia = createPinia(); setActivePinia(pinia);
  const agent = useAgentStore(), editor = useEditorStore(); useAuthStore().user = { id: 9995 };
  editor.projectId = 'scroll-project'; editor.sidebar = 'agent';
  agent.loadSettings = async () => { agent.settings = { hasKey: true, model: 'test' }; }; agent.loadChat = vi.fn(async () => {});
  agent.messages = [message(1), message(2), message(3)]; if (prepare) prepare(agent);
  const selected = ref('chat');
  const OtherPage = defineComponent({ render: () => h('div', 'other page') });
  const ChatPage = defineComponent({ setup: () => () => h('div', { class: { 'synthetic-hidden': editor.sidebar !== 'agent' } }, h(AgentPanel)) });
  const app = createApp({ render: () => h(KeepAlive, null, { default: () => selected.value === 'chat' ? h(ChatPage, { key: 'chat' }) : h(OtherPage, { key: 'other' }) }) });
  app.use(pinia); app.use(createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: OtherPage }] }));
  for (const name of ['el-select', 'el-option', 'el-icon']) app.component(name, { render() { return h('span', this.$slots.default?.()); } });
  app.component('el-input', { props: ['modelValue'], render() { return h('textarea', { value: this.modelValue }); } });
  app.component('el-button', { render() { return h('button', this.$slots.default?.()); } });
  const host = document.createElement('div'); document.body.appendChild(host); app.mount(host); mounted.push({ app, host }); await flush();
  return { host, selected, agent, editor, body: host.querySelector('.messages') };
}
function scroll(body, top) { body.scrollTop = top; body.dispatchEvent(new Event('scroll')); }
describe('retained chat reading position', () => {
  it('restores the exact upward reading position after KeepAlive detachment and background messages', async () => {
    const test = await mount(); scroll(test.body, 150);
    test.selected.value = 'other'; await flush(); expect(test.body.isConnected).toBe(false);
    scroll(test.body, 0); test.agent.messages.push(message(4)); await flush();
    test.selected.value = 'chat'; await flush();
    expect(test.host.querySelector('.messages')).toBe(test.body); expect(test.body.scrollTop).toBe(150);
    test.agent.messages.push(message(5)); await flush(); expect(test.body.scrollTop).toBe(150);
  });
  it('prioritizes the position before switching over background additions, then resumes following when the reader returns to the bottom', async () => {
    const test = await mount(); const before = test.body.scrollHeight - test.body.clientHeight; scroll(test.body, before);
    test.selected.value = 'other'; await flush(); scroll(test.body, 0); test.agent.messages.push(message(4)); await flush();
    test.selected.value = 'chat'; await flush(); expect(test.body.scrollTop).toBe(before);
    test.agent.messages.push(message(5)); await flush(); expect(test.body.scrollTop).toBe(before);
    scroll(test.body, test.body.scrollHeight - test.body.clientHeight);
    test.agent.messages.push(message(6)); await flush(); expect(test.body.scrollTop).toBe(test.body.scrollHeight);
  });
  it('preserves reading when another functional sidebar hides the same mounted chat', async () => {
    const test = await mount(); scroll(test.body, 330);
    test.editor.sidebar = 'tree'; await flush(); expect(test.body.clientHeight).toBe(0);
    scroll(test.body, 0); test.agent.messages.push(message(4)); await flush();
    test.editor.sidebar = 'agent'; await flush(); expect(test.body.isConnected).toBe(true); expect(test.body.scrollTop).toBe(330);
  });
  it('does not let a queued live-follow callback overwrite the position captured while switching', async () => {
    const test = await mount(); const before = test.body.scrollHeight - test.body.clientHeight; scroll(test.body, before);
    test.agent.messages.push(message(4)); test.selected.value = 'other'; await flush();
    scroll(test.body, 0); test.selected.value = 'chat'; await flush(); expect(test.body.scrollTop).toBe(before);
  });
  it('retains both the outer chat and each thought manual reading/collapse state', async () => {
    const test = await mount((agent) => { agent.messages.push({ id: 'answer', role: 'assistant', content: 'done', steps: [
      { type: 'model_thinking', text: 'first thought' }, { type: 'model_thinking', text: 'second thought' }, { type: 'text', text: 'done' },
    ] }); });
    test.host.querySelector('.tl-head').click(); await flush();
    const thoughts = test.host.querySelectorAll('.thinking-content'); scroll(thoughts[0], 120); test.host.querySelectorAll('.thinking-heading')[1].click(); await flush(); scroll(test.body, 210);
    test.selected.value = 'other'; await flush(); scroll(test.body, 0); scroll(thoughts[0], 0);
    test.agent.messages.push(message(5)); await flush(); test.selected.value = 'chat'; await flush();
    expect(test.body.scrollTop).toBe(210); expect(thoughts[0].scrollTop).toBe(120);
    expect(test.host.querySelectorAll('.thinking-heading')[1].getAttribute('aria-expanded')).toBe('false');
    expect(thoughts[1].style.display).toBe('none');
  });
});

describe('jump to latest and live following', () => {
  it('only shows the floating arrow when away from the bottom, including a small manual upward scroll', async () => {
    const test = await mount();
    scroll(test.body, test.body.scrollHeight - test.body.clientHeight);
    await flush(); expect(test.host.querySelector('.jump-to-latest')).toBeNull();
    const reading = test.body.scrollTop - 40;
    scroll(test.body, reading); await flush();
    expect(test.host.querySelector('.jump-to-latest')?.getAttribute('aria-label')).toBe('回到最新消息');
    test.agent.messages.push(message(4)); await flush(); expect(test.body.scrollTop).toBe(reading);
    scroll(test.body, test.body.scrollHeight - test.body.clientHeight); await flush();
    expect(test.host.querySelector('.jump-to-latest')).toBeNull();
  });
  it('jumps to the latest message and continues following repeated large updates', async () => {
    const test = await mount(); scroll(test.body, 80); await flush();
    test.host.querySelector('.jump-to-latest').click(); await flush();
    expect(test.body.scrollTop).toBe(test.body.scrollHeight);
    expect(test.host.querySelector('.jump-to-latest')).toBeNull();
    for (let round = 0; round < 3; round++) {
      test.agent.messages.push(...Array.from({ length: 4 }, (_, i) => message(10 + round * 4 + i)));
      await flush(); expect(test.body.scrollTop).toBe(test.body.scrollHeight);
      expect(test.host.querySelector('.jump-to-latest')).toBeNull();
    }
    scroll(test.body, 80); await flush();
    test.agent.messages.push(message(100)); await flush();
    expect(test.body.scrollTop).toBe(80); expect(test.host.querySelector('.jump-to-latest')).not.toBeNull();
  });
  it('starts following again after manually scrolling back to the bottom', async () => {
    const test = await mount(); scroll(test.body, 40); await flush();
    scroll(test.body, test.body.scrollHeight - test.body.clientHeight); await flush();
    test.agent.messages.push(message(4), message(5)); await flush();
    expect(test.body.scrollTop).toBe(test.body.scrollHeight);
    expect(test.host.querySelector('.jump-to-latest')).toBeNull();
  });
  it('does not let a queued update override a new upward scroll', async () => {
    const test = await mount(); scroll(test.body, test.body.scrollHeight - test.body.clientHeight);
    test.agent.messages.push(message(4)); await nextTick(); scroll(test.body, 90);
    await flush(); expect(test.body.scrollTop).toBe(90);
    expect(test.host.querySelector('.jump-to-latest')).not.toBeNull();
  });
  it('restores the arrow with the reading position and follows after clicking it on return', async () => {
    const test = await mount(); scroll(test.body, 110); await flush();
    test.selected.value = 'other'; await flush(); scroll(test.body, 0);
    test.agent.messages.push(message(4)); await flush();
    test.selected.value = 'chat'; await flush();
    expect(test.body.scrollTop).toBe(110);
    test.host.querySelector('.jump-to-latest').click(); await flush();
    test.agent.messages.push(message(5)); await flush();
    expect(test.body.scrollTop).toBe(test.body.scrollHeight);
  });
  it('removes the ordinary progress placeholder while preserving connection controls', async () => {
    const test = await mount((agent) => { agent.streaming = true; });
    expect(test.host.querySelector('.run-status')).toBeNull();
    expect(test.host.textContent).not.toContain('执行思路与进度');
    test.agent.connectionLost = true; await flush();
    expect(test.host.querySelector('.run-status').textContent).toContain('重新连接');
  });
});

it('explicit jump resumes outer following even after reading earlier live thought text', async () => {
  const test = await mount((agent) => { agent.streaming = true; agent.liveSteps = [{ type: 'model_thinking', text: 'thinking' }]; });
  const thought = test.host.querySelector('.thinking-content');
  scroll(thought, 40); scroll(test.body, 100); await flush();
  test.host.querySelector('.jump-to-latest').click(); await flush();
  test.agent.liveSteps.push({ type: 'text', text: 'new output' }); await flush();
  expect(test.body.scrollTop).toBe(test.body.scrollHeight);
  expect(thought.scrollTop).toBe(40);
});
it('upward wheel intent cancels a queued follow before the browser scroll event', async () => {
  const test = await mount(); scroll(test.body, test.body.scrollHeight - test.body.clientHeight);
  const reading = test.body.scrollTop;
  test.agent.messages.push(message(4));
  test.body.dispatchEvent(new WheelEvent('wheel', { deltaY: -40, bubbles: true }));
  await flush(); expect(test.body.scrollTop).toBe(reading);
  expect(test.host.querySelector('.jump-to-latest')).not.toBeNull();
});
