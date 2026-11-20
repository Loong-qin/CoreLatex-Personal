import { afterEach, describe, expect, it, vi } from 'vitest';
import { sseGet, ssePost } from './api.js';
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
function respond(chunks) {
  vi.stubGlobal('localStorage', { getItem: () => 'test-token' });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk)); controller.close(); } }), { status: 200 })));
}
describe('agent event stream transport', () => {
  it('decodes fragmented CRLF frames and final data without a trailing separator', async () => {
    respond(['id:1\r\ndata: {"type":"run",', '"seq":1}\r', '\n\r\ndata: {"type":"token","text":"字"}']);
    const events = []; await sseGet('/events?after=0', (e) => events.push(e));
    expect(events).toEqual([{ type: 'run', seq: 1 }, { type: 'token', text: '字' }]);
    expect(fetch.mock.calls[0][1]).not.toHaveProperty('method', 'POST');
    expect(fetch.mock.calls[0][1].cache).toBe('no-store');
  });
  it('sends one POST and does not hide handler failures as successful completion', async () => {
    respond(['data: {"type":"run"}\n\n']);
    await expect(ssePost('/chat', { message: 'hello' }, () => { throw new Error('handler failed'); })).rejects.toThrow('handler failed');
    expect(fetch).toHaveBeenCalledTimes(1); expect(fetch.mock.calls[0][1].method).toBe('POST');
  });
  it('preserves HTTP errors for nonretryable auth and missing-run responses', async () => {
    vi.stubGlobal('localStorage', { getItem: () => '' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Run missing' }), { status: 404 })));
    await expect(sseGet('/events', () => {})).rejects.toMatchObject({ status: 404, message: 'Run missing' });
  });
  it('keeps a heartbeat-only observer open and returns a silent connection to the retry path', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('localStorage', { getItem: () => 'test-token' });
    const cancel = vi.fn(), onEvent = vi.fn(), onActivity = vi.fn();
    let input;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ start(controller) { input = controller; }, cancel }))));
    const stopped = expect(sseGet('/events', onEvent, { onActivity })).rejects.toThrow('等待智能体事件超时');
    await vi.advanceTimersByTimeAsync(45_000);
    input.enqueue(new TextEncoder().encode(': heartbeat\n\n'));
    await vi.advanceTimersByTimeAsync(45_000);
    expect(onActivity).toHaveBeenCalledOnce();
    expect(onEvent).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(15_000);
    await stopped;
    expect(cancel).toHaveBeenCalledOnce();
  });
});
