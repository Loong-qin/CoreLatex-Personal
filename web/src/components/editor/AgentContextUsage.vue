<script setup>
import { computed, ref, watch } from 'vue';
import { ElPopover } from 'element-plus';

const props = defineProps({
  usage: { type: Object, default: null },
  active: { type: Boolean, default: true },
  disabled: { type: Boolean, default: false },
  compacting: { type: Boolean, default: false },
});
const emit = defineEmits(['compact']);
const open = ref(false);
const trigger = ref(null);
const content = ref(null);
const percent = computed(() => props.usage ? Math.min(100, props.usage.usedTokens / props.usage.maxTokens * 100) : null);
const percentText = computed(() => percent.value == null ? '—' : percent.value > 0 && percent.value < 1
  ? '<1%' : `${Math.round(percent.value)}%`);
const usageText = computed(() => percent.value == null ? '暂无占用数据' : `${props.usage.estimated ? '约 ' : ''}${percentText.value}`);
const triggerText = computed(() => props.usage?.estimated ? `≈${percentText.value}` : percentText.value);
const warning = computed(() => percent.value >= 80);

watch(() => props.active, active => { if (!active) open.value = false; });

function focusContent() {
  if (open.value) content.value?.focus({ preventScroll: true });
}
function closeOnEscape(event) {
  if (!open.value) return;
  event.preventDefault();
  event.stopPropagation();
  open.value = false;
  trigger.value?.focus({ preventScroll: true });
}
function compact() {
  focusContent();
  emit('compact');
}
</script>

<template>
  <ElPopover v-model:visible="open" :disabled="!active" role="dialog" title="上下文窗口"
    trigger="click" placement="top-end" strategy="fixed" :offset="8" :boundaries-padding="10"
    width="min(260px, calc(100vw - 20px))" :show-arrow="false" :persistent="false"
    popper-class="agent-context-popover" @after-enter="focusContent">
    <template #reference>
      <button ref="trigger" type="button" class="context-trigger" :class="{ warning }"
        :title="open ? undefined : `上下文窗口 · ${usageText}`" :aria-label="`上下文窗口，${usageText}`"
        @keydown.esc="closeOnEscape">
        <span class="context-track context-trigger-track" aria-hidden="true">
          <span v-if="percent != null" class="context-fill" :style="{ width: `${percent}%` }"></span>
        </span>
        <span aria-hidden="true">{{ triggerText }}</span>
      </button>
    </template>

    <div ref="content" class="context-details" :class="{ warning }" tabindex="-1" @keydown.esc="closeOnEscape">
      <div class="context-reading">
        <span>整体占用</span>
        <strong>{{ usageText }}</strong>
      </div>
      <div v-if="percent != null" class="context-track" role="meter" aria-label="整体占用"
        aria-valuemin="0" aria-valuemax="100" :aria-valuenow="percent" :aria-valuetext="usageText">
        <span class="context-fill" :style="{ width: `${percent}%` }"></span>
      </div>
      <p class="context-help">
        <template v-if="usage">
          {{ !usage.estimated ? '读数来自模型服务返回的最近一次请求的输入 Token。'
            : usage.basis === 'history' ? '按下一轮可沿用的对话、摘要、系统提示和工具估算。'
            : '按最近一次模型请求的系统提示、工具和消息估算。' }}
        </template>
        压缩会将较早的对话整理成摘要。
      </p>
      <button type="button" class="context-compact" :disabled="disabled || compacting" @click="compact">
        {{ compacting ? '正在压缩…' : '压缩上下文' }}
      </button>
    </div>
  </ElPopover>
</template>

<style scoped>
.context-trigger {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  height: 30px;
  padding: 0 6px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--fg-dim);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  cursor: pointer;
}
.context-trigger:hover, .context-trigger[aria-expanded='true'] { background: var(--bg-hover); color: var(--fg); }
.context-trigger:focus-visible, .context-compact:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.context-track { display: block; height: 5px; border-radius: 999px; background: var(--border); overflow: hidden; }
.context-track.context-trigger-track { width: 24px; height: 4px; }
.context-fill { display: block; height: 100%; border-radius: inherit; background: var(--accent); }
.warning .context-fill { background: var(--warn); }
:global(.el-popper.agent-context-popover) {
  box-sizing: border-box;
  min-width: 0;
  max-height: calc(100dvh - 20px);
  overflow: auto;
  padding: 12px;
  border-radius: var(--radius-md);
}
:global(.agent-context-popover .el-popover__title) { margin-bottom: 9px; font-size: 13px; font-weight: 650; color: var(--fg); }
.context-details { outline: none; }
.context-reading { display: flex; justify-content: space-between; gap: 8px; margin-bottom: 6px; font-size: 12px; color: var(--fg-dim); }
.context-reading strong { color: var(--fg); font-weight: 600; font-variant-numeric: tabular-nums; }
.context-help { margin: 10px 0; color: var(--fg-dim); font-size: 12px; line-height: 1.55; }
.context-compact { width: 100%; min-height: 32px; font-size: 12px; }
@media (pointer: coarse) {
  .context-trigger, .context-compact { min-height: 40px; }
}
@media (forced-colors: active) {
  .context-track { outline: 1px solid CanvasText; }
  .context-fill, .warning .context-fill { background: Highlight; forced-color-adjust: none; }
}
</style>
