// 外观偏好：模式 light | dark | system，配色 palette；均持久化到当前浏览器。
// token 本体在 theme.css（html.dark / html[data-palette] 分层），这里只负责
// 偏好读写、解析系统模式、切换 html 类与属性，并通知订阅者刷新 UI。
import { applyBrandIcon } from './brandIcon.js';

const MODE_KEY = 'corelatex.theme';
const PALETTE_KEY = 'corelatex.palette';

export const THEME_MODES = Object.freeze(['light', 'dark', 'system']);
export const MODE_LABELS = Object.freeze({ light: '浅色', dark: '深色', system: '跟随系统' });

// swatch 与 theme.css 中对应种子保持一致（theme.test.js 校验）。
export const PALETTES = Object.freeze([
  { id: 'sage', name: '松烟', hint: '灰绿 · 默认', swatch: {
    light: { bg: '#f3f5f1', surface: '#fffefa', accent: '#56766a', hover: '#466458', warm: '#b8957c', fg: '#303a33' },
    dark: { bg: '#151a17', surface: '#202722', accent: '#8fb5a4', hover: '#a5c6b6', warm: '#cfae94', fg: '#e4e9e4' } } },
  { id: 'mist', name: '黛蓝', hint: '雾青 · 沉静', swatch: {
    light: { bg: '#f2f4f8', surface: '#fdfdfe', accent: '#4f6d8e', hover: '#3f5c7c', warm: '#b08a6e', fg: '#2e3742' },
    dark: { bg: '#141920', surface: '#1f2630', accent: '#92aecb', hover: '#a9c1da', warm: '#cfae94', fg: '#e2e7ed' } } },
  { id: 'lilac', name: '藕荷', hint: '浅紫 · 温润', swatch: {
    light: { bg: '#f5f3f8', surface: '#fefdff', accent: '#756890', hover: '#645879', warm: '#b3907c', fg: '#37323f' },
    dark: { bg: '#191621', surface: '#242030', accent: '#b0a3cc', hover: '#c2b7da', warm: '#cfae9c', fg: '#e7e4ee' } } },
  { id: 'clay', name: '杏陶', hint: '暖陶 · 柔和', swatch: {
    light: { bg: '#f7f4ef', surface: '#fffdf9', accent: '#9a6b4f', hover: '#855a40', warm: '#b8957c', fg: '#3d362e' },
    dark: { bg: '#1d1814', surface: '#29221c', accent: '#d0a184', hover: '#ddb297', warm: '#d8b491', fg: '#ece5dc' } } },
  { id: 'teal', name: '竹青', hint: '青碧 · 清透', swatch: {
    light: { bg: '#f1f5f4', surface: '#fcfefd', accent: '#477772', hover: '#38655f', warm: '#b08d72', fg: '#2c3a38' },
    dark: { bg: '#131c1b', surface: '#1e2827', accent: '#8fbcb6', hover: '#a6cdc7', warm: '#cfae94', fg: '#e1e9e7' } } },
  { id: 'ink', name: '月白', hint: '素灰 · 克制', swatch: {
    light: { bg: '#f4f5f7', surface: '#fefefe', accent: '#5b6673', hover: '#4a5460', warm: '#ab8a70', fg: '#33383f' },
    dark: { bg: '#17191d', surface: '#22252b', accent: '#a8b2bf', hover: '#bcc5d1', warm: '#cfae94', fg: '#e4e6ea' } } },
]);

export function normalizeMode(value) { return THEME_MODES.includes(value) ? value : 'light'; }
export function normalizePalette(value) { return PALETTES.some(p => p.id === value) ? value : 'sage'; }
export function paletteById(id) { return PALETTES.find(p => p.id === normalizePalette(id)); }

export function getThemePref() {
  try { return normalizeMode(localStorage.getItem(MODE_KEY)); } catch { return 'light'; }
}
export function getPalettePref() {
  try { return normalizePalette(localStorage.getItem(PALETTE_KEY)); } catch { return 'sage'; }
}
export function systemPrefersDark() {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-color-scheme: dark)').matches;
}
export function resolveMode(pref = getThemePref()) {
  const mode = normalizeMode(pref);
  return mode === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : mode;
}
export function appearanceState() {
  return { pref: getThemePref(), palette: getPalettePref(), mode: resolveMode() };
}

export function applyAppearance() {
  const state = appearanceState();
  const root = document.documentElement;
  root.classList.toggle('dark', state.mode === 'dark');
  root.classList.toggle('light', state.mode !== 'dark');
  root.dataset.palette = state.palette;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', paletteById(state.palette).swatch[state.mode].bg);
  applyBrandIcon(paletteById(state.palette), state.mode);
  return state;
}

const listeners = new Set();
export function subscribeAppearance(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function emit() {
  const state = applyAppearance();
  for (const fn of [...listeners]) fn(state);
  return state;
}
export function setThemePref(pref) {
  try { localStorage.setItem(MODE_KEY, normalizeMode(pref)); } catch { /* 隐私模式等场景仅本次生效 */ }
  return emit();
}
export function setPalettePref(id) {
  try { localStorage.setItem(PALETTE_KEY, normalizePalette(id)); } catch { /* 同上 */ }
  return emit();
}
export function watchSystemTheme() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const onChange = () => { if (getThemePref() === 'system') emit(); };
  if (typeof mq.addEventListener === 'function') {
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }
  return () => {};
}
