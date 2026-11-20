<script setup>
import { computed, ref, useId, watch } from 'vue';

const props = defineProps({ question: { type: Object, required: true }, disabled: { type: Boolean, default: false } });
const emit = defineEmits(['answer']);
const expanded = ref(false);
const bodyId = 'agent-question-' + useId();
const options = computed(() => (props.question.options || []).map((option) => typeof option === 'string'
  ? option : String(option?.label || option?.text || option?.value || '')));
watch(() => [props.question.questionId, props.question.question], () => { expanded.value = false; });
</script>

<template>
  <section class="question-card" :class="{ expanded }" aria-label="需要你的决定">
    <div class="question-heading">
      <svg class="question-mark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M9.2 9.2a2.8 2.8 0 0 1 5.4 1c0 1.8-2.6 2.2-2.6 3.6" /><path d="M12 17h.01" /></svg>
      <strong class="question-title">需要你的决定</strong>
      <button type="button" class="question-toggle" :aria-expanded="expanded" :aria-controls="bodyId" @click="expanded = !expanded">
        {{ expanded ? '收起问题' : '展开问题' }}
      </button>
    </div>
    <div class="question-content">
      <div :id="bodyId" class="question-body" role="region" aria-label="模型提出的问题" tabindex="0">{{ question.question }}</div>
      <div v-if="options.length" class="question-options" role="group" aria-label="快捷回答">
        <button v-for="(option, i) in options" :key="i" type="button" class="question-option" :title="option"
          :disabled="disabled" @click="emit('answer', option)">{{ option }}</button>
      </div>
    </div>
    <span class="question-hint muted">{{ options.length ? '点击选项即可回答，也可以在下方输入自己的回答。' : '可以在下方输入自己的回答。' }}</span>
  </section>
</template>

<style scoped>
.question-card {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  max-height: min(44vh, 320px);
  max-height: min(44cqh, 320px, max(78px, calc(100cqh - 148px)));
  overflow: hidden;
  margin: 0 12px 8px;
  padding: 8px 10px;
  gap: 6px;
  border: 1px solid var(--accent);
  background: var(--accent-soft);
  border-radius: 10px;
  font-size: 12px;
}
.question-card.expanded { max-height: min(64vh, 520px); max-height: min(64cqh, 520px, max(78px, calc(100cqh - 148px))); }
.question-heading { flex: none; display: flex; align-items: center; gap: 8px; min-width: 0; }
.question-title { color: var(--accent); font-size: 12px; line-height: 20px; }
.question-toggle { flex: none; margin-left: auto; padding: 0; border: 0; background: transparent; color: var(--accent); font-size: 11px; line-height: 20px; }
/* Scroll the question and choices together so wrapped options cannot push
   the question or composer out of a short panel. */
.question-content { flex: 1 1 auto; min-height: 0; min-width: 0; overflow-y: auto; overflow-x: hidden; overscroll-behavior-y: contain; scrollbar-gutter: stable; }
.question-body { max-height: 4.95em; overflow-y: auto; overflow-x: hidden; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.65; overscroll-behavior-y: contain; scrollbar-gutter: stable; }
.expanded .question-body { max-height: none; overflow: visible; }
.question-options { display: flex; flex-direction: column; align-items: stretch; gap: 8px; min-width: 0; margin-top: 10px; padding: 2px; }
.question-option { flex: none; box-sizing: border-box; width: 100%; min-width: 0; min-height: 40px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface-raised, var(--bg2)); color: var(--fg); font-size: 12px; line-height: 1.6; text-align: left; white-space: pre-wrap; overflow-wrap: anywhere; cursor: pointer; }
.question-option:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); background: var(--bg2); }
.question-option:disabled { opacity: .5; cursor: not-allowed; }
.question-toggle:focus-visible, .question-option:focus-visible, .question-body:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.question-hint { flex: none; font-size: 11px; line-height: 16px; }
@container agent-panel (max-height: 520px) {
  .question-card { margin: 0 8px 6px; padding: 6px 8px; gap: 4px; }
  .question-hint { display: none; }
}

/* Visual refinement: quiet sage decision card, pill options, token motion. */
.question-card {
  border-color: color-mix(in srgb, var(--accent) 38%, var(--border));
  background: linear-gradient(180deg, color-mix(in srgb, var(--accent) 7%, var(--surface-raised)), var(--accent-soft));
  border-radius: var(--radius-md);
  box-shadow: var(--glass-highlight);
}
.question-mark { width: 14px; height: 14px; flex: none; color: var(--accent); }
.question-title { font-weight: 650; letter-spacing: .01em; }
.question-toggle {
  border-radius: 5px;
  transition: color var(--motion-hover) var(--ease-standard), opacity var(--motion-hover) var(--ease-standard);
}
.question-toggle:hover { color: var(--accent-hover); text-decoration: underline; text-underline-offset: 3px; }
.question-option {
  border-radius: var(--radius-sm);
  border-color: color-mix(in srgb, var(--accent) 18%, var(--border));
  box-shadow: var(--glass-highlight);
  transition: border-color var(--motion-hover) var(--ease-standard), background-color var(--motion-hover) var(--ease-standard), color var(--motion-hover) var(--ease-standard), box-shadow var(--motion-hover) var(--ease-standard);
}
.question-option:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--accent) 55%, var(--border));
  background: color-mix(in srgb, var(--accent) 6%, var(--surface-raised));
  box-shadow: 0 2px 8px color-mix(in srgb, var(--accent) 12%, transparent);
}
.question-body { scrollbar-width: thin; }
@media (prefers-reduced-motion: reduce) {
  .question-toggle, .question-option { transition: none; }
}
@media (forced-colors: active) {
  .question-card { background: Canvas; box-shadow: none; }
  .question-option { box-shadow: none; }
  .question-option:hover:not(:disabled) { box-shadow: none; }
}
</style>
