import { describe, it, expect } from 'vitest';
import { fitScale, clampPage, ptToPx, pxToPt, pageWrapStyleFor } from '../../lib/pdfGeometry.js';

describe('fitScale', () => {
  const base = { containerW: 800, containerH: 600, pageW: 400, pageH: 600, currentScale: 1.5 };

  it('fit-width 用容器宽/页宽', () => {
    expect(fitScale({ ...base, mode: 'fit-width' })).toBe(2);
  });

  it('fit-page 取宽高方向更小值', () => {
    // 高方向 600/600=1 < 宽方向 800/400=2
    expect(fitScale({ ...base, mode: 'fit-page' })).toBe(1);
    // 宽方向更受限时
    expect(fitScale({ ...base, mode: 'fit-page', containerW: 200 })).toBe(0.5);
  });

  it('数字 mode 直接作为缩放倍数', () => {
    expect(fitScale({ ...base, mode: 1.25 })).toBe(1.25);
    expect(fitScale({ ...base, mode: '2' })).toBe(2);
  });

  it('尺寸非法时回退 currentScale', () => {
    expect(fitScale({ ...base, mode: 'fit-width', pageW: 0 })).toBe(1.5);
    expect(fitScale({ ...base, mode: 'fit-width', containerW: 0 })).toBe(1.5);
    expect(fitScale({ ...base, mode: 'fit-page', containerH: 0 })).toBe(1.5);
    expect(fitScale({ ...base, mode: 'fit-page', pageH: -1 })).toBe(1.5);
  });

  it('数字 mode 非法时回退 currentScale', () => {
    expect(fitScale({ ...base, mode: 0 })).toBe(1.5);
    expect(fitScale({ ...base, mode: 'abc' })).toBe(1.5);
    expect(fitScale({ ...base, mode: NaN })).toBe(1.5);
  });
});

describe('clampPage', () => {
  it('收敛到 [1, total]', () => {
    expect(clampPage(1, 22)).toBe(1);
    expect(clampPage(22, 22)).toBe(22);
    expect(clampPage(0, 22)).toBe(1);
    expect(clampPage(-3, 22)).toBe(1);
    expect(clampPage(23, 22)).toBe(22);
  });

  it('支持字符串与取整', () => {
    expect(clampPage('5', 22)).toBe(5);
    expect(clampPage(3.7, 22)).toBe(3);
  });

  it('非法输入回 1', () => {
    expect(clampPage('abc', 22)).toBe(1);
    expect(clampPage(NaN, 22)).toBe(1);
    expect(clampPage(undefined, 22)).toBe(1);
  });

  it('total 非法时按 1 处理', () => {
    expect(clampPage(5, 0)).toBe(1);
    expect(clampPage(5, NaN)).toBe(1);
    expect(clampPage(5, undefined)).toBe(1);
  });
});

describe('ptToPx / pxToPt', () => {
  it('pt 与 px 按 scale 互换', () => {
    expect(ptToPx(72, 2)).toBe(144);
    expect(pxToPt(144, 2)).toBe(72);
  });

  it('互为逆运算', () => {
    const s = 1.37;
    expect(pxToPt(ptToPx(100, s), s)).toBeCloseTo(100, 10);
  });

  it('scale 为 0 时 pxToPt 返回 0', () => {
    expect(pxToPt(100, 0)).toBe(0);
  });
});

describe('pageWrapStyleFor', () => {
  const a4 = { w: 595.276, h: 841.89 };

  it('fit-width 布局纯 CSS 驱动，不受 scale 影响', () => {
    expect(pageWrapStyleFor('fit-width', a4, 0.5, 300)).toEqual({
      width: '100%',
      aspectRatio: '595.276 / 841.89',
    });
  });

  it('fit-page 用 min(100%, px) 兜底，px 过期也不会横向溢出', () => {
    const s = pageWrapStyleFor('fit-page', a4, 1.5, 595.276 * 1.5);
    expect(s.width).toBe('min(100%, 893px)');
    expect(s.aspectRatio).toBe('595.276 / 841.89');
  });

  it('数字缩放用固定 px，允许超出容器横向滚动', () => {
    const s = pageWrapStyleFor(1.25, a4, 1.25, 0);
    expect(s.width).toBe(`${Math.round(595.276 * 1.25)}px`);
  });

  it('px 尺寸非法时下限 1px，避免零宽占位', () => {
    expect(pageWrapStyleFor('fit-page', a4, 1, 0).width).toBe('min(100%, 1px)');
    expect(pageWrapStyleFor(0.001, a4, 0.001, 0).width).toBe('1px');
  });
});
