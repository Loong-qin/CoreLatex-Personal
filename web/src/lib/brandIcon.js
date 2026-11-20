// 运行时品牌图标：把「排版者的星芒」以当前配色/模式的具体色值渲染成 SVG，
// 写入 <link rel="icon">，让浏览器标签页图标与界面标志同步换装。
// 几何与 BrandMark.vue 完全一致；色值对应 theme.css 的 token 派生规则。

function channels(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function mixHex(a, b, t) {
  const ca = channels(a), cb = channels(b);
  const c = ca.map((v, i) => Math.round(v * (1 - t) + cb[i] * t));
  return `#${c.map(v => v.toString(16).padStart(2, '0')).join('')}`;
}

export function brandIconColors(palette, mode) {
  const s = palette.swatch[mode];
  return {
    inkA: s.hover,
    inkB: s.accent,
    sparkA: mixHex(s.warm, s.surface, 0.28),
    sparkB: s.warm,
    tileA: s.surface,
    tileB: mixHex(s.surface, s.accent, 0.08),
    edge: s.accent,
    hi: mode === 'light' ? mixHex(s.surface, '#ffffff', 0.55) : mixHex(s.surface, s.fg, 0.28),
    tick: s.accent,
  };
}

export function brandIconSvg(palette, mode, { tile = true } = {}) {
  const c = brandIconColors(palette, mode);
  return `<svg width="512" height="512" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">` +
    `<defs>` +
    `<linearGradient id="ink" x1="14" y1="12" x2="34" y2="38" gradientUnits="userSpaceOnUse"><stop stop-color="${c.inkA}"/><stop offset="1" stop-color="${c.inkB}"/></linearGradient>` +
    `<linearGradient id="spark" x1="31" y1="20" x2="39" y2="29" gradientUnits="userSpaceOnUse"><stop stop-color="${c.sparkA}"/><stop offset="1" stop-color="${c.sparkB}"/></linearGradient>` +
    `<linearGradient id="tile" x1="6" y1="2" x2="42" y2="46" gradientUnits="userSpaceOnUse"><stop stop-color="${c.tileA}"/><stop offset="1" stop-color="${c.tileB}"/></linearGradient>` +
    `</defs>` +
    (tile ? `<rect x="1" y="1" width="46" height="46" rx="12.5" fill="url(#tile)" stroke="${c.edge}" stroke-opacity="0.28"/>` +
    `<path d="M14.5 2.5h19" stroke="${c.hi}" stroke-width="1.4" stroke-linecap="round"/>` : '') +
    `<path d="M33.19 15.31 A13 13 0 1 0 33.19 33.69 L31.91 29.98 A8.9 8.9 0 1 1 31.91 19.02 Z" fill="url(#ink)"/>` +
    `<path d="M34.8 19.7 C35.35 22.6 36.4 23.65 39.4 24.5 C36.4 25.35 35.35 26.4 34.8 29.3 C34.25 26.4 33.2 25.35 30.2 24.5 C33.2 23.65 34.25 22.6 34.8 19.7 Z" fill="url(#spark)"/>` +
    `<rect x="32.9" y="35.5" width="4.4" height="1.7" rx="0.85" fill="${c.tick}" fill-opacity="0.45"/>` +
    `</svg>`;
}

export function applyBrandIcon(palette, mode) {
  if (typeof document === 'undefined') return;
  const link = document.querySelector('link[rel="icon"], link[rel="shortcut icon"]');
  if (!link) return;
  link.setAttribute('href', `data:image/svg+xml,${encodeURIComponent(brandIconSvg(palette, mode))}`);
}
