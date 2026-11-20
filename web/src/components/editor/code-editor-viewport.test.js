// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, KeepAlive, nextTick, provide, ref } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { undo, undoDepth } from '@codemirror/commands';
import CodeEditor from './CodeEditor.vue';
import { useEditorStore } from '../../stores/editor.js';
import { createEditorRuntime } from '../../lib/editorRuntime.js';
import { PROJECT_CONTEXT } from '../../lib/projectContext.js';
import { api } from '../../api.js';
const collab = vi.hoisted(() => ({ sessions: new Map() }));
vi.mock('./FilePreview.vue', () => ({ default: { render: () => null } }));
vi.mock('../../api.js', () => ({ api: { get: vi.fn(), post: vi.fn(), raw: vi.fn() } }));
vi.mock('../../stores/ui.js', () => ({ useUiStore: () => ({ error: vi.fn() }) }));
vi.mock('../../lib/collabClient.js', () => ({ attachCollab: (_, path) => collab.sessions.get(path), detachCollab: vi.fn(), detachProjectCollab: vi.fn(), subscribeProjectPresence: () => () => {}, setPresenceListener: vi.fn() }));
let app, el;
const flush = async () => { for (let i = 0; i < 6; i++) { await Promise.resolve(); await nextTick(); } };
const source = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join('\n');
function session(text = source) {
  const doc = new Y.Doc(), ytext = doc.getText('codemirror'); ytext.insert(0, text);
  const awareness = new Awareness(doc), handlers = new Map();
  const provider = { synced: true, awareness, on(event, fn) { if (!handlers.has(event)) handlers.set(event, new Set()); handlers.get(event).add(fn); }, off(event, fn) { handlers.get(event)?.delete(fn); } };
  return { doc, ytext, provider, resetCbs: new Set() };
}
async function mount() {
  const pinia = createPinia(); setActivePinia(pinia);
  const editor = useEditorStore(); editor.projectId = 'alpha'; editor.openFiles = ['main.tex']; editor.activeFile = 'main.tex';
  const runtime = createEditorRuntime(), active = ref(true), show = ref(true);
  collab.sessions.set('main.tex', session()); collab.sessions.set('second.tex', session());
  api.raw.mockResolvedValue({ text: async () => source });
  const Child = defineComponent({ setup() { provide(PROJECT_CONTEXT, { projectId: 'alpha', editor, runtime, active }); return () => h(CodeEditor); } });
  const Root = defineComponent({ setup: () => () => h(KeepAlive, null, { default: () => show.value ? h(Child) : null }) });
  el = document.createElement('div'); document.body.appendChild(el);
  app = createApp(Root); app.use(pinia); app.mount(el); await flush();
  function measure(view) {
    Object.defineProperties(view.scrollDOM, { clientHeight: { configurable: true, get: () => el.contains(view.dom) ? 600 : 0 }, clientWidth: { configurable: true, get: () => el.contains(view.dom) ? 700 : 0 } });
    vi.spyOn(view, 'requestMeasure').mockImplementation((request) => { if (request?.key?.view === view) request.write?.(request.read(view), view); });
  }
  measure(runtime.view);
  return { editor, runtime, active, show, measure, async hide() { active.value = false; show.value = false; await flush(); }, async returnToEditor() { active.value = true; show.value = true; await flush(); } };
}
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear();
  Range.prototype.getClientRects = () => [];
  Range.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 });
  vi.stubGlobal('requestAnimationFrame', () => 1); vi.stubGlobal('cancelAnimationFrame', () => {});
});
afterEach(() => {
  app?.unmount(); el?.remove();
  for (const s of collab.sessions.values()) { s.provider.awareness.destroy(); s.doc.destroy(); } collab.sessions.clear();
  vi.unstubAllGlobals(); delete Range.prototype.getClientRects; delete Range.prototype.getBoundingClientRect;
});
describe('CodeEditor cached view position', () => {
  it('restores exact scroll after KeepAlive, preserving mapped selection and undo history during background edits', async () => {
    const test = await mount(), view = test.runtime.view;
    view.dispatch({ changes: { from: view.state.doc.length, insert: '\nlocal edit' }, selection: { anchor: 1200, head: 1210 } });
    view.scrollDOM.scrollTop = 2734; view.scrollDOM.scrollLeft = 41;
    view.scrollDOM.dispatchEvent(new Event('scroll'));
    await test.hide();
    view.scrollDOM.scrollTop = 0; view.scrollDOM.scrollLeft = 0; view.scrollDOM.dispatchEvent(new Event('scroll'));
    // Collaboration stays attached and maps the retained EditorState selection.
    collab.sessions.get('main.tex').ytext.insert(0, 'remote prefix\n'); await flush();
    const selection = view.state.selection.toJSON(), depth = undoDepth(view.state);
    await test.returnToEditor();
    expect(test.runtime.view).toBe(view);
    expect(view.scrollDOM.scrollTop).toBe(2734); expect(view.scrollDOM.scrollLeft).toBe(41);
    expect(view.state.selection.toJSON()).toEqual(selection);
    expect(view.state.doc.toString()).toContain('local edit');
    expect(undoDepth(view.state)).toBe(depth); expect(depth).toBeGreaterThan(0);
    expect(view.state.doc.toString()).toContain('remote prefix');
  });
  it('keeps the editor instance and working undo stack across route deactivation', async () => {
    const test = await mount(), view = test.runtime.view;
    view.dispatch({ changes: { from: view.state.doc.length, insert: '\nlocal edit' } });
    await test.hide(); await test.returnToEditor();
    expect(test.runtime.view).toBe(view); expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).not.toContain('local edit');
  });
  it('unbinds toolbar actions from the previous file while the next snapshot is loading', async () => {
    const test = await mount(), first = test.runtime.view; const text = first.state.doc.toString();
    let resolve; api.raw.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    test.editor.openFile('second.tex'); await flush();
    expect(test.runtime.view).toBe(null); expect(test.editor.selection).toBe(null);
    test.runtime.insertText('must not edit previous file');
    expect(first.state.doc.toString()).toBe(text);
    resolve({ text: async () => source }); await flush();
    expect(test.runtime.view).not.toBe(first); expect(test.runtime.view.state.doc.toString()).toBe(source);
  });
  it('retains each file viewport independently when its DOM is detached for another file', async () => {
    const test = await mount(), first = test.runtime.view;
    first.scrollDOM.scrollTop = 1870; first.scrollDOM.dispatchEvent(new Event('scroll'));
    test.editor.openFile('second.tex'); await flush(); const second = test.runtime.view; test.measure(second);
    second.scrollDOM.scrollTop = 590; second.scrollDOM.dispatchEvent(new Event('scroll'));
    first.scrollDOM.scrollTop = 0; first.scrollDOM.dispatchEvent(new Event('scroll'));
    test.editor.activeFile = 'main.tex'; await flush();
    expect(test.runtime.view).toBe(first); expect(first.scrollDOM.scrollTop).toBe(1870);
    second.scrollDOM.scrollTop = 0; second.scrollDOM.dispatchEvent(new Event('scroll'));
    test.editor.activeFile = 'second.tex'; await flush(); expect(second.scrollDOM.scrollTop).toBe(590);
  });
});


describe('CodeEditor demand loading', () => {
  it('does not preload restored tabs and aborts a file request when another tab is selected', async () => {
    const test = await mount(), original = test.runtime.view;
    test.editor.openFiles.push('second.tex'); await flush();
    expect(api.raw).toHaveBeenCalledTimes(1);
    let resolve;
    api.raw.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    test.editor.activeFile = 'second.tex'; await flush();
    const request = api.raw.mock.calls.at(-1)[1].signal;
    expect(request.aborted).toBe(false);
    test.editor.activeFile = 'main.tex'; await flush();
    expect(request.aborted).toBe(true);
    expect(test.runtime.view).toBe(original);
    resolve({ text: async () => 'obsolete text' }); await flush();
    expect(test.runtime.view).toBe(original);
    expect(test.runtime.view.state.doc.toString()).not.toContain('obsolete text');
  });

  it('pauses unfinished file loading while a cached project is hidden and resumes only its active file', async () => {
    const test = await mount(); let resolve;
    api.raw.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    test.editor.openFile('second.tex'); await flush();
    const signal = api.raw.mock.calls.at(-1)[1].signal;
    await test.hide(); expect(signal.aborted).toBe(true);
    const count = api.raw.mock.calls.length;
    resolve({ text: async () => 'obsolete text' }); await flush();
    expect(api.raw).toHaveBeenCalledTimes(count);
    await test.returnToEditor();
    expect(api.raw).toHaveBeenCalledTimes(count + 1);
    expect(test.runtime.view.state.doc.toString()).toBe(source);
  });
});


it('opens workspace text files even when their directory has never been listed', async () => {
  const test = await mount();
  test.editor.tree = [];
  for (const path of ['_workspace/config.yaml', '_workspace/output.v1/README', '_workspace/example.cpp', '_workspace/analysis.r', '_workspace/refs.bibtex']) {
    collab.sessions.set(path, session());
    test.editor.openFile(path); await flush();
    expect(api.raw.mock.calls.at(-1)[0]).toContain(encodeURIComponent(path));
    expect(test.runtime.filePath).toBe(path);
  }
});
