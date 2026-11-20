<script setup>
// 一轮对话按发生顺序展示思考、叙述和工具；每段思考与工具详情独立折叠。
// rows 由 lib/agentUtils.js 的 buildTimeline 产出；进行中的一轮传 live 打开计时与转圈。
import { ref, shallowRef, computed, useId, watch, onBeforeUnmount } from 'vue';
import {
  Files, Document, FolderOpened, DocumentAdd, EditPen, CopyDocument,
  Monitor, View, Reading, MagicStick, Operation, CloseBold,
  VideoPlay, DocumentChecked, Search, Link, Setting,
} from '@element-plus/icons-vue';
import { renderMarkdownToHtml } from '../../lib/markdown2html.js';
import { formatDuration, toolIcon } from '../../lib/agentUtils.js';
import AgentThinkingBlock from './AgentThinkingBlock.vue';
import AgentToolResult from './AgentToolResult.vue';
import AgentWorkerPopover from './AgentWorkerPopover.vue';
import { groupAgentProcessRows } from '../../lib/agentWorkerRuns.js';
import { toolLabel } from '../../lib/toolMetadata.js';
import { api, getToken } from '../../api.js';

const ICONS = {
  Files, Document, FolderOpened, DocumentAdd, EditPen, CopyDocument,
  Monitor, View, Reading, MagicStick, Operation,
  VideoPlay, DocumentChecked, Search, Link, Setting,
};

// 失败步骤用叉号，其余按工具类型给图标（SVG，避免文本字形缺字变方块）
function iconOf(r) {
  if (r.state === 'error') return CloseBold;
  return ICONS[toolIcon(r.name)] || Operation;
}

const props = defineProps({
  rows: { type: Array, default: () => [] },
  projectId: { type: String, default: '' },
  chatId: { type: Number, default: null },
  graph: { type: Object, default: null },
  answerHtml: { type: String, default: '' },
  durationMs: { type: Number, default: null },
  live: { type: Boolean, default: false },
  active: { type: Boolean, default: true },
  compact: { type: Boolean, default: false },
  resolveImage: { type: Function, default: null },
  thinkingReadings: { type: Map, default: () => new Map() },
});

const legacyPlaceholders = new Set([
  '正在检查请求与项目上下文，关键判断和执行计划会显示在这里。',
  '模型正在整理信息，执行计划与关键判断会以简短摘要展示。',
]);
const processRows = computed(() => groupAgentProcessRows(props.rows, props.graph).filter((row) =>
  !(row.kind === 'thinking' && !row.text?.trim()) &&
  !(row.kind === 'tool' && row.name === 'report_progress') &&
  !(row.kind === 'activity' && legacyPlaceholders.has(row.text?.trim()))
));
const recoveryDownloads = ref({});
let recoveryGeneration = 0, disposed = false;
watch(() => [props.projectId, props.chatId, props.active], () => {
  recoveryGeneration++; recoveryDownloads.value = {};
}, { flush: 'sync' });
onBeforeUnmount(() => { disposed = true; recoveryGeneration++; });
function recoveryFor(row) {
  const r = row.recovery;
  if (!r || r.projectId !== props.projectId || r.chatId !== props.chatId ||
      !Number.isSafeInteger(r.draftId) || r.draftId <= 0 ||
      !Number.isSafeInteger(r.version) || r.version < 0 ||
      !Number.isSafeInteger(r.chatId) || r.chatId <= 0 ||
      !/^[A-Za-z0-9_-]+$/.test(r.projectId)) return null;
  return r;
}
async function downloadRecovery(row) {
  const r = recoveryFor(row), token = getToken();
  if (!r || !props.active || !token || recoveryDownloads.value[r.draftId]?.busy) return;
  const ticket = recoveryGeneration, projectId = props.projectId, chatId = props.chatId;
  const current = () => !disposed && ticket === recoveryGeneration && props.active &&
    props.projectId === projectId && props.chatId === chatId && getToken() === token;
  recoveryDownloads.value[r.draftId] = { busy: true, error: '' };
  try {
    const response = await api.raw(`/api/projects/${encodeURIComponent(projectId)}/agent/drafts/${r.draftId}?chatId=${chatId}`, { cache: 'no-store' });
    if (!current()) return;
    const blob = await response.blob();
    if (!current()) return;
    const url = URL.createObjectURL(blob);
    try {
      const link = document.createElement('a');
      link.href = url; link.download = `corelatex-draft-${r.draftId}-v${r.version}.json`;
      link.click();
    } finally { URL.revokeObjectURL(url); }
  } catch (error) {
    if (current()) recoveryDownloads.value[r.draftId] = { busy: false, error: error.message || '下载失败，请重试' };
  } finally {
    if (current() && recoveryDownloads.value[r.draftId]) recoveryDownloads.value[r.draftId].busy = false;
  }
}

function activityLabel(row) {
  if (row.phase === 'retry') return '系统重试';
  if (row.phase === 'waiting') return '系统等待';
  return row.source === 'model' || row.phase === 'planning' ? '进展摘要' : '系统进度';
}
const processExpanded = ref(props.live || props.compact);
const processId = 'agent-process-' + useId();
watch(() => props.live, live => { processExpanded.value = props.compact || live; });
function toggleProcess() {
  if (!props.live && processRows.value.length) processExpanded.value = !processExpanded.value;
}
const open = ref({}); // Stable tool identity keeps open image results mounted during regrouping.

const workerOpen = ref(false), selectedExecutionId = ref('');
const workerAnchor = shallowRef(null);
const workerPopoverId = 'agent-worker-' + useId();
const selectedWorker = computed(() => processRows.value.find(row => row.kind === 'agent_run' && row.run.executionId === selectedExecutionId.value)?.run || null);
const selectedWorkerRows = computed(() => {
  const run = selectedWorker.value;
  if (!run) return [];
  const rows = props.rows.filter(row => ['tool', 'activity'].includes(row.kind) &&
    (row.agentExecutionId ? row.agentExecutionId === run.executionId : row.agentId && `${row.agentId}:legacy` === run.executionId));
  return (rows.length ? rows : [...run.activities, ...run.tools]).map(row => ({ ...row, ...(row.kind === 'tool' ? { label: toolLabel(row.name) } : {}), agentId: undefined, agentExecutionId: undefined }));
});
function toggleWorker(run, anchor) {
  if (workerOpen.value && selectedExecutionId.value === run.executionId) { workerOpen.value = false; return; }
  selectedExecutionId.value = run.executionId; workerAnchor.value = anchor; workerOpen.value = true;
}
watch(selectedWorker, run => { if (!run) workerOpen.value = false; });
watch(() => props.active && processExpanded.value, active => { if (!active) workerOpen.value = false; });

function rowKey(row, index) {
  if (row.kind === 'agent_run') return `agent:${row.run.executionId}`;
  if (row.kind === 'tool') return `tool:${row.toolCallId || row.key || index}`;
  return row.key || `row:${index}`;
}
function workerState(run) {
  if (run.takeover?.by === 'coordinator') return '资源受限 · 主智能体已接管';
  if (run.resourceFailure?.code) return '资源受限';
  if (run.status === 'running' && run.activities?.some(row => row.phase === 'reporting')) return '正在汇报';
  const state = { pending: '待开始', running: '正在工作', waiting: '等待中', completed: '已完成', failed: '执行失败', cancelled: '已取消', interrupted: '已中断', skipped: '已跳过', blocked: '受阻' }[run.status] || '状态待确认';
  if (run.status === 'completed' && run.report?.verdict === 'needs_changes') return `${state} · 需修正`;
  if (run.status === 'completed' && run.report?.verdict === 'blocked') return `${state} · 受阻`;
  return state;
}

const headText = computed(() => {
  const d = formatDuration(props.durationMs);
  if (d) return `已工作 ${d}`;
  return props.live ? '已工作' : '本轮';
});

// 叙述步骤的 Markdown（按 rows 缓存，流式 token 不重排历史行）
const textHtml = computed(() =>
  processRows.value.map((r) =>
    r.kind === 'text' ? renderMarkdownToHtml(r.text, { breaks: true, resolveImage: props.resolveImage }) : ''
  )
);

function rowTitle(r, i) {
  const parts = [`${r.label}${r.summary ? ` ${r.summary}` : ''}`];
  const d = formatDuration(r.ms);
  if (d) parts.push(`耗时 ${d}`);
  parts.push(open.value[rowKey(r, i)] ? '收起详情' : '查看详情');
  return parts.join(' · ');
}

function toggle(row, index) {
  const key = rowKey(row, index);
  open.value[key] = !open.value[key];
}
</script>

<template>
  <div v-if="processRows.length || answerHtml || live" class="timeline">
    <component v-if="!compact" :is="!live && processRows.length ? 'button' : 'div'" class="tl-head"
      :class="{ 'tl-head-toggle': !live && processRows.length }"
      :type="!live && processRows.length ? 'button' : undefined"
      :aria-expanded="!live && processRows.length ? processExpanded : undefined"
      :aria-controls="!live && processRows.length ? processId : undefined"
      :title="!live && processRows.length ? (processExpanded ? '收起工作过程' : '展开工作过程') : undefined"
      @click="toggleProcess">
      <svg class="tl-head-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></svg>
      <span class="tl-head-text">{{ headText }}</span>
      <span v-if="live" class="tl-spin"></span>
      <template v-else-if="processRows.length">
        <span class="tl-process-hint">{{ processExpanded ? '收起工作过程' : '展开工作过程' }}</span>
        <svg class="tl-chevron" :class="{ expanded: processExpanded }" viewBox="0 0 12 12" aria-hidden="true"><path d="m4 2 4 4-4 4" /></svg>
      </template>
    </component>

    <div v-if="processRows.length" v-show="processExpanded" :id="processId" class="tl-steps">
      <template v-for="(r, i) in processRows" :key="rowKey(r, i)">
        <AgentThinkingBlock
          v-if="r.kind === 'thinking'"
          :text="r.text"
          :duration-ms="r.durationMs"
          :started-at="r.startedAt"
          :live="live"
          :reading-state="thinkingReadings.get(i)"
          @reading-change="thinkingReadings.set(i, $event)"
        />
        <!-- 叙述步骤：正常正文样式 -->
        <!-- eslint-disable-next-line vue/no-v-html -->
        <div v-else-if="r.kind === 'text'" class="tl-text md-chat" v-html="textHtml[i]"></div>
        <div v-else-if="r.kind === 'activity'" class="tl-activity">
          <span class="tl-activity-label">{{ activityLabel(r) }}：</span>{{ r.text }}
          <template v-if="recoveryFor(r)">
            <button type="button" class="tl-recovery-download" :disabled="recoveryDownloads[r.recovery.draftId]?.busy" @click="downloadRecovery(r)">{{ recoveryDownloads[r.recovery.draftId]?.busy ? '正在下载…' : '下载旧草稿' }}</button>
            <span v-if="recoveryDownloads[r.recovery.draftId]?.error" class="tl-recovery-error" role="status">{{ recoveryDownloads[r.recovery.draftId].error }}</span>
          </template>
        </div>
        <button v-else-if="r.kind === 'agent_run'" type="button" class="tl-agent-run" :class="r.run.status" :data-execution-id="r.run.executionId"
          aria-haspopup="dialog" :aria-expanded="workerOpen && selectedExecutionId === r.run.executionId" :aria-controls="workerOpen && selectedExecutionId === r.run.executionId ? workerPopoverId : undefined" :title="`${r.run.label}${workerState(r.run)} · 查看执行详情`" @click="toggleWorker(r.run, $event.currentTarget)">
          <span v-if="r.run.status === 'running'" class="tl-spin" aria-hidden="true"></span><span v-else class="tl-agent-dot" aria-hidden="true"></span>
          <span class="tl-agent-label">{{ r.run.label }}{{ workerState(r.run) }}</span><span class="tl-agent-more" aria-hidden="true">›</span>
        </button>
        <!-- 工具步骤：结果摘要与耗时，展开查看实际产物 -->
        <div v-else class="tl-step" :class="r.state">
          <button type="button" class="tl-row" :aria-expanded="!!open[rowKey(r, i)]" :title="rowTitle(r, i)" @click="toggle(r, i)">
            <span class="tl-icon">
              <span v-if="r.state === 'running'" class="tl-spin"></span>
              <el-icon v-else><component :is="iconOf(r)" /></el-icon>
            </span>
            <span class="tl-phrase">{{ r.label }}</span>
            <span v-if="r.display?.summary || r.summary" class="tl-summary" :title="r.summary">{{ r.mcp ? r.summary : (r.display?.summary || r.summary) }}</span>
            <span class="tl-row-status">{{ r.state === 'running' ? '进行中' : r.state === 'error' ? '失败' : r.state === 'cancelled' ? '已取消' : '' }}</span>
            <span v-if="r.ms != null" class="tl-duration">{{ formatDuration(r.ms) }}</span>
            <svg class="tl-chevron" :class="{ expanded: open[rowKey(r, i)] }" viewBox="0 0 12 12" aria-hidden="true"><path d="m4 2 4 4-4 4" /></svg>
          </button>

          <div v-if="open[rowKey(r, i)] && r.hasBody" class="tl-body">
            <AgentToolResult :row="r" :active="processExpanded && active" />
          </div>
        </div>
      </template>
    </div>

    <AgentWorkerPopover v-model="workerOpen" :id="workerPopoverId" :anchor="workerAnchor" :run="selectedWorker" :active="active && processExpanded">
      <AgentTimeline v-if="selectedWorker" :key="selectedWorker.executionId" :rows="selectedWorkerRows" compact :active="active && workerOpen"
        :live="['running', 'waiting'].includes(selectedWorker.status)" :resolve-image="resolveImage" />
    </AgentWorkerPopover>

    <!-- 最终回答：始终可见 -->
    <div v-if="answerHtml || live && !compact" class="tl-answer">
      <!-- eslint-disable-next-line vue/no-v-html -->
      <div class="md-chat" :class="{ 'is-streaming': live }" v-html="answerHtml"></div>
    </div>
  </div>
</template>

<style scoped>
.tl-agent-run { display: flex; align-items: center; gap: 7px; width: 100%; min-width: 0; padding: 5px 0; border: 0; border-radius: 4px; background: transparent; color: var(--fg-dim); text-align: left; cursor: pointer; }
.tl-agent-label { min-width: 0; flex: 1; font-size: 11.5px; line-height: 1.5; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.tl-agent-dot { width: 6px; height: 6px; border: 1px solid currentColor; border-radius: 50%; flex: none; margin-inline: 3px; }
.tl-agent-more { flex: none; font-size: 17px; line-height: 1; }
.tl-agent-run.running { color: var(--accent); }.tl-agent-run.failed { color: var(--danger); }.tl-agent-run.blocked { color: var(--warn); }
.tl-agent-run:hover { color: var(--accent); }.tl-agent-run:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

.tl-activity { padding: 2px 0; font-size: 11.5px; line-height: 1.5; color: var(--fg-dim); white-space: pre-wrap; overflow-wrap: anywhere; }
.tl-activity-label { font-weight: 600; }
.tl-recovery-download { margin-left: 6px; padding: 0; border: 0; background: transparent; color: var(--accent); font: inherit; cursor: pointer; text-decoration: underline; }
.tl-recovery-download:disabled { cursor: wait; opacity: .6; }
.tl-recovery-error { margin-left: 6px; color: var(--danger); }

.timeline {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
  min-width: 0;
}
.tl-head {
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  background: transparent;
  border: none;
  padding: 0;
  text-align: left;
  font-size: 11.5px;
  line-height: 1.4;
  color: var(--fg-dim);
}
.tl-head-text { flex: none; }
.tl-head-toggle { cursor: pointer; border-radius: 4px; }
.tl-head-toggle:hover { color: var(--fg); }
.tl-head-toggle:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.tl-process-hint { font-size: 11px; margin-left: 4px; }
.tl-chevron { width: 10px; height: 10px; flex: none; fill: none; stroke: currentColor; stroke-width: 1.5; transition: transform 120ms ease; }
.tl-chevron.expanded { transform: rotate(90deg); }
.tl-steps {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.tl-text {
  font-size: 13px;
  line-height: 1.55;
  color: var(--fg);
}
.tl-step {
  min-width: 0;
}
.tl-row {
  display: flex;
  align-items: center;
  gap: 5px;
  width: 100%;
  background: transparent;
  border: none;
  padding: 0;
  text-align: left;
  cursor: pointer;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--fg-dim);
}
.tl-row-status { flex: none; font-size: 10px; }
.tl-row-status:empty { display: none; }
.tl-duration { margin-left: auto; flex: none; font-size: 10px; color: var(--fg-dim); }
.tl-row:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; border-radius: 3px; }
.tl-row:hover {
  color: var(--fg);
}
.tl-step.error .tl-icon,
.tl-step.error .tl-phrase {
  color: var(--danger);
}
.tl-icon {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 13px;
  height: 13px;
}
.tl-icon .el-icon {
  font-size: 12px;
}
.tl-phrase {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tl-summary {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 11px;
  opacity: 0.85;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tl-body {
  margin: 2px 0 4px 17px;
  min-width: 0;
}
.tl-answer {
  font-size: 13px;
  line-height: 1.55;
  min-width: 0;
}
.tl-spin {
  flex: none;
  display: inline-block;
  width: 9px;
  height: 9px;
  border: 2px solid var(--border);
  border-top-color: var(--fg);
  border-radius: 50%;
  animation: tl-rot 0.8s linear infinite;
}
@keyframes tl-rot {
  to {
    transform: rotate(360deg);
  }
}

/* Visual refinement: quiet interactive rows, unified status colors, token motion. */
.tl-head-icon { width: 12px; height: 12px; flex: none; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; opacity: .75; }
.tl-head-toggle {
  padding: 2px 6px;
  margin-inline: -6px;
  border-radius: 6px;
  transition: color var(--motion-hover) var(--ease-standard), background-color var(--motion-hover) var(--ease-standard);
}
.tl-head-toggle:hover { background: var(--bg-hover); }
.tl-head-text { font-variant-numeric: tabular-nums; }
.tl-chevron { transition: transform var(--motion-hover) var(--ease-standard); }
.tl-row {
  padding: 3px 6px;
  margin-inline: -6px;
  border-radius: 6px;
  transition: color var(--motion-hover) var(--ease-standard), background-color var(--motion-hover) var(--ease-standard);
}
.tl-row:hover { background: var(--bg-hover); }
.tl-duration { font-variant-numeric: tabular-nums; }
.tl-step.running .tl-icon, .tl-step.running .tl-phrase { color: var(--accent); }
.tl-step.ok .tl-icon { color: color-mix(in srgb, var(--success) 62%, var(--fg-dim)); }
.tl-step.cancelled .tl-icon, .tl-step.cancelled .tl-phrase { color: var(--fg-muted); }
.tl-spin { border-color: color-mix(in srgb, var(--accent) 25%, var(--border)); border-top-color: var(--accent); }
.tl-body { animation: tl-body-in var(--motion-menu) var(--ease-standard); }
@keyframes tl-body-in { from { opacity: 0; transform: translateY(-3px); } to { opacity: 1; transform: translateY(0); } }
.tl-agent-run {
  padding: 5px 8px;
  margin-inline: -8px;
  border-radius: var(--radius-sm);
  transition: color var(--motion-hover) var(--ease-standard), background-color var(--motion-hover) var(--ease-standard);
}
.tl-agent-run:hover { background: var(--accent-soft); }
.tl-agent-run.pending, .tl-agent-run.waiting { color: var(--warn); }
.tl-agent-run.completed .tl-agent-dot { background: var(--success); border-color: var(--success); }
.tl-agent-run.failed .tl-agent-dot { background: var(--danger); border-color: var(--danger); }
.tl-agent-run.blocked .tl-agent-dot { background: var(--warn); border-color: var(--warn); }
.tl-agent-more { opacity: .6; transition: transform var(--motion-hover) var(--ease-standard), opacity var(--motion-hover) var(--ease-standard); }
.tl-agent-run:hover .tl-agent-more { opacity: 1; transform: translateX(2px); }
.tl-recovery-download { border-radius: 4px; transition: color var(--motion-hover) var(--ease-standard); }
.tl-recovery-download:hover:not(:disabled) { color: var(--accent-hover); }
@media (prefers-reduced-motion: reduce) {
  .tl-body { animation: none; }
  .tl-agent-run:hover .tl-agent-more { transform: none; }
  .tl-head-toggle, .tl-row, .tl-agent-run, .tl-agent-more, .tl-chevron, .tl-recovery-download { transition: none; }
}
@media (forced-colors: active) {
  .tl-body { animation: none; }
  .tl-agent-run:hover .tl-agent-more { transform: none; }
}
</style>
