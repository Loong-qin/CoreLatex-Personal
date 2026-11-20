const quarterTokensFor = codePoint => codePoint <= 127 ? 1 : 6;

/** Approximate text tokens before a provider reports its actual count. */
export function estimateContextText(value) {
  let quarterTokens = 0;
  for (const char of String(value ?? '')) quarterTokens += quarterTokensFor(char.codePointAt(0));
  return Math.ceil(quarterTokens / 4);
}

/** Return a UTF-16 offset without splitting a Unicode code point. */
export function textEndWithinTokenBudget(text, start, tokenBudget) {
  let end = start, remaining = tokenBudget * 4;
  while (end < text.length) {
    const codePoint = text.codePointAt(end);
    remaining -= quarterTokensFor(codePoint);
    if (remaining < 0) break;
    end += codePoint > 0xffff ? 2 : 1;
  }
  return end;
}

function estimateContent(content) {
  if (typeof content === 'string') return estimateContextText(content);
  if (!Array.isArray(content)) return 0;
  return content.reduce((total, part) => {
    if (part?.type === 'image' || part?.type === 'image_url') return total + 1024;
    if (part?.type === 'toolCall') return total + 8 + estimateContextText(part.name) + estimateContextText(JSON.stringify(part.arguments || {}));
    return total + estimateContextText(part?.text ?? part?.thinking ?? '');
  }, 0);
}

export function estimateRequestContext(context = {}) {
  const fixedTokens = 8 + estimateContextText(context.systemPrompt)
    + (context.tools?.length ? estimateContextText(JSON.stringify(context.tools)) + context.tools.length * 8 : 0);
  const messageTokens = (context.messages || []).reduce((total, message) => total + 8 + estimateContent(message.content), 0);
  return { usedTokens: fixedTokens + messageTokens, fixedTokens };
}
