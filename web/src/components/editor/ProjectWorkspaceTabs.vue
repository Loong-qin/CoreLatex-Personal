<script setup>
import { ref } from 'vue';
import { Close } from '@element-plus/icons-vue';
import { projectPath } from '../../lib/projectNavigation.js';
import { projectNotificationLabel } from '../../lib/projectNotification.js';
import ProjectNotificationBadge from './ProjectNotificationBadge.vue';

const props = defineProps({
  projects: { type: Array, default: () => [] },
  activeProjectId: { type: [String, Number], default: null },
  vertical: { type: Boolean, default: false },
});
const emit = defineEmits(['activate', 'close']);
const tabs = ref(null);
function projectId(project) { return String(project.publicId || project.id); }
function projectTitle(project) {
  return [project.name, project.busyLabel, project.statusLabel,
    projectNotificationLabel(project.pendingReviewCount, !isActive(project) && project.unreadCompletion)]
    .filter(Boolean).join(' · ');
}
function projectInitials(project) {
  const name = String(project.name || '').trim();
  const words = name.split(/[\s_\-–—]+/).filter(Boolean);
  if (words.length > 1 && /^[A-Za-z0-9]/.test(name)) return words.slice(0, 2).map(word => Array.from(word)[0]).join('').toUpperCase();
  return Array.from(name).slice(0, 2).join('').toUpperCase() || '项';
}
function isActive(project) { return projectId(project) === String(props.activeProjectId); }
function activate(event, project) {
  // Optional native browser gestures remain available, but plain clicks stay here.
  if (event.defaultPrevented || event.button > 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  emit('activate', project);
}
function onKey(event, project) {
  if (event.key === 'Delete') {
    event.preventDefault(); emit('close', project); return;
  }
  if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); event.currentTarget.click(); return; }
  const previousKey = props.vertical ? 'ArrowUp' : 'ArrowLeft';
  const nextKey = props.vertical ? 'ArrowDown' : 'ArrowRight';
  if (![previousKey, nextKey, 'Home', 'End'].includes(event.key)) return;
  const links = [...(tabs.value?.querySelectorAll('[role="tab"]') || [])];
  if (!links.length) return;
  event.preventDefault();
  const index = links.indexOf(event.currentTarget);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? links.length - 1
    : (index + (event.key === nextKey ? 1 : -1) + links.length) % links.length;
  links[next]?.focus();
  links[next]?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
}
</script>

<template>
  <nav v-if="projects.length" class="workspace-project-tabs" :class="{ 'is-vertical': vertical }" aria-label="已打开的项目工作区">
    <span class="workspace-caption" aria-hidden="true">{{ vertical ? '项目' : '工作区' }}</span>
    <div ref="tabs" class="workspace-tabs-scroll" role="tablist" aria-label="项目工作区" :aria-orientation="vertical ? 'vertical' : 'horizontal'">
      <div v-for="project in projects" :key="projectId(project)" class="workspace-project-tab" :class="{ active: isActive(project) }" role="presentation">
        <a class="workspace-tab-link" role="tab" :aria-selected="isActive(project)" :tabindex="isActive(project) ? 0 : -1" :href="projectPath(project)" :title="projectTitle(project)" :aria-label="projectTitle(project)" @click="activate($event, project)" @keydown="onKey($event, project)">
          <span v-if="vertical" class="workspace-tab-monogram" aria-hidden="true">{{ projectInitials(project) }}</span>
          <span class="workspace-tab-name" :aria-hidden="vertical ? true : undefined">{{ project.name }}</span>
          <span v-if="project.busyLabel || project.statusLabel" class="workspace-tab-state"
            :class="{ 'text-only': !project.busyLabel && !project.awaitingAnswer }">
            <span v-if="project.busyLabel" class="state-dot" aria-hidden="true"></span>
            <span v-else-if="project.awaitingAnswer" class="awaiting-answer-dot" aria-hidden="true"></span>
            <span class="workspace-tab-state-text">{{ project.busyLabel || project.statusLabel }}</span>
          </span>
          <ProjectNotificationBadge :pending-review-count="project.pendingReviewCount" :unread-completion="!isActive(project) && !!project.unreadCompletion" />
        </a>
        <button type="button" class="workspace-tab-close" :tabindex="isActive(project) ? 0 : -1" :aria-label="`关闭工作区：${project.name}（后台任务继续运行）`" title="关闭工作区，后台任务继续运行；停止任务请到 CoreAgent 面板" @click.stop="emit('close', project)"><el-icon aria-hidden="true"><Close /></el-icon></button>
      </div>
    </div>
  </nav>
</template>

<style scoped>
.workspace-project-tabs { display: flex; align-items: stretch; min-height: 37px; min-width: 0; flex: none; background: var(--glass-bg); -webkit-backdrop-filter: var(--glass-filter); backdrop-filter: var(--glass-filter); border-bottom: 1px solid var(--border); }
.workspace-caption { display: flex; align-items: center; flex: none; padding: 0 13px; font-size: 10px; color: var(--fg-muted, var(--fg-dim)); letter-spacing: .5px; }
.workspace-tabs-scroll { display: flex; flex: 1; min-width: 0; overflow-x: auto; overflow-y: hidden; overscroll-behavior-x: contain; scrollbar-width: thin; scrollbar-color: var(--border) transparent; }
.workspace-tabs-scroll::-webkit-scrollbar { height: 3px; }
.workspace-project-tab { display: flex; align-items: stretch; flex: 0 0 auto; min-width: 110px; max-width: min(320px, 70vw); position: relative; border-right: 1px solid var(--border); background: var(--surface-muted, var(--bg)); }
.workspace-project-tab.active { background: var(--surface-raised, var(--bg2)); }
.workspace-project-tab.active::after { content: ''; position: absolute; height: 2px; left: 0; right: 0; bottom: 0; background: var(--accent); pointer-events: none; }
.workspace-tab-link { display: flex; align-items: center; gap: 9px; flex: 1; min-width: 0; min-height: 36px; padding: 7px 8px 7px 13px; text-decoration: none; color: var(--fg-dim); font-size: 11px; }
.workspace-tab-link:hover { background: var(--bg-hover); color: var(--fg); }.active .workspace-tab-link { color: var(--accent); }
.workspace-tab-link:focus-visible, .workspace-tab-close:focus-visible { outline: 2px solid var(--accent); outline-offset: -3px; border-radius: 5px; }
.workspace-tab-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.workspace-tab-state { display: inline-flex; align-items: center; gap: 4px; flex: none; font-size: 9px; color: var(--fg-dim); white-space: nowrap; }
.state-dot { width: 5px; height: 5px; border-radius: 50%; background: var(--accent); }
.awaiting-answer-dot { width: 6px; height: 6px; border: 1px solid var(--warn); border-radius: 50%; }
.workspace-tab-close { display: inline-flex; align-items: center; justify-content: center; align-self: center; flex: none; width: 23px; height: 23px; margin: 0 6px 0 0; padding: 5px; border: 0; border-radius: 5px; background: transparent; color: var(--fg-dim); font-size: 11px; cursor: pointer; }
.workspace-tab-close:hover { background: var(--bg-hover); color: var(--fg); }
@media (max-width: 600px) { .workspace-caption { display: none; }.workspace-project-tab { min-width: 100px; }.workspace-tab-link { padding-left: 10px; gap: 6px; }.workspace-tab-state { font-size: 8px; } }

/* The editor mounts this variant below the tool buttons in its narrow rail. */
.workspace-project-tabs.is-vertical { flex-direction: column; flex: 1 1 auto; align-self: stretch; align-items: stretch; min-height: 0; width: 100%; padding-top: 7px; border-bottom: none; border-top: 1px solid var(--border); background: transparent; -webkit-backdrop-filter: none; backdrop-filter: none; }
.is-vertical .workspace-caption { display: block; padding: 3px 0 8px; text-align: center; font-size: 9px; letter-spacing: 0; }
.is-vertical .workspace-tabs-scroll { flex-direction: column; align-items: center; flex: 1 1 auto; gap: 7px; min-height: 0; padding: 2px 0 10px; overflow-x: hidden; overflow-y: auto; overscroll-behavior-y: contain; }
.is-vertical .workspace-tabs-scroll::-webkit-scrollbar { width: 2px; }
.is-vertical .workspace-project-tab { align-items: center; justify-content: center; flex: 0 0 auto; width: 36px; min-width: 0; max-width: none; min-height: 39px; border: none; border-radius: 8px; background: transparent; }
.is-vertical .workspace-project-tab.active { background: var(--accent-soft, var(--bg3)); }
.is-vertical .workspace-project-tab.active::after { left: -5px; right: auto; top: 10px; bottom: auto; width: 3px; height: 19px; border-radius: 0 3px 3px 0; }
.is-vertical .workspace-tab-link { position: relative; display: flex; align-items: center; justify-content: center; flex: 1; width: 36px; min-height: 39px; padding: 6px; border-radius: 8px; }
.is-vertical .workspace-tab-name, .is-vertical .workspace-tab-state-text { display: none; }
.is-vertical .workspace-tab-state.text-only { display: none; }
.workspace-tab-monogram { display: grid; place-items: center; width: 25px; height: 25px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface-raised, var(--bg2)); color: var(--fg-dim); font-size: 10px; line-height: 1; font-weight: 650; letter-spacing: -.3px; }
.is-vertical .active .workspace-tab-monogram { border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); background: var(--accent-soft, var(--bg3)); color: var(--accent); }
.is-vertical .workspace-tab-state { position: absolute; right: 4px; bottom: 5px; padding: 2px; border-radius: 50%; background: var(--surface-raised, var(--bg2)); }
.is-vertical .project-notification { position: absolute; right: 1px; top: 1px; box-shadow: 0 0 0 1.5px var(--surface-raised, var(--bg2)); }
.is-vertical .state-dot { width: 6px; height: 6px; }
.is-vertical .workspace-tab-close { position: absolute; z-index: 1; bottom: 0; left: 0; width: 15px; height: 15px; margin: 0; padding: 2px; border: 1px solid var(--border); border-radius: 5px; background: var(--surface-raised, var(--bg2)); font-size: 9px; opacity: 0; pointer-events: none; }
.is-vertical .workspace-project-tab:hover .workspace-tab-close, .is-vertical .workspace-project-tab:focus-within .workspace-tab-close { opacity: 1; pointer-events: auto; }
@media (hover: none) { .is-vertical .workspace-tab-close { min-height: 21px; height: 21px; opacity: 1; pointer-events: auto; } }


.workspace-project-tabs { background: var(--bg2); -webkit-backdrop-filter: none; backdrop-filter: none; }
.active .workspace-tab-link { color: var(--fg); }
.workspace-project-tab.active::after { background: var(--fg-dim); }
.is-vertical .workspace-project-tab.active { background: var(--bg-hover); }
.is-vertical .active .workspace-tab-monogram { color: var(--fg); background: transparent; border-color: var(--fg-muted); }

/* ---- visual refinement layer (presentation only) ---- */
.workspace-project-tabs { border-bottom-color: color-mix(in srgb, var(--border) 78%, var(--bg2)); }
.workspace-caption { letter-spacing: .12em; font-weight: 600; }
.workspace-project-tab { border-right-color: color-mix(in srgb, var(--border) 65%, var(--bg2)); }
.workspace-tab-link { transition: background-color var(--motion-hover) var(--ease-standard), color var(--motion-hover) var(--ease-standard); }
.active .workspace-tab-link { font-weight: 600; }
.workspace-project-tab.active { box-shadow: var(--glass-highlight); }
.workspace-project-tab.active::after { background: linear-gradient(90deg, var(--accent), color-mix(in srgb, var(--accent-secondary) 45%, var(--accent))); border-radius: 2px 2px 0 0; }
.workspace-tab-close { transition: background-color var(--motion-hover) var(--ease-standard), color var(--motion-hover) var(--ease-standard); }
.state-dot { background: var(--accent); animation: ws-dot-pulse 1.8s var(--ease-standard) infinite; }
@keyframes ws-dot-pulse {
  0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 35%, transparent); }
  50% { box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 12%, transparent); }
}
.workspace-tab-monogram { border-radius: 7px; transition: border-color var(--motion-hover) var(--ease-standard), background-color var(--motion-hover) var(--ease-standard), color var(--motion-hover) var(--ease-standard); }
.is-vertical .workspace-project-tab.active { background: var(--accent-soft); }
.is-vertical .workspace-project-tab.active::after { background: var(--accent); border-radius: 0 3px 3px 0; }
.is-vertical .active .workspace-tab-monogram { color: var(--accent-hover); background: var(--glass-g1-bg); border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); font-weight: 700; }
@media (prefers-reduced-motion: reduce) {
  .workspace-tab-link, .workspace-tab-close, .workspace-tab-monogram { transition: none; }
  .state-dot { animation: none; }
}
@media (forced-colors: active) {
  .workspace-project-tab.active { box-shadow: none; }
  .workspace-project-tab.active::after { background: Highlight; }
  .state-dot { animation: none; background: CanvasText; }
}

</style>
