import { describe, expect, it } from 'vitest';
import { editorPanelLayout, panelWidthFromKey, panelWidthRatio, readPanelWidthRatio, savePanelWidthRatio } from './editorUtils.js';

describe('responsive workbench geometry', () => {
  it.each([1180, 1280, 1440, 1920, 2560, 3440])('leaves at least 420px for the editor at %ipx with both panels expanded', (width) => {
    const g = editorPanelLayout(width, { sideOpen: true, rightOpen: true, sideWidth: 10000, rightWidth: 10000, rightTab: 'pdf' });
    expect(g.sideOverlay).toBe(false);
    expect(g.rightOverlay).toBe(false);
    expect(width - g.railWidth - g.sideWidth - 6 - g.rightWidth).toBeGreaterThanOrEqual(420);
  });
  it.each([320, 390, 768, 979])('uses contained overlays rather than clipping the editor at %ipx', (width) => {
    const g = editorPanelLayout(width, { sideWidth: 9999, rightWidth: 9999, sideOpen: true, rightOpen: true });
    expect(g.sideOverlay).toBe(true);
    expect(g.rightOverlay).toBe(true);
    expect(g.sideWidth + g.railWidth + 16).toBeLessThanOrEqual(width);
    expect(g.rightWidth + g.railWidth + 16).toBeLessThanOrEqual(width);
  });
  it('uses a left overlay at medium width while leaving room for inline PDF', () => {
    const g = editorPanelLayout(1024, { sideOpen: true, rightOpen: true, rightTab: 'pdf' });
    expect(g.sideOverlay).toBe(true);
    expect(g.rightOverlay).toBe(false);
    expect(1024 - g.railWidth - g.rightWidth).toBeGreaterThanOrEqual(420);
  });
  it('sanitizes persisted negative and non-finite sizes', () => {
    const g = editorPanelLayout(1440, { sideWidth: Infinity, rightWidth: -10 });
    expect(g.sideWidth).toBe(288);
    expect(g.rightWidth).toBe(360);
  });
  it.each([1440, 2560, 3440])('scales all desktop regions proportionally at %ipx', (width) => {
    const g = editorPanelLayout(width, { sideOpen: true, rightOpen: true, sideRatio: 0.2, rightRatio: 1 / 3, rightTab: 'pdf' });
    expect(g.sideWidth).toBe(Math.round(width * 0.2));
    expect(g.rightWidth).toBe(Math.round(width / 3));
    expect(g.rightMax).toBeLessThanOrEqual(width * 0.5);
    expect(width - g.railWidth - g.sideWidth - 6 - g.rightWidth).toBeGreaterThanOrEqual(420);
  });
  it.each([2560, 3440])('lets the preview actually reach 50%% on a %ipx monitor', (width) => {
    const g = editorPanelLayout(width, { sideOpen: true, rightOpen: true, sideRatio: 0.2, rightRatio: 0.5, rightTab: 'pdf' });
    expect(g.rightWidth).toBe(width * 0.5);
    expect(g.rightMax).toBe(width * 0.5);
    expect(g.rightWidth).toBeGreaterThan(720);
    expect(g.sideWidth).toBeGreaterThan(440);
  });
  it('keeps a dragged ratio through resizing and temporary overlay layouts', () => {
    const sideRatio = panelWidthRatio(360, 1440);
    const rightRatio = panelWidthRatio(600, 1440);
    const options = { sideOpen: true, rightOpen: true, sideRatio, rightRatio, rightTab: 'pdf' };
    const wide = editorPanelLayout(3440, options);
    expect(wide.sideWidth).toBe(Math.round(3440 * 0.25));
    expect(wide.rightWidth).toBe(Math.round(3440 * rightRatio));
    const mobile = editorPanelLayout(390, options);
    expect(mobile.rightWidth).toBeGreaterThan(390 * 0.5);
    expect(mobile.sideWidth).toBeGreaterThan(390 * 0.5);
    expect(editorPanelLayout(1440, options).sideWidth).toBe(360);
    expect(editorPanelLayout(1440, options).rightWidth).toBe(600);
  });
  it('uses tab defaults until the user chooses a ratio, then keeps it across tabs', () => {
    expect(editorPanelLayout(3440, { rightTab: 'pdf' }).rightWidth).toBe(1147);
    expect(editorPanelLayout(3440, { rightTab: 'info' }).rightWidth).toBe(860);
    expect(editorPanelLayout(3440, { rightTab: 'pdf', rightRatio: 0.4 }).rightWidth).toBe(1376);
    expect(editorPanelLayout(3440, { rightTab: 'info', rightRatio: 0.4 }).rightWidth).toBe(1376);
  });
  it('keyboard resizing follows the physical direction of the separator and clamps endpoints', () => {
    expect(panelWidthFromKey(300, 'ArrowRight', 220, 420)).toBe(316);
    expect(panelWidthFromKey(300, 'ArrowLeft', 220, 420, true)).toBe(316);
    expect(panelWidthFromKey(300, 'Home', 220, 420)).toBe(220);
    expect(panelWidthFromKey(300, 'End', 220, 420)).toBe(420);
    expect(panelWidthFromKey(410, 'ArrowRight', 220, 420)).toBe(420);
    expect(panelWidthFromKey(300, 'Enter', 220, 420)).toBeNull();
  });
});


describe('panel width preference migration', () => {
  function storageFor(values = {}) {
    const valuesMap = new Map(Object.entries(values));
    return { getItem: (key) => valuesMap.get(key) ?? null, setItem: (key, value) => valuesMap.set(key, value), removeItem: (key) => valuesMap.delete(key) };
  }
  it('migrates a legacy 720px preview to 50% rather than freezing it on ultrawide monitors', () => {
    const storage = storageFor({ 'corelatex.rightWidth': '720', 'corelatex.sideWidth': '280' });
    const rightRatio = readPanelWidthRatio(storage, 'right');
    const sideRatio = readPanelWidthRatio(storage, 'side');
    expect(rightRatio).toBe(0.5);
    expect(sideRatio).toBeCloseTo(280 / 1440, 6);
    expect(storage.getItem('corelatex.rightWidthRatio')).toBe('0.5');
    expect(storage.getItem('corelatex.rightWidth')).toBeNull();
    expect(editorPanelLayout(3440, { rightRatio, sideRatio, sideOpen: true, rightOpen: true }).rightWidth).toBe(1720);
  });
  it('prefers valid saved ratios and safely falls back from malformed preferences', () => {
    const storage = storageFor({ 'corelatex.rightWidthRatio': '0.4', 'corelatex.rightWidth': '720', 'corelatex.sideWidthRatio': 'NaN' });
    expect(readPanelWidthRatio(storage, 'right')).toBe(0.4);
    expect(readPanelWidthRatio(storage, 'side')).toBe(0.2);
    expect(readPanelWidthRatio(storageFor({ 'corelatex.rightWidthRatio': '9', 'corelatex.rightWidth': '-10' }), 'right')).toBe(0);
  });
  it('resets only width preferences and preserves all unrelated preferences', () => {
    const storage = storageFor({ 'corelatex.rightWidthRatio': '0.4', 'corelatex.rightWidth': '600', 'corelatex.reviewMode': '1' });
    savePanelWidthRatio(storage, 'right', 0);
    expect(storage.getItem('corelatex.rightWidthRatio')).toBeNull();
    expect(storage.getItem('corelatex.rightWidth')).toBeNull();
    expect(storage.getItem('corelatex.reviewMode')).toBe('1');
  });
});
