// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useAgentStore } from './agent.js';
import { buildTimeline } from '../lib/agentUtils.js';
vi.mock('../api.js', () => ({ api: { get: vi.fn(), post: vi.fn(), del: vi.fn() }, ssePost: vi.fn(), sseGet: vi.fn(), getToken: () => '', ApiError: Error }));
vi.mock('../lib/collabClient.js', () => ({ detachProjectCollab: vi.fn(), subscribeProjectPresence: () => () => {}, detachAllCollab: vi.fn(), setPresenceListener: vi.fn() }));
vi.mock('./ui.js', () => ({ useUiStore: () => ({ error: vi.fn(), toast: vi.fn() }) }));
beforeEach(() => { vi.clearAllMocks(); setActivePinia(createPinia()); });
function running() {
  const store = useAgentStore(); store.setProject('p'); const stream = store._beginStream();
  store._onEvent({ type: 'run', runId: 'r', seq: 1, state: 'running' }, stream);
  return { store, stream };
}
describe('provider-returned thinking text', () => {
  it('keeps the same message key when the live round becomes saved history', async () => {
    const { store, stream } = running();
    store._onEvent({ type: 'run', state: 'running', messageId: 42 });
    store._onEvent({ type: 'response_start' });
    store._onEvent({ type: 'model_thinking', text: 'Returned by selected provider' });
    expect(store.activeMessageId).toBe(42);
    await store._finishStream(null, { reload: false, stream });
    expect(store.messages.at(-1).id).toBe(42);
    expect(buildTimeline({ steps: store.messages.at(-1).steps }).rows[0].text).toBe('Returned by selected provider');
    store.clearLocal();
    expect(store.activeMessageId).toBeNull();
  });
  it('streams exact text separately from the answer and ignores non-display fields', () => {
    const { store } = running();
    store._onEvent({ type: 'response_start', seq: 2 });
    store._onEvent({ type: 'model_thinking', seq: 3, text: '检查 main.tex 的引用。\n', source: 'provider', thinkingSignature: 'DO_NOT_RENDER' });
    store._onEvent({ type: 'model_thinking', seq: 4, text: '保留人工标签。' });
    store._onEvent({ type: 'token', seq: 5, text: '已完成核对。' });
    store._onEvent({ type: 'thinking', seq: 6, text: 'UNEXPOSED_INTERNAL' });
    expect(store.streamText).toBe('已完成核对。');
    const tl = buildTimeline({ steps: store.liveSteps });
    expect(tl.answer).toBe('已完成核对。');
    expect(tl.rows).toEqual([{ kind: 'thinking', source: 'provider', text: '检查 main.tex 的引用。\n保留人工标签。' }]);
    expect(JSON.stringify(store.liveSteps)).not.toContain('DO_NOT_RENDER');
    expect(JSON.stringify(store.liveSteps)).not.toContain('UNEXPOSED_INTERNAL');
  });
  it('deduplicates replay, accepts a final replacement and restores thinking from saved steps', () => {
    const { store } = running();
    store._onEvent({ type: 'response_start', seq: 2 });
    store._onEvent({ type: 'model_thinking', seq: 3, text: 'partial' });
    store._onEvent({ type: 'model_thinking', seq: 3, text: 'DUPLICATE' });
    store._onEvent({ type: 'model_thinking', seq: 4, text: 'provider final text', replace: true });
    store._onEvent({ type: 'token', seq: 5, text: 'Answer' });
    const saved = JSON.parse(JSON.stringify(store.liveSteps));
    expect(buildTimeline({ steps: saved, content: 'Answer' })).toEqual({ rows: [{ kind: 'thinking', source: 'provider', text: 'provider final text' }], answer: 'Answer' });
  });
  it('drops only the failed response thinking while preserving previous calls and system retry status', () => {
    const { store } = running();
    store._onEvent({ type: 'response_start' });
    store._onEvent({ type: 'model_thinking', text: 'Earlier completed call' });
    store._onEvent({ type: 'token', text: 'Earlier answer' });
    store._onEvent({ type: 'response_start' });
    store._onEvent({ type: 'model_thinking', text: 'Failed fragment' });
    store._onEvent({ type: 'token', text: 'Failed answer' });
    store._onEvent({ type: 'activity', text: 'Retry 1/5', phase: 'retry', source: 'system' });
    store._onEvent({ type: 'response_reset' });
    store._onEvent({ type: 'model_thinking', text: 'New provider output' });
    store._onEvent({ type: 'token', text: 'Retried answer' });
    expect(store.liveSteps.filter(s => s.type === 'model_thinking').map(s => s.text)).toEqual(['Earlier completed call', 'New provider output']);
    expect(store.liveSteps.find(s => s.type === 'activity').source).toBe('system');
    expect(store.streamText).toBe('Earlier answerRetried answer');
    expect(JSON.stringify(store.liveSteps)).not.toContain('Failed');
  });
  it('never mixes execution summaries into provider thinking history', () => {
    const tl = buildTimeline({ steps: [
      { type: 'activity', phase: 'planning', source: 'model', text: 'Public execution update' },
      { type: 'model_thinking', source: 'provider', text: 'API returned text' },
      { type: 'activity', phase: 'waiting', source: 'system', text: 'Waiting for answer' },
      { type: 'text', text: 'Final answer' },
    ] });
    expect(tl.rows.filter(r => r.kind === 'thinking').map(r => r.text)).toEqual(['API returned text']);
    expect(tl.rows.filter(r => r.kind === 'activity').map(r => r.source)).toEqual(['model', 'system']);
    expect(tl.answer).toBe('Final answer');
  });
  it('preserves indexed text and thinking blocks with metadata-only duration updates', () => {
    const { store } = running();
    store._onEvent({ type: 'response_start' });
    store._onEvent({ type: 'token', blockIndex: 0, text: 'A' });
    store._onEvent({ type: 'model_thinking', blockIndex: 1, text: 'X', startedAt: 1000 });
    store._onEvent({ type: 'token', blockIndex: 2, text: 'B' });
    store._onEvent({ type: 'model_thinking', blockIndex: 3, text: 'Y', startedAt: 3000 });
    store._onEvent({ type: 'model_thinking', blockIndex: 1, text: '', startedAt: 1000, durationMs: 1200 });
    store._onEvent({ type: 'token', blockIndex: 4, text: 'C' });
    expect(store.liveSteps.map(s => s.text)).toEqual(['A', 'X', 'B', 'Y', 'C']);
    expect(store.streamText).toBe('ABC');
    const tl = buildTimeline({ steps: store.liveSteps, content: 'ABC' });
    expect(tl.rows.map(r => r.kind)).toEqual(['text', 'thinking', 'text', 'thinking']);
    expect(tl.rows[1]).toMatchObject({text:'X',startedAt:1000,durationMs:1200});
    expect(tl.answer).toBe('C');
  });
  it('inserts late blocks in source order and replaces text without duplicating the answer', () => {
    const { store } = running();
    store._onEvent({ type: 'response_start' });
    store._onEvent({ type: 'token', blockIndex: 2, text: 'tail' });
    store._onEvent({ type: 'model_thinking', blockIndex: 1, text: 'middle' });
    store._onEvent({ type: 'token', blockIndex: 0, text: 'prefix' });
    store._onEvent({ type: 'token', blockIndex: 2, text: 'end', replace: true });
    expect(store.liveSteps.map(s => s.text)).toEqual(['prefix', 'middle', 'end']);
    expect(store.streamText).toBe('prefixend');
    store._onEvent({ type: 'token', blockIndex: 0, text: '', replace: true });
    expect(store.streamText).toBe('end');
    expect(buildTimeline({steps:store.liveSteps}).rows.map(r=>r.text)).toEqual(['middle']);
  });
  it('scopes block indices to each response and discards failed timing metadata', () => {
    const { store } = running();
    store._onEvent({ type: 'response_start' });
    store._onEvent({ type: 'model_thinking', blockIndex: 0, text: 'previous', startedAt: 1000, durationMs: 500 });
    store._onEvent({ type: 'token', blockIndex: 1, text: 'old answer' });
    store._onEvent({ type: 'response_start' });
    store._onEvent({ type: 'model_thinking', blockIndex: 0, text: 'failed', startedAt: 2000 });
    store._onEvent({ type: 'response_reset' });
    store._onEvent({ type: 'model_thinking', blockIndex: 0, text: '', durationMs: 500 });
    expect(store.liveSteps.map(s=>s.text)).toEqual(['previous','old answer']);
    store._onEvent({ type: 'model_thinking', blockIndex: 0, text: 'retry', startedAt: 3000 });
    store._onEvent({ type: 'token', blockIndex: 1, text: 'new answer' });
    expect(store.liveSteps.map(s=>s.text)).toEqual(['previous','old answer','retry','new answer']);
    expect(store.streamText).toBe('old answernew answer');
  });

});
