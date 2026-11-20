// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, h, nextTick } from 'vue';
import { createPinia } from 'pinia';
import { createRouter, createMemoryHistory } from 'vue-router';
import App from './App.vue';
import { useAuthStore } from './stores/auth.js';
import { useProjectContext } from './lib/projectContext.js';
import { readWorkspaceSession, saveWorkspaceSession } from './lib/workspaceSession.js';
import { api, setToken, sseGet } from './api.js';
const state = vi.hoisted(() => ({ managers: [], summary: null, active: null, runStatus: null, changesets: null }));
vi.mock('./components/ContextMenu.vue', () => ({ default: { template: '<span />' } }));
vi.mock('./lib/collabClient.js', () => ({ detachAllCollab: vi.fn(), detachProjectCollab: vi.fn(), subscribeProjectPresence: vi.fn(() => vi.fn()), setPresenceListener: vi.fn() }));
vi.mock('./lib/projectWorkspaces.js', async original => {
  const module = await original();
  return { ...module, createProjectWorkspaces(...args) { const manager = module.createProjectWorkspaces(...args); state.managers.push(manager); return manager; } };
});
vi.mock('./api.js', async original => {
  const module = await original();
  return { ...module, api: { ...module.api, get: vi.fn(async path => {
    if (path.includes('summary=1')) return state.summary(path);
    if (path.endsWith('/chat')) return { chatId: path, messages: [] };
    if (path.endsWith('/agent/runs/active')) return { run: await state.active(path) };
    if (/\/agent\/runs\/[^/]+$/.test(path)) return { run: await state.runStatus(path) };
    if (path.endsWith('/changesets?status=pending')) return { changesets: await state.changesets(path) };
    throw new Error('Unexpected API: ' + path);
  }) }, sseGet: vi.fn((_path, _emit, { signal }) => new Promise(resolve => {
    if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true });
  })) };
});
const mounted = [];
const flush = async () => { for (let i = 0; i < 10; i++) { await Promise.resolve(); await nextTick(); } };
const project = (publicId, extras = {}) => ({ publicId, name: 'Project ' + publicId, ...extras });
const saved = (ids, activeProjectId = ids.at(-1)) => ({ projects: ids.map(id => project(id)), activeProjectId });
const deferred = () => { let resolve, reject; const promise = new Promise((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; };
beforeEach(() => {
  sessionStorage.clear(); localStorage.clear(); vi.clearAllMocks(); state.managers = [];
  state.summary = path => ({ projects: path.includes('view=archived') ? [] : ['A', 'B', 'C', 'X'].map(id => project(id)) });
  state.active = () => null;
  state.runStatus = () => null;
  state.changesets = () => [];
});
afterEach(() => {
  for (const test of mounted.splice(0)) { test.app.unmount(); test.host.remove(); }
  vi.useRealTimers();
});
async function mount(path = '/project/B', account = 1) {
  setToken('synthetic');
  const pinia = createPinia(), auth = useAuthStore(pinia);
  auth.user = account == null ? null : { id: account };
  const Editor = { setup() { const context = useProjectContext(); context.editor.projectId = context.projectId; context.editor.project = project(context.projectId); return () => h('div', { 'data-project': context.projectId }, context.projectId); } };
  const Other = { render: () => h('div', 'projects') };
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/', name: 'projects', component: Other }, { path: '/project/:id', name: 'editor', component: Editor }, { path: '/login', name: 'login', component: Other },
  ] });
  await router.push(path); await router.isReady();
  const host = document.createElement('div'); document.body.appendChild(host);
  const app = createApp(App); app.use(pinia); app.use(router); app.component('el-icon', { render: () => h('span') }); app.mount(host);
  const test = { app, host, auth, router, manager: state.managers.at(-1) }; mounted.push(test); await flush(); return test;
}
function unmount(test) { test.app.unmount(); test.host.remove(); mounted.splice(mounted.indexOf(test), 1); }
const ids = test => test.manager.sessions.map(session => session.publicId);
const projectTab = (test, id) => test.host.querySelector(`[role="tab"][href="/project/${id}"]`);
const unread = (test, id) => projectTab(test, id)?.querySelector('.project-notification-dot');
const reviewCount = (test, id) => projectTab(test, id)?.querySelector('.project-notification-count [aria-hidden="true"]')?.textContent;
describe('refreshing multiple project workspaces', () => {
  it('waits for the restored account without overwriting saved tabs with the initial route', async () => {
    saveWorkspaceSession(1, saved(['A', 'B', 'C'], 'B'));
    const test = await mount('/project/B', null);
    expect(ids(test)).toEqual(['B']);
    expect(readWorkspaceSession(1).projects.map(project => project.publicId)).toEqual(['A', 'B', 'C']);
    test.auth.user = { id: 1 }; await flush();
    expect(ids(test)).toEqual(['A', 'B', 'C']);
    expect(test.host.querySelector('[data-project]').dataset.project).toBe('B');
  });
  it('restores tabs and checks idle background projects without loading their histories or mounting editors', async () => {
    saveWorkspaceSession(1, saved(['A', 'B', 'C'], 'B'));
    let test = await mount();
    expect(ids(test)).toEqual(['A', 'B', 'C']);
    expect(test.host.querySelector('[data-project]').dataset.project).toBe('B');
    expect(test.manager.sessions.filter(session => session.mounted).map(session => session.publicId)).toEqual(['B']);
    for (const id of ['A', 'C']) {
      expect(api.get).toHaveBeenCalledWith(`/api/projects/${id}/agent/runs/active`, { cache: 'no-store' });
      expect(api.get.mock.calls.some(([path]) => path === `/api/projects/${id}/chat`)).toBe(false);
    }
    expect(api.get.mock.calls.some(([path]) => path === '/api/projects/B/chat')).toBe(false);
    expect(readWorkspaceSession(1).activeProjectId).toBe('B');
    window.dispatchEvent(new Event('pagehide')); unmount(test);
    test = await mount(); expect(ids(test)).toEqual(['A', 'B', 'C']);
    expect(test.host.querySelector('[data-project]').dataset.project).toBe('B');
  });
  it('restores a real background run and its history, while leaving idle projects unloaded', async () => {
    saveWorkspaceSession(1, saved(['A', 'B', 'C'], 'B'));
    state.active = path => path.includes('/A/') ? { id: 'run-a', state: 'running' } : null;
    const test = await mount();
    expect(api.get).toHaveBeenCalledWith('/api/projects/A/chat', { cache: 'no-store' });
    expect(api.get.mock.calls.some(([path]) => path === '/api/projects/C/chat')).toBe(false);
    expect(test.manager.sessions.find(session => session.publicId === 'A').agent.activeRunId).toBe('run-a');
    expect(sseGet).toHaveBeenCalledOnce(); expect(sseGet.mock.calls[0][0]).toContain('/run-a/events');
  });
  it('bounds background probes so the current project is not crowded out by many tabs', async () => {
    const projects = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
    saveWorkspaceSession(1, saved(projects, 'B'));
    state.summary = path => ({ projects: path.includes('view=archived') ? [] : projects.map(id => project(id)) });
    const active = deferred(); state.active = () => active.promise;
    await mount();
    const before = api.get.mock.calls.filter(([path]) => path.endsWith('/agent/runs/active'));
    expect(before).toHaveLength(4);
    active.resolve(null); await flush();
    const after = api.get.mock.calls.filter(([path]) => path.endsWith('/agent/runs/active'));
    expect(after).toHaveLength(6);
    expect(api.get.mock.calls.some(([path]) => path.endsWith('/chat'))).toBe(false);
  });
  it('does not read a closed background project after a slow active-run response', async () => {
    saveWorkspaceSession(1, saved(['A', 'B'], 'B'));
    const active = deferred(); state.active = path => path.includes('/A/') ? active.promise : null;
    const test = await mount(); test.manager.remove('A'); await flush();
    active.resolve({ id: 'stale', state: 'running' }); await flush();
    expect(api.get.mock.calls.some(([path]) => path === '/api/projects/A/chat')).toBe(false);
    expect(sseGet).not.toHaveBeenCalled();
  });
  it('does not mark an opened project as disconnected when its old background probe fails', async () => {
    saveWorkspaceSession(1, saved(['A', 'B'], 'B'));
    const active = deferred(); state.active = path => path.includes('/A/') ? active.promise : null;
    const test = await mount(); await test.router.push('/project/A'); await flush();
    active.reject(new Error('old request failed')); await flush();
    const session = test.manager.sessions.find(item => item.publicId === 'A');
    expect(session.mounted).toBe(true); expect(session.context.error.value).toBe('');
  });
  it('does not resurrect a closed tab on the next refresh', async () => {
    saveWorkspaceSession(1, saved(['A', 'B'])); let test = await mount();
    test.manager.remove('A'); await flush(); expect(readWorkspaceSession(1).projects.map(project => project.publicId)).toEqual(['B']);
    unmount(test); test = await mount(); expect(ids(test)).toEqual(['B']);
  });
  it('saves the mounted editor and preserves remembered files in the background workspace', async () => {
    saveWorkspaceSession(1, saved(['A', 'B']));
    const rememberedFiles = { file: 'draft.tex', openFiles: ['draft.tex'] };
    localStorage.setItem('corelatex.view.A', JSON.stringify(rememberedFiles));
    const test = await mount();
    const [background, current] = test.manager.sessions;
    const saveCurrent = vi.spyOn(current.editor, 'saveViewState');
    window.dispatchEvent(new Event('beforeunload'));
    expect(saveCurrent).toHaveBeenCalledOnce();
    expect(background.editor.restoreViewState()).toEqual(rememberedFiles);
    test.manager.remove('A');
    expect(JSON.parse(localStorage.getItem('corelatex.view.A'))).toEqual(rememberedFiles);
  });
  it('keeps the full saved list when project discovery temporarily fails', async () => {
    saveWorkspaceSession(1, saved(['A', 'B'])); state.summary = () => { throw new Error('offline'); };
    const test = await mount(); expect(ids(test)).toEqual(['A', 'B']);
    expect(readWorkspaceSession(1).projects.map(project => project.publicId)).toEqual(['A', 'B']);
    expect(test.manager.sessions[0].context.error.value).toContain('重试');
    await test.router.push('/'); await flush();
    expect(projectTab(test, 'A').getAttribute('aria-label')).toContain('待重新连接');
    expect(projectTab(test, 'A').querySelector('.state-dot')).toBeNull();
  });
  it('ignores a late recovery after the user closes a tab or logs out', async () => {
    saveWorkspaceSession(1, saved(['A', 'B'])); const waiting = deferred(); state.summary = () => waiting.promise;
    const test = await mount(); test.manager.remove('A'); await flush();
    waiting.resolve({ projects: [project('A'), project('B')] }); await flush();
    expect(ids(test)).toEqual(['B']); expect(api.get.mock.calls.some(([path]) => path === '/api/projects/A/chat')).toBe(false);
    const second = deferred(); state.summary = () => second.promise;
    unmount(test); saveWorkspaceSession(1, saved(['A', 'B'])); const next = await mount();
    next.auth.logout(); await flush(); second.resolve({ projects: [project('A'), project('B')] }); await flush();
    expect(ids(next)).toEqual([]); expect(readWorkspaceSession(1).projects).toEqual([]);
  });
  it('isolates accounts and preserves tabs while refreshing a non-editor page', async () => {
    saveWorkspaceSession(1, saved(['A', 'B'])); saveWorkspaceSession(2, saved(['X']));
    const test = await mount('/'); expect(ids(test)).toEqual(['A', 'B']);
    expect(test.host.querySelectorAll('[role="tab"]')).toHaveLength(2);
    test.auth.user = { id: 2 }; await flush(); expect(ids(test)).toEqual(['X']);
    expect(readWorkspaceSession(1).projects).toEqual([]); expect(readWorkspaceSession(2).projects.map(project => project.publicId)).toEqual(['X']);
  });
  it('removes revoked background projects and keeps archived tabs without restarting tasks', async () => {
    saveWorkspaceSession(1, saved(['A', 'B', 'C']));
    state.summary = path => ({ projects: path.includes('view=archived') ? [project('C', { archived: true })] : [project('B')] });
    const test = await mount(); expect(ids(test)).toEqual(['B', 'C']);
    expect(api.get.mock.calls.some(([path]) => path === '/api/projects/C/chat')).toBe(false);
  });

  it('marks only background completions unread and clears them when the project is visited', async () => {
    saveWorkspaceSession(1, saved(['A', 'B']));
    const test = await mount();
    const [a, b] = test.manager.sessions;
    b.agent.setProject('B');
    const streamA = a.agent._beginStream({ requestId: 'run-a' });
    const streamB = b.agent._beginStream({ requestId: 'run-b' });
    a.agent._onEvent({ type: 'token', seq: 1, text: 'Background result' }, streamA);
    a.agent._onEvent({ type: 'run', runId: 'run-a', seq: 2, state: 'completed' }, streamA);
    b.agent._onEvent({ type: 'done', runId: 'run-b', seq: 1, state: 'completed' }, streamB);
    await test.router.push('/');
    await flush();
    expect(unread(test, 'A')).toBeTruthy();
    expect(unread(test, 'B')).toBeNull();
    await test.router.push('/project/A');
    await test.router.push('/');
    a.agent._onEvent({ type: 'done', runId: 'run-a', seq: 3, state: 'completed' }, streamA);
    await flush();
    expect(unread(test, 'A')).toBeNull();
    expect(readWorkspaceSession(1).projects[0]).toEqual(project('A'));
  });

  it('rechecks a disconnected background run and removes its busy state after confirmed completion', async () => {
    saveWorkspaceSession(1, saved(['A']));
    const test = await mount('/');
    vi.useFakeTimers();
    const [session] = test.manager.sessions;
    const stream = session.agent._beginStream();
    session.agent._onEvent({ type: 'run', state: 'running', runId: 'run-a', seq: 1 }, stream);
    await flush();
    expect(projectTab(test, 'A').querySelector('.state-dot')).toBeTruthy();

    session.agent._onEvent({ type: 'question', runId: 'run-a', seq: 2, questionId: 'q1', question: 'Continue?' }, stream);
    await flush();
    expect(projectTab(test, 'A').querySelector('.state-dot')).toBeNull();
    expect(projectTab(test, 'A').querySelector('.awaiting-answer-dot')).toBeTruthy();

    session.agent.connectionLost = true;
    await flush();
    expect(projectTab(test, 'A').querySelector('.awaiting-answer-dot')).toBeNull();
    expect(projectTab(test, 'A').getAttribute('aria-label')).toContain('待重新连接');

    state.runStatus = () => ({ id: 'run-a', state: 'completed', messageId: 5 });
    await vi.advanceTimersByTimeAsync(15_000); await flush();
    expect(session.agent.streaming).toBe(false);
    expect(projectTab(test, 'A').getAttribute('aria-label')).not.toContain('待重新连接');
    expect(projectTab(test, 'A').querySelector('.state-dot')).toBeNull();
    expect(unread(test, 'A')).toBeTruthy();
    expect(api.get.mock.calls.filter(([path]) => path.endsWith('/agent/runs/run-a'))).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(api.get.mock.calls.filter(([path]) => path.endsWith('/agent/runs/run-a'))).toHaveLength(1);
  });

  it.each(['saved run', 'run that ended while restoring'])('recovers the unread result of a %s without treating history as new on a later refresh', async source => {
    const savedTab = saved(['A', 'B']);
    if (source === 'saved run') savedTab.projects[0].trackedRunId = 'run-a';
    else state.active = vi.fn().mockReturnValueOnce({ id: 'run-a', state: 'running' }).mockReturnValue(null);
    saveWorkspaceSession(1, savedTab);
    let test = await mount();
    expect(sseGet).toHaveBeenCalledOnce();
    const [path, emit] = sseGet.mock.calls[0];
    expect(path).toBe('/api/projects/A/agent/runs/run-a/events?after=0');
    emit({ type: 'token', runId: 'run-a', seq: 1, text: 'Finished during refresh' });
    emit({ type: 'run', runId: 'run-a', seq: 2, state: 'completed' });
    emit({ type: 'done', runId: 'run-a', seq: 3, state: 'completed' });
    await test.router.push('/');
    await flush();
    expect(unread(test, 'A')).toBeTruthy();
    expect(readWorkspaceSession(1).projects[0]).toEqual(project('A', { unreadCompletion: true }));

    unmount(test);
    sseGet.mockClear();
    test = await mount('/');
    expect(unread(test, 'A')).toBeTruthy();
    expect(sseGet).not.toHaveBeenCalled();
    unmount(test);

    test = await mount('/project/A');
    await test.router.push('/');
    await flush();
    expect(unread(test, 'A')).toBeNull();
  });

  it('counts unique pending files across batches and updates after review without an unread dot', async () => {
    const review = (id, paths) => ({ id, status: 'pending', files: paths.map(filePath => ({ filePath, status: 'pending' })) });
    let pending = [
      review(1, ['main.tex', 'Fig/steps-a.pdf', 'Fig/steps-b.pdf']),
      review(2, ['main.tex', 'Fig/steps-c.pdf']),
      review(3, ['Fig/budget-a.pdf']),
      review(4, ['Fig/budget-b.pdf']),
      review(5, ['Fig/budget-c.pdf', 'main.tex']),
    ];
    state.changesets = path => path.includes('/A/') ? structuredClone(pending) : [];
    saveWorkspaceSession(1, saved(['A', 'B']));
    const test = await mount('/');
    const [a] = test.manager.sessions;
    expect(reviewCount(test, 'A')).toBe('7');
    expect(reviewCount(test, 'B')).toBeUndefined();
    expect(projectTab(test, 'A').getAttribute('aria-label')).toContain('7 个待审阅文件');
    pending[0].files[0].status = 'accepted';
    pending[0].files[1].status = 'accepted';
    await a.editor.loadPendingChangesets();
    await flush();
    expect(reviewCount(test, 'A')).toBe('6');
    pending = [review(2, ['main.tex']), review(5, ['main.tex'])];
    await a.editor.loadPendingChangesets();
    await flush();
    expect(reviewCount(test, 'A')).toBe('1');
    pending = [
      { ...review(2, ['main.tex']), files: [{ filePath: 'main.tex', status: 'accepted' }] },
      { ...review(5, ['main.tex']), files: [{ filePath: 'main.tex', status: 'reverted' }] },
      review(6, []),
    ];
    await a.editor.loadPendingChangesets();
    await flush();
    expect(reviewCount(test, 'A')).toBeUndefined();
    pending = [];
    const stream = a.agent._beginStream({ requestId: 'run-a' });
    a.agent._onEvent({ type: 'changeset', runId: 'run-a', seq: 1, changeset: review(5, ['main.tex']) }, stream);
    a.agent._onEvent({ type: 'run', runId: 'run-a', seq: 2, state: 'completed' }, stream);
    await flush();
    expect(reviewCount(test, 'A')).toBeUndefined();
    expect(unread(test, 'A')).toBeNull();
  });

  it('drops a saved run that was never registered without leaving the project busy or unread', async () => {
    const savedTab = saved(['A', 'B']);
    savedTab.projects[0].trackedRunId = 'missing';
    saveWorkspaceSession(1, savedTab);
    sseGet.mockRejectedValueOnce(Object.assign(new Error('missing run'), { status: 404 }));
    const test = await mount('/');
    await flush();
    expect(projectTab(test, 'A').getAttribute('aria-label')).toBe('Project A');
    expect(readWorkspaceSession(1).projects[0]).toEqual(project('A'));
  });

  it('does not create a dot when a recovered run already belongs to the visible project', async () => {
    const savedTab = saved(['A', 'B']);
    savedTab.projects[1].trackedRunId = 'run-b';
    saveWorkspaceSession(1, savedTab);
    const test = await mount();
    const current = test.manager.sessions[1];
    await current.agent.restoreActiveRun('B');
    const [, emit] = sseGet.mock.calls[0];
    emit({ type: 'run', runId: 'run-b', seq: 4, state: 'completed' });
    await test.router.push('/');
    await flush();
    expect(unread(test, 'B')).toBeNull();
    expect(readWorkspaceSession(1).projects[1]).toEqual(project('B'));
  });

  it('ignores delayed events from a closed workspace after opening the same project again', async () => {
    saveWorkspaceSession(1, saved(['A', 'B']));
    const test = await mount('/project/A');
    const original = test.manager.sessions[0];
    original.agent.setProject('A');
    const stream = original.agent._beginStream({ requestId: 'run-a' });
    await test.router.push('/project/B');
    test.manager.remove('A');
    await flush();
    await test.router.push('/project/A');
    const reopened = test.manager.sessions.at(-1);
    expect(reopened).not.toBe(original);
    await test.router.push('/');
    original.agent._onEvent({ type: 'run', runId: 'run-a', seq: 2, state: 'completed' }, stream);
    await flush();
    expect(unread(test, 'A')).toBeNull();
    expect(readWorkspaceSession(1).projects.at(-1)).toEqual(project('A'));
  });
});
