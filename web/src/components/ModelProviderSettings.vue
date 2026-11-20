<script setup>
import { computed, ref, watch } from 'vue';
import { useAgentStore } from '../stores/agent.js';
import { useUiStore } from '../stores/ui.js';
import { DEFAULT_CONTEXT_LENGTH, DEFAULT_PROVIDER_URLS, DEFAULT_REASONING_LEVELS, normalizeProviderList, normalizeReasoningLevels, reasoningLevelLabel, createSettingsId } from '../lib/settings.js';

const props = defineProps({ providers: { type: Array, default: () => [] }, activeModelId: { type: String, default: '' } });
const emit = defineEmits(['saved']);
const agent = useAgentStore();
const ui = useUiStore();
const providers = ref([]);
const activeModelId = ref('');
const selectedId = ref('');
const baseline = ref('');
const saving = ref(false);
const testing = ref('');
const testResults = ref({});
const query = ref('');
const snapshot = () => JSON.stringify({ providers: providers.value, activeModelId: activeModelId.value });
const dirty = computed(() => snapshot() !== baseline.value);
const selected = computed(() => providers.value.find((p) => p.id === selectedId.value));
const visibleProviders = computed(() => providers.value.filter((p) => p.name.toLowerCase().includes(query.value.toLowerCase())));
function load(providersSource, active) {
  providers.value = normalizeProviderList(providersSource);
  activeModelId.value = active || '';
  if (!providers.value.some((p) => p.id === selectedId.value)) selectedId.value = providers.value[0]?.id || '';
  baseline.value = snapshot();
}
load(props.providers, props.activeModelId);
watch(() => [props.providers, props.activeModelId], () => {
  if (!dirty.value) load(props.providers, props.activeModelId);
});
function ensureDefault() {
  const available = providers.value.filter((p) => p.enabled).flatMap((p) => p.models.filter((m) => m.enabled));
  if (!available.some((m) => m.id === activeModelId.value)) activeModelId.value = available[0]?.id || '';
}
watch(() => providers.value.map((p) => [p.enabled, ...p.models.map((m) => `${m.id}:${m.enabled}`)]), ensureDefault, { deep: true });

const providerDialog = ref(false);
const providerDraft = ref({ name: '', template: 'custom' });
function addProvider() {
  providerDraft.value = { name: '', template: 'custom' };
  providerDialog.value = true;
}
function submitProvider() {
  if (!providerDialog.value) return;
  const name = providerDraft.value.name.trim();
  if (!name) return ui.error('请填写供应商名称');
  const template = providerDraft.value.template;
  const provider = { id: createSettingsId('p'), name, enabled: true,
    apiFormat: template === 'anthropic' ? 'anthropic' : 'openai',
    baseUrl: template === 'custom' ? '' : DEFAULT_PROVIDER_URLS[template], apiKey: '', models: [] };
  providers.value.push(provider);
  selectedId.value = provider.id;
  query.value = '';
  providerDialog.value = false;
}
async function removeProvider() {
  const provider = selected.value;
  if (!provider || !(await ui.confirm(`删除「${provider.name}」及其 ${provider.models.length} 个模型？保存后生效。`, '删除供应商'))) return;
  providers.value = providers.value.filter((p) => p.id !== provider.id);
  selectedId.value = providers.value[0]?.id || '';
  ensureDefault();
}
const modelDialog = ref(false);
const modelDraft = ref({});
const editingProviderId = ref('');
function editModel(model = null) {
  if (!selected.value) return;
  editingProviderId.value = selected.value.id;
  modelDraft.value = model ? { ...model, reasoningLevels: normalizeReasoningLevels(model.reasoningLevels) } : { id: createSettingsId('m'), name: '', model: '', enabled: true, contextLength: DEFAULT_CONTEXT_LENGTH, vision: true, temperature: undefined, maxTokens: undefined, reasoningLevels: [...DEFAULT_REASONING_LEVELS] };
  modelDialog.value = true;
}
function submitModel() {
  const provider = providers.value.find((p) => p.id === editingProviderId.value);
  if (!provider) return;
  const model = String(modelDraft.value.model || '').trim();
  if (!model) return ui.error('请填写 API 模型标识');
  const reasoningLevels = normalizeReasoningLevels(modelDraft.value.reasoningLevels);
  if (reasoningLevels.length > 32 || reasoningLevels.some(level => level.length > 64 || !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(level)))
    return ui.error('思考强度最多32档，每档不超过64个字符；请使用字母、数字或 _ . : -，不要包含空格。');
  const entry = { ...modelDraft.value, reasoningLevels, model, name: String(modelDraft.value.name || '').trim() || model };
  const index = provider.models.findIndex((m) => m.id === entry.id);
  if (index < 0) provider.models.push(entry);
  else provider.models.splice(index, 1, entry);
  ensureDefault();
  modelDialog.value = false;
}
async function removeModel(model) {
  if (!(await ui.confirm(`删除模型「${model.name || model.model}」？保存后生效。`, '删除模型'))) return;
  selected.value.models = selected.value.models.filter((m) => m.id !== model.id);
  ensureDefault();
}
async function save() {
  if (saving.value || !dirty.value) return;
  for (const provider of providers.value) {
    if (!provider.name.trim()) return ui.error('供应商名称不能为空');
    if (provider.baseUrl && !/^https?:\/\//i.test(provider.baseUrl)) return ui.error('API Base URL 需以 http:// 或 https:// 开头');
  }
  ensureDefault();
  saving.value = true;
  try {
    const settings = await agent.saveSettings({ providers: normalizeProviderList(providers.value), activeModelId: activeModelId.value });
    load(settings.providers || [], settings.activeModelId);
    testResults.value = {};
    emit('saved', settings);
    ui.toast('供应商和模型已保存');
  } catch (e) { ui.error(e.message || '保存失败'); }
  finally { saving.value = false; }
}
async function test(modelId) {
  if (!selected.value || dirty.value || saving.value || testing.value) return;
  const providerId = selected.value.id;
  const key = modelId || providerId;
  testing.value = key;
  try {
    const result = await agent.testConnection({ providerId, ...(modelId ? { modelId } : {}) });
    testResults.value = { ...testResults.value, [key]: { ok: result.ok, message: result.message || (result.ok ? '连接成功' : '连接失败') } };
  } catch (e) { testResults.value = { ...testResults.value, [key]: { ok: false, message: e.message || '连接失败' } }; }
  finally { testing.value = ''; }
}
</script>

<template>
  <div class="provider-settings">
    <div class="provider-toolbar">
      <span class="save-state" :class="{ changed: dirty }" role="status"><span class="save-dot" aria-hidden="true"></span>{{ dirty ? '有未保存的更改' : '配置已保存' }}</span>
      <el-button type="primary" :loading="saving" :disabled="!dirty || saving" @click="save">保存更改</el-button>
    </div>
    <fieldset class="provider-layout" :disabled="saving">
      <aside class="provider-sidebar" aria-label="供应商列表">
        <div class="provider-sidebar-head"><strong>供应商</strong><el-button text size="small" :disabled="saving" @click="addProvider">＋ 新增</el-button></div>
        <el-input v-model="query" placeholder="搜索供应商" clearable size="small" aria-label="搜索供应商" />
        <div class="provider-list">
          <button v-for="provider in visibleProviders" :key="provider.id" type="button" class="provider-choice"
            :class="{ selected: provider.id === selectedId }" :aria-pressed="provider.id === selectedId" @click="selectedId = provider.id">
            <span class="provider-avatar">{{ provider.name.slice(0, 1).toUpperCase() }}</span>
            <span class="provider-choice-copy"><strong>{{ provider.name }}</strong><small>{{ provider.models.length }} 个模型</small></span>
            <span class="provider-dot" :class="{ enabled: provider.enabled }" :title="provider.enabled ? '已启用' : '已停用'"></span>
          </button>
          <p v-if="!visibleProviders.length" class="empty-providers">{{ providers.length ? '没有匹配的供应商' : '添加供应商以开始配置' }}</p>
        </div>
      </aside>

      <section v-if="selected" class="provider-detail" :key="selected.id">
        <div class="provider-heading">
          <div class="provider-heading-copy"><span class="provider-heading-avatar" aria-hidden="true">{{ selected.name.slice(0, 1).toUpperCase() }}</span><div><h3>{{ selected.name }}</h3><p>此供应商下的模型共用连接地址和密钥。</p></div></div>
          <el-switch v-model="selected.enabled" active-text="启用" :disabled="saving" :aria-label="'启用供应商 ' + selected.name" />
        </div>
        <el-form label-position="top" class="provider-form" @submit.prevent>
          <el-form-item label="供应商名称"><el-input v-model="selected.name" :disabled="saving" /></el-form-item>
          <el-form-item label="API 格式">
            <el-select v-model="selected.apiFormat" :disabled="saving">
              <el-option value="openai" label="OpenAI Chat Completions 兼容" />
              <el-option value="anthropic" label="Anthropic Messages 兼容" />
            </el-select>
          </el-form-item>
          <el-form-item label="API Base URL" class="provider-wide">
            <el-input v-model.trim="selected.baseUrl" :placeholder="DEFAULT_PROVIDER_URLS[selected.apiFormat]" autocomplete="url" :disabled="saving" />
            <span class="provider-hint">填写兼容服务的基础地址；留空使用对应格式的默认地址。</span>
          </el-form-item>
          <el-form-item label="API Key" class="provider-wide">
            <el-input v-model="selected.apiKey" type="password" show-password autocomplete="new-password" placeholder="输入供应商 API key" :disabled="saving" />
            <span class="provider-hint">已保存的密钥以掩码显示；保留掩码不会覆盖原密钥。清空并保存会移除密钥。</span>
          </el-form-item>
        </el-form>
        <div class="provider-test">
          <el-button :disabled="dirty || saving || !!testing || !selected.models.length" :loading="testing === selected.id" @click="test()">测试连接</el-button>
          <span v-if="dirty" class="provider-hint">先保存更改，再测试连接。</span>
          <span v-else-if="testResults[selected.id]" class="provider-result" :class="{ error: !testResults[selected.id].ok }" role="status">{{ testResults[selected.id].message }}</span>
        </div>
        <div class="models-heading"><div><h4><svg class="heading-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" /><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5" /></svg>模型</h4><span class="provider-hint">选择默认模型，或在对话面板随时切换。</span></div><el-button size="small" :disabled="saving" @click="editModel()">＋ 添加模型</el-button></div>
        <div v-if="!selected.models.length" class="models-empty"><svg class="empty-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" /><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5" /></svg>尚未添加模型。请填写服务提供的 API 模型标识。</div>
        <div v-for="model in selected.models" :key="model.id" class="provider-model" :class="{ inactive: !model.enabled || !selected.enabled }">
          <div class="model-copy"><strong>{{ model.name || model.model }}</strong><code>{{ model.model }}</code><span class="model-meta">{{ Math.round(model.contextLength / 1024) }}K 上下文 · {{ model.vision ? '支持图像' : '文本输入' }}</span></div>
          <div class="model-controls">
            <el-tag v-if="activeModelId === model.id" size="small" type="success">默认</el-tag>
            <el-button v-else text size="small" :disabled="!model.enabled || !selected.enabled || saving" @click="activeModelId = model.id">设为默认</el-button>
            <el-switch v-model="model.enabled" size="small" :disabled="saving" :aria-label="'启用 ' + model.name" />
            <el-button text size="small" :disabled="dirty || saving || !!testing" :loading="testing === model.id" @click="test(model.id)">测试</el-button>
            <el-button text size="small" :disabled="saving" :aria-label="'编辑模型 ' + model.name" @click="editModel(model)">编辑</el-button>
            <el-button text type="danger" size="small" :disabled="saving" :aria-label="'删除模型 ' + model.name" @click="removeModel(model)">删除</el-button>
          </div>
          <span v-if="testResults[model.id]" class="provider-result model-result" :class="{ error: !testResults[model.id].ok }" role="status">{{ testResults[model.id].message }}</span>
        </div>
        <div class="provider-danger"><el-button text type="danger" :disabled="saving" @click="removeProvider">删除供应商</el-button></div>
      </section>
      <section v-else class="provider-detail provider-empty"><svg class="provider-empty-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2z" /><path d="M9 9h6M9 12h6M9 15h3.5" /></svg><h3>管理你的模型服务</h3><p>先添加供应商，再添加其支持的模型。</p><el-button type="primary" @click="addProvider">添加供应商</el-button></section>
    </fieldset>

    <el-dialog v-model="providerDialog" title="添加供应商" width="min(480px, 94vw)">
      <el-form label-position="top" @submit.prevent="submitProvider">
        <el-form-item label="供应商名称" required><el-input v-model="providerDraft.name" placeholder="例如：我的模型服务" /></el-form-item>
        <el-form-item label="连接模板"><el-select v-model="providerDraft.template"><el-option label="自定义兼容服务" value="custom" /><el-option label="OpenAI" value="openai" /><el-option label="Anthropic" value="anthropic" /></el-select></el-form-item>
      </el-form>
      <template #footer><el-button @click="providerDialog = false">取消</el-button><el-button type="primary" @click="submitProvider">添加</el-button></template>
    </el-dialog>
    <el-dialog v-model="modelDialog" title="模型配置" width="min(580px, 94vw)">
      <el-form label-position="top" class="provider-form" @submit.prevent="submitModel">
        <el-form-item label="显示名称"><el-input v-model="modelDraft.name" placeholder="用于识别模型" /></el-form-item>
        <el-form-item label="API 模型标识" required><el-input v-model.trim="modelDraft.model" placeholder="服务商提供的模型名称" /></el-form-item>
        <el-form-item label="上下文长度"><el-input-number v-model="modelDraft.contextLength" :min="1024" :max="2000000" :step="1024" /></el-form-item>
        <el-form-item label="支持图像输入"><el-switch v-model="modelDraft.vision" /></el-form-item>
        <el-form-item label="Temperature（可选）"><el-input-number v-model="modelDraft.temperature" :min="0" :max="2" :step="0.1" placeholder="继承全局设置" /></el-form-item>
        <el-form-item label="最大输出（可选）"><el-input-number v-model="modelDraft.maxTokens" :min="1" :max="200000" placeholder="继承全局设置" /></el-form-item>
        <el-form-item label="思考强度档位" class="provider-wide">
          <div class="reasoning-levels">
            <div v-for="(level, index) in modelDraft.reasoningLevels" :key="index" class="reasoning-level-row">
              <el-input v-model="modelDraft.reasoningLevels[index]" size="small" placeholder="例如 max" :aria-label="`思考强度 ${index + 1}`" />
              <span v-if="reasoningLevelLabel(level) !== level" class="reasoning-level-label">{{ reasoningLevelLabel(level) }}</span>
              <el-button text type="danger" size="small" :aria-label="`删除思考强度 ${index + 1}`" @click="modelDraft.reasoningLevels.splice(index, 1)">×</el-button>
            </div>
            <el-button size="small" :disabled="modelDraft.reasoningLevels?.length >= 32" @click="modelDraft.reasoningLevels.push('')">＋ 添加档位</el-button>
            <span class="provider-hint">填写供应商支持的档位，例如 max；删除全部后不启用思考强度。</span>
          </div>
        </el-form-item>
        <span class="provider-hint provider-wide">模型共用所属供应商的 API 格式、地址和密钥。</span>
      </el-form>
      <template #footer><el-button @click="modelDialog = false">取消</el-button><el-button type="primary" @click="submitModel">确认</el-button></template>
    </el-dialog>
  </div>
</template>

<style scoped>
.reasoning-levels { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; width: 100%; }
.reasoning-level-row { display: flex; align-items: center; flex: 0 0 126px; max-width: 100%; min-width: 0; border: 1px solid var(--border); border-radius: 8px; background: var(--surface-muted,var(--bg)); }
.reasoning-level-row:focus-within { border-color: var(--accent); }
.reasoning-level-row .el-input { flex: 1; min-width: 0; }
.reasoning-level-row :deep(.el-input__wrapper) { padding: 1px 7px; box-shadow: none; background: transparent; }
.reasoning-level-row .el-button { flex: none; width: 25px; margin: 0; padding: 0; }
.reasoning-level-label { flex: none; color: var(--fg-dim); font-size: 10px; }
.reasoning-levels > .provider-hint { flex-basis: 100%; margin-top: 0; }

.provider-settings{container-type:inline-size;min-width:0}.provider-toolbar{position:sticky;top:0;z-index:3;display:flex;align-items:center;justify-content:space-between;gap:14px;margin:0 0 18px;padding:10px 0 14px;background:var(--surface-raised,var(--bg2));border-bottom:1px solid var(--border)}.save-state{display:flex;align-items:center;gap:7px;font-size:11px;color:var(--fg-dim)}.save-dot{height:5px;width:5px;border-radius:50%;background:var(--fg-dim);opacity:.55}.save-state.changed{color:var(--accent)}.save-state.changed .save-dot{background:var(--accent);opacity:1}.provider-layout{display:grid;grid-template-columns:210px minmax(0,1fr);border:1px solid var(--border);border-radius:12px;padding:0;margin:0;min-width:0;overflow:hidden;background:var(--surface-raised,var(--bg2))}.provider-sidebar{padding:18px 12px;background:var(--surface-muted,var(--bg));border-right:1px solid var(--border)}.provider-sidebar-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:16px;font-size:12px;padding:0 4px}.provider-sidebar-head strong{font-weight:600}.provider-list{display:flex;flex-direction:column;gap:5px;margin-top:14px}.provider-choice{display:flex;align-items:center;gap:10px;min-width:0;width:100%;padding:12px 9px;text-align:left;border:1px solid transparent;background:transparent;border-radius:9px;color:var(--fg);cursor:pointer}.provider-choice:hover{background:var(--bg-hover)}.provider-choice.selected{background:var(--accent-soft);border-color:color-mix(in srgb,var(--accent) 25%,transparent)}.provider-choice:focus-visible{outline:2px solid var(--accent);outline-offset:1px}.provider-avatar{flex:none;display:grid;place-items:center;width:31px;height:33px;border:1px solid var(--border);border-radius:8px;background:var(--surface-raised,var(--bg2));font-family:Georgia,serif;font-size:16px;color:var(--accent)}.provider-choice-copy{display:flex;flex-direction:column;gap:4px;min-width:0;flex:1}.provider-choice-copy strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;font-weight:550}.provider-choice-copy small{font-size:10px;color:var(--fg-dim)}.provider-dot{width:5px;height:5px;flex:none;border-radius:50%;background:var(--fg-dim);opacity:.5}.provider-dot.enabled{background:var(--accent);opacity:1}.provider-detail{padding:26px;min-width:0}.provider-heading{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:28px}.provider-heading-copy{display:flex;align-items:center;gap:12px;min-width:0}.provider-heading-avatar{display:grid;place-items:center;flex:none;height:42px;width:40px;border:1px solid color-mix(in srgb,var(--accent) 20%,var(--border));border-radius:10px;background:var(--accent-soft);color:var(--accent);font-family:Georgia,serif;font-size:23px}.provider-heading h3{margin:0;font-size:19px;font-weight:600;line-height:1.5;overflow-wrap:anywhere;letter-spacing:-.3px}.provider-heading p{margin:5px 0 0;font-size:11px;line-height:1.7;color:var(--fg-dim)}.provider-heading>.el-switch{flex:none}.provider-form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 18px}.provider-form :deep(.el-form-item){min-width:0;margin-bottom:21px}.provider-form :deep(.el-form-item__label){font-size:12px;color:var(--fg);padding-bottom:8px}.provider-form :deep(.el-select),.provider-form :deep(.el-input-number){width:100%}.provider-wide{grid-column:1/-1}.provider-hint{font-size:11px;color:var(--fg-dim);line-height:1.75;margin-top:6px;display:block;overflow-wrap:anywhere}.provider-test{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:2px}.provider-result{font-size:12px;color:var(--accent);overflow-wrap:anywhere}.provider-result.error{color:var(--danger)}.models-heading{display:flex;align-items:center;justify-content:space-between;gap:14px;margin:28px 0 18px;border-top:1px solid var(--border);padding-top:24px}.models-heading h4{margin:0;font-size:14px;font-weight:600}.models-heading>.el-button{flex:none}.provider-model{display:flex;align-items:center;gap:14px;flex-wrap:wrap;border:1px solid var(--border);border-radius:10px;background:var(--surface-muted,var(--bg));padding:16px;margin-bottom:10px}.provider-model.inactive .model-copy{opacity:.55}.model-copy{min-width:100px;flex:1;display:flex;flex-direction:column;gap:5px;overflow-wrap:anywhere}.model-copy strong{font-size:13px;font-weight:550;line-height:1.5}.model-copy code{font-size:11px;color:var(--fg-dim);line-height:1.5}.model-meta{font-size:10px;color:var(--fg-dim);line-height:1.7}.model-controls{display:flex;align-items:center;gap:6px;flex-wrap:wrap}.model-controls .el-button{margin-left:0}.model-controls .el-switch{margin:0 4px}.model-result{width:100%}.provider-danger{margin-top:28px;border-top:1px solid var(--border);padding-top:15px}.provider-danger .el-button{padding-left:0}.models-empty{border:1px dashed var(--border);border-radius:10px;padding:24px 18px;background:var(--surface-muted,var(--bg));font-size:12px;line-height:1.8;color:var(--fg-dim)}.empty-providers{font-size:12px;line-height:1.8;color:var(--fg-dim);padding:15px 6px}.provider-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:380px;text-align:center}.provider-empty h3{font-size:18px;font-weight:600;margin:0 0 12px}.provider-empty p{font-size:12px;color:var(--fg-dim);line-height:1.8;margin:0 0 24px}
@container(max-width:900px){.provider-layout{grid-template-columns:180px minmax(0,1fr)}.provider-detail{padding:22px}.model-controls{width:100%;border-top:1px solid var(--border);padding-top:10px;gap:8px}}
@container(max-width:650px){.provider-layout{grid-template-columns:1fr}.provider-sidebar{border-right:none;border-bottom:1px solid var(--border);padding:15px}.provider-sidebar-head{margin-bottom:11px}.provider-list{flex-direction:row;overflow:auto;padding:1px 1px 5px;margin-top:10px;scrollbar-width:thin}.provider-choice{flex:none;min-width:165px;max-width:220px;padding:10px}.provider-form{grid-template-columns:1fr}.provider-wide{grid-column:auto}.provider-detail{padding:20px}.provider-heading{align-items:flex-start;gap:10px}.provider-heading-avatar{display:none}.provider-heading h3{font-size:18px}.provider-heading p{font-size:11px}.models-heading{align-items:flex-start}.provider-toolbar{gap:10px}.save-state{font-size:10px}}
@media(max-width:760px){.provider-layout{grid-template-columns:1fr}.provider-sidebar{border-right:none;border-bottom:1px solid var(--border)}.provider-list{flex-direction:row;overflow:auto}.provider-choice{flex:none;min-width:165px;max-width:220px}.provider-form{grid-template-columns:1fr}.provider-wide{grid-column:auto}.provider-detail{padding:18px}.model-controls{width:100%;border-top:1px solid var(--border);padding-top:10px}.models-heading{gap:10px}.provider-heading-copy{gap:9px}}

/* Visual refinement layer: glass chrome, tinted avatars, token motion. */
.provider-toolbar {
  background: var(--glass-g2-bg);
  -webkit-backdrop-filter: var(--glass-g2-filter);
  backdrop-filter: var(--glass-g2-filter);
  border-bottom-color: color-mix(in srgb, var(--border) 80%, var(--bg2));
}
.save-state.changed .save-dot { animation: save-dot-pulse 1.8s var(--ease-standard) infinite; }
@keyframes save-dot-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .4; } }
.provider-layout {
  border-color: var(--glass-edge);
  border-radius: var(--radius-lg);
  background: var(--glass-g1-bg);
  box-shadow: var(--glass-shadow);
}
.provider-choice { transition: background-color var(--motion-hover) var(--ease-standard), border-color var(--motion-hover) var(--ease-standard); }
.provider-choice.selected { box-shadow: var(--glass-highlight); }
.provider-avatar {
  background: linear-gradient(180deg, var(--surface-raised), color-mix(in srgb, var(--accent) 9%, var(--surface-raised)));
  border-color: color-mix(in srgb, var(--accent) 22%, var(--border));
}
.provider-heading-avatar {
  background: linear-gradient(160deg, color-mix(in srgb, var(--accent) 14%, var(--surface-raised)), color-mix(in srgb, var(--accent-secondary) 12%, var(--surface-raised)));
  border-radius: var(--radius-md);
  box-shadow: var(--glass-highlight);
}
.provider-result { color: var(--success); }
.provider-result.error { color: var(--danger); }
.heading-icon { width: 14px; height: 14px; margin-right: 6px; vertical-align: -2px; fill: none; stroke: var(--accent); stroke-width: 1.6; stroke-linejoin: round; }
.models-heading h4 { letter-spacing: -.01em; }
.provider-model {
  border-radius: var(--radius-md);
  border-color: color-mix(in srgb, var(--border) 85%, var(--bg2));
  transition: border-color var(--motion-hover) var(--ease-standard), background-color var(--motion-hover) var(--ease-standard);
}
.provider-model:hover { border-color: color-mix(in srgb, var(--accent) 30%, var(--border)); background: var(--surface-raised); }
.model-copy code { font-family: var(--mono); }
.models-empty { border-color: color-mix(in srgb, var(--accent) 26%, var(--border)); text-align: center; }
.empty-icon { display: block; width: 22px; height: 22px; margin: 0 auto 8px; fill: none; stroke: var(--accent-secondary); stroke-width: 1.5; stroke-linejoin: round; opacity: .85; }
.provider-empty-icon { width: 30px; height: 30px; margin-bottom: 14px; fill: none; stroke: var(--accent-secondary); stroke-width: 1.4; stroke-linecap: round; stroke-linejoin: round; opacity: .85; }
.reasoning-level-row:focus-within { box-shadow: 0 0 0 3px var(--focus-ring); }
@media (prefers-reduced-motion: reduce) {
  .save-state.changed .save-dot { animation: none; }
  .provider-choice, .provider-model { transition: none; }
}
@media (forced-colors: active) {
  .save-state.changed .save-dot { animation: none; }
  .provider-layout { background: Canvas; box-shadow: none; }
  .provider-avatar, .provider-heading-avatar { background: Canvas; box-shadow: none; }
  .provider-toolbar { background: Canvas; -webkit-backdrop-filter: none; backdrop-filter: none; }
}
</style>
