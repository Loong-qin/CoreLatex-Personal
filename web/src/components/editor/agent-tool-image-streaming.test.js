// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, h, KeepAlive, nextTick, ref } from 'vue';
import AgentTimeline from './AgentTimeline.vue';
import AgentToolResult from './AgentToolResult.vue';
import { buildTimeline } from '../../lib/agentUtils.js';
import { api } from '../../api.js';

vi.mock('../../api.js', () => ({ api: { raw: vi.fn() } }));
const mounts = [];
const image = (id, page = 1) => ({ id, page, label: `第 ${page} 页`, mimeType: 'image/png', url: `/api/projects/streaming/agent/artifacts/${id}` });
const response = () => ({ blob: async () => new Blob(['fixture image'], { type: 'image/png' }) });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function flush() { for (let i = 0; i < 5; i++) { await Promise.resolve(); await nextTick(); } }

async function mount({ timeline = false, images = [image('asset-a'), image('asset-b', 2)] } = {}) {
  const token = ref('开始输出');
  const sourceImages = ref(images);
  const active = ref(true);
  const visible = ref(true);
  const host = document.createElement('div'); document.body.append(host);
  const app = createApp({ render() {
    // Reproduce the real chain: each streamed token reconstructs timeline rows,
    // display objects and normalized image objects while artifact values stay equal.
    const built = buildTimeline({ steps: [
      { type: 'tool', name: 'compile_and_preview', toolCallId: 'compile-1', status: 'end',
        input: { pages: '1-2' }, result: '已读取编译预览', ms: 10,
        display: { version: 1, kind: 'compile', summary: '已读取编译预览',
          images: sourceImages.value.map(item => ({ ...item })) } },
      { type: 'text', text: token.value },
    ] });
    return h(KeepAlive, null, { default: () => visible.value
      ? timeline ? h(AgentTimeline, { rows: built.rows, answerHtml: built.answer, live: true })
        : h(AgentToolResult, { row: built.rows[0], active: active.value })
      : null });
  } });
  app.component('el-icon', { render() { return h('span', this.$slots.default?.()); } });
  app.mount(host); mounts.push({ app, host }); await flush();
  if (timeline) { host.querySelector('.tl-row').click(); await flush(); }
  return { host, sourceImages, active, visible, async stream(count) {
    for (let i = 1; i <= count; i++) {
      token.value = `持续生成回答，第 ${i} 个 token`;
      sourceImages.value = sourceImages.value.map(item => ({ ...item }));
      await flush();
    }
  } };
}

beforeEach(() => {
  vi.clearAllMocks();
  URL.createObjectURL = vi.fn(() => `blob:stream-${URL.createObjectURL.mock.calls.length}`);
  URL.revokeObjectURL = vi.fn();
  api.raw.mockImplementation(async () => response());
});
afterEach(() => {
  for (const { app, host } of mounts.splice(0)) { app.unmount(); host.remove(); }
});

describe('tool image snapshots during streamed answers', () => {
  for (const [timeline, count] of [[false, 50], [true, 100]]) {
    it(`keeps images, the open dialog and zoom unchanged across ${count} ${timeline ? 'timeline token' : 'result row'} updates`, async () => {
      const f = await mount({ timeline });
      expect(api.raw).toHaveBeenCalledTimes(2);
      const thumbnails = [...f.host.querySelectorAll('.tool-image-button img')];
      const urls = thumbnails.map(node => node.src);
      f.host.querySelector('.tool-image-button').click(); await flush();
      const dialog = document.querySelector('[role="dialog"]');
      dialog.querySelector('[aria-label="放大"]').click();
      dialog.querySelector('[aria-label="放大"]').click(); await flush();
      const enlarged = dialog.querySelector('.tool-image-stage img');
      expect(enlarged.style.width).toBe('150%');

      await f.stream(count);

      expect(api.raw).toHaveBeenCalledTimes(2);
      expect(api.raw.mock.calls.map(([url]) => url)).toEqual([image('asset-a').url, image('asset-b').url]);
      expect(URL.createObjectURL).toHaveBeenCalledTimes(2);
      expect(URL.revokeObjectURL).not.toHaveBeenCalled();
      [...f.host.querySelectorAll('.tool-image-button img')].forEach((node, index) => {
        expect(node).toBe(thumbnails[index]); expect(node.src).toBe(urls[index]);
      });
      expect(document.querySelector('[role="dialog"]')).toBe(dialog);
      expect(dialog.querySelector('.tool-image-stage img')).toBe(enlarged);
      expect(enlarged.src).toBe(urls[0]);
      expect(enlarged.style.width).toBe('150%');
      expect(dialog.querySelector('.tool-image-scale').textContent).toBe('150%');
    });
  }

  it('does not duplicate an in-flight image request while equal normalized objects are replaced', async () => {
    const pending = deferred(); api.raw.mockReturnValue(pending.promise);
    const f = await mount({ images: [image('pending')] });
    await f.stream(50);
    expect(api.raw).toHaveBeenCalledTimes(1);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    pending.resolve(response()); await flush();
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(f.host.querySelector('img').src).toBe('blob:stream-1');
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  });

  it('releases and fetches again when an artifact URL truly changes, then cleans up when inactive', async () => {
    const f = await mount({ images: [image('original')] });
    expect(f.host.querySelector('img').src).toBe('blob:stream-1');
    f.sourceImages.value = [{ ...image('original'), url: image('replacement').url }];
    await flush();
    expect(api.raw.mock.calls.map(([url]) => url)).toEqual([image('original').url, image('replacement').url]);
    expect(URL.revokeObjectURL.mock.calls).toEqual([['blob:stream-1']]);
    expect(f.host.querySelector('img').src).toBe('blob:stream-2');
    f.active.value = false; await flush();
    expect(URL.revokeObjectURL.mock.calls.map(([url]) => url)).toEqual(['blob:stream-1', 'blob:stream-2']);
    expect(f.host.querySelector('img')).toBeNull();
    expect(api.raw).toHaveBeenCalledTimes(2);
  });

  it('ignores superseded late responses and deactivated requests without creating stale blobs', async () => {
    const requests = [];
    api.raw.mockImplementation(url => { const pending = deferred(); requests.push({ url, ...pending }); return pending.promise; });
    const f = await mount({ images: [image('old')] });
    f.sourceImages.value = [image('current')]; await flush();
    expect(requests).toHaveLength(2);
    requests[1].resolve(response()); await flush();
    expect(f.host.querySelector('img').src).toBe('blob:stream-1');
    requests[0].resolve(response()); await flush();
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(f.host.querySelector('img').src).toBe('blob:stream-1');
    f.host.querySelector('.tool-image-button').click(); await flush();
    f.visible.value = false; await flush();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(URL.revokeObjectURL.mock.calls).toEqual([['blob:stream-1']]);
    f.visible.value = true; await flush();
    expect(requests).toHaveLength(3);
    f.visible.value = false; await flush();
    requests[2].resolve(response()); await flush();
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
  });
});
