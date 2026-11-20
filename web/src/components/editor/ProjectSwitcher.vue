<script setup>
import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ArrowDown, ArrowRight, FolderAdd, Refresh, Search } from '@element-plus/icons-vue';
import { api } from '../../api.js';
import { projectPath, navigateProjectLink, navigateWorkspaceLink } from '../../lib/projectNavigation.js';
import { projectNotificationLabel } from '../../lib/projectNotification.js';
import ProjectNotificationBadge from './ProjectNotificationBadge.vue';

const router = useRouter();
const props = defineProps({
  project: { type: Object, default: null },
  workspaceProjects: { type: Array, default: () => [] },
  compact: { type: Boolean, default: false },
});
const panel = ref(null);
const searchInput = ref(null);
const query = ref('');
const projects = ref([]);
const loading = ref(false);
const error = ref('');
const pickerStyle = ref({ visibility: 'hidden' });
let active = true;
let listening = false;
let loaded = false;
let disposed = false;
const currentId = computed(() => projectId(props.project));
const workspaceById = computed(() => new Map(props.workspaceProjects.map(project => [projectId(project), project])));
const filtered = computed(() => {
  const term = query.value.trim().toLocaleLowerCase();
  return projects.value.filter(p => !term || `${p.name} ${p.ownerName || ''}`.toLocaleLowerCase().includes(term))
    .sort((a, b) => Number(isCurrent(b)) - Number(isCurrent(a)))
    .map(project => {
      const workspace = workspaceById.value.get(projectId(project));
      return {
        ...project,
        pendingReviewCount: workspace?.pendingReviewCount ?? 0,
        unreadCompletion: !isCurrent(project) && !!workspace?.unreadCompletion,
      };
    });
});
function projectId(project) { return String(project?.publicId || project?.id || ''); }
function isCurrent(project) { return projectId(project) === currentId.value; }
function projectLinkLabel(project) {
  const readonly = project.archived || project.role === 'viewer' ? '（只读）' : '';
  const notification = projectNotificationLabel(project.pendingReviewCount, project.unreadCompletion);
  return [`切换项目：${project.name}${readonly}`, notification].filter(Boolean).join(' · ');
}
function accessLabel(project) { return project.archived ? '已归档 · 只读' : project.role === 'viewer' ? '只读' : project.role === 'owner' ? '我的项目' : '共享编辑'; }
async function loadProjects() {
  if (loading.value) return;
  loading.value = true;
  error.value = '';
  try {
    // The summary omits expensive recursive storage accounting from this picker.
    const [active, archived] = await Promise.all([
      api.get('/api/projects?view=all&summary=1'),
      api.get('/api/projects?view=archived&summary=1'),
    ]);
    if (disposed) return;
    const unique = new Map();
    for (const project of [...(active.projects || []), ...(archived.projects || [])]) {
      if (!project.deleted) unique.set(String(project.publicId || project.id), project);
    }
    projects.value = [...unique.values()];
    loaded = true;
  } catch (e) {
    if (!disposed) error.value = e.message || '加载项目失败';
  } finally { if (!disposed) loading.value = false; }
}
function positionPicker() {
  if (!active || !panel.value?.open) return;
  const anchor = panel.value.querySelector('summary')?.getBoundingClientRect();
  if (!anchor) return;
  const width = window.innerWidth || document.documentElement.clientWidth;
  const height = window.innerHeight || document.documentElement.clientHeight;
  const pickerWidth = Math.min(370, Math.max(0, width - 32));
  const preferredLeft = props.compact ? anchor.right + 8 : anchor.left;
  const left = Math.max(16, Math.min(preferredLeft, width - pickerWidth - 16));
  const preferredTop = props.compact ? anchor.top : anchor.bottom + 6;
  const top = Math.max(16, Math.min(preferredTop, height - Math.min(240, Math.max(0, height - 32)) - 16));
  pickerStyle.value = { left: `${left}px`, top: `${top}px`, maxHeight: `${Math.max(0, height - top - 16)}px`, visibility: 'visible' };
}
async function onToggle() {
  if (!panel.value?.open) return;
  if (!active) { close(); return; }
  positionPicker();
  if (!loaded) loadProjects();
  await nextTick();
  if (active && panel.value?.open) searchInput.value?.focus();
}
function close(restoreFocus = false) {
  if (!panel.value?.open) return;
  panel.value.open = false;
  pickerStyle.value = { visibility: 'hidden' };
  if (restoreFocus) panel.value.querySelector('summary')?.focus();
}
function selectProject(event, project) {
  navigateProjectLink(event, project, router);
  close();
}
function showProjects(event) {
  navigateWorkspaceLink(event, '/', router);
  close();
}
function onOutside(event) { if (!panel.value?.contains(event.target)) close(); }
function onKey(event) {
  if (event.key === 'Escape' && panel.value?.open) {
    event.preventDefault(); event.stopPropagation(); close(true);
  }
}
function onViewportScroll(event) {
  // Scrolling the project list itself must leave its popover open.
  if (!panel.value?.contains(event.target)) positionPicker();
}
function startListening() {
  active = true;
  if (listening) return;
  listening = true;
  document.addEventListener('pointerdown', onOutside);
  window.addEventListener('resize', positionPicker);
  window.addEventListener('scroll', onViewportScroll, true);
}
function stopListening() {
  active = false;
  close();
  if (!listening) return;
  listening = false;
  document.removeEventListener('pointerdown', onOutside);
  window.removeEventListener('resize', positionPicker);
  window.removeEventListener('scroll', onViewportScroll, true);
}
onMounted(startListening);
onActivated(startListening);
onDeactivated(stopListening);
onBeforeUnmount(() => { disposed = true; stopListening(); });
</script>

<template>
  <details ref="panel" class="project-switcher" :class="{ compact }" @toggle="onToggle" @keydown="onKey">
    <summary :title="compact ? `打开或切换项目；当前：${project?.name || '加载中'}` : `当前项目：${project?.name || '加载中'}；切换其他项目`" :aria-label="compact ? '打开或切换项目' : '项目工作区'">
      <el-icon v-if="compact" aria-hidden="true"><FolderAdd /></el-icon>
      <template v-else><span class="current-project-name">{{ project?.name || '加载中…' }}</span><el-icon aria-hidden="true"><ArrowDown /></el-icon></template>
    </summary>
    <section class="project-picker" :style="pickerStyle" aria-label="切换其他项目">
      <header class="picker-heading"><div><strong>项目工作区</strong><p>在当前页面切换，后台任务继续运行。</p></div><button class="ghost picker-refresh" :disabled="loading" title="刷新项目列表" aria-label="刷新项目列表" @click="loadProjects"><el-icon><Refresh /></el-icon></button></header>
      <label class="picker-search"><el-icon aria-hidden="true"><Search /></el-icon><input ref="searchInput" v-model="query" type="search" placeholder="搜索项目或拥有者" aria-label="筛选工作区项目" /></label>
      <p v-if="loading && !projects.length" class="picker-message" role="status">正在加载项目…</p>
      <div v-else-if="error" class="picker-message picker-error" role="alert">{{ error }}<button class="ghost" @click="loadProjects">重试</button></div>
      <ul v-else class="picker-list">
        <li v-for="item in filtered" :key="item.publicId || item.id">
          <div v-if="isCurrent(item)" class="picker-project is-current" aria-current="page">
            <span class="project-label"><strong :title="item.name">{{ item.name }}</strong><small>{{ accessLabel(item) }}</small></span>
            <ProjectNotificationBadge :pending-review-count="item.pendingReviewCount" />
            <span class="current-label">当前</span>
          </div>
          <a v-else class="picker-project" :href="projectPath(item)" :aria-label="projectLinkLabel(item)" @click="selectProject($event, item)">
            <span class="project-label"><strong :title="item.name">{{ item.name }}</strong><small>{{ item.ownerName }} · {{ accessLabel(item) }}</small></span>
            <ProjectNotificationBadge :pending-review-count="item.pendingReviewCount" :unread-completion="item.unreadCompletion" />
            <el-icon aria-hidden="true"><ArrowRight /></el-icon>
          </a>
        </li>
        <li v-if="!filtered.length" class="picker-message">{{ query.trim() ? '没有匹配的项目' : '暂无其他项目' }}</li>
      </ul>
      <a class="picker-footer" href="/" @click="showProjects">项目列表与新建项目<el-icon aria-hidden="true"><ArrowRight /></el-icon></a>
    </section>
  </details>
</template>

<style scoped>
.project-switcher { min-width: 40px; max-width: min(30vw, 400px); flex-shrink: 1; }
summary { display: flex; align-items: center; gap: 7px; min-height: 32px; padding: 5px 7px; border-radius: 7px; cursor: pointer; color: var(--fg); list-style: none; }
summary::-webkit-details-marker { display: none; }
summary:hover, details[open] > summary { background: var(--bg-hover); }
summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.current-project-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; font-weight: 650; letter-spacing: -.2px; }
summary > .el-icon { font-size: 11px; color: var(--fg-dim); flex: none; }
.project-picker { position: fixed; z-index: 80; width: min(370px, calc(100vw - 32px)); display: flex; flex-direction: column; padding: 14px; background: var(--glass-strong); border: 1px solid var(--glass-edge); border-radius: 14px; box-shadow: var(--glass-highlight), var(--shadow-lg); -webkit-backdrop-filter: var(--glass-filter); backdrop-filter: var(--glass-filter); }
.picker-heading { display: flex; align-items: flex-start; gap: 8px; margin-bottom: 12px; }
.picker-heading > div { flex: 1; min-width: 0; }.picker-heading strong { font-size: 13px; }.picker-heading p { margin: 5px 0 0; font-size: 11px; line-height: 1.6; color: var(--fg-dim); }
.picker-refresh { display: grid; place-items: center; flex: none; width: 28px; height: 28px; padding: 5px; }.picker-refresh:disabled { opacity: .45; }
.picker-search { display: flex; align-items: center; gap: 7px; padding: 6px 9px; border: 1px solid var(--border); border-radius: 8px; color: var(--fg-dim); flex: none; }
.picker-search:focus-within { border-color: var(--accent); }.picker-search input { width: 100%; min-width: 0; padding: 3px 0; border: none; outline: none; background: transparent; color: var(--fg); font: inherit; font-size: 12px; }.picker-search input:focus-visible { outline: none; box-shadow: none; }
.picker-list { list-style: none; margin: 10px -5px 7px; padding: 0 5px; min-height: 0; max-height: min(360px, 48dvh); overflow-y: auto; overscroll-behavior: contain; }
.picker-project { display: flex; align-items: center; gap: 10px; padding: 10px; border-radius: 8px; color: var(--fg); text-decoration: none; }
a.picker-project:hover, a.picker-project:focus-visible { background: var(--bg-hover); }.picker-project.is-current { background: var(--accent-soft, var(--bg3)); }.project-label { flex: 1; min-width: 0; }.project-label strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 550; }.project-label small { display: block; margin-top: 5px; font-size: 10px; color: var(--fg-dim); }.current-label { font-size: 10px; color: var(--accent); flex: none; }.picker-project > .el-icon { font-size: 13px; color: var(--fg-dim); flex: none; }
.picker-message { padding: 14px 6px; margin: 0; color: var(--fg-dim); font-size: 12px; line-height: 1.6; }.picker-error { color: var(--danger); }.picker-error button { margin-left: 8px; }
.picker-footer { display: flex; align-items: center; justify-content: space-between; flex: none; padding: 10px 8px 1px; border-top: 1px solid var(--border); color: var(--accent); text-decoration: none; font-size: 11px; }.picker-footer:hover { text-decoration: underline; }
@media (max-width: 760px) { .project-switcher { flex: 1; max-width: none; }.current-project-name { font-size: 13px; } summary { padding-inline: 4px; }.project-picker { left: 16px; top: 50px; } }

.project-switcher.compact { flex: 0 0 auto; align-self: center; min-width: 0; max-width: none; width: 36px; }
.project-switcher.compact > summary { justify-content: center; gap: 0; width: 36px; min-height: 38px; padding: 8px; border-radius: 9px; }
.project-switcher.compact > summary > .el-icon { font-size: 18px; color: var(--fg-muted, var(--fg-dim)); }
.project-switcher.compact > summary:hover, .project-switcher.compact[open] > summary { background: var(--accent-soft, var(--bg3)); }
.project-switcher.compact > summary:hover > .el-icon, .project-switcher.compact[open] > summary > .el-icon { color: var(--accent); }

/* ---- visual refinement layer (presentation only) ---- */
summary { transition: background-color var(--motion-hover) var(--ease-standard); }
.current-project-name { letter-spacing: -.01em; }
.picker-heading strong { letter-spacing: -.01em; font-weight: 650; }
.picker-refresh { border-radius: 7px; transition: background-color var(--motion-hover) var(--ease-standard), color var(--motion-hover) var(--ease-standard); }
.picker-search { border-radius: var(--radius-sm); background: color-mix(in srgb, var(--bg2) 60%, transparent); transition: border-color var(--motion-hover) var(--ease-standard), box-shadow var(--motion-hover) var(--ease-standard); }
.picker-search:focus-within { box-shadow: 0 0 0 3px var(--focus-ring); }
.picker-list { scrollbar-width: thin; scrollbar-color: color-mix(in srgb, var(--fg-muted) 38%, transparent) transparent; }
.picker-project { border-radius: var(--radius-sm); transition: background-color var(--motion-hover) var(--ease-standard); }
.picker-project > .el-icon { transition: transform var(--motion-hover) var(--ease-standard), color var(--motion-hover) var(--ease-standard); }
a.picker-project:hover > .el-icon, a.picker-project:focus-visible > .el-icon { transform: translateX(2px); color: var(--accent); }
.project-label strong { font-weight: 600; }
.picker-project.is-current { box-shadow: inset 2px 0 0 var(--accent); }
.current-label { padding: 2px 8px; border-radius: 999px; background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--accent-hover); font-weight: 650; letter-spacing: .02em; }
.picker-footer { border-top-color: color-mix(in srgb, var(--border) 72%, transparent); font-weight: 600; letter-spacing: .01em; }
.picker-footer > .el-icon { transition: transform var(--motion-hover) var(--ease-standard); }
.picker-footer:hover > .el-icon { transform: translateX(2px); }
@media (prefers-reduced-motion: reduce) {
  summary, .picker-refresh, .picker-search, .picker-project, .picker-project > .el-icon, .picker-footer > .el-icon { transition: none; }
  a.picker-project:hover > .el-icon, a.picker-project:focus-visible > .el-icon, .picker-footer:hover > .el-icon { transform: none; }
}
@media (forced-colors: active) {
  .picker-project.is-current { box-shadow: none; }
  .current-label { background: Canvas; color: CanvasText; border: 1px solid CanvasText; }
}
</style>
