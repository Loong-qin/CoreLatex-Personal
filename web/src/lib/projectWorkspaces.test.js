// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, createApp, defineComponent, h, KeepAlive, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { createProjectWorkspaces } from './projectWorkspaces.js';
import { useProjectContext } from './projectContext.js';
import { useEditorRuntime } from './editorRuntime.js';
import { useEditorStore } from '../stores/editor.js';
import { useAgentStore } from '../stores/agent.js';
import { useAuthStore } from '../stores/auth.js';
import { detachProjectCollab } from './collabClient.js';
import { api } from '../api.js';
vi.mock('../api.js', async original => {
  const actual = await original();
  return { ...actual, api: { ...actual.api, get: vi.fn() } };
});
vi.mock('./collabClient.js', () => ({
  detachAllCollab: vi.fn(), detachProjectCollab: vi.fn(), setPresenceListener: vi.fn(),
  subscribeProjectPresence: vi.fn(() => vi.fn()),
}));
const mounted = [];
const flush = async () => { for (let i = 0; i < 4; i++) { await Promise.resolve(); await nextTick(); } };
beforeEach(() => { vi.clearAllMocks(); api.get.mockReset(); localStorage.clear(); });
afterEach(async () => { for (const harness of mounted.splice(0)) { harness.app.unmount(); harness.manager.dispose(); harness.el.remove(); } await flush(); });
async function harness() {
  const pinia = createPinia(); setActivePinia(pinia);
  const auth = useAuthStore(pinia); auth.token = 'synthetic-session'; auth.user = { id: 1 };
  const manager = createProjectWorkspaces(pinia), selected = shallowRef(null), probes = new Map(), errors = [], teardown = [];
  const mounts = new Map();
  const EditorProbe = defineComponent({
    setup() {
      const context = useProjectContext(), editor = useEditorStore(), agent = useAgentStore(), runtime = useEditorRuntime();
      const draft = ref('');
      editor.projectId = context.projectId; editor.project = { name: context.projectId }; agent.setProject(context.projectId);
      onMounted(() => { mounts.set(context.projectId, (mounts.get(context.projectId) || 0) + 1); });
      onBeforeUnmount(() => {
        // Child cleanup must see live state before its wrapper disposes Pinia.
        teardown.push({ project: context.projectId, files: [...editor.openFiles], registered: pinia._s.has(editor.$id) });
      });
      probes.set(context.projectId, { context, editor, agent, runtime, draft });
      return () => h('div', { 'data-project': context.projectId }, [h('input', { value: draft.value, onInput: (event) => { draft.value = event.target.value; } }), h('span', editor.project?.name)]);
    },
  });
  const Root = defineComponent({
    setup() {
      const include = computed(() => manager.sessions.map((session) => session.cacheName));
      watch(() => auth.token, (token) => { if (!token) { selected.value = null; manager.clear(); } });
      return () => h(KeepAlive, { include: include.value }, { default: () => selected.value ? h(selected.value.component, { key: selected.value.publicId, view: h(EditorProbe) }) : null });
    },
  });
  const el = document.createElement('div'); document.body.appendChild(el);
  const app = createApp(Root); app.use(pinia); app.config.errorHandler = (error) => { errors.push(error); }; app.mount(el);
  async function select(id) { selected.value = manager.open(id); manager.activate(id); await flush(); return selected.value; }
  const result = { app, el, pinia, auth, manager, select, selected, probes, errors, mounts, teardown };
  mounted.push(result); await flush(); return result;
}
describe('project workspace KeepAlive integration', () => {
  it('injects isolated editor/agent/runtime scopes and retains a project local UI state while hidden', async () => {
    const test = await harness(); const a = await test.select('a');
    const probeA = test.probes.get('a'); probeA.draft.value = 'local draft A'; a.editor.openFiles = ['a.tex']; a.editor.activeFile = 'a.tex';
    a.context.runtime.register({ marker: 'runtime A' }); a.agent.messages = [{ role: 'user', content: 'A task' }]; a.agent._beginStream();
    const b = await test.select('b'), probeB = test.probes.get('b');
    expect(probeA.editor).toBe(a.editor); expect(probeA.agent).toBe(a.agent); expect(probeA.runtime).toBe(a.context.runtime);
    expect(probeB.editor).toBe(b.editor); expect(probeB.agent).toBe(b.agent); expect(probeB.runtime).toBe(b.context.runtime);
    expect(a.context.active.value).toBe(false); expect(b.context.active.value).toBe(true);
    expect(a.editor).not.toBe(b.editor); expect(a.agent).not.toBe(b.agent); expect(a.context.runtime).not.toBe(b.context.runtime);
    expect(test.teardown).toEqual([]);
    const currentChangeset = { id: 101, status: 'pending', applied: false,
      files: [{ filePath: 'a.tex', status: 'pending', applied: false }] };
    api.get.mockResolvedValue({ changesets: [currentChangeset] });
    const reconcile = vi.spyOn(a.editor, 'reconcileChangeset');
    a.agent._onEvent({ type: 'token', text: 'background A output' });
    a.agent._onEvent({ type: 'changeset', changeset: { id: 101, status: 'pending', files: [] } });
    await reconcile.mock.results[0].value;
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.get).toHaveBeenCalledWith('/api/projects/a/changesets?status=pending', { cache: 'no-store' });
    expect(a.agent.streamText).toBe('background A output'); expect(b.agent.streamText).toBe('');
    expect(a.editor.pendingChangesets).toEqual([currentChangeset]); expect(b.editor.pendingChangesets).toEqual([]);
    expect(await test.select('a')).toBe(a);
    expect(test.mounts.get('a')).toBe(1); expect(test.el.querySelector('input').value).toBe('local draft A');
    expect(a.editor.openFiles).toEqual(['a.tex']); expect(a.context.runtime.view.marker).toBe('runtime A');
    expect(a.agent.streaming).toBe(true); expect(test.errors).toEqual([]);
  });
  it('closing an inactive cached project disposes only that project and keeps the visible project intact', async () => {
    const test = await harness(); const a = await test.select('a'); a.editor.openFiles = ['a.tex']; a.agent._beginStream();
    const b = await test.select('b'); b.editor.openFiles = ['b.tex']; b.agent._beginStream(); test.probes.get('b').draft.value = 'B remains';
    test.manager.remove('a'); await flush();
    expect(a.disposed).toBe(true); expect(test.pinia._s.has(a.editor.$id)).toBe(false); expect(test.pinia._s.has(a.agent.$id)).toBe(false);
    expect(b.disposed).toBe(false); expect(b.editor.openFiles).toEqual(['b.tex']); expect(b.agent.streaming).toBe(true);
    expect(b.context.active.value).toBe(true); expect(test.el.querySelector('input').value).toBe('B remains');
    expect(test.teardown).toEqual([{ project: 'a', files: ['a.tex'], registered: true }]);
    expect(detachProjectCollab.mock.calls.map(([id]) => id)).toContain('a');
    expect(detachProjectCollab.mock.calls.map(([id]) => id)).not.toContain('b'); expect(test.errors).toEqual([]);
  });
  it('logging out disposes all cached projects after child cleanup without throwing or deleting auth state', async () => {
    const test = await harness(); const a = await test.select('a'); a.editor.openFiles = ['a.tex']; a.agent._beginStream();
    const b = await test.select('b'); b.editor.openFiles = ['b.tex']; b.agent._beginStream();
    test.auth.logout(); await flush();
    expect(test.manager.sessions).toHaveLength(0); expect(a.disposed).toBe(true); expect(b.disposed).toBe(true);
    for (const session of [a, b]) { expect(test.pinia._s.has(session.editor.$id)).toBe(false); expect(test.pinia._s.has(session.agent.$id)).toBe(false); }
    expect(test.teardown).toEqual(expect.arrayContaining([{ project: 'a', files: ['a.tex'], registered: true }, { project: 'b', files: ['b.tex'], registered: true }]));
    expect(test.pinia._s.get('auth')).toBe(test.auth); expect(test.auth.token).toBe(''); expect(test.errors).toEqual([]);
  });
  it('cleans a project opened and closed before its wrapper mounted', async () => {
    const test = await harness(); const pending = test.manager.open('never-mounted');
    test.manager.remove('never-mounted'); await flush();
    expect(pending.disposed).toBe(true); expect(test.pinia._s.has(pending.editor.$id)).toBe(false); expect(test.pinia._s.has(pending.agent.$id)).toBe(false);
    expect(test.errors).toEqual([]);
  });
});
