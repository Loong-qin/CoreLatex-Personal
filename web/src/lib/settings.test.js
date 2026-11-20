import { describe, expect, it } from 'vitest';
import { buildSettingsPatch, normalizeAgentConfig, normalizeMcpServers, parseEnvText } from './settings.js';

describe('settings helpers', () => {
  it('normalizes agent bounds and defaults', () => {
    expect(normalizeAgentConfig({ temperature: 9, maxTokens: -4, allowRunScripts: false })).toEqual({
      temperature: 2, maxTokens: 1, allowRunScripts: false, allowWebAccess: true, confirmBeforeApply: false, graphOrchestration: false, completionSound: true, subagentModelId: '', subagentReasoningEffort: '',
    });
    expect(normalizeAgentConfig({})).toMatchObject({ temperature: 0.7, maxTokens: 128000, allowRunScripts: true, allowWebAccess: true });
    expect(normalizeAgentConfig({ confirmBeforeApply: true })).toMatchObject({ confirmBeforeApply: true });
  });

  it('deduplicates invalid MCP servers while preserving args and env', () => {
    expect(normalizeMcpServers([
      { name: 'fs', command: 'npx', args: ['-y'], env: { ROOT: '/tmp' } },
      { name: 'fs', command: 'other' },
      { name: '', command: 'ignored' },
    ])).toEqual([{ name: 'fs', command: 'npx', args: ['-y'], env: { ROOT: '/tmp' } }]);
  });

  it('keeps an existing API key when the key field is blank', () => {
    const patch = buildSettingsPatch({
      provider: 'openai', baseUrl: '', model: 'gpt-4o-mini', apiKey: '***1234',
      chineseSupport: true, agentConfig: {},
    });
    expect(patch).not.toHaveProperty('apiKey');
    expect(buildSettingsPatch({ ...patch, apiKey: '' }, { clearApiKey: true })).toHaveProperty('apiKey', '');
  });

  it('parses env values containing equals signs', () => {
    expect(parseEnvText('TOKEN=a=b\n# ignored\nEMPTY')).toEqual({ TOKEN: 'a=b', EMPTY: '' });
  });
});

import { DEFAULT_CONTEXT_LENGTH, normalizeModelList, normalizeSettings, reasoningLevelLabel } from './settings.js';

describe('normalizeModelList（多模型配置）', () => {
  it('规范化字段并补默认上下文长度', () => {
    const list = normalizeModelList([
      { id: 'm1', name: '主力', provider: 'openai', baseUrl: ' https://api.example.com/v1 ', model: 'gpt-x', apiKey: '***abcd' },
      { provider: 'anthropic', model: 'claude-y' },
    ]);
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ id: 'm1', provider: 'openai', baseUrl: 'https://api.example.com/v1', apiKey: '***abcd' });
    expect(list[0].contextLength).toBe(DEFAULT_CONTEXT_LENGTH);
    expect(list[1].id).toBeTruthy();
    expect(list[1].contextLength).toBe(DEFAULT_CONTEXT_LENGTH);
  });

  it('丢弃缺模型名的条目并钳制上下文长度', () => {
    const list = normalizeModelList([
      { id: 'a', model: '' },
      { id: 'b', model: 'm', contextLength: 1 },
      { id: 'c', model: 'm2', contextLength: 99999999 },
    ]);
    expect(list.map((m) => m.id)).toEqual(['b', 'c']);
    expect(list[0].contextLength).toBe(1024);
    expect(list[1].contextLength).toBe(2000000);
  });

  it('非数组输入返回空列表', () => {
    expect(normalizeModelList(null)).toEqual([]);
    expect(normalizeModelList('x')).toEqual([]);
  });
});

describe('normalizeSettings / buildSettingsPatch 多模型字段', () => {
  it('normalizeSettings 返回 models 与 activeModelId（非法 active 回落到第一个）', () => {
    const s = normalizeSettings({
      models: [{ id: 'a', model: 'm1' }, { id: 'b', model: 'm2' }],
      activeModelId: 'zzz',
    });
    expect(s.models.map((m) => m.id)).toEqual(['a', 'b']);
    expect(s.activeModelId).toBe('a');
  });

  it('buildSettingsPatch 携带 models 与 activeModelId', () => {
    const patch = buildSettingsPatch(
      { models: [{ id: 'a', model: 'm1' }], activeModelId: 'a', agentConfig: {} },
      {}
    );
    expect(patch.models).toHaveLength(1);
    expect(patch.activeModelId).toBe('a');
  });
});


describe('provider-owned models', () => {
  it('retains model IDs, vision and disabled state while keeping credentials at provider scope', () => {
    const settings = normalizeSettings({ providers: [{ id: 'p', name: 'Custom', apiFormat: 'anthropic', apiKey: '***abcd', enabled: true,
      models: [{ id: 'old-id', model: 'model-a', vision: false, enabled: false }, { id: 'second', model: 'model-b' }] }], activeModelId: 'old-id' });
    expect(settings.providers[0].models[0]).toMatchObject({ id: 'old-id', vision: false, enabled: false });
    expect(settings.activeModelId).toBe('second');
    const patch = buildSettingsPatch(settings);
    expect(patch.providers[0].apiKey).toBe('***abcd');
    expect(patch.providers[0].models[0]).not.toHaveProperty('apiKey');
    expect(patch.providers[0].models[0]).not.toHaveProperty('baseUrl');
    expect(patch).not.toHaveProperty('models');
  });
  it('does not merge legacy models merely because their masked keys match', () => {
    const settings = normalizeSettings({ models: [{ id: 'a', model: 'one', apiKey: '***1234' }, { id: 'b', model: 'two', apiKey: '***1234' }] });
    expect(settings.providers).toHaveLength(2);
    expect(settings.providers.flatMap((p) => p.models.map((m) => m.id))).toEqual(['a', 'b']);
  });
  it('global settings saves cannot overwrite provider configuration', () => {
    const settings = normalizeSettings({ providers: [] });
    const patch = buildSettingsPatch(settings, { includeProviders: false });
    expect(patch).not.toHaveProperty('providers'); expect(patch).not.toHaveProperty('models'); expect(patch).not.toHaveProperty('activeModelId');
  });
});


describe('workflow and completion preferences', () => {
  it('keeps graph opt-in, sound on by default, and preserves explicit off values on save', () => {
    expect(normalizeAgentConfig()).toMatchObject({ graphOrchestration: false, completionSound: true });
    const settings = normalizeSettings({ agentConfig: { graphOrchestration: true, completionSound: false, allowWebAccess: false } });
    expect(buildSettingsPatch(settings).agentConfig).toMatchObject({ graphOrchestration: true, completionSound: false, allowWebAccess: false });
    expect(normalizeAgentConfig({ graphOrchestration: 'true' }).graphOrchestration).toBe(false);
  });
});


describe('reasoning configuration round trips', () => {
  it('preserves trimmed ordered custom levels through provider load and save without changing model identity', () => {
    const source = { providers: [{ id: 'p', apiKey: '***same', models: [{ id: 'm', model: 'custom', reasoningLevels: [' xhigh ', 'max', 'medium', 'max', '', 'custom.deep:2'] }] }] };
    const normalized = normalizeSettings(source);
    const levels = ['xhigh', 'max', 'medium', 'custom.deep:2'];
    expect(normalized.providers[0].models[0]).toMatchObject({ id: 'm', reasoningLevels: levels });
    expect(buildSettingsPatch(normalized).providers[0].models[0]).toMatchObject({ id: 'm', reasoningLevels: levels });
  });
  it('does not enable a new API parameter for legacy or explicitly disabled models', () => {
    expect(normalizeModelList([{ model: 'legacy' }, { model: 'off', reasoningLevels: [] }]).map(m => m.reasoningLevels)).toEqual([[], []]);
  });
});


it('shows custom reasoning values verbatim even when they match Object prototype names', () => {
  expect(['max', 'constructor', 'toString'].map(reasoningLevelLabel)).toEqual(['最高', 'constructor', 'toString']);
});

describe('subagent configuration persistence', () => {
  it('round trips an independent model and custom reasoning level without modifying main-model settings', () => {
    const source = normalizeSettings({ models: [{ id: 'main', model: 'm' }, { id: 'worker', model: 'w' }], activeModelId: 'main',
      agentConfig: { subagentModelId: ' worker ', subagentReasoningEffort: ' custom.deep:2 ' } });
    const patch = buildSettingsPatch(source, { includeProviders: false });
    expect(patch.agentConfig).toMatchObject({ subagentModelId: 'worker', subagentReasoningEffort: 'custom.deep:2' });
    expect(patch).not.toHaveProperty('activeModelId');
    expect(source.activeModelId).toBe('main');
    expect(normalizeSettings({ ...source, agentConfig: patch.agentConfig }).agentConfig).toEqual(patch.agentConfig);
  });
  it('defaults missing and malformed choices to inheritance while preserving unavailable saved choices for recovery', () => {
    expect(normalizeAgentConfig({ subagentModelId: {}, subagentReasoningEffort: 5 })).toMatchObject({ subagentModelId: '', subagentReasoningEffort: '' });
    expect(normalizeSettings({ providers: [], agentConfig: { subagentModelId: 'deleted', subagentReasoningEffort: 'high' } }).agentConfig)
      .toMatchObject({ subagentModelId: 'deleted', subagentReasoningEffort: 'high' });
  });
});


describe('orchestration policy settings', () => {
  it('preserves legacy settings and canonicalizes explicit tiers and bounds', () => {
    expect(normalizeAgentConfig({ graphOrchestration: true })).not.toHaveProperty('collaborationTier');
    const legacy = normalizeAgentConfig({ collaborationTier: 'lite', maxModelConcurrency: 99, repairCycles: 0 });
    expect(legacy).toMatchObject({ graphOrchestration: true, collaborationTier: 'lite', maxModelConcurrency: 8 });
    expect(legacy).not.toHaveProperty('repairCycles');
    expect(normalizeAgentConfig({ graphOrchestration: true, collaborationTier: 'off' }).graphOrchestration).toBe(false);
    const patch = buildSettingsPatch({ agentConfig: { collaborationTier: 'deep', repairCycles: 2, maxModelConcurrency: 1 } }).agentConfig;
    expect(patch).toMatchObject({ collaborationTier: 'deep', maxModelConcurrency: 1 });
    expect(patch).not.toHaveProperty('repairCycles');
  });
});
