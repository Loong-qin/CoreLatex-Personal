<script setup>
// 编辑区右缘「概览滚动条」：滚动条与文档概览合二为一，替代原生滚动条。
// - 圆角滑块 = 当前视口区域：拖动即滚动、点击轨道定位、滚轮/方向键均可操作；
//   滑块位置在滚动/拖动的同一帧同步更新（零防抖），保证跟手；
// - 标记概览叠于滑块之上：待审修改块 / 编译错误警告 / 选中词 / 批注 / 搜索匹配 / 光标，
//   点击跳转或转移选区，悬停查看详情（标记内容按 60ms 防抖刷新，不拖累滑块）。
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import { useEditorStore } from '../../stores/editor.js';
import { useEditorRuntime } from '../../lib/editorRuntime.js';
import { buildReviewRanges } from '../../lib/reviewDecorations.js';

const store = useEditorStore();
const editorRuntime = useEditorRuntime();

const hidden = ref(true);
const viewport = ref({ top: 0, height: 100 });
const marks = ref([]);
const cursorTop = ref(null);
const barEl = ref(null);
const box = ref({ top: 0, height: 0 }); // 状态条实际渲染区间（标签栏下方起）
const scrollTopNow = ref(0);
const maxScrollNow = ref(0);

let scrollEl = null;
let resizeObserver = null;
let unsubscribe = null;
let debounceId = 0;
let pollId = 0;
const dragging = ref(false); // 正在拖动滑块（响应式：驱动 grabbing 形态）
let dragStartY = 0;
let dragStartScroll = 0;

const MIN_THUMB_PX = 28;

// 滑块几何：百分比 + 最小可抓高度（px），拖动换算与命中判定共用同一口径
function bandMetrics() {
  const trackH = barEl.value?.clientHeight || 0;
  const topPx = (viewport.value.top / 100) * trackH;
  const heightPx = Math.max(MIN_THUMB_PX, (viewport.value.height / 100) * trackH);
  return { trackH, topPx, heightPx };
}

// 轻量同步更新：只读滚动度量，滚动/拖动当帧立即反映到滑块与 ARIA
function updateViewport() {
  if (!scrollEl) return;
  const scrollH = scrollEl.scrollHeight;
  const clientH = scrollEl.clientHeight;
  scrollTopNow.value = scrollEl.scrollTop;
  maxScrollNow.value = Math.max(0, scrollH - clientH);
  viewport.value = scrollH > 0
    ? { top: (scrollEl.scrollTop / scrollH) * 100, height: Math.max(1, (clientH / scrollH) * 100) }
    : { top: 0, height: 100 };
}

function scheduleRefresh() {
  clearTimeout(debounceId);
  debounceId = setTimeout(refresh, 60);
}

// 文档坐标块 → 状态条纵向百分比（按滚动总高换算，行折行也准确）
function yPct(view, doc, lineNo) {
  const scrollH = scrollEl?.scrollHeight || 0;
  if (!scrollH) return 0;
  const ln = doc.line(Math.min(Math.max(1, lineNo), doc.lines));
  const block = view.lineBlockAt(ln.from);
  const pct = ((block.top + Math.min(block.height, scrollH) / 2) / scrollH) * 100;
  return Math.min(100, Math.max(0, pct));
}

function refresh() {
  const view = editorRuntime.view;
  if (!view || !scrollEl || store.viewMode !== 'code') {
    hidden.value = true;
    return;
  }
  hidden.value = false;
  const doc = view.state.doc;
  // 状态条从滚动区域顶部开始（即标签栏下方），高度与滚动区域一致
  const host = scrollEl.closest('.editor-host');
  if (host) {
    const sr = scrollEl.getBoundingClientRect();
    const hr = host.getBoundingClientRect();
    box.value = { top: Math.max(0, sr.top - hr.top), height: sr.height };
  }
  const list = [];
  // 审阅修改块（含当前块高亮）
  const dr = store.diffReview;
  if (dr?.hunks?.length) {
    dr.hunks.forEach((h, i) => {
      list.push({
        key: `h${i}`,
        type: i === dr.hunkIdx ? 'hunk-cur' : 'hunk',
        top: yPct(view, doc, h.docFrom),
        title: `修改块 ${i + 1}/${dr.hunks.length} · 第 ${h.docFrom} 行`,
        i,
      });
    });
  }
  // 编译错误/警告（仅当前打开文件的）
  const issues = [
    ...store.compile.errors.map((e) => ({ ...e, kind: 'error' })),
    ...store.compile.warnings.map((w) => ({ ...w, kind: 'warning' })),
  ];
  for (const it of issues) {
    if (!it.line || (it.file && it.file !== store.activeFile)) continue;
    const lineNo = Math.min(Math.max(1, Number(it.line)), doc.lines);
    list.push({
      key: `${it.kind}${list.length}`,
      type: it.kind,
      top: yPct(view, doc, lineNo),
      title: `${it.kind === 'error' ? '错误' : '警告'} · 第 ${lineNo} 行：${String(it.message || '').slice(0, 120)}`,
      line: lineNo,
    });
  }
  // 选中词：标注该词在全文的其余出现位置
  const sel = store.selection;
  if (sel && sel.file === store.activeFile) {
    const text = String(sel.text || '');
    const needle = text.trim();
    if (needle.length >= 2 && needle.length <= 80 && !text.includes('\n')) {
      const docText = view.state.doc.toString();
      const found = [];
      let idx = docText.indexOf(needle);
      while (idx >= 0 && found.length < 200) {
        const overlapsSel = idx < sel.to && idx + needle.length > sel.from;
        if (!overlapsSel) found.push(idx);
        idx = docText.indexOf(needle, idx + needle.length);
      }
      for (const pos of found) {
        const ln = view.state.doc.lineAt(pos);
        list.push({
          key: `w${pos}`,
          type: 'word',
          top: yPct(view, doc, ln.number),
          from: pos,
          to: pos + needle.length,
          title: `“${needle}” 共出现 ${found.length + 1} 处 · 第 ${ln.number} 行（点击选中此处）`,
          line: ln.number,
        });
      }
    }
  }
  // 批注（审阅评论）：当前位置 + 悬停详情，点击选中批注引用的文字
  for (const r of buildReviewRanges(store.reviews, store.activeFile, doc.length)) {
    const ln = doc.lineAt(r.start);
    const author = r.review.authorName || '匿名';
    const content = String(r.review.content || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    list.push({
      key: `c${r.id}`,
      type: 'comment',
      top: yPct(view, doc, ln.number),
      title: `批注 · ${author} · 第 ${ln.number} 行：${content}`,
      from: r.start,
      to: r.end,
      line: ln.number,
    });
  }
  // 搜索匹配（当前文件的命中位置，来自搜索面板）
  const sm = store.searchMatches;
  if (sm && sm.file === store.activeFile) {
      for (const [k, it] of (sm.items || []).entries()) {
        const ln = doc.line(Math.min(it.line + 1, doc.lines));
        const from = ln.from + Math.min(it.col || 0, ln.length);
        const to = Math.min(ln.to, from + (it.len || 0));
        list.push({
          key: `m${k}`,
          type: 'match',
          top: yPct(view, doc, it.line + 1),
          title: `搜索匹配 · 第 ${it.line + 1} 行`,
          line: it.line + 1,
          from,
          to,
        });
      }
  }
  marks.value = list;
  // 光标位置
  cursorTop.value = doc.lines ? yPct(view, doc, Math.min(store.cursorLine + 1, doc.lines)) : null;
  updateViewport();
}

function onScrollFast() {
  updateViewport(); // 滑块当帧同步，跟手
  scheduleRefresh(); // 标记/光标等重内容防抖刷新
}

function wireView(view) {
  if (scrollEl) {
    scrollEl.removeEventListener('scroll', onScrollFast);
    scrollEl = null;
  }
  if (resizeObserver) {
    resizeObserver.disconnect();
    resizeObserver = null;
  }
  if (view) {
    scrollEl = view.scrollDOM;
    scrollEl.addEventListener('scroll', onScrollFast, { passive: true });
    resizeObserver = new ResizeObserver(scheduleRefresh);
    resizeObserver.observe(scrollEl);
  }
  scheduleRefresh();
}

// ---- 滑块拖动 / 轨道点击 / 滚轮 / 键盘（概览条即滚动条） ----
function applyScroll(top) {
  if (!scrollEl) return;
  const maxScroll = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
  scrollEl.scrollTop = Math.max(0, Math.min(maxScroll, top));
  updateViewport();
}

function onBarPointerDown(e) {
  if (!scrollEl || e.target.closest('.ov-mark')) return; // 标记自行处理
  const { trackH, topPx, heightPx } = bandMetrics();
  const scrollH = scrollEl.scrollHeight;
  const clientH = scrollEl.clientHeight;
  const maxScroll = Math.max(0, scrollH - clientH);
  if (maxScroll <= 0 || trackH <= 0) return;
  const yInBar = e.clientY - barEl.value.getBoundingClientRect().top;
  const inBand = yInBar >= topPx && yInBar <= topPx + heightPx;
  if (!inBand) {
    // 点击轨道：把视口中心定位到点击处
    applyScroll((yInBar / trackH) * scrollH - clientH / 2);
  }
  dragging.value = true;
  dragStartY = e.clientY;
  dragStartScroll = scrollEl.scrollTop;
  try { barEl.value.setPointerCapture(e.pointerId); } catch {}
  const pxToScroll = maxScroll / Math.max(1, trackH - heightPx); // 条上 1px 对应的内容滚动量
  const onMove = (ev) => {
    if (!dragging.value) return;
    applyScroll(dragStartScroll + (ev.clientY - dragStartY) * pxToScroll);
  };
  const onUp = () => {
    dragging.value = false;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
}

function onBarWheel(e) {
  if (!scrollEl) return;
  e.preventDefault();
  applyScroll(scrollEl.scrollTop + e.deltaY);
}

function onBarKeydown(e) {
  if (!scrollEl) return;
  const clientH = scrollEl.clientHeight;
  const step = { ArrowDown: 40, ArrowUp: -40, PageDown: clientH * 0.9, PageUp: -clientH * 0.9 }[e.key];
  if (step != null) {
    e.preventDefault();
    applyScroll(scrollEl.scrollTop + step);
  } else if (e.key === 'Home') {
    e.preventDefault();
    applyScroll(0);
  } else if (e.key === 'End') {
    e.preventDefault();
    applyScroll(scrollEl.scrollHeight);
  }
}

// 点击标记：审阅块跳块；选中词/批注/搜索匹配把选区转移到该处（高亮不丢）；错误/警告跳行
function onMarkClick(m) {
  if (m.type === 'hunk' || m.type === 'hunk-cur') {
    store.gotoDiffHunk(m.i);
  } else if (m.from != null) {
    editorRuntime.selectRange(m.from, m.to);
  } else if (m.line) {
    editorRuntime.jumpToLine(m.line - 1);
  }
}

const ariaNow = computed(() => Math.round(scrollTopNow.value));
const ariaMax = computed(() => Math.round(maxScrollNow.value));

onMounted(() => {
  unsubscribe = store.$subscribe(() => scheduleRefresh());
  // 安全网：事件（滚动/store 变更/视口尺寸）之外再以低频兜底刷新，保证状态不滞留
  pollId = window.setInterval(scheduleRefresh, 400);
  scheduleRefresh();
});
onBeforeUnmount(() => {
  if (unsubscribe) unsubscribe();
  if (resizeObserver) resizeObserver.disconnect();
  clearTimeout(debounceId);
  clearInterval(pollId);
});

watch(() => editorRuntime.view, (v) => wireView(v), { immediate: true });
watch(() => store.viewMode, () => scheduleRefresh());
</script>

<template>
  <div
    ref="barEl"
    class="overview-bar"
    :class="{ hidden, dragging }"
    :style="{ marginTop: box.top + 'px', height: box.height + 'px' }"
    role="scrollbar"
    tabindex="0"
    aria-orientation="vertical"
    aria-label="文档概览滚动条"
    :aria-valuemin="0"
    :aria-valuemax="ariaMax"
    :aria-valuenow="ariaNow"
    title="文档概览 / 滚动条：拖动滑块滚动，点击标记跳转，悬停查看详情"
    @pointerdown="onBarPointerDown"
    @wheel="onBarWheel"
    @keydown="onBarKeydown"
  >
    <div class="ov-track" aria-hidden="true"></div>
    <div
      class="ov-viewport"
      :style="{ top: viewport.top + '%', height: viewport.height + '%' }"
    ></div>
    <div
      v-for="m in marks"
      :key="m.key"
      class="ov-mark"
      :class="'ov-' + m.type"
      :style="{ top: m.top + '%' }"
      :title="m.title"
      @pointerdown.stop
      @click.stop="onMarkClick(m)"
    ></div>
    <div v-if="cursorTop != null" class="ov-cursor" :style="{ top: cursorTop + '%' }" title="光标位置"></div>
  </div>
</template>

<style scoped>
/* 概览滚动条：实体列占位（编辑器文字不会伸入该列），替代原生滚动条。
   滑块为内缩圆角胶囊（滚动条形态），标记概览叠于其上。 */
.overview-bar {
  position: relative;
  width: 14px;
  flex: 0 0 14px;
  overflow: hidden;
  cursor: pointer;
  touch-action: none;
  user-select: none;
  outline: none;
}
.overview-bar.hidden { visibility: hidden; }
.overview-bar:focus-visible { box-shadow: inset 0 0 0 2px var(--focus-ring); border-radius: 7px; }
.ov-track {
  position: absolute;
  inset: 2px 3px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--fg-muted) 9%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--border) 55%, transparent);
  pointer-events: none;
}
/* 滑块 = 当前视口区域：位置/高度不做过渡，保证当帧跟手 */
.ov-viewport {
  position: absolute;
  left: 3px;
  right: 3px;
  min-height: 28px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--fg-muted) 34%, transparent);
  box-shadow: inset 0 1px 0 color-mix(in srgb, var(--surface-raised) 35%, transparent);
  cursor: grab;
}
.overview-bar:hover .ov-viewport { background: color-mix(in srgb, var(--accent) 42%, transparent); }
.ov-viewport:hover { background: color-mix(in srgb, var(--accent) 52%, transparent); }
.overview-bar.dragging .ov-viewport {
  background: color-mix(in srgb, var(--accent) 62%, transparent);
  box-shadow: inset 0 1px 0 color-mix(in srgb, var(--surface-raised) 45%, transparent), 0 0 8px color-mix(in srgb, var(--accent) 30%, transparent);
  cursor: grabbing;
}
.overview-bar.dragging { cursor: grabbing; }
/* 标记概览：细刻度叠于滑块之上，语义色不变 */
.ov-mark {
  position: absolute;
  left: 4px;
  right: 4px;
  height: 3px;
  margin-top: -1.5px;
  border-radius: 2px;
  cursor: pointer;
  pointer-events: auto;
  z-index: 2;
  transition: transform var(--motion-hover) var(--ease-standard);
}
.ov-mark:hover { transform: scaleY(1.7); }
.ov-hunk { background: var(--warn); }
.ov-hunk-cur {
  background: var(--accent);
  height: 5px;
  margin-top: -2.5px;
  box-shadow: 0 0 5px color-mix(in srgb, var(--accent) 65%, transparent);
  z-index: 3;
}
.ov-error { background: var(--danger); }
.ov-warning {
  background: var(--bg2);
  border: 1px solid var(--warn);
  height: 5px;
  margin-top: -2.5px;
}
.ov-word { background: color-mix(in srgb, var(--blue) 62%, var(--bg2)); }
.ov-comment { background: var(--accent); }
.ov-match { background: var(--accent-secondary); }
.ov-cursor {
  position: absolute;
  left: 3px;
  right: 3px;
  height: 2px;
  margin-top: -1px;
  border-radius: 1px;
  background: color-mix(in srgb, var(--fg) 62%, transparent);
  pointer-events: none;
  z-index: 2;
}
@media (prefers-reduced-motion: reduce) {
  .ov-mark { transition: none; }
  .ov-mark:hover { transform: none; }
}
@media (forced-colors: active) {
  .ov-track { background: Canvas; box-shadow: inset 0 0 0 1px CanvasText; }
  .ov-viewport { background: GrayText; box-shadow: none; }
  .ov-hunk-cur { box-shadow: none; }
}
</style>

<style>
/* 概览条替代原生滚动条：隐藏 Code 视图编辑器的滚动条本体 */
.editor-host .cm-scroller { scrollbar-width: none; }
.editor-host .cm-scroller::-webkit-scrollbar { display: none; }
</style>
