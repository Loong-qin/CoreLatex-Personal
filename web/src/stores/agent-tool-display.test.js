// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useAgentStore } from './agent.js';
import { buildTimeline } from '../lib/agentUtils.js';
vi.mock('../api.js', () => ({ api: { get: vi.fn(), post: vi.fn(), del: vi.fn() }, ssePost: vi.fn(), sseGet: vi.fn(), getToken: () => '', ApiError: Error }));
vi.mock('../lib/collabClient.js', () => ({ detachProjectCollab: vi.fn(), subscribeProjectPresence: () => () => {}, detachAllCollab: vi.fn(), setPresenceListener: vi.fn() }));
vi.mock('./ui.js', () => ({ useUiStore: () => ({ error: vi.fn(), toast: vi.fn() }) }));
beforeEach(() => { vi.clearAllMocks(); setActivePinia(createPinia()); });
describe('tool display lifecycle', () => {
  it('merges completion into its actual call and preserves identical display after finalization and history serialization', async () => {
    const store = useAgentStore(); store.setProject('p'); const stream = store._beginStream();
    store._onEvent({ type: 'run', runId: 'r', seq: 1, state: 'running' }, stream);
    for (const id of ['first', 'second']) store._onEvent({ type: 'tool', name: 'compile_and_preview', toolCallId: id, status: 'start', input: { pages: '15' } });
    const display = { version: 1, kind: 'compile', title: '编译与预览', summary: '已读取第 15 页', images: [{ id: 'snap', url: '/api/projects/p/agent/artifacts/snap', label: '第 15 页', page: 15 }] };
    store._onEvent({ type: 'tool', name: 'compile_and_preview', toolCallId: 'first', status: 'end', detail: 'compile succeeded', display, ms: 1500 });
    expect(store.liveSteps).toHaveLength(2); expect(store.liveSteps[0].display).toEqual(display); expect(store.liveSteps[1].display).toBeUndefined();
    const live = buildTimeline({ steps: store.liveSteps }).rows[0];
    await store._finishStream(null, { reload: false, stream });
    const history = buildTimeline({ steps: JSON.parse(JSON.stringify(store.messages.at(-1).steps)) }).rows[0];
    expect(history.display).toEqual(live.display); expect(history.ms).toBe(1500);
    store.clearLocal();
  });
});
