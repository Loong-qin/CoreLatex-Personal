import { describe, it, expect } from 'vitest';
import {
  makeFigureTemplate,
  makeTableTemplate,
  offsetToLine,
  groupVersionsByDay,
  clampZoom,
  sideWidthFromPointer,
  sideBodyStyle,
  sidePanesFromDrag,
} from '../../lib/editorUtils.js';

describe('makeFigureTemplate', () => {
  it('生成含路径与宽度的 figure 环境', () => {
    const t = makeFigureTemplate('figs/a.png', 0.6);
    expect(t).toContain('\\begin{figure}[htbp]');
    expect(t).toContain('\\includegraphics[width=0.6\\textwidth]{figs/a.png}');
    expect(t).toContain('\\end{figure}');
  });

  it('非法宽度回落 0.8', () => {
    expect(makeFigureTemplate('a.png', 'abc')).toContain('width=0.8\\textwidth');
    expect(makeFigureTemplate('a.png', 5)).toContain('width=0.8\\textwidth');
  });
});

describe('makeTableTemplate', () => {
  it('生成 booktabs 结构且行列数正确', () => {
    const t = makeTableTemplate(3, 2);
    expect(t).toContain('\\toprule');
    expect(t).toContain('\\midrule');
    expect(t).toContain('\\bottomrule');
    expect(t).toContain('\\begin{tabular}{cc}');
    expect(t).toContain('列1 & 列2 \\\\');
    // 3 行含表头 → 2 个空数据行 + 1 表头行 = 3 个 \\
    expect(t.split('\\\\').length - 1).toBe(3);
  });

  it('行列下限为 1', () => {
    const t = makeTableTemplate(0, 0);
    expect(t).toContain('\\begin{tabular}{c}');
    expect(t).toContain('列1 \\\\');
  });
});

describe('offsetToLine', () => {
  const text = 'line0\nline1\nli\nne3';
  it('换算 0 基行号', () => {
    expect(offsetToLine(text, 0)).toBe(0);
    expect(offsetToLine(text, 5)).toBe(0);
    expect(offsetToLine(text, 6)).toBe(1);
    expect(offsetToLine(text, 12)).toBe(2);
  });
  it('越界 offset 被夹住', () => {
    expect(offsetToLine(text, -5)).toBe(0);
    expect(offsetToLine(text, 9999)).toBe(3);
  });
});

describe('groupVersionsByDay', () => {
  it('按日分组且保留输入顺序', () => {
    const groups = groupVersionsByDay([
      { id: 3, createdAt: '2026-09-21T09:00:00' },
      { id: 2, createdAt: '2026-09-21T08:00:00' },
      { id: 1, createdAt: '2026-09-20T20:00:00' },
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0].day).toBe('2026-09-21');
    expect(groups[0].items.map((v) => v.id)).toEqual([3, 2]);
    expect(groups[1].day).toBe('2026-09-20');
    expect(groups[1].items.map((v) => v.id)).toEqual([1]);
  });
  it('空输入与非法日期', () => {
    expect(groupVersionsByDay([])).toEqual([]);
    expect(groupVersionsByDay(null)).toEqual([]);
    const g = groupVersionsByDay([{ id: 1, createdAt: 'not-a-date' }]);
    expect(g[0].day).toBe('未知日期');
  });
});

describe('clampZoom', () => {
  it('区间内保留两位小数', () => {
    expect(clampZoom(1.05)).toBe(1.05);
    expect(clampZoom(0.7)).toBe(0.7);
  });
  it('越界钳到上下限', () => {
    expect(clampZoom(9)).toBe(1.6);
    expect(clampZoom(0.1)).toBe(0.7);
  });
  it('非法输入回落到 1', () => {
    expect(clampZoom(NaN)).toBe(1);
    expect(clampZoom('abc')).toBe(1);
  });
});

describe('sideWidthFromPointer', () => {
  it('目标宽度 = 光标 x 减图标轨右缘', () => {
    expect(sideWidthFromPointer(446, 46)).toBe(400);
  });
  it('越界钳到 180/560，非法输入回落下限', () => {
    expect(sideWidthFromPointer(100, 46)).toBe(180);
    expect(sideWidthFromPointer(2000, 46)).toBe(560);
    expect(sideWidthFromPointer(NaN, 46)).toBe(180);
  });
});

describe('sideBodyStyle', () => {
  it('100% 时不产生额外样式', () => {
    expect(sideBodyStyle(1)).toEqual({});
    expect(sideBodyStyle(NaN)).toEqual({});
  });
  it('transform 放大内容、占位尺寸除以缩放系数，并锁定 flex 防止被撑满', () => {
    const s = sideBodyStyle(1.5);
    expect(s.transform).toBe('scale(1.5)');
    expect(s.transformOrigin).toBe('top left');
    expect(s.width).toBe('calc(100% / 1.5)');
    expect(s.height).toBe('calc(100% / 1.5)');
    expect(s.flex).toBe('none');
  });
  it('越界钳到 0.7/1.6', () => {
    expect(sideBodyStyle(3).transform).toBe('scale(1.6)');
    expect(sideBodyStyle(0.1).transform).toBe('scale(0.7)');
  });
});

describe('sidePanesFromDrag', () => {
  // 默认约定：文件树 ≥15、工作空间 ≥12、大纲 ≥15，三段和恒为 100。
  // EditorView 实际按标题行像素折算传 mins（见 SLIVER），面板可折叠到只剩标题条。
  const DEF = { top: 45, mid: 25 };
  const SLIVER = { top: 5, mid: 4, outline: 4 };

  it('常规区间内两条分隔条都精确跟手', () => {
    expect(sidePanesFromDrag('top', 55, DEF)).toEqual({ top: 55, mid: 25, outline: 20 });
    expect(sidePanesFromDrag('mid', 65, DEF)).toEqual({ top: 45, mid: 20, outline: 35 });
  });

  it('上分隔条下压：优先压缩大纲，大纲到底后工作空间才开始收缩（用户指定优先级）', () => {
    // 压到 65：大纲让 10（30→20），工作空间不动
    expect(sidePanesFromDrag('top', 55, DEF)).toEqual({ top: 55, mid: 25, outline: 20 });
    // 压到 65：大纲让尽 15 到底，剩余 5 由工作空间收缩
    expect(sidePanesFromDrag('top', 65, DEF)).toEqual({ top: 65, mid: 20, outline: 15 });
    // 一路压到全局极限（100 - 12 - 15 = 73）后停住
    expect(sidePanesFromDrag('top', 90, DEF)).toEqual({ top: 73, mid: 12, outline: 15 });
  });

  it('工作空间已是标题条时，上分隔条下压继续压大纲、工作空间不动（用户实录场景）', () => {
    const SLIVER = { top: 5, mid: 4, outline: 4 };
    // 文件树 40 + 工作空间 6（近最小值）+ 大纲 54：拖上分隔条到 70 → 大纲让 30，工作空间保持 6
    expect(sidePanesFromDrag('top', 70, { top: 40, mid: 6 }, SLIVER)).toEqual({ top: 70, mid: 6, outline: 24 });
    // 大纲压到标题条后，再压才开始收缩工作空间
    expect(sidePanesFromDrag('top', 90, { top: 40, mid: 6 }, SLIVER)).toEqual({ top: 90, mid: 6, outline: 4 });
    expect(sidePanesFromDrag('top', 95, { top: 40, mid: 6 }, SLIVER)).toEqual({ top: 92, mid: 4, outline: 4 });
  });

  it('上分隔条上收：空间全部给工作空间，文件树到最小值即停', () => {
    expect(sidePanesFromDrag('top', 30, DEF)).toEqual({ top: 30, mid: 40, outline: 30 });
    expect(sidePanesFromDrag('top', 5, DEF)).toEqual({ top: 15, mid: 55, outline: 30 });
  });

  it('下分隔条下压：只有大纲让位，压到最小值 15 后停住，文件树不动', () => {
    expect(sidePanesFromDrag('mid', 85, DEF)).toEqual({ top: 45, mid: 40, outline: 15 });
    expect(sidePanesFromDrag('mid', 95, DEF)).toEqual({ top: 45, mid: 40, outline: 15 });
  });

  it('下分隔条上收：工作空间到最小值即停，绝不连带压缩文件树（不把大纲带出来）', () => {
    expect(sidePanesFromDrag('mid', 35, DEF)).toEqual({ top: 45, mid: 12, outline: 43 });
    expect(sidePanesFromDrag('mid', 3, DEF)).toEqual({ top: 45, mid: 12, outline: 43 });
  });

  it('像素折算的窄最小值：面板可折叠到只剩标题条，下压几乎触底', () => {
    expect(sidePanesFromDrag('mid', 97, DEF, SLIVER)).toEqual({ top: 45, mid: 51, outline: 4 });
    // 上分隔条下压同样先吃大纲（30→4），余量再吃工作空间（25→16）
    expect(sidePanesFromDrag('top', 80, DEF, SLIVER)).toEqual({ top: 80, mid: 16, outline: 4 });
  });

  it('三段之和恒为 100 且不低于各自最小值（连续扫过全部指针位置）', () => {
    for (const mins of [undefined, SLIVER]) {
      for (let p = -20; p <= 120; p += 0.5) {
        for (const which of ['top', 'mid']) {
          const r = sidePanesFromDrag(which, p, DEF, mins);
          expect(r.top).toBeGreaterThanOrEqual(mins?.top ?? 15);
          expect(r.mid).toBeGreaterThanOrEqual(mins?.mid ?? 12);
          expect(r.outline).toBeGreaterThanOrEqual(mins?.outline ?? 15);
          expect(r.top + r.mid + r.outline).toBeCloseTo(100);
        }
      }
    }
  });

  it('非法输入回退到当前布局，脏数据（低于最小值）先被修正', () => {
    expect(sidePanesFromDrag('top', NaN, DEF)).toEqual({ top: 45, mid: 25, outline: 30 });
    // top=60 + mid=45 会让大纲为 -5：mid 先回扣到 25，大纲恢复 15
    expect(sidePanesFromDrag('top', 60, { top: 60, mid: 45 })).toEqual({ top: 60, mid: 25, outline: 15 });
    // 净化后正常参与拖动：指针 70 → 工作空间收窄，文件树不动
    expect(sidePanesFromDrag('mid', 70, { top: 60, mid: 45 })).toEqual({ top: 60, mid: 12, outline: 28 });
  });
});
