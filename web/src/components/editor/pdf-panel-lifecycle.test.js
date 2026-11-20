// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, h, KeepAlive, nextTick, provide, reactive, ref } from 'vue';
import PdfPanel from './PdfPanel.vue';
import RightDrawer from './RightDrawer.vue';
import { PROJECT_CONTEXT } from '../../lib/projectContext.js';
import { loadPdf, renderPage } from '../../lib/pdfDocument.js';
import { api } from '../../api.js';

const fixture = vi.hoisted(() => ({ store: null, ui: { error: vi.fn(), toast: vi.fn() } }));
vi.mock('../../stores/editor.js', () => ({ useEditorStore: () => fixture.store }));
vi.mock('../../stores/agent.js', () => ({ useAgentStore: () => ({ streaming: false }) }));
vi.mock('../../stores/ui.js', () => ({ useUiStore: () => fixture.ui }));
vi.mock('../../api.js', () => ({ getToken: () => 'fixture-token', api: { raw: vi.fn(), get: vi.fn() } }));
vi.mock('./InfoPanel.vue', () => ({ default: { render: () => null } }));
vi.mock('../../lib/pdfDocument.js', () => ({ loadPdf: vi.fn(), renderPage: vi.fn() }));

let app, el, showing, fetchPdf, observers, resizeObservers, contextActive;
const flush = async () => { for (let i = 0; i < 12; i++) { await Promise.resolve(); await nextTick(); } };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const response = (id) => ({ ok: true, arrayBuffer: async () => new Uint8Array([id]).buffer });
const documentFixture = (numPages) => ({
  numPages, destroy: vi.fn().mockResolvedValue(),
  getPage: vi.fn().mockResolvedValue({ getViewport: () => ({ width: 600, height: 800 }) }),
});

beforeEach(() => {
  vi.useFakeTimers(); localStorage.clear(); vi.clearAllMocks(); observers = []; resizeObservers = [];
  fixture.store = reactive({ projectId: 'alpha', project: { compileEngine: 'xelatex' }, pdfStamp: 0,
    compile: { status: 'success', pdfUrl: '/alpha.pdf', errors: [], warnings: [] }, compileProject: vi.fn() });
  fixture.store.saveCompileSettings = vi.fn(async settings => {
    if (settings.engine !== undefined) fixture.store.project.compileEngine = settings.engine;
    if (settings.texVersion !== undefined) fixture.store.project.texVersion = settings.texVersion;
    return true;
  });
  api.get.mockResolvedValue({ defaultVersion: '2024', versions: [{ version: '2024', label: 'TeX Live 2024', available: true, enabled: true }] });
  fetchPdf = vi.fn(); vi.stubGlobal('fetch', fetchPdf);
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback) { this.callback = callback; this.observe = vi.fn(); this.disconnect = vi.fn(); resizeObservers.push(this); }
  });
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback) { this.callback = callback; this.observe = vi.fn(); this.unobserve = vi.fn(); this.disconnect = vi.fn(); observers.push(this); }
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: vi.fn(), getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, 255]) }),
  });
  renderPage.mockImplementation(async (doc, page) => ({ page: await doc.getPage(page), task: { promise: Promise.resolve(), cancel: vi.fn() } }));
});
afterEach(() => {
  app?.unmount(); el?.remove(); app = null; el = null;
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

async function mountPanel() {
  showing = ref(true); contextActive = ref(true);
  const Other = { render: () => h('div', 'Other project') };
  app = createApp({ setup() { provide(PROJECT_CONTEXT, { active: contextActive }); }, render: () => h(KeepAlive, null, { default: () => showing.value ? h(PdfPanel, { key: 'alpha' }) : h(Other, { key: 'other' }) }) });
  el = document.createElement('div'); document.body.appendChild(el); app.mount(el);
  const scroll = el.querySelector('.pdf-scroll');
  Object.defineProperties(scroll, { clientWidth: { configurable: true, value: 700 }, clientHeight: { configurable: true, value: 600 }, scrollHeight: { configurable: true, value: 2400 } });
  await flush();
  return scroll;
}

describe('project-cached PDF lifecycle', () => {
  it('keeps the same PDF, canvas, page and reading position while inactive and defers background updates', async () => {
    const original = documentFixture(3), replacement = documentFixture(4);
    loadPdf.mockResolvedValueOnce(original).mockResolvedValueOnce(replacement);
    fetchPdf.mockResolvedValueOnce(response(1)).mockResolvedValueOnce(response(2));
    const scroll = await mountPanel();
    for (const wrap of el.querySelectorAll('.page-wrap')) Object.defineProperties(wrap, {
      offsetTop: { configurable: true, value: (Number(wrap.dataset.page) - 1) * 800 }, offsetHeight: { configurable: true, value: 800 },
    });
    const input = el.querySelector('.page-input');
    input.value = '2'; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
    await flush();
    scroll.scrollTop = 915; scroll.dispatchEvent(new Event('scroll'));
    const canvas = el.querySelector('canvas');
    showing.value = false; await flush();
    expect(original.destroy).not.toHaveBeenCalled();
    expect(resizeObservers[0].disconnect).toHaveBeenCalled();
    expect(observers[0].disconnect).toHaveBeenCalled();
    const measured = resizeObservers[0].observe.mock.calls.length;
    await vi.advanceTimersByTimeAsync(3000);
    expect(fetchPdf).toHaveBeenCalledTimes(1);
    expect(resizeObservers[0].observe).toHaveBeenCalledTimes(measured);
    showing.value = true; await flush();
    expect(el.querySelector('canvas')).toBe(canvas);
    expect(el.querySelector('.page-input')).toBe(input);
    expect(input.value).toBe('2');
    expect(scroll.scrollTop).toBe(915);
    expect(fetchPdf).toHaveBeenCalledTimes(1);
    showing.value = false; await flush();
    fixture.store.compile.pdfUrl = '/alpha-new.pdf'; fixture.store.pdfStamp++;
    await flush(); expect(fetchPdf).toHaveBeenCalledTimes(1);
    showing.value = true; await flush();
    expect(fetchPdf).toHaveBeenCalledTimes(2);
    expect(el.querySelector('.pager').textContent).toContain('/4');
    expect(original.destroy).toHaveBeenCalledOnce();
  });

  it('preserves a page and numeric zoom when context visibility changes before geometry collapses to zero', async () => {
    loadPdf.mockResolvedValue(documentFixture(3)); fetchPdf.mockResolvedValue(response(1));
    const scroll = await mountPanel();
    for (const wrap of el.querySelectorAll('.page-wrap')) Object.defineProperties(wrap, { offsetTop: { configurable: true, value: (Number(wrap.dataset.page) - 1) * 800 }, offsetHeight: { configurable: true, value: 800 } });
    scroll.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: -10, cancelable: true })); await flush();
    const zoom = el.querySelector('.pct').textContent;
    scroll.scrollTop = 1080; scroll.scrollLeft = 90;
    contextActive.value = false;
    Object.defineProperties(scroll, { clientWidth: { configurable: true, value: 0 }, clientHeight: { configurable: true, value: 0 } });
    scroll.scrollTop = 0; scroll.scrollLeft = 0; scroll.dispatchEvent(new Event('scroll')); showing.value = false; await flush();
    Object.defineProperties(scroll, { clientWidth: { configurable: true, value: 700 }, clientHeight: { configurable: true, value: 600 } });
    contextActive.value = true; showing.value = true; await flush();
    expect(scroll.scrollTop).toBe(1080); expect(scroll.scrollLeft).toBe(90); expect(el.querySelector('.pct').textContent).toBe(zoom);
  });

  it('caches the PDF document, page, zoom and canvas across drawer tab changes and closing the drawer', async () => {
    loadPdf.mockResolvedValue(documentFixture(4)); fetchPdf.mockResolvedValue(response(1));
    fixture.store.rightTab = 'pdf';
    const visible = ref(true); app = createApp({ render: () => h(RightDrawer, { visible: visible.value }) });
    app.component('el-icon', { render() { return h('span', this.$slots.default?.()); } });
    el = document.createElement('div'); document.body.appendChild(el); app.mount(el);
    const scroll = el.querySelector('.pdf-scroll');
    Object.defineProperties(scroll, { clientWidth: { configurable: true, value: 700 }, clientHeight: { configurable: true, value: 600 }, scrollHeight: { configurable: true, value: 3200 } });
    await flush();
    const input = el.querySelector('.page-input'); input.value = '3'; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
    scroll.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: -10, cancelable: true })); await flush();
    const canvas = el.querySelector('canvas'), zoom = el.querySelector('.pct').textContent;
    fixture.store.rightTab = 'info'; await flush(); fixture.store.rightTab = 'pdf'; await flush();
    expect(el.querySelector('canvas')).toBe(canvas); expect(el.querySelector('.page-input').value).toBe('3'); expect(el.querySelector('.pct').textContent).toBe(zoom); expect(fetchPdf).toHaveBeenCalledTimes(1);
    fixture.store.rightTab = null; await flush(); fixture.store.rightTab = 'pdf'; await flush();
    expect(el.querySelector('canvas')).toBe(canvas); expect(el.querySelector('.page-input').value).toBe('3'); expect(fetchPdf).toHaveBeenCalledTimes(1);
  });

  it('discards an older parsed document that resolves after the newest compilation', async () => {
    const oldLoad = deferred();
    const obsolete = documentFixture(1), newest = documentFixture(7);
    fetchPdf.mockResolvedValueOnce(response(1)).mockResolvedValueOnce(response(2));
    loadPdf.mockImplementationOnce(() => oldLoad.promise).mockResolvedValueOnce(newest);
    await mountPanel();
    const firstSignal = fetchPdf.mock.calls[0][1].signal;
    fixture.store.compile.pdfUrl = '/newest.pdf'; fixture.store.pdfStamp++;
    await flush();
    expect(firstSignal.aborted).toBe(true);
    expect(el.querySelector('.pager').textContent).toContain('/7');
    oldLoad.resolve(obsolete); await flush();
    expect(obsolete.destroy).toHaveBeenCalledOnce();
    expect(newest.destroy).not.toHaveBeenCalled();
    expect(el.querySelector('.pager').textContent).toContain('/7');
  });

  it('aborts downloads and destroys late PDF proxies after unmount', async () => {
    const lateLoad = deferred(), lateDocument = documentFixture(2);
    fetchPdf.mockResolvedValueOnce(response(1)); loadPdf.mockImplementationOnce(() => lateLoad.promise);
    await mountPanel();
    const signal = fetchPdf.mock.calls[0][1].signal;
    app.unmount(); app = null;
    expect(signal.aborted).toBe(true);
    lateLoad.resolve(lateDocument); await flush();
    expect(lateDocument.destroy).toHaveBeenCalledOnce();
  });
});


describe('PDF TeX Live version selection', () => {
  it('offers only enabled and available versions, saves the selection and waits for an explicit compile', async () => {
    fixture.store.project.texVersion = '2024';
    api.get.mockResolvedValue({ defaultVersion: '2024', versions: [
      { version: '2024', label: 'TeX Live 2024', available: true, enabled: true },
      { version: '2025', label: 'TeX Live 2025', available: true, enabled: true },
      { version: '2023', label: 'TeX Live 2023', available: true, enabled: false },
      { version: '2026', label: 'TeX Live 2026', available: false, enabled: true },
    ] });
    loadPdf.mockResolvedValue(documentFixture(1)); fetchPdf.mockResolvedValue(response(1));
    await mountPanel(); const select = el.querySelector('[aria-label="TeX Live 版本"]');
    expect([...select.options].map(option => option.value)).toEqual(['2024', '2025']);
    expect(select.value).toBe('2024'); select.value = '2025'; select.dispatchEvent(new Event('change')); await flush();
    expect(fixture.store.saveCompileSettings).toHaveBeenCalledWith({ texVersion: '2025' });
    expect(fixture.store.compileProject).not.toHaveBeenCalled();
    expect(fixture.store.project.texVersion).toBe('2025');
    expect(fixture.ui.toast).not.toHaveBeenCalled();
    expect(el.querySelector('.compile-settings-notice')).toBeNull();
    el.querySelector('button.primary.small').click(); await flush();
    expect(fixture.store.compileProject).toHaveBeenCalledWith('xelatex', '2025');
  });
  it('retains an unavailable project version visibly instead of silently changing its environment', async () => {
    fixture.store.project.texVersion = '2023';
    loadPdf.mockResolvedValue(documentFixture(1)); fetchPdf.mockResolvedValue(response(1));
    await mountPanel(); const select = el.querySelector('[aria-label="TeX Live 版本"]');
    expect(select.value).toBe('2023'); expect(select.options[0].disabled).toBe(true); expect(select.options[0].text).toContain('暂不可用');
    expect(fixture.store.compileProject).not.toHaveBeenCalled();
  });
  it('provides a retry after the versions request fails without blocking PDF rendering', async () => {
    api.get.mockRejectedValueOnce(new Error('offline')); loadPdf.mockResolvedValue(documentFixture(1)); fetchPdf.mockResolvedValue(response(1));
    await mountPanel(); expect(el.querySelector('.runtime-error').textContent).toContain('重试'); expect(el.querySelector('canvas')).not.toBeNull();
    el.querySelector('.runtime-error button').click(); await flush(); expect(el.querySelector('.runtime-error')).toBeNull();
  });
});



describe('PDF compile settings feedback', () => {
  it('stays quiet on load, focus, unchanged selection and project refresh', async () => {
    loadPdf.mockResolvedValue(documentFixture(1)); fetchPdf.mockResolvedValue(response(1));
    await mountPanel();
    const engine = el.querySelector('[aria-label="编译引擎"]');
    engine.dispatchEvent(new Event('focus'));
    engine.dispatchEvent(new Event('change'));
    fixture.store.project = { compileEngine: 'pdflatex', texVersion: '2024' };
    await flush();
    expect(fixture.store.saveCompileSettings).not.toHaveBeenCalled();
    expect(fixture.ui.toast).not.toHaveBeenCalled();
  });

  it('keeps a delayed successful save silent after leaving the panel', async () => {
    loadPdf.mockResolvedValue(documentFixture(1)); fetchPdf.mockResolvedValue(response(1));
    const pending = deferred(); fixture.store.saveCompileSettings.mockReturnValueOnce(pending.promise);
    await mountPanel();
    const engine = el.querySelector('[aria-label="编译引擎"]');
    engine.value = 'lualatex'; engine.dispatchEvent(new Event('change')); await flush();
    expect(fixture.ui.toast).not.toHaveBeenCalled();
    contextActive.value = false; await flush();
    pending.resolve(true); await flush();
    expect(fixture.ui.toast).not.toHaveBeenCalled();
  });
});

describe('PDF compile settings during concurrent work', () => {
  const runtimeOptions = { versions: [
    { version: '2024', label: 'TeX Live 2024', available: true, enabled: true },
    { version: '2025', label: 'TeX Live 2025', available: true, enabled: true },
  ] };

  it('allows a version switch while compiling and saves it for the next compilation', async () => {
    fixture.store.project.texVersion = '2024'; fixture.store.compile.status = 'running';
    api.get.mockResolvedValue(runtimeOptions);
    loadPdf.mockResolvedValue(documentFixture(1)); fetchPdf.mockResolvedValue(response(1));
    const pending = deferred();
    fixture.store.saveCompileSettings.mockImplementationOnce(async settings => {
      await pending.promise;
      fixture.store.project.texVersion = settings.texVersion;
      return true;
    });
    await mountPanel();
    const select = el.querySelector('[aria-label="TeX Live 版本"]');
    const engine = el.querySelector('[aria-label="编译引擎"]');
    expect(select.disabled).toBe(false); expect(engine.disabled).toBe(false);
    select.value = '2025'; select.dispatchEvent(new Event('change')); await flush();
    expect(fixture.store.saveCompileSettings).toHaveBeenCalledWith({ texVersion: '2025' });
    expect(select.disabled).toBe(true); expect(engine.disabled).toBe(true);
    expect(fixture.store.compileProject).not.toHaveBeenCalled();
    pending.resolve(); await flush();
    expect(select.disabled).toBe(false); expect(select.value).toBe('2025');
    expect(fixture.ui.toast).not.toHaveBeenCalled();
    expect(fixture.store.compileProject).not.toHaveBeenCalled();
  });

  it('restores the previous selection and exposes the server error when saving fails', async () => {
    fixture.store.project.texVersion = '2024'; api.get.mockResolvedValue(runtimeOptions);
    fixture.store.saveCompileSettings.mockRejectedValueOnce(new Error('该版本未启用'));
    loadPdf.mockResolvedValue(documentFixture(1)); fetchPdf.mockResolvedValue(response(1));
    await mountPanel(); const select = el.querySelector('[aria-label="TeX Live 版本"]');
    select.value = '2025'; select.dispatchEvent(new Event('change')); await flush();
    expect(fixture.ui.error).toHaveBeenCalledWith('该版本未启用');
    expect(select.value).toBe('2024'); expect(select.disabled).toBe(false);
    expect(fixture.store.project.texVersion).toBe('2024');
    expect(fixture.store.compileProject).not.toHaveBeenCalled();
  });

  it('clears a pending save after switching projects and ignores its late result', async () => {
    fixture.store.project.texVersion = '2024'; api.get.mockResolvedValue(runtimeOptions);
    loadPdf.mockResolvedValue(documentFixture(1)); fetchPdf.mockResolvedValue(response(1));
    const pending = deferred(); fixture.store.saveCompileSettings.mockReturnValueOnce(pending.promise);
    await mountPanel(); const select = el.querySelector('[aria-label="TeX Live 版本"]');
    select.value = '2025'; select.dispatchEvent(new Event('change')); await flush();
    expect(select.disabled).toBe(true);
    fixture.store.projectId = 'beta';
    fixture.store.project = { texVersion: '2024', compileEngine: 'pdflatex' };
    await flush();
    expect(select.disabled).toBe(false); expect(select.value).toBe('2024');
    const next = deferred();
    fixture.store.saveCompileSettings.mockImplementationOnce(async settings => {
      await next.promise; fixture.store.project.texVersion = settings.texVersion; return true;
    });
    select.value = '2025'; select.dispatchEvent(new Event('change')); await flush();
    expect(select.disabled).toBe(true);
    pending.resolve(false); await flush();
    expect(select.disabled).toBe(true); // The old response cannot end the new save.
    expect(fixture.ui.error).not.toHaveBeenCalled();
    next.resolve(); await flush();
    expect(select.disabled).toBe(false); expect(select.value).toBe('2025');
    expect(fixture.store.saveCompileSettings).toHaveBeenLastCalledWith({ texVersion: '2025' });
  });

  it('ignores an old save error after the same project identifier is reopened', async () => {
    fixture.store.project.texVersion = '2024'; fixture.store.projectVersion = 1; api.get.mockResolvedValue(runtimeOptions);
    loadPdf.mockResolvedValue(documentFixture(1)); fetchPdf.mockResolvedValue(response(1));
    const pending = deferred(); fixture.store.saveCompileSettings.mockReturnValueOnce(pending.promise);
    await mountPanel(); const select = el.querySelector('[aria-label="TeX Live 版本"]');
    select.value = '2025'; select.dispatchEvent(new Event('change')); await flush();
    fixture.store.projectVersion = 2;
    fixture.store.project = { texVersion: '2024', compileEngine: 'pdflatex' };
    await flush();
    expect(select.disabled).toBe(false); expect(select.value).toBe('2024');
    pending.reject(new Error('旧请求失败')); await flush();
    expect(fixture.ui.error).not.toHaveBeenCalled();
    expect(select.disabled).toBe(false); expect(select.value).toBe('2024');
  });
});

describe('PDF runtime initialization', () => {
  it('loads runtimes when asynchronous project initialization supplies the project id', async () => {
    fixture.store.projectId = null; fixture.store.project.texVersion = 'system'; fixture.store.compile.status = 'idle'; fixture.store.compile.pdfUrl = '';
    api.get.mockResolvedValue({ versions: [{ version: 'system', label: '系统 TeX Live 2023（兼容）', detectedVersion: '2023', available: true, enabled: true }] });
    await mountPanel(); expect(api.get).not.toHaveBeenCalled();
    fixture.store.projectId = 'alpha'; await flush();
    expect(api.get).toHaveBeenCalledWith('/api/tex/runtimes');
    const select = el.querySelector('[aria-label="TeX Live 版本"]');
    expect(select.options[0].disabled).toBe(false); expect(select.textContent).toContain('2023'); expect(select.textContent).not.toContain('暂不可用');
  });
  it('retries after a project switch and ignores the older runtime response', async () => {
    const old = deferred(); api.get.mockReturnValueOnce(old.promise).mockResolvedValue({ versions: [{ version: '2024', label: 'TeX Live 2024', available: true, enabled: true }] });
    fixture.store.compile.status = 'idle'; fixture.store.compile.pdfUrl = '';
    await mountPanel(); fixture.store.projectId = 'beta'; await flush();
    old.resolve({ versions: [{ version: '2024', available: false, enabled: false }] }); await flush();
    expect(el.querySelector('[aria-label="TeX Live 版本"]').options[0].disabled).toBe(false);
  });
});


describe('PDF request failures', () => {
  it('shows actionable service errors without offering document edits for a network or quota failure', async () => {
    fixture.store.compile.status = 'failed'; fixture.store.compile.pdfUrl = '';
    fixture.store.compile.errors = [{ file: '', line: 0, source: 'request', message: '编译额度不足' }];
    await mountPanel();
    expect(el.querySelector('.issues .msg').textContent).toBe('编译额度不足');
    expect(el.querySelector('.issues .loc')).toBeNull();
    expect(el.querySelector('.issues .ai-fix')).toBeNull();
    fixture.store.compile.errors = [{ file: 'main.tex', line: 7, message: 'Undefined control sequence' }];
    await flush();
    expect(el.querySelector('.issues .loc').textContent).toBe('main.tex:7');
    expect(el.querySelector('.issues .ai-fix')).not.toBeNull();
  });
});
