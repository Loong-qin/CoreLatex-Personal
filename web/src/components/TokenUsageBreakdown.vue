<script setup>
import { INPUT_TOKEN_METRICS, OUTPUT_TOKEN_METRIC } from '../lib/aiUsage.js';
import { formatTokens } from '../lib/projectUtils.js';

defineProps({
  usage: { type: Object, required: true },
  variant: { type: String, default: 'list' },
  showCacheDetails: { type: Boolean, default: true },
});
</script>

<template>
  <dl class="token-breakdown" :class="{ 'token-breakdown--overview': variant === 'overview' }">
    <div class="token-metric token-input">
      <dt>输入 Token</dt>
      <dd>{{ formatTokens(usage.inputTokens) }}</dd>
      <dd v-if="showCacheDetails" class="token-children">
        <dl aria-label="输入 Token 明细">
          <div v-for="metric in INPUT_TOKEN_METRICS" :key="metric.key" class="token-metric">
            <dt><span class="token-dot" :style="{ backgroundColor: metric.color }" aria-hidden="true" />{{ metric.label }}</dt>
            <dd>{{ formatTokens(usage[metric.key]) }}</dd>
          </div>
        </dl>
      </dd>
    </div>
    <div class="token-metric">
      <dt><span class="token-dot" :style="{ backgroundColor: OUTPUT_TOKEN_METRIC.color }" aria-hidden="true" />{{ OUTPUT_TOKEN_METRIC.label }} Token</dt>
      <dd>{{ formatTokens(usage.outputTokens) }}</dd>
    </div>
  </dl>
</template>

<style scoped>
.token-breakdown, .token-children dl {
  display: grid;
  gap: 3px;
  margin: 0;
}
.token-breakdown { font-size: 11px; line-height: 1.5; }
.token-metric {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  column-gap: 5px;
}
.token-metric dt { color: var(--fg-dim); overflow-wrap: anywhere; }
.token-metric > dd {
  min-inline-size: 0;
  margin: 0;
}
.token-metric > dd:not(.token-children) {
  margin-inline-start: auto;
  color: var(--fg);
  text-align: end;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}
.token-metric > .token-children {
  box-sizing: border-box;
  flex: 0 0 100%;
  margin-block-start: 3px;
  padding-inline-start: 8px;
  border-inline-start: 1px solid var(--border);
}
.token-dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  margin-inline-end: 4px;
  border-radius: 2px;
}
.token-breakdown--overview {
  grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
  align-items: start;
  column-gap: 12px;
}
.token-breakdown--overview > .token-metric {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 1px;
}
.token-breakdown--overview > .token-metric > dt { font-size: 12px; }
.token-breakdown--overview > .token-metric > dd:not(.token-children) {
  margin-inline-start: 0;
  text-align: start;
  font-size: 16px;
  line-height: 1.3;
}
.token-breakdown--overview .token-children { margin-block-start: 6px; }
</style>
