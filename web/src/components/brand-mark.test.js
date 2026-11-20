// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { createApp, h } from 'vue';
import BrandMark from './BrandMark.vue';

let app, el;
afterEach(() => { app?.unmount(); el?.remove(); app = null; el = null; });

function mount(nodes) {
  el = document.createElement('div');
  document.body.appendChild(el);
  app = createApp({ render: () => nodes });
  app.mount(el);
  return el;
}

describe('BrandMark', () => {
  it('renders the tiled mark with unique gradient ids per instance', () => {
    const root = mount([h(BrandMark, { size: 40 }), h(BrandMark, { size: 24 })]);
    const svgs = root.querySelectorAll('svg');
    expect(svgs.length).toBe(2);
    expect(svgs[0].getAttribute('width')).toBe('40');
    expect(svgs[1].getAttribute('width')).toBe('24');
    const ids = [...root.querySelectorAll('linearGradient')].map(g => g.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(root.querySelectorAll('rect').length).toBe(4); // 每实例：底 tile + 基线刻度
  });

  it('omits the tile in bare variant but keeps glyph, spark and tick', () => {
    const root = mount(h(BrandMark, { size: 64, tile: false }));
    const svg = root.querySelector('svg');
    expect(svg.querySelectorAll('path').length).toBe(2); // C + spark
    expect(svg.querySelectorAll('rect').length).toBe(1); // baseline tick only
    expect(svg.querySelectorAll('linearGradient').length).toBe(3); // defs 恒定，tile 渐变未引用
  });

  it('is decorative by default and accepts aria-hidden passthrough', () => {
    const root = mount(h(BrandMark, { 'aria-hidden': 'true' }));
    expect(root.querySelector('svg').getAttribute('aria-hidden')).toBe('true');
    expect(root.querySelector('svg').getAttribute('focusable')).toBe('false');
  });

  it('derives every color from appearance tokens (palette + mode aware)', () => {
    const root = mount(h(BrandMark));
    const styles = [...root.querySelectorAll('stop')].map(s => s.getAttribute('style') || '');
    expect(styles.some(s => s.includes('var(--accent-hover)'))).toBe(true);
    expect(styles.some(s => s.includes('var(--accent)'))).toBe(true);
    expect(styles.some(s => s.includes('var(--accent-warm)'))).toBe(true);
    expect(styles.some(s => s.includes('var(--surface-raised)'))).toBe(true);
    const svg = root.querySelector('svg');
    expect(svg.innerHTML).not.toMatch(/#[0-9a-fA-F]{6}/);
    expect(svg.querySelector('rect').getAttribute('stroke')).toBe('var(--accent)');
    expect(svg.querySelector('path[stroke]').getAttribute('stroke')).toBe('var(--mark-hi)');
  });
});