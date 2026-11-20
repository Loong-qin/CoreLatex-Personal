// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { mixHex, brandIconSvg, applyBrandIcon } from './brandIcon.js';
import { PALETTES, paletteById } from './theme.js';

describe('mixHex', () => {
  it('按权重混合并取整', () => {
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(mixHex('#ffffff', '#000000', 0)).toBe('#ffffff');
    expect(mixHex('#b8957c', '#fffefa', 0.28)).toBe('#ccb29f');
  });
});

describe('brandIconSvg', () => {
  it('每套配色×模式都生成含对应主色的完整 SVG', () => {
    for (const p of PALETTES) {
      for (const mode of ['light', 'dark']) {
        const svg = brandIconSvg(p, mode);
        expect(svg.startsWith('<svg')).toBe(true);
        expect(svg.endsWith('</svg>')).toBe(true);
        expect(svg).toContain(p.swatch[mode].accent);
        expect(svg).toContain(p.swatch[mode].hover);
        expect(svg).toContain(p.swatch[mode].warm);
      }
    }
  });
  it('bare 变体去掉底 tile 与高光，保留字标与星芒', () => {
    const svg = brandIconSvg(paletteById('sage'), 'light', { tile: false });
    expect(svg).not.toContain('rect x="1"');
    expect(svg).not.toContain('M14.5 2.5h19');
    expect(svg).toContain('M33.19 15.31');
    expect(svg).toContain('rect x="32.9"');
  });
  it('深色与浅色图标不同', () => {
    const p = paletteById('mist');
    expect(brandIconSvg(p, 'light')).not.toBe(brandIconSvg(p, 'dark'));
  });
});

describe('applyBrandIcon', () => {
  it('把当前配色的图标写入 link[rel=icon]', () => {
    document.head.insertAdjacentHTML('beforeend', '<link rel="icon" type="image/svg+xml" href="/favicon.svg">');
    applyBrandIcon(paletteById('clay'), 'dark');
    const href = document.querySelector('link[rel="icon"]').getAttribute('href');
    expect(href.startsWith('data:image/svg+xml,')).toBe(true);
    expect(decodeURIComponent(href)).toContain('#d0a184');
    applyBrandIcon(paletteById('teal'), 'light');
    expect(decodeURIComponent(document.querySelector('link[rel="icon"]').getAttribute('href'))).toContain('#477772');
  });
  it('无 link 时静默跳过', () => {
    document.querySelector('link[rel="icon"]')?.remove();
    expect(() => applyBrandIcon(paletteById('sage'), 'light')).not.toThrow();
  });
});
