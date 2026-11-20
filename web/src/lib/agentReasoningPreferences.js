// Seed a project's first choice from the account's previous reasoning preferences.
export function legacyReasoningPreferences(userId) {
  try {
    const value = JSON.parse(globalThis.localStorage.getItem(`corelatex.agentReasoning.${userId}`) || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}
