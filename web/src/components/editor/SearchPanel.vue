<template>
  <section class="search-panel panel-section">
    <div class="panel-head"><el-icon class="head-glyph" aria-hidden="true"><Search /></el-icon><h4>搜索</h4><span class="muted">{{ resultCount }} 个结果</span></div>
    <div class="search-controls">
      <el-input v-model="query" size="small" placeholder="搜索文件内容" autofocus @keydown.enter="run" />
      <el-select v-model="scope" size="small" class="scope-select" title="搜索范围">
        <el-option value="current" label="当前文件" />
        <el-option value="project" label="全项目" />
      </el-select>
      <el-checkbox v-model="fuzzy" size="small" label="模糊" />
      <el-checkbox v-model="caseSensitive" size="small" label="区分大小写" />
    </div>
    <div ref="retainedScrollEl" class="search-body">
      <div v-if="busy" class="empty">正在搜索…</div>
      <div v-else-if="query && !results.length" class="empty"><el-icon class="empty-glyph" aria-hidden="true"><Search /></el-icon>没有找到匹配项</div>
      <div v-for="group in grouped" :key="group.path" class="result-group">
        <div class="group-title">
          <span class="chev" @click.stop="toggleGroup(group.path)">{{ collapsedGroups.has(group.path) ? '▸' : '▾' }}</span>
          <button class="group-name" @click="store.openFile(group.path)"><span>▤ {{ group.path }}</span></button>
          <span class="muted">{{ group.items.length }}</span>
        </div>
        <button v-if="!collapsedGroups.has(group.path)" v-for="(r, i) in group.items" :key="group.path + ':' + r.line + ':' + i" class="result-row" @click="openResult(group.path, r)">
          <span class="line-no">{{ r.line + 1 }}</span><span class="preview">{{ r.preview }}</span>
        </button>
      </div>
    </div>
  </section>
</template>

<script setup>
import { useRetainedScroll } from '../../lib/retainedScroll.js';
import { computed, ref, watch, onBeforeUnmount } from 'vue';
import { api } from '../../api.js';
import { useEditorStore } from '../../stores/editor.js';
import { useUiStore } from '../../stores/ui.js';
import { useEditorRuntime } from '../../lib/editorRuntime.js';
import { createEditorNavigator } from '../../lib/editorNavigation.js';
import { searchInText } from '../../lib/search.js';
import { isTextFilePath } from '../../lib/fileKind.js';

const MAX_TOTAL = 1000; // 总命中上限，防止短查询产生过多结果拖垮渲染
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 超过 5MB 的文本文件不参与搜索

const props = defineProps({ active: { type: Boolean, default: true } });
const store = useEditorStore();
const retainedScrollEl = ref(null);
useRetainedScroll(retainedScrollEl, { scope: store, key: () => 'search-scroll', active: () => props.active });
const editorRuntime = useEditorRuntime();
const ui = useUiStore();
const navigator = createEditorNavigator(store, editorRuntime, { active: () => props.active, onError: message => ui.error(message) });
onBeforeUnmount(() => navigator.cancel());
const query = ref('');
const scope = ref('project');
const fuzzy = ref(false);
const caseSensitive = ref(false);
const busy = ref(false);
const resultMap = ref(new Map());
const collapsedGroups = ref(new Set());
function toggleGroup(path) {
  const s = new Set(collapsedGroups.value);
  if (s.has(path)) s.delete(path); else s.add(path);
  collapsedGroups.value = s;
}
let timer = null;
let searchTicket = 0;
const files = computed(() => flatten(store.tree || []).filter((n) =>
  n.type === 'file' && !n.path.startsWith('_workspace/') && isTextFilePath(n.path, n) && (n.size ?? 0) <= MAX_FILE_SIZE
));
const grouped = computed(() => [...resultMap.value.entries()].map(([path, items]) => ({ path, items })));
const results = computed(() => grouped.value.flatMap((g) => g.items));
const resultCount = computed(() => results.value.length);

function flatten(nodes, out = []) { for (const n of nodes) { out.push(n); if (n.children) flatten(n.children, out); } return out; }
function run() {
  clearTimeout(timer);
  if (!props.active) return;
  // Invalidate a running search immediately, before the debounce starts another.
  searchTicket++;
  timer = setTimeout(search, 80);
}
async function search() {
  if (!props.active) return;
  const q = query.value.trim();
  if (!q) {
    resultMap.value = new Map();
    store.searchMatches = null;
    return;
  }
  const ticket = ++searchTicket;
  busy.value = true;
  try {
    const targets = scope.value === 'current' && store.activeFile
      ? files.value.filter((f) => f.path === store.activeFile)
      : files.value;
    const map = new Map();
    let total = 0;
    for (const node of targets) {
      if (ticket !== searchTicket || total >= MAX_TOTAL) break;
      try {
        let text;
        if (node.path === store.activeFile && editorRuntime.view) text = editorRuntime.getDocText();
        else text = await (await api.raw('/api/projects/' + store.projectId + '/file?path=' + encodeURIComponent(node.path))).text();
        if (ticket !== searchTicket) break; // 等待期间查询已变化，丢弃本次结果
        const hits = searchInText(text, q, { fuzzy: fuzzy.value, caseSensitive: caseSensitive.value });
        if (hits.length) { map.set(node.path, hits); total += hits.length; }
      } catch { /* ignore unreadable binary files */ }
    }
    if (ticket === searchTicket) {
      resultMap.value = map;
      syncActiveMatches();
    }
  } finally { if (ticket === searchTicket) busy.value = false; }
}

// 当前文件的命中同步到 store：概览条标注 + 编辑器匹配高亮共用
function syncActiveMatches() {
  if (!props.active) { store.searchMatches = null; return; }
  const q = query.value.trim();
  const hits = resultMap.value.get(store.activeFile) || [];
  store.searchMatches = hits.length
    ? {
        file: store.activeFile,
        items: hits.map((h) => ({ line: h.line, col: h.col, len: fuzzy.value ? 0 : q.length })),
      }
    : null;
}
watch(() => store.activeFile, () => syncActiveMatches());
watch(() => props.active, (active) => {
  clearTimeout(timer);
  searchTicket++;
  busy.value = false;
  store.searchMatches = null;
  if (active) run();
});
onBeforeUnmount(() => { clearTimeout(timer); searchTicket++; store.searchMatches = null; });
function openResult(path, result) {
  navigator.open(path, { line: result.line, col: result.col });
}
watch([query, scope, fuzzy, caseSensitive, () => store.treeVersion, () => store.activeFile], run);
</script>

<style scoped>
.panel-section { display:flex; flex-direction:column; min-height:0; height:100%; }
.panel-head { display:flex; align-items:center; padding:8px 10px; border-bottom:1px solid var(--border); color:var(--fg-dim); font-size:11px; }
.panel-head h4 { margin:0; flex:1; font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
.search-controls { display:flex; flex-wrap:wrap; gap:6px; padding:8px; border-bottom:1px solid var(--border); }
.search-controls .el-input { width:100%; }
.scope-select { flex:1; min-width:100px; }
.search-controls .el-checkbox { margin-right:6px; height:24px; }
.search-body { overflow:auto; flex:1; }
.result-group { border-bottom:1px solid rgba(57,65,78,.55); }
.group-title { display:flex; align-items:center; gap:4px; padding:7px 9px 7px 5px; font-size:12px; font-weight:600; color:var(--fg); }
.group-title .chev { width:16px; flex:none; text-align:center; font-size:10px; color:var(--fg-dim); cursor:pointer; border-radius:3px; }
.group-title .chev:hover { color:var(--fg); background:var(--bg-hover); }
.group-name { flex:1; min-width:0; display:flex; border:0; background:transparent; color:inherit; font:inherit; text-align:left; padding:0; cursor:pointer; }
.group-name span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.group-title:hover { background:var(--bg-hover); }
.group-title .muted { flex:none; }
.result-row { width:100%; display:flex; align-items:center; border:0; border-radius:0; text-align:left; background:transparent; color:var(--fg); }
.group-title:hover,.result-row:hover { background:var(--bg-hover); }
.result-row { gap:8px; padding:5px 9px 5px 21px; color:var(--fg-dim); font-family:var(--mono); font-size:11px; }
.line-no { color:var(--accent); width:28px; text-align:right; flex:none; }
.preview { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.empty { padding:22px 10px; text-align:center; color:var(--fg-dim); font-size:12px; }

/* ---- visual refinement layer (presentation only; block is unscoped, so every rule stays under .search-panel) ---- */
.search-panel .panel-head { gap: 7px; border-bottom-color: color-mix(in srgb, var(--border) 72%, var(--bg2)); }
.search-panel .panel-head h4 { letter-spacing: .06em; font-weight: 650; color: var(--fg-dim); }
.search-panel .head-glyph { flex: none; font-size: 13px; color: var(--accent); opacity: .9; }
.search-panel .panel-head > .muted { font-variant-numeric: tabular-nums; }
.search-panel .search-controls { border-bottom-color: color-mix(in srgb, var(--border) 72%, var(--bg2)); }
.search-panel .search-body { scrollbar-width: thin; scrollbar-color: color-mix(in srgb, var(--fg-muted) 38%, transparent) transparent; }
.search-panel .result-group { border-bottom: 1px solid color-mix(in srgb, var(--border) 72%, var(--bg2)); }
.search-panel .group-title { transition: background-color var(--motion-hover) var(--ease-standard); }
.search-panel .group-name { border-radius: 4px; transition: color var(--motion-hover) var(--ease-standard); }
.search-panel .group-title:hover .group-name { color: var(--accent-hover); }
.search-panel .group-title .muted { display: inline-flex; align-items: center; justify-content: center; min-width: 17px; height: 17px; padding: 0 5px; border-radius: 999px; background: var(--glass-inset); font-size: 10px; font-variant-numeric: tabular-nums; }
.search-panel .result-row { transition: background-color var(--motion-hover) var(--ease-standard), color var(--motion-hover) var(--ease-standard); }
.search-panel .result-row:hover { color: var(--fg); box-shadow: inset 2px 0 0 color-mix(in srgb, var(--accent) 55%, transparent); }
.search-panel .line-no { font-variant-numeric: tabular-nums; }
.search-panel .empty { display: flex; flex-direction: column; align-items: center; gap: 8px; color: var(--fg-muted); letter-spacing: .01em; }
.search-panel .empty-glyph { font-size: 22px; color: color-mix(in srgb, var(--accent) 45%, var(--fg-muted)); opacity: .8; }
@media (prefers-reduced-motion: reduce) {
  .search-panel .group-title, .search-panel .group-name, .search-panel .result-row { transition: none; }
}
@media (forced-colors: active) {
  .search-panel .head-glyph, .search-panel .empty-glyph { color: CanvasText; }
  .search-panel .result-row:hover { box-shadow: none; }
}
</style>