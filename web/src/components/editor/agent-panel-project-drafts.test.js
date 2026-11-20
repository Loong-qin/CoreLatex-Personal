// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, h, nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { createRouter, createMemoryHistory } from 'vue-router';
import AgentPanel from './AgentPanel.vue';
import { useAgentStore } from '../../stores/agent.js';
import { useEditorStore } from '../../stores/editor.js';
import { useAuthStore } from '../../stores/auth.js';
import { composerDrafts } from '../../lib/agentComposerDrafts.js';
const ui = vi.hoisted(() => ({ error: vi.fn(), toast: vi.fn(), confirm: vi.fn() }));
vi.mock('../../stores/ui.js', () => ({ useUiStore: () => ui }));
vi.mock('../../lib/collabClient.js', () => ({ detachProjectCollab: vi.fn(), subscribeProjectPresence: () => () => {}, detachAllCollab: vi.fn(), setPresenceListener: vi.fn() }));
const mounts = [];
const flush = async () => { for (let i = 0; i < 3; i++) { await Promise.resolve(); await nextTick(); } };
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
async function mount(prepare, existingPinia) {
  const el = document.createElement('div'); document.body.appendChild(el);
  const pinia = existingPinia || createPinia(); setActivePinia(pinia);
  const agent = useAgentStore(), editor = useEditorStore(), auth = useAuthStore();
  auth.user = { id: 9876 }; editor.projectId = 'draft-project-a';
  agent.loadSettings = async () => { agent.settings = { hasKey: true, model: 'test' }; };
  agent.loadChat = vi.fn(async () => {});
  if (prepare) prepare({ agent, editor, auth });
  const app = createApp(AgentPanel); app.use(pinia);
  app.use(createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { render: () => null } }] }));
  app.component('el-input', { props: ['modelValue', 'disabled'], emits: ['update:modelValue'], render() { return h('textarea', { value: this.modelValue, disabled: this.disabled, onInput: (e) => this.$emit('update:modelValue', e.target.value) }); } });
  app.component('el-button', { props: ['disabled'], render() { return h('button', { disabled: this.disabled }, this.$slots.default?.()); } });
  for (const name of ['el-select', 'el-option', 'el-icon']) app.component(name, { render() { return h('span', this.$slots.default?.()); } });
  app.mount(el);
  const item = { el, agent, editor, auth, pinia, unmount() { if (this.closed) return; this.closed = true; app.unmount(); el.remove(); } };
  mounts.push(item); await flush(); return item;
}
function type(el, text) { const ta = el.querySelector('textarea'); ta.value = text; ta.dispatchEvent(new Event('input', { bubbles: true })); }
function send(el) { [...el.querySelectorAll('button')].find((button) => button.textContent === '发送').click(); }
function pick(el, files) { const input = el.querySelector('input[type=file]'); Object.defineProperty(input, 'files', { configurable: true, value: files }); input.dispatchEvent(new Event('change', { bubbles: true })); }
beforeEach(() => { vi.clearAllMocks(); sessionStorage.clear(); composerDrafts.clearAccount(9876); composerDrafts.clearAccount(9877); });
afterEach(() => { mounts.splice(0).forEach((item) => item.unmount()); vi.unstubAllGlobals(); composerDrafts.clearAccount(9876); composerDrafts.clearAccount(9877); });
describe('AgentPanel project drafts', () => {
  it('keeps project text and attachment reads separate while another project is active', async () => {
    const readers = []; vi.stubGlobal('FileReader', class { readAsDataURL() { readers.push(this); } });
    const { el, editor, agent } = await mount();
    type(el, 'draft A'); pick(el, [{ name: 'a.png', type: 'image/png', size: 1 }]); await flush();
    editor.projectId = 'draft-project-b'; await flush();
    expect(el.querySelector('textarea').value).toBe(''); expect(el.querySelectorAll('.attach-chip')).toHaveLength(0);
    type(el, 'draft B'); readers[0].result = 'data:image/png;base64,QQ=='; readers[0].onload(); await flush();
    expect(el.querySelector('textarea').value).toBe('draft B');
    editor.projectId = 'draft-project-a'; await flush();
    expect(el.querySelector('textarea').value).toBe('draft A'); expect(el.querySelector('.attach-chip').textContent).toContain('a.png');
    agent.sendMessage = vi.fn(async () => false); send(el); await flush();
    expect(agent.sendMessage).toHaveBeenCalledWith('draft-project-a', 'draft A', expect.objectContaining({ attachments: { images: [{ name: 'a.png', mime: 'image/png', data: 'QQ==' }], files: [] } }));
    expect(el.querySelector('textarea').value).toBe('draft A');
  });
  it('restores a remounted project and completes its original pending reader', async () => {
    const readers = []; vi.stubGlobal('FileReader', class { readAsDataURL() { readers.push(this); } });
    const first = await mount(); type(first.el, 'survive remount'); pick(first.el, [{ name: 'pending.txt', type: 'text/plain', size: 1 }]); await flush(); first.unmount();
    const second = await mount(null, first.pinia);
    expect(second.el.querySelector('textarea').value).toBe('survive remount');
    expect(second.el.querySelector('.attach-chip').textContent).toContain('读取中');
    readers[0].result = 'data:text/plain;base64,QQ=='; readers[0].onload(); await flush();
    expect(second.el.querySelector('.attach-chip').textContent).not.toContain('读取中');
    expect([...second.el.querySelectorAll('button')].find((button) => button.textContent === '发送').disabled).toBe(false);
  });
  it('restores failed sends to their original project without replacing a later draft', async () => {
    const result = deferred();
    const { el, editor, agent } = await mount(); agent.sendMessage = vi.fn(() => result.promise);
    type(el, 'submitted A'); await flush(); send(el); await flush();
    expect(el.querySelector('textarea').value).toBe('');
    editor.projectId = 'draft-project-b'; await flush(); type(el, 'new B');
    result.resolve(false); await flush(); expect(el.querySelector('textarea').value).toBe('new B');
    editor.projectId = 'draft-project-a'; await flush(); expect(el.querySelector('textarea').value).toBe('submitted A');
    const success = deferred(); agent.sendMessage = vi.fn(() => success.promise); send(el); await flush(); type(el, 'follow-up A'); await flush();
    success.resolve(true); await flush(); expect(el.querySelector('textarea').value).toBe('follow-up A');
  });
  it('does not resume chat from a panel unmounted before settings finished loading', async () => {
    const settings = deferred();
    const panel = await mount(({ agent }) => { agent.loadSettings = () => settings.promise; });
    panel.unmount(); settings.resolve({}); await flush();
    expect(panel.agent.loadChat).not.toHaveBeenCalled();
  });
  it('never exposes one account draft to another account', async () => {
    const { el, auth } = await mount(); type(el, 'private draft'); await flush();
    auth.user = { id: 9877 }; await flush(); expect(el.querySelector('textarea').value).toBe('');
    type(el, 'second account'); await flush(); auth.user = { id: 9876 }; await flush();
    expect(el.querySelector('textarea').value).toBe('');
    expect(JSON.stringify(Object.values(sessionStorage))).not.toContain('private draft');
  });
});


it('keeps input and attachments after the real send path receives a maintenance 503', async () => {
  const readers = []; vi.stubGlobal('FileReader', class { readAsDataURL() { readers.push(this); } });
  const { el, agent } = await mount();
  const message = '服务正在维护发布，尚未启动本次任务；请稍后重试。';
  const request = vi.fn(async () => new Response(JSON.stringify({ error: message }), { status: 503, headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', request);
  type(el, 'retry after maintenance'); pick(el, [{ name: 'draft.txt', type: 'text/plain', size: 1 }]);
  readers[0].result = 'data:text/plain;base64,QQ=='; readers[0].onload(); await flush();
  send(el);
  for (let i = 0; i < 8; i++) await flush();
  expect(request).toHaveBeenCalledTimes(1);
  expect(JSON.parse(request.mock.calls[0][1].body)).toMatchObject({ message: 'retry after maintenance', files: [{ name: 'draft.txt', mime: 'text/plain', data: 'QQ==' }] });
  expect(agent.streaming).toBe(false); expect(agent.activeRunId).toBeNull();
  expect(el.querySelector('textarea').value).toBe('retry after maintenance');
  expect(el.querySelector('.attach-chip').textContent).toContain('draft.txt');
  expect(ui.error).toHaveBeenCalledWith(message);
});
