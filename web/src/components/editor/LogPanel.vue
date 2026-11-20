<template>
  <div class="log-panel">
    <div class="panel-head">
      <el-icon class="head-glyph" aria-hidden="true"><Tickets /></el-icon>
      <span class="title">编译日志</span>
      <span class="grow"></span>
      <el-button text size="small" title="刷新日志与历史" @click="refresh">↻ 刷新</el-button>
    </div>

    <!-- 编译历史 -->
    <div v-if="jobs.length" class="jobs">
      <div
        v-for="j in jobs"
        :key="j.id"
        class="job-item"
        :class="{ on: viewingJob === j.id }"
        @click="viewJob(j)"
      >
        <span class="job-status" :class="j.status">{{ statusIcon(j.status) }}</span>
        <span class="job-engine mono">{{ j.engine || 'latexmk' }}</span>
        <span class="muted">{{ j.durationMs ? (j.durationMs / 1000).toFixed(1) + 's' : '' }}</span>
        <span class="grow"></span>
        <span v-if="j.userName" class="muted">{{ j.userName }}</span>
        <span class="muted">{{ timeAgo(j.createdAt) }}</span>
      </div>
    </div>

    <pre v-if="shownLog" ref="retainedScrollEl" class="log-body mono">{{ shownLog }}</pre>
    <div v-else class="empty muted"><el-icon class="empty-glyph" aria-hidden="true"><Document /></el-icon>尚未编译</div>
  </div>
</template>

<script setup>
import { useRetainedScroll } from '../../lib/retainedScroll.js';
import { ref, computed, onMounted } from 'vue';
import { api, timeAgo } from '../../api.js';
import { useEditorStore } from '../../stores/editor.js';
import { useUiStore } from '../../stores/ui.js';

const store = useEditorStore();
const ui = useUiStore();

const jobs = ref([]);
const viewingJob = ref(null); // null = 最新日志（store.logContent）
const jobLog = ref('');
const retainedScrollEl = ref(null);
useRetainedScroll(retainedScrollEl, { scope: store, key: () => 'log:' + viewingJob.value, active: () => store.rightTab === 'log' });

const shownLog = computed(() => (viewingJob.value == null ? store.logContent : jobLog.value));

function statusIcon(status) {
  if (status === 'success') return '✔';
  if (status === 'failed') return '✘';
  return '…';
}

async function loadJobs() {
  try {
    const r = await api.get(`/api/projects/${store.projectId}/compile/jobs`);
    jobs.value = r.jobs || r || [];
  } catch {
    jobs.value = [];
  }
}

async function viewJob(j) {
  if (viewingJob.value === j.id) {
    viewingJob.value = null; // 切回最新日志
    return;
  }
  viewingJob.value = j.id;
  jobLog.value = '';
  try {
    const res = await api.raw(`/api/projects/${store.projectId}/log?jobId=${j.id}`);
    jobLog.value = await res.text();
  } catch (e) {
    jobLog.value = '';
    ui.error(e.message || '获取该次编译日志失败');
  }
}

async function refresh() {
  viewingJob.value = null;
  await Promise.all([store.loadLog(), loadJobs()]);
}

onMounted(refresh);
</script>

<style scoped>
.log-panel {
  padding: 12px;
  display: flex;
  flex-direction: column;
  height: 100%;
  box-sizing: border-box;
}
.panel-head { display: flex; align-items: center; margin-bottom: 10px; flex-shrink: 0; }
.title { font-size: 13px; font-weight: 600; }
.grow { flex: 1; }
.jobs { margin-bottom: 10px; flex-shrink: 0; }
.job-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  margin-bottom: 4px;
  font-size: 12px;
  cursor: pointer;
}
.job-item:hover { background: var(--bg-hover); }
.job-item.on { border-color: var(--accent); }
.job-status.success { color: var(--accent); }
.job-status.failed { color: var(--danger); }
.job-engine { color: var(--blue); }
.log-body {
  flex: 1;
  min-height: 0;
  margin: 0;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 10px;
  font-size: 11.5px;
  line-height: 1.5;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-all;
}
.empty { text-align: center; padding: 32px 0; font-size: 13px; }

/* ---- visual refinement layer (presentation only) ---- */
.panel-head { gap: 7px; }
.head-glyph { flex: none; font-size: 14px; color: var(--accent); opacity: .9; }
.title { font-weight: 650; letter-spacing: .01em; }
.job-item { border-radius: var(--radius-sm); border-color: color-mix(in srgb, var(--border) 85%, var(--bg2)); background: var(--glass-g1-bg); transition: background-color var(--motion-hover) var(--ease-standard), border-color var(--motion-hover) var(--ease-standard); }
.job-item:hover { border-color: color-mix(in srgb, var(--accent) 35%, var(--border)); }
.job-item.on { border-color: color-mix(in srgb, var(--accent) 60%, var(--border)); background: var(--accent-soft); box-shadow: inset 2px 0 0 var(--accent); }
.job-status { flex: none; width: 15px; text-align: center; font-weight: 700; }
.job-status.success { color: var(--success); }
.job-status.failed { color: var(--danger); }
.job-status:not(.success):not(.failed) { color: var(--warn); animation: log-job-pulse 1.6s var(--ease-standard) infinite; }
@keyframes log-job-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .45; } }
.job-engine { color: var(--accent-hover); font-weight: 600; }
.job-item .muted { font-variant-numeric: tabular-nums; }
.log-body { background: color-mix(in srgb, var(--bg) 70%, var(--surface-muted)); border-color: color-mix(in srgb, var(--border) 85%, var(--bg2)); border-radius: var(--radius-sm); scrollbar-width: thin; scrollbar-color: color-mix(in srgb, var(--fg-muted) 38%, transparent) transparent; }
.empty { display: flex; flex-direction: column; align-items: center; gap: 8px; color: var(--fg-muted); letter-spacing: .01em; }
.empty-glyph { font-size: 24px; color: color-mix(in srgb, var(--accent) 45%, var(--fg-muted)); opacity: .8; }
@media (prefers-reduced-motion: reduce) {
  .job-item { transition: none; }
  .job-status:not(.success):not(.failed) { animation: none; }
}
@media (forced-colors: active) {
  .head-glyph, .empty-glyph { color: CanvasText; }
  .job-item.on { box-shadow: none; }
  .job-status:not(.success):not(.failed) { animation: none; }
}
</style>
