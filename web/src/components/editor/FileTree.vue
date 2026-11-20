<template>
  <section class="file-tree panel-section">
    <div class="panel-head">
      <div class="panel-title">
        <el-icon class="head-glyph" aria-hidden="true"><FolderOpened /></el-icon>
        <h4>项目文件</h4>
        <span class="file-count">{{ fileCount }}</span>
      </div>
      <div class="head-actions">
        <el-tooltip content="上传文件（可多选）" placement="top">
          <el-button class="icon-btn" text :disabled="store.readOnly" @click="filePickInput?.click()"><el-icon><Upload /></el-icon></el-button>
        </el-tooltip>
        <el-tooltip content="上传目录（保留子目录结构）" placement="top">
          <el-button class="icon-btn" text :disabled="store.readOnly" @click="folderPickInput?.click()"><el-icon><FolderOpened /></el-icon></el-button>
        </el-tooltip>
        <el-tooltip content="新建文件（可选 LaTeX 常用后缀）" placement="top">
          <el-button class="icon-btn" text :disabled="store.readOnly" @click="openNewFile"><el-icon><DocumentAdd /></el-icon></el-button>
        </el-tooltip>
        <el-tooltip content="新建文件夹" placement="top">
          <el-button class="icon-btn" text :disabled="store.readOnly" @click="newFolder"><el-icon><FolderAdd /></el-icon></el-button>
        </el-tooltip>
        <el-tooltip content="刷新文件树" placement="top">
          <el-button class="icon-btn" text :loading="loading" @click="refresh"><el-icon><Refresh /></el-icon></el-button>
        </el-tooltip>
      </div>
    </div>
    <div v-if="selectedPaths.length > 1" class="selection-bar">
      <span class="sel-count">已选 {{ selectedPaths.length }} 项（拖到目录可批量移动）</span>
      <el-button size="small" text type="danger" :disabled="store.readOnly" @click="batchDelete">批量删除</el-button>
      <el-button size="small" text @click="clearSelection">取消选择</el-button>
    </div>
    <div class="tree-filter">
      <el-input v-model="query" size="small" clearable placeholder="筛选文件或路径" aria-label="筛选项目文件">
        <template #prefix><el-icon class="filter-icon"><Search /></el-icon></template>
      </el-input>
    </div>
    <input ref="filePickInput" class="hidden" type="file" multiple @change="upload" />
    <input ref="folderPickInput" class="hidden" type="file" multiple webkitdirectory @change="upload" />
    <div ref="retainedScrollEl" class="tree-scroll" @click.capture="onClickCapture">
      <div v-if="store.treeError" class="tree-error" role="alert">{{ store.treeError }} <button type="button" @click="refresh">重试</button></div>
      <div v-if="(loading || store.treeLoading || (store.treeLoaded === false && !store.treeError)) && !displayTree.length" class="empty-state"><el-icon class="is-loading"><Loading /></el-icon> 正在加载文件…</div>
      <el-tree
        v-else-if="displayTree.length"
        ref="treeRef"
        class="project-tree"
        :data="displayTree"
        node-key="path"
        :props="treeProps"
        :expand-on-click-node="false"
        :default-expanded-keys="defaultExpandedKeys"
        :current-node-key="store.activeFile"
        highlight-current
        draggable
        :allow-drag="allowDrag"
        :allow-drop="allowDrop"
        @node-click="handleNodeClick"
        @node-drop="onNodeDrop"
        @node-expand="onNodeExpand"
        @node-collapse="onNodeCollapse"
      >
        <template #default="{ data }">
          <div class="tree-row" :class="{ 'is-group': data.kind === 'group', 'is-file': data.type === 'file', 'is-selected': isSelected(data) || store.activeFile === data.path }">
            <span class="node-icon" :class="iconClass(data)">{{ nodeIcon(data) }}</span>
            <span class="node-name" :title="data.path">{{ data.name }}</span>
            <span v-if="data.type === 'file' && isMainFile(data.path)" class="main-badge" title="编译入口（主文件）">主</span>
            <span v-if="data.type === 'file'" class="node-size">{{ formatBytes(data.size) }}</span>
            <el-dropdown class="node-menu" trigger="click" @command="(command) => handleCommand(command, data)">
              <el-button class="more-btn" text aria-label="文件操作" @click.stop><el-icon><MoreFilled /></el-icon></el-button>
              <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item v-if="data.type === 'file'" command="download">下载文件</el-dropdown-item>
                <el-dropdown-item
                  v-if="data.type === 'file' && isTexFile(data.path)"
                  command="set-main"
                  :disabled="store.readOnly || isMainFile(data.path)"
                >{{ isMainFile(data.path) ? '主文件 ✓' : '设为主文件' }}</el-dropdown-item>
                <template v-if="data.type === 'dir'">
                  <el-dropdown-item command="upload-files" :disabled="store.readOnly">上传文件到此处</el-dropdown-item>
                  <el-dropdown-item command="upload-dir" :disabled="store.readOnly">上传目录到此处</el-dropdown-item>
                </template>
                <el-dropdown-item command="rename" :disabled="store.readOnly">重命名</el-dropdown-item>
                <el-dropdown-item command="remove" :disabled="store.readOnly" divided>删除</el-dropdown-item>
              </el-dropdown-menu>
              </template>
            </el-dropdown>
          </div>
        </template>
      </el-tree>
      <div v-else-if="!store.treeError" class="empty-state"><el-icon class="empty-glyph" aria-hidden="true"><FolderOpened /></el-icon>{{ query ? '没有匹配的文件' : '项目暂无文件' }}</div>
    </div>
    <div class="tree-foot">{{ query ? fileCount + " 个匹配文件" : "共 " + fileCount + " 个文件" }}</div>
    <el-dialog v-model="newFileDialog" title="新建文件" width="400px" append-to-body>
      <el-form label-width="56px" size="small" @submit.prevent="createFile">
        <el-form-item label="目录">
          <el-input v-model="newFileForm.dir" placeholder="留空 = 项目根目录，如 chapters/" clearable />
        </el-form-item>
        <el-form-item label="文件名">
          <el-input v-model="newFileForm.name" placeholder="如 main、references" clearable>
            <template #append><span class="ext-badge">{{ newFileForm.ext }}</span></template>
          </el-input>
        </el-form-item>
        <el-form-item label="类型">
          <el-select v-model="newFileForm.ext" style="width: 100%">
            <el-option v-for="e in FILE_EXTS" :key="e.value" :value="e.value" :label="e.label" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button size="small" @click="newFileDialog = false">取消</el-button>
        <el-button size="small" type="primary" @click="createFile">创建</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<script setup>
import { useRetainedScroll } from '../../lib/retainedScroll.js';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { Loading, Upload, FolderAdd, FolderOpened, DocumentAdd, Refresh, Search, MoreFilled } from '@element-plus/icons-vue';
import { api } from '../../api.js';
import { downloadProjectFile } from '../../lib/projectFileUrl.js';
import { useEditorStore } from '../../stores/editor.js';
import { useUiStore } from '../../stores/ui.js';

const props = defineProps({ active: { type: Boolean, default: true } });
const store = useEditorStore();
const retainedScrollEl = ref(null);
useRetainedScroll(retainedScrollEl, { scope: store, key: () => 'tree-scroll', active: () => props.active });
const ui = useUiStore();
const filePickInput = ref(null);
const folderPickInput = ref(null);
const treeRef = ref(null);
const loading = ref(false);
const query = ref('');
const treeProps = { children: 'children', label: 'name' };
const rawTree = computed(() => (store.tree || []).filter((node) => node.path !== '_workspace' && !String(node.path || '').startsWith('_workspace/')));

const displayTree = computed(() => {
  const groups = [
    { path: '__group__source', name: '源文件', kind: 'group', type: 'dir', children: [] },
    { path: '__group__assets', name: '编译与素材', kind: 'group', type: 'dir', children: [] },
  ];
  rawTree.value.forEach((node) => {
    const target = isAssetNode(node) ? groups[1] : groups[0];
    const filtered = filterNode(normalizeNode(node), query.value.trim().toLowerCase());
    if (filtered) target.children.push(filtered);
  });
  return groups.filter((group) => group.children.length);
});
const fileCount = computed(() => countFiles(displayTree.value));
function normalizeNode(node) { return { ...node, children: node.type === 'dir' ? (node.children || []).map(normalizeNode) : undefined }; }
function extension(name = '') { const lower = String(name).toLowerCase(); return lower.endsWith('.synctex.gz') ? '.synctex.gz' : lower.includes('.') ? lower.slice(lower.lastIndexOf('.')) : ''; }
function isAssetNode(node) {
  const path = String(node.path || '').toLowerCase();
  const name = String(node.name || '').toLowerCase();
  if (node.type === 'dir') return /^(fig|figures|assets|images?|build|out|dist|output|temp|tmp)$/.test(name) || path.split('/').includes('fig');
  return ['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.eps', '.aux', '.log', '.out', '.toc', '.fls', '.fdb_latexmk', '.synctex.gz'].includes(extension(name));
}
function filterNode(node, term) {
  if (node.type !== 'dir') {
    if (!term) return node;
    return String(node.name).toLowerCase().includes(term) || String(node.path).toLowerCase().includes(term) ? node : null;
  }
  const children = (node.children || []).map((child) => filterNode(child, term)).filter(Boolean);
  if (!term || children.length || String(node.name).toLowerCase().includes(term) || String(node.path).toLowerCase().includes(term)) return { ...node, children };
  return null;
}
function countFiles(nodes) { return (nodes || []).reduce((count, node) => count + (node.type === 'file' ? 1 : countFiles(node.children)), 0); }
function nodeIcon(node) {
  if (node.kind === 'group') return node.name === '源文件' ? '▤' : '▧';
  if (node.type === 'dir') return '▱';
  const ext = extension(node.name);
  if (ext === '.tex') return 'T';
  if (['.bib', '.sty', '.cls'].includes(ext)) return '≡';
  if (['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.eps'].includes(ext)) return '▧';
  return '•';
}
function iconClass(node) { return node.kind === 'group' ? 'group-icon' : node.type === 'dir' ? 'folder-icon' : extension(node.name).slice(1); }
function formatBytes(n = 0) { if (n < 1024) return n + ' B'; if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'; return (n / 1024 / 1024).toFixed(1) + ' MB'; }
function handleNodeClick(data) {
  if (data.kind === 'group') return;
  if (clickMods.value.shift) { selectRange(data.path); return; }
  if (clickMods.value.ctrl) { toggleSelect(data.path); return; }
  setSingle(data.path);
  if (data.type === 'file') store.openFile(data.path);
}
// —— 多选:单击单选(打开文件)、Shift 连选、Ctrl/⌘ 跳选 ——
// el-tree 的 node-click 回调不带原生事件,在 tree-scroll 捕获阶段先记下
// 点击事件的修饰键(capture 先于 el-tree 的 handler,时序有保证)
const selectedPaths = ref([]);
const anchorPath = ref(null);
const clickMods = ref({ shift: false, ctrl: false });
function onClickCapture(e) { clickMods.value = { shift: !!e.shiftKey, ctrl: !!(e.ctrlKey || e.metaKey) }; }
function isSelected(data) { return !data.kind && selectedPaths.value.includes(data.path); }
function flattenTreeNodes(nodes, out = []) {
  (nodes || []).forEach((n) => { if (n.kind === 'group') flattenTreeNodes(n.children, out); else { out.push(n); flattenTreeNodes(n.children, out); } });
  return out;
}
function setSingle(path) { selectedPaths.value = [path]; anchorPath.value = path; }
function toggleSelect(path) {
  const i = selectedPaths.value.indexOf(path);
  if (i >= 0) selectedPaths.value.splice(i, 1); else selectedPaths.value.push(path);
  anchorPath.value = path;
}
function selectRange(path) {
  const order = flattenTreeNodes(displayTree.value).map((n) => n.path);
  const a = order.indexOf(anchorPath.value ?? path);
  const b = order.indexOf(path);
  if (a < 0 || b < 0) { setSingle(path); return; }
  selectedPaths.value = order.slice(Math.min(a, b), Math.max(a, b) + 1);
}
function clearSelection() { selectedPaths.value = []; }
function pruneSelection() {
  const alive = new Set(flattenTreeNodes(displayTree.value).map((n) => n.path));
  selectedPaths.value = selectedPaths.value.filter((p) => alive.has(p));
}
async function batchDelete() {
  if (store.readOnly || !selectedPaths.value.length || !store.projectId) return;
  if (!window.confirm('确定删除选中的 ' + selectedPaths.value.length + ' 项吗？目录将连同内容一起删除。')) return;
  let ok = 0; const failed = [];
  // 先关掉将被删除文件占用的标签,再逐个删除(防协同重连写回),最后统一刷新
  for (const p of selectedPaths.value) {
    if (store.activeFile && (store.activeFile === p || store.activeFile.startsWith(p + '/'))) store.closeFile(store.activeFile);
  }
  for (const p of selectedPaths.value) {
    try {
      await api.del('/api/projects/' + store.projectId + '/files?path=' + encodeURIComponent(p));
      ok++;
    } catch { failed.push(p); }
  }
  await refresh();
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
function handleCommand(command, node) {
  if (command === 'download') download(node.path);
  if (command === 'set-main') setMainFile(node.path);
  if (command === 'rename') renameNode(node);
  if (command === 'remove') removeNode(node);
  if (command === 'upload-files') { uploadTargetDir = node.path; filePickInput.value?.click(); }
  if (command === 'upload-dir') { uploadTargetDir = node.path; folderPickInput.value?.click(); }
}

// —— 主文件:编译入口。任何 .tex 都可经「设为主文件」声明,不必叫 main ——
const isTexFile = (p) => /\.tex$/i.test(p || '');
const isMainFile = (p) => (store.project?.mainFile || 'main.tex') === p;
async function setMainFile(path) {
  try {
    await api.patch(`/api/projects/${store.projectId}`, { mainFile: path });
    if (store.project) store.project.mainFile = path;
    ui.toast(`已将 ${path} 设为主文件，编译将以此为入口`);
  } catch (e) {
    ui.error(e.message || '设置主文件失败');
  }
}
async function refresh() {
  loading.value = true;
  try { await store.loadTree(); }
  catch (error) { ui.error(error?.message || '项目文件加载失败'); return; }
  finally { loading.value = false; }
  // Existing nodes stay mounted while refreshing; replay remembered expansion after data updates.
  await applyExpanded();
  pruneSelection();
  // 手动删改会让部分待审条目在服务端作废,同步刷新审查条
  store.loadPendingChangesets().catch(() => {});
}
// —— 目录展开状态记忆 ——
// el-tree 数据刷新(拖拽移动/上传/重命名后)会整体重建节点,展开状态被重置;
// 自己维护已展开 key 集合,刷新后回放,并按项目持久化到 localStorage。
const expandedSet = ref(new Set());
function expandedKey() { return 'corelatex.treeExpanded.' + (store.projectId || ''); }
function loadExpanded() {
  try { expandedSet.value = new Set(JSON.parse(localStorage.getItem(expandedKey()) || '[]')); }
  catch { expandedSet.value = new Set(); }
}
function saveExpanded() {
  try { localStorage.setItem(expandedKey(), JSON.stringify([...expandedSet.value])); } catch {}
}
function onNodeExpand(data) { expandedSet.value.add(data.path); saveExpanded(); }
function onNodeCollapse(data) { expandedSet.value.delete(data.path); saveExpanded(); }
// 回放展开状态:换一个新的 default-expanded-keys 数组引用,el-tree 内部 watch 到变化会
// 逐个 expand;再直接把 store.nodesMap 里对应节点置为展开兜底(两条路都幂等)
const defaultExpandedKeys = ref(['__group__source']);
async function applyExpanded() {
  if (!expandedSet.value.size) return;
  await nextTick(); // Wait for the tree's updated data before replaying expansion.
  defaultExpandedKeys.value = ['__group__source', ...expandedSet.value];
  try {
    const nodesMap = treeRef.value?.store?.nodesMap;
    if (nodesMap) expandedSet.value.forEach((key) => { if (nodesMap[key]) nodesMap[key].expanded = true; });
  } catch {}
}
// 移动目录时同步改写集合内该目录自身及其子级的 key,并展开目标目录让移动结果可见
function rememberMoved(node, oldPath, newParent) {
  if (node.type === 'dir') {
    expandedSet.value = new Set([...expandedSet.value].map((k) => {
      if (k === oldPath) return node.path;
      return k.startsWith(oldPath + '/') ? node.path + k.slice(oldPath.length) : k;
    }));
  }
  if (newParent) expandedSet.value.add(newParent);
  saveExpanded();
}
// 文件与目录两个选择器共用同一条上传通道：目录选择带 webkitRelativePath，
// 普通文件选择回退为文件名，服务端按 paths 逐项落盘并自动建父目录；
// 从目录菜单发起时 uploads 定向到该目录
let uploadTargetDir = '';
async function upload(e) {
  const files = [...(e.target.files || [])]; e.target.value = '';
  if (!files.length || !store.projectId || store.readOnly) return;
  const prefix = uploadTargetDir ? uploadTargetDir + '/' : '';
  const form = new FormData(); form.append('paths', JSON.stringify(files.map((file) => prefix + (file.webkitRelativePath || file.name)))); files.forEach((file) => form.append('files', file, file.name));
  uploadTargetDir = '';
  try { await api.postForm('/api/projects/' + store.projectId + '/upload', form); await refresh(); ui.toast('上传完成'); } catch (err) { ui.error(err.message || '上传失败'); }
}
// —— 拖拽移动：改变文件/目录层级 ——
// 「源文件 / 编译与素材」是前端按类型虚拟分出来的组、不是真实目录，禁止拖动和作为放置目标；
// 拖到真实目录上=移入该目录，拖到节点前后=移到其同级（根级节点的同级即项目根目录）。
function allowDrag(node) { return !store.readOnly && node.data.kind !== 'group'; }
function isDescendantTarget(dropNode, draggingNode) {
  let parent = dropNode.parent;
  while (parent) {
    if (parent.data?.path === draggingNode.data.path) return true;
    parent = parent.parent;
  }
  return false;
}
function allowDrop(draggingNode, dropNode, type) {
  if (store.readOnly || dropNode.data.kind === 'group') return false;
  if (draggingNode.data.path === dropNode.data.path) return false;
  if (isDescendantTarget(dropNode, draggingNode)) return false; // 不能拖进自己的子级
  if (type === 'inner') return dropNode.data.type === 'dir';
  return true;
}
async function onNodeDrop(draggingNode, dropNode, dropType) {
  const dragData = draggingNode.data;
  if (!dragData?.path || dragData.kind === 'group' || !store.projectId) return;
  let parentPath;
  if (dropType === 'inner') {
    parentPath = dropNode.data.path;
  } else {
    const target = String(dropNode.data.path || '');
    parentPath = target.includes('/') ? target.slice(0, target.lastIndexOf('/')) : '';
  }
  // 被拖节点在多选集合中 → 整批移动;否则只移动被拖节点
  const items = (selectedPaths.value.length > 1 && selectedPaths.value.includes(dragData.path))
    ? selectedPaths.value.slice()
    : [dragData.path];
  const nodeMap = new Map(flattenTreeNodes(displayTree.value).map((n) => [n.path, n]));
  const plan = [];
  let skippedInside = 0;
  for (const p of items) {
    const name = p.split('/').pop();
    const newPath = parentPath ? parentPath + '/' + name : name;
    if (newPath === p) continue; // 原地,跳过
    if (parentPath === p || parentPath.startsWith(p + '/')) { skippedInside++; continue; } // 目标在该目录内部
    plan.push({ oldPath: p, newPath, isDir: nodeMap.get(p)?.type === 'dir' });
  }
  let ok = 0;
  const failed = [];
  for (const item of plan) {
    try {
      if (!await store.renamePath(item.oldPath, item.newPath)) return;
      ok++;
      // 目录移动后,改写剩余计划与展开集合中位于该目录内的路径
      for (const rest of plan) {
        if (rest.oldPath.startsWith(item.oldPath + '/')) rest.oldPath = item.newPath + rest.oldPath.slice(item.oldPath.length);
      }
      if (item.isDir) rememberMoved({ type: 'dir', path: item.newPath }, item.oldPath, parentPath);
    } catch { failed.push(item.oldPath); }
  }
  if (!ok && !failed.length) return;
  clearSelection();
  await refresh();
  const dest = parentPath || '根目录';
  if (failed.length) ui.error('已移动 ' + ok + ' 项到 ' + dest + '，' + failed.length + ' 项失败（重名或其他原因）');
  else if (items.length > 1) ui.toast('已移动 ' + ok + ' 项到 ' + dest + (skippedInside ? '，跳过 ' + skippedInside + ' 项' : ''));
  else ui.toast('已移动到 ' + dest);
}
async function newFolder() {
  if (store.readOnly) return;
  const path = window.prompt('新建文件夹路径', '');
  if (!path?.trim()) return;
  try { await api.post('/api/projects/' + store.projectId + '/mkdir', { path: path.trim() }); await refresh(); } catch (err) { ui.error(err.message || '创建失败'); }
}
async function renameNode(node) {
  if (store.readOnly || node.kind === 'group') return;
  const name = window.prompt('重命名', node.name);
  if (!name?.trim() || name.trim() === node.name) return;
  const base = node.path.includes('/') ? node.path.slice(0, node.path.lastIndexOf('/') + 1) : '';
  try {
    const newPath = base + name.trim();
    if (!await store.renamePath(node.path, newPath)) return;
    rememberMoved({ type: node.type, path: newPath }, node.path, base.replace(/\/$/, ''));
    await refresh();
  } catch (err) { ui.error(err.message || '重命名失败'); }
}
async function removeNode(node) {
  if (store.readOnly || node.kind === 'group' || !window.confirm('确定删除“' + node.path + '”吗？')) return;
  // 先关标签再删:避免协同客户端在删除后重连,把已删文件以旧内容/空内容写回
  if (node.type === 'file') store.closeFile(node.path);
  try { await api.del('/api/projects/' + store.projectId + '/files?path=' + encodeURIComponent(node.path)); await refresh(); } catch (err) { ui.error(err.message || '删除失败'); }
}
function download(path) {
  if (!store.projectId) return;
  downloadProjectFile(store.projectId, path);
}

watch(() => query.value, async (value) => {
  if (!value.trim()) return;
  await nextTick();
  const keys = [];
  const collect = (nodes) => (nodes || []).forEach((node) => { if (node.type === 'dir') { keys.push(node.path); collect(node.children); } });
  collect(displayTree.value);
  // 筛选时展开所有目录让匹配项可见
  const nodesMap = treeRef.value?.store?.nodesMap;
  if (nodesMap) keys.forEach((key) => { if (nodesMap[key]) nodesMap[key].expanded = true; });
});
// Project initialization and mutations own loading. Mounting/opening this panel
// must never issue another directory scan, including for genuinely empty projects.
watch(() => store.projectId, () => { loadExpanded(); clearSelection(); query.value = ''; applyExpanded(); });
watch(() => store.treeVersion, () => { applyExpanded(); pruneSelection(); });
onMounted(() => {
  loadExpanded();
  window.addEventListener('keydown', onDeleteKey);
  applyExpanded();
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onDeleteKey);
});

// —— 新建文件(带 LaTeX 常用后缀下拉) ——
const newFileDialog = ref(false);
const newFileForm = ref({ dir: '', name: '', ext: '.tex' });
const FILE_EXTS = [
  { value: '.tex', label: '.tex — LaTeX 文档' },
  { value: '.bib', label: '.bib — BibTeX 文献库' },
  { value: '.sty', label: '.sty — 宏包(style)' },
  { value: '.cls', label: '.cls — 文档类(class)' },
  { value: '.bst', label: '.bst — 参考文献样式' },
  { value: '.tikz', label: '.tikz — TikZ 图源' },
  { value: '.md', label: '.md — Markdown 笔记' },
  { value: '.txt', label: '.txt — 纯文本' },
];
function openNewFile() {
  newFileForm.value = { dir: '', name: '', ext: '.tex' };
  newFileDialog.value = true;
}
async function createFile() {
  if (store.readOnly || !store.projectId) return;
  const dir = newFileForm.value.dir.trim().replace(/^\/*/, '').replace(/\/+$/, '');
  let name = newFileForm.value.name.trim();
  if (!name) { ui.error('请输入文件名'); return; }
  if (name.includes('/')) { ui.error('文件名不能包含 /,子路径请填到目录栏'); return; }
  // 已手敲后缀时不再叠加,统一以选择的类型为准
  name = name.replace(new RegExp(newFileForm.value.ext.replace('.', '\\.') + '$', 'i'), '');
  const path = (dir ? dir + '/' : '') + name + newFileForm.value.ext;
  try {
    await api.post('/api/projects/' + store.projectId + '/files', { path, content: '', overwrite: false });
    newFileDialog.value = false;
    if (dir) { expandedSet.value.add(dir); saveExpanded(); }
    await refresh();
    store.openFile(path);
    ui.toast('已创建 ' + path);
  } catch (err) { ui.error(err.message || '创建失败'); }
}
</script>

<style scoped>
.panel-section { display: flex; flex: 1 1 0; flex-direction: column; min-height: 0; height: 100%; overflow: hidden; }
.panel-head { display: flex; align-items: center; gap: 8px; padding: 9px 10px; border-bottom: 1px solid var(--border); }
.panel-title { display: flex; align-items: center; gap: 7px; min-width: 0; flex: 1; }
.panel-head h4 { margin: 0; font-size: 12px; font-weight: 650; color: var(--fg); }
.file-count { display: inline-flex; min-width: 18px; height: 18px; align-items: center; justify-content: center; padding: 0 5px; border-radius: 9px; background: var(--bg3); color: var(--fg-dim); font-size: 10px; }
.head-actions { display: flex; align-items: center; gap: 1px; }
.icon-btn { height: 26px; padding: 0 6px; color: var(--fg-dim); font-size: 12px; }
.icon-btn:hover { color: var(--fg); background: var(--bg-hover); }
.hidden { display: none; }
.tree-filter { padding: 7px 9px; border-bottom: 1px solid var(--border); }
.filter-icon { color: var(--fg-dim); font-size: 13px; }
.tree-error { padding: 7px 9px; color: var(--danger, #c44); font-size: 12px; }
.tree-error button { border: 0; background: transparent; color: var(--accent); cursor: pointer; }
.tree-scroll { flex: 1; min-height: 100px; overflow: auto; padding: 5px 5px 7px; }
.project-tree { --el-tree-node-hover-bg-color: var(--bg-hover); --el-tree-text-color: var(--fg-dim); background: transparent; font-size: 12px; }
.project-tree :deep(.el-tree-node__content) { height: 30px; border-radius: 5px; padding-right: 3px; }
.project-tree :deep(.el-tree-node__content:hover) { background: var(--bg-hover); }
/* 选中高亮统一由 .tree-row.is-selected 一层负责;显式关掉 EP 默认 is-current 底色,避免同一行两种绿 */
.project-tree :deep(.is-current > .el-tree-node__content) { background: transparent; }
.project-tree :deep(.el-tree-node__expand-icon) { color: var(--fg-dim); font-size: 12px; padding: 5px 4px 5px 2px; }
.tree-row { display: flex; align-items: center; min-width: 0; width: 100%; gap: 6px; line-height: 30px; user-select: none; }
.tree-row.is-selected:not(.is-group) { background: var(--bg-hover); border-radius: 4px; color: var(--fg); }
.selection-bar { display: flex; align-items: center; gap: 2px; padding: 5px 9px 0; font-size: 11px; color: var(--fg-dim); }
.sel-count { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.selection-bar .el-button + .el-button { margin-left: 0; }
.tree-row.is-group { font-weight: 650; color: var(--fg); }
.node-icon { width: 16px; flex: none; color: var(--fg-dim); text-align: center; font-size: 13px; }
.group-icon { color: var(--fg-dim); }
.folder-icon { color: var(--fg-dim); }
.node-name { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.main-badge {
  flex: none;
  font-size: 10px;
  line-height: 1;
  padding: 2px 4px;
  border-radius: 4px;
  background: var(--bg3);
  color: var(--fg-dim);
  margin-right: 4px;
}
.node-size { flex: none; color: var(--fg-dim); font-size: 10px; }
.node-menu { flex: none; opacity: 0; transition: opacity .12s ease; }
.tree-row:hover .node-menu, .project-tree :deep(.is-current) .node-menu, .tree-row.is-group .node-menu { opacity: 1; }
.more-btn { width: 27px; height: 25px; padding: 0; color: var(--fg-dim); font-size: 12px; }
.more-btn:hover { color: var(--fg); background: var(--bg3); }
.empty-state { display: flex; align-items: center; justify-content: center; gap: 7px; min-height: 110px; padding: 18px 12px; color: var(--fg-dim); font-size: 12px; text-align: center; }
.tree-foot { flex: none; padding: 6px 10px; border-top: 1px solid var(--border); color: var(--fg-dim); font-size: 10px; }
.ext-badge { color: var(--accent); font-family: ui-monospace, monospace; font-size: 11px; }

/* ---- visual refinement layer (presentation only) ---- */
.panel-head { border-bottom-color: color-mix(in srgb, var(--border) 72%, var(--bg2)); }
.panel-head h4 { letter-spacing: .02em; }
.head-glyph { flex: none; font-size: 13px; color: var(--accent); opacity: .9; }
.file-count { background: var(--accent-soft); color: var(--accent-hover); font-weight: 650; font-variant-numeric: tabular-nums; border-radius: 999px; }
.icon-btn { border-radius: 6px; transition: color var(--motion-hover) var(--ease-standard), background-color var(--motion-hover) var(--ease-standard); }
.tree-filter { border-bottom-color: color-mix(in srgb, var(--border) 72%, var(--bg2)); }
.tree-scroll { scrollbar-width: thin; scrollbar-color: color-mix(in srgb, var(--fg-muted) 38%, transparent) transparent; }
.project-tree :deep(.el-tree-node__content) { border-radius: 6px; transition: background-color var(--motion-hover) var(--ease-standard); }
.tree-row.is-selected:not(.is-group) { background: var(--accent-soft); box-shadow: inset 2px 0 0 var(--accent); color: var(--fg); }
.tree-row.is-group { letter-spacing: .01em; }
.group-icon { color: var(--accent); }
.folder-icon { color: color-mix(in srgb, var(--accent-warm) 72%, var(--fg-dim)); }
.node-icon.tex { color: var(--accent); font-weight: 700; }
.node-icon.bib, .node-icon.sty, .node-icon.cls { color: var(--accent-secondary); }
.node-size { color: var(--fg-muted); font-variant-numeric: tabular-nums; }
.main-badge { background: var(--accent-soft); color: var(--accent-hover); font-weight: 650; border-radius: 999px; padding: 2px 6px; }
.node-menu { transition: opacity var(--motion-hover) var(--ease-standard); }
.more-btn { border-radius: 6px; transition: color var(--motion-hover) var(--ease-standard), background-color var(--motion-hover) var(--ease-standard); }
.selection-bar { color: var(--accent-hover); }
.tree-error { margin: 5px 6px 0; padding: 7px 9px; border-radius: var(--radius-sm); background: var(--danger-soft); color: var(--danger); }
.tree-error button { font-weight: 600; }
.empty-state { flex-direction: column; gap: 8px; color: var(--fg-muted); letter-spacing: .01em; }
.empty-glyph { font-size: 22px; color: color-mix(in srgb, var(--accent) 45%, var(--fg-muted)); opacity: .8; }
.tree-foot { border-top-color: color-mix(in srgb, var(--border) 72%, var(--bg2)); color: var(--fg-muted); letter-spacing: .02em; font-variant-numeric: tabular-nums; }
@media (prefers-reduced-motion: reduce) {
  .icon-btn, .more-btn, .node-menu, .project-tree :deep(.el-tree-node__content) { transition: none; }
}
@media (forced-colors: active) {
  .head-glyph, .empty-glyph { color: CanvasText; }
  .tree-row.is-selected:not(.is-group) { box-shadow: none; }
}
</style>
