<script setup>
import { computed } from 'vue';
import { modelReasoningLevels, modelReasoningEffort, reasoningLevelLabel } from '../lib/settings.js';

const props = defineProps({
  providers: { type: Array, default: () => [] }, activeModelId: { type: String, default: '' },
  modelId: { type: String, default: '' }, reasoningEffort: { type: String, default: '' },
  tier: { type: String, default: '' }, maxConcurrency: { type: Number, default: 2 },
});
const emit = defineEmits(['change']);
const models = computed(() => props.providers.filter(p => p.enabled !== false).flatMap(p =>
  (p.models || []).filter(m => m.enabled !== false && m.model?.trim()).map(m => ({ ...m, providerName: p.name }))));
const model = computed(() => models.value.find(m => m.id === (props.modelId || props.activeModelId)));
const missingModel = computed(() => Boolean(props.modelId && !model.value));
const levels = computed(() => modelReasoningLevels(model.value));
const invalidEffort = computed(() => Boolean(props.reasoningEffort && !levels.value.includes(props.reasoningEffort)));
const automaticLabel = computed(() => {
  if (!props.modelId) return '跟随主智能体';
  const level = modelReasoningEffort(model.value);
  return level ? `模型默认（${reasoningLevelLabel(level)}）` : '模型默认';
});
function selectModel(id) {
  const nextModel = models.value.find(m => m.id === (id || props.activeModelId));
  emit('change', { subagentModelId: id,
    subagentReasoningEffort: modelReasoningLevels(nextModel).includes(props.reasoningEffort) ? props.reasoningEffort : '' });
}
</script>

<template>
  <section class="subagent-settings" aria-label="子智能体配置">
    <div class="subagent-fields">
      <div class="subagent-field">
        <label>协作档位</label>
        <el-select :model-value="tier || 'legacy'" aria-label="协作档位" @update:model-value="emit('change', { collaborationTier: $event, graphOrchestration: true })">
          <el-option v-if="!tier" label="兼容原设置" value="legacy" disabled />
          <el-option label="轻量 · 仅增量审阅" value="lite" />
          <el-option label="标准 · 按需分析与核验" value="full" />
          <el-option label="深入 · 允许并行编辑" value="deep" />
        </el-select>
      </div>
      <div class="subagent-field">
        <label>同时请求模型的数量</label>
        <el-input-number :model-value="maxConcurrency" :min="1" :max="8" :precision="0" aria-label="模型并发数"
          @update:model-value="emit('change', { maxModelConcurrency: $event ?? 2 })" />
      </div>
      <div class="subagent-field">
        <label id="subagent-model-label">子智能体模型</label>
        <el-select :empty-values="[null, undefined]" :model-value="modelId" aria-label="子智能体模型" aria-labelledby="subagent-model-label" @update:model-value="selectModel">
          <el-option label="跟随主智能体" value="" />
          <el-option v-if="missingModel" label="原模型已不可用 · 请重新选择" :value="modelId" disabled />
          <el-option v-for="item in models" :key="item.id" :value="item.id" :label="`${item.providerName || '模型'} · ${item.name || item.model}`" />
        </el-select>
      </div>
      <div class="subagent-field">
        <label id="subagent-reasoning-label">子智能体思考强度</label>
        <el-select :empty-values="[null, undefined]" :model-value="reasoningEffort" aria-label="子智能体思考强度" aria-labelledby="subagent-reasoning-label"
          :disabled="!levels.length && !invalidEffort"
          @update:model-value="emit('change', { subagentReasoningEffort: $event })">
          <el-option :label="automaticLabel" value="" />
          <el-option v-if="invalidEffort" :label="`${reasoningLevelLabel(reasoningEffort)}（当前模型不支持）`" :value="reasoningEffort" disabled />
          <el-option v-for="level in levels" :key="level" :value="level" :label="reasoningLevelLabel(level)" />
        </el-select>
      </div>
    </div>
    <p v-if="missingModel || invalidEffort" class="subagent-hint unavailable" role="status">{{ missingModel ? '原模型已删除或停用，请重新选择模型或恢复为跟随主智能体。' : '当前模型不支持已保存的思考强度，请选择可用档位或恢复默认。' }}</p>
    <p v-else-if="!model" class="subagent-hint">请先在模型设置中添加并启用模型。</p>
    <p v-else-if="!levels.length" class="subagent-hint">当前模型未配置思考档位，无需单独设置强度。</p>
    <p v-else class="subagent-hint">{{ modelId ? '未单独选择强度时使用该模型默认档位。' : '未单独选择强度时跟随主智能体当前档位；更换主模型后，单独选择的档位须受新模型支持。' }}</p>
    <p class="subagent-hint">审查仅检测本轮新增或修改内容引入的冲突、事实性错误。编译错误默认自动修复并重新验证；无法继续时保留草稿并说明原因。必要的重新读取不受限制。模型并发数不包含等待工具的子任务。</p>
  </section>
</template>

<style scoped>
.subagent-settings { padding: 20px 0; border-bottom: 1px solid var(--border); }
.subagent-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; }
.subagent-field { min-width: 0; }
.subagent-field label { display: block; margin-bottom: 9px; font-size: 12px; font-weight: 500; color: var(--fg); }
.subagent-field .el-select { width: 100%; }
.subagent-hint { margin: 10px 0 0; font-size: 12px; line-height: 1.8; color: var(--fg-dim); }
.unavailable { color: var(--warning, var(--fg)); }
@container(max-width:600px) { .subagent-fields { grid-template-columns: 1fr; gap: 14px; } }
@media(max-width:760px) { .subagent-fields { grid-template-columns: 1fr; gap: 14px; } }

/* Visual refinement layer: quieter labels, semantic warning strip. */
.subagent-field label { font-weight: 550; color: var(--fg-dim); letter-spacing: .01em; }
.subagent-field :deep(.el-select__wrapper) { border-radius: var(--radius-sm); }
.subagent-field :deep(.el-input-number) { border-radius: var(--radius-sm); }
.subagent-hint.unavailable {
  padding: 8px 11px;
  border-left: 2px solid color-mix(in srgb, var(--warn) 55%, var(--border));
  background: var(--warn-soft);
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
  color: color-mix(in srgb, var(--warn) 78%, var(--fg));
}
@media (forced-colors: active) {
  .subagent-hint.unavailable { background: Canvas; }
}
</style>
