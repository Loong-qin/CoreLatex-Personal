import { registerApiProvider } from '@mariozechner/pi-ai';
import { streamOpenAICompletions } from '@mariozechner/pi-ai/openai-completions';
import { streamAnthropic } from '@mariozechner/pi-ai/anthropic';
import { resolveReasoningEffort } from './models.js';
import { HttpError } from '../../util.js';
import { kimiProfile } from './openaiCompatibility.js';

const API = { openai: 'corelatex-openai-reasoning', anthropic: 'corelatex-anthropic-reasoning' };
// Explicit old model IDs use budget-based thinking. Unknown configured gateways
// receive native adaptive effort and can reject unsupported values themselves.
const LEGACY_CLAUDE = /^claude-(?:3[.-]7-sonnet|(?:opus|sonnet)-4(?:[.-](?:0|1|5))?|haiku-4[.-]5)(?:-(?:\d{8}|latest))?$/i;
const BUDGETS = { minimal: 1024, low: 2048, medium: 8192, high: 16384, xhigh: 32768, max: 65536 };

export function modelReasoningOptions(config) {
  const reasoning = resolveReasoningEffort(config, config.reasoningEffort);
  return reasoning || kimiProfile(config)?.thinking ? { reasoning, temperature: undefined } : {};
}

export function reasoningModelFields(config) {
  const reasoningEffort = resolveReasoningEffort(config, config.reasoningEffort);
  const kimi = kimiProfile(config);
  return reasoningEffort || kimi?.thinking ? { api: API[config.provider === 'anthropic' ? 'anthropic' : 'openai'],
    reasoning: true, reasoningEffort } : { reasoning: false };
}

function payloadHook(options, update) {
  return async (payload, model) => {
    const changed = await options?.onPayload?.(payload, model);
    return update(changed ?? payload);
  };
}

function openai(model, context, options = {}) {
  const effort = options.reasoning ?? options.reasoningEffort ?? model.reasoningEffort;
  const kimi = kimiProfile(model);
  if (kimi?.generation === 'k3' && effort && !['low', 'high', 'max'].includes(effort))
    throw new HttpError(400, `Kimi K3 支持的思考强度为 low、high、max；请在模型设置中调整档位（当前：${effort}）`);
  if (kimi && kimi.generation !== 'k3' && effort &&
      !(kimi.switchable && ['enabled', 'disabled', 'off', 'none'].includes(effort)))
    throw new HttpError(400, '此 Kimi 型号不支持 reasoning_effort 强度档位；请删除强度档位以使用模型默认模式，可切换的 K2.5/K2.6 可配置 enabled、disabled。');
  return streamOpenAICompletions(model, context, { ...options, reasoningEffort: effort, temperature: undefined,
    onPayload: payloadHook(options, payload => {
      // Respect pi's OpenRouter wire format; preserve the exact configured value
      // instead of passing through its closed ThinkingLevel enum and clamp.
      if (kimi) {
        delete payload.reasoning;
        delete payload.thinking;
        if (kimi.generation === 'k3') {
          if (effort) payload.reasoning_effort = effort;
          else delete payload.reasoning_effort;
        } else {
          delete payload.reasoning_effort;
          if (kimi.switchable && effort) payload.thinking = { type: effort === 'enabled' ? 'enabled' : 'disabled' };
        }
      } else if (payload.reasoning) payload.reasoning = { ...payload.reasoning, effort };
      else payload.reasoning_effort = effort;
      delete payload.temperature;
      return payload;
    }),
  });
}

function anthropic(model, context, options = {}) {
  const effort = options.reasoning ?? options.reasoningEffort ?? model.reasoningEffort;
  const disabled = effort === 'none' || effort === 'off';
  const legacy = LEGACY_CLAUDE.test(model.id);
  const maxTokens = Math.floor(options.maxTokens ?? model.maxTokens ?? 8192);
  let budget;
  if (legacy && !disabled) {
    if (!Object.hasOwn(BUDGETS, effort)) throw new HttpError(400, `模型 ${model.id} 使用旧版思考预算，不支持自定义思考强度 ${effort}`);
    if (maxTokens <= 1024) throw new HttpError(400, `模型 ${model.id} 的 maxTokens 必须大于 1024 才能启用思考`);
    budget = Math.min(BUDGETS[effort], maxTokens - 1);
  }
  return streamAnthropic(model, context, { ...options, temperature: undefined, maxTokens,
    thinkingEnabled: !disabled, thinkingBudgetTokens: budget, effort: disabled ? undefined : effort,
    onPayload: payloadHook(options, payload => {
      delete payload.temperature;
      if (disabled) {
        payload.thinking = { type: 'disabled' };
        if (payload.output_config) delete payload.output_config.effort;
      } else if (legacy) {
        payload.thinking = { type: 'enabled', budget_tokens: budget };
        // Opus 4.5 additionally supports effort; other legacy models use budgets.
        if (/^claude-opus-4[.-]5(?:-|$)/i.test(model.id) && ['low', 'medium', 'high'].includes(effort))
          payload.output_config = { ...payload.output_config, effort };
        else if (payload.output_config) delete payload.output_config.effort;
      } else {
        payload.thinking = { type: 'adaptive' };
        payload.output_config = { ...payload.output_config, effort };
      }
      return payload;
    }),
  });
}

// Register separately, never replace pi's built-ins: unconfigured models retain
// their original behavior. generateSummary also dispatches through this registry.
registerApiProvider({ api: API.openai, stream: openai, streamSimple: openai }, 'corelatex-reasoning');
registerApiProvider({ api: API.anthropic, stream: anthropic, streamSimple: anthropic }, 'corelatex-reasoning');
