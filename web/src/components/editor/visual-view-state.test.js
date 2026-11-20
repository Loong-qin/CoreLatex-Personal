// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, h, nextTick, provide, reactive, ref } from 'vue';
import VisualView from './VisualView.vue';
import { PROJECT_CONTEXT } from '../../lib/projectContext.js';
const state = vi.hoisted(() => ({ store: null }));
vi.mock('../../stores/editor.js', () => ({ useEditorStore: () => state.store }));
vi.mock('../../api.js', () => ({ getToken: () => '' }));
vi.mock('../../lib/collabClient.js', () => ({ attachCollab: () => ({ ytext: { toString: () => 'Draft', observe: vi.fn(), unobserve: vi.fn() }, resetCbs: new Set() }), detachCollab: vi.fn() }));
vi.mock('../../lib/latex2html.js', () => ({ renderLatexToHtml: (text, options) => { state.figureUrl = options.resolveImage; return `<p>${text}</p>`; }, VISUAL_CSS: '', pickImagePath: path => path }));
vi.mock('../../lib/markdown2html.js', () => ({ renderMarkdownToHtml: text => text, MD_CSS: '' }));
let app, host;
const flush = async () => { await nextTick(); await nextTick(); };
afterEach(() => { app?.unmount(); host?.remove(); vi.unstubAllGlobals(); });
describe('visual preview view state', () => {
  it('does not turn hidden zero geometry into a new code anchor and restores its per-file viewport after remount', async () => {
    const observers = [];
    vi.stubGlobal('ResizeObserver', class { constructor(callback) { this.callback = callback; observers.push(this); } observe() {} disconnect() {} });
    state.store = reactive({ projectId: 'a', activeFile: 'main.tex', tree: [], editorFontSize: 13, pendingViewAnchor: 0.6 });
    const active = ref(true);
    function mount() {
      app = createApp({ setup() { provide(PROJECT_CONTEXT, { active }); return () => h(VisualView); } });
      host = document.createElement('div'); document.body.appendChild(host); app.mount(host);
      const scroll = host.querySelector('.visual-scroll');
      let width = 600, height = 500;
      Object.defineProperties(scroll, { clientWidth: { get: () => width }, clientHeight: { get: () => height }, scrollHeight: { value: 2500 }, scrollWidth: { value: 700 } });
      return { scroll, hide() { width = 0; height = 0; } };
    }
    const first = mount(); await flush(); expect(first.scroll.scrollTop).toBe(1200);
    first.scroll.scrollTop = 930; first.scroll.scrollLeft = 40; first.scroll.dispatchEvent(new Event('scroll'));
    active.value = false; first.hide(); first.scroll.scrollTop = 0; first.scroll.scrollLeft = 0;
    for (const observer of observers) observer.callback();
    first.scroll.dispatchEvent(new Event('scroll')); state.store.pendingViewAnchor = 0.4;
    app.unmount(); app = null; host.remove();
    expect(state.store.pendingViewAnchor).toBe(0.4);
    state.store.pendingViewAnchor = null; active.value = true;
    const second = mount(); await flush();
    expect(second.scroll.scrollTop).toBe(930); expect(second.scroll.scrollLeft).toBe(40);
  });
});


it('resolves figures without loading or traversing a project file tree', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  state.store = reactive({ projectId: 'a', activeFile: 'main.tex', editorFontSize: 13, pendingViewAnchor: null,
    get tree() { throw new Error('Visual rendering must not traverse the file tree'); } });
  app = createApp({ render: () => h(VisualView) });
  host = document.createElement('div'); document.body.appendChild(host); app.mount(host); await flush();
  expect(state.figureUrl('figures/chart')).toContain('/figure?path=figures%2Fchart&resolve=1');
  expect(state.figureUrl('figures/chart.pdf')).toContain('/figure?');
  expect(state.figureUrl('figures/chart.png')).toContain('/file?');
});
