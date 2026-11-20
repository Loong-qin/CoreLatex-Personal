<template>
  <div class="workspace-shell">
    <ProjectWorkspaceTabs v-if="openedProjects.length && route.name !== 'login' && route.name !== 'editor'" :projects="openedProjects" :active-project-id="route.name === 'editor' ? String(route.params.id) : ''" @activate="activateProject" @close="closeProject" />
    <div class="workspace-content">
      <router-view v-slot="{ Component, route: currentRoute }">
        <KeepAlive :include="cacheNames">
          <component v-if="currentRoute.name === 'editor' && activeSession" :is="activeSession.component" :key="activeSession.publicId" :view="Component" />
        </KeepAlive>
        <component v-if="currentRoute.name !== 'editor'" :is="Component" />
      </router-view>
    </div>
  </div>
  <ContextMenu />
</template>

<script setup>
import { computed, onBeforeUnmount, onUnmounted, provide, shallowRef, watch } from 'vue';
import { getActivePinia } from 'pinia';
import { useRoute, useRouter } from 'vue-router';
import ContextMenu from './components/ContextMenu.vue';
import ProjectWorkspaceTabs from './components/editor/ProjectWorkspaceTabs.vue';
import { createProjectWorkspaces } from './lib/projectWorkspaces.js';
import { WORKSPACE_CONTEXT } from './lib/projectContext.js';
import { useAuthStore } from './stores/auth.js';
import { projectPath } from './lib/projectNavigation.js';
import { api } from './api.js';
import { installCompletionSoundUnlock, setCompletionSoundEnabled, getCompletionSoundRevision, syncCompletionSoundPreference } from './lib/agentCompletionSound.js';
import { readWorkspaceSession, saveWorkspaceSession, clearWorkspaceSession } from './lib/workspaceSession.js';
import { groupPendingChangesetFiles } from './lib/changesetUtils.js';

const RUN_STATUS_POLL_MS = 15_000;
const route = useRoute(), router = useRouter(), auth = useAuthStore();
const workspaces = createProjectWorkspaces(getActivePinia());
const activeSession = shallowRef(null);
const cacheNames = computed(() => workspaces.sessions.map((s) => s.cacheName));
const projectName = (s) => s.editor.project?.name || s.context.name.value || '加载项目…';
const sessionProjects = computed(() => workspaces.sessions.map((s) => ({
  publicId: s.publicId, name: projectName(s), ...s.completion.value,
})));
const openedProjects = computed(() => workspaces.sessions.map((s) => {
  const connectedRun = s.agent.streaming && !s.agent.connectionLost && !s.agent.reconnecting;
  const awaitingAnswer = connectedRun && !!s.agent.pendingQuestion;
  return {
    publicId: s.publicId, name: projectName(s),
    busyLabel: connectedRun && !awaitingAnswer ? 'AI 执行中' : s.editor.compile.status === 'running' ? '编译中' : '',
    statusLabel: awaitingAnswer ? '等待回答' : s.agent.reconnecting ? '正在重连'
      : !connectedRun && (s.agent.connectionLost || s.context.error.value) ? '待重新连接' : '',
    awaitingAnswer,
    pendingReviewCount: groupPendingChangesetFiles(s.editor.pendingChangesets).length,
    unreadCompletion: s.completion.value.unreadCompletion,
  };
}));
provide(WORKSPACE_CONTEXT, {
  projects: openedProjects,
  activeProjectId: computed(() => route.name === 'editor' ? String(route.params.id) : ''),
  activateProject, closeProject,
});
const stopSoundUnlock = installCompletionSoundUnlock();
let soundPreferenceGeneration = 0;
let workspaceUserId = null;
let accountGeneration = 0;
let appDisposed = false;
let restoringSession = false;
let lastActiveProjectId = null;
function persistWorkspaceSession() {
  if (appDisposed || restoringSession || workspaceUserId == null || !auth.token) return;
  saveWorkspaceSession(workspaceUserId, {
    projects: sessionProjects.value,
    activeProjectId: lastActiveProjectId,
  });
}
function saveWorkspaceViews() {
  persistWorkspaceSession();
  for (const session of workspaces.sessions) {
    if (session.mounted) session.editor.saveViewState();
  }
}
function recoverWorkspaceConnections() {
  if (appDisposed || !auth.token) return;
  const generation = accountGeneration;
  for (const session of workspaces.sessions) {
    if (session.disposed) continue;
    if (session.agent.connectionLost) {
      void session.agent.reconnectRun();
    } else if (session.context.error.value && !session.mounted) {
      session.agent.restoreActiveRun(session.publicId, { strictRestore: true }).then(() => {
        if (!appDisposed && generation === accountGeneration && !session.disposed) session.context.error.value = '';
      }).catch(() => {});
    }
  }
}
function onVisibilityChange() {
  if (document.visibilityState === 'hidden') saveWorkspaceViews();
  else if (document.visibilityState === 'visible') recoverWorkspaceConnections();
}
watch(() => workspaces.sessions.some(session => session.agent.connectionLost), (lost, _, onCleanup) => {
  if (!lost) return;
  const timer = window.setInterval(() => {
    if (!auth.token || !navigator.onLine) return;
    for (const session of workspaces.sessions) if (!session.disposed && session.agent.connectionLost) {
      void session.agent.refreshRunStatus();
    }
  }, RUN_STATUS_POLL_MS);
  onCleanup(() => window.clearInterval(timer));
});
async function restoreWorkspaceSession(userId) {
  const generation = ++accountGeneration;
  restoringSession = true;
  const saved = readWorkspaceSession(userId);
  // Read the whole snapshot before opening anything: synchronous persistence of
  // the current route must not overwrite the other saved tabs during startup.
  const restored = saved.projects.map(project => workspaces.open(project.publicId, project.name, project));
  const extras = workspaces.sessions.filter(session => !restored.includes(session));
  workspaces.sessions.splice(0, workspaces.sessions.length, ...restored, ...extras);
  lastActiveProjectId = route.name === 'editor' ? String(route.params.id) : saved.activeProjectId;
  workspaceUserId = String(userId);
  restoringSession = false;
  persistWorkspaceSession();
  if (!restored.length) return;
  const current = () => !appDisposed && generation === accountGeneration && workspaceUserId === String(userId) && !!auth.token;
  try {
    // Summary requests avoid recursively scanning storage for every saved project.
    const [active, archived] = await Promise.all([
      api.get('/api/projects?view=all&summary=1'),
      api.get('/api/projects?view=archived&summary=1'),
    ]);
    if (!current()) return;
    if (!Array.isArray(active.projects) || !Array.isArray(archived.projects)) throw new Error('项目列表暂不可用');
    const accessible = new Map([...active.projects, ...archived.projects]
      .filter(project => !project.deleted).map(project => [String(project.publicId || project.id), project]));
    // Restore in a few lanes so many saved background projects cannot crowd
    // out the visible project's initial metadata and file requests.
    const pending = restored[Symbol.iterator]();
    const restoreNext = async () => {
      for (const session of pending) {
        if (!current() || session.disposed || !workspaces.sessions.includes(session)) continue;
        const project = accessible.get(session.publicId);
        if (!project) {
          // The visible editor handles its own access error and redirect.
          if (session !== activeSession.value) workspaces.remove(session.publicId);
          continue;
        }
        session.context.name.value = project.name;
        if (session.mounted || session === activeSession.value) continue;
        session.editor.projectId = session.publicId;
        const pendingReviews = session.editor.loadPendingChangesets();
        try {
          // Idle projects need only a cheap active-run check. Real live runs
          // retain the existing history and event-replay restoration behavior.
          if (!project.archived) await session.agent.restoreActiveRun(session.publicId, { strictRestore: true });
        } catch {
          if (current() && !session.disposed && !session.mounted && session !== activeSession.value) session.context.error.value = '连接未恢复，打开项目后重试';
        }
        await pendingReviews;
      }
    };
    await Promise.all(Array.from({ length: Math.min(restored.length, 4) }, restoreNext));
  } catch {
    // A transient network error must never erase a valid saved workspace list.
    if (current()) for (const session of restored) {
      if (!session.disposed && !session.mounted && session !== activeSession.value) session.context.error.value = '连接未恢复，打开项目后重试';
    }
  }
}
watch(() => [route.name, route.params.id], ([name, id]) => {
  activeSession.value = name === 'editor' && id ? workspaces.open(id) : null;
  if (activeSession.value) lastActiveProjectId = activeSession.value.publicId;
  workspaces.activate(activeSession.value?.publicId);
  persistWorkspaceSession();
}, { immediate: true, flush: 'sync' });
watch(sessionProjects, persistWorkspaceSession, { flush: 'sync' });
function clearAccountSession() {
  soundPreferenceGeneration++;
  setCompletionSoundEnabled(false);
  if (workspaceUserId != null) clearWorkspaceSession(workspaceUserId);
  workspaceUserId = null;
  accountGeneration++;
  activeSession.value = null;
  workspaces.clear();
}
watch(() => auth.token, (token, previous) => {
  if (previous && token !== previous) clearAccountSession();
}, { flush: 'sync' });
watch(() => auth.user?.id, (id, previous) => {
  if (previous != null && id !== previous) clearAccountSession();
  if (id != null && auth.token && workspaceUserId !== String(id)) {
    const soundGeneration = ++soundPreferenceGeneration;
    setCompletionSoundEnabled(false);
    const soundRevision = getCompletionSoundRevision();
    api.get('/api/settings/ai').then(settings => {
      if (!appDisposed && soundGeneration === soundPreferenceGeneration && auth.user?.id === id && auth.token) {
        syncCompletionSoundPreference(settings.agentConfig?.completionSound !== false, soundRevision);
      }
    }).catch(() => {});
    restoreWorkspaceSession(id);
    if (route.name === 'editor' && route.params.id) {
      activeSession.value = workspaces.open(route.params.id);
      workspaces.activate(activeSession.value.publicId);
    }
  }
}, { immediate: true, flush: 'sync' });
window.addEventListener('pagehide', saveWorkspaceViews);
window.addEventListener('beforeunload', saveWorkspaceViews);
window.addEventListener('online', recoverWorkspaceConnections);
document.addEventListener('visibilitychange', onVisibilityChange);
function activateProject(project) { router.push(projectPath(project)); }
async function closeProject(project) {
  const id = String(project.publicId || project.id);
  if (route.name === 'editor' && String(route.params.id) === id) {
    const next = workspaces.sessions.find((s) => s.publicId !== id);
    await router.push(next ? projectPath(next) : '/');
  }
  workspaces.remove(id);
}
onBeforeUnmount(() => {
  saveWorkspaceViews();
  appDisposed = true;
  soundPreferenceGeneration++;
  stopSoundUnlock();
  accountGeneration++;
  window.removeEventListener('pagehide', saveWorkspaceViews);
  window.removeEventListener('beforeunload', saveWorkspaceViews);
  window.removeEventListener('online', recoverWorkspaceConnections);
  document.removeEventListener('visibilitychange', onVisibilityChange);
});
onUnmounted(() => workspaces.dispose());
</script>

<style scoped>
.workspace-shell { height: 100%; display: flex; flex-direction: column; overflow: hidden; }
.workspace-content { flex: 1; min-height: 0; }
.workspace-shell :deep(.workspace-project-tabs) { background: var(--glass-g1-bg); -webkit-backdrop-filter: var(--glass-g1-filter); backdrop-filter: var(--glass-g1-filter); }
</style>
