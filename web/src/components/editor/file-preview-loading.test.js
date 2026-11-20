// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, h, nextTick, provide, reactive, ref } from 'vue';
import FilePreview from './FilePreview.vue';
import { PROJECT_CONTEXT } from '../../lib/projectContext.js';
import { api } from '../../api.js';
import { loadPdf, renderPage } from '../../lib/pdfDocument.js';
vi.mock('../../api.js', () => ({ getToken: () => 'test token', api: { raw: vi.fn() } }));
vi.mock('../../lib/pdfDocument.js', () => ({ loadPdf: vi.fn(), renderPage: vi.fn() }));
let app, el, props, active, downloads;
const flush = async () => { for (let i = 0; i < 10; i++) { await Promise.resolve(); await nextTick(); } };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const blobResponse = () => ({ blob: async () => ({ arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }) });
const pdf = () => ({ numPages: 2, destroy: vi.fn().mockResolvedValue(), getPage: vi.fn().mockResolvedValue({ getViewport: () => ({ width: 600 }) }) });
async function mount(path, visible = true) {
  props = reactive({ projectId: 'project-alpha', path }); active = ref(visible);
  app = createApp({ setup() { provide(PROJECT_CONTEXT, { active }); return () => h(FilePreview, props); } });
  el = document.createElement('div'); document.body.appendChild(el); app.mount(el); await flush();
}
beforeEach(() => {
  vi.resetAllMocks(); downloads = [];
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function() { downloads.push(this.href); });
  let serial = 0;
  vi.stubGlobal('URL', class extends URL { static createObjectURL() { return 'blob:preview-' + ++serial; } static revokeObjectURL = vi.fn(); });
  api.raw.mockResolvedValue(blobResponse());
  loadPdf.mockResolvedValue(pdf());
  renderPage.mockResolvedValue({ task: { promise: Promise.resolve(), cancel: vi.fn() } });
});
afterEach(() => { app?.unmount(); el?.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('on-demand file previews', () => {
  it('does not download archives before an explicit download click', async () => {
    await mount('_workspace/huge data.zip');
    expect(api.raw).not.toHaveBeenCalled();
    el.querySelector('.download-button').click();
    expect(api.raw).not.toHaveBeenCalled();
    const url = new URL(downloads[0]);
    expect(url.searchParams.get('path')).toBe('_workspace/huge data.zip');
    expect(url.searchParams.get('download')).toBe('1');
    expect(url.searchParams.get('token')).toBe('test token');
  });
  it('lets the browser request media metadata without a whole-file Blob', async () => {
    await mount('_workspace/video.mp4');
    expect(api.raw).not.toHaveBeenCalled();
    expect(el.querySelector('video').getAttribute('preload')).toBe('metadata');
    expect(el.querySelector('video').src).toContain('/file?path=');
  });
  it('aborts obsolete requests and destroys a parsed PDF that arrives after changing files', async () => {
    const parsed = deferred(), old = pdf(); loadPdf.mockReturnValueOnce(parsed.promise);
    await mount('_workspace/large.pdf');
    const signal = api.raw.mock.calls[0][1].signal;
    props.path = '_workspace/chart.png'; await flush();
    expect(signal.aborted).toBe(true);
    parsed.resolve(old); await flush();
    expect(old.destroy).toHaveBeenCalledOnce();
    expect(el.querySelector('.image-stage img')).not.toBeNull();
    expect(el.querySelector('.pdf-stage')).toBeNull();
  });
  it('does not fetch hidden files and resumes only the latest selection', async () => {
    await mount('_workspace/a.png', false); expect(api.raw).not.toHaveBeenCalled();
    props.path = '_workspace/b.png'; await flush(); expect(api.raw).not.toHaveBeenCalled();
    active.value = true; await flush();
    expect(api.raw).toHaveBeenCalledTimes(1);
    expect(api.raw.mock.calls[0][0]).toContain('b.png');
  });
  it('renders a requested PDF page once and aborts pending loads on unmount', async () => {
    await mount('report.pdf'); expect(renderPage).toHaveBeenCalledTimes(1);
    el.querySelectorAll('.pdf-toolbar button')[1].click(); await flush();
    expect(renderPage).toHaveBeenCalledTimes(2);
    const pending = deferred(); api.raw.mockReturnValueOnce(pending.promise);
    props.path = 'next.png'; await flush();
    const signal = api.raw.mock.calls.at(-1)[1].signal;
    app.unmount(); app = null;
    expect(signal.aborted).toBe(true);
    pending.resolve(blobResponse()); await flush();
    expect(URL.revokeObjectURL).toHaveBeenCalled();
  });
});
