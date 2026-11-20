<template>
  <section class="outline-panel panel-section">
    <div class="panel-head">
      <el-icon class="head-glyph" aria-hidden="true"><Memo /></el-icon>
      <h4>大纲</h4>
      <span class="muted count">{{ items.length }}</span>
    </div>
    <div ref="retainedScrollEl" class="outline-scroll">
      <div v-for="({ item, i }) in visibleItems" :key="item.line + ':' + i" class="outline-item"
        :class="{ active: i === activeIndex }" :style="{ paddingLeft: (6 + item.level * 14) + 'px' }"
        :title="'第 ' + (item.line + 1) + ' 行'" @click="jump(item.line)">
        <span
          class="chev"
          :class="{ leaf: !hasChildren(i) }"
          @click.stop="hasChildren(i) && toggle(i)"
        >{{ hasChildren(i) ? (collapsed.has(i) ? '▸' : '▾') : marks[item.level] || '•' }}</span>
        <span class="title">{{ item.title }}</span>
      </div>
      <div v-if="!items.length" class="empty"><el-icon class="empty-glyph" aria-hidden="true"><Memo /></el-icon>当前文件没有章节标题</div>
    </div>
  </section>
</template>

<script setup>
import { useRetainedScroll } from '../../lib/retainedScroll.js';
import { computed, nextTick, ref } from 'vue';
import { useEditorStore } from '../../stores/editor.js';
import { useEditorRuntime } from '../../lib/editorRuntime.js';
import { activeOutlineIndex } from '../../lib/outline.js';

const store = useEditorStore();
const retainedScrollEl = ref(null);
useRetainedScroll(retainedScrollEl, { scope: store, key: () => 'outline-scroll', active: () => store.sidebar === 'tree' });
const editorRuntime = useEditorRuntime();
const marks = ['◆', '·', '·', '·'];
const items = computed(() => store.outline || []);
const activeIndex = computed(() => activeOutlineIndex(items.value, store.cursorLine));
const collapsed = ref(new Set());

function hasChildren(i) {
  const list = items.value;
  return i + 1 < list.length && list[i + 1].level > list[i].level;
}

function toggle(i) {
  const s = new Set(collapsed.value);
  if (s.has(i)) s.delete(i); else s.add(i);
  collapsed.value = s;
}

// 折叠语义：折叠某节点时，隐藏其后所有级别更深的节点（直到同级或更高级节点）
const visibleItems = computed(() => {
  const out = [];
  const collapsedLevels = []; // 处于折叠态的祖先级别栈
  items.value.forEach((item, i) => {
    while (collapsedLevels.length && collapsedLevels[collapsedLevels.length - 1] >= item.level) collapsedLevels.pop();
    if (!collapsedLevels.length) out.push({ item, i });
    if (collapsed.value.has(i)) collapsedLevels.push(item.level);
  });
  return out;
});

function jump(line) {
  editorRuntime.jumpToLine(line);
  nextTick(() => {
    const el = retainedScrollEl.value?.querySelector('.outline-item.active');
    el?.scrollIntoView({ block: 'nearest' });
  });
}
</script>

<style scoped>
.panel-section { display:flex; flex:1 1 0; flex-direction:column; min-height:0; height:100%; border-top:1px solid var(--border); overflow:hidden; }
.panel-head { display:flex; align-items:center; padding:8px 10px; border-bottom:1px solid var(--border); }
.panel-head h4 { margin:0; font-size:12px; text-transform:uppercase; letter-spacing:.04em; color:var(--fg-dim); flex:1; }
.count { font-size:11px; }
.outline-scroll { flex:1; min-height:0; overflow:auto; padding:4px 0; }
.outline-item { width:100%; display:flex; align-items:center; gap:5px; min-height:27px; border:0; border-radius:0; background:transparent; text-align:left; color:var(--fg-dim); padding-top:3px; padding-bottom:3px; padding-right:8px; font-size:12px; cursor:pointer; }
.outline-item:hover { background:var(--bg-hover); color:var(--fg); }
.outline-item.active { color:var(--accent); background:rgba(38,162,105,.11); }
.chev { width:14px; flex:none; font-size:10px; text-align:center; color:var(--fg-dim); border-radius:3px; }
.chev:not(.leaf):hover { color:var(--fg); background:var(--bg-hover); }
.chev.leaf { cursor:default; }
.title { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.empty { padding:16px 10px; color:var(--fg-dim); font-size:12px; text-align:center; }

/* ---- visual refinement layer (presentation only) ---- */
.panel-section { border-top-color: color-mix(in srgb, var(--border) 72%, var(--bg2)); }
.panel-head { gap: 7px; border-bottom-color: color-mix(in srgb, var(--border) 72%, var(--bg2)); }
.panel-head h4 { letter-spacing: .06em; font-weight: 650; }
.head-glyph { flex: none; font-size: 13px; color: var(--accent); opacity: .9; }
.count { display: inline-flex; align-items: center; justify-content: center; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 999px; background: var(--accent-soft); color: var(--accent-hover); font-size: 10px; font-weight: 650; font-variant-numeric: tabular-nums; }
.outline-scroll { scrollbar-width: thin; scrollbar-color: color-mix(in srgb, var(--fg-muted) 38%, transparent) transparent; }
.outline-item { transition: background-color var(--motion-hover) var(--ease-standard), color var(--motion-hover) var(--ease-standard); }
.outline-item.active { background: var(--accent-soft); color: var(--accent-hover); font-weight: 600; box-shadow: inset 2px 0 0 var(--accent); }
.outline-item.active .chev { color: var(--accent); }
.chev { transition: color var(--motion-hover) var(--ease-standard), background-color var(--motion-hover) var(--ease-standard); }
.empty { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 22px 10px; color: var(--fg-muted); letter-spacing: .01em; }
.empty-glyph { font-size: 22px; color: color-mix(in srgb, var(--accent) 45%, var(--fg-muted)); opacity: .8; }
@media (prefers-reduced-motion: reduce) {
  .outline-item, .chev { transition: none; }
}
@media (forced-colors: active) {
  .head-glyph, .empty-glyph { color: CanvasText; }
  .outline-item.active { box-shadow: none; }
}
</style>
