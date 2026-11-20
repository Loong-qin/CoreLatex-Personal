<script setup>
import { computed } from 'vue';
import { projectNotificationLabel } from '../../lib/projectNotification.js';

const props = defineProps({
  pendingReviewCount: { type: Number, default: 0 },
  unreadCompletion: { type: Boolean, default: false },
});
const label = computed(() => projectNotificationLabel(props.pendingReviewCount, props.unreadCompletion));
</script>

<template>
  <span v-if="label" class="project-notification" :class="pendingReviewCount ? 'project-notification-count' : 'project-notification-dot'" :title="label">
    <span v-if="pendingReviewCount" aria-hidden="true">{{ pendingReviewCount > 99 ? '99+' : pendingReviewCount }}</span>
    <span class="project-notification-label">{{ label }}</span>
  </span>
</template>

<style scoped>
.project-notification { flex: none; border-radius: 999px; }
.project-notification-count { display: inline-flex; align-items: center; justify-content: center; min-width: 15px; height: 15px; padding: 0 3px; background: var(--accent-hover, var(--accent)); color: var(--on-accent); font-size: 9px; font-weight: 700; line-height: 1; font-variant-numeric: tabular-nums; }
.project-notification-dot { display: inline-block; width: 7px; height: 7px; background: var(--accent-secondary, var(--accent)); }
.project-notification-label { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
@media (forced-colors: active) {
  .project-notification { forced-color-adjust: none; background: Highlight; color: HighlightText; }
}
</style>
