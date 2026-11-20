// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, h, nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { createRouter, createMemoryHistory } from 'vue-router';
import AgentPanel from './AgentPanel.vue';
import { useAgentStore } from '../../stores/agent.js';
const ui = vi.hoisted(() => ({ error: vi.fn(), toast: vi.fn(), confirm: vi.fn() }));
vi.mock('../../stores/ui.js', () => ({ useUiStore: () => ui }));
vi.mock('../../lib/collabClient.js', () => ({ detachProjectCollab: vi.fn(), subscribeProjectPresence: () => () => {}, detachAllCollab: vi.fn(), setPresenceListener: vi.fn() }));
let app, el;
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await nextTick(); };
async function mount(prepare, props = {}) {
  el = document.createElement('div'); document.body.appendChild(el);
  const pinia = createPinia(); setActivePinia(pinia);
  const agent = useAgentStore();
  agent.loadSettings = async () => { agent.settings = { hasKey: true, model: 'test' }; };
  agent.loadChat = vi.fn();
  if (prepare) prepare(agent);
  app = createApp(AgentPanel, props); app.use(pinia); app.use(createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { render: () => null } }] }));
  app.component('el-input', { props: ['modelValue', 'disabled'], emits: ['update:modelValue'], render() { return h('textarea', { value: this.modelValue, disabled: this.disabled, onInput: e => this.$emit('update:modelValue', e.target.value) }); } });
  app.component('el-button', { props: ['disabled'], render() { return h('button', { disabled: this.disabled }, this.$slots.default?.()); } });
  for (const name of ['el-select', 'el-option', 'el-icon']) app.component(name, { render() { return h('span', this.$slots.default?.()); } });
  app.mount(el); await flush(); return agent;
}
function type(text) { const ta = el.querySelector('textarea'); ta.value = text; ta.dispatchEvent(new Event('input', { bubbles: true })); }
beforeEach(() => vi.clearAllMocks());
afterEach(() => { app?.unmount(); el?.remove(); vi.unstubAllGlobals(); });
describe('agent interaction controls', () => {
  it('closes from its own header without resetting or interrupting the conversation', async () => {
    const close = vi.fn();
    const agent = await mount(undefined, { onClose: close });
    agent.resetChat = vi.fn(); agent.cancelStream = vi.fn();
    agent.streaming = true; await flush();
    const button = el.querySelector('[aria-label="关闭左侧面板"]');
    button.focus(); expect(document.activeElement).toBe(button);
    button.click();
    expect(close).toHaveBeenCalledOnce();
    expect(agent.resetChat).not.toHaveBeenCalled();
    expect(agent.cancelStream).not.toHaveBeenCalled();
    expect(el.querySelector('[aria-label="清空会话"]').disabled).toBe(true);
  });
  it('makes clearing explicit and requires confirmation before removing conversation history', async () => {
    const agent = await mount(); agent.resetChat = vi.fn();
    const clear = el.querySelector('[aria-label="清空会话"]');
    ui.confirm.mockResolvedValueOnce(false);
    clear.click(); await flush();
    expect(ui.confirm).toHaveBeenCalledWith(expect.stringContaining('不可恢复'), '清空会话', expect.any(Object));
    expect(agent.resetChat).not.toHaveBeenCalled();
    ui.confirm.mockResolvedValueOnce(true);
    clear.click(); await flush();
    expect(agent.resetChat).toHaveBeenCalledOnce();
  });

  it('keeps draft text when Enter is pressed while resetting', async () => {
    const agent = await mount(); agent.sendMessage = vi.fn(); type('Do not lose this'); await flush();
    agent.resetting = true; await flush();
    el.querySelector('textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await flush();
    expect(el.querySelector('textarea').value).toBe('Do not lose this'); expect(agent.sendMessage).not.toHaveBeenCalled();
  });
  it('reserves attachment slots before FileReader completion and waits until loaded', async () => {
    const readers = [];
    vi.stubGlobal('FileReader', class { readAsDataURL() { readers.push(this); } });
    await mount();
    const input = el.querySelector('input[type=file]');
    Object.defineProperty(input, 'files', { configurable: true, value: Array.from({ length: 13 }, (_, i) => ({ name: `${i}.png`, type: 'image/png', size: 1 })) });
    input.dispatchEvent(new Event('change', { bubbles: true })); await flush();
    expect(readers).toHaveLength(8); expect(el.querySelectorAll('.attach-chip')).toHaveLength(8);
    expect([...el.querySelectorAll('button')].find((b) => b.textContent === '发送').disabled).toBe(true);
    readers.forEach((r) => { r.result = 'data:image/png;base64,QQ=='; r.onload(); }); await flush();
    expect([...el.querySelectorAll('button')].find((b) => b.textContent === '发送').disabled).toBe(false);
  });
  it('renders public progress, question choices and running correction controls', async () => {
    const agent = await mount((a) => {
      a.streaming = true; a.activeRunId = 'r';
      a.liveSteps = [{ type: 'activity', phase: 'planning', text: '检查选区和相关引用' }, { type: 'activity', phase: 'retry', text: '模型服务暂不可用，正在重试 2/5' }];
      a.pendingQuestion = { questionId: 'q', question: '保留哪个版本？', options: ['版本 A', '版本 B'] };
    });
    agent.answerQuestion = vi.fn(async () => true);
    expect(el.textContent).toContain('检查选区和相关引用'); expect(el.textContent).toContain('重试 2/5');
    expect(el.textContent).toContain('需要你的决定');
    [...el.querySelectorAll('button')].find((b) => b.textContent.trim() === '版本 A').click(); await flush();
    expect(agent.answerQuestion).toHaveBeenCalledWith('版本 A');
    agent.pendingQuestion = null; agent.sendInput = vi.fn(async () => false); type('Keep equations'); await flush();
    [...el.querySelectorAll('button')].find((b) => b.textContent === '补充').click(); await flush();
    expect(agent.sendInput).toHaveBeenCalledWith('Keep equations'); expect(el.querySelector('textarea').value).toBe('Keep equations');
  });
  it('keeps full long questions, quick answers, custom replies and stop controls usable in a short panel', async () => {
    const longQuestion = ('核实这一项科研结论，并说明证据、来源和可能的限制。\n\n').repeat(100);
    const agent = await mount((state) => {
      state.streaming = true; state.activeRunId = 'run-long-question';
      state.pendingQuestion = { questionId: 'long', question: longQuestion, options: ['保留原文', '继续核实'] };
    });
    // Layout dimensions are verified in browser QA; this checks the real controls
    // remain mounted, focusable and connected to the original answer/cancel flow.
    el.querySelector('.agent-panel').style.height = '260px';
    agent.answerQuestion = vi.fn(async () => true); agent.cancelStream = vi.fn();
    const body = el.querySelector('.question-body'); expect(body.textContent).toBe(longQuestion);
    expect(el.querySelector('.question-toggle').getAttribute('aria-expanded')).toBe('false');
    body.focus(); expect(document.activeElement).toBe(body);
    el.querySelector('.question-toggle').click(); await flush();
    expect(el.querySelector('.question-toggle').getAttribute('aria-expanded')).toBe('true');
    [...el.querySelectorAll('.question-option')].find((button) => button.textContent === '继续核实').click(); await flush();
    expect(agent.answerQuestion).toHaveBeenCalledWith('继续核实');
    type('我的自定义回答'); await flush();
    const textarea = el.querySelector('textarea'); textarea.focus(); expect(document.activeElement).toBe(textarea);
    [...el.querySelectorAll('button')].find((button) => button.textContent === '回答').click(); await flush();
    expect(agent.answerQuestion).toHaveBeenCalledWith('我的自定义回答'); expect(textarea.value).toBe('');
    const stop = [...el.querySelectorAll('button')].find((button) => button.textContent === '停止');
    stop.focus(); expect(document.activeElement).toBe(stop); stop.click(); expect(agent.cancelStream).toHaveBeenCalledOnce();
  });

});
