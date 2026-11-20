<template>
  <div class="info-panel">
    <div class="panel-title">
      <el-icon class="head-glyph" aria-hidden="true"><DataAnalysis /></el-icon>
      摘要
      <span class="grow"></span>
      <el-button text size="small" title="重新统计" @click="store.loadStats()">↻ 刷新</el-button>
    </div>

    <div v-if="store.stats" class="stat-grid">
      <div v-for="s in statItems" :key="s.label" class="card stat">
        <div class="stat-value">{{ s.value }}</div>
        <div class="stat-label">{{ s.label }}</div>
      </div>
    </div>

    <div v-else class="empty">
      <el-icon class="empty-glyph" aria-hidden="true"><TrendCharts /></el-icon>
      <p class="muted">尚未生成统计数据</p>
      <el-button type="primary" size="small" @click="store.loadStats()">点击刷新</el-button>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted } from 'vue';
import { useEditorStore } from '../../stores/editor.js';

const store = useEditorStore();

const statItems = computed(() => {
  const s = store.stats || {};
  return [
    { label: '词数', value: s.words },
    { label: '正文词数', value: s.bodyWords },
    { label: '标题词数', value: s.headingWords },
    { label: '正文外词数', value: s.otherWords },
    { label: '标题数量', value: s.headings },
    { label: '图表数量', value: s.figuresAndTables },
    { label: '内联数学公式数量', value: s.inlineMath },
    { label: '独立显示数学公式数量', value: s.displayMath },
  ].map((x) => ({ ...x, value: x.value ?? 0 }));
});

onMounted(() => store.loadStats());
</script>

<style scoped>
.info-panel { padding: 12px; }
.panel-title {
  display: flex;
  align-items: center;
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 10px;
}
.grow { flex: 1; }
.stat-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.stat { padding: 12px; text-align: center; }
.stat-value { font-size: 20px; font-weight: 700; color: var(--accent); }
.stat-label { font-size: 12px; color: var(--fg-dim); margin-top: 4px; }
.empty { text-align: center; padding: 32px 0; }

/* ---- visual refinement layer (presentation only) ---- */
.panel-title { gap: 7px; font-weight: 650; letter-spacing: .01em; }
.head-glyph { flex: none; font-size: 14px; color: var(--accent); opacity: .9; }
.stat-grid { gap: 9px; }
.stat { padding: 13px 12px; border-radius: var(--radius-md); transition: border-color var(--motion-hover) var(--ease-standard), box-shadow var(--motion-hover) var(--ease-standard), transform var(--motion-hover) var(--ease-standard); }
.stat:hover { border-color: color-mix(in srgb, var(--accent) 38%, var(--glass-edge)); box-shadow: var(--glass-shadow), var(--shadow-sm); transform: translateY(-1px); }
.stat-value { font-size: 21px; letter-spacing: -.02em; font-variant-numeric: tabular-nums; background: linear-gradient(180deg, color-mix(in srgb, var(--accent) 82%, var(--fg)), var(--accent-hover)); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; color: var(--accent-hover); }
.stat-label { font-size: 11px; letter-spacing: .02em; color: var(--fg-muted); }
.empty { display: flex; flex-direction: column; align-items: center; gap: 4px; }
.empty .muted { margin: 4px 0 8px; }
.empty-glyph { font-size: 26px; color: color-mix(in srgb, var(--accent) 45%, var(--fg-muted)); opacity: .8; }
@media (prefers-reduced-motion: reduce) {
  .stat { transition: none; }
  .stat:hover { transform: none; }
}
@media (forced-colors: active) {
  .head-glyph, .empty-glyph { color: CanvasText; }
  .stat-value { background: none; -webkit-text-fill-color: currentColor; color: CanvasText; }
  .stat:hover { transform: none; box-shadow: none; }
}
</style>
