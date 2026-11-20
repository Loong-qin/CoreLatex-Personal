// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, h, nextTick, reactive, KeepAlive, ref } from 'vue';
import AgentToolResult from './AgentToolResult.vue';
import { api } from '../../api.js';
vi.mock('../../api.js', () => ({ api: { raw: vi.fn() } }));
const mounts = [];
const images = [1, 2].map(n => ({ id: `s${n}`, label: `第 ${n} 页`, page: n, url: `/api/projects/p/agent/artifacts/s${n}` }));
async function flush() { for (let i = 0; i < 5; i++) { await Promise.resolve(); await nextTick(); } }
async function mount(display, options = {}) {
  const props = reactive({ row: { name: 'compile_and_preview', state: 'ok', display, inputText: '{"pages":"1-2"}', resultText: 'done', ...options.row }, active: options.active ?? true });
  const visible = ref(true);
  const app = createApp({ render: () => h(KeepAlive, {}, { default: () => visible.value ? h(AgentToolResult, props) : null }) });
  const host = document.createElement('div'); document.body.append(host); app.mount(host); mounts.push({ app, host }); await flush();
  return { props, host, app, visible };
}
beforeEach(() => {
  vi.clearAllMocks();
  URL.createObjectURL = vi.fn((blob) => `blob:mock-${URL.createObjectURL.mock.calls.length}`);
  URL.revokeObjectURL = vi.fn();
  api.raw.mockResolvedValue({ blob: async () => new Blob(['image'], { type: 'image/png' }) });
});
afterEach(() => { mounts.splice(0).forEach(({ app, host }) => { app.unmount(); host.remove(); }); });

describe('readable tool cards and immutable images', () => {
  it('loads only when visible, uses authenticated API paths, and keeps technical details collapsed', async () => {
    const { host, props } = await mount({ version: 1, kind: 'compile', summary: '已读取 2 页', images }, { active: false });
    expect(api.raw).not.toHaveBeenCalled(); expect(host.querySelector('details').open).toBe(false);
    props.active = true; await flush();
    expect(api.raw.mock.calls.map(args => args[0])).toEqual(images.map(i => i.url));
    expect(host.querySelectorAll('.tool-image-button img')).toHaveLength(2);
    expect(host.querySelector('img').src).toBe('blob:mock-1'); expect(host.textContent).toContain('智能体看到的图像');
    props.active = false; await flush(); expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
  });

  it('opens real snapshot, zooms, fits, navigates, traps focus, and closes via Escape restoring focus', async () => {
    const { host } = await mount({ version: 1, kind: 'compile', images });
    const trigger = host.querySelector('[aria-label="放大预览：第 1 页"]'); trigger.focus(); trigger.click(); await flush();
    const dialog = document.querySelector('[role="dialog"]'); expect(dialog).not.toBeNull();
    expect(document.activeElement.getAttribute('aria-label')).toBe('关闭预览');
    const button = label => dialog.querySelector(`[aria-label="${label}"]`);
    button('放大').click(); await flush(); expect(dialog.querySelector('.tool-image-stage img').style.width).toBe('125%');
    button('适应窗口').click(); await flush(); expect(dialog.querySelector('.tool-image-stage').classList.contains('fit')).toBe(true);
    button('下一张').click(); await flush(); expect(dialog.querySelector('.tool-image-stage img').alt).toBe('第 2 页');
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })); await flush(); expect(dialog.querySelector('.tool-image-stage img').alt).toBe('第 1 页');
    button('关闭预览').focus(); button('关闭预览').dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    expect(document.activeElement.getAttribute('aria-label')).toBe('下一张');
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await flush();
    expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(document.activeElement).toBe(trigger);
  });

  it('releases modal and blobs on project deactivation and reloads snapshots on activation', async () => {
    const { host, visible } = await mount({ version: 1, kind: 'image', images: [images[0]] });
    host.querySelector('.tool-image-button').click(); await flush();
    visible.value = false; await flush(); expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-1');
    visible.value = true; await flush(); expect(api.raw).toHaveBeenCalledTimes(2); expect(host.querySelector('img').src).toBe('blob:mock-2');
  });

  it('does not leak URLs or create blobs when an in-flight request resolves after unmount', async () => {
    let resolve;
    api.raw.mockImplementation(() => new Promise(done => { resolve = done; }));
    const { app } = await mount({ version: 1, kind: 'image', images: [images[0]] });
    app.unmount(); resolve({ blob: async () => new Blob(['image'], { type: 'image/png' }) }); await flush();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('shows a recoverable expired image placeholder and never requests hostile URLs', async () => {
    api.raw.mockRejectedValue({ status: 410 });
    const { host } = await mount({ version: 1, kind: 'image', images: [...images.slice(0, 1), { id: 'bad', label: 'bad', url: 'https://evil.test/image' }] });
    expect(api.raw).toHaveBeenCalledTimes(1); expect(host.textContent).toContain('已过期或不可用');
    expect(host.querySelectorAll('.tool-image-button')).toHaveLength(0); expect(host.querySelector('.tool-image-retry')).not.toBeNull();
  });

  it('shows line-numbered content and honest edit results with sources as safe links', async () => {
    const read = await mount({ version: 1, kind: 'read', startLine: 15, text: 'first\nsecond', fields: [{ label: '文件', value: 'main.tex' }] }, { row: { name: 'read_file' } });
    expect(read.host.querySelector('.tool-numbered-code').textContent).toContain('15first16second');
    const edit = await mount({ version: 1, kind: 'edit', before: 'old', after: 'new', outcome: 'staged', notice: '尚未写入正式文件' }, { row: { name: 'edit_file' } });
    expect(edit.host.querySelector('.tool-diff').textContent).toContain('修改前old修改后new'); expect(edit.host.textContent).toContain('执行时暂存');
    edit.props.row.state = 'error'; await flush(); expect(edit.host.querySelector('.tool-diff')).toBeNull();
    const source = await mount({ version: 1, kind: 'search', items: [{ label: '来源', url: 'https://example.test', detail: '摘要' }, { label: 'bad', url: 'javascript:alert(1)' }] });
    expect(source.host.querySelectorAll('a')).toHaveLength(1); expect(source.host.querySelector('a').rel).toBe('noopener noreferrer');
  });
});
