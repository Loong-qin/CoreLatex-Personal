// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  PALETTES, THEME_MODES, normalizeMode, normalizePalette, getThemePref, getPalettePref,
  resolveMode, applyAppearance, setThemePref, setPalettePref, subscribeAppearance, appearanceState,
} from './theme.js';
const css = readFileSync('src/theme.css', 'utf8');

beforeEach(() => {
  localStorage.clear();
  document.documentElement.className = 'light';
  delete document.documentElement.dataset.palette;
});
afterEach(() => { vi.restoreAllMocks(); });

describe('偏好规范化', () => {
  it('未知值回退到默认', () => {
    expect(normalizeMode('neon')).toBe('light');
    expect(normalizeMode(undefined)).toBe('light');
    expect(normalizePalette('rainbow')).toBe('sage');
    expect(THEME_MODES).toEqual(['light', 'dark', 'system']);
  });
  it('读写持久化', () => {
    setThemePref('dark');
    setPalettePref('mist');
    expect(getThemePref()).toBe('dark');
    expect(getPalettePref()).toBe('mist');
    expect(localStorage.getItem('corelatex.theme')).toBe('dark');
    expect(localStorage.getItem('corelatex.palette')).toBe('mist');
  });
});

describe('模式解析与应用', () => {
  it('system 跟随 matchMedia', () => {
    const original = window.matchMedia;
    window.matchMedia = vi.fn().mockReturnValue({ matches: true, addEventListener: () => {}, removeEventListener: () => {} });
    expect(resolveMode('system')).toBe('dark');
    window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });
    expect(resolveMode('system')).toBe('light');
    expect(resolveMode('dark')).toBe('dark');
    window.matchMedia = original;
  });
  it('applyAppearance 同步 html 类、data-palette 与 theme-color', () => {
    document.head.insertAdjacentHTML('beforeend', '<meta name="theme-color" content="#f3f5f1">');
    setThemePref('dark');
    setPalettePref('lilac');
    const state = applyAppearance();
    expect(state.mode).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.classList.contains('light')).toBe(false);
    expect(document.documentElement.dataset.palette).toBe('lilac');
    expect(document.querySelector('meta[name="theme-color"]').content).toBe('#191621');
    setThemePref('light');
    expect(document.documentElement.classList.contains('light')).toBe(true);
    expect(document.querySelector('meta[name="theme-color"]').content).toBe('#f5f3f8');
  });
  it('订阅者收到变更，退订后不再收到', () => {
    const seen = [];
    const off = subscribeAppearance(s => seen.push(s));
    setPalettePref('clay');
    setThemePref('dark');
    expect(seen.length).toBe(2);
    expect(seen[1]).toMatchObject({ palette: 'clay', mode: 'dark' });
    off();
    setPalettePref('ink');
    expect(seen.length).toBe(2);
    expect(appearanceState().palette).toBe('ink');
  });
});

describe('配色与 CSS 种子一致', () => {
  const block = (selector) => {
    const m = css.match(new RegExp(`${selector.replace(/[.[\]']/g, ch => `\\${ch}`)}\\s*\\{([^}]+)\\}`));
    return m ? m[1] : '';
  };
  const seed = (body, name) => (body.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`)) || [])[1];
  it('每套配色都有浅色与深色块，且 swatch 与种子一致', () => {
    for (const p of PALETTES) {
      const light = p.id === 'sage' ? block(':root') : block(`html[data-palette='${p.id}']`);
      const dark = p.id === 'sage' ? block('html.dark') : block(`html.dark[data-palette='${p.id}']`);
      expect(light, `${p.id} light block`).toBeTruthy();
      expect(dark, `${p.id} dark block`).toBeTruthy();
      for (const mode of ['light', 'dark']) {
        const body = mode === 'light' ? light : dark;
        expect(seed(body, 'accent'), `${p.id} ${mode} accent`).toBe(p.swatch[mode].accent);
        expect(seed(body, 'accent-hover'), `${p.id} ${mode} hover`).toBe(p.swatch[mode].hover);
        expect(seed(body, 'accent-warm'), `${p.id} ${mode} warm`).toBe(p.swatch[mode].warm);
        expect(seed(body, 'bg'), `${p.id} ${mode} bg`).toBe(p.swatch[mode].bg);
        expect(seed(body, 'surface-raised'), `${p.id} ${mode} surface`).toBe(p.swatch[mode].surface);
        expect(seed(body, 'fg'), `${p.id} ${mode} fg`).toBe(p.swatch[mode].fg);
      }
    }
  });
  it('深色块覆盖全部种子 token', () => {
    // 语义色（danger/warn/success）由模式基层统一提供，配色块只覆盖 chrome 种子
    const required = ['bg', 'bg2', 'bg3', 'bg-hover', 'fg', 'fg-dim', 'fg-muted', 'accent', 'accent-hover', 'accent-secondary', 'accent-warm', 'on-accent', 'border', 'surface-raised', 'surface-muted'];
    for (const p of PALETTES) {
      const dark = p.id === 'sage' ? block('html.dark') : block(`html.dark[data-palette='${p.id}']`);
      for (const token of required) expect(dark, `${p.id} dark --${token}`).toContain(`--${token}:`);
    }
    const base = block('html.dark');
    for (const token of ['danger', 'warn', 'success']) expect(base).toContain(`--${token}:`);
  });
});
