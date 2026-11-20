<template>
  <section class="workspace-panel panel-section">
    <div class="panel-head">
      <el-icon class="head-glyph" aria-hidden="true"><FolderOpened /></el-icon>
      <h4>工作空间</h4>
      <div class="head-actions">
        <el-tooltip content="刷新工作空间" placement="top">
          <el-button text size="small" class="icon-btn" @click="refreshWorkspace"><el-icon><Refresh /></el-icon></el-button>
        </el-tooltip>
        <el-tooltip content="上传文件（可多选）" placement="top">
          <el-button text size="small" class="icon-btn" @click="pickFiles"><el-icon><Upload /></el-icon></el-button>
        </el-tooltip>
        <el-tooltip content="上传目录（保留子目录结构）" placement="top">
          <el-button text size="small" class="icon-btn" @click="pickFolder"><el-icon><FolderOpened /></el-icon></el-button>
        </el-tooltip>
        <el-tooltip content="新建目录" placement="top">
          <el-button text size="small" class="icon-btn" :disabled="store.readOnly" @click="newFolder"><el-icon><FolderAdd /></el-icon></el-button>
        </el-tooltip>
        <el-tooltip content="新建草稿" placement="top">
          <el-button text size="small" class="icon-btn" @click="newDraft"><el-icon><EditPen /></el-icon></el-button>
        </el-tooltip>
        <el-tooltip content="导出项目 ZIP" placement="top">
          <el-button text size="small" class="icon-btn" @click="exportZip"><el-icon><Download /></el-icon></el-button>
        </el-tooltip>
      </div>
    </div>
    <div v-if="selectedPaths.length > 1" class="selection-bar">
      <span class="sel-count">已选 {{ selectedPaths.length }} 项（拖到目录可批量移动）</span>
      <el-button size="small" text type="danger" :disabled="store.readOnly" @click="batchDelete">批量删除</el-button>
      <el-button size="small" text @click="clearSelection">取消选择</el-button>
    </div>
    <input ref="fileInput" class="hidden" type="file" multiple @change="upload" />
    <input ref="dirInput" class="hidden" type="file" multiple webkitdirectory @change="upload" />
    <div ref="retainedScrollEl" class="workspace-body" @click.capture="onClickCapture" @dragover.prevent="onDragOverBody" @drop.prevent="onDropRoot">
      <p class="hint">AI 草稿和中间文件存放在 <code>_workspace/</code>，不会参与项目编译。</p>
      <div v-if="rootState.loaded && !wsRoot.length && !rootState.loading && !rootState.error" class="empty"><el-icon class="empty-glyph" aria-hidden="true"><Document /></el-icon>工作空间为空</div>
      <template v-for="row in visibleRows" :key="row.kind + ':' + row.path">
      <div
        v-if="row.kind === 'node'"
        class="ws-row"
        :class="[row.node.type === 'dir' ? 'dir-row' : 'file-row', { 'is-selected': isSelected(row.node), 'drag-over': row.node.type === 'dir' && dragOverPath === row.node.path }]"
        :style="{ paddingLeft: 4 + row.depth * 14 + 'px' }"
        :draggable="!store.readOnly"
        @click="handleRowClick(row.node)"
        @dragstart="onDragStart($event, row.node)"
        @dragover="onRowDragOver($event, row.node)"
        @dragleave="onRowDragLeave(row.node)"
        @drop="onRowDrop($event, row.node)"
      >
        <span
          v-if="row.node.type === 'dir'"
          class="chevron"
          :class="{ open: !isCollapsed(row.node.path) }"
          title="展开/折叠"
          @click.stop="toggleCollapse(row.node.path)"
        >▸</span>
        <span v-else class="chevron placeholder"></span>
        <el-icon v-if="row.node.type === 'file'" class="file-icon"><Document /></el-icon>
        <span class="workspace-name" :title="row.node.path">{{ row.node.type === 'dir' ? row.node.name + '/' : row.node.name }}</span>
        <span v-if="row.node.type === 'file'" class="muted workspace-size">{{ formatBytes(row.node.size) }}</span>
        <span v-if="row.node.type === 'dir'" class="dir-drop-hint">拖到此处移入</span>
        <el-dropdown class="file-menu" trigger="click" @command="(cmd) => handleCommand(cmd, row.node)">
          <el-button class="more-btn" text aria-label="文件操作" @click.stop><el-icon><MoreFilled /></el-icon></el-button>
          <template #dropdown>
            <el-dropdown-menu>
              <template v-if="row.node.type === 'dir'">
                <el-dropdown-item command="upload-files" :disabled="store.readOnly">上传文件到此处</el-dropdown-item>
                <el-dropdown-item command="upload-dir" :disabled="store.readOnly">上传目录到此处</el-dropdown-item>
              </template>
              <el-dropdown-item v-if="row.node.type === 'file'" command="download">下载文件</el-dropdown-item>
              <el-dropdown-item command="rename" :disabled="store.readOnly">重命名</el-dropdown-item>
              <el-dropdown-item command="remove" :disabled="store.readOnly" divided>删除</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </div>
      <div v-else class="directory-status" :style="{ paddingLeft: 8 + row.depth * 14 + 'px' }" role="status">
        <span v-if="row.kind === 'loading'">正在加载…</span>
        <template v-else-if="row.kind === 'error'">{{ row.message }} <button type="button" @click="retryDirectory(row.path)">重试</button></template>
        <button v-else type="button" @click="loadDirectory(row.path, { append: true })">加载更多</button>
      </div>
      </template>
    </div>
  </section>
</template>

<script setup>
import { useRetainedScroll } from '../../lib/retainedScroll.js';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ElMessageBox } from 'element-plus';
import { Upload, EditPen, Download, Document, MoreFilled, FolderAdd, FolderOpened, Refresh } from '@element-plus/icons-vue';
import { downloadProjectExport, downloadProjectFile } from '../../lib/projectFileUrl.js';
import { api } from '../../api.js';
import { useEditorStore } from '../../stores/editor.js';
import { useUiStore } from '../../stores/ui.js';

const props = defineProps({ active: { type: Boolean, default: true } });
const store = useEditorStore();
const retainedScrollEl = ref(null);
useRetainedScroll(retainedScrollEl, { scope: store, key: () => 'workspace-scroll', active: () => props.active });
const ui = useUiStore();
const fileInput = ref(null);
const dirInput = ref(null);

// Cache only directory entries already requested. File contents are fetched by
// the editor on click; no workspace document is read for the listing.
const WORKSPACE_ROOT = '_workspace';
const directories = ref({});
const expandedSet = ref(new Set());
const rootState = computed(() => directories.value[WORKSPACE_ROOT] || {});
const wsRoot = computed(() => rootState.value.entries || []);
let workspaceGeneration = 0;
let loadTimer = null;
let workspaceDirty = false;
let seenInitialTree = false;
let disposed = false;
const requests = new Map();
let requestSerial = 0;
function formatBytes(n = 0) { return n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB'; }
function setDirectory(path, changes) {
  directories.value = { ...directories.value, [path]: { ...(directories.value[path] || {}), ...changes } };
}
function isCollapsed(path) { return !expandedSet.value.has(path); }
function cancelRequestsUnder(path = WORKSPACE_ROOT) {
  for (const [directory, request] of requests) {
    if (directory !== path && !directory.startsWith(path + '/')) continue;
    requests.delete(directory);
    request.controller.abort();
    setDirectory(directory, { loading: false, interrupted: true });
  }
}
function isVisibleDirectory(path) {
  if (path === WORKSPACE_ROOT) return true;
  if (!expandedSet.value.has(path)) return false;
  let parent = path.slice(0, path.lastIndexOf('/'));
  while (parent && parent !== WORKSPACE_ROOT) {
    if (!expandedSet.value.has(parent)) return false;
    parent = parent.slice(0, parent.lastIndexOf('/'));
  }
  return parent === WORKSPACE_ROOT;
}
function resumeDirectory(path) {
  const state = directories.value[path] || {};
  if (state.interrupted) loadDirectory(path, { append: !!state.retryAppend, force: !state.retryAppend });
  else loadDirectory(path);
}
function toggleCollapse(path) {
  const next = new Set(expandedSet.value);
  if (next.has(path)) {
    next.delete(path); expandedSet.value = next;
    cancelRequestsUnder(path);
  } else {
    next.add(path); expandedSet.value = next;
    resumeDirectory(path);
    for (const nested of next) if (nested.startsWith(path + '/') && isVisibleDirectory(nested)) resumeDirectory(nested);
  }
}
function resetWorkspace() {
  workspaceGeneration++;
  clearTimeout(loadTimer); loadTimer = null;
  for (const request of requests.values()) request.controller.abort();
  requests.clear();
  directories.value = {};
  expandedSet.value = new Set();
  workspaceDirty = false;
  seenInitialTree = !!store.treeLoaded;
  clearSelection();
}
function scheduleWorkspaceLoad() {
  clearTimeout(loadTimer);
  if (!props.active || !store.projectId || disposed) return;
  // Give the main document a chance to start before listing workspace metadata.
  loadTimer = setTimeout(() => {
    loadTimer = null;
    if (!props.active || !store.projectId || disposed) return;
    if (workspaceDirty) refreshWorkspace();
    else {
      resumeDirectory(WORKSPACE_ROOT);
      for (const path of expandedSet.value) if (isVisibleDirectory(path)) resumeDirectory(path);
    }
  }, 150);
}
async function loadDirectory(path, { append = false, force = false } = {}) {
  if (!props.active || !store.projectId || disposed) return;
  const previous = directories.value[path] || {};
  if (previous.loading && !force) return;
  if (append && !previous.nextCursor) return;
  if (!append && previous.loaded && !force) return;
  if (force) requests.get(path)?.controller.abort();
  const projectId = store.projectId, projectVersion = store.projectVersion, generation = workspaceGeneration;
  const cursor = append ? previous.nextCursor : null;
  const controller = new AbortController();
  const request = { id: ++requestSerial, controller };
  requests.set(path, request);
  const current = () => !disposed && generation === workspaceGeneration && projectId === store.projectId &&
    projectVersion === store.projectVersion && requests.get(path) === request;
  setDirectory(path, { loading: true, error: '', retryAppend: append, interrupted: false });
  try {
    const suffix = cursor ? '&cursor=' + encodeURIComponent(cursor) : '';
    const response = await api.get('/api/projects/' + encodeURIComponent(projectId) + '/workspace/children?path=' + encodeURIComponent(path) + '&limit=100' + suffix,
      { signal: controller.signal });
    if (!current()) return;
    if (response?.path !== path || !Array.isArray(response.entries) ||
        response.entries.some(node => !node || !['file', 'dir'].includes(node.type) || typeof node.path !== 'string' || !node.path.startsWith(path + '/')) ||
        !(response.nextCursor === null || typeof response.nextCursor === 'string')) throw new Error('工作空间目录格式无效');
    const old = append ? (directories.value[path]?.entries || []) : [];
    const merged = [...old];
    const indices = new Map(merged.map((entry, index) => [entry.path, index]));
    for (const entry of response.entries) {
      if (indices.has(entry.path)) merged[indices.get(entry.path)] = entry;
      else { indices.set(entry.path, merged.length); merged.push(entry); }
    }
    setDirectory(path, { entries: merged, nextCursor: response.nextCursor, loaded: true, error: '', retryAppend: false });
  } catch (error) {
    if (current() && !controller.signal.aborted) setDirectory(path, { error: error?.message || '工作空间目录加载失败', retryAppend: append });
  } finally {
    if (current()) { setDirectory(path, { loading: false }); requests.delete(path); }
  }
}
function retryDirectory(path) {
  const state = directories.value[path] || {};
  loadDirectory(path, { append: !!state.retryAppend, force: !state.retryAppend });
}
async function refreshWorkspace() {
  if (!store.projectId || !props.active || disposed) { workspaceDirty = true; return; }
  workspaceDirty = false;
  const paths = [WORKSPACE_ROOT, ...expandedSet.value].filter((path, index, all) => all.indexOf(path) === index && isVisibleDirectory(path));
  await Promise.all(paths.map(path => loadDirectory(path, { force: true })));
}
const visibleRows = computed(() => {
  const rows = [];
  const walk = (path, depth) => {
    const state = directories.value[path] || {};
    for (const node of state.entries || []) {
      rows.push({ kind: 'node', node, path: node.path, depth });
      if (node.type === 'dir' && expandedSet.value.has(node.path)) walk(node.path, depth + 1);
    }
    if (state.loading || (path === WORKSPACE_ROOT && !state.loaded && !state.error && props.active)) rows.push({ kind: 'loading', path, depth });
    else if (state.error) rows.push({ kind: 'error', path, depth, message: state.error });
    else if (state.nextCursor) rows.push({ kind: 'more', path, depth });
  };
  walk(WORKSPACE_ROOT, 0);
  return rows;
});

// —— 多选:单击单选(打开文件)、Shift 连选、Ctrl/⌘ 跳选 ——
// 修饰键在列表容器捕获阶段从点击事件上读取(capture 先于行内 handler,时序有保证)
const selectedPaths = ref([]);
const anchorPath = ref(null);
const clickMods = ref({ shift: false, ctrl: false });
function onClickCapture(e) { clickMods.value = { shift: !!e.shiftKey, ctrl: !!(e.ctrlKey || e.metaKey) }; }
function isSelected(node) { return !!(node.path && selectedPaths.value.includes(node.path)); }
function setSingle(path) { selectedPaths.value = [path]; anchorPath.value = path; }
function toggleSelect(path) {
  const i = selectedPaths.value.indexOf(path);
  if (i >= 0) selectedPaths.value.splice(i, 1); else selectedPaths.value.push(path);
  anchorPath.value = path;
}
function selectRange(path) {
  const order = visibleRows.value.filter((row) => row.kind === 'node').map((row) => row.node.path);
  const a = order.indexOf(anchorPath.value ?? path);
  const b = order.indexOf(path);
  if (a < 0 || b < 0) { setSingle(path); return; }
  selectedPaths.value = order.slice(Math.min(a, b), Math.max(a, b) + 1);
}
function clearSelection() { selectedPaths.value = []; }
function pruneSelection() {
  const alive = new Set(Object.values(directories.value).flatMap((state) => (state.entries || []).map((node) => node.path)));
  selectedPaths.value = selectedPaths.value.filter((p) => alive.has(p));
}
function handleRowClick(node) {
  if (node.type === 'dir' && !clickMods.value.shift && !clickMods.value.ctrl) {
    toggleCollapse(node.path); // 普通点击目录名 = 折叠/展开,同时选中
    setSingle(node.path);
    return;
  }
  if (clickMods.value.shift) { selectRange(node.path); return; }
  if (clickMods.value.ctrl) { toggleSelect(node.path); return; }
  setSingle(node.path);
  if (node.type === 'file') store.openFile(node.path);
}
async function batchDelete() {
  if (store.readOnly || !selectedPaths.value.length || !store.projectId) return;
  if (!window.confirm('确定删除选中的 ' + selectedPaths.value.length + ' 项吗？目录将连同内容一起删除。')) return;
  let ok = 0; const failed = [];
  // 先关掉将被删除文件占用的标签,再逐个删除(防协同重连写回)
  for (const p of selectedPaths.value) {
    if (store.activeFile && (store.activeFile === p || store.activeFile.startsWith(p + '/'))) store.closeFile(store.activeFile);
  }
  for (const p of selectedPaths.value) {
    try {
      await api.del('/api/projects/' + store.projectId + '/files?path=' + encodeURIComponent(p));
      ok++;
    } catch { failed.push(p); }
  }
  await refreshWorkspace();
  ui.toast(failed.length ? '已删除 ' + ok + ' 项，' + failed.length + ' 项失败' : '已删除 ' + ok + ' 项');
  pruneSelection();
}
function onDeleteKey(e) {
  // 仅多选(>1)时 Delete 批量删除;单选的删除走行内菜单
  if (!props.active || e.key !== 'Delete' || selectedPaths.value.length < 2 || store.readOnly) return;
  const el = document.activeElement;
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
  batchDelete();
}
onMounted(() => {
  seenInitialTree = !!store.treeLoaded;
  window.addEventListener('keydown', onDeleteKey);
  scheduleWorkspaceLoad();
});
onBeforeUnmount(() => {
  disposed = true;
  resetWorkspace();
  window.removeEventListener('keydown', onDeleteKey);
});
watch(() => [store.projectId, store.projectVersion], () => { resetWorkspace(); scheduleWorkspaceLoad(); });
watch(() => props.active, (active) => {
  if (active) scheduleWorkspaceLoad();
  else { clearTimeout(loadTimer); loadTimer = null; cancelRequestsUnder(); }
});
watch(() => store.workspaceVersion, () => {
  workspaceDirty = true;
  if (props.active) scheduleWorkspaceLoad();
});
watch(() => store.treeVersion, () => {
  // The first formal-tree result is part of opening the project, not a change
  // to the workspace. Later refreshes can reflect an agent/file mutation.
  if (!seenInitialTree) { seenInitialTree = true; return; }
  workspaceDirty = true;
  if (props.active) scheduleWorkspaceLoad();
});

// —— 拖拽移动:拖选中行到目录行移入该目录,拖到列表空白处移回 _workspace 根 ——
let dragPaths = [];
const dragOverPath = ref(null); // 仅拖拽悬停在目录行时显示移入提示
function onDragStart(e, node) {
  dragPaths = (selectedPaths.value.length > 1 && selectedPaths.value.includes(node.path))
    ? selectedPaths.value.slice()
    : [node.path];
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', JSON.stringify(dragPaths));
}
function onRowDragOver(e, node) {
  if (!dragPaths.length || node.type !== 'dir') return; // 仅目录行是放置目标
  e.preventDefault();
  e.stopPropagation();
  e.dataTransfer.dropEffect = 'move';
  dragOverPath.value = node.path;
}
function onRowDragLeave(node) {
  if (dragOverPath.value === node.path) dragOverPath.value = null;
}
function onRowDrop(e, node) {
  if (node.type !== 'dir') return;
  e.preventDefault();
  e.stopPropagation();
  dragOverPath.value = null;
  moveToDir(node.path);
}
function onDragOverBody(e) { if (dragPaths.length) e.dataTransfer.dropEffect = 'move'; }
function onDropRoot(e) {
  // 落点在某一行上时不按「移回根」处理
  if (e.target && e.target.closest && e.target.closest('.ws-row')) return;
  dragOverPath.value = null;
  moveToDir('');
}
async function moveToDir(dirPath) {
  if (store.readOnly || !dragPaths.length || !store.projectId) return;
  let ok = 0; const failed = []; let skipped = 0;
  for (const p of dragPaths) {
    const name = p.split('/').pop();
    const newPath = (dirPath ? dirPath + '/' : '_workspace/') + name;
    if (newPath === p || dirPath === p || dirPath.startsWith(p + '/')) { skipped++; continue; }
    try {
      if (!await store.renamePath(p, newPath)) return;
      ok++;
    } catch { failed.push(name); }
  }
  dragPaths = [];
  await refreshWorkspace();
  pruneSelection();
  const dest = (dirPath || '_workspace').replace(/^_workspace\/?/, '') || '根';
  if (failed.length) ui.error('已移动 ' + ok + ' 项，' + failed.length + ' 项失败（重名或其他原因）');
  else if (ok) ui.toast('已移动 ' + ok + ' 项到 ' + dest + (skipped ? '，跳过 ' + skipped + ' 项' : ''));
}

let uploadTarget = ''; // 定向上传目标目录('' = _workspace 根)
function pickFiles() { uploadTarget = ''; fileInput.value?.click(); }
function pickFolder() { uploadTarget = ''; dirInput.value?.click(); }
function startUploadTo(dirPath, asFolder = false) {
  uploadTarget = dirPath || '';
  (asFolder ? dirInput : fileInput).value?.click();
}
async function upload(e) {
  const selected = [...(e.target.files || [])]; e.target.value = '';
  if (!selected.length || store.readOnly) return;
  const prefix = (uploadTarget ? uploadTarget + '/' : '_workspace/');
  const form = new FormData();
  form.append('paths', JSON.stringify(selected.map((f) => prefix + (f.webkitRelativePath || f.name))));
  selected.forEach((f) => form.append('files', f, f.name));
  uploadTarget = '';
  try { await api.postForm('/api/projects/' + store.projectId + '/upload', form); await refreshWorkspace(); pruneSelection(); ui.toast('已上传到工作空间'); }
  catch (err) { ui.error(err.message || '上传失败'); }
}
async function newFolder() {
  if (store.readOnly) return;
  let name;
  try {
    const { value } = await ElMessageBox.prompt('目录名（可含子路径，例如 drafts/refs）', '新建目录', {
      inputValue: '',
      confirmButtonText: '创建',
      cancelButtonText: '取消',
    });
    name = value;
  } catch {
    return;
  }
  if (!name?.trim()) return;
  // 统一挂到 _workspace/ 下,防止写到项目根目录
  const rel = name.trim().replace(/^_workspace\//, '').replace(/^\/*/, '').replace(/\/+$/, '');
  if (!rel) return;
  try {
    await api.post('/api/projects/' + store.projectId + '/mkdir', { path: '_workspace/' + rel });
    await refreshWorkspace(); ui.toast('已创建目录 _workspace/' + rel);
  } catch (err) { ui.error(err.message || '创建失败'); }
}
async function newDraft() {
  if (store.readOnly) return;
  let path;
  try {
    const { value } = await ElMessageBox.prompt('草稿文件名（例如 notes.md）', '新建草稿', {
      inputValue: 'draft.md',
      confirmButtonText: '创建',
      cancelButtonText: '取消',
    });
    path = value;
  } catch {
    return;
  }
  if (!path?.trim()) return;
  const rel = path.trim().replace(/^\/*/, '');
  try {
    await api.post('/api/projects/' + store.projectId + '/files', { path: '_workspace/' + rel, content: '', overwrite: false });
    await refreshWorkspace(); store.openFile('_workspace/' + rel);
  } catch (err) { ui.error(err.message || '创建失败'); }
}
function exportZip() {
  if (store.projectId) downloadProjectExport(store.projectId);
}

function handleCommand(cmd, node) {
  if (cmd === 'download' && node.type === 'file') downloadFile(node.path);
  if (cmd === 'rename') renameFile(node);
  if (cmd === 'remove') removeFile(node);
  if (cmd === 'upload-files') startUploadTo(node.type === 'dir' ? node.path : '');
  if (cmd === 'upload-dir') startUploadTo(node.type === 'dir' ? node.path : '', true);
}
function downloadFile(path) {
  if (!store.projectId) return;
  downloadProjectFile(store.projectId, path);
}

async function renameFile(f) {
  if (store.readOnly) return;
  const oldName = f.path.split('/').pop();
  let name;
  try {
    const { value } = await ElMessageBox.prompt(f.type === 'dir' ? '新目录名' : '新文件名', '重命名', {
      inputValue: oldName,
      confirmButtonText: '确定',
      cancelButtonText: '取消',
    });
    name = value;
  } catch {
    return;
  }
  if (!name?.trim() || name.trim() === oldName) return;
  const base = f.path.slice(0, f.path.lastIndexOf('/') + 1);
  const newPath = base + name.trim();
  try {
    if (!await store.renamePath(f.path, newPath)) return;
    await refreshWorkspace();
    pruneSelection();
    ui.toast('已重命名');
  } catch (err) { ui.error(err.message || '重命名失败'); }
}
async function removeFile(f) {
  if (store.readOnly) return;
  try {
    await ElMessageBox.confirm('确定删除“' + f.path + '”吗？' + (f.type === 'dir' ? '目录内容将一并删除。' : ''), f.type === 'dir' ? '删除目录' : '删除文件', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    });
  } catch {
    return;
  }
  try {
    // 先关标签再删,防协同重连把已删文件写回
    store.closeFile(f.path);
    await api.del('/api/projects/' + store.projectId + '/files?path=' + encodeURIComponent(f.path));
    await refreshWorkspace();
    pruneSelection();
    ui.toast('已删除');
  } catch (err) { ui.error(err.message || '删除失败'); }
}
</script>

<style scoped>
.panel-section { display:flex; flex:1 1 0; flex-direction:column; min-height:0; height:100%; overflow:hidden; border-top:1px solid var(--border); }
.panel-head { display:flex; align-items:center; padding:8px 10px; flex:none; }
.panel-head h4 { margin:0; font-size:12px; text-transform:uppercase; letter-spacing:.04em; color:var(--fg-dim); flex:1; }
.head-actions { display:flex; gap:2px; }
.icon-btn { padding:3px 6px; margin-left:0; }
.hidden { display:none; }
.directory-status { padding:5px 4px; color:var(--fg-dim); font-size:11px; }
.directory-status button { border:0; background:transparent; color:var(--accent); padding:0 3px; cursor:pointer; font:inherit; }
.workspace-body { flex:1; min-height:0; overflow:auto; padding:0 8px 8px; }
.hint { margin:0 2px 8px; color:var(--fg-dim); font-size:11px; line-height:1.4; }
code { color:var(--accent); }
.ws-row { display:flex; align-items:center; gap:6px; width:100%; border-radius:4px; padding:4px; text-align:left; color:var(--fg); font-size:12px; cursor:pointer; user-select:none; }
.dir-row { color:var(--fg); font-weight:600; }
.ws-row.is-selected { background: rgba(38, 162, 105, .14); }
.chevron { width:12px; flex:none; text-align:center; color:var(--fg-dim); font-size:10px; transition: transform .12s ease; display:inline-block; }
.chevron.open { transform: rotate(90deg); }
.chevron.placeholder { visibility: hidden; }
.file-icon { flex:none; color:var(--fg-dim); font-size:13px; }
.workspace-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1; }
.workspace-size { font-size:10px; flex:none; }
.file-menu { flex:none; opacity:0; transition:opacity .12s ease; }
.ws-row:hover .file-menu { opacity:1; }
.more-btn { width:24px; height:22px; padding:0; color:var(--fg-dim); font-size:12px; }
.more-btn:hover { color:var(--fg); background:var(--bg3); }
.dir-drop-hint { margin-left:auto; opacity:0; color:var(--accent); font-size:10px; flex:none; transition: opacity .12s ease; pointer-events: none; }
.ws-row.dir-row.drag-over { background: rgba(38, 162, 105, .08); }
.ws-row.dir-row.drag-over .dir-drop-hint { opacity:1; }
.selection-bar { display:flex; align-items:center; gap:2px; padding:5px 8px 0; font-size:11px; color:var(--fg-dim); flex:none; }
.sel-count { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.selection-bar .el-button + .el-button { margin-left:0; }
.empty { padding:8px 4px; color:var(--fg-dim); font-size:12px; }

/* ---- visual refinement layer (presentation only) ---- */
.panel-section { border-top-color: color-mix(in srgb, var(--border) 72%, var(--bg2)); }
.panel-head { gap: 7px; }
.panel-head h4 { letter-spacing: .06em; font-weight: 650; }
.head-glyph { flex: none; font-size: 13px; color: var(--accent); opacity: .9; }
.icon-btn { border-radius: 6px; color: var(--fg-dim); transition: color var(--motion-hover) var(--ease-standard), background-color var(--motion-hover) var(--ease-standard); }
.icon-btn:hover { color: var(--fg); background: var(--bg-hover); }
.workspace-body { scrollbar-width: thin; scrollbar-color: color-mix(in srgb, var(--fg-muted) 38%, transparent) transparent; }
.hint code { padding: 1px 5px; border-radius: 4px; background: var(--accent-soft); font-size: 10.5px; }
.ws-row { border-radius: 6px; transition: background-color var(--motion-hover) var(--ease-standard); }
.ws-row:hover { background: var(--bg-hover); }
.ws-row.is-selected { background: var(--accent-soft); box-shadow: inset 2px 0 0 var(--accent); }
.ws-row.dir-row.drag-over { background: var(--accent-soft); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 45%, transparent); }
.chevron { transition: transform var(--motion-hover) var(--ease-standard); }
.file-icon { color: var(--fg-muted); }
.dir-row .chevron { color: color-mix(in srgb, var(--accent-warm) 72%, var(--fg-dim)); }
.workspace-size { color: var(--fg-muted); font-variant-numeric: tabular-nums; }
.file-menu { transition: opacity var(--motion-hover) var(--ease-standard); }
.more-btn { border-radius: 6px; transition: color var(--motion-hover) var(--ease-standard), background-color var(--motion-hover) var(--ease-standard); }
.dir-drop-hint { font-weight: 600; transition: opacity var(--motion-hover) var(--ease-standard); }
.directory-status button { border-radius: 4px; font-weight: 600; }
.directory-status button:hover { background: var(--accent-soft); }
.selection-bar { color: var(--accent-hover); }
.empty { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 22px 8px; color: var(--fg-muted); letter-spacing: .01em; }
.empty-glyph { font-size: 22px; color: color-mix(in srgb, var(--accent) 45%, var(--fg-muted)); opacity: .8; }
@media (prefers-reduced-motion: reduce) {
  .ws-row, .chevron, .icon-btn, .more-btn, .file-menu, .dir-drop-hint { transition: none; }
}
@media (forced-colors: active) {
  .head-glyph, .empty-glyph { color: CanvasText; }
  .ws-row.is-selected, .ws-row.dir-row.drag-over { box-shadow: none; }
}
</style>
