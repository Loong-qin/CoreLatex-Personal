// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, h, nextTick, reactive } from 'vue';
import EditorView from './EditorView.vue';
const state = vi.hoisted(() => ({ store: null, error: vi.fn() }));
vi.mock('vue-router', () => ({ useRoute: () => ({ params: { id: 'test' } }), useRouter: () => ({ push: vi.fn() }) }));
vi.mock('../stores/editor.js', () => ({ useEditorStore: () => state.store }));
vi.mock('../stores/auth.js', () => ({ useAuthStore: () => ({ user: null }) }));
vi.mock('../stores/ui.js', () => ({ useUiStore: () => ({ error: state.error }) }));
vi.mock('../stores/agent.js', () => ({ useAgentStore: () => ({ setProject: vi.fn(), loadSettings: async () => {}, loadChat: async () => {}, restoreActiveRun: async () => {}, clearLocal: vi.fn() }) }));
vi.mock('../lib/collabClient.js', () => ({ setCollabUser: vi.fn() }));
vi.mock('../lib/selectionMenu.js', () => ({ buildSelectionMenuItems: vi.fn() }));
vi.mock('../components/editor/FileTree.vue', () => ({ default: { template: '<input aria-label="tree state" />' } }));
vi.mock('../components/editor/WorkspacePanel.vue', () => ({ default: { template: '<div />' } }));
vi.mock('../components/editor/OutlinePanel.vue', () => ({ default: { template: '<div />' } }));
vi.mock('../components/editor/SearchPanel.vue', () => ({ default: { template: '<div />' } }));
vi.mock('../components/editor/ReviewPanel.vue', () => ({ default: { template: '<div />' } }));
vi.mock('../components/editor/AgentPanel.vue', () => ({ default: { emits: ['close'], template: `<div><button class="agent-close" aria-label="关闭左侧面板" @click="$emit('close')">关闭</button><input aria-label="agent draft" /></div>` } }));
vi.mock('../components/editor/EditorToolbar.vue', () => ({ default: { template: '<div />' } }));
vi.mock('../components/editor/ChangesetBar.vue', () => ({ default: { template: '<div />' } }));
vi.mock('../components/editor/CodeEditor.vue', () => ({ default: { template: '<textarea aria-label="document" />' } }));
vi.mock('../components/editor/VisualView.vue', () => ({ default: { template: '<div />' } }));
vi.mock('../components/editor/StatusBar.vue', () => ({ default: { template: '<div />' } }));
vi.mock('../components/editor/OverviewBar.vue', () => ({ default: { template: '<div />' } }));
vi.mock('../components/editor/PdfPanel.vue', () => ({ default: { template: '<input aria-label="pdf state" />' } }));
vi.mock('../components/editor/InfoPanel.vue', () => ({ default: { template: '<div />' } }));
vi.mock('../components/editor/VersionsPanel.vue', () => ({ default: { template: '<div />' } }));
vi.mock('../components/editor/LogPanel.vue', () => ({ default: { template: '<div />' } }));
let app, el, fullscreenElement;
const fullscreenDescriptors = {
  element: Object.getOwnPropertyDescriptor(document, 'fullscreenElement'),
  enabled: Object.getOwnPropertyDescriptor(document, 'fullscreenEnabled'),
  request: Object.getOwnPropertyDescriptor(document.documentElement, 'requestFullscreen'),
  exit: Object.getOwnPropertyDescriptor(document, 'exitFullscreen'),
};
function changeFullscreen(element) {
  fullscreenElement = element;
  document.dispatchEvent(new Event('fullscreenchange'));
}
function restoreFullscreenProperties() {
  for (const [target, key, descriptor] of [
    [document, 'fullscreenElement', fullscreenDescriptors.element],
    [document, 'fullscreenEnabled', fullscreenDescriptors.enabled],
    [document.documentElement, 'requestFullscreen', fullscreenDescriptors.request],
    [document, 'exitFullscreen', fullscreenDescriptors.exit],
  ]) {
    if (descriptor) Object.defineProperty(target, key, descriptor);
    else delete target[key];
  }
}
const flush = async () => { await Promise.resolve(); await nextTick(); await Promise.resolve(); await nextTick(); };
const setWidth = (width) => { Object.defineProperty(window, 'innerWidth', { value: width, writable: true, configurable: true }); window.dispatchEvent(new Event('resize')); };
const visible = (selector) => el.querySelector(selector)?.style.display !== 'none';
const click = async (selector) => { el.querySelector(selector).click(); await flush(); };
beforeEach(() => {
  state.error.mockClear();
  fullscreenElement = null;
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => fullscreenElement });
  Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value: true });
  Object.defineProperty(document.documentElement, 'requestFullscreen', { configurable: true, value: vi.fn(async () => changeFullscreen(document.documentElement)) });
  Object.defineProperty(document, 'exitFullscreen', { configurable: true, value: vi.fn(async () => changeFullscreen(null)) });
  localStorage.clear(); setWidth(1440);
  state.store = reactive({
    project: { name: 'A very long collaborative research project' }, projectId: 'test', sidebar: 'tree', rightTab: 'pdf', myRole: 'owner', onlineUsers: [], memberCount: 1,
    viewMode: 'code', compile: { status: 'idle' }, tree: [],
    init: async () => true, restoreViewState: () => ({}), compileProject: async () => {}, loadPendingChangesets: vi.fn(), saveViewState: vi.fn(), reset: vi.fn(),
    setSidebar(name) { this.sidebar = this.sidebar === name ? null : name; },
    setRightTab(name) { this.rightTab = this.rightTab === name ? null : name; },
  });
});
afterEach(() => { fullscreenElement = null; app?.unmount(); el?.remove(); app = null; restoreFullscreenProperties(); });
async function mount() {
  el = document.createElement('div'); document.body.appendChild(el);
  app = createApp(EditorView); app.component('el-icon', { setup: (_, { slots }) => () => h('span', slots.default?.()) }); app.mount(el); await flush();
}

describe('workbench layout controls', () => {
  it.each([0.7, 1.25, 1.6])('uses one agent heading at %sx and preserves draft state when zooming', async (zoom) => {
    localStorage.setItem('corelatex.sideZoom', String(zoom));
    state.store.sidebar = 'agent'; await mount();
    const panel = el.querySelector('.side-panel');
    const viewport = panel.querySelector('.side-viewport');
    const body = panel.querySelector('.side-body');
    const heading = panel.querySelector('.side-heading');
    const draft = el.querySelector('[aria-label="agent draft"]');
    draft.value = 'keep the current answer';
    expect(viewport).not.toBeNull();
    expect(body.parentElement).toBe(viewport);
    expect(heading).toBeNull();
    expect(body.querySelector('.agent-close')).not.toBeNull();
    expect(body.style.transform).toBe(`scale(${zoom})`);
    expect(Number(body.style.height.match(/[0-9.]+/)[0]) * zoom).toBeCloseTo(100, 3);
    const width = panel.style.width;
    panel.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: zoom === 1.6 ? 10 : -10, bubbles: true, cancelable: true }));
    await flush();
    expect(panel.style.width).toBe(width);
    expect(el.querySelector('[aria-label="agent draft"]')).toBe(draft);
    expect(draft.value).toBe('keep the current answer');
    await click('[aria-label="恢复默认布局"]');
    expect(body.style.transform).toBe('');
    expect(body.parentElement).toBe(viewport);
    expect(draft.value).toBe('keep the current answer');
  });

  it('keeps the selected drawer tab open and lets the close button dismiss it', async () => {
    await mount();
    const pdf = el.querySelector('[aria-label="pdf state"]'); pdf.value = 'page 4';
    await click('.drawer-tabs [title="PDF 预览"]');
    expect(state.store.rightTab).toBe('pdf');
    expect(visible('.right-drawer')).toBe(true);
    expect(el.querySelector('[aria-label="pdf state"]')).toBe(pdf);
    expect(pdf.value).toBe('page 4');
    await click('.drawer-tabs [title="项目信息"]');
    expect(state.store.rightTab).toBe('info');
    await click('.drawer-tabs [title="项目信息"]');
    expect(state.store.rightTab).toBe('info');
    await click('[aria-label="关闭右侧面板"]');
    expect(visible('.right-drawer')).toBe(false);
  });
  it('closes and reopens the single agent header without losing its draft', async () => {
    state.store.sidebar = 'agent'; await mount();
    const draft = el.querySelector('[aria-label="agent draft"]'); draft.value = 'still here';
    await click('.agent-close');
    expect(visible('.side-panel')).toBe(false);
    await click('[aria-label="CoreAgent"]');
    expect(visible('.side-panel')).toBe(true);
    expect(el.querySelector('[aria-label="agent draft"]')).toBe(draft);
    expect(draft.value).toBe('still here');
  });
  it('focuses the integrated agent close button in a narrow overlay', async () => {
    setWidth(390); await mount();
    await click('[aria-label="CoreAgent"]');
    expect(document.activeElement).toBe(el.querySelector('.agent-close'));
    await click('.agent-close');
    expect(visible('.side-panel')).toBe(false);
    expect(document.activeElement).toBe(el.querySelector('[aria-label="CoreAgent"]'));
  });

  it('focus mode enters real page fullscreen and preserves panels, layout preferences and DOM state', async () => {
    state.store.sidebar = 'agent'; await mount();
    const draft = el.querySelector('[aria-label="agent draft"]'); draft.value = 'unsent instruction';
    const pdf = el.querySelector('[aria-label="pdf state"]'); pdf.value = 'page 9';
    const doc = el.querySelector('[aria-label="document"]'); doc.value = 'manual text';
    localStorage.setItem('corelatex.sideWidth', '320');
    const sideWidth = el.querySelector('.side-panel').style.width;
    await click('.focus-toggle');
    expect(document.documentElement.requestFullscreen).toHaveBeenCalledOnce();
    expect(document.fullscreenElement).toBe(document.documentElement);
    expect(visible('.side-panel')).toBe(true); expect(visible('.right-drawer')).toBe(true);
    expect(el.querySelector('.side-panel').style.width).toBe(sideWidth);
    expect(localStorage.getItem('corelatex.sideWidth')).toBe('320');
    expect(state.store.sidebar).toBe('agent'); expect(state.store.rightTab).toBe('pdf');
    expect(el.querySelector('.focus-toggle').getAttribute('aria-pressed')).toBe('true');
    // Native browser Esc can exit fullscreen without dispatching a page keydown.
    changeFullscreen(null); await flush();
    expect(el.querySelector('.focus-toggle').getAttribute('aria-pressed')).toBe('false');
    expect(visible('.side-panel')).toBe(true); expect(visible('.right-drawer')).toBe(true);
    expect(el.querySelector('[aria-label="agent draft"]')).toBe(draft); expect(draft.value).toBe('unsent instruction');
    expect(el.querySelector('[aria-label="pdf state"]')).toBe(pdf); expect(pdf.value).toBe('page 9');
    expect(el.querySelector('[aria-label="document"]')).toBe(doc); expect(doc.value).toBe('manual text');
  });
  it('exits real fullscreen with the button or keyboard shortcut without changing the selected panes', async () => {
    await mount(); await click('.focus-toggle');
    await click('.focus-toggle');
    expect(document.exitFullscreen).toHaveBeenCalledOnce();
    expect(document.fullscreenElement).toBeNull();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F', ctrlKey: true, shiftKey: true, cancelable: true })); await flush();
    expect(document.documentElement.requestFullscreen).toHaveBeenCalledTimes(2);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })); await flush();
    expect(document.exitFullscreen).toHaveBeenCalledTimes(2);
    expect(state.store.sidebar).toBe('tree'); expect(state.store.rightTab).toBe('pdf');
  });
  it('continues normal pane controls and layout reset while in fullscreen', async () => {
    await mount(); await click('.focus-toggle');
    await click('[aria-label="CoreAgent"]');
    expect(state.store.sidebar).toBe('agent'); expect(visible('.side-panel')).toBe(true);
    await click('header [aria-label="项目信息"]');
    expect(state.store.rightTab).toBe('info'); expect(visible('.right-drawer')).toBe(true);
    await click('[aria-label="恢复默认布局"]');
    expect(document.fullscreenElement).toBe(document.documentElement);
    expect(document.exitFullscreen).not.toHaveBeenCalled();
    expect(el.querySelector('.focus-toggle').getAttribute('aria-pressed')).toBe('true');
  });
  it('reports unsupported or denied fullscreen without hiding any content or pretending to enter', async () => {
    Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value: false });
    await mount(); await click('.focus-toggle');
    expect(state.error).toHaveBeenCalledWith(expect.stringContaining('不支持'));
    expect(document.documentElement.requestFullscreen).not.toHaveBeenCalled();
    expect(el.querySelector('.focus-toggle').getAttribute('aria-pressed')).toBe('false');
    Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value: true });
    document.documentElement.requestFullscreen.mockRejectedValueOnce(new Error('permission denied'));
    await click('.focus-toggle');
    expect(state.error).toHaveBeenLastCalledWith(expect.stringContaining('未允许'));
    expect(el.querySelector('.focus-toggle').getAttribute('aria-pressed')).toBe('false');
    expect(visible('.side-panel')).toBe(true); expect(visible('.right-drawer')).toBe(true);
    expect(el.querySelector('.focus-toggle').disabled).toBe(false);
  });
  it('prevents repeated fullscreen requests while the browser is deciding and exits on navigation', async () => {
    let finish;
    document.documentElement.requestFullscreen.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await mount(); await click('.focus-toggle'); await click('.focus-toggle');
    expect(document.documentElement.requestFullscreen).toHaveBeenCalledOnce();
    expect(el.querySelector('.focus-toggle').disabled).toBe(true);
    expect(el.querySelector('.focus-toggle').getAttribute('aria-pressed')).toBe('false');
    changeFullscreen(document.documentElement); finish(); await flush();
    expect(el.querySelector('.focus-toggle').disabled).toBe(false);
    app.unmount(); app = null;
    expect(document.exitFullscreen).toHaveBeenCalledOnce();
  });
  it('does not leave a new route fullscreen if a pending browser request finishes after navigation', async () => {
    let finish;
    document.documentElement.requestFullscreen.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await mount(); await click('.focus-toggle');
    app.unmount(); app = null;
    changeFullscreen(document.documentElement); finish(); await flush();
    expect(document.exitFullscreen).toHaveBeenCalledOnce();
    expect(document.fullscreenElement).toBeNull();
  });
  it('small windows start with the editor visible and allow dismissible mutually exclusive overlays', async () => {
    setWidth(390); await mount();
    expect(visible('.side-panel')).toBe(false); expect(visible('.right-drawer')).toBe(false);
    await click('[aria-label="项目树"]'); expect(visible('.side-panel')).toBe(true);
    await click('[aria-label="CoreAgent"]'); expect(visible('.side-panel')).toBe(true); expect(state.store.sidebar).toBe('agent');
    await click('header [aria-label="PDF 预览"]'); expect(visible('.right-drawer')).toBe(true); expect(visible('.side-panel')).toBe(false);
    await click('header [aria-label="项目信息"]'); expect(visible('.right-drawer')).toBe(true); expect(state.store.rightTab).toBe('info');
    await click('.panel-backdrop'); expect(visible('.right-drawer')).toBe(false);
    await click('[aria-label="项目树"]');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); await flush();
    expect(visible('.side-panel')).toBe(false); expect(el.querySelector('.panel-backdrop')).toBeNull();
    expect(state.store.sidebar).toBe('tree'); expect(state.store.rightTab).toBe('info');
  });
  it('keyboard separators resize in physical directions and double click restores defaults', async () => {
    await mount();
    const left = el.querySelector('[aria-label="左侧面板宽度"]');
    left.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' })); await flush();
    expect(left.getAttribute('aria-valuenow')).toBe('304');
    const right = el.querySelector('[aria-label="右侧面板宽度"]');
    right.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' })); await flush();
    expect(right.getAttribute('aria-valuenow')).toBe('496');
    expect(Number(localStorage.getItem('corelatex.rightWidthRatio'))).toBeCloseTo(496 / 1440, 6);
    expect(localStorage.getItem('corelatex.rightWidth')).toBeNull();
    right.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); await flush();
    expect(right.getAttribute('aria-valuenow')).toBe('480');
  });
  it('persists dragged desktop ratios through monitor changes, tab switches and a mobile overlay', async () => {
    await mount();
    const left = el.querySelector('[aria-label="左侧面板宽度"]');
    left.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    const right = el.querySelector('[aria-label="右侧面板宽度"]');
    right.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' })); await flush();
    const sideRatio = Number(localStorage.getItem('corelatex.sideWidthRatio'));
    const rightRatio = Number(localStorage.getItem('corelatex.rightWidthRatio'));
    setWidth(3440); await flush();
    expect(el.querySelector('.side-panel').style.width).toBe(Math.round(3440 * sideRatio) + 'px');
    expect(el.querySelector('.right-drawer').style.width).toBe(Math.round(3440 * rightRatio) + 'px');
    await click('header [aria-label="项目信息"]');
    expect(el.querySelector('.right-drawer').style.width).toBe(Math.round(3440 * rightRatio) + 'px');
    setWidth(390); await flush(); await click('header [aria-label="项目信息"]');
    expect(parseInt(el.querySelector('.right-drawer').style.width)).toBeGreaterThan(195);
    expect(Number(localStorage.getItem('corelatex.sideWidthRatio'))).toBe(sideRatio);
    expect(Number(localStorage.getItem('corelatex.rightWidthRatio'))).toBe(rightRatio);
    setWidth(2560); await flush();
    expect(el.querySelector('.side-panel').style.width).toBe(Math.round(2560 * sideRatio) + 'px');
    expect(el.querySelector('.right-drawer').style.width).toBe(Math.round(2560 * rightRatio) + 'px');
  });
  it('migrates legacy pixel widths on entry and allows a 50% ultrawide PDF pane', async () => {
    setWidth(3440); localStorage.setItem('corelatex.sideWidth', '280'); localStorage.setItem('corelatex.rightWidth', '720');
    await mount();
    expect(el.querySelector('.right-drawer').style.width).toBe('1720px');
    expect(el.querySelector('.side-panel').style.width).toBe('669px');
    expect(el.querySelector('[aria-label="右侧面板宽度"]').getAttribute('aria-valuetext')).toBe('50.0% 页面宽度');
    expect(localStorage.getItem('corelatex.rightWidthRatio')).toBe('0.5');
    expect(localStorage.getItem('corelatex.rightWidth')).toBeNull();
  });
  it('restoring defaults clears only layout preferences and does not reset document state', async () => {
    localStorage.setItem('corelatex.sideWidth', '99999'); localStorage.setItem('corelatex.rightWidth', '99999'); localStorage.setItem('corelatex.reviewMode', '1');
    await mount(); const doc = el.querySelector('[aria-label="document"]'); doc.value = 'keep this';
    await click('[aria-label="恢复默认布局"]');
    expect(localStorage.getItem('corelatex.sideWidth')).toBeNull(); expect(localStorage.getItem('corelatex.rightWidth')).toBeNull();
    expect(localStorage.getItem('corelatex.sideWidthRatio')).toBeNull(); expect(localStorage.getItem('corelatex.rightWidthRatio')).toBeNull();
    expect(localStorage.getItem('corelatex.reviewMode')).toBe('1'); expect(doc.value).toBe('keep this'); expect(state.store.reset).not.toHaveBeenCalled();
  });
  it('respects shortcuts already handled by the editor and leaves focused dialogs alone', async () => {
    await mount(); await click('.focus-toggle');
    const handled = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    handled.preventDefault(); el.querySelector('[aria-label="document"]').dispatchEvent(handled); await flush();
    expect(el.querySelector('.focus-toggle').getAttribute('aria-pressed')).toBe('true');
    const dialog = document.createElement('div'); dialog.setAttribute('role', 'dialog'); el.appendChild(dialog);
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await flush();
    expect(el.querySelector('.focus-toggle').getAttribute('aria-pressed')).toBe('true');
    dialog.remove();
  });
  it('moves focus into an overlay, traps Tab, and restores the opener when Esc closes it', async () => {
    setWidth(390); await mount();
    const opener = el.querySelector('[aria-label="项目树"]'); opener.focus();
    await click('[aria-label="项目树"]');
    const close = el.querySelector('[aria-label="关闭左侧面板"]');
    expect(document.activeElement).toBe(close);
    expect(el.querySelector('.center').hasAttribute('inert')).toBe(true);
    close.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
    expect(el.querySelector('.side-panel').contains(document.activeElement)).toBe(true);
    const last = document.activeElement;
    last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(close);
    close.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); await flush();
    expect(document.activeElement).toBe(opener); expect(el.querySelector('.center').hasAttribute('inert')).toBe(false);
    await click('[aria-label="项目树"]');
    state.store.setRightTab('info'); await flush();
    expect(document.activeElement).toBe(el.querySelector('[aria-label="关闭右侧面板"]'));
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); await flush();
    expect(document.activeElement).toBe(opener);
    const pdfOpener = el.querySelector('header [aria-label="PDF 预览"]'); pdfOpener.focus(); await click('header [aria-label="PDF 预览"]');
    expect(document.activeElement).toBe(el.querySelector('[aria-label="关闭右侧面板"]'));
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); await flush();
    expect(document.activeElement).toBe(pdfOpener);
  });
  it('keeps compact read-only and archived badges available on narrow screens', async () => {
    setWidth(390); state.store.myRole = 'viewer'; await mount();
    expect(el.querySelector('.badge-short').textContent).toBe('只读');
    state.store.project.archived = true; await flush();
    expect(el.querySelector('.badge-short').textContent).toBe('归档·只读');
    expect(el.querySelector('.badge').getAttribute('title')).toBe('已归档（只读）');
  });
  it('viewport contraction closes overlays without changing the selected panels', async () => {
    await mount(); setWidth(390); await flush();
    expect(visible('.side-panel')).toBe(false); expect(visible('.right-drawer')).toBe(false);
    setWidth(1440); await flush(); expect(visible('.side-panel')).toBe(true); expect(visible('.right-drawer')).toBe(true);
  });
});
