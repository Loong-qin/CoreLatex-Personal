<template>
  <div class="versions-panel">
    <div class="panel-head">
      <el-button type="primary" size="small" @click="snapshotOpen = true">
        <el-icon class="btn-icon"><Camera /></el-icon>手动创建快照
      </el-button>
      <span class="grow"></span>
      <el-button text size="small" title="刷新版本列表" aria-label="刷新版本列表" :loading="listLoading" @click="loadVersions">
        <el-icon><Refresh /></el-icon>
      </el-button>
    </div>

    <div v-if="listLoading && !versions.length" class="empty muted" role="status">正在加载版本记录…</div>
    <div v-else-if="listError" class="list-error" role="alert">
      <span>{{ listError }}</span><el-button text size="small" @click="loadVersions">重试</el-button>
    </div>
    <div v-else-if="!versions.length" class="empty muted"><el-icon class="empty-glyph" aria-hidden="true"><Camera /></el-icon>暂无版本记录</div>

    <div v-for="g in groups" :key="g.day" class="day-group">
      <div class="day-title">{{ g.day }}</div>
      <article v-for="v in g.items" :key="v.id" class="version-item">
        <button type="button" class="version-summary" :aria-expanded="expandedId === v.id"
          :aria-controls="'version-files-' + v.id" @click="toggleVersion(v)">
          <span class="v-line1">
            <span class="v-chevron" :class="{ expanded: expandedId === v.id }" aria-hidden="true">›</span>
            <span class="v-badge">v{{ v.seq || v.id }}</span>
            <span class="v-msg" :title="v.message">{{ v.message || '（无说明）' }}</span>
          </span>
          <span class="v-line2">
            <span class="adds">+{{ v.adds }}</span><span class="dels">−{{ v.dels }}</span>
            <span class="muted">{{ v.userName }}</span><span class="grow"></span>
            <span class="muted">{{ timeAgo(v.createdAt) }}</span>
          </span>
        </button>
        <button type="button" class="v-menu" title="更多操作" :aria-label="'v' + (v.seq || v.id) + ' 更多操作'" @click.stop="openMenu($event, v)">⋯</button>
        <div v-if="expandedId === v.id" :id="'version-files-' + v.id" class="version-files">
          <p v-if="!v.files?.length" class="files-empty muted">该快照没有文件变更</p>
          <ul v-else :aria-label="'v' + (v.seq || v.id) + ' 变更文件'">
            <li v-for="file in v.files" :key="file.path" class="version-file">
              <span class="change-kind" :class="file.change">{{ changeLabel(file.change) }}</span>
              <span class="file-path mono" :title="file.path">{{ file.path }}</span>
              <span v-if="file.binary" class="binary-mark" title="二进制文件">二进制</span>
              <span class="file-counts mono"><span class="adds">+{{ file.adds || 0 }}</span><span class="dels">−{{ file.dels || 0 }}</span></span>
              <button type="button" class="file-view" :aria-label="'查看 ' + file.path + ' 的更改'" @click.stop="showDiff(v, file.path)">查看</button>
            </li>
          </ul>
        </div>
      </article>
    </div>

    <el-dialog v-model="snapshotOpen" title="手动创建快照" width="420px">
      <el-form label-position="top" @submit.prevent>
        <el-form-item label="版本说明">
          <el-input v-model="snapshotMsg" placeholder="例如：完成第二章初稿" @keyup.enter="createSnapshot" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="snapshotOpen = false">取消</el-button>
        <el-button type="primary" :loading="creating" @click="createSnapshot">创建</el-button>
      </template>
    </el-dialog>

    <el-dialog :model-value="!!restoreTarget" title="恢复此版本" width="420px" @update:model-value="restoreTarget = null">
      <p class="muted" style="margin: 0">
        将项目文件恢复到 v{{ restoreTarget?.seq || restoreTarget?.id }}（{{ restoreTarget?.message || '无说明' }}）。
        恢复前会自动保存当前内容为安全快照，再恢复到所选版本。确定继续吗？
      </p>
      <template #footer>
        <el-button @click="restoreTarget = null">取消</el-button>
        <el-button type="danger" :loading="restoring" @click="doRestore">恢复</el-button>
      </template>
    </el-dialog>

    <el-dialog :model-value="!!diffView" :title="diffTitle" width="min(800px, 94vw)" @update:model-value="closeDiff">
      <template v-if="diffView">
        <p class="diff-note muted">相对上一快照的更改；首次快照展示初始文件内容。</p>
        <div v-if="diffView.loading" class="diff-state muted" role="status">正在加载文件差异…</div>
        <div v-else-if="diffView.error" class="diff-state" role="alert">
          <span>{{ diffView.error }}</span>
          <el-button text size="small" @click="showDiff(diffView.version, diffView.filePath)">重试</el-button>
        </div>
        <div v-else-if="!diffView.diffs.length" class="diff-state muted">{{ diffView.filePath ? '该文件差异不可用' : '该快照没有可显示的文件差异' }}</div>
        <div v-for="d in diffView.diffs" v-else :key="d.path" class="diff-file">
          <div class="diff-path mono">{{ d.path }}</div>
          <p v-if="d.binary" class="binary-note muted">此文件为二进制文件（如图片或 PDF），无法显示逐行文字差异。</p>
          <div v-else-if="d.patch" class="diff-body mono" role="region" :aria-label="d.path + ' 只读差异'" tabindex="0">
            <pre v-for="(line, i) in diffLines(d.patch)" :key="i" :class="lineClass(line)">{{ line || ' ' }}</pre>
          </div>
          <p v-else class="muted">该文件没有可显示的文本差异</p>
        </div>
      </template>
      <template #footer><el-button @click="closeDiff">关闭</el-button></template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, watch, onBeforeUnmount } from 'vue';
import { Camera, Refresh } from '@element-plus/icons-vue';
import { api, timeAgo } from '../../api.js';
import { useEditorStore } from '../../stores/editor.js';
import { useUiStore } from '../../stores/ui.js';
import { groupVersionsByDay } from '../../lib/editorUtils.js';

const store = useEditorStore();
const ui = useUiStore();
const versions = ref([]);
const listLoading = ref(false);
const listError = ref('');
const expandedId = ref(null);
const snapshotOpen = ref(false);
const snapshotMsg = ref('');
const creating = ref(false);
const restoreTarget = ref(null);
const restoring = ref(false);
const diffView = ref(null);
const groups = computed(() => groupVersionsByDay(versions.value));
const diffTitle = computed(() => diffView.value
  ? 'v' + (diffView.value.version.seq || diffView.value.version.id) + ' · ' + (diffView.value.filePath || '全部更改')
  : '查看更改');

let active = true;
let listRequest = 0;
let diffRequest = 0;
let snapshotRequest = 0;
let restoreRequest = 0;
const detailsCache = new Map();
const pendingDetails = new Map();
const isCurrent = (projectId, projectVersion) => active && store.isCurrentProject(projectId, projectVersion);

function resetView() {
  ++listRequest; ++diffRequest; ++snapshotRequest; ++restoreRequest;
  versions.value = [];
  listLoading.value = false;
  listError.value = '';
  expandedId.value = null;
  snapshotOpen.value = false;
  snapshotMsg.value = '';
  creating.value = false;
  restoreTarget.value = null;
  restoring.value = false;
  diffView.value = null;
  detailsCache.clear();
  pendingDetails.clear();
}

async function loadVersions() {
  const { projectId, projectVersion } = store;
  if (!projectId) return;
  const request = ++listRequest;
  listLoading.value = true;
  listError.value = '';
  try {
    const result = await api.get('/api/projects/' + projectId + '/versions');
    if (!isCurrent(projectId, projectVersion) || request !== listRequest) return;
    versions.value = result.versions || [];
    if (!versions.value.some((version) => version.id === expandedId.value)) expandedId.value = null;
  } catch (error) {
    if (isCurrent(projectId, projectVersion) && request === listRequest) listError.value = error.message || '加载版本记录失败';
  } finally {
    if (isCurrent(projectId, projectVersion) && request === listRequest) listLoading.value = false;
  }
}

function toggleVersion(version) {
  expandedId.value = expandedId.value === version.id ? null : version.id;
}
function changeLabel(change) {
  return { added: '新增', removed: '删除', modified: '修改' }[change] || '更改';
}
function openMenu(event, version) {
  const { projectId, projectVersion } = store;
  ui.openContextMenu(event.clientX, event.clientY, [
    { label: '查看更改', action: () => { if (isCurrent(projectId, projectVersion)) showDiff(version); } },
    { label: '恢复此版本', danger: true, action: () => { if (isCurrent(projectId, projectVersion)) restoreTarget.value = version; } },
  ]);
}

async function readVersion(version, projectId, projectVersion) {
  if (detailsCache.has(version.id)) return detailsCache.get(version.id);
  if (pendingDetails.has(version.id)) return pendingDetails.get(version.id);
  const request = api.get('/api/projects/' + projectId + '/versions/' + version.id);
  pendingDetails.set(version.id, request);
  try {
    const result = await request;
    if (isCurrent(projectId, projectVersion)) detailsCache.set(version.id, result);
    return result;
  } finally {
    if (pendingDetails.get(version.id) === request) pendingDetails.delete(version.id);
  }
}
async function showDiff(version, filePath = '') {
  const { projectId, projectVersion } = store;
  const request = ++diffRequest;
  diffView.value = { version, filePath, loading: true, error: '', diffs: [] };
  try {
    const result = await readVersion(version, projectId, projectVersion);
    if (!isCurrent(projectId, projectVersion) || request !== diffRequest) return;
    const diffs = result.diffs || [];
    diffView.value = { version, filePath, loading: false, error: '',
      diffs: filePath ? diffs.filter((diff) => diff.path === filePath) : diffs };
  } catch (error) {
    if (isCurrent(projectId, projectVersion) && request === diffRequest) {
      diffView.value = { version, filePath, loading: false, diffs: [], error: error.message || '获取版本差异失败' };
    }
  }
}
function closeDiff() {
  ++diffRequest;
  diffView.value = null;
}
function diffLines(patch) {
  return String(patch || '').split('\n');
}
function lineClass(line) {
  if (line.startsWith('+++') || line.startsWith('---')) return 'diff-meta';
  if (line.startsWith('@@')) return 'diff-hunk';
  if (line.startsWith('+')) return 'diff-add';
  if (line.startsWith('-')) return 'diff-del';
  return '';
}

async function createSnapshot() {
  if (creating.value || !store.projectId) return;
  const { projectId, projectVersion } = store;
  const request = ++snapshotRequest;
  creating.value = true;
  try {
    await api.post('/api/projects/' + projectId + '/versions', { message: snapshotMsg.value.trim() });
    if (!isCurrent(projectId, projectVersion) || request !== snapshotRequest) return;
    snapshotOpen.value = false;
    snapshotMsg.value = '';
    ui.toast('快照已创建');
    await loadVersions();
  } catch (error) {
    if (isCurrent(projectId, projectVersion) && request === snapshotRequest) ui.error(error.message || '创建快照失败');
  } finally {
    if (isCurrent(projectId, projectVersion) && request === snapshotRequest) creating.value = false;
  }
}

async function doRestore() {
  const target = restoreTarget.value;
  if (!target || restoring.value) return;
  const { projectId, projectVersion } = store;
  const request = ++restoreRequest;
  restoring.value = true;
  try {
    await api.post('/api/projects/' + projectId + '/versions/' + target.id + '/restore');
    if (!isCurrent(projectId, projectVersion) || request !== restoreRequest) return;
    restoreTarget.value = null;
    await store.loadTree();
    if (!isCurrent(projectId, projectVersion) || request !== restoreRequest) return;
    // 保留已有恢复行为：关掉已删除文件的标签，协作房间由服务端重建。
    const paths = new Set();
    const walk = (nodes) => nodes.forEach((node) => {
      if (node.children) walk(node.children);
      else if (node.path) paths.add(node.path);
    });
    walk(store.tree || []);
    for (const file of [...store.openFiles]) if (!file.startsWith('_workspace/') && !paths.has(file)) store.closeFile(file);
    ui.toast('已恢复到 v' + (target.seq || target.id) + '，编辑器内容已同步');
    await loadVersions();
  } catch (error) {
    if (isCurrent(projectId, projectVersion) && request === restoreRequest) ui.error(error.message || '恢复失败');
  } finally {
    if (isCurrent(projectId, projectVersion) && request === restoreRequest) restoring.value = false;
  }
}

watch([() => store.projectId, () => store.projectVersion], () => {
  resetView();
  loadVersions();
}, { immediate: true });
// 编译成功自动快照后刷新；已有版本内容不可变，可以保留其详情缓存。
watch(() => store.versionsStamp, () => loadVersions());
onBeforeUnmount(() => {
  active = false;
  resetView();
});
</script>

<style scoped>
.versions-panel { padding: 12px; }
.panel-head { display: flex; align-items: center; margin-bottom: 12px; }
.grow { flex: 1; }
.btn-icon { margin-right: 4px; }
.empty { text-align: center; padding: 32px 0; font-size: 13px; }
.list-error, .diff-state { display: flex; align-items: center; gap: 8px; font-size: 13px; padding: 12px 0; }
.day-group { margin-bottom: 14px; }
.day-title { font-size: 11px; color: var(--fg-dim); letter-spacing: 0.5px; margin-bottom: 6px; }
.version-item { position: relative; background: var(--bg3); border: 1px solid var(--border); border-radius: 8px; margin-bottom: 6px; overflow: hidden; }
.version-summary { display: block; width: 100%; border: 0; background: none; color: inherit; padding: 8px 10px; font: inherit; text-align: left; cursor: pointer; }
.version-summary:hover, .v-menu:hover { background: var(--bg-hover); }
.version-summary:focus-visible, .v-menu:focus-visible, .file-view:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.v-line1 { display: flex; align-items: center; gap: 8px; padding-right: 22px; }
.v-chevron { color: var(--fg-dim); font-size: 18px; line-height: 16px; flex: none; transition: transform 120ms; }
.v-chevron.expanded { transform: rotate(90deg); }
.v-badge { background: var(--accent); color: var(--on-accent); font-size: 11px; border-radius: 4px; padding: 1px 6px; flex-shrink: 0; }
.v-msg { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
.v-menu { position: absolute; top: 5px; right: 6px; border: 0; background: none; cursor: pointer; color: var(--fg-dim); padding: 0 5px; border-radius: 4px; font-size: 18px; }
.v-line2 { display: flex; align-items: center; gap: 10px; margin-top: 4px; font-size: 12px; }
.adds { color: var(--accent); }
.dels { color: var(--danger); }
.version-files { border-top: 1px solid var(--border); padding: 5px 9px; }
.version-files ul { list-style: none; padding: 0; margin: 0; }
.version-file { display: flex; align-items: center; gap: 7px; padding: 5px 0; font-size: 12px; }
.files-empty { margin: 5px 0; font-size: 12px; }
.change-kind { flex: none; font-size: 10px; color: var(--fg-dim); }
.change-kind.added { color: var(--accent); }
.change-kind.removed { color: var(--danger); }
.file-path { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file-counts { display: inline-flex; gap: 5px; flex: none; font-size: 11px; }
.binary-mark { flex: none; color: var(--fg-dim); font-size: 10px; }
.file-view { flex: none; border: 0; border-radius: 3px; padding: 2px 4px; background: none; color: var(--blue, var(--accent)); cursor: pointer; font: inherit; }
.file-view:hover { background: var(--bg-hover); }
.diff-note { margin: 0 0 12px; font-size: 12px; }
.diff-file { margin-bottom: 14px; }
.diff-path { font-size: 12px; color: var(--blue); margin-bottom: 6px; overflow-wrap: anywhere; }
.binary-note { padding: 12px; border: 1px solid var(--border); border-radius: 6px; font-size: 13px; }
.diff-body { background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 8px 0; font-size: 12px; line-height: 1.5; max-height: 50vh; overflow: auto; }
.diff-body pre { margin: 0; padding: 0 10px; white-space: pre; font: inherit; min-width: max-content; }
.diff-add { background: rgba(38, 162, 105, 0.18); color: var(--accent); }
.diff-del { background: rgba(229, 83, 75, 0.15); color: var(--danger); }
.diff-hunk, .diff-meta { color: var(--blue); }

/* ---- visual refinement layer (presentation only) ---- */
.panel-head .el-button { letter-spacing: .01em; }
.empty { display: flex; flex-direction: column; align-items: center; gap: 8px; color: var(--fg-muted); letter-spacing: .01em; }
.empty-glyph { font-size: 24px; color: color-mix(in srgb, var(--accent) 45%, var(--fg-muted)); opacity: .8; }
.day-title { display: flex; align-items: center; gap: 7px; font-weight: 650; letter-spacing: .08em; color: var(--fg-muted); font-variant-numeric: tabular-nums; }
.day-title::before { content: ''; width: 5px; height: 5px; border-radius: 50%; background: color-mix(in srgb, var(--accent) 60%, var(--bg2)); flex: none; }
.version-item { background: var(--surface-muted); border-color: color-mix(in srgb, var(--border) 85%, var(--bg2)); border-radius: var(--radius-md); transition: border-color var(--motion-hover) var(--ease-standard), box-shadow var(--motion-hover) var(--ease-standard); }
.version-item:hover { border-color: color-mix(in srgb, var(--accent) 40%, var(--border)); box-shadow: var(--shadow-sm); }
.version-summary { transition: background-color var(--motion-hover) var(--ease-standard); }
.v-chevron { transition: transform var(--motion-hover) var(--ease-standard); }
.v-badge { background: var(--accent-soft); color: var(--accent-hover); border: 1px solid color-mix(in srgb, var(--accent) 22%, transparent); border-radius: 999px; font-weight: 650; padding: 1px 8px; font-variant-numeric: tabular-nums; }
.v-msg { font-weight: 550; }
.v-menu { border-radius: 6px; transition: background-color var(--motion-hover) var(--ease-standard), color var(--motion-hover) var(--ease-standard); }
.v-menu:hover { color: var(--fg); }
.v-line2 { font-variant-numeric: tabular-nums; }
.adds { color: var(--success); font-weight: 650; }
.dels { color: var(--danger); font-weight: 650; }
.version-files { border-top-color: color-mix(in srgb, var(--border) 70%, var(--bg2)); background: color-mix(in srgb, var(--bg2) 55%, transparent); }
.version-file { border-radius: 5px; transition: background-color var(--motion-hover) var(--ease-standard); }
.version-file:hover { background: var(--bg-hover); }
.change-kind { padding: 1px 7px; border-radius: 999px; background: var(--glass-inset); font-weight: 650; letter-spacing: .02em; }
.change-kind.added { color: color-mix(in srgb, var(--success) 80%, var(--fg)); background: var(--success-soft); }
.change-kind.removed { color: color-mix(in srgb, var(--danger) 82%, var(--fg)); background: var(--danger-soft); }
.change-kind.modified { color: var(--accent-hover); background: var(--accent-soft); }
.binary-mark { padding: 1px 6px; border-radius: 999px; background: var(--glass-inset); border: 1px solid color-mix(in srgb, var(--border) 70%, transparent); }
.file-view { border-radius: 5px; font-weight: 600; transition: background-color var(--motion-hover) var(--ease-standard), color var(--motion-hover) var(--ease-standard); }
.file-view:hover { color: var(--accent-hover); }
.diff-body { border-radius: var(--radius-sm); border-color: color-mix(in srgb, var(--border) 85%, var(--bg2)); scrollbar-width: thin; scrollbar-color: color-mix(in srgb, var(--fg-muted) 38%, transparent) transparent; }
.diff-add { background: var(--success-soft); color: color-mix(in srgb, var(--success) 78%, var(--fg)); }
.diff-del { background: var(--danger-soft); color: color-mix(in srgb, var(--danger) 82%, var(--fg)); }
.diff-hunk { background: color-mix(in srgb, var(--accent-soft) 65%, transparent); }
.diff-meta { color: var(--fg-muted); }
@media (prefers-reduced-motion: reduce) {
  .version-item, .version-summary, .v-chevron, .v-menu, .version-file, .file-view { transition: none; }
}
@media (forced-colors: active) {
  .empty-glyph { color: CanvasText; }
  .day-title::before { background: CanvasText; }
  .version-item:hover { box-shadow: none; }
}
</style>
