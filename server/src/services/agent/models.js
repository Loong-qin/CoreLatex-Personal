import { HttpError } from '../../util.js';
import { collaborationPolicy } from './orchestrationPolicy.js';

export const DEFAULT_CONTEXT_LENGTH = 262_144;
// Missing legacy configuration means no reasoning parameter, preserving old gateways.
export function normalizeReasoningLevels(value, { strict = false } = {}) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32 || value.some(level => typeof level !== 'string'
    || (level.trim() && !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,63}$/.test(level.trim())))) {
    if (strict) throw new HttpError(400, 'reasoningLevels 需为最多 32 项的字符串数组，每项最多 64 字符，仅支持字母、数字、下划线、点、冒号和连字符');
    return [];
  }
  return [...new Set(value.map(level => level.trim()).filter(Boolean))];
}

export function resolveReasoningEffort(model, requested) {
  const levels = normalizeReasoningLevels(model.reasoningLevels);
  if (requested !== undefined && requested !== null && requested !== '') {
    if (typeof requested !== 'string' || !levels.includes(requested.trim()))
      throw new HttpError(400, '所选思考强度不在当前模型的 reasoningLevels 中，请重新选择');
    return requested.trim();
  }
  return levels.includes('medium') ? 'medium' : levels[0];
}

const enabled = (value) => value !== false && value !== 'false' && value !== 0;

export function normalizeModelEntry(raw = {}, index = 0) {
  raw = raw && typeof raw === 'object' ? raw : {};
  const contextLength = Math.min(2_000_000, Math.max(1024, Math.round(Number(raw.contextLength) || DEFAULT_CONTEXT_LENGTH)));
  const optional = (value, min, max, round = false) => {
    if (value == null || value === '') return undefined;
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, round ? Math.round(n) : n)) : undefined;
  };
  return {
    id: String(raw.id || `m_${Date.now()}_${index}`).slice(0, 160),
    name: String(raw.name || raw.model || '').trim().slice(0, 80) || `模型 ${index + 1}`,
    model: String(raw.model || '').trim().slice(0, 160),
    enabled: enabled(raw.enabled), contextLength, vision: enabled(raw.vision),
    reasoningLevels: normalizeReasoningLevels(raw.reasoningLevels),
    temperature: optional(raw.temperature, 0, 2),
    maxTokens: optional(raw.maxTokens, 1, Math.min(200_000, Math.floor(contextLength / 2)), true),
    // Legacy compatibility: these fields only belong to a provider in v2.
    provider: raw.provider === 'anthropic' ? 'anthropic' : 'openai',
    baseUrl: String(raw.baseUrl || '').trim().replace(/\/+$/, ''),
    apiKey: String(raw.apiKey || ''),
  };
}

function modelOnly(raw, index) {
  const { provider, baseUrl, apiKey, ...model } = normalizeModelEntry(raw, index);
  return model;
}

export function migrateLegacyModels(models) {
  const providers = [];
  const groups = new Map();
  for (const [index, raw] of models.entries()) {
    const model = normalizeModelEntry(raw, index);
    if (!model.model) continue;
    const groupKey = JSON.stringify([model.provider, model.baseUrl, model.apiKey]);
    let provider = groups.get(groupKey);
    if (!provider) {
      let label = model.provider === 'anthropic' ? 'Anthropic 兼容' : 'OpenAI 兼容';
      try { if (model.baseUrl) label = new URL(model.baseUrl).hostname; } catch { /* Preserve old configuration for editing. */ }
      provider = { id: `p_legacy_${model.id}`, name: label, apiFormat: model.provider,
        baseUrl: model.baseUrl, apiKey: model.apiKey, enabled: true, models: [] };
      groups.set(groupKey, provider);
      providers.push(provider);
    }
    provider.models.push(modelOnly(model, index));
  }
  return providers;
}

function readJson(value, fallback) {
  try { return JSON.parse(value || ''); } catch { return fallback; }
}

/** Credential owner = provider; model IDs remain stable through migration. */
export function parseModelSettings(settingsRow) {
  const stored = readJson(settingsRow?.ai_providers, null);
  let providers;
  if (stored && !Array.isArray(stored) && stored.version === 2 && Array.isArray(stored.providers)) {
    providers = stored.providers;
  } else if (Array.isArray(stored) && stored.length) {
    providers = stored;
  } else {
    let legacy = readJson(settingsRow?.ai_models, []);
    legacy = Array.isArray(legacy) ? legacy : [];
    if (!legacy.length && settingsRow?.ai_model) legacy = [{
      id: 'legacy', name: settingsRow.ai_model, model: settingsRow.ai_model,
      provider: settingsRow.ai_provider, baseUrl: settingsRow.ai_base_url, apiKey: settingsRow.ai_api_key,
    }];
    providers = migrateLegacyModels(legacy);
  }
  providers = providers.filter((p) => p && typeof p === 'object').map((p, index) => ({
    id: String(p.id || `p_${index}`), name: String(p.name || '自定义供应商').slice(0, 80),
    apiFormat: p.apiFormat === 'anthropic' ? 'anthropic' : 'openai',
    baseUrl: String(p.baseUrl || '').trim().replace(/\/+$/, ''), apiKey: String(p.apiKey || ''),
    enabled: enabled(p.enabled),
    models: (Array.isArray(p.models) ? p.models : []).map(modelOnly).filter((m) => m.model),
  }));
  const models = providers.flatMap((p) => p.models.map((m) => ({
    ...m, providerId: p.id, providerName: p.name, provider: p.apiFormat,
    baseUrl: p.baseUrl, apiKey: p.apiKey, enabled: p.enabled && m.enabled,
    providerEnabled: p.enabled, modelEnabled: m.enabled,
  })));
  const available = models.filter((m) => m.enabled);
  let activeId = String(settingsRow?.ai_active || '');
  if (!available.some((m) => m.id === activeId)) activeId = available[0]?.id || '';
  return { providers, models, activeId };
}

export function validateProviders(rawProviders, oldProviders = []) {
  if (!Array.isArray(rawProviders)) throw new HttpError(400, 'providers 需为数组');
  if (rawProviders.length > 100) throw new HttpError(400, '最多配置 100 个供应商');
  const providerIds = new Set();
  const modelIds = new Set();
  let total = 0;
  return rawProviders.map((raw, index) => {
    if (!raw || typeof raw !== 'object') throw new HttpError(400, '供应商配置无效');
    const id = String(raw.id || '').trim();
    if (!id || id.length > 160 || providerIds.has(id)) throw new HttpError(400, '供应商 ID 不能为空或重复');
    providerIds.add(id);
    const name = String(raw.name || '').trim();
    if (!name || name.length > 80) throw new HttpError(400, '请填写 1–80 字的供应商名称');
    if (!['openai', 'anthropic'].includes(raw.apiFormat)) throw new HttpError(400, 'API 格式仅支持 OpenAI Chat Completions 或 Anthropic Messages');
    const baseUrl = String(raw.baseUrl || '').trim().replace(/\/+$/, '');
    if (baseUrl) {
      let url;
      try { url = new URL(baseUrl); } catch { throw new HttpError(400, `${name} 的 Base URL 无效`); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) {
        throw new HttpError(400, `${name} 的 Base URL 需为不含账号、查询参数和片段的 HTTP(S) 地址`);
      }
    }
    const old = oldProviders.find((p) => p.id === id);
    let apiKey = raw.apiKey === undefined ? (old?.apiKey || '') : String(raw.apiKey);
    if (apiKey.startsWith('***')) {
      if (!old) throw new HttpError(400, '新供应商需要填写真实 API Key');
      apiKey = old.apiKey;
    }
    if (apiKey.length > 16384) throw new HttpError(400, 'API Key 过长');
    if (!Array.isArray(raw.models)) throw new HttpError(400, `${name} 的 models 需为数组`);
    total += raw.models.length;
    if (total > 500) throw new HttpError(400, '最多配置 500 个模型');
    const models = raw.models.map((m, i) => {
      if (!m || typeof m !== 'object' || !String(m.model || '').trim()) throw new HttpError(400, '请填写模型 ID');
      normalizeReasoningLevels(m.reasoningLevels, { strict: true });
      const model = modelOnly(m, i);
      if (!m.id || modelIds.has(model.id)) throw new HttpError(400, '模型条目 ID 不能为空或重复');
      modelIds.add(model.id);
      for (const key of ['contextLength', 'temperature', 'maxTokens']) {
        if (m[key] != null && m[key] !== '' && !Number.isFinite(Number(m[key]))) throw new HttpError(400, `${model.name} 的 ${key} 需为数字`);
      }
      return model;
    });
    return { id, name, apiFormat: raw.apiFormat, baseUrl, apiKey, enabled: enabled(raw.enabled), models };
  });
}

export function resolveModelConfig(settingsRow, requestedId, requestedReasoningEffort) {
  const { models, activeId } = parseModelSettings(settingsRow);
  const wanted = String(requestedId || activeId || '');
  const found = models.find((m) => m.id === wanted);
  if (!found) throw new HttpError(400, requestedId ? '所选模型不存在，请重新选择' : '请先配置并启用供应商与模型');
  if (!found.enabled) throw new HttpError(400, '所选供应商或模型已停用，请重新选择');
  let defaults = {};
  try { defaults = JSON.parse(settingsRow?.agent_config || '{}'); } catch { /* defaults */ }
  const globalTokens = Number(defaults.maxTokens) || 128000;
  const globalTemperature = Number(defaults.temperature);
  return { ...found,
    reasoningEffort: resolveReasoningEffort(found, requestedReasoningEffort),
    maxTokens: found.maxTokens ?? Math.min(200000, Math.floor(found.contextLength / 2), Math.max(1, globalTokens)),
    temperature: found.temperature ?? (Number.isFinite(globalTemperature) ? Math.min(2, Math.max(0, globalTemperature)) : 0.7),
  };
}


/** Old clients and saved zero limits must not disable automatic repair. */
export function stripRetiredAgentConfig(config = {}) {
  const current = config && typeof config === 'object' && !Array.isArray(config) ? { ...config } : {};
  delete current.repairCycles;
  return current;
}

/** Validate persisted worker preferences against the same account's enabled models. */
export function validateSubagentConfig(config, { models, activeId }) {
  config = stripRetiredAgentConfig(config);
  try { collaborationPolicy(config); } catch (error) { throw new HttpError(400, error.message); }
  for (const [key, limit] of [['subagentModelId', 160], ['subagentReasoningEffort', 64]]) {
    if (config[key] !== undefined && (typeof config[key] !== 'string' || config[key].length > limit))
      throw new HttpError(400, `${key} 需为不超过 ${limit} 字符的字符串`);
  }
  const modelId = config.subagentModelId?.trim() || '';
  const effort = config.subagentReasoningEffort?.trim() || '';
  const model = models.find(item => item.id === (modelId || activeId));
  if (modelId && (!model || !model.enabled))
    throw new HttpError(400, '子智能体模型不存在或已停用；请先在智能体设置中选择可用模型或改为跟随主智能体');
  if (effort && (!model || !normalizeReasoningLevels(model.reasoningLevels).includes(effort)))
    throw new HttpError(400, '子智能体思考强度不受所选模型支持；请在智能体设置中重新选择或改为自动');
  return { ...config,
    ...(config.collaborationTier !== undefined ? { graphOrchestration: config.collaborationTier !== 'off' } : {}),
    ...(config.subagentModelId !== undefined ? { subagentModelId: modelId } : {}),
    ...(config.subagentReasoningEffort !== undefined ? { subagentReasoningEffort: effort } : {}),
  };
}

/** Resolve once per dispatched worker, preserving the coordinator's own config. */
export function resolveSubagentModelConfig(settingsRow, primaryConfig) {
  const config = readJson(settingsRow?.agent_config, {}) || {};
  const modelId = typeof config.subagentModelId === 'string' ? config.subagentModelId.trim() : '';
  const effort = typeof config.subagentReasoningEffort === 'string' ? config.subagentReasoningEffort.trim() : '';
  if (config.subagentModelId !== undefined && typeof config.subagentModelId !== 'string' ||
      config.subagentReasoningEffort !== undefined && typeof config.subagentReasoningEffort !== 'string')
    throw new HttpError(400, '子智能体模型设置无效，请在智能体设置中重新保存');
  try {
    if (modelId) return resolveModelConfig(settingsRow, modelId, effort || undefined);
    // The request can choose a different main model/effort than the saved default.
    return { ...primaryConfig, reasoningEffort: resolveReasoningEffort(primaryConfig, effort || primaryConfig.reasoningEffort) };
  } catch (error) {
    throw new HttpError(400, '子智能体模型配置不可用：' + error.message + '；请在智能体设置中调整子模型或思考强度（自动）');
  }
}
