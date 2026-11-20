// 编辑器工具栏/版本面板的纯逻辑工具（模板生成、行号换算、版本按日分组）

/**
 * figure 环境模板。width 为 \textwidth 的比例（0-1），非法值回落 0.8。
 */
export function makeFigureTemplate(path, width = 0.8) {
  let w = Number(width);
  if (!Number.isFinite(w) || w <= 0 || w > 1) w = 0.8;
  const p = String(path || '').trim();
  return [
    '',
    '\\begin{figure}[htbp]',
    '  \\centering',
    `  \\includegraphics[width=${w}\\textwidth]{${p}}`,
    '  \\caption{}',
    '  \\label{fig:}',
    '\\end{figure}',
    '',
  ].join('\n');
}

/**
 * booktabs 表格模板。rows 为含表头的总行数（首行生成 列1..列N 表头），
 * rows/cols 取整并夹在 1..50。
 */
export function makeTableTemplate(rows = 3, cols = 3) {
  rows = Math.min(50, Math.max(1, Math.round(Number(rows) || 0)));
  cols = Math.min(50, Math.max(1, Math.round(Number(cols) || 0)));
  const header = Array.from({ length: cols }, (_, i) => `列${i + 1}`).join(' & ');
  const emptyRow = Array.from({ length: cols }, () => ' ').join(' & ');
  const bodyRows = [];
  for (let i = 1; i < rows; i++) bodyRows.push(`    ${emptyRow} \\\\`);
  return [
    '',
    '\\begin{table}[htbp]',
    '  \\centering',
    '  \\caption{}',
    '  \\label{tab:}',
    `  \\begin{tabular}{${'c'.repeat(cols)}}`,
    '    \\toprule',
    `    ${header} \\\\`,
    '    \\midrule',
    ...bodyRows,
    '    \\bottomrule',
    '  \\end{tabular}',
    '\\end{table}',
    '',
  ].join('\n');
}

/** 文本偏移量 → 0 基行号（offset 夹在合法范围内） */
export function offsetToLine(text, offset) {
  text = String(text || '');
  const off = Math.min(Math.max(0, Number(offset) || 0), text.length);
  let line = 0;
  for (let i = 0; i < off; i++) {
    if (text[i] === '\n') line++;
  }
  return line;
}

function dayKey(createdAt) {
  const s = String(createdAt || '');
  const t = new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
  if (Number.isNaN(t.getTime())) return '未知日期';
  const pad = (n) => String(n).padStart(2, '0');
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
}

/**
 * 版本按日分组：保留输入顺序（假定 API 已按新→旧排序），
 * 返回 [{ day: 'YYYY-MM-DD', items: [...] }]。
 */
export function groupVersionsByDay(versions) {
  const groups = [];
  const byDay = new Map();
  for (const v of versions || []) {
    const day = dayKey(v.createdAt);
    let g = byDay.get(day);
    if (!g) {
      g = { day, items: [] };
      byDay.set(day, g);
      groups.push(g);
    }
    g.items.push(v);
  }
  return groups;
}


/**
 * 区域缩放系数（Ctrl+滚轮）钳制：限定区间并保留两位小数；
 * 非数值输入回落到 1（100%）。
 */
export function clampZoom(z, min = 0.7, max = 1.6) {
  const n = Number(z);
  if (!Number.isFinite(n)) return 1;
  return Math.min(max, Math.max(min, Math.round(n * 100) / 100));
}

/**
 * 左侧栏宽度拖动换算：光标 x 与图标轨右缘之差即目标宽度，再钳到可拖区间。
 */
export function sideWidthFromPointer(clientX, railRight, min = 180, max = 560) {
  const px = Number(clientX);
  if (!Number.isFinite(px) || !Number.isFinite(railRight)) return min;
  return Math.max(min, Math.min(max, Math.round(px - railRight)));
}

/**
 * 左侧栏 Ctrl+滚轮缩放：只放大内部内容，**不改面板宽度**。
 * 用 transform: scale 实现（zoom 属性在 Chrome 下会因缩放坐标系取整，
 * 使最右侧一列内容被 overflow:hidden 裁掉）：布局盒固定为 100%/z，
 * 绘制时放大 z 倍，恰好铺满标题栏下方的独立 side-viewport。百分比高度必须
 * 相对这一内容视口计算，不能相对包含标题栏的整个侧栏。flex:none 防止布局盒撑回 100%
 * 导致纵向溢出。z 为 1（100%）时返回空样式，走 CSS 默认的 flex:1 填充。
 */
export function sideBodyStyle(z, min = 0.7, max = 1.6) {
  const zoom = Number(z);
  if (!Number.isFinite(zoom) || zoom === 1) return {};
  const clamped = Math.min(max, Math.max(min, zoom));
  return {
    transform: `scale(${clamped})`,
    transformOrigin: 'top left',
    width: `calc(100% / ${clamped})`,
    height: `calc(100% / ${clamped})`,
    flex: 'none',
  };
}

/**
 * 左侧栏三段面板（文件树 top / 工作空间 mid / 大纲吃剩余）的分隔条拖动换算。
 * 让位优先级按用户指定（2026-10-14）：大纲最次要、工作空间次之——
 * - 上分隔条下压：文件树增长，**优先压缩大纲**；大纲压到底部（标题条）后，
 *   才轮到工作空间收缩（「优先压缩大纲，大纲压缩到底部的时候，对应工作区收缩」）；
 * - 上分隔条上收：空间全给工作空间，大纲不动；
 * - 下分隔条下压：工作空间增长、只有大纲让位；上收：工作空间收缩到标题条即停，
 *   绝不连带压缩文件树（文件树不动，大纲也不因此额外扩张）。
 * 最小值由调用方按标题行像素高度折算传入（EditorView 用 PANE_MIN_PX），
 * 因此任一面板都能折叠到只剩标题条，不会再「触底卡住」。
 * 返回 { top, mid, outline }，恒满足三段之和为 100 且各自不低于最小值。
 */
export function sidePanesFromDrag(which, pointerPct, current = {}, mins = {}) {
  const topMin = mins.top ?? 15;
  const midMin = mins.mid ?? 12;
  const outlineMin = mins.outline ?? 15;
  let top = Number(current.top);
  let mid = Number(current.mid);
  if (!Number.isFinite(top) || top < topMin) top = topMin;
  if (!Number.isFinite(mid) || mid < midMin) mid = midMin;
  // 历史持久化的脏数据可能让大纲低于最小值：从工作空间回扣补齐
  if (top + mid > 100 - outlineMin) mid = Math.max(midMin, 100 - outlineMin - top);

  const p = Number(pointerPct);
  if (which === 'top') {
    const next = Math.max(topMin, Math.min(Number.isFinite(p) ? p : top, 100 - midMin - outlineMin));
    if (next > top) {
      // 下压：优先压缩大纲，大纲让尽后剩余部分由工作空间收缩
      const need = next - top;
      const fromOutline = Math.min(100 - top - mid - outlineMin, need);
      mid -= need - fromOutline;
    } else {
      mid += top - next;
    }
    top = next;
  } else {
    // 只在 mid/outline 两段之间挪动：文件树不动
    mid = Math.max(midMin, Math.min(Number.isFinite(p) ? p - top : mid, 100 - top - outlineMin));
  }
  return { top, mid, outline: 100 - top - mid };
}


/** Panel widths are stored as a fraction of the whole workbench, independent of monitor size. */
export function panelWidthRatio(width, viewportWidth) {
  const ratio = Number(width) / Number(viewportWidth);
  return Number.isFinite(ratio) && ratio > 0 ? Math.min(0.5, Number(ratio.toFixed(6))) : 0;
}

/** Migrate historic pixel preferences using the original 1440px desktop layout. */
export function readPanelWidthRatio(storage, panel) {
  const key = `corelatex.${panel}WidthRatio`;
  const stored = Number(storage.getItem(key));
  if (Number.isFinite(stored) && stored > 0 && stored <= 0.5) return stored;
  const legacy = Number(storage.getItem(`corelatex.${panel}Width`));
  if (Number.isFinite(legacy) && legacy > 0) {
    const migrated = panelWidthRatio(legacy, 1440);
    savePanelWidthRatio(storage, panel, migrated);
    return migrated;
  }
  return panel === 'side' ? 0.2 : 0;
}

export function savePanelWidthRatio(storage, panel, ratio) {
  const key = `corelatex.${panel}WidthRatio`;
  if (Number.isFinite(ratio) && ratio > 0 && ratio <= 0.5) storage.setItem(key, String(ratio));
  else storage.removeItem(key);
  storage.removeItem(`corelatex.${panel}Width`);
}

/** Responsive workbench geometry. Overlay panels never consume the editor's width. */
export function editorPanelLayout(viewportWidth, options = {}) {
  const number = (value, fallback) => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback;
  const width = Math.max(240, number(viewportWidth, 1440));
  const railWidth = width < 600 ? 44 : 48;
  const sideOverlay = width < 1180;
  const rightOverlay = width < 980;
  const overlayMax = Math.max(180, width - railWidth - 16);
  // Desktop limits are proportional; only the editor's usable minimum remains in pixels.
  const sideMax = sideOverlay
    ? Math.min(420, overlayMax)
    : Math.min(Math.floor(width * 0.3), width - railWidth - 420 - 6 - (options.rightOpen ? 280 : 0));
  const sideMin = Math.min(220, sideMax);
  const preferredSide = number(options.sideRatio, 0) * width || number(options.sideWidth, width * 0.2);
  const sideWidth = sideOverlay ? sideMax : Math.round(Math.min(sideMax, Math.max(sideMin, preferredSide)));
  const rightMax = rightOverlay
    ? Math.min(640, overlayMax)
    : Math.min(Math.floor(width * 0.5), width - railWidth - 420 - (!sideOverlay && options.sideOpen ? sideWidth + 6 : 0));
  const rightMin = Math.min(280, rightMax);
  const preferredRight = number(options.rightRatio, 0) * width || number(options.rightWidth, width * (options.rightTab === 'pdf' ? 1 / 3 : 0.25));
  const rightWidth = rightOverlay ? rightMax : Math.round(Math.min(rightMax, Math.max(rightMin, preferredRight)));
  return { viewportWidth: width, railWidth, sideOverlay, rightOverlay, sideWidth, sideMin, sideMax, rightWidth, rightMin, rightMax, sideRatio: sideWidth / width, rightRatio: rightWidth / width };
}

/** Keyboard separators follow physical directions; right panels expand towards the left. */
export function panelWidthFromKey(current, key, min, max, reverse = false, step = 16) {
  if (key === 'Home') return min;
  if (key === 'End') return max;
  if (key !== 'ArrowLeft' && key !== 'ArrowRight') return null;
  const delta = (key === 'ArrowRight' ? 1 : -1) * (reverse ? -1 : 1) * step;
  return Math.min(max, Math.max(min, Math.round(current + delta)));
}
