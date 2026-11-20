<script setup>
import { computed, nextTick, onBeforeUnmount, onDeactivated, ref, useId, watch } from 'vue';
import { formatDuration } from '../../lib/agentUtils.js';

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  anchor: { type: Object, default: null },
  run: { type: Object, default: null },
  active: { type: Boolean, default: true },
  id: { type: String, default: '' },
});
const emit = defineEmits(['update:modelValue']);
const panel = ref(null), closeButton = ref(null);
const titleId = 'worker-popover-title-' + useId();
const visible = computed(() => props.modelValue && props.active && !!props.run);
const layout = ref({ left: '0px', top: '0px', width: '400px', maxHeight: '520px', visibility: 'hidden' });
const placement = ref('right');
const state = computed(() => {
  const run = props.run;
  if (run?.takeover?.by === 'coordinator') return '资源受限 · 主智能体已接管';
  if (run?.resourceFailure?.code) return '资源受限';
  if (run?.status === 'running' && run.activities?.some(row => row.phase === 'reporting')) return '正在汇报';
  const label = { pending: '待开始', running: '正在工作', waiting: '等待中', completed: '已完成', failed: '执行失败', cancelled: '已取消', interrupted: '已中断', skipped: '已跳过', blocked: '受阻' }[run?.status] || '状态待确认';
  return run?.status === 'completed' && run.report?.verdict === 'needs_changes' ? label + ' · 需修正'
    : run?.status === 'completed' && run.report?.verdict === 'blocked' ? label + ' · 受阻' : label;
});
const findings = computed(() => (Array.isArray(props.run?.report?.findings) ? props.run.report.findings : [])
  .map(item => typeof item === 'string' ? { message: item } : item)
  .filter(item => typeof item?.message === 'string' && item.message.trim()));
const verdicts = { pass: '通过', needs_changes: '需修正', blocked: '受阻' };
const findingCategories = { factual_error: '事实性错误', conflict: '内容冲突', suggestion: '建议 · 不要求修改', uncertain: '未证实 · 不要求修改' };
const findingCategory = category => Object.hasOwn(findingCategories, category) ? findingCategories[category] : '';
let observer, frame = 0, restoreFocus = false;
const nestedPreview = target => target?.closest?.('.tool-image-overlay');
function close(restore = true) {
  restoreFocus = restore;
  emit('update:modelValue', false);
}
function position() {
  if (!visible.value || !panel.value) return;
  const anchor = props.anchor;
  if (!anchor?.isConnected) { close(false); return; }
  const measured = anchor.getBoundingClientRect();
  const rect = { left: measured.left, right: measured.right, top: measured.top, bottom: measured.bottom };
  // The chat scroll area can clip a row while it is still inside the page viewport.
  // Never leave its floating details hanging over the composer or panel heading.
  for (let ancestor = anchor.parentElement; ancestor && ancestor !== document.body; ancestor = ancestor.parentElement) {
    const style = getComputedStyle(ancestor), bounds = ancestor.getBoundingClientRect();
    if (/auto|scroll|hidden|clip/.test(style.overflowY || style.overflow) && bounds.height > 0) {
      rect.top = Math.max(rect.top, bounds.top); rect.bottom = Math.min(rect.bottom, bounds.bottom);
    }
    if (/auto|scroll|hidden|clip/.test(style.overflowX || style.overflow) && bounds.width > 0) {
      rect.left = Math.max(rect.left, bounds.left); rect.right = Math.min(rect.right, bounds.right);
    }
  }
  if (rect.bottom <= rect.top || rect.right <= rect.left) { close(false); return; }
  const viewport = window.visualViewport;
  const leftBound = (viewport?.offsetLeft || 0) + 8, topBound = (viewport?.offsetTop || 0) + 8;
  const viewportWidth = viewport?.width || window.innerWidth;
  const viewportHeight = viewport?.height || window.innerHeight;
  const rightBound = leftBound + viewportWidth - 16, bottomBound = topBound + viewportHeight - 16;
  if (rect.bottom < topBound || rect.top > bottomBound || rect.right < leftBound || rect.left > rightBound) { close(false); return; }
  const width = Math.min(400, viewportWidth - 16), gap = 10;
  let left, top, maxHeight = Math.min(520, viewportHeight - 16), side;
  if (rightBound - rect.right >= width + gap) {
    side = 'right'; left = rect.right + gap; top = rect.top;
  } else if (rect.left - leftBound >= width + gap) {
    side = 'left'; left = rect.left - width - gap; top = rect.top;
  } else {
    const below = bottomBound - rect.bottom - gap, above = rect.top - topBound - gap;
    side = below >= Math.min(240, maxHeight) || below >= above ? 'bottom' : 'top';
    maxHeight = Math.min(maxHeight, Math.max(120, side === 'bottom' ? below : above));
    left = Math.max(leftBound, Math.min(rect.left, rightBound - width));
    top = side === 'bottom' ? rect.bottom + gap : rect.top - gap - Math.min(panel.value.getBoundingClientRect().height || maxHeight, maxHeight);
  }
  const height = Math.min(panel.value.getBoundingClientRect().height || maxHeight, maxHeight);
  top = Math.max(topBound, Math.min(top, bottomBound - height));
  placement.value = side;
  layout.value = { left: left + 'px', top: top + 'px', width: width + 'px', maxHeight: maxHeight + 'px', visibility: 'visible' };
}
function schedulePosition() {
  if (frame) return;
  frame = requestAnimationFrame(() => { frame = 0; position(); });
}
function outside(event) {
  if (!panel.value?.contains(event.target) && !props.anchor?.contains(event.target) && !nestedPreview(event.target)) close(false);
}
function keydown(event) {
  if (event.key !== 'Escape' || document.querySelector('.tool-image-overlay')) return;
  event.preventDefault(); event.stopPropagation(); close();
}
function stopListening() {
  observer?.disconnect(); observer = null;
  if (frame) cancelAnimationFrame(frame);
  frame = 0;
  window.removeEventListener('resize', schedulePosition);
  window.removeEventListener('scroll', schedulePosition, true);
  window.visualViewport?.removeEventListener('resize', schedulePosition);
  window.visualViewport?.removeEventListener('scroll', schedulePosition);
  document.removeEventListener('pointerdown', outside, true);
  document.removeEventListener('focusin', outside);
  document.removeEventListener('keydown', keydown);
}
watch(visible, async open => {
  stopListening();
  if (open) {
    restoreFocus = false;
    layout.value = { ...layout.value, visibility: 'hidden' };
    await nextTick();
    if (!visible.value) return;
    position();
    window.addEventListener('resize', schedulePosition);
    window.addEventListener('scroll', schedulePosition, true);
    window.visualViewport?.addEventListener('resize', schedulePosition);
    window.visualViewport?.addEventListener('scroll', schedulePosition);
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('focusin', outside);
    document.addEventListener('keydown', keydown);
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(schedulePosition);
      if (panel.value) observer.observe(panel.value);
      if (props.anchor) observer.observe(props.anchor);
    }
    closeButton.value?.focus({ preventScroll: true });
  } else if (restoreFocus && props.active && props.anchor?.isConnected) {
    await nextTick(); props.anchor.focus({ preventScroll: true });
  }
}, { immediate: true });
watch(() => props.anchor, () => { if (visible.value) nextTick(position); });
watch(() => props.run, () => { if (visible.value) nextTick(position); }, { deep: true });
watch(() => props.active, active => { if (!active) close(false); });
onDeactivated(() => { stopListening(); close(false); });
onBeforeUnmount(stopListening);
</script>

<template>
  <Teleport to="body">
    <section v-if="visible" :id="id || undefined" ref="panel" class="agent-worker-popover" :style="layout"
      :data-placement="placement" :data-execution-id="run.executionId" role="dialog" aria-modal="false" :aria-labelledby="titleId">
      <header class="worker-popover-header">
        <svg class="worker-popover-mark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="8" width="14" height="11" rx="3" /><path d="M12 8V4.5" /><circle cx="12" cy="3.5" r="1" /><path d="M9.5 13h.01M14.5 13h.01" /></svg>
        <strong :id="titleId">{{ run.label }} · 执行详情</strong>
        <button ref="closeButton" type="button" aria-label="关闭子智能体详情" @click="close()">×</button>
      </header>
      <div class="worker-popover-body">
        <div class="worker-popover-status" :class="run.status"><span>{{ state }}</span><span v-if="Number.isFinite(run.durationMs)">{{ formatDuration(run.durationMs) }}</span></div>
        <details v-if="run.task" class="worker-popover-task"><summary>任务说明</summary><p>{{ run.task }}</p></details>
        <slot />
        <p v-if="!run.tools?.length && !run.activities?.length" class="worker-popover-empty">尚无已记录的工具调用。</p>
        <section v-if="run.report" class="worker-popover-report" aria-label="执行报告">
          <strong>执行报告<span v-if="run.report.verdict"> · {{ verdicts[run.report.verdict] || '结论待确认' }}</span></strong>
          <p v-if="run.report.summary">{{ run.report.summary }}</p>
          <p v-if="run.report.coverage?.length">核查范围：<template v-for="(scope, index) in run.report.coverage" :key="scope.path">
            {{ index ? '、' : '' }}<code>{{ scope.path }}</code>（{{ scope.binary ? '二进制变更' : scope.truncated ? '差异片段，已截断' : '本轮差异' }}）
          </template></p>
          <p v-if="run.report.blockedReason?.message && run.report.blockedReason.message !== run.report.summary">受阻原因：{{ run.report.blockedReason.message }}</p>
          <ul v-if="run.report.limitations?.length" aria-label="核查限制"><li v-for="(limitation, index) in run.report.limitations" :key="index">{{ limitation }}</li></ul>
          <ul v-if="findings.length"><li v-for="(finding, index) in findings" :key="index">
            <span v-if="findingCategory(finding.category)" class="finding-category">{{ findingCategory(finding.category) }}</span>
            <code v-if="finding.path">{{ finding.path }}<template v-if="Number.isInteger(finding.line) && finding.line > 0">:{{ finding.line }}</template><template v-if="finding.side === 'before'">（修改前）</template></code> {{ finding.message }}
            <details v-if="finding.evidence?.quote" class="finding-evidence"><summary>核查依据</summary><p v-if="finding.evidence.source">{{ finding.evidence.source }}</p><blockquote>{{ finding.evidence.quote }}</blockquote></details>
          </li></ul>
        </section>
      </div>
    </section>
  </Teleport>
</template>

<style scoped>
.agent-worker-popover { position: fixed; z-index: 4100; display: flex; flex-direction: column; box-sizing: border-box; overflow: hidden; color: var(--fg); background: var(--glass-strong); border: 1px solid var(--glass-edge); border-radius: 12px; box-shadow: var(--glass-highlight), var(--shadow-lg); -webkit-backdrop-filter: var(--glass-filter); backdrop-filter: var(--glass-filter); font-size: 12px; text-align: left; }
.worker-popover-header { display: flex; align-items: center; gap: 8px; padding: 9px 12px; border-bottom: 1px solid var(--border, #dbe2eb); flex: none; }
.worker-popover-header strong { min-width: 0; flex: 1; overflow-wrap: anywhere; font-size: 12px; font-weight: 600; }
.worker-popover-header button { display: grid; place-items: center; width: 24px; height: 24px; padding: 0; background: transparent; border: 0; border-radius: 4px; color: var(--fg-dim); font-size: 19px; cursor: pointer; }
.worker-popover-header button:hover { background: var(--bg-muted, #f2f5f9); color: var(--fg); }
.worker-popover-header button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.worker-popover-body { padding: 10px 12px 12px; overflow: auto; overscroll-behavior: contain; min-height: 0; overflow-wrap: anywhere; }
.worker-popover-status { display: flex; gap: 8px; justify-content: space-between; margin-bottom: 6px; color: var(--fg-dim); font-size: 11px; }
.worker-popover-status.running { color: var(--accent); }.worker-popover-status.failed { color: var(--danger); }
.worker-popover-task { margin: 0 0 9px; white-space: pre-wrap; color: var(--fg-dim); font-size: 11.5px; line-height: 1.5; }
.worker-popover-task summary { cursor: pointer; }.worker-popover-task p { margin: 5px 0 0; }
.worker-popover-empty { color: var(--fg-dim); margin: 8px 0 0; }
.worker-popover-report { margin-top: 11px; padding-top: 9px; border-top: 1px solid var(--border, #dbe2eb); font-size: 12px; line-height: 1.5; }
.worker-popover-report strong { font-weight: 600; }.worker-popover-report strong span { color: var(--fg-dim); font-size: 11px; }
.worker-popover-report p { margin: 6px 0 0; white-space: pre-wrap; }.worker-popover-report ul { padding-left: 18px; margin: 6px 0 0; }.worker-popover-report li + li { margin-top: 5px; }
.finding-category { display: block; color: var(--fg-dim); font-size: 11px; margin-bottom: 2px; }
.finding-evidence { margin-top: 5px; font-size: 11.5px; color: var(--fg-dim); }
.finding-evidence summary { cursor: pointer; }
.finding-evidence blockquote { margin: 5px 0 0; padding: 1px 0 1px 9px; border-left: 2px solid var(--border); white-space: pre-wrap; }

/* Visual refinement: glass popover polish, semantic status strip, token motion. */
.agent-worker-popover { animation: worker-popover-in var(--motion-surface) var(--ease-standard); }
@keyframes worker-popover-in { from { opacity: 0; } to { opacity: 1; } }
.worker-popover-header { background: var(--glass-inset); border-bottom-color: color-mix(in srgb, var(--border) 75%, var(--bg2)); }
.worker-popover-mark { width: 15px; height: 15px; flex: none; color: var(--accent); }
.worker-popover-header strong { font-weight: 650; letter-spacing: -.01em; }
.worker-popover-header button {
  border-radius: var(--radius-sm);
  transition: background-color var(--motion-hover) var(--ease-standard), color var(--motion-hover) var(--ease-standard);
}
.worker-popover-header button:hover { background: var(--bg-hover); }
.worker-popover-status {
  padding: 6px 9px;
  border-radius: var(--radius-sm);
  background: var(--glass-inset);
  font-variant-numeric: tabular-nums;
}
.worker-popover-status.running { background: var(--accent-soft); }
.worker-popover-status.failed { background: var(--danger-soft); }
.worker-popover-status.pending, .worker-popover-status.waiting, .worker-popover-status.blocked { color: var(--warn); background: var(--warn-soft); }
.worker-popover-task summary, .finding-evidence summary {
  border-radius: 5px;
  transition: color var(--motion-hover) var(--ease-standard);
}
.worker-popover-task summary:hover, .finding-evidence summary:hover { color: var(--accent-hover); }
.worker-popover-report { border-top-color: color-mix(in srgb, var(--border) 75%, var(--bg2)); }
.worker-popover-report strong { font-weight: 650; }
.worker-popover-report code, .worker-popover-body code {
  font-family: var(--mono);
  font-size: 11px;
  padding: 1px 5px;
  border-radius: 5px;
  background: var(--glass-inset);
}
.finding-category { color: var(--accent-secondary); font-weight: 600; letter-spacing: .02em; }
.finding-evidence blockquote { border-left-color: color-mix(in srgb, var(--accent-secondary) 40%, var(--border)); }
@media (prefers-reduced-motion: reduce) {
  .agent-worker-popover { animation: none; }
  .worker-popover-header button, .worker-popover-task summary, .finding-evidence summary { transition: none; }
}
@media (forced-colors: active) {
  .agent-worker-popover { animation: none; }
  .worker-popover-status { background: Canvas; }
}
</style>
