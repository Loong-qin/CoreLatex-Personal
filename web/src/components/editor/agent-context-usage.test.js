// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createApp, h, nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { createRouter, createMemoryHistory } from 'vue-router';
import AgentPanel from './AgentPanel.vue';
import { api, ssePost } from '../../api.js';
import { useAgentStore } from '../../stores/agent.js';
import { useAuthStore } from '../../stores/auth.js';
import { useEditorStore } from '../../stores/editor.js';

const ui = vi.hoisted(() => ({ error: vi.fn(), toast: vi.fn(), confirm: vi.fn() }));
vi.mock('../../api.js', () => ({
  api: { get: vi.fn(), post: vi.fn(), del: vi.fn() },
  getToken: () => 'session', sseGet: vi.fn(), ssePost: vi.fn(), ApiError: Error,
}));
vi.mock('../../stores/ui.js', () => ({ useUiStore: () => ui }));
vi.mock('../../lib/collabClient.js', () => ({
  detachAllCollab: vi.fn(), detachProjectCollab: vi.fn(), subscribeProjectPresence: () => () => {}, setPresenceListener: vi.fn(),
}));

const usage = { modelId: 'model-a', modelKey: 'key-a', usedTokens: 7600, maxTokens: 10000, estimated: false, updatedAt: 100, basis: 'request' };
const otherUsage = { modelId: 'model-b', modelKey: 'key-b', usedTokens: 3000, maxTokens: 12000, estimated: true, updatedAt: 200, basis: 'history' };
const messages = [{ id: 1, role: 'user', content: '继续编辑' }, { id: 2, role: 'assistant', content: '已完成' }];
const settings = () => ({ activeModelId: 'model-a', models: [
  { id: 'model-a', model: 'A', hasKey: true, contextLength: 10000, contextModelKey: 'key-a' },
  { id: 'model-b', model: 'B', hasKey: true, contextLength: 12000, contextModelKey: 'key-b' },
] });

let app, el;
const trigger = () => el.querySelector('.context-trigger');
const popover = () => document.querySelector('.agent-context-popover[aria-hidden="false"]');

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  api.get.mockImplementation(async path => path === '/api/settings/ai' ? settings()
    : path.endsWith('/runs/active') ? { run: null }
      : { chatId: 5, messages, contextUsage: usage });
});

afterEach(() => { app?.unmount(); el?.remove(); app = el = null; vi.unstubAllGlobals(); });

async function mount({ accountReady = true } = {}) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const auth = useAuthStore(pinia);
  if (accountReady) auth.user = { id: 76 };
  const editor = useEditorStore();
  editor.projectId = 'project-a';
  editor.sidebar = 'agent';
  const agent = useAgentStore();
  el = document.createElement('div');
  document.body.appendChild(el);
  app = createApp(AgentPanel);
  app.use(pinia);
  app.use(createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { render: () => null } }] }));
  app.component('el-input', {
    props: ['modelValue'], emits: ['update:modelValue'],
    render() { return h('textarea', { value: this.modelValue, onInput: event => this.$emit('update:modelValue', event.target.value) }); },
  });
  app.component('el-button', { props: ['disabled'], render() { return h('button', { disabled: this.disabled }, this.$slots.default?.()); } });
  app.component('el-select', {
    props: ['disabled', 'modelValue'], emits: ['update:modelValue'],
    render() { return h('select', { disabled: this.disabled, value: this.modelValue,
      onChange: event => this.$emit('update:modelValue', event.target.value) }, this.$slots.default?.()); },
  });
  app.component('el-option', { props: ['value', 'label'], render() { return h('option', { value: this.value }, this.label); } });
  app.component('el-icon', { render() { return h('span', this.$slots.default?.()); } });
  app.mount(el);
  await vi.waitFor(() => expect(agent.activeChatId).toBe(5));
  await nextTick();
  return { agent, auth, editor };
}

async function openPopover() {
  trigger().click();
  await vi.waitFor(() => expect(popover()).toBeTruthy());
  return popover();
}

function pickModel(id) {
  const select = el.querySelector('.model-select');
  select.value = id;
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

it('opens a single overall reading from the composer and dismisses it with Escape', async () => {
  await mount();
  expect(trigger().textContent.trim()).toBe('76%');
  trigger().focus();
  trigger().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
  await vi.waitFor(() => expect(popover()?.contains(document.activeElement)).toBe(true));
  expect(popover().getAttribute('aria-label')).toBe('上下文窗口');
  expect(popover().querySelectorAll('[role="meter"]')).toHaveLength(1);
  expect(popover().querySelector('[role="meter"]').getAttribute('aria-valuenow')).toBe('76');
  expect(popover().textContent).toContain('读数来自模型服务');
  expect(popover().textContent).not.toContain('7600');
  document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await vi.waitFor(() => expect(trigger().getAttribute('aria-expanded')).toBe('false'));
  expect(document.activeElement).toBe(trigger());
});

it('keeps the chat intact and displays the fresh estimate after manual compression', async () => {
  const { agent } = await mount();
  const request = Promise.withResolvers();
  api.post.mockReturnValue(request.promise);
  const button = (await openPopover()).querySelector('.context-compact');
  button.click();
  await nextTick();
  expect(api.post).toHaveBeenCalledOnce();
  expect(api.post).toHaveBeenCalledWith('/api/projects/project-a/agent/context/compact', { modelId: 'model-a' });
  expect(button.disabled).toBe(true);
  expect(button.textContent.trim()).toBe('正在压缩…');
  expect(el.querySelector('.reset-chat').disabled).toBe(true);
  expect(el.querySelector('.model-select').disabled).toBe(true);
  expect(await agent.sendMessage('project-a', 'later')).toBe(false);
  expect(await agent.compactContext()).toBe(false);
  expect(ssePost).not.toHaveBeenCalled();
  request.resolve({ compressed: true, contextUsage: { ...usage, estimated: true, usedTokens: 3100, updatedAt: 200 } });
  await vi.waitFor(() => expect(trigger().textContent.trim()).toBe('≈31%'));
  expect(popover().querySelector('[role="meter"]').getAttribute('aria-valuetext')).toBe('约 31%');
  expect(button.disabled).toBe(false);
  expect(agent.messages.map(message => message.content)).toEqual(messages.map(message => message.content));
});

it('matches snapshots to the model and ignores older replay events while a run is active', async () => {
  const { agent } = await mount();
  await agent.setActiveModel('model-b');
  await nextTick();
  expect(trigger().textContent.trim()).toBe('—');
  const pop = await openPopover();
  expect(pop.textContent).toContain('暂无占用数据');
  expect(pop.querySelector('[role="meter"]')).toBeNull();

  const stream = agent._beginStream();
  agent._onEvent({ type: 'context_usage', seq: 1, contextUsage: { ...usage, updatedAt: 50, usedTokens: 7000 } }, stream);
  expect(agent.contextUsage.usedTokens).toBe(7600);
  agent._onEvent({ type: 'context_usage', seq: 2, contextUsage: { ...otherUsage, estimated: false, basis: 'request', usedTokens: 9000 } }, stream);
  await nextTick();
  expect(trigger().textContent.trim()).toBe('75%');
  expect(pop.querySelector('.context-compact').disabled).toBe(true);
});

it('restores a completed conversation with a reading for the selected model', async () => {
  api.get.mockImplementation(async path => {
    if (path === '/api/settings/ai') return { ...settings(), activeModelId: 'model-b' };
    if (path.endsWith('/runs/active')) return { run: null };
    return { chatId: 5, messages, contextUsage: path.includes('modelId=model-b') ? otherUsage : usage };
  });
  await mount();
  expect(api.get).toHaveBeenCalledWith('/api/projects/project-a/chat?modelId=model-b', undefined);
  expect(trigger().textContent.trim()).toBe('≈25%');
  expect((await openPopover()).textContent).toContain('按下一轮可沿用的对话');
});

it('refreshes for the saved task model when account restoration finishes after history', async () => {
  localStorage.setItem('corelatex.agentProjectPreferences.76:project-a', JSON.stringify({ modelId: 'model-b', reasoning: {} }));
  const defaultGet = api.get.getMockImplementation();
  api.get.mockImplementation(async (path, options) => path.includes('/agent/context?modelId=model-b')
    ? { chatId: 5, contextUsage: otherUsage } : defaultGet(path, options));
  const { auth } = await mount({ accountReady: false });
  expect(trigger().textContent.trim()).toBe('76%');
  auth.user = { id: 76 };
  await vi.waitFor(() => expect(trigger().textContent.trim()).toBe('≈25%'));
  expect(el.querySelector('.model-select').value).toBe('model-b');
  expect(api.get).toHaveBeenCalledWith('/api/projects/project-a/agent/context?modelId=model-b', { cache: 'no-store' });
});

it('pins the task model once the account becomes known after settings loaded', async () => {
  const { agent, auth } = await mount({ accountReady: false });
  const key = 'corelatex.agentProjectPreferences.76:project-a';
  expect(localStorage.getItem(key)).toBeNull();
  auth.user = { id: 76 };
  expect(JSON.parse(localStorage.getItem(key)).modelId).toBe('model-a');

  api.get.mockResolvedValueOnce({ ...settings(), activeModelId: 'model-b' });
  await agent.loadSettings();
  expect(agent.activeModelId).toBe('model-a');
});

it('requests a reading through the model picker and discards an earlier selection response', async () => {
  const first = Promise.withResolvers();
  let requestsForB = 0;
  api.get.mockImplementation(async path => {
    if (path === '/api/settings/ai') return settings();
    if (path === '/api/projects/project-a/agent/context?modelId=model-b') {
      return ++requestsForB === 1 ? first.promise : { chatId: 5, contextUsage: otherUsage };
    }
    if (path === '/api/projects/project-a/agent/context?modelId=model-a') return { chatId: 5, contextUsage: usage };
    if (path.endsWith('/runs/active')) return { run: null };
    return { chatId: 5, messages, contextUsage: usage };
  });
  const { agent } = await mount();
  pickModel('model-b');
  await vi.waitFor(() => expect(requestsForB).toBe(1));
  pickModel('model-a');
  await vi.waitFor(() => expect(trigger().textContent.trim()).toBe('76%'));
  first.resolve({ chatId: 5, contextUsage: otherUsage });
  await vi.waitFor(() => expect(agent.currentContextUsage.modelId).toBe('model-a'));
  expect(trigger().textContent.trim()).toBe('76%');

  pickModel('model-b');
  await vi.waitFor(() => expect(trigger().textContent.trim()).toBe('≈25%'));
  expect(agent.messages.map(message => message.content)).toEqual(messages.map(message => message.content));
  expect(ssePost).not.toHaveBeenCalled();
});

it('keeps a model picked from the panel when an older settings refresh finishes late', async () => {
  const { agent, editor } = await mount();
  const stale = Promise.withResolvers();
  const defaultGet = api.get.getMockImplementation();
  let hold = true;
  api.get.mockImplementation(async (path, options) => {
    if (path === '/api/settings/ai') {
      if (hold) { hold = false; return stale.promise; }
      return settings();
    }
    if (path.includes('/agent/context?modelId=model-b')) return { chatId: 5, contextUsage: otherUsage };
    return defaultGet(path, options);
  });
  const refresh = vi.spyOn(agent, 'loadSettings');
  const select = vi.spyOn(agent, 'setActiveModel');
  editor.sidebar = 'tree';
  await nextTick();
  editor.sidebar = 'agent';
  await nextTick();
  const reopening = refresh.mock.results[0].value;

  pickModel('model-b');
  await agent.loadSettings({ syncSound: false });
  expect(agent.activeModelId).toBe('model-b');
  await select.mock.results[0].value;
  stale.resolve({ ...settings(), models: [settings().models[0]] });
  await reopening;
  await nextTick();
  expect(agent.settings.activeModelId).toBe('model-a');
  expect(el.querySelector('.model-select').value).toBe('model-b');
  expect(trigger().textContent.trim()).toBe('≈25%');
});

it('discards an earlier settings response once a newer one has been applied', async () => {
  const { agent } = await mount();
  const stale = Promise.withResolvers();
  api.get.mockReturnValueOnce(stale.promise).mockResolvedValueOnce({ ...settings(), activeModelId: 'model-b' });
  const loading = agent.loadSettings();
  await agent.loadSettings();
  stale.resolve(settings());
  await loading;
  expect(agent.settings.activeModelId).toBe('model-b');
  expect(agent.activeModelId).toBe('model-a');
});

it.each([null, { ...usage, estimated: true, usedTokens: 7000, updatedAt: 120 }])(
  'keeps a newer provider measurement across a settled history load (%j)', async contextUsage => {
    const { agent } = await mount();
    const history = Promise.withResolvers();
    const defaultGet = api.get.getMockImplementation();
    api.get.mockImplementation((path, options) => path === '/api/projects/project-a/chat?modelId=model-a'
      ? history.promise : defaultGet(path, options));
    const stream = agent._beginStream();
    agent._onEvent({ type: 'context_usage', chatId: 5, seq: 1, contextUsage: { ...usage, usedTokens: 8300, updatedAt: 180 } }, stream);
    agent._onEvent({ type: 'done', state: 'completed', seq: 2 }, stream);
    history.resolve({ chatId: 5, messages: [...messages, { id: 3, role: 'assistant', content: '新结果' }], contextUsage });
    await vi.waitFor(() => expect(agent.messages.at(-1)?.content).toBe('新结果'));
    expect(trigger().textContent.trim()).toBe('83%');
  },
);

it('hides an old provider identity while refreshing the same model entry', async () => {
  const { agent } = await mount();
  const pending = Promise.withResolvers();
  const nextSettings = settings();
  nextSettings.models[0].contextModelKey = 'new-key-a';
  api.get.mockResolvedValueOnce(nextSettings).mockReturnValueOnce(pending.promise);
  await agent.loadSettings();
  await nextTick();
  expect(trigger().textContent.trim()).toBe('—');
  expect(api.get).toHaveBeenLastCalledWith('/api/projects/project-a/agent/context?modelId=model-a', { cache: 'no-store' });
  pending.resolve({ chatId: 5, contextUsage: { ...usage, modelKey: 'new-key-a', estimated: true, basis: 'history', usedTokens: 2000 } });
  await vi.waitFor(() => expect(trigger().textContent.trim()).toBe('≈20%'));
});

it('ignores a late context response after switching to a different project', async () => {
  const { agent, editor } = await mount();
  const pending = Promise.withResolvers();
  const defaultGet = api.get.getMockImplementation();
  api.get.mockImplementation((path, options) => {
    if (path === '/api/projects/project-a/agent/context?modelId=model-a') return pending.promise;
    if (path === '/api/projects/project-b/chat?modelId=model-a') {
      return Promise.resolve({ chatId: 6, messages, contextUsage: { ...usage, usedTokens: 3900 } });
    }
    return defaultGet(path, options);
  });
  const refreshing = agent.refreshContextUsage();
  editor.projectId = 'project-b';
  await vi.waitFor(() => expect(agent.activeChatId).toBe(6));
  pending.resolve({ chatId: 5, contextUsage: { ...usage, usedTokens: 9800, updatedAt: 200 } });
  await refreshing;
  expect(trigger().textContent.trim()).toBe('39%');
});

it('clears the old reading when the same chat is emptied by another window', async () => {
  const { agent } = await mount();
  api.get.mockResolvedValueOnce({ chatId: 5, messages: [], contextUsage: null });
  await agent.loadChat('project-a', { restoreRun: false });
  expect(agent.currentContextUsage).toBeNull();
  await nextTick();
  expect(trigger().textContent.trim()).toBe('—');
});

it('clears the old reading when a model switch discovers an empty chat', async () => {
  const { agent } = await mount();
  const defaultGet = api.get.getMockImplementation();
  api.get.mockImplementation(async (path, options) => {
    if (path.includes('/agent/context?')) return { chatId: 5, contextUsage: null };
    return defaultGet(path, options);
  });
  const select = vi.spyOn(agent, 'setActiveModel');
  pickModel('model-b');
  await select.mock.results[0].value;
  expect(agent.contextUsage).toBeNull();
  pickModel('model-a');
  await select.mock.results[1].value;
  await nextTick();
  expect(trigger().textContent.trim()).toBe('—');
});

it('ignores a delayed empty context response after a new stream reports usage', async () => {
  const { agent } = await mount();
  const stale = Promise.withResolvers();
  api.get.mockReturnValueOnce(stale.promise);
  const refreshing = agent.refreshContextUsage();
  const stream = agent._beginStream();
  agent._onEvent({ type: 'context_usage', chatId: 5, seq: 1,
    contextUsage: { ...usage, usedTokens: 8500, updatedAt: 200 } }, stream);
  stale.resolve({ chatId: 5, contextUsage: null });
  await refreshing;
  await nextTick();
  expect(trigger().textContent.trim()).toBe('85%');
  agent.clearLocal();
});

it('discards compression results from a closed and reopened chat', async () => {
  const { agent } = await mount();
  const request = Promise.withResolvers();
  api.post.mockReturnValueOnce(request.promise);
  const compacting = agent.compactContext();
  agent.clearLocal();
  await agent.loadChat('project-a', { restoreRun: false });
  request.resolve({ compressed: true, contextUsage: { ...usage, usedTokens: 3100, updatedAt: 200 } });
  expect(await compacting).toBe(false);
  expect(agent.contextUsage.usedTokens).toBe(7600);
  expect(agent.compacting).toBe(false);
  expect(ui.toast).not.toHaveBeenCalled();
});
