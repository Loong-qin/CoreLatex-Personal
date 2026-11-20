<script setup>
import { computed } from 'vue';
import { toolPresentation, technicalToolText } from '../../lib/toolPresentation.js';
import AgentToolImages from './AgentToolImages.vue';
const props = defineProps({ row: { type: Object, required: true }, active: { type: Boolean, default: true } });
const display = computed(() => toolPresentation({ name: props.row.name, input: props.row.inputText, result: props.row.resultText, display: props.row.display, state: props.row.state }));
const inputText = computed(() => technicalToolText(props.row.inputText));
const resultText = computed(() => technicalToolText(props.row.resultText));
const outcomeText = computed(() => props.row.state === 'ok' ? ({ staged: '执行时暂存', applied: '执行时已写入', 'no-change': '无变化', restored: '已恢复基线' }[display.value.outcome] || '') : '');
const contentLabel = computed(() => ({ compile: '编译结果', read: '读取内容', edit: '修改说明', command: '执行输出', skill: '技能内容', context: '请求时的文档快照', web: '网页内容', question: '需要补充的信息' }[display.value.kind] || '结果'));
const isDiff = computed(() => props.row.state === 'ok' && typeof display.value.before === 'string' && typeof display.value.after === 'string');
</script>

<template>
  <section class="tool-result" :data-kind="display.kind">
    <div v-if="display.summary || outcomeText" class="tool-result-summary" :class="row.state" role="status">
      <span>{{ display.summary }}</span><span v-if="outcomeText" class="tool-outcome">{{ outcomeText }}</span>
    </div>
    <dl v-if="display.fields.length" class="tool-result-fields">
      <template v-for="(field, index) in display.fields" :key="index"><dt>{{ field.label }}</dt><dd>{{ field.value }}</dd></template>
    </dl>
    <AgentToolImages v-if="display.images.length" :images="display.images" :active="active" />
    <div v-if="isDiff" class="tool-diff">
      <div class="tool-content-cap">本次工具调用的内容对比</div>
      <div><div class="tool-content-cap">修改前</div><pre class="tool-code before">{{ display.before || '（空文件）' }}</pre></div>
      <div><div class="tool-content-cap">修改后</div><pre class="tool-code after">{{ display.after || '（空文件）' }}</pre></div>
    </div>
    <ul v-if="display.items.length" class="tool-result-items">
      <li v-for="(item, index) in display.items" :key="index">
        <a v-if="item.url" :href="item.url" target="_blank" rel="noopener noreferrer">{{ item.label }} <span aria-hidden="true">↗</span></a>
        <span v-else class="tool-item-label">{{ item.label }}</span>
        <code v-if="item.path && item.path !== item.label">{{ item.path }}</code>
        <p v-if="item.detail">{{ item.detail }}</p>
      </li>
    </ul>
    <div v-if="display.text" class="tool-content">
      <div class="tool-content-cap">{{ row.state === 'error' ? '失败原因与输出' : contentLabel }}</div>
      <div v-if="display.kind === 'read' && display.startLine" class="tool-numbered-code" aria-label="读取内容与行号">
        <div v-for="(line, index) in display.text.split('\n')" :key="index"><span aria-hidden="true">{{ display.startLine + index }}</span><code>{{ line || ' ' }}</code></div>
      </div>
      <pre v-else class="tool-code" :class="{ prose: !['read', 'command', 'skill'].includes(display.kind) }">{{ display.text }}</pre>
    </div>
    <p v-if="display.notice" class="tool-notice">{{ display.notice }}</p>
    <p v-if="display.truncated" class="tool-notice">为保持可读性，此处只展示部分结果。</p>
    <details v-if="inputText || resultText" class="tool-technical">
      <summary>技术详情</summary>
      <template v-if="inputText"><div class="tool-content-cap">参数</div><pre class="tl-pre tool-code">{{ inputText }}</pre></template>
      <template v-if="resultText"><div class="tool-content-cap">原始结果（已脱敏）</div><pre class="tl-pre tool-code">{{ resultText }}</pre></template>
    </details>
  </section>
</template>

<style scoped>
.tool-result { display: flex; flex-direction: column; gap: 11px; padding: 12px; border: 1px solid var(--border); border-radius: 9px; background: var(--bg, #fff); color: var(--fg); font-size: 12px; line-height: 1.6; min-width: 0; }
.tool-result-summary { display: flex; flex-wrap: wrap; gap: 7px; align-items: center; color: var(--fg); overflow-wrap: anywhere; }
.tool-result-summary.error { color: var(--danger); }
.tool-result-summary.cancelled { color: var(--fg-dim); }
.tool-outcome { border-radius: 4px; background: var(--bg2); padding: 1px 6px; color: var(--fg-dim); font-size: 10px; }
.tool-result-fields { display: grid; grid-template-columns: max-content minmax(0, 1fr); column-gap: 12px; row-gap: 5px; margin: 0; font-size: 11px; }
.tool-result-fields dt { color: var(--fg-dim); }
.tool-result-fields dd { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.tool-content-cap { color: var(--fg-dim); font-size: 10px; margin-bottom: 5px; }
.tool-code { margin: 0; padding: 9px 10px; max-height: 280px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; border-radius: 5px; background: var(--bg2, #f5f7fb); color: var(--fg); font: 11px/1.65 var(--font-mono, ui-monospace, monospace); tab-size: 2; }
.tool-code.prose { font: inherit; font-size: 12px; }
.tool-numbered-code { max-height: 280px; overflow: auto; padding: 9px 0; background: var(--bg2, #f5f7fb); border-radius: 5px; font: 11px/1.65 var(--font-mono, ui-monospace, monospace); }
.tool-numbered-code > div { display: flex; }.tool-numbered-code span { flex: none; width: 38px; padding-right: 10px; text-align: right; user-select: none; color: var(--fg-dim); opacity: .65; }.tool-numbered-code code { white-space: pre-wrap; overflow-wrap: anywhere; min-width: 0; padding-right: 9px; font: inherit; }
.tool-diff { display: grid; grid-template-columns: 1fr; gap: 9px; }
.tool-code.before { border-left: 3px solid #c66e6e; }
.tool-code.after { border-left: 3px solid #5b9b7b; }
.tool-result-items { list-style: none; padding: 0; margin: 0; max-height: 310px; overflow: auto; }
.tool-result-items li { padding: 8px 0; border-bottom: 1px solid var(--border); }
.tool-result-items li:first-child { padding-top: 0; }.tool-result-items li:last-child { border-bottom: none; padding-bottom: 0; }
.tool-result-items a { color: var(--accent); text-decoration: none; overflow-wrap: anywhere; }.tool-result-items a:hover { text-decoration: underline; }
.tool-result-items code { display: block; color: var(--fg-dim); font-size: 10px; overflow-wrap: anywhere; }
.tool-result-items p { margin: 4px 0 0; color: var(--fg-dim); white-space: pre-wrap; overflow-wrap: anywhere; font-size: 11px; }
.tool-item-label { overflow-wrap: anywhere; }
.tool-notice { margin: 0; padding: 7px 9px; border-left: 2px solid var(--border); background: var(--bg2); color: var(--fg-dim); font-size: 11px; white-space: pre-wrap; overflow-wrap: anywhere; }
.tool-technical { border-top: 1px solid var(--border); padding-top: 7px; font-size: 11px; color: var(--fg-dim); }
.tool-technical summary { cursor: pointer; width: fit-content; }.tool-technical[open] summary { margin-bottom: 8px; }.tool-technical .tool-code { margin-bottom: 7px; max-height: 180px; }
summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }

/* Visual refinement: softened card, semantic status dot, token-derived tints. */
.tool-result {
  border-color: color-mix(in srgb, var(--border) 82%, var(--bg2));
  background: var(--glass-inset);
  border-radius: var(--radius-md);
  box-shadow: var(--glass-highlight);
}
.tool-result-summary::before {
  content: '';
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--success);
}
.tool-result-summary.error::before { background: var(--danger); }
.tool-result-summary.running::before { background: var(--accent); }
.tool-result-summary.cancelled::before { background: var(--fg-muted); }
.tool-result-summary.running { color: var(--accent); }
.tool-outcome {
  border-radius: 999px;
  padding: 1px 8px;
  background: var(--accent-soft);
  color: var(--accent-hover);
  font-weight: 550;
}
.tool-content-cap { font-weight: 600; letter-spacing: .03em; }
.tool-code, .tool-numbered-code {
  background: var(--surface-muted);
  border-radius: var(--radius-sm);
}
.tool-code.before { border-left: 3px solid var(--danger); background: color-mix(in srgb, var(--danger) 5%, var(--surface-muted)); }
.tool-code.after { border-left: 3px solid var(--success); background: color-mix(in srgb, var(--success) 6%, var(--surface-muted)); }
.tool-numbered-code span { color: color-mix(in srgb, var(--accent) 45%, var(--fg-dim)); opacity: .8; }
.tool-result-items li { border-bottom-color: color-mix(in srgb, var(--border) 70%, var(--bg2)); }
.tool-result-items a { transition: color var(--motion-hover) var(--ease-standard); }
.tool-result-items a:hover { color: var(--accent-hover); }
.tool-notice {
  border-left: 2px solid color-mix(in srgb, var(--warn) 55%, var(--border));
  background: var(--warn-soft);
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
  color: color-mix(in srgb, var(--warn) 72%, var(--fg));
}
.tool-technical { border-top-color: color-mix(in srgb, var(--border) 70%, var(--bg2)); }
.tool-technical summary { border-radius: 5px; transition: color var(--motion-hover) var(--ease-standard); }
.tool-technical summary:hover { color: var(--accent-hover); }
@media (prefers-reduced-motion: reduce) {
  .tool-result-items a, .tool-technical summary { transition: none; }
}
@media (forced-colors: active) {
  .tool-result { background: Canvas; box-shadow: none; }
  .tool-result-summary::before { background: CanvasText; }
  .tool-code.before, .tool-code.after { background: Canvas; }
}
</style>
