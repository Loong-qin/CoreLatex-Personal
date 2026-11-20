<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch, defineAsyncComponent } from 'vue';
import { useRouter } from 'vue-router';
import { api, fmtBytes, fmtSeconds, timeAgo } from '../api.js';
import { useAuthStore } from '../stores/auth.js';
import { setCollabUser } from '../lib/collabClient.js';
import { useUiStore } from '../stores/ui.js';
import { projectPath, navigateProjectLink } from '../lib/projectNavigation.js';
import { PROJECT_VIEWS, viewQuery, usagePercent, projectActions, formatTokens } from '../lib/projectUtils.js';
import { Setting, DataBoard, SwitchButton, Document, User, Clock, MoreFilled, Search, Plus, TopRight, FolderOpened, Share, Box, Delete, TrendCharts, Timer, MagicStick } from '@element-plus/icons-vue';
import BrandMark from '../components/BrandMark.vue';
import TokenUsageBreakdown from '../components/TokenUsageBreakdown.vue';
const StatsPanel = defineAsyncComponent(() => import('../components/StatsPanel.vue'));
const SettingsView = defineAsyncComponent(() => import('./SettingsView.vue'));
const AdminView = defineAsyncComponent(() => import('./AdminView.vue'));

const router = useRouter();
const auth = useAuthStore();
const ui = useUiStore();

const view = ref('all');
const q = ref('');
const projects = ref([]);
const loading = ref(false);

// 弹窗状态：'create' | 'rename' | 'share' | null
const modal = ref(null);
const active = ref(null); // 当前操作的项目
const busy = ref(false);

const createName = ref('');
const zipInput = ref(null);
const renameName = ref('');
const shareOwner = ref(null);
const shareMembers = ref([]);
const shareUsername = ref('');
const shareRole = ref('editor');

const ACTION_LABELS = {
  open: '打开',
  rename: '重命名',
  export: '导出 ZIP',
  share: '共享',
  archive: '归档',
  unarchive: '取消归档',
  delete: '删除',
  restore: '恢复',
  purge: '彻底删除',
};
const DANGER_ACTIONS = new Set(['delete', 'purge']);

// 导航图标（纯展示）
const NAV_ICONS = { all: FolderOpened, mine: User, shared: Share, archived: Box, trash: Delete };

const viewTitle = computed(() => PROJECT_VIEWS.find((v) => v.key === view.value)?.label || '');

// 项目显示模式：列表 / 卡片（记忆到本地）
const viewMode = ref(localStorage.getItem('corelatex.projectViewMode') || 'list');
watch(viewMode, (v) => localStorage.setItem('corelatex.projectViewMode', v));

// 左侧栏宽度：拖动手柄调整并记忆（180–420px）
const sidebarWidth = ref(Math.min(420, Math.max(180, Number(localStorage.getItem('corelatex.sidebarWidth')) || 230)));
let stopSideResize = () => {};
function startSideResize(e) {
  stopSideResize();
  e.preventDefault();
  const startX = e.clientX;
  const startW = sidebarWidth.value;
  const onMove = (ev) => {
    sidebarWidth.value = Math.min(420, Math.max(180, startW + ev.clientX - startX));
  };
  const onUp = () => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.removeEventListener('pointercancel', onUp);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    localStorage.setItem('corelatex.sidebarWidth', String(sidebarWidth.value));
  };
  stopSideResize = onUp;
  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
  document.addEventListener('pointercancel', onUp);
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
}

onBeforeUnmount(() => {
  disposed = true;
  clearTimeout(searchTimer);
  invalidateProjectLoad();
  usageController?.abort();
  stopSideResize();
});
function resizeSidebarByKey(e) {
  if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(e.key)) return;
  e.preventDefault();
  sidebarWidth.value = e.key === 'Home' ? 230 : Math.min(420, Math.max(180, sidebarWidth.value + (e.key === 'ArrowRight' ? 10 : -10)));
  localStorage.setItem('corelatex.sidebarWidth', String(sidebarWidth.value));
}

// 列表整行点击进入项目；点到操作按钮/链接时忽略
function onRowClick(row, _col, ev) {
  if (ev?.target?.closest?.('button, a')) return;
  if (view.value !== 'trash') openProject(row);
}

const createVisible = computed({
  get: () => modal.value === 'create',
  set: (v) => { modal.value = v ? 'create' : null; },
});
const renameVisible = computed({
  get: () => modal.value === 'rename',
  set: (v) => { modal.value = v ? 'rename' : null; },
});
const shareVisible = computed({
  get: () => modal.value === 'share',
  set: (v) => { modal.value = v ? 'share' : null; },
});

const projectPct = computed(() =>
  auth.usage ? usagePercent(auth.usage.projectCount, auth.usage.projectQuota) : null
);
const storagePct = computed(() =>
  auth.usage?.storageUsed != null ? usagePercent(auth.usage.storageUsed, auth.usage.storageQuota) : null
);
const compilePct = computed(() =>
  auth.usage ? usagePercent(auth.usage.compileSecondsUsed, auth.usage.compileSecondsQuota) : null
);

let projectLoad = null, loadGeneration = 0, usageController = null, disposed = false;
const sizesLoading = ref(false);
function invalidateProjectLoad() {
  loadGeneration++;
  projectLoad?.abort(); projectLoad = null;
  loading.value = false; sizesLoading.value = false;
}
function projectSize(row) {
  if (Number.isFinite(row.sizeBytes) && row.sizeBytes >= 0) return fmtBytes(row.sizeBytes);
  return sizesLoading.value ? '计算中…' : '—';
}
async function load() {
  invalidateProjectLoad();
  if (disposed || ['stats', 'settings', 'admin'].includes(view.value)) return;
  const controller = new AbortController(), generation = loadGeneration;
  projectLoad = controller;
  const current = () => !disposed && !controller.signal.aborted && generation === loadGeneration;
  const params = new URLSearchParams({ view: viewQuery(view.value) });
  if (q.value.trim()) params.set('q', q.value.trim());
  const summary = new URLSearchParams(params); summary.set('summary', '1');
  loading.value = true;
  try {
    const data = await api.get(`/api/projects?${summary}`, { signal: controller.signal });
    if (!current()) return;
    if (!Array.isArray(data?.projects)) throw new Error('项目列表格式无效');
    projects.value = data.projects;
    loading.value = false;
    // Preserve already returned sizes (e.g. cached/compatible server data).
    if (!data.projects.some(row => !Number.isFinite(row.sizeBytes))) return;
    sizesLoading.value = true;
    // The default endpoint computes exact sizes asynchronously. Its result only
    // fills size fields: it must never replace newer project metadata or rows.
    void api.get(`/api/projects?${params}`, { signal: controller.signal }).then(full => {
      if (!current() || !Array.isArray(full?.projects)) return;
      const sizes = new Map(full.projects.filter(row => Number.isFinite(row.sizeBytes) && row.sizeBytes >= 0)
        .map(row => [String(row.publicId || row.id), row.sizeBytes]));
      projects.value = projects.value.map(row => {
        const size = sizes.get(String(row.publicId || row.id));
        return size === undefined ? row : { ...row, sizeBytes: size };
      });
    }).catch(() => { /* A size failure must not hide the usable project list. */ })
      .finally(() => { if (current()) sizesLoading.value = false; });
  } catch (error) {
    if (current()) ui.error(error?.message || '加载项目列表失败');
  } finally { if (current()) loading.value = false; }
}
function refreshUsage() {
  usageController?.abort();
  const controller = new AbortController(); usageController = controller;
  Promise.resolve(auth.refreshUsage({ signal: controller.signal })).catch(() => {})
    .finally(() => { if (usageController === controller) usageController = null; });
}

let searchTimer;
watch(q, () => {
  clearTimeout(searchTimer);
  invalidateProjectLoad();
  searchTimer = setTimeout(load, 300);
});
watch(view, () => { clearTimeout(searchTimer); load(); });
watch(() => auth.user, (user) => {
  if (user) setCollabUser(user.displayName || user.username);
}, { immediate: true });

onMounted(() => {
  load();
  refreshUsage();
});

// 后端只认项目唯一哈希 publicId(数字自增编号不再解析,防枚举),所有操作接口统一走它
const pid = (p) => p.publicId || p.id;

function openProject(p) {
  if (view.value !== 'trash') router.push(projectPath(p));
}

async function runAction(fn, successMsg) {
  busy.value = true;
  try {
    await fn();
    modal.value = null;
    if (successMsg) ui.toast(successMsg);
    await load();
    refreshUsage();
  } catch (e) {
    ui.error(e.message || '操作失败');
  } finally {
    busy.value = false;
  }
}

function rowActions(p) {
  return projectActions(p, view.value);
}

function doAction(p, action) {
  active.value = p;
  switch (action) {
    case 'open': openProject(p); break;
    case 'rename':
      renameName.value = p.name;
      modal.value = 'rename';
      break;
    case 'share': openShare(p); break;
    case 'archive':
      runAction(() => api.post(`/api/projects/${pid(p)}/archive`), '已归档');
      break;
    case 'unarchive':
      runAction(() => api.post(`/api/projects/${pid(p)}/unarchive`), '已取消归档');
      break;
    case 'delete': confirmDelete(p); break;
    case 'restore':
      runAction(() => api.post(`/api/projects/${pid(p)}/restore`), '已恢复');
      break;
    case 'purge': confirmPurge(p); break;
    case 'export': exportZip(p); break;
  }
}

// 新建 / 导入
function openCreate() {
  createName.value = '';
  modal.value = 'create';
}
function createBlank() {
  const name = createName.value.trim();
  if (!name) return ui.error('请输入项目名称');
  runAction(() => api.post('/api/projects', { name }), '项目已创建');
}
function pickZip() {
  zipInput.value?.click();
}
async function onZipPicked(e) {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  const form = new FormData();
  form.append('file', file);
  const name = createName.value.trim();
  if (name) form.append('name', name);
  runAction(() => api.postForm('/api/projects/import', form), 'ZIP 已导入');
}

// 重命名
function submitRename() {
  const name = renameName.value.trim();
  if (!name) return ui.error('请输入项目名称');
  const p = active.value;
  runAction(() => api.patch(`/api/projects/${pid(p)}`, { name }), '已重命名');
}

// 删除 / 彻底删除
async function confirmDelete(p) {
  const ok = await ui.confirm(
    `确定将「${p.name}」移入回收站吗？之后可以从回收站恢复。`,
    '删除项目',
    { confirmText: '移入回收站', type: 'warning' }
  );
  if (!ok) return;
  runAction(() => api.post(`/api/projects/${pid(p)}/delete`), '已移入回收站');
}
async function confirmPurge(p) {
  const ok = await ui.confirm(
    `「${p.name}」将被永久删除，无法恢复。确定继续吗？`,
    '彻底删除项目',
    { confirmText: '永久删除', type: 'error' }
  );
  if (!ok) return;
  runAction(() => api.post(`/api/projects/${pid(p)}/purge`), '已彻底删除');
}

// 导出
async function exportZip(p) {
  try {
    const res = await api.raw(`/api/projects/${pid(p)}/export`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${p.name || 'project'}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    ui.toast('已开始下载');
  } catch (e) {
    ui.error(e.message || '导出失败');
  }
}

// 共享
async function openShare(p) {
  modal.value = 'share';
  shareOwner.value = null;
  shareMembers.value = [];
  shareUsername.value = '';
  shareRole.value = 'editor';
  try {
    const data = await api.get(`/api/projects/${pid(p)}/members`);
    shareOwner.value = data.owner || null;
    shareMembers.value = data.members || [];
  } catch (e) {
    ui.error(e.message || '加载成员失败');
  }
}
async function addMember() {
  const username = shareUsername.value.trim();
  if (!username) return ui.error('请输入用户名');
  const p = active.value;
  try {
    await api.post(`/api/projects/${pid(p)}/members`, { username, role: shareRole.value });
    shareUsername.value = '';
    ui.toast('已添加成员');
    openShare(p);
  } catch (e) {
    ui.error(e.message || '添加成员失败');
  }
}
async function removeMember(m) {
  const p = active.value;
  try {
    await api.del(`/api/projects/${pid(p)}/members/${m.userId}`);
    ui.toast('已移除成员');
    openShare(p);
  } catch (e) {
    ui.error(e.message || '移除成员失败');
  }
}

function logout() {
  auth.logout();
  router.push('/login');
}
</script>

<template>
  <div class="projects-page">
    <!-- 左侧边栏（宽度可拖动） -->
    <aside class="sidebar" :style="{ width: sidebarWidth + 'px' }">
      <div class="side-head">
        <a class="workspace-brand" href="/" @click.prevent="view = 'all'" aria-label="CoreLatex 项目首页"><BrandMark class="brand-mark" :size="36" aria-hidden="true" /><span>CoreLatex<small>论文工作台</small></span></a>
        <div class="head-btns">
          <el-tooltip content="设置" placement="bottom">
            <button class="icon-btn" aria-label="设置" :aria-pressed="view === 'settings'" :class="{ on: view === 'settings' }" @click="view = view === 'settings' ? 'all' : 'settings'"><el-icon><Setting /></el-icon></button>
          </el-tooltip>
          <el-tooltip v-if="auth.isAdmin" content="用户管理" placement="bottom">
            <button class="icon-btn" aria-label="用户管理" :aria-pressed="view === 'admin'" :class="{ on: view === 'admin' }" @click="view = view === 'admin' ? 'all' : 'admin'"><el-icon><DataBoard /></el-icon></button>
          </el-tooltip>
          <el-tooltip content="退出登录" placement="bottom">
            <button class="icon-btn danger" aria-label="退出登录" @click="logout"><el-icon><SwitchButton /></el-icon></button>
          </el-tooltip>
        </div>
      </div>
      <div class="user-name"><span class="user-avatar" aria-hidden="true">{{ (auth.user?.displayName || auth.user?.username || 'C').slice(0, 1).toUpperCase() }}</span><span>{{ auth.user?.displayName || auth.user?.username || '' }}</span></div>
      <nav class="side-nav" aria-label="项目导航">        <button
          v-for="v in PROJECT_VIEWS"
          :key="v.key"
          class="nav-item"
          :class="{ active: view === v.key }"
          :aria-current="view === v.key ? 'page' : undefined"
          @click="view = v.key"
        ><el-icon class="nav-icon" aria-hidden="true"><component :is="NAV_ICONS[v.key]" /></el-icon>{{ v.label }}</button>
        <button class="nav-item" :class="{ active: view === 'stats' }" title="查看完整数据统计" @click="view = 'stats'"><el-icon class="nav-icon" aria-hidden="true"><TrendCharts /></el-icon>数据统计</button>
      </nav>

      <el-divider />

      <el-card v-if="auth.usage" class="usage-card" shadow="never">
        <div class="usage-title"><el-icon aria-hidden="true"><TrendCharts /></el-icon>用量数据</div>
        <div class="usage-row">
          <span><el-icon aria-hidden="true"><Document /></el-icon>项目数</span>
          <span class="muted">{{ auth.usage.projectCount }} / {{ auth.usage.projectQuota < 0 ? '不限' : auth.usage.projectQuota }}</span>
        </div>
        <div class="usage-row">
          <span><el-icon aria-hidden="true"><Box /></el-icon>空间</span>
          <span class="muted">{{ auth.usage.storageUsed == null ? '计算中…' : fmtBytes(auth.usage.storageUsed) }} / {{ fmtBytes(auth.usage.storageQuota) }}</span>
        </div>
        <el-progress
          v-if="storagePct !== null"
          :percentage="storagePct"
          :status="storagePct >= 90 ? 'exception' : ''"
          :stroke-width="5"
          :show-text="false"
          class="usage-bar"
        />
        <div class="usage-row">
          <span><el-icon aria-hidden="true"><Timer /></el-icon>编译时长</span>
          <span class="muted">{{ fmtSeconds(auth.usage.compileSecondsUsed) }} / {{ fmtSeconds(auth.usage.compileSecondsQuota) }}</span>
        </div>
        <el-progress
          v-if="compilePct !== null"
          :percentage="compilePct"
          :status="compilePct >= 90 ? 'exception' : ''"
          :stroke-width="5"
          :show-text="false"
          class="usage-bar"
        />

        <template v-if="auth.usage.ai">
          <el-divider class="usage-divider" />
          <div class="usage-row usage-ai-total">
            <span><el-icon aria-hidden="true"><MagicStick /></el-icon>AI 使用</span>
            <span class="muted">总 Token <strong>{{ formatTokens(auth.usage.ai.totalTokens) }}</strong></span>
          </div>
          <div class="usage-ai-lines">
            <TokenUsageBreakdown :usage="auth.usage.ai" :show-cache-details="false" aria-label="AI Token 明细" />
            <div class="ai-line muted"><span class="ai-dot" style="background: var(--warn)" aria-hidden="true"></span>请求 {{ auth.usage.ai.requests }} 次</div>
          </div>
        </template>
      </el-card>
    </aside>
    <div class="side-resizer" role="separator" tabindex="0" aria-label="调整项目侧栏宽度" aria-orientation="vertical" :aria-valuenow="sidebarWidth" :aria-valuemin="180" :aria-valuemax="420" title="拖动或按方向键调整侧栏宽度" @pointerdown="startSideResize" @keydown="resizeSidebarByKey"></div>

    <!-- 主区 -->
    <main class="main">
      <StatsPanel v-if="view === 'stats'" />
      <AdminView v-else-if="view === 'admin'" embedded />
      <SettingsView v-else-if="view === 'settings'" embedded @navigate="(t) => (view = t)" />
      <template v-else>
      <header class="projects-heading"><div><span class="page-eyebrow">WORKSPACE</span><h1>{{ viewTitle }}<span class="project-count">{{ projects.length }}</span></h1><p>{{ q.trim() ? '按项目名称查找你的文稿' : '打开项目开始工作，可在编辑器内快速切换其他项目。' }}</p></div></header>
      <div class="toolbar">
        <el-input
          v-model="q"
          class="search"
          placeholder="搜索项目…"
          clearable
          :prefix-icon="Search"
          aria-label="搜索项目"
        />
        <div class="grow"></div>
        <el-radio-group v-model="viewMode" size="small" class="mode-toggle" aria-label="项目显示方式">
          <el-radio-button value="list">列表</el-radio-button>
          <el-radio-button value="card">卡片</el-radio-button>
        </el-radio-group>
        <el-button class="create-project" type="primary" :icon="Plus" @click="openCreate">新建项目</el-button>
      </div>

      <!-- 卡片视图 -->
      <div v-if="viewMode === 'card'" class="project-cards" v-loading="loading">
        <div v-for="row in projects" :key="row.id" class="proj-card" @click="openProject(row)">
          <div class="proj-card-head">
            <span class="proj-icon"><el-icon><Document /></el-icon></span>
            <span v-if="view === 'trash'" class="proj-card-title">{{ row.name }}</span>
            <a v-else class="proj-card-title" :href="projectPath(row)" @click.stop="navigateProjectLink($event, row, router)">{{ row.name }}</a>
            <el-tag v-if="row.archived && view !== 'archived'" size="small" type="info">已归档</el-tag>
            <el-dropdown
              class="proj-more"
              trigger="click"
              @command="(cmd) => doAction(row, cmd)"
            >
              <button type="button" class="proj-more-btn" :aria-label="`更多操作：${row.name}`" title="更多操作" @click.stop>
                <el-icon><MoreFilled /></el-icon>
              </button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item
                    v-for="a in rowActions(row)"
                    :key="a"
                    :command="a"
                    :style="DANGER_ACTIONS.has(a) ? 'color: var(--danger, #f56c6c)' : ''"
                  >{{ ACTION_LABELS[a] }}</el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </div>
          <div class="proj-card-meta muted">
            <span class="meta-item"><el-icon><User /></el-icon>{{ row.ownerName }}</span>
            <span class="meta-item"><el-icon><Clock /></el-icon>{{ timeAgo(row.updatedAt) }}</span>
            <span class="meta-item"><el-icon><Document /></el-icon>{{ projectSize(row) }}</span>
          </div>
          <a v-if="view !== 'trash'" class="project-new-tab card-new-tab" :href="projectPath(row)" target="_blank" rel="noopener" :aria-label="`在新标签页打开：${row.name}`" title="可选：在新标签页打开" @click.stop>另开标签页<el-icon aria-hidden="true"><TopRight /></el-icon></a>
        </div>
        <div v-if="!loading && !projects.length" class="empty muted card-empty">
          <el-icon class="empty-icon" aria-hidden="true"><component :is="q.trim() ? Search : FolderOpened" /></el-icon>
          <template v-if="q.trim()">没有匹配「{{ q.trim() }}」的项目</template>
          <template v-else>还没有项目，点击右上角「新建项目」开始吧</template>
        </div>
      </div>

      <!-- 列表视图 -->
      <el-table
        v-else
        v-loading="loading"
        :data="projects"
        class="project-table clickable"
        row-key="id"
        @row-click="onRowClick"
      >
        <el-table-column label="标题" min-width="220">
          <template #default="{ row }">
            <span v-if="view === 'trash'" class="proj-link">{{ row.name }}</span>
            <a v-else class="proj-link" @click="navigateProjectLink($event, row, router)" :href="projectPath(row)">{{ row.name }}</a>
            <el-tag v-if="row.archived && view !== 'archived'" size="small" type="info" class="row-tag">已归档</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="ownerName" label="拥有者" width="140" />
        <el-table-column label="大小" width="110">
          <template #default="{ row }">
            <span class="muted">{{ projectSize(row) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="最近修改" width="130">
          <template #default="{ row }">
            <span class="muted">{{ timeAgo(row.updatedAt) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="108" align="right" fixed="right">
          <template #default="{ row }">
            <div class="table-project-actions">
            <a v-if="view !== 'trash'" class="project-new-tab table-new-tab" :href="projectPath(row)" target="_blank" rel="noopener" :aria-label="`在新标签页打开：${row.name}`" title="可选：在新标签页打开" @click.stop><el-icon aria-hidden="true"><TopRight /></el-icon></a>
            <el-dropdown trigger="click" :disabled="busy" @command="(cmd) => doAction(row, cmd)">
              <button type="button" class="proj-more-btn table-more" :aria-label="`更多操作：${row.name}`" :disabled="busy" @click.stop><el-icon><MoreFilled /></el-icon></button>
              <template #dropdown><el-dropdown-menu>
                <el-dropdown-item v-for="a in rowActions(row)" :key="a" :command="a" :style="DANGER_ACTIONS.has(a) ? 'color: var(--danger)' : ''">{{ ACTION_LABELS[a] }}</el-dropdown-item>
              </el-dropdown-menu></template>
            </el-dropdown>
            </div>
          </template>
        </el-table-column>
        <template #empty>
          <div class="empty muted">
            <el-icon class="empty-icon" aria-hidden="true"><component :is="q.trim() ? Search : FolderOpened" /></el-icon>
            <template v-if="q.trim()">没有匹配「{{ q.trim() }}」的项目</template>
            <template v-else-if="view === 'trash'">回收站是空的</template>
            <template v-else-if="view === 'shared'">还没有人与你共享项目</template>
            <template v-else-if="view === 'archived'">没有已归档的项目</template>
            <template v-else>还没有项目，点击右上角「新建项目」开始吧</template>
          </div>
        </template>
      </el-table>
      </template>
    </main>

    <!-- 新建项目弹窗 -->
    <el-dialog v-model="createVisible" title="新建项目" width="420px">
      <el-form label-position="top" @submit.prevent>
        <el-form-item label="项目名称">
          <el-input v-model="createName" placeholder="我的论文" @keyup.enter="createBlank" />
        </el-form-item>
      </el-form>
      <p class="muted hint">上传 ZIP 时将导入压缩包内的 LaTeX 项目文件。</p>
      <input ref="zipInput" type="file" accept=".zip" hidden @change="onZipPicked" />
      <template #footer>
        <el-button type="primary" :loading="busy" @click="createBlank">空白创建</el-button>
        <el-button :disabled="busy" @click="pickZip">上传 ZIP</el-button>
        <el-button text @click="modal = null">取消</el-button>
      </template>
    </el-dialog>

    <!-- 重命名弹窗 -->
    <el-dialog v-model="renameVisible" title="重命名项目" width="420px">
      <el-form label-position="top" @submit.prevent>
        <el-form-item label="新名称">
          <el-input v-model="renameName" @keyup.enter="submitRename" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button type="primary" :loading="busy" @click="submitRename">确定</el-button>
        <el-button text @click="modal = null">取消</el-button>
      </template>
    </el-dialog>

    <!-- 共享弹窗 -->
    <el-dialog v-model="shareVisible" :title="`共享「${active?.name}」`" width="520px">
      <div class="member-list">
        <div class="member-row" v-if="shareOwner">
          <span class="member-avatar" aria-hidden="true">{{ (shareOwner.displayName || shareOwner.username || '?').slice(0, 1).toUpperCase() }}</span>
          <span class="grow">{{ shareOwner.displayName || shareOwner.username }}
            <span class="muted">@{{ shareOwner.username }}</span>
          </span>
          <el-tag size="small" type="success">拥有者</el-tag>
        </div>
        <div class="member-row" v-for="m in shareMembers" :key="m.userId">
          <span class="member-avatar" aria-hidden="true">{{ (m.displayName || m.username || '?').slice(0, 1).toUpperCase() }}</span>
          <span class="grow">{{ m.displayName || m.username }}
            <span class="muted">@{{ m.username }}</span>
          </span>
          <el-tag size="small" :type="m.role === 'editor' ? 'primary' : 'info'">
            {{ m.role === 'editor' ? '可编辑' : '只读' }}
          </el-tag>
          <el-button link type="danger" size="small" @click="removeMember(m)">移除</el-button>
        </div>
        <div v-if="shareMembers.length === 0" class="muted empty-members">暂无共享成员</div>
      </div>
      <el-form label-position="top" @submit.prevent>
        <el-form-item label="按用户名添加成员">
          <div class="flex gap8 add-member-row">
            <el-input v-model="shareUsername" class="grow" placeholder="用户名" @keyup.enter="addMember" />
            <el-select v-model="shareRole" class="role-select">
              <el-option value="editor" label="可编辑" />
              <el-option value="viewer" label="只读" />
            </el-select>
            <el-button type="primary" @click="addMember">添加</el-button>
          </div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button text @click="modal = null">关闭</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.project-new-tab { display: inline-flex; align-items: center; gap: 5px; color: var(--fg-dim); text-decoration: none; font-size: 11px; border-radius: 6px; }
.project-new-tab:hover { color: var(--accent); background: var(--accent-soft); }.card-new-tab { margin: 13px 0 -3px; padding: 4px 6px; }.table-project-actions { display: flex; justify-content: flex-end; align-items: center; gap: 5px; }.table-new-tab { width: 28px; height: 28px; justify-content: center; font-size: 15px; }

.projects-page{display:flex;height:100%;min-height:0;background:transparent}
.sidebar{min-width:180px;flex-shrink:0;background:var(--bg2);border-right:1px solid var(--border);display:flex;flex-direction:column;padding:24px 16px 18px;overflow-y:auto}
.side-head{display:flex;flex-direction:column;align-items:stretch;gap:20px;padding:0 8px}.workspace-brand{display:flex;align-items:center;gap:11px;color:var(--fg);text-decoration:none;font-size:17px;font-weight:700;letter-spacing:-.5px}.workspace-brand small{display:block;color:var(--fg-dim);font-size:10px;font-weight:500;letter-spacing:1.5px;margin-top:4px}.brand-mark{display:grid;place-items:center;position:relative;width:36px;height:38px;border:1px solid color-mix(in srgb,var(--accent) 35%,var(--border));border-radius:10px;background:var(--accent-soft);color:var(--accent);font-family:Georgia,serif;font-size:26px;font-weight:500}.brand-mark span{position:absolute;font-size:16px;bottom:1px;right:5px}.head-btns{display:flex;gap:6px;padding-bottom:14px;border-bottom:1px solid var(--border)}.icon-btn{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--fg-dim);cursor:pointer;font-size:16px}.icon-btn:hover,.icon-btn.on{background:var(--accent-soft);color:var(--accent)}.icon-btn.danger:hover{background:color-mix(in srgb,var(--danger) 10%,transparent);color:var(--danger)}.user-name{display:flex;align-items:center;gap:9px;min-width:0;padding:16px 8px 12px;font-size:12px;color:var(--fg-dim)}.user-name>span:last-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.user-avatar{display:grid;place-items:center;flex:none;width:26px;height:26px;background:var(--surface-muted,var(--bg-hover));border:1px solid var(--border);border-radius:50%;font-size:11px;font-weight:600}.side-nav{display:flex;flex-direction:column;gap:5px;margin-top:6px}.nav-item{text-align:left;background:transparent;border:1px solid transparent;border-radius:9px;padding:10px 12px;color:var(--fg-dim);width:100%;font-size:13px}.nav-item:hover{background:var(--bg-hover);color:var(--fg)}.nav-item.active{background:var(--accent-soft);color:var(--accent);border-color:color-mix(in srgb,var(--accent) 18%,transparent);font-weight:600}.sidebar>.el-divider{margin:22px 0 18px}.usage-card{font-size:11px;--el-card-padding:13px;background:var(--surface-muted,var(--bg));border-radius:10px}.usage-title{font-size:11px;letter-spacing:.8px;font-weight:600;margin-bottom:13px;color:var(--fg-dim)}.usage-row{display:flex;justify-content:space-between;gap:10px;margin-bottom:9px}.usage-row>span:last-child{text-align:right}.usage-bar{margin:2px 0 12px}.usage-divider{margin:13px 0}.usage-ai-lines{font-size:10px;display:flex;flex-direction:column;gap:5px;margin:3px 0}.ai-line{display:flex;align-items:center;gap:6px}.ai-dot{width:5px;height:5px;border-radius:50%;flex-shrink:0}.side-resizer{width:5px;flex-shrink:0;cursor:col-resize;background:transparent;touch-action:none}.side-resizer:hover,.side-resizer:focus-visible{background:var(--accent)}
.main{flex:1;display:flex;flex-direction:column;min-width:0;padding:36px clamp(20px,3vw,52px);overflow:auto;container-type:inline-size}.projects-heading{display:flex;align-items:center;justify-content:space-between;margin:0 0 26px}.page-eyebrow{font-size:10px;color:var(--accent);font-weight:650;letter-spacing:1.7px}.projects-heading h1{display:flex;align-items:center;gap:12px;margin:8px 0;font-size:27px;font-weight:650;letter-spacing:-.5px}.project-count{display:inline-flex;align-items:center;justify-content:center;min-width:27px;height:23px;padding:0 7px;border:1px solid var(--border);border-radius:6px;background:var(--bg2);color:var(--fg-dim);font-size:11px;font-weight:500;letter-spacing:0}.projects-heading p{margin:0;font-size:12px;color:var(--fg-dim);line-height:1.7}.toolbar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:20px}.search{width:min(320px,100%)}.grow{flex:1}.mode-toggle{flex:none}.create-project{flex:none}.mode-toggle :deep(.el-radio-button__inner){font-size:12px;padding:8px 12px}.project-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,270px),1fr));gap:18px;align-content:start;flex:1;min-height:0}.proj-card{position:relative;overflow:hidden;border:1px solid var(--border);border-radius:var(--radius-lg,14px);background:var(--surface-raised,var(--bg2));padding:22px 20px;cursor:pointer;display:flex;flex-direction:column;gap:25px;transition:border-color .15s,box-shadow .15s}.proj-card:hover,.proj-card:focus-within{border-color:color-mix(in srgb,var(--accent) 55%,var(--border));box-shadow:var(--shadow-sm)}.proj-card-head{display:flex;align-items:center;gap:12px;min-width:0}.proj-icon{width:39px;height:44px;border:1px solid color-mix(in srgb,var(--accent) 20%,var(--border));border-radius:8px;flex:none;display:grid;place-items:center;background:var(--accent-soft);color:var(--accent);font-size:20px}.proj-card-title{color:var(--fg);font-weight:600;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-decoration:none}.proj-card-title:hover{color:var(--accent)}.proj-card-meta{display:flex;flex-wrap:wrap;gap:10px 16px;font-size:11px}.meta-item{display:flex;align-items:center;gap:6px}.meta-item:first-child{width:100%}.meta-item .el-icon{font-size:12px;color:var(--fg-dim)}.proj-more{margin-left:auto;flex-shrink:0}.proj-more-btn{width:28px;height:28px;border:1px solid transparent;border-radius:7px;display:flex;align-items:center;justify-content:center;background:transparent;color:var(--fg-dim);font-size:16px;cursor:pointer}.proj-more-btn:hover{background:var(--bg-hover);color:var(--fg)}.table-more{margin-left:auto}.card-empty{grid-column:1/-1}.project-table{flex:1;border:1px solid var(--border);border-radius:var(--radius-lg,14px);overflow:hidden;--el-table-border-color:var(--border);--el-table-header-text-color:var(--fg-dim);--el-table-row-hover-bg-color:var(--bg-hover)}.project-table :deep(th.el-table__cell){background:var(--surface-muted,var(--bg2));font-size:11px;font-weight:500;padding:13px 0}.project-table :deep(td.el-table__cell){padding:18px 0;font-size:12px}.project-table :deep(.cell){padding-left:20px;padding-right:20px}.project-table :deep(.el-table__row){cursor:pointer}.proj-link{color:var(--fg);cursor:pointer;font-size:13px;font-weight:550;text-decoration:none}.proj-link:hover{color:var(--accent)}.row-tag{margin-left:8px}.empty{text-align:center;padding:72px 16px;font-size:13px;line-height:1.8}.hint{font-size:12px;margin:0 0 4px}.member-list{border:1px solid var(--border);border-radius:10px;margin-bottom:14px;max-height:220px;overflow:auto}.member-row{display:flex;align-items:center;gap:10px;padding:12px;border-bottom:1px solid var(--border);overflow-wrap:anywhere}.member-row:last-child{border-bottom:none}.empty-members{padding:18px;text-align:center;font-size:12px}.add-member-row{width:100%;flex-wrap:wrap}.role-select{width:110px;flex-shrink:0}.icon-btn:focus-visible,.nav-item:focus-visible,.proj-more-btn:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
@container(max-width:600px){.toolbar{gap:10px}.search{width:100%;order:-1}.toolbar .grow{display:none}.create-project{margin-left:auto}.projects-heading h1{font-size:23px}.project-table :deep(.cell){padding-left:12px;padding-right:12px}}
@media(max-width:760px){.projects-page{flex-direction:column}.sidebar{width:100%!important;min-width:0;max-height:none;overflow:visible;padding:14px 16px 0;border-right:none;border-bottom:1px solid var(--border)}.side-head{flex-direction:row;align-items:center;justify-content:space-between;gap:12px;padding:0}.workspace-brand{font-size:15px}.workspace-brand small{display:none}.brand-mark{width:28px;height:30px;font-size:21px;border-radius:7px}.brand-mark span{font-size:12px;right:4px}.head-btns{padding:0;border:0;gap:3px}.user-name,.usage-card,.sidebar>.el-divider{display:none}.side-nav{flex-direction:row;overflow:auto;gap:4px;margin-top:14px;padding-bottom:10px;scrollbar-width:thin}.nav-item{width:auto;white-space:nowrap;padding:8px 10px;font-size:12px}.side-resizer{display:none}.main{padding:24px 18px;min-height:0}.projects-heading{margin-bottom:22px}.project-cards{gap:12px}.proj-card{padding:18px}.add-member-row>.grow{flex-basis:100%}}

/* Workspace refinement: stronger hierarchy with quiet, actionable surfaces. */
.sidebar { background: var(--glass-g2-bg); border-color: var(--glass-edge); padding-top: 26px; box-shadow: var(--glass-highlight); -webkit-backdrop-filter: var(--glass-g2-filter); backdrop-filter: var(--glass-g2-filter); }
.workspace-brand { letter-spacing: -.025em; }
.brand-mark { border-radius: 9px; box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 7%, transparent); }
.nav-item { position: relative; font-weight: 500; transition: transform var(--motion-menu) var(--ease-standard), opacity var(--motion-menu) var(--ease-standard); }
.nav-item:hover { transform: translateX(2px); }
.nav-item.active { font-weight: 650; }
.nav-item.active::before { content: ''; position: absolute; left: 5px; top: 50%; width: 2px; height: 14px; border-radius: 2px; background: var(--accent); transform: translateY(-50%); }
.main { padding-top: clamp(28px, 3vw, 44px); }
.projects-heading { padding-bottom: 24px; margin-bottom: 24px; border-bottom: 1px solid var(--border); }
.page-eyebrow { letter-spacing: .18em; }
.projects-heading h1 { font-size: clamp(25px, 2.2vw, 31px); letter-spacing: -.035em; }
.project-count { font-variant-numeric: tabular-nums; border-radius: 999px; }
.toolbar { padding: 2px 0 4px; }
.search :deep(.el-input__wrapper) { background: var(--glass-inset); }
.project-cards { gap: 16px; flex: 0 0 auto; }
.proj-card {
  border-radius: 13px;
  background: var(--glass-g1-bg);
  border-color: var(--glass-edge);
  box-shadow: var(--glass-shadow);
  -webkit-backdrop-filter: var(--glass-g1-filter);
  backdrop-filter: var(--glass-g1-filter);
  transition: transform var(--motion-hover) var(--ease-standard), opacity var(--motion-hover) var(--ease-standard);
}
.proj-card:hover, .proj-card:focus-within { transform: translateY(-2px); box-shadow: var(--shadow-md); }
.proj-icon { border-radius: 7px 7px 10px 7px; }
.proj-card-title { font-size: 15px; letter-spacing: -.015em; }
.project-table { border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
.project-table { background: var(--surface-raised); border-color: var(--border); box-shadow: var(--shadow-sm); -webkit-backdrop-filter: none; backdrop-filter: none; }
.project-table :deep(.el-table) { background: transparent; }
.usage-card { background: var(--glass-inset); border: 1px solid var(--border); -webkit-backdrop-filter: none; backdrop-filter: none; }
@media(max-width:760px) {
  .sidebar { background: var(--glass-g2-bg); }
  .nav-item:hover { transform: none; }
  .nav-item.active::before { display: none; }
  .projects-heading { padding-bottom: 18px; margin-bottom: 20px; }
  .proj-card:hover, .proj-card:focus-within { transform: none; }
}
@media(prefers-reduced-motion:reduce) {
  .nav-item:hover, .proj-card:hover, .proj-card:focus-within { transform: none; }
}

/* One content plane, with soft sage cues for navigation and project identity. */
.sidebar { background: color-mix(in srgb, var(--bg2) 92%, transparent); border-color: var(--border); box-shadow: none; backdrop-filter: none; -webkit-backdrop-filter: none; }
.brand-mark, .proj-icon { color: var(--accent); background: var(--accent-soft); border-color: color-mix(in srgb, var(--accent) 18%, var(--border)); box-shadow: none; }
.brand-mark { background: linear-gradient(145deg, var(--surface-raised), var(--accent-soft)); }
.user-avatar { color: var(--accent-hover); background: var(--accent-soft); border-color: color-mix(in srgb, var(--accent) 12%, var(--border)); }
.nav-item { transition: background-color var(--motion-menu) var(--ease-standard), color var(--motion-menu) var(--ease-standard), transform var(--motion-menu) var(--ease-standard); }
.nav-item.active { color: var(--accent-hover); background: var(--accent-soft); border-color: color-mix(in srgb, var(--accent) 9%, transparent); }
.nav-item.active::before { background: var(--accent); }
.page-eyebrow { color: var(--accent); }
.projects-heading { border-bottom-color: color-mix(in srgb, var(--border) 76%, transparent); }
.project-count { background: var(--surface-raised); border-color: var(--border); }
.search :deep(.el-input__wrapper) { background: color-mix(in srgb, var(--surface-raised) 72%, transparent); box-shadow: 0 0 0 1px var(--border) inset; }
.search :deep(.el-input__wrapper.is-focus) { background: var(--surface-raised); }
.create-project { border-radius: 9px; box-shadow: 0 5px 14px color-mix(in srgb, var(--accent) 15%, transparent); }
.proj-card { box-shadow: var(--glass-shadow); border-color: var(--glass-edge); }
.proj-card:hover, .proj-card:focus-within { transform: translateY(-2px); box-shadow: var(--shadow-md); border-color: color-mix(in srgb, var(--accent) 34%, var(--border)); }
.project-table { border-color: var(--glass-edge); box-shadow: var(--shadow-sm); }
.usage-card { background: color-mix(in srgb, var(--surface-muted) 58%, transparent); border-color: color-mix(in srgb, var(--border) 72%, transparent); box-shadow: none; }
@media (max-width: 760px) {
  .proj-card:hover, .proj-card:focus-within { transform: none; }
}
@media (prefers-reduced-motion: reduce) {
  .proj-card:hover, .proj-card:focus-within { transform: none; }
}

/* 品牌标志：SVG 自带纸感底与描边，外层只做尺寸与投影 */
.brand-mark { width: 36px; height: 36px; border: none; background: none; box-shadow: none; font-size: 0; display: grid; place-items: center; flex: none; filter: drop-shadow(0 3px 8px color-mix(in srgb, var(--accent) 14%, transparent)); }
.brand-mark svg { width: 100%; height: 100%; }
@media (max-width: 760px) {
  .brand-mark { width: 28px; height: 28px; border-radius: 0; }
}

/* Visual refinement: iconified navigation, quieter usage panel, richer cards. */
.nav-item { display: flex; align-items: center; gap: 9px; }
.nav-icon { font-size: 15px; flex: none; opacity: .72; transition: opacity var(--motion-menu) var(--ease-standard); }
.nav-item:hover .nav-icon, .nav-item.active .nav-icon { opacity: 1; }
.user-avatar { box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 6%, transparent); }
.usage-title { display: flex; align-items: center; gap: 6px; letter-spacing: .06em; }
.usage-title .el-icon { font-size: 13px; color: var(--accent); }
.usage-row > span:first-child { display: inline-flex; align-items: center; gap: 6px; }
.usage-row > span:first-child .el-icon { font-size: 12px; color: var(--fg-muted); }
.usage-ai-total { flex-wrap: wrap; row-gap: 3px; }
.usage-ai-total > span:last-child { margin-inline-start: auto; font-variant-numeric: tabular-nums; }
.usage-ai-total strong { display: inline-block; white-space: nowrap; }
.usage-card { border-radius: 12px; }
.usage-bar :deep(.el-progress-bar__outer) { background: color-mix(in srgb, var(--border) 60%, transparent); }
.proj-icon { background: linear-gradient(150deg, var(--surface-raised), var(--accent-soft)); box-shadow: inset 0 1px 0 color-mix(in srgb, var(--surface-raised) 70%, transparent); }
.proj-card::after { content: ''; position: absolute; inset: 0 0 auto; height: 2px; background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--accent) 45%, transparent), transparent); opacity: 0; transition: opacity var(--motion-surface) var(--ease-standard); pointer-events: none; }
.proj-card:hover::after, .proj-card:focus-within::after { opacity: 1; }
.proj-card-meta .el-icon { opacity: .8; }
.card-new-tab { opacity: .75; transition: opacity var(--motion-hover) var(--ease-standard); }
.proj-card:hover .card-new-tab, .proj-card:focus-within .card-new-tab { opacity: 1; }
.empty { display: flex; flex-direction: column; align-items: center; gap: 2px; }
.empty-icon { font-size: 36px; margin-bottom: 12px; color: color-mix(in srgb, var(--accent) 38%, var(--border)); }
.member-avatar { display: grid; place-items: center; flex: none; width: 28px; height: 28px; border-radius: 50%; background: var(--accent-soft); border: 1px solid color-mix(in srgb, var(--accent) 14%, var(--border)); color: var(--accent-hover); font-size: 12px; font-weight: 650; }
.member-row { transition: background-color var(--motion-hover) var(--ease-standard); }
.member-row:hover { background: var(--glass-inset); }
.project-table :deep(td.el-table__cell) { transition: background-color var(--motion-hover) var(--ease-standard); }
.page-eyebrow { display: inline-flex; align-items: center; gap: 7px; }
.page-eyebrow::before { content: ''; width: 14px; height: 2px; border-radius: 2px; background: var(--accent); opacity: .55; }
@media (prefers-reduced-motion: reduce) {
  .proj-card::after { transition: none; }
}

</style>
