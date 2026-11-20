import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AssistantMessageEventStream } from '@mariozechner/pi-ai';
import { createRetryingStream } from '../src/services/agent/requestRetry.js';

const model = { api: 'openai-completions', provider: 'openai', id: 'synthetic' };
const message = (content = [], stopReason = 'stop', errorMessage) => ({ role: 'assistant', content, stopReason, errorMessage, ...model });
function response(error, partial) {
  const stream = new AssistantMessageEventStream();
  if (partial) {
    stream.push({ type: 'start', partial });
    stream.push({ type: 'text_delta', delta: 'partial', contentIndex: 0, partial });
  }
  if (error) stream.push({ type: 'error', reason: 'error', error: message([], 'error', error) });
  else stream.push({ type: 'done', reason: 'stop', message: message([{ type: 'text', text: 'success' }]) });
  stream.end();
  return stream;
}

test('one API request can reconnect five times, with SDK retries disabled', async () => {
  let calls = 0;
  const retries = [];
  const stream = createRetryingStream({ stream: (_m, _c, options) => {
    assert.equal(options.maxRetries, 0);
    return response(++calls <= 5 ? 'HTTP 503 temporarily unavailable' : null);
  }, onRetry: (retry) => retries.push(retry.attempt), delay: async () => {} });
  const out = stream(model, { messages: [] });
  const events = [];
  for await (const event of out) events.push(event);
  assert.equal(calls, 6);
  assert.deepEqual(retries, [1, 2, 3, 4, 5]);
  assert.equal(events.filter((e) => e.type === 'error').length, 0);
  assert.equal((await out.result()).content[0].text, 'success');
});

test('exhausted retries emit exactly one terminal failure after six attempts', async () => {
  let calls = 0;
  const run = createRetryingStream({ stream: () => { calls++; return response('fetch failed'); }, delay: async () => {} });
  const out = run(model, { messages: [] });
  const events = [];
  for await (const event of out) events.push(event);
  assert.equal(calls, 6);
  assert.equal(events.filter((e) => e.type === 'error').length, 1);
  assert.equal((await out.result()).stopReason, 'error');
});

test('per-worker retry limits override the main-agent default without enabling SDK retries', async () => {
  for (const maxRetries of [0, 1]) {
    let calls = 0; const attempts = [], retries = [];
    const run = createRetryingStream({ maxRetries, stream: (_model, _context, options) => {
      assert.equal(options.maxRetries, 0); calls++; return response('503 gateway unavailable');
    }, delay: async () => {}, onAttempt: value => attempts.push(value), onRetry: value => retries.push(value) });
    const out = run(model, { messages: [] });
    for await (const _ of out) { /* drain */ }
    assert.equal(calls, maxRetries + 1); assert.equal(retries.length, maxRetries);
    assert.ok([...attempts, ...retries].every(item => item.maxRetries === maxRetries));
    assert.equal((await out.result()).stopReason, 'error');
  }
});

test('authentication and context errors do not waste reconnections', async () => {
  for (const error of ['401 invalid API key', '400 context length exceeded']) {
    let calls = 0;
    const run = createRetryingStream({ stream: () => { calls++; return response(error); }, delay: async () => {} });
    const out = run(model, { messages: [] });
    for await (const _ of out) { /* drain */ }
    assert.equal(calls, 1);
  }
});

test('cancellation during backoff prevents the next API call', async () => {
  const ac = new AbortController();
  let calls = 0;
  const run = createRetryingStream({ stream: () => { calls++; return response('502 gateway'); },
    onRetry: () => ac.abort(), baseDelayMs: 1000 });
  const out = run(model, { messages: [] }, { signal: ac.signal });
  for await (const _ of out) { /* drain */ }
  assert.equal(calls, 1);
  assert.equal((await out.result()).stopReason, 'aborted');
});

test('partial failed responses share one assistant slot and never publish stale tools as final', async () => {
  let calls = 0;
  const failed = message([{ type: 'toolCall', id: 'never-run', name: 'write_file', arguments: { path: 'x.tex', content: 'bad' } }]);
  const run = createRetryingStream({ stream: () => ++calls === 1 ? response('ECONNRESET', failed) : response(null), delay: async () => {} });
  const out = run(model, { messages: [] });
  const events = [];
  for await (const event of out) events.push(event);
  assert.equal(events.filter((e) => e.type === 'start').length, 1);
  assert.equal((await out.result()).content.some((p) => p.type === 'toolCall'), false);
});

test('real pi loop retries a fixed request snapshot without replaying completed or phantom tools', async () => {
  const { runAgentLoopContinue } = await import('@mariozechner/pi-agent-core');
  let calls = 0, executions = 0;
  const requests = [];
  const makeMessage = (content, stopReason = 'stop') => ({
    ...message(content, stopReason), usage: { input: 0, output: 0 }, timestamp: Date.now(),
  });
  const run = createRetryingStream({
    delay: async () => {},
    stream: (_model, context) => {
      requests.push(structuredClone(context.messages));
      const out = new AssistantMessageEventStream();
      calls++;
      if (calls <= 2) {
        const tool = { type: 'toolCall', id: calls === 1 ? 'real-call' : 'phantom-call', name: 'write_file', arguments: {} };
        const partial = makeMessage([tool], 'toolUse');
        out.push({ type: 'start', partial });
        out.push({ type: 'toolcall_end', contentIndex: 0, toolCall: tool, partial });
        if (calls === 1) out.push({ type: 'done', reason: 'toolUse', message: partial });
        else out.push({ type: 'error', reason: 'error', error: { ...makeMessage([], 'error'), errorMessage: 'ECONNRESET' } });
      } else out.push({ type: 'done', reason: 'stop', message: makeMessage([{ type: 'text', text: 'success' }]) });
      out.end();
      return out;
    },
  });
  const context = {
    systemPrompt: '',
    messages: [{ role: 'user', content: 'make one edit', timestamp: Date.now() }],
    tools: [{ name: 'write_file', label: 'write', description: 'fixture', parameters: { type: 'object', properties: {} },
      execute: async () => { executions++; return { content: [{ type: 'text', text: 'applied once' }], details: {} }; } }],
  };
  await runAgentLoopContinue(context, { model, convertToLlm: (items) => items }, () => {}, undefined, run);
  assert.equal(calls, 3);
  assert.equal(executions, 1);
  assert.deepEqual(requests[2], requests[1], 'API retry must not contain its own partial assistant/tool call');
  assert.ok(!JSON.stringify(requests[2]).includes('phantom-call'));
  assert.ok(requests[2].some((entry) => entry.role === 'toolResult' && entry.toolCallId === 'real-call'));
  assert.equal(context.messages.filter((entry) => entry.role === 'assistant').length, 2);
});


test('request ledger and one shared permit include transport retries without holding permits over backoff', async () => {
  const { createOrchestrationRuntime } = await import('../src/services/agent/orchestrationRuntime.js');
  const runtime = createOrchestrationRuntime({ maxConcurrency: 1 }); let calls = 0;
  const run = createRetryingStream({ requestRuntime: runtime, stream: () => response(++calls === 1 ? '503 gateway' : null),
    delay: async () => assert.equal(runtime.snapshot().modelPool.active, 0) });
  const out = run(model, { messages: [] }); for await (const _ of out) { /* drain */ }
  assert.equal(runtime.snapshot().requests.length, 2); assert.equal(runtime.snapshot().modelPool.active, 0);
  assert.equal(runtime.snapshot().requests[0].status, 'error'); assert.equal(runtime.snapshot().requests[1].status, 'stop');
});


test('permission revoked while waiting for a model permit prevents dispatch and does not create a phantom request', async () => {
  const { createOrchestrationRuntime } = await import('../src/services/agent/orchestrationRuntime.js');
  const runtime = createOrchestrationRuntime({ maxConcurrency: 1 });
  const release = await runtime.beginRequest({ model, context: { messages: [] }, options: {} });
  let allowed = true, calls = 0;
  const run = createRetryingStream({ requestRuntime: runtime, beforeDispatch: () => { if (!allowed) throw Error('403 access revoked'); },
    stream: () => { calls++; return response(null); } });
  const out = run(model, { messages: [] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(runtime.snapshot().modelPool.waiting, 1); allowed = false; release();
  for await (const _ of out) { /* drain */ }
  assert.equal(calls, 0); assert.equal((await out.result()).stopReason, 'error');
  assert.equal(runtime.snapshot().requests.length, 1); assert.equal(runtime.snapshot().modelPool.active, 0);
});

test('retry accounting retains usage observed before the stream broke and settles before delivery', async () => {
  const { createOrchestrationRuntime } = await import('../src/services/agent/orchestrationRuntime.js');
  const entries = [];
  const runtime = createOrchestrationRuntime({ onRequestSettled: ({ entry }) => entries.push(entry) });
  let calls = 0;
  const run = createRetryingStream({ requestRuntime: runtime, delay: async () => {},
    stream: () => ++calls > 1 ? response(null) : {
      async *[Symbol.asyncIterator]() {
        yield { type: 'start', partial: { usage: { input: 5, output: 2, cacheRead: 20, cacheWrite: 1 }, responseModel: 'upstream-synthetic' } };
        throw new Error('stream read failed');
      },
    },
  });
  const out = run(model, { messages: [] });
  for await (const event of out) if (event.type === 'done') assert.equal(entries.length, 2);
  assert.equal(entries[0].usageStatus, 'partial');
  assert.equal(entries[0].status, 'error');
  assert.equal(entries[0].responseModel, 'upstream-synthetic');
  assert.equal(entries[1].usageStatus, 'unknown');
  assert.notEqual(entries[0].requestKey, entries[1].requestKey);
  assert.deepEqual(runtime.snapshot().usage, { inputTokens: 26, outputTokens: 2, cacheRead: 20, cacheWrite: 1 });
});

test('a rejection in a local stream factory releases admission without a provider attempt', async () => {
  const { createOrchestrationRuntime } = await import('../src/services/agent/orchestrationRuntime.js');
  const entries = [];
  const runtime = createOrchestrationRuntime({ onRequestSettled: ({ entry }) => entries.push(entry) });
  const run = createRetryingStream({ requestRuntime: runtime,
    stream: () => { throw Error('400 invalid local model configuration'); },
  });
  const out = run(model, { messages: [] });
  assert.equal((await out.result()).stopReason, 'error');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].dispatched, false);
  assert.equal(runtime.snapshot().modelPool.active, 0);
});
