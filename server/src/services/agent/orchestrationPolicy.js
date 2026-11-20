export const COLLABORATION_TIERS = ['off', 'lite', 'full', 'deep'];

export function collaborationPolicy(config = {}) {
  const tier = config.collaborationTier ?? (config.graphOrchestration === true ? 'full' : 'off');
  if (!COLLABORATION_TIERS.includes(tier)) throw new Error('collaborationTier 需为 off、lite、full 或 deep');
  for (const [key, min, max] of [['maxModelConcurrency', 1, 8]]) {
    if (config[key] !== undefined && (!Number.isInteger(config[key]) || config[key] < min || config[key] > max))
      throw new Error(`${key} 需为 ${min}–${max} 的整数`);
  }
  if (config.orchestrationBudgetUsd != null && (!Number.isFinite(config.orchestrationBudgetUsd) || config.orchestrationBudgetUsd <= 0))
    throw new Error('orchestrationBudgetUsd 需为正数或 null');
  return Object.freeze({ tier, enabled: tier !== 'off', analysis: ['full', 'deep'].includes(tier),
    parallelEdits: tier === 'deep' || config.collaborationTier === undefined && config.graphOrchestration === true,
    maxConcurrency: config.maxModelConcurrency ?? 2,
    budgetUsd: config.orchestrationBudgetUsd ?? null, legacy: config.collaborationTier === undefined });
}
