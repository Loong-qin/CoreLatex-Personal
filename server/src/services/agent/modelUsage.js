function tokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

// pi-ai separates uncached input from cache reads and writes. Its initial
// all-zero usage object can also mean that no usage was received.
export function normalizeModelUsage(usage) {
  const input = tokenCount(usage?.input) ?? 0;
  const output = tokenCount(usage?.output) ?? 0;
  const cacheRead = tokenCount(usage?.cacheRead) ?? 0;
  const cacheWrite = tokenCount(usage?.cacheWrite) ?? 0;
  if (input + output + cacheRead + cacheWrite === 0) return null;
  return { input, output, cacheRead, cacheWrite };
}

export function inputTokensForUsage(usage) {
  const normalized = normalizeModelUsage(usage);
  const total = normalized && normalized.input + normalized.cacheRead + normalized.cacheWrite;
  return total || null;
}

// Direct HTTP requests, such as the connection test, do not pass through pi-ai.
export function normalizeProviderUsage(provider, usage) {
  if (!usage || typeof usage !== 'object') return null;
  if (provider === 'anthropic') {
    const input = tokenCount(usage.input_tokens);
    const output = tokenCount(usage.output_tokens);
    if (input === undefined || output === undefined) return null;
    return { input, output, cacheRead: tokenCount(usage.cache_read_input_tokens) ?? 0,
      cacheWrite: tokenCount(usage.cache_creation_input_tokens) ?? 0 };
  }

  const responses = provider === 'openai-responses';
  const input = tokenCount(responses ? usage.input_tokens : usage.prompt_tokens);
  const output = tokenCount(responses ? usage.output_tokens : usage.completion_tokens);
  if (input === undefined || output === undefined) return null;
  const details = responses ? usage.input_tokens_details : usage.prompt_tokens_details;
  const hit = tokenCount(details?.cached_tokens) ?? tokenCount(usage.prompt_cache_hit_tokens) ?? 0;
  const cacheWrite = Math.min(input, tokenCount(details?.cache_write_tokens) ?? 0);
  // Chat-compatible gateways that report cache writes include them in cached_tokens.
  const cacheRead = Math.min(input - cacheWrite, Math.max(0, hit - cacheWrite));
  return { input: input - cacheRead - cacheWrite, output, cacheRead, cacheWrite };
}
