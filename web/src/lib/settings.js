export const DEFAULT_AGENT_CONFIG = Object.freeze({ temperature: 0.7, maxTokens: 128000, allowRunScripts: true, confirmBeforeApply: false, allowWebAccess: true, graphOrchestration: false, completionSound: true, subagentModelId: '', subagentReasoningEffort: '' });
export const DEFAULT_PROVIDER_URLS = Object.freeze({ openai: 'https://api.openai.com/v1', anthropic: 'https://api.anthropic.com/v1' });
export const DEFAULT_REASONING_LEVELS = Object.freeze(['low', 'medium', 'high', 'xhigh']);
// Missing levels belong to legacy models: do not begin sending a new API
// parameter until the user explicitly configures support for it.
export function normalizeReasoningLevels(raw) {
  return Array.isArray(raw) ? [...new Set(raw.filter(level => typeof level === 'string').map(level => level.trim()).filter(Boolean))] : [];
}
export function modelReasoningLevels(model) { return normalizeReasoningLevels(model?.reasoningLevels); }
export function modelReasoningEffort(model) {
  const levels = modelReasoningLevels(model);
  return levels.includes('medium') ? 'medium' : levels[0] || '';
}
export function reasoningLevelLabel(level) {
  const labels = { low: '低', medium: '中', high: '高', xhigh: '极高', max: '最高' };
  return Object.hasOwn(labels, level) ? labels[level] : level;
}

let localIdSerial = 0;
export function createSettingsId(prefix) {
  const crypto = globalThis.crypto;
  if (typeof crypto?.randomUUID === 'function') return `${prefix}_${crypto.randomUUID()}`;
  // getRandomValues remains available on ordinary HTTP intranet deployments.
  if (typeof crypto?.getRandomValues === 'function') {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return `${prefix}_${Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('')}`;
  }
  // These are local configuration identities, never authentication credentials.
  return `${prefix}_${Date.now().toString(36)}_${++localIdSerial}_${Math.random().toString(36).slice(2)}`;
}

export const DEFAULT_CONTEXT_LENGTH = 262144; // 256k：模型上下文默认长度，超出由智能体自动压缩
function finiteNumber(value, fallback) { const n = Number(value); return Number.isFinite(n) ? n : fallback; }
export function normalizeAgentConfig(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const temperature = Math.min(2, Math.max(0, finiteNumber(source.temperature, DEFAULT_AGENT_CONFIG.temperature)));
  const maxTokens = Math.min(128000, Math.max(1, Math.round(finiteNumber(source.maxTokens, DEFAULT_AGENT_CONFIG.maxTokens))));
  const tier = ['off', 'lite', 'full', 'deep'].includes(source.collaborationTier) ? source.collaborationTier : undefined;
  return { temperature: Number(temperature.toFixed(2)), maxTokens,
    allowRunScripts: source.allowRunScripts !== false, confirmBeforeApply: source.confirmBeforeApply === true,
    allowWebAccess: source.allowWebAccess !== false, graphOrchestration: tier ? tier !== 'off' : source.graphOrchestration === true,
    ...(tier ? { collaborationTier: tier } : {}),
    ...(source.maxModelConcurrency !== undefined ? { maxModelConcurrency: Math.min(8, Math.max(1, Math.round(finiteNumber(source.maxModelConcurrency, 2)))) } : {}),
    ...(source.orchestrationBudgetUsd > 0 && Number.isFinite(source.orchestrationBudgetUsd) ? { orchestrationBudgetUsd: source.orchestrationBudgetUsd } : {}),
    completionSound: source.completionSound !== false,
    subagentModelId: typeof source.subagentModelId === 'string' ? source.subagentModelId.trim() : '',
    subagentReasoningEffort: typeof source.subagentReasoningEffort === 'string' ? source.subagentReasoningEffort.trim() : '' };
}
export function normalizeMcpServers(raw) { const source = Array.isArray(raw) ? raw : []; const seen = new Set(); return source.map((server) => { if (!server || typeof server !== 'object') return null; const name = String(server.name || '').trim(); const command = String(server.command || '').trim(); if (!name || !command || seen.has(name)) return null; seen.add(name); const args = Array.isArray(server.args) ? server.args.map((arg) => String(arg)).filter(Boolean) : []; const env = server.env && typeof server.env === 'object' ? Object.fromEntries(Object.entries(server.env).map(([key, value]) => [String(key).trim(), String(value)]).filter(([key]) => key)) : {}; return { name, command, args, env }; }).filter(Boolean); }
// 多模型条目：apiKey 允许掩码串（*** 开头，保存时服务端保留旧值）；缺 id 时补临时 id
export function normalizeModelList(raw) { const source = Array.isArray(raw) ? raw : []; return source.map((m, i) => { if (!m || typeof m !== 'object') return null; const model = String(m.model || '').trim(); if (!model) return null; const provider = m.provider === 'anthropic' ? 'anthropic' : 'openai'; const contextLength = Math.min(2000000, Math.max(1024, Math.round(finiteNumber(m.contextLength, DEFAULT_CONTEXT_LENGTH)))); const optNum = (v, min, max, round) => { if (v == null || v === '') return undefined; const n = Number(v); if (!Number.isFinite(n)) return undefined; const c = round ? Math.round(n) : n; return Math.min(max, Math.max(min, c)); }; const temperature = optNum(m.temperature, 0, 2, false); const maxTokens = optNum(m.maxTokens, 1, 200000, true); return { id: String(m.id || `m_${Date.now()}_${i}`), name: String(m.name || '').trim() || model, provider, baseUrl: String(m.baseUrl || '').trim(), model, apiKey: String(m.apiKey || ''), contextLength, temperature, maxTokens, enabled: m.enabled !== false, vision: m.vision !== false, reasoningLevels: normalizeReasoningLevels(m.reasoningLevels), hasKey: !!m.hasKey }; }).filter(Boolean); }
export function normalizeProviderList(raw) {
  return (Array.isArray(raw) ? raw : []).filter((p) => p && typeof p === 'object').map((p, i) => ({
    id: String(p.id || `provider_${i}`), name: String(p.name || '自定义供应商'),
    baseUrl: String(p.baseUrl || '').trim(), apiFormat: p.apiFormat === 'anthropic' ? 'anthropic' : 'openai',
    apiKey: String(p.apiKey || ''), enabled: p.enabled !== false,
    models: normalizeModelList(p.models).map(({ id, name, model, enabled, contextLength, vision, temperature, maxTokens, reasoningLevels }) =>
      ({ id, name, model, enabled, contextLength, vision, temperature, maxTokens, reasoningLevels })),
  }));
}
export function legacyModelProviders(models) {
  // Do not combine masked credentials: equal masks do not prove two keys are equal.
  return normalizeModelList(models).map((m) => ({
    id: `legacy_provider_${m.id}`, name: m.name || '已有供应商', baseUrl: m.baseUrl,
    apiFormat: m.provider, apiKey: m.apiKey, enabled: true, models: [m],
  }));
}
export function normalizeSettings(raw = {}) {
  const provider = raw.provider === 'anthropic' ? 'anthropic' : 'openai';
  const mcpConfig = raw.mcpConfig && typeof raw.mcpConfig === 'object' ? raw.mcpConfig : {};
  const models = normalizeModelList(raw.models);
  const providers = normalizeProviderList(Array.isArray(raw.providers) ? raw.providers : legacyModelProviders(models));
  const eligible = providers.filter((p) => p.enabled).flatMap((p) => p.models.filter((m) => m.enabled));
  const activeModelId = eligible.some((m) => m.id === raw.activeModelId) ? String(raw.activeModelId) : (eligible[0]?.id || '');
  return { provider, baseUrl: String(raw.baseUrl || ''), model: String(raw.model || ''), hasKey: Boolean(raw.hasKey), apiKey: '', models, providers, activeModelId,
    chineseSupport: raw.chineseSupport !== false, agentConfig: normalizeAgentConfig(raw.agentConfig), mcpServers: normalizeMcpServers(mcpConfig.servers) };
}
export function buildSettingsPatch(form, { clearApiKey = false, mcpServers = [], models, includeProviders = true } = {}) {
  const patch = { chineseSupport: Boolean(form.chineseSupport), agentConfig: normalizeAgentConfig(form.agentConfig), mcpConfig: { servers: normalizeMcpServers(mcpServers) } };
  if (Array.isArray(form.providers)) {
    if (includeProviders) {
      patch.providers = normalizeProviderList(form.providers);
      const available = patch.providers.filter((p) => p.enabled).flatMap((p) => p.models.filter((m) => m.enabled));
      patch.activeModelId = available.some((m) => m.id === form.activeModelId) ? form.activeModelId : (available[0]?.id || '');
    }
    return patch;
  }
  Object.assign(patch, { provider: form.provider === 'anthropic' ? 'anthropic' : 'openai', baseUrl: String(form.baseUrl || '').trim(), model: String(form.model || '').trim() });
  const apiKey = String(form.apiKey || '').trim();
  if (clearApiKey) patch.apiKey = '';
  else if (apiKey && !apiKey.startsWith('***')) patch.apiKey = apiKey;
  const list = normalizeModelList(models ?? form.models);
  if (list.length) { patch.models = list; patch.activeModelId = list.some((m) => m.id === form.activeModelId) ? form.activeModelId : list[0].id; }
  return patch;
}
export function parseArgsText(value) { return String(value || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean); }
export function parseEnvText(value) { return Object.fromEntries(String(value || '').split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#')).map((line) => { const index = line.indexOf('='); return index < 0 ? [line, ''] : [line.slice(0, index).trim(), line.slice(index + 1)]; }).filter(([key]) => key)); }
