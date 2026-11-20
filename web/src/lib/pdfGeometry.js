// PDF 预览几何计算（纯函数，便于测试）

/**
 * 计算实际缩放倍数。
 * mode: 'fit-width' | 'fit-page' | 数字（直接作为缩放倍数）
 * containerW/H 为可用显示区域（CSS px），pageW/H 为页面尺寸（pt，scale=1 时）。
 * 尺寸非法（<=0）时回退到 currentScale。
 */
export function fitScale({ mode, containerW, containerH, pageW, pageH, currentScale = 1 }) {
  if (mode === 'fit-width') {
    return pageW > 0 && containerW > 0 ? containerW / pageW : currentScale;
  }
  if (mode === 'fit-page') {
    if (pageW > 0 && pageH > 0 && containerW > 0 && containerH > 0) {
      return Math.min(containerW / pageW, containerH / pageH);
    }
    return currentScale;
  }
  const n = Number(mode);
  return Number.isFinite(n) && n > 0 ? n : currentScale;
}

/** 页码收敛到 [1, total]；非法输入回 1，total 非法时按 1 处理。 */
export function clampPage(n, total) {
  const t = Math.max(1, Math.floor(Number(total)) || 1);
  let p = Math.floor(Number(n));
  if (!Number.isFinite(p)) p = 1;
  return Math.min(Math.max(p, 1), t);
}

/**
 * 页面占位(.page-wrap)样式。布局不依赖 JS 测量的容器宽：
 * - fit-width: width:100% 纯 CSS 跟随容器——即使 measure() 因渲染帧调度滞后
 *   (ResizeObserver 饿死/滚动条出现竞态)拿到过时宽度，页面也不会溢出偏移，
 *   只影响位图重渲的清晰度，测量追上后自愈；
 * - fit-page: min(100%, px) 双保险，水平方向永不超出容器；
 * - 数字缩放: 固定 px，允许横向滚动（用户主动放大）。
 * 宽高比一律交给 aspect-ratio，高度不再写死，占位与真实页面尺寸同步更新。
 * scale/fitPageW 仅在需要 px 数值时使用（渲染分辨率与百分比显示仍走 fitScale）。
 */
export function pageWrapStyleFor(mode, pagePt, scale, fitPageW) {
  const ar = `${pagePt.w} / ${pagePt.h}`;
  if (mode === 'fit-width') return { width: '100%', aspectRatio: ar };
  if (mode === 'fit-page') {
    return { width: `min(100%, ${Math.max(1, Math.round(fitPageW))}px)`, aspectRatio: ar };
  }
  return { width: `${Math.max(1, Math.round(ptToPx(pagePt.w, scale)))}px`, aspectRatio: ar };
}

/** PostScript point → CSS 像素 */
export function ptToPx(pt, scale) {
  return pt * scale;
}

/** CSS 像素 → PostScript point */
export function pxToPt(px, scale) {
  return scale > 0 ? px / scale : 0;
}
