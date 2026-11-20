<template>
  <div class="editor-page" :class="{ 'compact-workbench': layout.rightOverlay }">
    <!-- 顶栏 -->
    <header class="topbar">
      <button class="ghost" title="返回项目列表" @click="goBack"><el-icon><Back /></el-icon></button>
      <el-icon class="proj-name-icon" aria-hidden="true"><Document /></el-icon>
      <span class="proj-name" :title="store.project?.name">{{ store.project?.name || '加载中…' }}</span>
      <span v-if="store.project?.archived" class="badge warn" title="已归档（只读）"><span class="badge-full">已归档（只读）</span><span class="badge-short">归档·只读</span></span>
      <span v-else-if="store.myRole === 'viewer'" class="badge" title="只读成员"><span class="badge-full">只读成员</span><span class="badge-short">只读</span></span>
      <!-- 协作信息：在线协作者头像 + 在线人数 + 共享编辑人数 -->
      <span
        class="collab-chip"
        :title="collabTitle"
      >
        <span class="avatar-stack">
          <span
            v-for="(u, i) in displayUsers"
            :key="i"
            class="avatar-dot"
            :style="{ background: u.color || 'var(--accent)' }"
          >{{ initialOf(u.name) }}</span>
        </span>
        <span class="collab-text">
          <b>{{ store.onlineUsers.length }}</b> 在线
          <template v-if="store.memberCount > 1"><span class="shared-detail"> · {{ store.memberCount }} 人共享</span></template>
        </span>
      </span>
      <div class="grow"></div>
      <div class="layout-actions" aria-label="布局控制">
        <button class="ghost icon-btn focus-toggle" :class="{ active: focusMode }" :aria-pressed="focusMode" :disabled="fullscreenPending" :title="focusMode ? '退出全屏专注（Esc）' : '全屏专注（Ctrl/Cmd + Shift + F）'" @click="toggleFocus">
          <el-icon><FullScreen /></el-icon><span>{{ focusMode ? '退出全屏' : '专注' }}</span>
        </button>
        <button class="ghost icon-btn reset-layout" title="恢复默认布局" aria-label="恢复默认布局" @click="resetLayout"><el-icon><RefreshLeft /></el-icon></button>
      </div>
      <span class="topbar-divider" aria-hidden="true"></span>
      <button
        class="ghost icon-btn" :class="{ active: rightShown && store.rightTab === 'pdf' }" :aria-pressed="rightShown && store.rightTab === 'pdf'"
        title="PDF 预览" aria-label="PDF 预览" @click="toggleRight('pdf', $event)"
      ><el-icon><Document /></el-icon></button>
      <button
        v-for="t in rightTabs" :key="t.key"
        class="ghost icon-btn" :class="{ active: rightShown && store.rightTab === t.key }" :aria-pressed="rightShown && store.rightTab === t.key"
        :title="t.label" :aria-label="t.label" @click="toggleRight(t.key, $event)"
      ><el-icon><component :is="t.icon" /></el-icon></button>
    </header>

    <div ref="rowEl" class="main-row" :style="{ '--rail-width': layout.railWidth + 'px' }">
      <!-- 左图标轨 -->
      <nav class="icon-rail" aria-label="项目面板">
        <button
          v-for="p in railPanels" :key="p.key"
          class="rail-btn" :class="{ active: sideShown && store.sidebar === p.key }" :aria-pressed="sideShown && store.sidebar === p.key"
          :title="p.label" :aria-label="p.label" @click="toggleSidebar(p.key, $event)"
        >
          <el-icon class="rail-icon"><component :is="p.icon" /></el-icon>
        </button>
        <section v-if="workspace" class="rail-workspaces" aria-label="项目工作区区域">
          <ProjectSwitcher compact :project="store.project" :workspace-projects="workspaceProjects" />
          <ProjectWorkspaceTabs vertical :projects="workspaceProjects" :active-project-id="activeWorkspaceId" @activate="workspace.activateProject" @close="workspace.closeProject" />
        </section>
      </nav>

      <button v-if="overlayVisible" class="panel-backdrop" aria-label="关闭侧面板" @click="closeOverlay"></button>

      <!-- 左面板：宽度只由拖动分隔条决定，Ctrl+滚轮只缩放内部内容 -->
      <aside
        v-show="sideShown"
        id="editor-side-panel" tabindex="-1" :aria-label="activeSideLabel"
        class="side-panel"
        :class="{ 'overlay-panel': layout.sideOverlay }"
        :style="{ width: layout.sideWidth + 'px', flexBasis: layout.sideWidth + 'px' }"
        @wheel="onSideWheel"
      >
        <div v-if="store.sidebar !== 'agent'" class="side-heading"><span>{{ activeSideLabel }}</span><button class="ghost" title="关闭面板" aria-label="关闭左侧面板" @click="closeSidebar"><el-icon><Close /></el-icon></button></div>
        <!-- The scaled body fills only the space below the heading. -->
        <div class="side-viewport">
          <div class="side-body" :style="sideBodyStyle">
            <div v-if="visitedPanels.has('tree')" v-show="store.sidebar === 'tree'" class="tree-panel-cache">
              <div class="pane" :style="{ flexBasis: sideTopPct + '%' }"><FileTree :active="projectActive && sideShown && store.sidebar === 'tree'" /></div>
              <div class="h-splitter" role="separator" tabindex="0" aria-orientation="horizontal" aria-label="文件树与工作空间高度" :aria-valuenow="Math.round(sideTopPct)" aria-valuemin="0" aria-valuemax="100" title="拖动或上下方向键调整高度，双击恢复默认" @pointerdown="startVDrag($event, 'top')" @keydown="onPaneKey($event, 'top')" @dblclick="resetSidePanes"></div>
              <div class="pane" :style="{ flexBasis: sideMidPct + '%' }"><WorkspacePanel :active="projectActive && sideShown && store.sidebar === 'tree'" /></div>
              <div class="h-splitter" role="separator" tabindex="0" aria-orientation="horizontal" aria-label="工作空间与大纲高度" :aria-valuenow="Math.round(sideTopPct + sideMidPct)" aria-valuemin="0" aria-valuemax="100" title="拖动或上下方向键调整高度，双击恢复默认" @pointerdown="startVDrag($event, 'mid')" @keydown="onPaneKey($event, 'mid')" @dblclick="resetSidePanes"></div>
              <div class="pane" :style="{ flexBasis: 100 - sideTopPct - sideMidPct + '%' }"><OutlinePanel /></div>
            </div>
            <SearchPanel v-if="visitedPanels.has('search')" v-show="store.sidebar === 'search'" :active="projectActive && sideShown && store.sidebar === 'search'" />
            <ReviewPanel v-if="visitedPanels.has('review')" v-show="store.sidebar === 'review'" :active="projectActive && sideShown && store.sidebar === 'review'" />
            <AgentPanel v-if="visitedPanels.has('agent')" v-show="store.sidebar === 'agent'" @close="closeSidebar" />
          </div>
        </div>
      </aside>

      <!-- 左侧栏宽度分隔条 -->
      <div
        v-if="sideShown && !layout.sideOverlay"
        class="splitter"
        role="separator" tabindex="0" aria-orientation="vertical" aria-label="左侧面板宽度" aria-controls="editor-side-panel"
        :aria-valuenow="layout.sideWidth" :aria-valuemin="layout.sideMin" :aria-valuemax="layout.sideMax"
        :aria-valuetext="`${(layout.sideRatio * 100).toFixed(1)}% 页面宽度`"
        :title="`控制区域 ${(layout.sideRatio * 100).toFixed(1)}% · 拖动或左右方向键调整，双击恢复默认`"
        @pointerdown="startSideDrag" @keydown="onSideWidthKey" @dblclick="resetSideWidth"
      ></div>

      <!-- 中央编辑区：右缘概览条（兼滚动条）标注审阅块/错误警告/选中词/光标与视口位置 -->
      <section class="center" :inert="overlayVisible ? true : null">
        <EditorToolbar />
        <ChangesetBar />
        <div class="editor-host">
          <div class="editor-surface">
            <VisualView v-if="store.viewMode === 'visual'" />
            <CodeEditor v-else @context-menu="onEditorContextMenu" @save-compile="onSaveCompile" @add-review="openReviewDialog" />
            <OverviewBar />
          </div>
        </div>
        <StatusBar @synctex-forward="onSynctexForward" />
      </section>

      <!-- 右抽屉：PDF 预览 / 项目信息 / 版本 / 日志 共用，仅显示一个 -->
      <RightDrawer ref="drawerRef" :layout="layout" :visible="rightShown" :inert="overlayVisible && !(rightShown && layout.rightOverlay) ? true : null" @jump-to-code="onJumpToCode" @toggle="toggleRight" @close="closeRight" @open="openRight" @width-ratio-change="rightWidthRatio = $event" />
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount, onActivated, onDeactivated } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  Back, FolderOpened, Search, ChatDotSquare, MagicStick,
  InfoFilled, Clock, Document, FullScreen, RefreshLeft, Close,
} from '@element-plus/icons-vue';
import { ElMessageBox } from 'element-plus';
import { useEditorStore } from '../stores/editor.js';
import { useAuthStore } from '../stores/auth.js';
import { useUiStore } from '../stores/ui.js';
import { useAgentStore } from '../stores/agent.js';
import { setCollabUser } from '../lib/collabClient.js';
import { useEditorRuntime } from '../lib/editorRuntime.js';
import { useProjectContext, useWorkspaceContext } from '../lib/projectContext.js';
import { clampZoom, sideWidthFromPointer, sideBodyStyle as sideBodyStyleFor, sidePanesFromDrag, editorPanelLayout, panelWidthFromKey, panelWidthRatio, readPanelWidthRatio, savePanelWidthRatio } from '../lib/editorUtils.js';
import { createEditorNavigator } from '../lib/editorNavigation.js';
import { api } from '../api.js';
import { isTextFilePath } from '../lib/fileKind.js';
import { buildSelectionMenuItems } from '../lib/selectionMenu.js';
import FileTree from '../components/editor/FileTree.vue';
import WorkspacePanel from '../components/editor/WorkspacePanel.vue';
import OutlinePanel from '../components/editor/OutlinePanel.vue';
import SearchPanel from '../components/editor/SearchPanel.vue';
import ReviewPanel from '../components/editor/ReviewPanel.vue';
import AgentPanel from '../components/editor/AgentPanel.vue';
import EditorToolbar from '../components/editor/EditorToolbar.vue';
import ChangesetBar from '../components/editor/ChangesetBar.vue';
import CodeEditor from '../components/editor/CodeEditor.vue';
import VisualView from '../components/editor/VisualView.vue';
import StatusBar from '../components/editor/StatusBar.vue';
import RightDrawer from '../components/editor/RightDrawer.vue';
import OverviewBar from '../components/editor/OverviewBar.vue';
import ProjectSwitcher from '../components/editor/ProjectSwitcher.vue';
import ProjectWorkspaceTabs from '../components/editor/ProjectWorkspaceTabs.vue';

const route = useRoute();
const router = useRouter();
const store = useEditorStore();
const editorRuntime = useEditorRuntime();
const projectContext = useProjectContext();
const workspace = useWorkspaceContext();
const workspaceProjects = computed(() => workspace?.projects.value || []);
const activeWorkspaceId = computed(() => workspace?.activeProjectId.value || store.projectId);
const projectActive = computed(() => projectContext?.active.value ?? true);
const auth = useAuthStore();
const ui = useUiStore();
const agentStore = useAgentStore();
const drawerRef = ref(null);
const rowEl = ref(null);
// Panels are expensive trees/forms: mount on first use, then preserve their DOM,
// filters, scroll positions and drafts instead of rebuilding on each rail click.
const visitedPanels = ref(new Set(store.sidebar ? [store.sidebar] : []));
watch(() => store.sidebar, (name) => {
  if (name) visitedPanels.value.add(name);
}, { flush: 'sync' });
// 协同身份：编辑器页可能被直接刷新进入（不经过项目列表/设置页），
// 必须在此也设置昵称，否则本端 awareness 缺 user 字段，在线名单会漏掉自己。
// auth.user 就绪后（硬刷新时为异步拉取）自动补设并同步到已建立的会话。
watch(
  () => auth.user,
  (u) => setCollabUser(u?.displayName || u?.username),
  { immediate: true }
);

// 归档（只读）项目不提供审阅与 AI 入口，从图标轨中过滤
const railPanels = computed(() => {
  const panels = [
    { key: 'tree', label: '项目树', icon: FolderOpened },
    { key: 'search', label: '文件搜索', icon: Search },
  ];
  if (!store.project?.archived) {
    panels.push({ key: 'review', label: '审阅', icon: ChatDotSquare });
    panels.push({ key: 'agent', label: 'CoreAgent', icon: MagicStick });
  }
  return panels;
});

// 归档项目：侧栏若停留在审阅/CoreAgent 面板，自动切回项目树
watch(
  () => store.project?.archived,
  (a) => {
    if (a && (store.sidebar === 'review' || store.sidebar === 'agent')) store.setSidebar('tree');
  },
  { immediate: true }
);
const rightTabs = [
  { key: 'info', label: '项目信息', icon: InfoFilled },
  { key: 'versions', label: '版本', icon: Clock },
  { key: 'log', label: '日志', icon: Document },
];

// 顶栏协作信息：最多展示 3 个头像，余者以 +N 汇总；tooltip 列出在线名单
const displayUsers = computed(() => store.onlineUsers.slice(0, 3));
const extraCount = computed(() => Math.max(0, store.onlineUsers.length - 3));
const collabTitle = computed(() => {
  if (!store.onlineUsers.length) return '当前没有协作者在线';
  return `在线：${store.onlineUsers.map((u) => u.name).join('、')}${extraCount.value ? ` 等 ${store.onlineUsers.length} 人` : ''}`;
});
function initialOf(name) {
  return String(name || '?').trim().charAt(0).toUpperCase();
}

// 左侧栏三个面板的高度百分比（文件树/工作空间，大纲吃剩余），持久化记忆
const savedTop = Number(localStorage.getItem('corelatex.sideTopPct')) || 45;
const savedMid = Number(localStorage.getItem('corelatex.sideMidPct')) || 25;
const sideTopPct = ref(Number.isFinite(savedTop) ? Math.min(85, Math.max(5, savedTop)) : 45);
const sideMidPct = ref(Number.isFinite(savedMid) ? Math.min(95 - sideTopPct.value, Math.max(5, savedMid)) : 25);

// 栏宽按整个页面的比例持久化，切换显示器或全屏后继续保持比例；内部缩放独立记忆。
const sideWidthRatio = ref(readPanelWidthRatio(localStorage, 'side'));
const sideZoom = ref(clampZoom(Number(localStorage.getItem('corelatex.sideZoom')) || 1));

const rowWidth = ref(window.innerWidth);
// 专注只切换浏览器全屏；面板选择、宽度和内容始终保持原样。
const focusMode = ref(false);
const fullscreenPending = ref(false);
let viewDisposed = false;
// A route owns only the store generation it initialized. Late responses and cleanup
// from an old editor must never start work in, or reset, the next project.
const viewProjectId = projectContext?.projectId || String(route.params.id);
let viewProjectVersion;
function ownsProjectState() { return viewProjectVersion === store.projectVersion; }
function isCurrentSession() { return !viewDisposed && ownsProjectState(); }
function isCurrentView() {
  return isCurrentSession() && projectActive.value && String(route.params.id) === viewProjectId;
}
function syncProjectTitle() {
  if (isCurrentView()) document.title = store.project?.name ? `${store.project.name} · CoreLatex` : 'CoreLatex';
}
watch(() => store.project?.name, syncProjectTitle);
const activeOverlay = ref(null);
const rightWidthRatio = ref(readPanelWidthRatio(localStorage, 'right'));
const layout = computed(() => editorPanelLayout(rowWidth.value, {
  sideRatio: sideWidthRatio.value, rightRatio: rightWidthRatio.value,
  sideOpen: !!store.sidebar, rightOpen: !!store.rightTab,
  rightTab: store.rightTab,
}));
const sideShown = computed(() => !!store.sidebar && (!layout.value.sideOverlay || activeOverlay.value === 'side'));
const rightShown = computed(() => !!store.rightTab && (!layout.value.rightOverlay || activeOverlay.value === 'right'));
const overlayKind = computed(() => sideShown.value && layout.value.sideOverlay ? 'side' : rightShown.value && layout.value.rightOverlay ? 'right' : null);
const overlayVisible = computed(() => !!overlayKind.value);
let overlayReturnTarget = null;
function overlayElement(kind = overlayKind.value) {
  return rowEl.value?.querySelector(kind === 'side' ? '#editor-side-panel' : '#editor-right-panel');
}
function rememberOverlayTrigger(event) {
  const target = event?.currentTarget || document.activeElement;
  if (target instanceof HTMLElement && target !== document.body && !target.closest('.overlay-panel, .drawer-overlay')) overlayReturnTarget = target;
}
function focusableOverlayElements(panel) {
  const selector = 'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [contenteditable="true"], [tabindex]';
  return [...panel.querySelectorAll(selector)].filter((element) => {
    if (element.tabIndex < 0 || element.closest('[inert]')) return false;
    for (let node = element; node && node !== panel.parentElement; node = node.parentElement) {
      const style = window.getComputedStyle(node);
      if (node.hidden || style.display === 'none' || style.visibility === 'hidden') return false;
    }
    return true;
  });
}
function onOverlayTab(e) {
  if (!overlayVisible.value || e.key !== 'Tab' || e.defaultPrevented) return;
  const panel = overlayElement();
  if (!panel) return;
  const elements = focusableOverlayElements(panel);
  e.preventDefault();
  if (!elements.length) { panel.focus(); return; }
  const index = elements.indexOf(document.activeElement);
  const next = index < 0 ? (e.shiftKey ? elements.length - 1 : 0) : (index + (e.shiftKey ? -1 : 1) + elements.length) % elements.length;
  elements[next].focus();
}
watch(overlayKind, async (kind, previous) => {
  if (kind) {
    if (!previous && !overlayReturnTarget) rememberOverlayTrigger();
    await nextTick();
    if (overlayKind.value !== kind) return;
    const panel = overlayElement(kind);
    (panel?.querySelector(kind === 'side' ? '.side-heading button, .agent-close' : '.close') || panel)?.focus();
  } else if (previous) {
    const returnTarget = overlayReturnTarget;
    overlayReturnTarget = null;
    await nextTick();
    if (!overlayKind.value && returnTarget?.isConnected) returnTarget.focus();
  }
});
const activeSideLabel = computed(() => railPanels.value.find((panel) => panel.key === store.sidebar)?.label || '项目面板');
function syncFullscreenState() {
  focusMode.value = document.fullscreenElement === document.documentElement;
}
async function toggleFocus() {
  if (fullscreenPending.value) return;
  const exiting = document.fullscreenElement === document.documentElement;
  if (!exiting && (typeof document.documentElement.requestFullscreen !== 'function' || document.fullscreenEnabled === false)) {
    ui.error('当前浏览器不支持页面全屏，可使用浏览器菜单中的全屏功能');
    return;
  }
  if (exiting && typeof document.exitFullscreen !== 'function') {
    ui.error('请按 Esc 或使用浏览器菜单退出全屏');
    return;
  }
  fullscreenPending.value = true;
  try {
    if (exiting) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch {
    ui.error(exiting ? '未能退出全屏，请按 Esc 重试' : '浏览器未允许进入全屏，请再次点击专注按钮');
  } finally {
    // 浏览器权限响应可能晚于路由离开，避免旧页面的请求随后把新页面带入全屏。
    if (viewDisposed && document.fullscreenElement === document.documentElement) {
      try { await document.exitFullscreen?.(); } catch {}
    }
    if (!viewDisposed) syncFullscreenState();
    fullscreenPending.value = false;
  }
}
function toggleSidebar(name, event) {
  rememberOverlayTrigger(event);
  const wasVisible = sideShown.value && store.sidebar === name;
  if (layout.value.sideOverlay) {
    if (store.sidebar !== name) store.setSidebar(name);
    activeOverlay.value = wasVisible ? null : 'side';
  } else store.setSidebar(name);
}
function toggleRight(name, event) {
  rememberOverlayTrigger(event);
  const wasVisible = rightShown.value && store.rightTab === name;
  if (layout.value.rightOverlay) {
    if (store.rightTab !== name) store.setRightTab(name);
    activeOverlay.value = wasVisible ? null : 'right';
  } else store.setRightTab(name);
}
function closeOverlay() { activeOverlay.value = null; }
function closeSidebar() {
  if (layout.value.sideOverlay) closeOverlay();
  else if (store.sidebar) store.setSidebar(store.sidebar);
}
function closeRight() {
  if (layout.value.rightOverlay) closeOverlay();
  else if (store.rightTab) store.setRightTab(store.rightTab);
}
function openRight() { rememberOverlayTrigger(); activeOverlay.value = 'right'; }
watch(() => store.sidebar, (name) => { if (name && layout.value.sideOverlay) activeOverlay.value = 'side'; });
watch(() => store.rightTab, (name) => { if (name && layout.value.rightOverlay) openRight(); });
watch(() => [layout.value.sideOverlay, layout.value.rightOverlay], (next, previous) => {
  if (next.some((value, index) => value !== previous[index])) closeOverlay();
});
let resizeObserver;
let stopPanelDrag;
function updateRowWidth() { rowWidth.value = rowEl.value?.getBoundingClientRect().width || window.innerWidth; }
function resetSideWidth() { sideWidthRatio.value = 0.2; savePanelWidthRatio(localStorage, 'side', 0); }
function resetLayout() {
  closeOverlay();
  resetSideWidth(); resetSidePanes();
  sideZoom.value = 1;
  localStorage.removeItem('corelatex.sideZoom');
  rightWidthRatio.value = 0;
  savePanelWidthRatio(localStorage, 'right', 0);
  if (store.sidebar !== 'tree') store.setSidebar('tree');
  if (store.rightTab !== 'pdf') store.setRightTab('pdf');
  // Store watchers are queued; close once they have observed the restored tabs.
  nextTick(closeOverlay);
}



// Ctrl/Cmd + 滚轮：只缩放侧栏内部内容，宽度始终由拖动决定
function onSideWheel(e) {
  if (!(e.ctrlKey || e.metaKey)) return;
  e.preventDefault();
  sideZoom.value = clampZoom(sideZoom.value + (e.deltaY < 0 ? 0.05 : -0.05));
  localStorage.setItem('corelatex.sideZoom', String(sideZoom.value));
}

// 缩放系数换算成内部容器的样式：内容放大 z 倍，占位尺寸同时除以 z，
// 面板外框宽度因此保持不变
const sideBodyStyle = computed(() => sideBodyStyleFor(sideZoom.value));

// 左侧栏宽度拖动：以图标轨右缘为原点
function startSideDrag(e) {
  e.preventDefault();
  stopPanelDrag?.();
  const splitter = e.currentTarget;
  const row = splitter.parentElement;
  const railRight = row.querySelector('.icon-rail').getBoundingClientRect().right;
  try { splitter.setPointerCapture(e.pointerId); } catch {}
  document.body.classList.add('col-resizing');
  const onMove = (ev) => {
    const width = sideWidthFromPointer(ev.clientX, railRight, layout.value.sideMin, layout.value.sideMax);
    sideWidthRatio.value = panelWidthRatio(width, rowWidth.value);
  };
  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    document.body.classList.remove('col-resizing');
    stopPanelDrag = null;
    savePanelWidthRatio(localStorage, 'side', sideWidthRatio.value);
  };
  stopPanelDrag = onUp;
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
}

function onSideWidthKey(e) {
  const next = panelWidthFromKey(layout.value.sideWidth, e.key, layout.value.sideMin, layout.value.sideMax, false, e.shiftKey ? 48 : 16);
  if (next === null) return;
  e.preventDefault();
  sideWidthRatio.value = panelWidthRatio(next, rowWidth.value);
  savePanelWidthRatio(localStorage, 'side', sideWidthRatio.value);
}
function onPaneKey(e, which) {
  if (!['ArrowUp', 'ArrowDown', 'Home'].includes(e.key)) return;
  e.preventDefault();
  if (e.key === 'Home') { resetSidePanes(); return; }
  const height = rowEl.value?.getBoundingClientRect().height || 720;
  const min = Math.min(30, PANE_MIN_PX / height * 100);
  const current = which === 'top' ? sideTopPct.value : sideTopPct.value + sideMidPct.value;
  const next = sidePanesFromDrag(which, current + (e.key === 'ArrowDown' ? 3 : -3), { top: sideTopPct.value, mid: sideMidPct.value }, { top: min, mid: min, outline: min });
  sideTopPct.value = next.top; sideMidPct.value = next.mid;
  localStorage.setItem('corelatex.sideTopPct', String(next.top));
  localStorage.setItem('corelatex.sideMidPct', String(next.mid));
}

// 左侧栏上下拖动：让位优先级按用户指定——大纲最次要、工作空间次之（上分隔条下压
// 优先压缩大纲、大纲到底后才收缩工作空间；下分隔条上收只动工作空间、文件树不动）。
// 面板最小值按标题行像素折算——任何面板都能折叠到只剩标题条。细节见 sidePanesFromDrag
const PANE_MIN_PX = 36; // 面板标题行高度(padding 8×2 + 标题行)，折叠下限
function startVDrag(e, which) {
  e.preventDefault();
  stopPanelDrag?.();
  const splitter = e.currentTarget;
  const panel = splitter.parentElement;
  const rect = panel.getBoundingClientRect();
  if (!rect.height) return;
  // 像素下限换算成百分比随窗口高度自适应；面板隐藏(高 0)时回落 5% 防除零
  const minPct = rect.height > 0 ? (PANE_MIN_PX / rect.height) * 100 : 5;
  const mins = { top: minPct, mid: minPct, outline: minPct };
  try { splitter.setPointerCapture(e.pointerId); } catch {}
  document.body.classList.add('row-resizing');
  const onMove = (ev) => {
    const pct = ((ev.clientY - rect.top) / rect.height) * 100;
    const next = sidePanesFromDrag(which, pct, { top: sideTopPct.value, mid: sideMidPct.value }, mins);
    sideTopPct.value = next.top;
    sideMidPct.value = next.mid;
  };
  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    document.body.classList.remove('row-resizing');
    stopPanelDrag = null;
    localStorage.setItem('corelatex.sideTopPct', String(Math.round(sideTopPct.value)));
    localStorage.setItem('corelatex.sideMidPct', String(Math.round(sideMidPct.value)));
  };
  stopPanelDrag = onUp;
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
}

// 双击任一分隔条：三段面板回到默认比例（文件树 45 / 工作空间 25 / 大纲 30）
function resetSidePanes() {
  sideTopPct.value = 45;
  sideMidPct.value = 25;
  localStorage.setItem('corelatex.sideTopPct', '45');
  localStorage.setItem('corelatex.sideMidPct', '25');
}

// Ctrl/Cmd+S：协同已实时落盘，这里触发编译（服务端会先 flush 防抖中的变更）
function onSaveCompile() {
  if (store.compile.status === 'running') return;
  store.compileProject().catch((err) => ui.error(err.message || '编译失败'));
}
function onGlobalKeydown(e) {
  // Embedded editors, menus and dialogs get first refusal for their own shortcuts.
  if (!isCurrentView() || e.defaultPrevented) return;
  if (e.key === 'Tab' && overlayVisible.value) { onOverlayTab(e); return; }
  if (e.key === 'Escape' && e.target?.closest?.('[role="dialog"], [aria-modal="true"], .el-message-box')) return;
  if (e.key === 'Escape' && overlayVisible.value) {
    e.preventDefault();
    closeOverlay();
    return;
  }
  if (e.key === 'Escape' && focusMode.value) {
    e.preventDefault();
    toggleFocus();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'f') {
    e.preventDefault(); toggleFocus(); return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    onSaveCompile();
  }
}

function goBack() {
  router.push('/');
}

function onEditorContextMenu({ x, y, from, to, text, projectId = store.projectId, filePath = store.activeFile }) {
  const items = buildSelectionMenuItems({
    store,
    agentStore,
    ui,
    runtime: editorRuntime,
    selection: { from, to }, // 右键时捕获选区，点击菜单项时透传给后端
    onLocatePdf: () => locateInPdf(from),
    // 审阅模式：只读状态下提供「添加批注」入口
    onAddReview: store.reviewMode ? () => openReviewDialog({ projectId, filePath, from, to, text }) : undefined,
  });
  ui.openContextMenu(x, y, items);
}

// 审阅模式：针对选区弹出批注输入框，提交后写入服务端并刷新标记
async function openReviewDialog({ from, to, text, projectId = store.projectId, filePath = store.activeFile }) {
  if (!projectId || !filePath || !isCurrentSession() || store.projectId !== projectId) return;
  const token = auth.token;
  let content;
  try {
    const quote = String(text || '').replace(/\s+/g, ' ').trim();
    const short = quote.length > 80 ? quote.slice(0, 80) + '…' : quote;
    const { value } = await ElMessageBox.prompt(
      short ? `「${short}」` : '针对当前选中的内容',
      '添加批注',
      {
        inputType: 'textarea',
        inputPlaceholder: '写下你的审阅意见…',
        confirmButtonText: '提交',
        cancelButtonText: '取消',
        inputValidator: (v) => (v && v.trim() ? true : '批注内容不能为空'),
      }
    );
    content = value.trim();
  } catch {
    return; // 用户取消
  }
  if (!isCurrentSession() || store.projectId !== projectId || auth.token !== token) return;
  try {
    await store.addReview({
      filePath,
      start: from,
      end: to,
      quotedText: text || '',
      content,
    });
    ui.toast('批注已添加');
  } catch (e) {
    ui.error(e.message || '添加批注失败');
  }
}

let pdfLocateController;
const codeNavigator = createEditorNavigator(store, editorRuntime, { active: isCurrentView, onError: message => ui.error(message) });

async function locateInPdf(pos) {
  const file = store.activeFile;
  if (!file || !store.compile.pdfUrl) {
    ui.error('请先编译生成 PDF');
    return;
  }
  const view = editorRuntime.view;
  if (!view || editorRuntime.filePath !== file) return;
  const offset = Math.min(pos ?? view.state.selection.main.head, view.state.doc.length);
  const source = view.state.doc.lineAt(offset);
  const query = new URLSearchParams({ file, line: source.number, col: offset - source.from + 1 });
  const jobId = store.compile.pdfJobId;
  if (jobId != null) query.set('jobId', jobId);
  const projectId = store.projectId;
  const stamp = store.pdfStamp;
  codeNavigator.cancel();
  pdfLocateController?.abort();
  const controller = new AbortController();
  pdfLocateController = controller;
  const current = () => isCurrentView() && !controller.signal.aborted
    && store.projectId === projectId && store.activeFile === file && store.pdfStamp === stamp;
  try {
    const hit = await api.get(`/api/projects/${projectId}/synctex/code?${query}`, { signal: controller.signal });
    if (current()) {
      await drawerRef.value?.jumpToPdf({ ...hit, jobId });
    }
  } catch (error) {
    if (current()) ui.error(error.status === 404 ? '此处没有对应的 PDF 位置，请确认当前 PDF 已重新编译' : error.message || 'PDF 定位失败');
  } finally {
    if (pdfLocateController === controller) pdfLocateController = null;
  }
}

function onSynctexForward() {
  locateInPdf();
}

function onJumpToCode({ file, line, column }) {
  if (!file) return;
  pdfLocateController?.abort();
  return codeNavigator.open(file, { line: Math.max(0, (line || 1) - 1), col: Math.max(0, (column || 1) - 1) });
}

watch(() => [store.activeFile, store.pdfStamp, projectActive.value], () => pdfLocateController?.abort());

function attachViewEvents() {
  if (viewDisposed || !projectActive.value) return;
  syncFullscreenState();
  document.addEventListener('fullscreenchange', syncFullscreenState);
  updateRowWidth();
  if (typeof ResizeObserver !== 'undefined' && rowEl.value) {
    resizeObserver ||= new ResizeObserver(updateRowWidth);
    resizeObserver.observe(rowEl.value);
  }
  window.addEventListener('resize', updateRowWidth);
  window.addEventListener('keydown', onGlobalKeydown);
}
function detachViewEvents() {
  document.removeEventListener('fullscreenchange', syncFullscreenState);
  resizeObserver?.disconnect();
  window.removeEventListener('resize', updateRowWidth);
  window.removeEventListener('keydown', onGlobalKeydown);
  stopPanelDrag?.();
}
onActivated(() => {
  attachViewEvents();
  syncProjectTitle();
  if (projectInitialized && isCurrentSession()) store.loadPendingChangesets();
  nextTick(() => { if (isCurrentView()) { updateRowWidth(); editorRuntime.view?.requestMeasure(); } });
});
onDeactivated(() => {
  detachViewEvents();
  pdfLocateController?.abort();
  codeNavigator.cancel();
  // Overlay visibility belongs to this cached workspace, just like its tabs.
  if (ownsProjectState()) store.saveViewState();
});
const isWorkspaceFile = (path) => typeof path === 'string' && path.startsWith('_workspace/');
let pendingRestoredFiles = null;
let restoredWorkspaceCheck = null;
async function checkRestoredWorkspaceFile(path) {
  const { projectId, projectVersion } = store;
  const controller = new AbortController();
  const check = { path, controller };
  restoredWorkspaceCheck = check;
  try {
    // HEAD validates only the active remembered workspace file. It does not
    // enumerate or read any workspace content.
    await api.head(`/api/projects/${projectId}/file?path=${encodeURIComponent(path)}`, { signal: controller.signal });
  } catch (error) {
    if (error?.status !== 404 || controller.signal.aborted || !isCurrentSession() ||
        store.projectId !== projectId || store.projectVersion !== projectVersion ||
        store.activeFile !== path || !store.openFiles.includes(path)) return;
    store.closeFile(path);
    if (!store.openFiles.length && store.project?.mainFile) store.openFile(store.project.mainFile);
  } finally {
    if (restoredWorkspaceCheck === check) restoredWorkspaceCheck = null;
  }
}
watch(() => store.activeFile, (path) => {
  if (restoredWorkspaceCheck && restoredWorkspaceCheck.path !== path) restoredWorkspaceCheck.controller.abort();
});
function projectTreeFiles() {
  const files = new Set();
  const visit = (nodes) => (nodes || []).forEach((node) => {
    if (node.type === 'dir' || node.children) visit(node.children);
    else if (node.path) files.add(node.path);
  });
  visit(store.tree);
  return files;
}
function reconcileRestoredTabs() {
  if (!pendingRestoredFiles || !store.treeLoaded || !isCurrentSession()) return;
  const remembered = pendingRestoredFiles;
  pendingRestoredFiles = null;
  const exist = projectTreeFiles();
  const before = [...store.openFiles];
  const remaining = before.filter((file) => !remembered.has(file) || isWorkspaceFile(file) || exist.has(file));
  // Do not reopen tabs the user closed while the tree was loading. If only
  // stale remembered tabs remain, fall back to an existing main document.
  if (before.length && !remaining.length && store.project?.mainFile && exist.has(store.project.mainFile)) remaining.push(store.project.mainFile);
  store.openFiles = remaining;
  if (!remaining.includes(store.activeFile)) store.activeFile = remaining[0] || '';
  store.restoredAnchors = Object.fromEntries(Object.entries(store.restoredAnchors || {}).filter(([path]) => remaining.includes(path)));
}
function restoreSavedTabs(saved) {
  if (!Array.isArray(saved?.openFiles)) return;
  const remembered = [...new Set(saved.openFiles.filter((path) => typeof path === 'string' && path.length > 0))];
  const needsTree = store.treeLoaded === false;
  const exist = needsTree ? null : projectTreeFiles();
  const files = remembered.filter((path) => needsTree || isWorkspaceFile(path) || exist.has(path));
  if (!saved.openFiles.length || files.length) {
    store.openFiles = files;
    store.activeFile = files.includes(saved.file) ? saved.file : files[0] || '';
    if (saved.anchors && typeof saved.anchors === 'object' && !Array.isArray(saved.anchors)) {
      store.restoredAnchors = Object.fromEntries(files
        .filter((file) => Number.isFinite(saved.anchors[file]))
        .map((file) => [file, Math.max(0, Math.min(1, saved.anchors[file]))]));
    }
    if (needsTree && files.length) pendingRestoredFiles = new Set(files);
    if (isWorkspaceFile(store.activeFile)) checkRestoredWorkspaceFile(store.activeFile);
  }
  reconcileRestoredTabs();
}
watch(() => [store.treeLoaded, store.treeVersion], reconcileRestoredTabs);

let projectInitialized = false;
let automaticCompileStarted = false;
let backgroundStartTimer = null;
function startAutomaticCompileWhenReady() {
  if (!projectInitialized || automaticCompileStarted || !projectActive.value || !isCurrentSession()) return;
  const needsEditor = store.viewMode !== 'visual' && !!store.activeFile && isTextFilePath(store.activeFile);
  if (needsEditor && !(editorRuntime.view && editorRuntime.projectId === store.projectId && editorRuntime.filePath === store.activeFile)) return;
  automaticCompileStarted = true;
  store.compileProject().catch(() => {});
}
watch(() => [projectActive.value, store.viewMode, store.activeFile, editorRuntime.view, editorRuntime.projectId, editorRuntime.filePath], startAutomaticCompileWhenReady);

onMounted(async () => {
  attachViewEvents();
  try {
    const initializing = store.init(viewProjectId);
    viewProjectVersion = store.projectVersion;
    if (!await initializing || !isCurrentSession()) return;
    if (projectContext) projectContext.error.value = '';
    syncProjectTitle();
    const projectId = store.projectId;
    agentStore.setProject(projectId);
    // Let the current file start loading before background project work. Active
    // runs are still reattached; idle chats load only when the panel is opened.
    backgroundStartTimer = setTimeout(() => {
      backgroundStartTimer = null;
      if (!isCurrentSession() || store.projectId !== projectId) return;
      agentStore.loadSettings().catch(() => {});
      agentStore.restoreActiveRun(projectId).catch(() => {});
      store.loadPendingChangesets();
    }, 0);
    // Restore tabs immediately, without waiting for the directory scan. Once
    // the project tree arrives, reconcile only remembered project files; the
    // separately loaded workspace cannot be judged from that tree.
    restoreSavedTabs(store.restoreViewState());
    // Preserve automatic preview while giving the active text snapshot priority.
    projectInitialized = true;
    startAutomaticCompileWhenReady();
  } catch (e) {
    if (!isCurrentSession()) return;
    if (projectContext) projectContext.error.value = e.message || '加载项目失败';
    if (isCurrentView()) { ui.error(e.message || '加载项目失败'); router.push('/'); }
  }
});

onBeforeUnmount(() => {
  clearTimeout(backgroundStartTimer);
  restoredWorkspaceCheck?.controller.abort();
  pdfLocateController?.abort();
  codeNavigator.cancel();
  const wasActive = projectActive.value;
  viewDisposed = true;
  detachViewEvents();
  if (wasActive && document.fullscreenElement === document.documentElement) {
    document.exitFullscreen?.().catch(() => {});
  }
  // Only closing a workspace disposes it. A normal project switch uses KeepAlive.
  if (ownsProjectState()) {
    if (wasActive) document.title = 'CoreLatex';
    store.saveViewState();
    agentStore.clearLocal();
    store.reset();
  }
});
</script>

<style scoped>
.editor-page { height: 100%; display: flex; flex-direction: column; overflow: hidden; background: transparent; }
.topbar { min-height: 56px; display: flex; align-items: center; gap: 8px; padding: 8px 16px 8px 10px; background: var(--surface-raised, var(--bg2)); border-bottom: 1px solid var(--border); flex: none; }
.topbar > .ghost { flex: none; }
.proj-name { min-width: 40px; max-width: min(30vw, 400px); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 650; font-size: 14px; letter-spacing: -.2px; }
.grow { flex: 1; min-width: 0; }
.layout-actions { display: flex; align-items: center; gap: 3px; flex: none; }
.topbar-divider { height: 20px; width: 1px; background: var(--border); margin: 0 4px; flex: none; }
.icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 34px; min-height: 34px; padding: 7px; border-radius: 9px; }
.focus-toggle { width: auto; gap: 6px; font-size: 12px; }
.icon-btn.active { background: var(--accent-soft, var(--bg3)); color: var(--accent); }
.collab-chip { display: inline-flex; align-items: center; gap: 7px; padding: 3px 6px; background: transparent; border: 1px solid transparent; border-radius: 999px; font-size: 11px; color: var(--fg-muted, var(--fg-dim)); max-width: 280px; white-space: nowrap; overflow: hidden; flex-shrink: 1; }
.avatar-stack { display: inline-flex; flex: none; }
.avatar-dot { width: 22px; height: 22px; border-radius: 50%; border: 2px solid var(--surface-raised, var(--bg2)); color: var(--on-accent); font-size: 10px; font-weight: 650; display: inline-flex; align-items: center; justify-content: center; margin-left: -7px; flex: none; }
.avatar-dot:first-child { margin-left: 0; }
.collab-text b { color: var(--fg); font-weight: 650; }
.badge { font-size: 10px; padding: 3px 8px; border-radius: 6px; background: var(--surface-muted, var(--bg3)); color: var(--fg-muted, var(--fg-dim)); white-space: nowrap; }
.badge.warn { color: var(--warn); }
.badge-short { display: none; }
.main-row { position: relative; flex: 1; display: flex; min-height: 0; min-width: 0; overflow: hidden; }
.icon-rail { width: var(--rail-width, 48px); flex: none; background: var(--surface-raised, var(--bg2)); border-right: 1px solid var(--border); display: flex; flex-direction: column; align-items: center; padding-top: 10px; gap: 5px; z-index: 25; min-height: 0; overflow-x: hidden; overflow-y: auto; scrollbar-width: thin; }
.rail-btn { flex: none; width: 36px; height: 38px; border: none; background: transparent; border-radius: 7px; display: flex; align-items: center; justify-content: center; color: var(--fg-muted, var(--fg-dim)); position: relative; }
.rail-workspaces { display: flex; flex-direction: column; align-items: center; align-self: stretch; flex: 1 1 0; min-height: 110px; margin-top: 10px; padding-top: 10px; padding-bottom: 8px; gap: 8px; border-top: 1px solid var(--border); }
.rail-btn .el-icon { font-size: 18px; }
.rail-btn:hover { background: var(--bg-hover); color: var(--fg); }
.rail-btn.active { background: var(--accent-soft, var(--bg3)); color: var(--accent); }
.rail-btn.active::before { content: ''; position: absolute; left: -6px; width: 3px; height: 18px; background: var(--accent); border-radius: 0 3px 3px 0; }
.side-panel { flex: 0 0 auto; background: var(--surface-raised, var(--bg2)); border-right: 1px solid var(--border); display: flex; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; }
.side-heading { display: flex; align-items: center; justify-content: space-between; min-height: 38px; padding: 3px 8px 3px 14px; border-bottom: 1px solid var(--border); color: var(--fg-muted, var(--fg-dim)); font-size: 11px; font-weight: 600; letter-spacing: .1px; flex: none; }
.side-heading .ghost { display: flex; padding: 5px; border-radius: 6px; }
.side-viewport { position: relative; flex: 1 1 0; min-height: 0; min-width: 0; overflow: hidden; display: flex; flex-direction: column; }
.side-body { flex: 1 1 auto; min-height: 0; overflow: hidden; display: flex; flex-direction: column; }
.tree-panel-cache { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; overflow: hidden; }
.side-panel .pane { flex: 0 0 auto; min-height: 0; overflow: hidden; display: flex; flex-direction: column; }
.h-splitter { height: 5px; cursor: row-resize; background: var(--bg); flex: none; touch-action: none; position: relative; z-index: 5; }
.h-splitter::before { content: ''; position: absolute; inset: -4px 0; }
.h-splitter:hover, .h-splitter:active, .h-splitter:focus-visible { background: var(--accent); }
:global(body.row-resizing) { user-select: none; cursor: row-resize; }
.center { flex: 1 1 auto; width: auto; display: flex; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; background: var(--bg); }
.editor-host { position: relative; flex: 1 1 auto; min-width: 0; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
.editor-surface { position: relative; flex: 1 1 auto; min-width: 0; min-height: 0; display: flex; }
.editor-surface > .code-editor, .editor-surface > .visual-view { flex: 1 1 auto; min-width: 0; }
.splitter { width: 5px; cursor: col-resize; background: var(--bg); flex: none; touch-action: none; position: relative; z-index: 5; }
.splitter::before { content: ''; position: absolute; inset: 0 -4px; }
.splitter:hover, .splitter:active, .splitter:focus-visible { background: var(--accent); }
:global(body.col-resizing) { user-select: none; cursor: col-resize; }
:global(body.col-resizing iframe), :global(body.col-resizing canvas) { pointer-events: none; }
.panel-backdrop { position: absolute; z-index: 20; inset: 0 0 0 var(--rail-width, 48px); border: none; border-radius: 0; background: rgba(12, 20, 30, .22); cursor: default; }
.panel-backdrop:hover { background: rgba(12, 20, 30, .22); }
.overlay-panel { position: absolute; z-index: 22; left: calc(var(--rail-width, 48px) + 8px); top: 10px; bottom: 10px; border: 1px solid var(--border); border-radius: var(--radius-lg, 14px); box-shadow: var(--shadow-sm, 0 12px 36px #0002); }
@media (max-width: 1100px) { .shared-detail { display: none; } .proj-name { max-width: 26vw; } .collab-chip { padding-right: 8px; } }
@media (max-width: 760px) { .topbar { min-height: 52px; padding: 6px 8px; gap: 4px; } .proj-name { flex: 1; max-width: none; font-size: 13px; } .collab-chip { border: none; background: transparent; padding: 0; gap: 3px; flex: none; } .avatar-stack { display: none; } .collab-text { font-size: 10px; } .topbar > .grow { display: none; } .topbar-divider { margin: 0 2px; } .focus-toggle span { display: none; } .icon-btn { width: 30px; min-height: 32px; padding: 6px; } .badge { font-size: 9px; padding: 3px 5px; } .badge-full { display: none; } .badge-short { display: inline; } }
@media (max-width: 420px) { .reset-layout { display: none; } .topbar-divider { display: none; } .topbar { gap: 2px; } .topbar > .ghost:first-child { padding: 6px; } .collab-chip { display: none; } }

/* Editor chrome stays restrained so the document remains the visual focus. */
.topbar { background: var(--glass-g1-bg); border-color: var(--glass-edge); box-shadow: var(--glass-highlight); -webkit-backdrop-filter: var(--glass-g1-filter); backdrop-filter: var(--glass-g1-filter); }
.proj-name { letter-spacing: -.015em; }
.icon-btn, .rail-btn { transition: transform var(--motion-hover) var(--ease-standard), opacity var(--motion-hover) var(--ease-standard); }
.icon-btn:active:not(:disabled), .rail-btn:active:not(:disabled) { transform: scale(.96); }
/* Keep the fixed project picker relative to the viewport, outside rail clipping. */
.icon-rail { background: var(--glass-g1-bg); border-color: var(--glass-edge); }
.rail-btn.active { box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 12%, transparent); }
.side-panel { background: var(--glass-g2-bg); border-color: var(--glass-edge); -webkit-backdrop-filter: var(--glass-g2-filter); backdrop-filter: var(--glass-g2-filter); }
.side-heading { min-height: 40px; background: var(--glass-inset); color: var(--fg-dim); letter-spacing: .035em; }
.center { background: var(--bg); }
.splitter, .h-splitter { transition: opacity var(--motion-hover) var(--ease-standard); }
.overlay-panel { background: var(--glass-g3-bg); border-color: var(--glass-edge); box-shadow: var(--glass-highlight), var(--shadow-lg); -webkit-backdrop-filter: var(--glass-g3-filter); backdrop-filter: var(--glass-g3-filter); animation: overlay-in var(--motion-surface) var(--ease-standard); }
@keyframes overlay-in { from { opacity: 0; transform: translateX(-4px); } to { opacity: 1; transform: translateX(0); } }
.badge { border: 1px solid color-mix(in srgb, var(--border) 72%, transparent); font-weight: 550; }
.collab-chip { border-radius: 8px; }
@media(max-width:760px) {
  .icon-btn:active:not(:disabled), .rail-btn:active:not(:disabled) { transform: none; }
}

/* Docked regions form one workspace; overlay mode supplies the glass elevation. */
.topbar { background: color-mix(in srgb, var(--bg2) 94%, transparent); border-color: var(--border); -webkit-backdrop-filter: var(--glass-g2-filter); backdrop-filter: var(--glass-g2-filter); }
.icon-rail { background: var(--bg2); border-color: var(--border); }
.side-panel:not(.overlay-panel) { background: var(--bg2); border-color: var(--border); box-shadow: none; -webkit-backdrop-filter: none; backdrop-filter: none; }
.side-heading { background: transparent; }
.icon-btn.active, .rail-btn.active { color: var(--accent-hover); background: var(--accent-soft); }
.rail-btn.active { box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 9%, transparent); }
.rail-btn.active::before { background: var(--accent); }
.badge { background: var(--surface-muted); }
.panel-backdrop, .panel-backdrop:hover { background: var(--el-mask-color); }

/* Visual refinement: identity cue in the topbar, softer chrome details. */
.proj-name-icon { flex: none; font-size: 15px; color: var(--accent); opacity: .85; margin-left: 2px; }
.collab-chip { background: var(--glass-inset); border-color: color-mix(in srgb, var(--border) 70%, transparent); padding: 3px 9px 3px 5px; transition: background-color var(--motion-hover) var(--ease-standard); }
.collab-chip:hover { background: var(--bg-hover); }
.avatar-dot { box-shadow: 0 1px 3px rgba(var(--shadow-ink), .18); }
.badge { border-radius: 999px; padding: 3px 10px; }
.badge.warn { background: var(--warn-soft); border-color: color-mix(in srgb, var(--warn) 24%, transparent); }
.rail-btn { border-radius: 9px; }
.rail-btn:hover { color: var(--accent-hover); }
.rail-btn.active::before { border-radius: 0 4px 4px 0; height: 20px; }
.side-heading { text-transform: none; font-size: 11px; }
.side-heading span { display: inline-flex; align-items: center; gap: 7px; }
.side-heading span::before { content: ''; width: 3px; height: 11px; border-radius: 2px; background: var(--accent); opacity: .6; }
.topbar { box-shadow: 0 1px 0 color-mix(in srgb, var(--surface-raised) 65%, transparent) inset, 0 2px 10px rgba(var(--shadow-ink), .03); }
@media (max-width: 760px) {
  .proj-name-icon { display: none; }
  .collab-chip { background: transparent; border: none; padding: 0; }
}

</style>
