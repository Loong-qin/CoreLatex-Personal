// Protocol capabilities are independent of the user's chosen reasoning effort.
// OpenAI-compatible endpoints do not necessarily accept OpenAI's developer role.
export function kimiProfile(config) {
  const provider = config.provider || 'openai';
  if (provider === 'anthropic') return null;
  let host = '';
  try { host = new URL(config.baseUrl || '').hostname.toLowerCase(); } catch { /* validated by settings */ }
  // OpenRouter owns its wire protocol even when routing to a Kimi model.
  if (host === 'openrouter.ai' || host.endsWith('.openrouter.ai')) return null;
  const name = String(config.model || config.id || '').toLowerCase().split('/').at(-1);
  const knownHost = ['api.kimi.com', 'api.kimi.ai', 'api.moonshot.ai', 'api.moonshot.cn'].includes(host);
  const k3 = /^(?:kimi-)?k3(?:[.-]|$)/.test(name);
  const kimi = knownHost || k3 || /^(?:kimi-|moonshot-)/.test(name);
  if (!kimi) return null;
  const k2 = /^(?:kimi-)?k2(?:[.-]|$)/.test(name);
  const thinking = k3 || (k2 && (/k2\.[567]/.test(name) || name.includes('thinking')));
  return { generation: k3 ? 'k3' : k2 ? 'k2' : 'legacy', thinking,
    switchable: /k2\.[56](?:-|$)/.test(name) };
}

export function openAICompatibility(config) {
  if (config.provider === 'anthropic') return undefined;
  let host = '';
  try { host = new URL(config.baseUrl || 'https://api.openai.com/v1').hostname.toLowerCase(); } catch { /* validated elsewhere */ }
  const kimi = kimiProfile(config);
  const compat = host === 'api.openai.com' && !kimi ? {} : { supportsDeveloperRole: false };
  if (kimi) Object.assign(compat, { supportsDeveloperRole: false, supportsStore: false,
    supportsStrictMode: false, requiresReasoningContentOnAssistantMessages: true,
    maxTokensField: kimi.generation === 'k3' ? 'max_completion_tokens' : 'max_tokens',
    supportsReasoningEffort: kimi.generation === 'k3' });
  return compat;
}
