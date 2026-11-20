// Run inputs belong to an existing assistant turn. Their display association
// comes from durable metadata, never from user-authored text prefixes.
export function isRunInput(message) {
  return message?.role === 'user' && !!message.runId && ['answer', 'steering'].includes(message.inputKind);
}

export function inputBelongsTo(message, assistant) {
  if (!isRunInput(message) || assistant?.role !== 'assistant') return false;
  if (message.parentMessageId != null && String(message.parentMessageId) === String(assistant.id)) return true;
  return !!assistant.runId && String(message.runId) === String(assistant.runId);
}

export function orderRunInputs(messages = []) {
  const rows = Array.isArray(messages) ? messages : [];
  const grouped = new Map();
  const linked = new Set();
  for (const assistant of rows) {
    if (assistant.role !== 'assistant') continue;
    const inputs = rows.filter(message => !linked.has(message) && inputBelongsTo(message, assistant));
    if (!inputs.length) continue;
    inputs.sort((a, b) => Number.isSafeInteger(a.id) && Number.isSafeInteger(b.id) ? a.id - b.id : 0);
    grouped.set(assistant, inputs);
    for (const input of inputs) linked.add(input);
  }
  const result = [];
  for (const message of rows) {
    if (linked.has(message)) continue;
    const inputs = grouped.get(message) || [];
    result.push(...inputs.filter(input => input.consumed === true), message, ...inputs.filter(input => input.consumed !== true));
  }
  return result;
}

export function unansweredMessage(messages) {
  const last = orderRunInputs(messages).at(-1);
  return last?.role === 'user' ? last : null;
}
