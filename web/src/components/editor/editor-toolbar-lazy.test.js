// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createApp, nextTick, reactive } from 'vue';
import EditorToolbar from './EditorToolbar.vue';

const state = vi.hoisted(() => ({ store: null, runtime: null }));
vi.mock('../../stores/editor.js', () => ({ useEditorStore: () => state.store }));
vi.mock('../../lib/editorRuntime.js', () => ({ useEditorRuntime: () => state.runtime }));
let app, el;
beforeEach(() => {
  state.store = reactive({ project: {}, activeFile: 'main.tex', viewMode: 'code', editingLocked: false, reviewMode: false,
    tree: [{ type: 'dir', path: 'figures', children: [{ type: 'file', path: 'figures/main.png' }] }],
    openFiles: ['main.tex', '_workspace/charts/result.png', '_workspace/charts/result.png', '_workspace/draft.md'] });
  state.runtime = { view: null, insertText: vi.fn(), wrapSelection: vi.fn() };
});
afterEach(() => { app?.unmount(); el?.remove(); app = null; el = null; });

it('suggests opened workspace images alongside project images without scanning workspace directories', async () => {
  app = createApp(EditorToolbar); el = document.createElement('div'); document.body.appendChild(el);
  app.component('el-popover', { template: '<div><slot name="reference" /><slot /></div>' });
  app.mount(el); await nextTick();
  el.querySelector('[title="插入图片"]').click(); await nextTick();
  expect([...document.querySelectorAll('#image-files option')].map(option => option.value))
    .toEqual(['_workspace/charts/result.png', 'figures/main.png']);
  state.store.openFiles.push('_workspace/new.pdf'); await nextTick();
  expect([...document.querySelectorAll('#image-files option')].map(option => option.value))
    .toEqual(['_workspace/charts/result.png', '_workspace/new.pdf', 'figures/main.png']);
});
