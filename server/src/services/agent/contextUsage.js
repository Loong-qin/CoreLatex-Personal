import { contextModelKey } from './context.js';
import { replayedMessageContent, ROUND_NOTE } from './chatRunHistory.js';
import { inputTokensForUsage } from './modelUsage.js';
import { estimateContextText, estimateRequestContext } from './tokenEstimation.js';
export { estimateContextText, estimateRequestContext } from './tokenEstimation.js';

function parseSnapshot(chat) {
  try {
    const value = JSON.parse(chat?.context_usage || 'null');
    if (!value || !Number.isFinite(value.usedTokens) || value.usedTokens < 0
      || !Number.isFinite(value.maxTokens) || value.maxTokens <= 0
      || !Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0) return null;
    return value;
  } catch { return null; }
}

function publicSnapshot(value) {
  if (!value) return null;
  const { usedTokens, maxTokens, estimated, modelId, modelKey, updatedAt, basis } = value;
  return { usedTokens, maxTokens, estimated, modelId, modelKey, updatedAt, basis };
}

export function readContextUsage(chat, modelConfig) {
  const value = parseSnapshot(chat);
  if (!value || !modelConfig || value.modelKey !== contextModelKey(modelConfig)
    || value.maxTokens !== modelConfig.contextLength) return null;
  return publicSnapshot(value);
}

function storeSnapshot(db, chatId, snapshot, emit) {
  const saved = db.transaction(() => {
    const chat = db.prepare('SELECT context_usage FROM chats WHERE id=?').get(chatId);
    if (!chat) return null;
    const previous = parseSnapshot(chat);
    const updatedAt = Math.max(snapshot.updatedAt, (previous?.updatedAt ?? -1) + 1);
    const value = { ...snapshot, updatedAt };
    db.prepare('UPDATE chats SET context_usage=? WHERE id=?').run(JSON.stringify(value), chatId);
    return publicSnapshot(value);
  }).immediate();
  if (saved) emit?.({ type: 'context_usage', chatId, contextUsage: saved });
  return saved;
}

export function createContextUsageTracker({ db, chatId, modelConfig, emit, now = Date.now }) {
  let latestRequest = null, latestSnapshot = null, normalFixedTokens = null;
  const matches = ({ owner, phase }) => owner === 'coordinator' && phase !== 'history_compaction';
  return {
    onRequestStart(request) {
      if (!matches(request)) return;
      const chat = db.prepare('SELECT summary FROM chats WHERE id=?').get(chatId);
      if (!chat) return;
      const estimate = estimateRequestContext(request.context);
      const fixedTokens = Math.max(0, estimate.fixedTokens - estimateContextText(chat.summary));
      if (request.context.tools?.length) normalFixedTokens = fixedTokens;
      latestRequest = request.requestId;
      latestSnapshot = {
        ...estimate, fixedTokens: normalFixedTokens ?? fixedTokens,
        modelId: modelConfig.id || '', modelKey: contextModelKey(modelConfig),
        maxTokens: modelConfig.contextLength, estimated: true, basis: 'request', updatedAt: now(),
      };
      storeSnapshot(db, chatId, latestSnapshot, emit);
    },
    onRequestSettled({ entry, result }) {
      if (!matches(entry) || entry.requestId !== latestRequest || !latestSnapshot) return;
      if (!result || ['error', 'aborted'].includes(result.stopReason)) return;
      const inputTokens = inputTokensForUsage(result.usage);
      if (inputTokens == null) return;
      // The provider's input includes cached prefixes, tools and system text.
      // Output/reasoning is billable but is not this request's input context.
      latestSnapshot = { ...latestSnapshot, usedTokens: inputTokens, estimated: false, updatedAt: now() };
      storeSnapshot(db, chatId, latestSnapshot, emit);
    },
  };
}

// Estimate the saved replay before the next user message or an automatic compaction.
function savedContextSnapshot({ chat, modelConfig, messages, estimateFixedTokens, now = Date.now }) {
  if (!chat || !modelConfig || (!chat.summary && !messages.length)) return null;
  const previous = parseSnapshot(chat);
  // The account/project system prompt and tool definitions are shared by coordinator models.
  const fixedTokens = Number.isFinite(previous?.fixedTokens) && previous.fixedTokens >= 0
    ? previous.fixedTokens : estimateFixedTokens?.();
  if (!Number.isFinite(fixedTokens)) return null;
  const replay = messages.map(message => ({ content: replayedMessageContent(message) }));
  replay.push({ content: ROUND_NOTE });
  const history = estimateRequestContext({ messages: replay });
  const usedTokens = fixedTokens + estimateContextText(chat.summary) + history.usedTokens - history.fixedTokens;
  return { usedTokens, fixedTokens, maxTokens: modelConfig.contextLength,
    modelId: modelConfig.id || '', modelKey: contextModelKey(modelConfig),
    estimated: true, basis: 'history', updatedAt: Math.max(now(), previous?.updatedAt ?? 0) };
}

export function estimateSavedContextUsage(options) {
  return publicSnapshot(savedContextSnapshot(options));
}

// Tool results and hidden reasoning from a finished run are not replayed on the next user turn.
export function refreshSavedContextUsage({ db, chatId, emit, ...options }) {
  const chat = db.prepare('SELECT * FROM chats WHERE id=?').get(chatId);
  const snapshot = savedContextSnapshot({ chat, ...options });
  return snapshot ? storeSnapshot(db, chatId, snapshot, emit) : null;
}
