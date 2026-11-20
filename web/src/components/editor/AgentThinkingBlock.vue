<script setup>
import { computed, nextTick, onActivated, onDeactivated, onBeforeUnmount, ref, useId, watch } from 'vue';

const props = defineProps({
  text: { type: String, default: '' },
  durationMs: { type: Number, default: null },
  startedAt: { type: [Number, String], default: null },
  live: { type: Boolean, default: false },
  readingState: { type: Object, default: null },
});
const emit = defineEmits(['reading-change']);
const expanded = ref(props.readingState?.expanded ?? true);
const content = ref(null);
// Each thought keeps its own reading position. Follow new tokens until the user
// scrolls up; returning to the bottom resumes following without losing history.
const followLatest = ref(props.readingState?.followLatest ?? true);
let readingTop = props.readingState?.scrollTop || 0;
let positionApplied = false;
const active = ref(true);
let restoringPosition = false;
let programmaticTop = null;
let contentResizeObserver;
function saveReading() {
  emit('reading-change', { expanded: expanded.value, followLatest: followLatest.value, scrollTop: readingTop });
}
function toggleExpanded() {
  expanded.value = !expanded.value;
  saveReading();
}
function onContentScroll() {
  if (!active.value || !expanded.value || restoringPosition) return;
  const el = content.value;
  // KeepAlive storage and collapsed ancestors have no layout. Their synthetic
  // scroll events must not replace the user's last visible reading position.
  if (el && el.isConnected && el.clientHeight > 0) {
    if (programmaticTop != null && Math.abs(el.scrollTop - programmaticTop) < 1) { programmaticTop = null; return; }
    programmaticTop = null;
    followLatest.value = el.scrollHeight - el.scrollTop - el.clientHeight <= 8;
    readingTop = el.scrollTop;
    saveReading();
  }
}
function applyReadingPosition(force = false) {
  const el = content.value;
  if (!active.value || !expanded.value || !el || !el.isConnected || el.clientHeight <= 0) {
    positionApplied = false;
    return;
  }
  if (followLatest.value || force || !positionApplied) {
    restoringPosition = true;
    el.scrollTop = followLatest.value ? el.scrollHeight : readingTop;
    readingTop = el.scrollTop;
    programmaticTop = el.scrollTop;
    restoringPosition = false;
  }
  positionApplied = true;
}
watch([() => props.text, expanded], async () => {
  await nextTick();
  applyReadingPosition();
}, { immediate: true, flush: 'post' });
onDeactivated(() => {
  const el = content.value;
  if (expanded.value && el && el.isConnected && el.clientHeight > 0 && !restoringPosition) readingTop = el.scrollTop;
  active.value = false;
  restoringPosition = false;
  programmaticTop = null;
  positionApplied = false;
  saveReading();
});
onActivated(async () => {
  active.value = true;
  restoringPosition = true;
  await nextTick();
  // A retained DOM node can lose scrollTop while detached. Restore even when a
  // completed thought received no new text while another project was visible.
  applyReadingPosition(true);
  restoringPosition = false;
});
watch(content, (el) => {
  contentResizeObserver?.disconnect();
  if (el && typeof ResizeObserver !== 'undefined') {
    contentResizeObserver = new ResizeObserver(() => {
      if (!el.isConnected || el.clientHeight <= 0) positionApplied = false;
      else if (!positionApplied) applyReadingPosition(true);
    });
    contentResizeObserver.observe(el);
  }
}, { flush: 'post' });
const contentId = 'thinking-' + useId();
const now = ref(Date.now());
let timer;
const measured = computed(() => Number.isFinite(props.durationMs));
const start = computed(() => {
  if (props.startedAt == null) return null;
  const value = typeof props.startedAt === 'number' ? props.startedAt : Date.parse(props.startedAt);
  return Number.isFinite(value) ? value : null;
});
const timing = computed(() => props.live && !measured.value && start.value != null);
const seconds = computed(() => {
  const elapsed = measured.value ? props.durationMs : timing.value ? now.value - start.value : null;
  if (elapsed == null) return null;
  return (Math.max(0, elapsed) / 1000).toFixed(1).replace(/\.0$/, '');
});
watch([timing, active], ([running, visible]) => {
  clearInterval(timer);
  if (running && visible) {
    now.value = Date.now();
    timer = setInterval(() => { now.value = Date.now(); }, 250);
  }
}, { immediate: true });
onBeforeUnmount(() => { active.value = false; contentResizeObserver?.disconnect(); clearInterval(timer); });
</script>

<template>
  <section class="thinking-block" :aria-busy="timing">
    <button
      type="button"
      class="thinking-heading"
      :aria-expanded="expanded"
      :aria-controls="contentId"
      :title="expanded ? '收起思考' : '展开思考'"
      @click="toggleExpanded"
    >
      <svg class="thinking-brain" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M12 18V5a3 3 0 0 0-5.8-1A3.7 3.7 0 0 0 3 7.7a4 4 0 0 0 .1 7.4A3.8 3.8 0 0 0 7 20a3 3 0 0 0 5-2Z" />
        <path d="M12 5a3 3 0 0 1 5.8-1A3.7 3.7 0 0 1 21 7.7a4 4 0 0 1-.1 7.4A3.8 3.8 0 0 1 17 20a3 3 0 0 1-5-2M7 8c0 2-1 3-3 3m13-3c0 2 1 3 3 3M8 14c2 0 4 1 4 3m4-3c-2 0-4 1-4 3" />
      </svg>
      <span>思考<span v-if="seconds != null"> · 持续了 {{ seconds }} 秒</span></span>
      <svg class="thinking-chevron" :class="{ expanded }" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
        <path d="m4 2 4 4-4 4" />
      </svg>
    </button>
    <div
      v-show="expanded"
      :id="contentId"
      ref="content"
      class="thinking-content"
      role="region"
      aria-label="模型思考内容"
      tabindex="0"
      @scroll="onContentScroll"
    >{{ text }}</div>
  </section>
</template>

<style scoped>
.thinking-block {
  min-width: 0;
  margin: 7px 0 9px;
  color: var(--fg-dim);
}
.thinking-heading {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 12px;
  line-height: 1.6;
  text-align: left;
  cursor: pointer;
}
.thinking-heading:hover { color: var(--fg); }
.thinking-heading:focus-visible { outline: 1px solid var(--accent); outline-offset: 3px; border-radius: 2px; }
.thinking-brain { width: 15px; height: 15px; flex: none; }
.thinking-chevron { width: 10px; height: 10px; flex: none; transition: transform 120ms ease; }
.thinking-chevron.expanded { transform: rotate(90deg); }
.thinking-content {
  margin: 8px 0 0 7px;
  padding: 0 0 0 13px;
  border-left: 1px solid var(--border);
  font-size: 12px;
  line-height: 1.7;
  max-height: 8.5em; /* five visible lines */
  overflow-y: auto;
  overflow-x: hidden;
  overscroll-behavior-y: contain;
  scrollbar-gutter: stable;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

/* Visual refinement: lavender thinking voice, gentle live pulse, token motion. */
.thinking-heading {
  border-radius: 5px;
  transition: color var(--motion-hover) var(--ease-standard);
}
.thinking-brain { color: var(--accent-secondary); transition: color var(--motion-hover) var(--ease-standard); }
.thinking-heading:hover .thinking-brain { color: var(--accent); }
.thinking-block[aria-busy='true'] .thinking-brain {
  color: var(--accent);
  animation: thinking-pulse 1.8s var(--ease-standard) infinite;
}
@keyframes thinking-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .45; } }
.thinking-chevron { transition: transform var(--motion-hover) var(--ease-standard); }
.thinking-content { border-left-color: color-mix(in srgb, var(--accent-secondary) 34%, var(--border)); }
@media (prefers-reduced-motion: reduce) {
  .thinking-block[aria-busy='true'] .thinking-brain { animation: none; }
  .thinking-heading, .thinking-brain, .thinking-chevron { transition: none; }
}
@media (forced-colors: active) {
  .thinking-block[aria-busy='true'] .thinking-brain { animation: none; }
}
</style>
