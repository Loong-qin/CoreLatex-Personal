import { shallowReactive } from 'vue';

const preferencesByApp = new WeakMap();

export function validAgentAccount(userId) {
  return Number.isSafeInteger(Number(userId)) && Number(userId) > 0;
}

export function agentProjectPreferenceKey(userId, projectId) {
  if (!validAgentAccount(userId) || !projectId) return '';
  return `corelatex.agentProjectPreferences.${Number(userId)}:${encodeURIComponent(projectId)}`;
}

function cacheFor(app) {
  if (!preferencesByApp.has(app)) preferencesByApp.set(app, shallowReactive(new Map()));
  return preferencesByApp.get(app);
}

export function readProjectPreferences(app, key) {
  const cached = cacheFor(app).get(key);
  if (cached) return cached;
  try {
    const value = JSON.parse(globalThis.localStorage.getItem(key) || 'null');
    if (!value || typeof value.modelId !== 'string') return null;
    const choices = value.reasoning;
    const reasoning = choices && typeof choices === 'object' && !Array.isArray(choices) ? choices : {};
    return { modelId: value.modelId, reasoning };
  } catch { return null; }
}

export function saveProjectPreferences(app, key, preferences) {
  cacheFor(app).set(key, preferences);
  // Store only the model ID and reasoning levels, with an in-memory fallback.
  try { globalThis.localStorage.setItem(key, JSON.stringify(preferences)); } catch {}
}
