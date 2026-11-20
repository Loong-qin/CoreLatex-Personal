// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { api } from './api.js';

afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

it('passes the caller abort signal to fetch and rejects when it aborts', async () => {
  const controller = new AbortController();
  const fetchMock = vi.fn((_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  }));
  vi.stubGlobal('fetch', fetchMock);
  const pending = api.post('/api/projects/a/compile', { engine: 'xelatex', persistSelection: false }, { signal: controller.signal });
  const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  expect(fetchMock).toHaveBeenCalledWith('/api/projects/a/compile', expect.objectContaining({ method: 'POST', signal: controller.signal }));
  controller.abort();
  await rejection;
});

it('preserves aborts while reading a PATCH response body', async () => {
  const controller = new AbortController();
  const fetchMock = vi.fn(async (_url, { signal }) => ({
    status: 200, ok: true,
    json: () => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }),
  }));
  vi.stubGlobal('fetch', fetchMock);
  const pending = api.patch('/api/projects/a/compile/settings', { texVersion: '2025' }, { signal: controller.signal });
  const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await Promise.resolve();
  expect(fetchMock).toHaveBeenCalledWith('/api/projects/a/compile/settings', expect.objectContaining({ method: 'PATCH', signal: controller.signal }));
  controller.abort();
  await rejection;
});
