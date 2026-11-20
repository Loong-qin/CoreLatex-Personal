// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, nextTick, reactive } from 'vue';
import OverviewBar from './OverviewBar.vue';

const fixture = vi.hoisted(() => ({ store: null, runtime: null }));
vi.mock('../../stores/editor.js', () => ({ useEditorStore: () => fixture.store }));
vi.mock('../../lib/editorRuntime.js', () => ({ useEditorRuntime: () => fixture.runtime }));
vi.mock('../../lib/reviewDecorations.js', () => ({ buildReviewRanges: () => [] }));

let app, el, bar, scrollDOM;
function makeView() {
  scrollDOM = document.createElement('div');
  Object.defineProperties(scrollDOM, {
    scrollHeight: { configurable: true, value: 3000 },
    clientHeight: { configurable: true, value: 600 },
  });
  return {
    scrollDOM,
    lineBlockAt: vi.fn((pos) => ({ top: pos, height: 20 })),
    state: {
      doc: {
        lines: 200,
        length: 2000,
        line: (n) => ({ from: (n - 1) * 10, length: 10, number: n }),
        lineAt: (pos) => ({ number: Math.floor(pos / 10) + 1 }),
        toString: () => '',
      },
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('ResizeObserver', class { constructor() { this.observe = vi.fn(); this.disconnect = vi.fn(); } });
  fixture.store = reactive({
    viewMode: 'code', diffReview: null, selection: null, reviews: [], searchMatches: null,
    activeFile: 'main.tex', cursorLine: 0,
    compile: { errors: [{ file: 'main.tex', line: 40, message: 'boom' }], warnings: [] },
    gotoDiffHunk: vi.fn(),
    $subscribe: vi.fn(() => () => {}),
  });
  fixture.runtime = reactive({ view: null, selectRange: vi.fn(), jumpToLine: vi.fn() });
});
afterEach(() => {
  app?.unmount(); el?.remove(); app = null; el = null;
  vi.unstubAllGlobals(); vi.useRealTimers(); vi.clearAllMocks();
});

async function mountBar() {
  el = document.createElement('div'); document.body.appendChild(el);
  app = createApp(OverviewBar); app.mount(el);
  bar = el.querySelector('.overview-bar');
  Object.defineProperties(bar, { clientHeight: { configurable: true, value: 600 } });
  fixture.runtime.view = makeView();
  vi.advanceTimersByTime(80);
  await nextTick(); await Promise.resolve();
  vi.advanceTimersByTime(80); // 冲刷 wireView 后的第二次 refresh（标记/视口/ARIA）
  await nextTick(); await Promise.resolve();
  return bar;
}
const thumb = () => bar.querySelector('.ov-viewport');

describe('overview scrollbar', () => {
  it('exposes scrollbar semantics and a viewport-proportional thumb', async () => {
    await mountBar();
    expect(bar.getAttribute('role')).toBe('scrollbar');
    expect(bar.getAttribute('aria-valuemax')).toBe('2400');
    expect(bar.getAttribute('aria-valuenow')).toBe('0');
    expect(thumb().style.height).toBe('20%');
    expect(bar.classList.contains('hidden')).toBe(false);
  });

  it('moves the thumb in the same frame as editor scroll (no debounce)', async () => {
    await mountBar();
    scrollDOM.scrollTop = 1500;
    scrollDOM.dispatchEvent(new Event('scroll'));
    await nextTick(); // 滑块度量同步更新，DOM 于微任务（绘制前）落地
    expect(thumb().style.top).toBe('50%');
    expect(bar.getAttribute('aria-valuenow')).toBe('1500');
  });

  it('dragging the thumb scrolls proportionally and tracks the pointer live', async () => {
    await mountBar();
    bar.dispatchEvent(new MouseEvent('pointerdown', { clientY: 60, bubbles: true, cancelable: true }));
    await nextTick();
    expect(bar.classList.contains('dragging')).toBe(true);
    window.dispatchEvent(new MouseEvent('pointermove', { clientY: 160, bubbles: true }));
    // pxToScroll = 2400 / (600 - 120) = 5 → +100px → scrollTop 500
    expect(scrollDOM.scrollTop).toBe(500);
    await nextTick();
    expect(thumb().style.top).toBe(`${(500 / 3000) * 100}%`);
    window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    await nextTick();
    expect(bar.classList.contains('dragging')).toBe(false);
  });

  it('clicking the track centers the viewport on the click point', async () => {
    await mountBar();
    bar.dispatchEvent(new MouseEvent('pointerdown', { clientY: 300, bubbles: true, cancelable: true }));
    expect(scrollDOM.scrollTop).toBe(1200); // 300/600*3000 - 300
    await nextTick();
    expect(thumb().style.top).toBe('40%');
    window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
  });

  it('wheel and keyboard operate the scrollbar', async () => {
    await mountBar();
    bar.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true }));
    expect(scrollDOM.scrollTop).toBe(120);
    bar.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    expect(scrollDOM.scrollTop).toBe(160);
    bar.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
    expect(scrollDOM.scrollTop).toBe(2400);
    bar.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }));
    expect(scrollDOM.scrollTop).toBe(0);
  });

  it('keeps overview marks clickable above the thumb', async () => {
    await mountBar();
    const mark = bar.querySelector('.ov-error');
    expect(mark).toBeTruthy();
    mark.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
    expect(scrollDOM.scrollTop).toBe(0); // 标记不触发轨道滚动
    mark.click();
    expect(fixture.runtime.jumpToLine).toHaveBeenCalledWith(39);
  });

  it('hides outside code view', async () => {
    await mountBar();
    fixture.store.viewMode = 'visual';
    await nextTick(); // watch 回调先排防抖定时器
    vi.advanceTimersByTime(80);
    await nextTick();
    expect(bar.classList.contains('hidden')).toBe(true);
  });
});