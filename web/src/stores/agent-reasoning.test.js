// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { api, ssePost } from '../api.js';
import { useAgentStore, createProjectAgentStore } from './agent.js';
import { useAuthStore } from './auth.js';
import { useEditorStore } from './editor.js';

const browserSession = vi.hoisted(() => ({ token: '' }));
vi.mock('../api.js', () => ({
  api: { get: vi.fn(), post: vi.fn(), del: vi.fn() }, ssePost: vi.fn(), sseGet: vi.fn(),
  getToken: () => browserSession.token, setToken: token => { browserSession.token = token; }, ApiError: Error,
}));
vi.mock('../lib/collabClient.js', () => ({ detachProjectCollab: vi.fn(), subscribeProjectPresence: () => () => {}, detachAllCollab: vi.fn(), setPresenceListener: vi.fn(), pendingProjectEdits: vi.fn() }));
vi.mock('./ui.js', () => ({ useUiStore: () => ({ error: vi.fn(), toast: vi.fn() }) }));

const projectA = 'project-a';
const projectB = 'project-b';
const savedSelection = (user, project) => JSON.parse(localStorage.getItem(`corelatex.agentProjectPreferences.${user}:${project}`));
let store, auth, settings, pinia;
beforeEach(async () => {
  vi.resetAllMocks();
  localStorage.clear();
  browserSession.token = 'synthetic-token';
  pinia = createPinia();
  setActivePinia(pinia);
  auth = useAuthStore(pinia);
  auth.user = { id: 41 };
  settings = { activeModelId: 'a', models: [
    { id: 'a', name: 'Model A', model: 'same-upstream', enabled: true, hasKey: true, reasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { id: 'b', name: 'Model B', model: 'different', enabled: true, hasKey: true, reasoningLevels: ['max', 'low'] },
    { id: 'old', model: 'legacy', enabled: true, hasKey: true },
    { id: 'disabled-thinking', model: 'plain', enabled: true, hasKey: true, reasoningLevels: [] },
  ] };
  api.get.mockImplementation(async path => path === '/api/settings/ai' ? structuredClone(settings)
    : path.endsWith('/active') ? { run: null } : { chatId: 1, messages: [], files: [], changesets: [] });
  vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
    Object.assign(settings, JSON.parse(options.body));
    return { ok: true, json: async () => ({ ok: true }) };
  }));
  ssePost.mockImplementation(async (_url, _body, emit) => emit({ type: 'done', state: 'completed' }));
  store = useAgentStore(pinia);
  store.setProject(projectA);
  await store.loadSettings();
});
afterEach(() => { store.clearLocal(); vi.unstubAllGlobals(); });

function openInAnotherApp(project) {
  const fresh = createPinia();
  useAuthStore(fresh).user = { id: 41 };
  return createProjectAgentStore(project, fresh);
}

describe('project model and reasoning selection', () => {
  it('keeps ordered reasoning levels and defaults to medium or the first supported level', async () => {
    expect(store.reasoningOptions.map(option => option.value)).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(store.reasoningOptions.map(option => option.label)).toEqual(['低', '中', '高', '极高', '最高']);
    expect(store.activeReasoningEffort).toBe('medium');
    await store.setActiveModel('b');
    expect(store.activeReasoningEffort).toBe('max');
    expect(store.reasoningOptions.map(option => option.value)).toEqual(['max', 'low']);
  });

  it('stores separate model choices and keeps the new account default for new tasks', async () => {
    const b = createProjectAgentStore(projectB, pinia);
    await b.loadSettings();
    await store.setActiveModel('b');
    expect(store.activeModelId).toBe('b');
    expect(b.activeModelId).toBe('a');
    expect(store.settings.activeModelId).toBe('a');
    expect(fetch).not.toHaveBeenCalled();

    await store.saveSettings({ activeModelId: 'old' });
    await b.loadSettings();
    const c = createProjectAgentStore('project-c', pinia);
    await c.loadSettings();
    expect(fetch).toHaveBeenCalledOnce();
    expect([store.activeModelId, b.activeModelId, c.activeModelId]).toEqual(['b', 'a', 'old']);
    expect(savedSelection(41, projectA)).toEqual({ modelId: 'b', reasoning: {} });
    expect(savedSelection(41, projectB)).toEqual({ modelId: 'a', reasoning: {} });
  });

  it('restores each project and its own effort after the browser state is recreated', async () => {
    const b = createProjectAgentStore(projectB, pinia);
    await b.loadSettings();
    store.messages = [{ id: 7, content: 'keep this conversation' }];
    const switchModel = vi.spyOn(store, 'setActiveModel');
    store.setReasoningEffort('max');
    b.setReasoningEffort('high');
    expect(store.activeModelId).toBe('a');
    expect(store.activeReasoningEffort).toBe('max');
    expect(b.activeReasoningEffort).toBe('high');
    expect(switchModel).not.toHaveBeenCalled();
    expect(store.messages).toEqual([{ id: 7, content: 'keep this conversation' }]);

    await store.setActiveModel('b');
    store.setReasoningEffort('low');
    const reopenedA = openInAnotherApp(projectA), reopenedB = openInAnotherApp(projectB);
    await Promise.all([reopenedA.loadSettings(), reopenedB.loadSettings()]);
    expect([reopenedA.activeModelId, reopenedA.activeReasoningEffort]).toEqual(['b', 'low']);
    expect([reopenedB.activeModelId, reopenedB.activeReasoningEffort]).toEqual(['a', 'high']);
    await reopenedA.setActiveModel('a');
    expect(reopenedA.activeReasoningEffort).toBe('max');
    expect(savedSelection(41, projectA).reasoning).toEqual({ a: 'max', b: 'low' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('uses the project preference when an existing store rebinds and clears its history', async () => {
    await store.setActiveModel('b');
    store.setReasoningEffort('low');
    store.setProject(projectB);
    expect(store.activeModelId).toBe('a');
    store.setReasoningEffort('high');
    store.setProject(projectA);
    expect([store.activeModelId, store.activeReasoningEffort]).toEqual(['b', 'low']);

    useEditorStore(pinia).projectId = projectA;
    store.messages = [{ id: 7, content: 'clear this conversation' }];
    await store.resetChat();
    expect(store.messages).toEqual([]);
    expect([store.activeModelId, store.activeReasoningEffort]).toEqual(['b', 'low']);
  });

  it('seeds a new project from older saved levels once and never updates the old shared preference', async () => {
    localStorage.setItem('corelatex.agentReasoning.41', JSON.stringify({ a: 'high', b: 'unsupported', deleted: 'low' }));
    const b = createProjectAgentStore(projectB, pinia);
    await b.loadSettings();
    expect(b.activeReasoningEffort).toBe('high');
    expect(savedSelection(41, projectB).reasoning).toEqual({ a: 'high' });

    localStorage.setItem('corelatex.agentReasoning.41', JSON.stringify({ a: 'max' }));
    await b.loadSettings();
    expect(b.activeReasoningEffort).toBe('high');
    b.setReasoningEffort('low');
    expect(JSON.parse(localStorage.getItem('corelatex.agentReasoning.41'))).toEqual({ a: 'max' });
  });

  it.each(['chat', 'selection'])('freezes the selected model and effort for an active %s request', async kind => {
    store.setReasoningEffort('xhigh');
    let release;
    ssePost.mockImplementation((_url, _body, emit) => new Promise(resolve => {
      release = () => { emit({ type: 'done', state: 'completed' }); resolve(); };
    }));
    const pending = kind === 'chat' ? store.sendMessage(projectA, 'explain')
      : store.runSelectionAction(projectA, 'explain', { file: 'main.tex', start: 1, end: 9, selectionText: 'selected' });
    const body = ssePost.mock.calls[0][1];
    expect(body).toMatchObject({ modelId: 'a', reasoningEffort: 'xhigh' });
    expect(body).not.toHaveProperty('reasoningLevels');
    expect(store.setReasoningEffort('low')).toBe(false);
    expect(await store.setActiveModel('b')).toBe(false);

    settings.activeModelId = 'b';
    const b = createProjectAgentStore(projectB, pinia);
    await Promise.all([b.loadSettings(), store.loadSettings()]);
    b.setReasoningEffort('low');
    expect([b.activeModelId, b.activeReasoningEffort]).toEqual(['b', 'low']);
    expect([store.activeModelId, store.activeReasoningEffort]).toEqual(['a', 'xhigh']);
    expect(body).toMatchObject({ modelId: 'a', reasoningEffort: 'xhigh' });
    release();
    await pending;
  });

  it.each([{ enabled: false }, { hasKey: false }, null])('falls back to a usable model when the selected model becomes unavailable (%j)', async change => {
    store.setReasoningEffort('max');
    await store.setActiveModel('b');
    store.setReasoningEffort('low');
    settings.activeModelId = 'b';
    if (change) Object.assign(settings.models[1], change);
    else settings.models = settings.models.filter(model => model.id !== 'b');
    settings.models[0].reasoningLevels = ['low', 'high'];

    await store.loadSettings();
    expect(store.activeModelId).toBe('a');
    expect(store.activeReasoningEffort).toBe('low');
    expect(store.modelOptions.map(model => model.id)).toEqual(['a', 'old', 'disabled-thinking']);
    expect(savedSelection(41, projectA)).toEqual({ modelId: 'a', reasoning: change ? { b: 'low' } : {} });
    await expect(store.setActiveModel('b')).rejects.toThrow('不可用');
    expect(() => store.setReasoningEffort('max')).toThrow('不支持');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('isolates accounts sharing the same project and restores preferences after returning', async () => {
    await store.setActiveModel('b');
    store.setReasoningEffort('low');
    auth.logout();
    expect(store.activeModelId).toBe('');
    browserSession.token = auth.token = 'other-token';
    auth.user = { id: 42 };
    await store.loadSettings();
    expect([store.activeModelId, store.activeReasoningEffort]).toEqual(['a', 'medium']);
    store.setReasoningEffort('high');
    expect(savedSelection(42, projectA)).toEqual({ modelId: 'a', reasoning: { a: 'high' } });

    browserSession.token = auth.token = 'new-first-account-token';
    auth.user = { id: 41 };
    await store.loadSettings();
    expect([store.activeModelId, store.activeReasoningEffort]).toEqual(['b', 'low']);
    expect(Object.keys(localStorage).join(' ')).not.toContain('token');
  });

  it('drops late settings from a previous account without altering the current task', async () => {
    const response = Promise.withResolvers();
    api.get.mockReturnValueOnce(response.promise);
    const stale = store.loadSettings();
    auth.user = { id: 42 };
    await store.loadSettings();
    store.setReasoningEffort('max');
    const currentSettings = store.settings;
    response.resolve({ activeModelId: 'foreign', models: [{ id: 'foreign', model: 'Other account model' }] });
    await stale;
    expect(store.settings).toBe(currentSettings);
    expect([store.activeModelId, store.activeReasoningEffort]).toEqual(['a', 'max']);
    expect(savedSelection(42, projectA)).toEqual({ modelId: 'a', reasoning: { a: 'max' } });
  });

  it('rejects settings, project selection and agent requests when the browser token changes in another tab', async () => {
    store.activeChatId = 5;
    store.messages = [{ content: 'keep local chat' }];
    const response = Promise.withResolvers();
    api.get.mockReturnValueOnce(response.promise);
    const stale = store.loadSettings();
    const preference = savedSelection(41, projectA);
    const currentSettings = store.settings;
    browserSession.token = 'other-browser-tab-token';

    await expect(store.loadSettings()).rejects.toThrow('登录状态');
    await expect(store.setActiveModel('b')).rejects.toThrow('登录状态');
    expect(() => store.setReasoningEffort('low')).toThrow('登录状态');
    expect(await store.sendMessage(projectA, 'do not send')).toBe(false);
    expect(await store.runSelectionAction(projectA, 'explain')).toBe(false);
    expect(await store.compactContext()).toBe(false);
    await store.loadChat(projectA);
    await expect(store.restoreActiveRun(projectA, { strictRestore: true })).rejects.toThrow('登录状态');
    response.resolve({ activeModelId: 'foreign', models: [] });
    await stale;
    expect(api.get).toHaveBeenCalledTimes(2); // The setup and the GET already in flight.
    expect(api.post).not.toHaveBeenCalled();
    expect(ssePost).not.toHaveBeenCalled();
    expect(store.settings).toBe(currentSettings);
    expect(savedSelection(41, projectA)).toEqual(preference);
  });

  it('loads the saved model before a selection action from a freshly opened project', async () => {
    await store.setActiveModel('b');
    store.setReasoningEffort('low');
    const reopened = openInAnotherApp(projectA);
    const response = Promise.withResolvers();
    api.get.mockReturnValueOnce(response.promise);
    const pending = reopened.runSelectionAction(projectA, 'explain', { file: 'main.tex', start: 0, end: 4 });
    expect(ssePost).not.toHaveBeenCalled();
    expect(await reopened.sendMessage(projectA, 'second launch')).toBe(false);

    settings.activeModelId = 'old';
    response.resolve(structuredClone(settings));
    expect(await pending).toBe(true);
    expect(ssePost).toHaveBeenCalledOnce();
    expect(ssePost.mock.calls[0][0]).toBe('/api/projects/project-a/agent/selection-action');
    expect(ssePost.mock.calls[0][1]).toMatchObject({ modelId: 'b', reasoningEffort: 'low' });
  });

  it.each(['project', 'account'])('does not dispatch a pending run after its %s changes during settings load', async boundary => {
    const fresh = openInAnotherApp(projectA);
    const response = Promise.withResolvers();
    api.get.mockReturnValueOnce(response.promise);
    const pending = fresh.sendMessage(projectA, 'stale launch');
    if (boundary === 'project') fresh.setProject(projectB);
    else browserSession.token = 'new-browser-token';
    response.resolve(structuredClone(settings));

    expect(await pending).toBe(false);
    expect(ssePost).not.toHaveBeenCalled();
    expect(fresh.messages).toEqual([]);
  });

  it.each(['old', 'disabled-thinking'])('omits reasoning for a model with no configured levels (%s)', async id => {
    await store.setActiveModel(id);
    expect(store.reasoningOptions).toEqual([]);
    expect(store.activeReasoningEffort).toBe('');
    await store.sendMessage(projectA, 'hello');
    await store.runSelectionAction(projectA, 'explain', { file: 'main.tex', start: 0, end: 1 });
    for (const [, body] of ssePost.mock.calls) {
      expect(body.modelId).toBe(id);
      expect(body).not.toHaveProperty('reasoningEffort');
    }
  });

  it('accepts custom levels and refuses to change them during a reset', () => {
    store.settings.models[0].reasoningLevels = ['max', 'vendor.custom'];
    store.setReasoningEffort('vendor.custom');
    expect(store.activeReasoningEffort).toBe('vendor.custom');
    expect(store.reasoningOptions.at(-1).label).toBe('vendor.custom');
    store.resetting = true;
    expect(store.setReasoningEffort('max')).toBe(false);
    expect(store.activeReasoningEffort).toBe('vendor.custom');
  });
});
