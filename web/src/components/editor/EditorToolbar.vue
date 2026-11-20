<template>
  <div class="editor-toolbar">
    <!-- 归档（只读）项目：隐藏全部修改类入口 -->
    <div v-if="!archived" class="format-tools" aria-label="文档格式工具">
    <!-- 历史 -->
    <button class="tb" title="撤销" :disabled="ro" @click="run(undo)"><el-icon><RefreshLeft /></el-icon></button>
    <button class="tb" title="重做" :disabled="ro" @click="run(redo)"><el-icon><RefreshRight /></el-icon></button>
    <span class="sep"></span>

    <button class="tb bold" title="加粗" :disabled="ro" @click="wrap('\\textbf{', '}')">B</button>
    <button class="tb italic" title="倾斜" :disabled="ro" @click="wrap('\\emph{', '}')">I</button>
    <button class="tb" title="章节 \section" :disabled="ro" @click="wrap('\\section{', '}', '标题')">H1</button>
    <button class="tb" title="行内公式 $...$" :disabled="ro" @click="wrap('$', '$', 'x^2')">ƒ(x)</button>
    <span class="sep" aria-hidden="true"></span>
    <el-popover v-model:visible="insertMenuOpen" placement="bottom-start" trigger="click" :width="260" :disabled="ro">
      <template #reference>
        <button class="tb insert-trigger" :disabled="ro" title="更多格式与插入" aria-label="更多格式与插入">插入 <el-icon class="insert-caret" aria-hidden="true"><ArrowDown /></el-icon></button>
      </template>
      <div class="insert-tools" aria-label="更多格式与插入" @click="insertMenuOpen = false">
    <button class="tb underline" title="下划线" :disabled="ro" @click="wrap('\\underline{', '}')">U<span>下划线</span></button>

    <button class="tb" title="小节 \subsection" :disabled="ro" @click="wrap('\\subsection{', '}', '标题')">H2<span>小节</span></button>

    <button class="tb" title="独立公式 \[ ... \]" :disabled="ro" @click="insert('\\[\n  \n\\]')">ƒ[x]<span>独立公式</span></button>

    <button class="tb" title="插入图片" :disabled="ro" @click="figureOpen = true">
      <svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/></svg><span>图片</span>
    </button>
    <button class="tb" title="插入表格（booktabs）" :disabled="ro" @click="tableOpen = true">
      <svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18"/></svg><span>表格</span>
    </button>
    <button class="tb" title="无序列表" :disabled="ro" @click="insert(itemizeTpl)">
      <svg viewBox="0 0 24 24"><path d="M8.5 6H21M8.5 12H21M8.5 18H21"/><circle cx="4" cy="6" r="1" class="dot"/><circle cx="4" cy="12" r="1" class="dot"/><circle cx="4" cy="18" r="1" class="dot"/></svg><span>列表</span>
    </button>
    <button class="tb" title="链接 \href" :disabled="ro" @click="wrap('\\href{https://}{', '}', '链接文字')">
      <svg viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg><span>链接</span>
    </button>
    <button class="tb" title="引用 \cite" :disabled="ro" @click="wrap('\\cite{', '}', 'key')">
      <svg viewBox="0 0 24 24" class="fill"><path d="M16 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/><path d="M5 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/></svg><span>引用</span>
    </button>
      </div>
    </el-popover>
    </div>

    <div class="toolbar-views">

    <!-- 审阅模式开关（归档项目不提供） -->
    <button
      v-if="!archived"
      class="tb review-toggle"
      :class="{ on: store.reviewMode }"
      title="审阅模式：开启后编辑器只读，选中内容可右键添加批注"
      :aria-pressed="store.reviewMode"
      @click="store.setReviewMode(!store.reviewMode)"
    >审阅</button>

    <!-- 视图切换：Visual 只支持 LaTeX/Markdown；纯代码与 pdf/图片等预览类文件不显示；
         变更集审阅态（编辑区显示 diff）时也不可切换 -->
    <div v-if="visualCapable && !store.diffReview && !archived" class="seg">
      <button
        class="seg-btn"
        :class="{ on: store.viewMode === 'code' }"
        title="代码视图" :aria-pressed="store.viewMode === 'code'"
        @click="store.viewMode = 'code'"
      >源码</button>
      <button
        class="seg-btn"
        :class="{ on: store.viewMode === 'visual' }"
        title="Visual 预览" :aria-pressed="store.viewMode === 'visual'"
        @click="store.viewMode = 'visual'"
      >可视</button>
    </div>

    </div>

    <!-- 插入图片弹窗 -->
    <Teleport to="body">
      <div v-if="figureOpen" class="modal-mask" @click.self="figureOpen = false">
        <div class="modal">
          <h3>插入图片</h3>
          <div class="form-row">
            <label>文件路径</label>
            <input v-model="figPath" list="image-files" placeholder="figs/example.png" />
            <datalist id="image-files">
              <option v-for="p in imageFiles" :key="p" :value="p" />
            </datalist>
          </div>
          <div class="form-row">
            <label>宽度（占版心比例，0-1）</label>
            <input v-model.number="figWidth" type="number" min="0.1" max="1" step="0.05" />
          </div>
          <div class="flex gap8" style="justify-content: flex-end">
            <button @click="figureOpen = false">取消</button>
            <button class="primary" :disabled="!figPath.trim()" @click="insertFigure">插入</button>
          </div>
        </div>
      </div>

      <!-- 插入表格弹窗 -->
      <div v-if="tableOpen" class="modal-mask" @click.self="tableOpen = false">
        <div class="modal">
          <h3>插入表格（booktabs）</h3>
          <div class="form-row">
            <label>行数（含表头）</label>
            <input v-model.number="tblRows" type="number" min="1" max="50" />
          </div>
          <div class="form-row">
            <label>列数</label>
            <input v-model.number="tblCols" type="number" min="1" max="50" />
          </div>
          <div class="flex gap8" style="justify-content: flex-end">
            <button @click="tableOpen = false">取消</button>
            <button class="primary" @click="insertTable">插入</button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue';
import { undo, redo } from '@codemirror/commands';
import { RefreshLeft, RefreshRight, ArrowDown } from '@element-plus/icons-vue';
import { useEditorStore } from '../../stores/editor.js';
import { useEditorRuntime } from '../../lib/editorRuntime.js';
import { makeFigureTemplate, makeTableTemplate } from '../../lib/editorUtils.js';

const store = useEditorStore();
const editorRuntime = useEditorRuntime();
const ro = computed(() => store.editingLocked);
const archived = computed(() => !!store.project?.archived);

// 归档项目强制回代码视图（Visual 视图属于编辑入口）
watch(archived, (a) => { if (a && store.viewMode === 'visual') store.viewMode = 'code'; }, { immediate: true });

// Visual 渲染管线只覆盖 LaTeX/Markdown：纯代码（.py/.sh/…）与非文本预览（pdf/图片，
// 由 FilePreview 常驻展示）都不提供切换；切到这类文件时强制回 Code 视图
const visualCapable = computed(() => /\.(tex|md|markdown)$/i.test(store.activeFile || ''));
watch(() => store.activeFile, (f) => {
  if (store.viewMode === 'visual' && !/\.(tex|md|markdown)$/i.test(f || '')) store.viewMode = 'code';
});

const insertMenuOpen = ref(false);
const figureOpen = ref(false);
const tableOpen = ref(false);
const figPath = ref('');
const figWidth = ref(0.8);
const tblRows = ref(3);
const tblCols = ref(3);

const itemizeTpl = '\\begin{itemize}\n  \\item \n\\end{itemize}\n';

const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.pdf', '.eps', '.webp'];

const imageFiles = computed(() => {
  const out = new Set();
  const addImage = (path) => {
    if (typeof path !== 'string') return;
    const i = path.lastIndexOf('.');
    if (i >= 0 && IMAGE_EXTS.includes(path.slice(i).toLowerCase())) out.add(path);
  };
  const stack = [...(store.tree || [])];
  while (stack.length) {
    const n = stack.pop();
    if (n.children) stack.push(...n.children);
    else addImage(n.path);
  }
  // The workspace is not recursively scanned. Already opened workspace images
  // remain convenient suggestions without loading any extra directory or file.
  for (const path of store.openFiles || []) if (path.startsWith('_workspace/')) addImage(path);
  return [...out].sort();
});

function run(cmd) {
  const v = editorRuntime.view;
  if (!v) return;
  cmd(v);
  v.focus();
}

function wrap(before, after, placeholder) {
  editorRuntime.wrapSelection(before, after, placeholder);
}

function insert(text) {
  editorRuntime.insertText(text);
}

function insertFigure() {
  editorRuntime.insertText(makeFigureTemplate(figPath.value, figWidth.value));
  figureOpen.value = false;
  figPath.value = '';
}

function insertTable() {
  editorRuntime.insertText(makeTableTemplate(tblRows.value, tblCols.value));
  tableOpen.value = false;
}
</script>

<style scoped>
.editor-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  min-height: 42px;
  padding: 5px 12px;
  background: var(--bg2);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
  overflow: hidden;
}
.format-tools { display: flex; align-items: center; gap: 2px; flex: 1; min-width: 0; overflow-x: auto; scrollbar-width: thin; }
.insert-trigger { gap: 7px; }
.insert-tools { display: grid; grid-template-columns: 1fr 1fr; gap: 5px; }
.insert-tools .tb { justify-content: flex-start; gap: 10px; min-height: 34px; padding: 7px 9px; }
.insert-tools .tb span { font-style: normal; text-decoration: none; font-weight: 400; }
.toolbar-views { display: flex; align-items: center; gap: 6px; flex: none; margin-left: auto; }
.tb {
  background: transparent;
  border: 1px solid transparent;
  border-radius: 5px;
  padding: 5px 7px;
  min-height: 28px;
  font-size: 12px;
  min-width: 30px;
  color: var(--fg-dim);
  white-space: nowrap;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
}
.tb svg {
  width: 15px;
  height: 15px;
  min-width: 15px;
  min-height: 15px;
  flex: 0 0 auto;
  display: block;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.tb svg .dot { fill: currentColor; stroke: none; }
.tb svg.fill { fill: currentColor; stroke: none; }
.tb:hover:not(:disabled) { background: var(--bg-hover); }
.tb.on {
  background: var(--accent-soft);
  color: var(--accent);
}
.tb.on:hover:not(:disabled) { background: var(--accent-soft); }
.tb.bold { font-weight: 700; }
.tb.italic { font-style: italic; }
.tb.underline { text-decoration: underline; }
.sep {
  width: 1px;
  height: 14px;
  background: var(--border);
  margin: 0 3px;
  flex-shrink: 0;
}
.grow { flex: 1; }
.seg {
  display: flex;
  background: var(--bg3);
  border: none;
  border-radius: 6px;
  padding: 2px;
  gap: 2px;
  overflow: hidden;
}
.seg-btn {
  background: transparent;
  border: none;
  border-radius: 4px;
  padding: 4px 9px;
  font-size: 12px;
  color: var(--fg-dim);
  white-space: nowrap;
}
.seg-btn:hover { background: var(--bg-hover); }
.seg-btn.on {
  background: var(--bg2);
  color: var(--accent);
  box-shadow: 0 1px 3px #0000000a;
}

/* Compact editorial controls with clear selected and keyboard-focus states. */
.editor-toolbar { background: var(--glass-inset); box-shadow: var(--glass-highlight); }
.tb { border-radius: 6px; transition: background-color .16s, color .16s; }
.tb:hover:not(:disabled) { color: var(--fg); }
.tb.on { box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 12%, transparent); }
.seg { background: var(--surface-muted); border: 1px solid var(--border); padding: 2px; }
.seg-btn.on { background: var(--surface-raised); box-shadow: var(--shadow-sm); }

/* Visual refinement: vector history icons, pill view switch, tactile tools. */
.tb .el-icon { font-size: 15px; }
.insert-caret { font-size: 11px !important; opacity: .65; }
.tb { border-radius: 7px; }
.tb:hover:not(:disabled) { color: var(--accent-hover); }
.tb.on { color: var(--accent-hover); }
.seg { border-radius: 999px; padding: 2px; }
.seg-btn { border-radius: 999px; padding: 4px 12px; font-weight: 550; }
.seg-btn.on { font-weight: 650; }
.review-toggle { border-radius: 999px; padding-inline: 12px; }
.review-toggle.on { box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 20%, transparent); }
.sep { height: 16px; opacity: .8; }
.insert-tools .tb { border-radius: 8px; }
.insert-tools .tb:hover:not(:disabled) { background: var(--accent-soft); color: var(--accent-hover); }
</style>
