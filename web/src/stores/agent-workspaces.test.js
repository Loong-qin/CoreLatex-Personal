// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { ref } from 'vue';
import { api, ssePost } from '../api.js';
import { useAgentStore, createProjectAgentStore, bindAgentContext } from './agent.js';
import { useEditorStore, createProjectEditorStore } from './editor.js';

vi.mock('../api.js', () => ({ api: { get: vi.fn(), del: vi.fn(), post: vi.fn() }, ssePost: vi.fn(), getToken: () => '', ApiError: Error }));
vi.mock('../lib/collabClient.js', () => ({ detachAllCollab: vi.fn(), detachProjectCollab: vi.fn(), subscribeProjectPresence: vi.fn(() => vi.fn()), setPresenceListener: vi.fn() }));
vi.mock('./ui.js', () => ({ useUiStore: vi.fn(() => ({ error: vi.fn(), toast: vi.fn() })) }));
const deferred = () => { let resolve; const promise = new Promise((res) => { resolve = res; }); return { promise, resolve }; };
let streams, workspacePinia;
beforeEach(() => {
  vi.clearAllMocks(); streams = new Map(); localStorage.clear(); workspacePinia = createPinia(); setActivePinia(workspacePinia);
  api.get.mockImplementation(async path => path.includes('/changesets?') ? { changesets: [{ id: path.includes('/a/') ? 1 : 2, status: 'pending', files: [] }] } : { chatId: 1, messages: [] }); api.del.mockResolvedValue({});
  ssePost.mockImplementation((path, body, onEvent, { signal }) => {
    const pending = deferred(); streams.set(path, { ...pending, onEvent, signal }); return pending.promise;
  });
});
function project(id) {
  const pinia = workspacePinia;
  const editor = createProjectEditorStore(id, pinia); editor.projectId = id;
  vi.spyOn(editor, 'reconcileChangeset');
  const agent = createProjectAgentStore(id, pinia);
  const ui = { error: vi.fn(), toast: vi.fn() };
  const active = ref(true);
  bindAgentContext(agent, { editor, ui, active });
  return { pinia, editor, agent, ui, active };
}
describe('parallel project agent contexts', () => {
  it('keeps background SSE, changesets, messages and completion in their own project', async () => {
    const a = project('a'), b = project('b');
    expect(a.agent).not.toBe(b.agent);
    expect(createProjectAgentStore('a', workspacePinia)).toBe(a.agent);
    const first = a.agent.sendMessage('a', 'work A');
    const second = b.agent.sendMessage('b', 'work B');
    a.active.value = false; // The workspace remains mounted while another project is selected.
    setActivePinia(b.pinia);
    const streamA = streams.get('/api/projects/a/agent/chat'), streamB = streams.get('/api/projects/b/agent/chat');
    streamA.onEvent({ type: 'token', text: 'A in background' });
    streamA.onEvent({ type: 'changeset', changeset: { id: 1, status: 'pending', files: [] } });
    expect(a.agent.streamText).toBe('A in background'); expect(b.agent.streamText).toBe('');
    expect(a.editor.reconcileChangeset).toHaveBeenCalledWith({ id: 1, status: 'pending', files: [] });
    await Promise.resolve(); await Promise.resolve();
    expect(a.editor.pendingChangesets.map((item) => item.id)).toEqual([1]);
    expect(b.editor.pendingChangesets).toEqual([]); expect(b.editor.reconcileChangeset).not.toHaveBeenCalled();
    expect(streamA.signal.aborted).toBe(false); expect(streamB.signal.aborted).toBe(false);
    streamA.onEvent({ type: 'done' }); streamA.resolve();
    expect(await first).toBe(true); expect(b.agent.streaming).toBe(true);
    streamB.onEvent({ type: 'token', text: 'B output' }); streamB.onEvent({ type: 'done' }); streamB.resolve();
    expect(await second).toBe(true);
  });
  it('invalidates only the owning workspace for real agent writes and completed scripts', async () => {
    const a = project('a'), b = project('b');
    const running = a.agent.sendMessage('a', 'write workspace');
    const stream = streams.get('/api/projects/a/agent/chat');
    const emit = event => stream.onEvent({ type: 'tool', ...event });
    emit({ name: 'write_file', status: 'start', toolCallId: 'write-1', input: { path: '_workspace/notes.md' } });
    emit({ name: 'write_file', status: 'end', toolCallId: 'write-1', detail: JSON.stringify({ path: '_workspace/notes.md', scope: 'workspace', changed: true, applied: true }) });
    expect(a.editor.workspaceVersion).toBe(1); expect(b.editor.workspaceVersion).toBe(0);
    emit({ name: 'write_file', status: 'end', toolCallId: 'write-1', detail: JSON.stringify({ path: '_workspace/notes.md', scope: 'workspace', changed: true, applied: true }) });
    emit({ name: 'edit_file', status: 'end', toolCallId: 'no-change', detail: JSON.stringify({ path: '_workspace/notes.md', scope: 'workspace', changed: false }) });
    emit({ name: 'write_file', status: 'end', toolCallId: 'formal', detail: JSON.stringify({ path: 'main.tex', scope: 'project', changed: true }) });
    emit({ name: 'read_file', status: 'end', toolCallId: 'read', detail: '_workspace/notes.md' });
    expect(a.editor.workspaceVersion).toBe(1);
    emit({ name: 'run_in_workspace', status: 'error', toolCallId: 'script' }); // Partial script effects are possible.
    expect(a.editor.workspaceVersion).toBe(2);
    stream.onEvent({ type: 'activity', source: 'system', draftPath: '_workspace/parallel-edits/1.json', text: 'draft ready' });
    expect(a.editor.workspaceVersion).toBe(3);
    stream.onEvent({ type: 'done' }); stream.resolve(); await running;
  });
  it('resets only the originating editor project even when another workspace is active', async () => {
    const a = project('a'), b = project('b');
    a.agent.setProject('a'); b.agent.setProject('b'); b.agent.messages = [{ content: 'keep B' }];
    setActivePinia(b.pinia);
    await a.agent.resetChat();
    expect(api.del).toHaveBeenCalledWith('/api/projects/a/chat');
    expect(a.ui.toast).toHaveBeenCalled(); expect(b.ui.toast).not.toHaveBeenCalled();
    expect(b.agent.messages[0].content).toBe('keep B');
  });
  it('isolates errors and explicit close cleanup from a second running project', async () => {
    const a = project('a'), b = project('b');
    const first = a.agent.sendMessage('a', 'work A'), second = b.agent.sendMessage('b', 'work B');
    const streamA = streams.get('/api/projects/a/agent/chat'), streamB = streams.get('/api/projects/b/agent/chat');
    setActivePinia(b.pinia); streamA.onEvent({ type: 'error', message: 'A failed' });
    expect(a.ui.error).toHaveBeenCalledWith('A failed'); expect(b.ui.error).not.toHaveBeenCalled();
    a.agent.clearLocal();
    expect(streamA.signal.aborted).toBe(true); expect(streamB.signal.aborted).toBe(false);
    streamA.resolve(); expect(await first).toBe(false);
    streamB.onEvent({ type: 'done' }); streamB.resolve(); expect(await second).toBe(true);
  });
  it('pins the editor dependency to the owning Pinia even without explicit context binding', () => {
    const piniaA = createPinia(), piniaB = createPinia();
    const a = useEditorStore(piniaA), b = useEditorStore(piniaB);
    a.reconcileChangeset = vi.fn().mockResolvedValue(true); b.reconcileChangeset = vi.fn().mockResolvedValue(true);
    const agent = useAgentStore(piniaA); agent.setProject('a'); agent._beginStream();
    setActivePinia(piniaB); agent._onEvent({ type: 'changeset', changeset: { id: 2 } });
    expect(a.reconcileChangeset).toHaveBeenCalledWith({ id: 2 }); expect(b.reconcileChangeset).not.toHaveBeenCalled();
  });
});
