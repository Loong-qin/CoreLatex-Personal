<template>
  <div class="status-bar">
    <span class="sb-item"><el-icon class="sb-icon" aria-hidden="true"><Position /></el-icon>行 {{ store.cursorLine + 1 }}，列 {{ store.cursorCol + 1 }}</span>
    <span v-if="currentSection" class="sb-item section" :title="currentSection">
      § {{ currentSection }}
    </span>

    <span class="grow"></span>

    <input
      v-model="gotoText"
      class="goto"
      placeholder="跳至行"
      aria-label="跳转到行号"
      inputmode="numeric"
      title="输入行号后回车跳转"
      @keydown.enter="gotoLine"
    />
    <span class="sb-item word-count"><el-icon class="sb-icon" aria-hidden="true"><EditPen /></el-icon>{{ words }} 词</span>
    <button class="sb-btn" title="定位到 PDF 对应位置" @click="emit('synctex-forward')">
      <el-icon class="sb-icon" aria-hidden="true"><Aim /></el-icon>定位 PDF
    </button>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import { Position, EditPen, Aim } from '@element-plus/icons-vue';
import { useEditorStore } from '../../stores/editor.js';
import { useEditorRuntime } from '../../lib/editorRuntime.js';
import { activeOutlineIndex } from '../../lib/outline.js';

const emit = defineEmits(['synctex-forward']);
const store = useEditorStore();
const editorRuntime = useEditorRuntime();

const gotoText = ref('');
const words = ref(0);

const currentSection = computed(() => {
  const i = activeOutlineIndex(store.outline, store.cursorLine);
  return i >= 0 ? store.outline[i].title : '';
});

function gotoLine() {
  const n = parseInt(gotoText.value, 10);
  if (Number.isFinite(n) && n >= 1) editorRuntime.jumpToLine(n - 1);
  gotoText.value = '';
}

function countWords() {
  const t = editorRuntime.getDocText();
  words.value = t ? t.split(/\s+/).filter(Boolean).length : 0;
}

// 文档内容不经 store，1s 轮询去抖刷新字数
let timer = null;
onMounted(() => {
  countWords();
  timer = setInterval(countWords, 1000);
});
onBeforeUnmount(() => clearInterval(timer));
watch(() => editorRuntime.view, () => setTimeout(countWords, 0));
</script>

<style scoped>
.status-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 10px;
  height: 30px;
  min-width: 0;
  container-type: inline-size;
  background: var(--bg2);
  border-top: 1px solid var(--border);
  font-size: 11px;
  color: var(--fg-dim);
  flex-shrink: 0;
  white-space: nowrap;
}
.sb-item { flex-shrink: 0; }
.section {
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 32%;
  min-width: 0;
  flex-shrink: 1;
}
.grow { flex: 1; min-width: 0; }
.goto {
  width: 58px;
  min-width: 0;
  flex-shrink: 0;
  padding: 2px 5px;
  font-size: 11px;
  border-radius: 4px;
  border-color: transparent;
  background: transparent;
}
.sb-btn {
  padding: 2px 7px;
  background: transparent;
  border-color: transparent;
  color: var(--fg-dim);
  flex-shrink: 0;
  font-size: 11px;
  border-radius: 4px;
}
@container (max-width: 420px) {
  .section { display: none; }
}
@container (max-width: 300px) {
  .word-count { display: none; }
}

/* Visual refinement: quiet iconography and tactile controls. */
.status-bar { background: var(--glass-inset); box-shadow: inset 0 1px 0 color-mix(in srgb, var(--surface-raised) 60%, transparent); font-variant-numeric: tabular-nums; }
.sb-item { display: inline-flex; align-items: center; gap: 5px; }
.sb-icon { font-size: 12px; opacity: .7; }
.sb-btn { display: inline-flex; align-items: center; gap: 5px; border-radius: 999px; padding: 2px 9px; transition: background-color var(--motion-hover) var(--ease-standard), color var(--motion-hover) var(--ease-standard); }
.sb-btn:hover { background: var(--accent-soft); color: var(--accent-hover); }
.goto { border-radius: 6px; transition: background-color var(--motion-hover) var(--ease-standard), border-color var(--motion-hover) var(--ease-standard); }
.goto:hover { background: var(--surface-raised); border-color: var(--border); }
.goto:focus-visible { background: var(--surface-raised); border-color: var(--accent); }
</style>
