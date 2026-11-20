// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, reactive, ref } from 'vue';
import { EditorState } from '@codemirror/state';
import { createEditorRuntime } from './editorRuntime.js';
import { createEditorNavigator } from './editorNavigation.js';
let store, runtime, navigator, active, error;
const flush = async () => { for (let i = 0; i < 4; i++) await nextTick(); };
const view = (text = 'first\nsecond\nthird') => ({ state: EditorState.create({ doc: text }), dispatch: vi.fn(), focus: vi.fn() });
beforeEach(() => {
  vi.useFakeTimers();
  store = reactive({ projectId: 'a', projectVersion: 1, activeFile: 'old.tex', viewMode: 'code', openFile(path) { this.activeFile = path; } });
  runtime = createEditorRuntime(); active = ref(true); error = vi.fn();
  navigator = createEditorNavigator(store, runtime, { active: () => active.value, onError: error });
});
afterEach(() => { navigator.cancel(); vi.clearAllTimers(); vi.useRealTimers(); });
describe('file navigation waits for a matching editor', () => {
  it('waits through a slow file load without moving the previously registered editor', async () => {
    const old = view(); runtime.register(old, { projectId: 'a', filePath: 'old.tex' });
    const operation = navigator.open('slow.tex', { line: 2, col: 2 });
    await vi.advanceTimersByTimeAsync(2500); expect(old.dispatch).not.toHaveBeenCalled();
    const loaded = view(); runtime.register(loaded, { projectId: 'a', filePath: 'slow.tex' }); await flush();
    expect(await operation).toBe(true); expect(loaded.dispatch).toHaveBeenCalledOnce(); expect(loaded.dispatch).toHaveBeenCalledWith({ selection: { anchor: 15 }, scrollIntoView: true });
  });
  it('resolves review offsets from the loaded live document rather than an earlier HTTP copy', async () => {
    store.viewMode = 'visual'; const operation = navigator.open('review.tex', { offset: 8 });
    expect(store.viewMode).toBe('code');
    const loaded = view('changed\nreview target\nend'); runtime.register(loaded, { projectId: 'a', filePath: 'review.tex' }); await flush();
    expect(await operation).toBe(true); expect(loaded.dispatch.mock.calls[0][0].selection.anchor).toBe(8);
  });
  it.each(['project', 'generation', 'file', 'hidden', 'cancel'])('cancels a pending target after %s changes', async change => {
    const operation = navigator.open('slow.tex', { line: 2 });
    if (change === 'project') store.projectId = 'b';
    if (change === 'generation') store.projectVersion++;
    if (change === 'file') store.activeFile = 'other.tex';
    if (change === 'hidden') active.value = false;
    if (change === 'cancel') navigator.cancel();
    await flush();
    const loaded = view(); runtime.register(loaded, { projectId: 'a', filePath: 'slow.tex' }); await flush();
    expect(await operation).toBe(false); expect(loaded.dispatch).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
  });
  it('keeps only the latest navigation request and never jumps to another project same-named file', async () => {
    const first = navigator.open('one.tex', { line: 1 }); const second = navigator.open('two.tex', { line: 2 });
    expect(await first).toBe(false);
    const wrong = view(); runtime.register(wrong, { projectId: 'b', filePath: 'two.tex' }); await flush(); expect(wrong.dispatch).not.toHaveBeenCalled();
    const right = view(); runtime.register(right, { projectId: 'a', filePath: 'two.tex' }); await flush();
    expect(await second).toBe(true); expect(right.dispatch).toHaveBeenCalledOnce();
  });
  it('reports a load timeout once and releases its pending request', async () => {
    const operation = navigator.open('broken.tex', { line: 1 });
    await vi.advanceTimersByTimeAsync(20000); expect(await operation).toBe(false); expect(error).toHaveBeenCalledOnce();
    const loaded = view(); runtime.register(loaded, { projectId: 'a', filePath: 'broken.tex' }); await flush(); expect(loaded.dispatch).not.toHaveBeenCalled();
  });
});
