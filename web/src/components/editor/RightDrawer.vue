<template>
  <aside v-show="visible && !!store.rightTab" id="editor-right-panel" tabindex="-1" class="right-drawer" :class="{ 'drawer-overlay': geometry.rightOverlay }" :style="{ width: drawerWidth + 'px' }" :aria-label="activeTitle">
    <div v-if="!geometry.rightOverlay" class="width-splitter" role="separator" tabindex="0" aria-orientation="vertical" aria-label="右侧面板宽度" aria-controls="editor-right-panel" :aria-valuenow="drawerWidth" :aria-valuemin="geometry.rightMin" :aria-valuemax="geometry.rightMax" :aria-valuetext="`${(geometry.rightRatio * 100).toFixed(1)}% 页面宽度`" :title="`预览区域 ${(geometry.rightRatio * 100).toFixed(1)}% · 最大 50% · 拖动或左右方向键调整，双击恢复默认`" @pointerdown="startWidthDrag" @keydown="onWidthKey" @dblclick="resetWidth"></div>
    <div class="drawer-head">
      <div class="drawer-tabs" role="tablist" aria-label="预览和项目信息">
        <button v-for="t in tabs" :key="t.key" class="head-tab" :class="{ on: store.rightTab === t.key }" :title="t.label" role="tab" :aria-selected="store.rightTab === t.key" @click="selectTab(t.key)">
          <el-icon class="head-icon"><component :is="t.icon" /></el-icon><span>{{ t.label }}</span>
        </button>
      </div>
      <button class="close" title="关闭右侧面板" aria-label="关闭右侧面板" @click="emit('close')"><el-icon><Close /></el-icon></button>
    </div>
    <div ref="retainedScrollEl" class="drawer-body">
      <KeepAlive>
        <PdfPanel v-if="lastRightTab === 'pdf'" ref="pdfPanelRef" :active="visible && store.rightTab === 'pdf'" @jump-to-code="(e) => emit('jump-to-code', e)" />
        <InfoPanel v-else-if="lastRightTab === 'info'" />
        <VersionsPanel v-else-if="lastRightTab === 'versions'" />
        <LogPanel v-else-if="lastRightTab === 'log'" />
      </KeepAlive>
    </div>
  </aside>
</template>

<script setup>
import { useRetainedScroll } from '../../lib/retainedScroll.js';
import { ref, computed, nextTick, onMounted, onBeforeUnmount, watch } from 'vue';
import { Document, InfoFilled, Clock, Tickets, Close } from '@element-plus/icons-vue';
import { useEditorStore } from '../../stores/editor.js';
import { editorPanelLayout, panelWidthFromKey, panelWidthRatio, readPanelWidthRatio, savePanelWidthRatio } from '../../lib/editorUtils.js';
import PdfPanel from './PdfPanel.vue';
import InfoPanel from './InfoPanel.vue';
import VersionsPanel from './VersionsPanel.vue';
import LogPanel from './LogPanel.vue';

const props = defineProps({ layout: { type: Object, default: null }, visible: { type: Boolean, default: true } });
const store = useEditorStore();
const lastRightTab = ref(store.rightTab || 'pdf');
watch(() => store.rightTab, value => { if (value) lastRightTab.value = value; }, { flush: 'sync' });
const retainedScrollEl = ref(null);
useRetainedScroll(retainedScrollEl, { scope: store, key: () => 'drawer-scroll:' + (store.rightTab || lastRightTab.value), active: () => props.visible && !!store.rightTab });
const pdfPanelRef = ref(null);
const emit = defineEmits(['jump-to-code', 'toggle', 'close', 'open', 'width-ratio-change']);
const tabs = [
  { key: 'pdf', label: 'PDF 预览', icon: Document },
  { key: 'info', label: '项目信息', icon: InfoFilled },
  { key: 'versions', label: '版本', icon: Clock },
  { key: 'log', label: '日志', icon: Tickets },
];
function selectTab(key) {
  if (store.rightTab !== key) emit('toggle', key);
}
const activeTitle = computed(() => tabs.find((tab) => tab.key === store.rightTab)?.label || '预览');
const customRatio = ref(readPanelWidthRatio(localStorage, 'right'));
const windowWidth = ref(window.innerWidth);
function onWindowResize() { windowWidth.value = window.innerWidth; }
onMounted(() => window.addEventListener('resize', onWindowResize));
onBeforeUnmount(() => { window.removeEventListener('resize', onWindowResize); stopDragging?.(); });
const geometry = computed(() => props.layout || editorPanelLayout(windowWidth.value, { rightRatio: customRatio.value, rightTab: store.rightTab, rightOpen: true }));
const drawerWidth = computed(() => geometry.value.rightWidth);
function saveWidth(width) {
  const ratio = panelWidthRatio(width, geometry.value.viewportWidth);
  customRatio.value = ratio;
  savePanelWidthRatio(localStorage, 'right', ratio);
  emit('width-ratio-change', ratio);
}
function resetWidth() { customRatio.value = 0; savePanelWidthRatio(localStorage, 'right', 0); emit('width-ratio-change', 0); }
function onWidthKey(e) {
  const next = panelWidthFromKey(drawerWidth.value, e.key, geometry.value.rightMin, geometry.value.rightMax, true, e.shiftKey ? 48 : 16);
  if (next === null) return;
  e.preventDefault(); saveWidth(next);
}
let stopDragging;
function startWidthDrag(e) {
  e.preventDefault();
  stopDragging?.();
  const startX = e.clientX;
  const startWidth = drawerWidth.value;
  const splitter = e.currentTarget;
  try { splitter.setPointerCapture(e.pointerId); } catch {}
  document.body.classList.add('col-resizing');
  const onMove = (ev) => saveWidth(Math.min(geometry.value.rightMax, Math.max(geometry.value.rightMin, Math.round(startWidth + startX - ev.clientX))));
  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    document.body.classList.remove('col-resizing'); stopDragging = null;
  };
  stopDragging = onUp;
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
}
async function jumpToPdf(r) {
  if (store.rightTab !== 'pdf') store.setRightTab('pdf');
  emit('open');
  await nextTick();
  pdfPanelRef.value?.jumpToPdf(r);
}
defineExpose({ jumpToPdf, getPdfPanel: () => pdfPanelRef.value });
</script>

<style scoped>
.right-drawer { position: relative; flex: none; display: flex; flex-direction: column; background: var(--glass-g2-bg); -webkit-backdrop-filter: var(--glass-g2-filter); backdrop-filter: var(--glass-g2-filter); box-shadow: var(--glass-highlight); border-left: 1px solid var(--border); height: 100%; min-width: 0; min-height: 0; container-type: inline-size; }
.width-splitter { position: absolute; left: -3px; top: 0; bottom: 0; width: 7px; cursor: col-resize; touch-action: none; z-index: 6; }
.width-splitter:hover, .width-splitter:active, .width-splitter:focus-visible { background: var(--accent); }
.drawer-head { display: flex; align-items: center; border-bottom: 1px solid var(--border); padding: 0 8px; flex: none; min-height: 42px; gap: 4px; }
.drawer-tabs { display: flex; align-items: center; min-width: 0; flex: 1; overflow-x: auto; scrollbar-width: thin; }
.head-tab { display: flex; align-items: center; gap: 5px; background: transparent; border: none; border-bottom: 2px solid transparent; border-radius: 0; padding: 12px 9px 10px; font-size: 11px; color: var(--fg-muted, var(--fg-dim)); white-space: nowrap; flex: none; }
.head-tab:hover { color: var(--fg); background: transparent; }
.head-tab.on { color: var(--accent); border-bottom-color: var(--accent); }
.head-tab .el-icon { font-size: 14px; }
.close { display: flex; align-items: center; justify-content: center; width: 28px; height: 28px; background: transparent; border: none; color: var(--fg-muted, var(--fg-dim)); padding: 6px; border-radius: 7px; flex: none; }
.close:hover { color: var(--fg); background: var(--bg-hover); }
.drawer-body { flex: 1; overflow-y: auto; min-height: 0; display: flex; flex-direction: column; }
.drawer-body > :deep(*) { flex: 1; min-height: 0; }
.drawer-overlay { position: absolute; z-index: 22; right: 8px; top: 10px; bottom: 10px; height: auto; border: 1px solid var(--border); border-radius: var(--radius-lg, 14px); box-shadow: var(--shadow-sm, 0 12px 36px #0002); overflow: hidden; }
@container (max-width: 420px) { .head-tab { padding-inline: 8px; } .head-tab > span:not(.el-icon) { display: none; } .head-tab.on > span:not(.el-icon) { display: inline; } .drawer-head { padding-inline: 6px; } }

.right-drawer:not(.drawer-overlay) { background: var(--bg2); box-shadow: none; -webkit-backdrop-filter: none; backdrop-filter: none; }
.drawer-overlay { background: var(--glass-g3-bg); border-color: var(--glass-edge); box-shadow: var(--glass-highlight), var(--shadow-lg); -webkit-backdrop-filter: var(--glass-g3-filter); backdrop-filter: var(--glass-g3-filter); }
.head-tab.on { color: var(--accent-hover); border-bottom-color: var(--accent); }

/* ---- visual refinement layer (presentation only) ---- */
.drawer-head { border-bottom-color: color-mix(in srgb, var(--border) 78%, var(--bg2)); }
.head-tab { font-weight: 550; letter-spacing: .01em; border-radius: 0; transition: color var(--motion-hover) var(--ease-standard), border-color var(--motion-hover) var(--ease-standard); }
.head-tab .head-icon { opacity: .85; transition: opacity var(--motion-hover) var(--ease-standard); }
.head-tab:hover .head-icon, .head-tab.on .head-icon { opacity: 1; }
.head-tab.on { font-weight: 650; }
.close { transition: color var(--motion-hover) var(--ease-standard), background-color var(--motion-hover) var(--ease-standard); }
.width-splitter { transition: background-color var(--motion-hover) var(--ease-standard); }
.width-splitter:hover, .width-splitter:active, .width-splitter:focus-visible { background: color-mix(in srgb, var(--accent) 62%, transparent); }
.drawer-body { scrollbar-width: thin; scrollbar-color: color-mix(in srgb, var(--fg-muted) 38%, transparent) transparent; }
@media (prefers-reduced-motion: reduce) {
  .head-tab, .head-tab .head-icon, .close, .width-splitter { transition: none; }
}
@media (forced-colors: active) {
  .width-splitter:hover, .width-splitter:active, .width-splitter:focus-visible { background: Highlight; }
}

</style>
