import { AssistantMessageEventStream, streamSimple } from '@mariozechner/pi-ai';
import { normalizeModelUsage } from './modelUsage.js';

export const MAX_API_RETRIES = 5;

export function isRetryableApiError(error) {
  if (error?.name === 'AbortError' || error?.stopReason === 'aborted') return false;
  const text = String(error?.errorMessage || error?.message || error || '');
  if (/context length|max length|prompt exceeds|too many tokens/i.test(text)) return false;
  if (/\b(?:400|401|403|404|405|413|422)\b|unauthori[sz]ed|forbidden|invalid.?api.?key|api key.*required|no api key|authentication|invalid.request|unsupported|model.*not found|content.filter/i.test(text)) return false;
  return true; // Transport, timeouts, rate limits, 5xx and unknown gateway failures.
}

export function abortableDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(new DOMException('Request cancelled', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}

function failureMessage(model, error, signal) {
  return {
    role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: signal?.aborted ? 'aborted' : 'error',
    errorMessage: error?.errorMessage || error?.message || String(error), timestamp: Date.now(),
  };
}

/** Retry one provider request, never the enclosing agent/tool loop.
 * Failed attempts never yield terminal events to pi, so no tool from a failed
 * attempt can run. Completed tools remain in context and are never replayed.
 */
export function createRetryingStream({
  stream = streamSimple,
  onRetry = () => {},
  onAttempt = () => {},
  delay = abortableDelay,
  baseDelayMs = 500,
  maxRetries = MAX_API_RETRIES,
  requestRuntime,
  owner = 'coordinator',
  getPhase = () => 'investigation',
  beforeDispatch,
} = {}) {
  const retryLimit = Number.isInteger(maxRetries) && maxRetries >= 0 ? maxRetries : MAX_API_RETRIES;
  return (model, context, options = {}) => {
    // pi appends a partial assistant to its live array after 'start'. A retry
    // must reuse the original request, never that incomplete assistant/tool call.
    const requestContext = { ...context, messages: structuredClone(context.messages) };
    const output = new AssistantMessageEventStream();
    void (async () => {
      let started = false;
      let lastError;
      for (let attempt = 0; attempt <= retryLimit; attempt++) {
        if (options.signal?.aborted) {
          const error = failureMessage(model, new DOMException('Request cancelled', 'AbortError'), options.signal);
          output.push({ type: 'error', reason: 'aborted', error });
          output.end();
          return;
        }
        let terminal, settle, partial;
        let dispatched = false;
        try {
          await onAttempt({ attempt, maxRetries: retryLimit });
          const dispatch = () => beforeDispatch?.({ context: requestContext });
          settle = await requestRuntime?.beginRequest({ model, context: requestContext, options, owner, phase: getPhase, beforeDispatch: dispatch });
          if (!requestRuntime) await dispatch();
          options.signal?.throwIfAborted();
          const upstream = stream(model, { ...requestContext, messages: structuredClone(requestContext.messages) }, {
            ...options, maxRetries: 0, timeoutMs: options.timeoutMs ?? 120_000,
          });
          dispatched = true;
          const response = await upstream;
          for await (const event of response) {
            if (event.type === 'error' || event.type === 'done') { terminal = event; break; }
            if (event.partial) partial = event.partial;
            // pi must retain just one assistant slot across attempts.
            if (event.type === 'start') {
              if (started) continue;
              started = true;
            }
            output.push(event);
          }
          if (!terminal) {
            const final = await response.result();
            terminal = final && !['error', 'aborted'].includes(final.stopReason)
              ? { type: 'done', reason: final.stopReason, message: final }
              : { type: 'error', reason: final?.stopReason || 'error',
                error: final || failureMessage(model, new Error('Model stream ended unexpectedly'), options.signal) };
          }
        } catch (error) {
          terminal = { type: 'error', reason: options.signal?.aborted ? 'aborted' : 'error',
            error: failureMessage(model, error, options.signal) };
        } finally {
          if (settle) {
            const result = terminal?.type === 'done' ? terminal.message : terminal?.error;
            const observedUsage = normalizeModelUsage(partial?.usage);
            // A broken stream can throw before the SDK emits its terminal
            // message. Retain the last observed counts on this attempt only.
            settle(!normalizeModelUsage(result?.usage) && observedUsage
              ? { ...result, usage: observedUsage, responseModel: result?.responseModel || partial?.responseModel }
              : result, { dispatched });
          }
        }
        if (terminal.type === 'done') {
          output.push(terminal);
          output.end();
          return;
        }
        lastError = terminal.error;
        if (options.signal?.aborted || attempt === retryLimit || !isRetryableApiError(lastError)) {
          output.push(terminal);
          output.end();
          return;
        }
        const waitMs = Math.min(baseDelayMs * 2 ** attempt, 8000);
        await onRetry({ attempt: attempt + 1, maxRetries: retryLimit, waitMs, error: lastError });
        try { await delay(waitMs, options.signal); }
        catch (error) {
          output.push({ type: 'error', reason: 'aborted', error: failureMessage(model, error, options.signal) });
          output.end();
          return;
        }
      }
      output.push({ type: 'error', reason: 'error', error: lastError });
      output.end();
    })().catch((error) => {
      output.push({ type: 'error', reason: options.signal?.aborted ? 'aborted' : 'error',
        error: failureMessage(model, error, options.signal) });
      output.end();
    });
    return output;
  };
}
