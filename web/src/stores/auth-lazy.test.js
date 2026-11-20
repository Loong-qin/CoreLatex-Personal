// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useAuthStore } from './auth.js';
import { api } from '../api.js';
vi.mock('../api.js', () => ({ api: { get: vi.fn() }, getToken: () => 'token-a', setToken: vi.fn() }));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
beforeEach(() => { vi.clearAllMocks(); setActivePinia(createPinia()); });

describe('lightweight identity and cancellable usage', () => {
  it('loads identity without forcing a project storage scan', async () => {
    api.get.mockResolvedValue({ user: { id: 1, username: 'A' }, usage: { storageUsed: null, storageQuota: 500 } });
    const store = useAuthStore(); await store.fetchMe();
    expect(api.get).toHaveBeenCalledWith('/api/auth/me?summary=1');
    expect(store.user.username).toBe('A'); expect(store.usage.storageUsed).toBeNull();
  });
  it('does not replace full usage with a late identity summary', async () => {
    const identity = deferred();
    api.get.mockImplementation(path => path.includes('/auth/me') ? identity.promise : Promise.resolve({ storageUsed: 44, storageQuota: 500 }));
    const store = useAuthStore(), first = store.fetchMe(); await store.refreshUsage();
    identity.resolve({ user: { id: 1 }, usage: { storageUsed: null, storageQuota: 500 } }); await first;
    expect(store.usage.storageUsed).toBe(44);
  });
  it('ignores usage after cancellation or logout', async () => {
    const one = deferred(), two = deferred(); api.get.mockReturnValueOnce(one.promise).mockReturnValueOnce(two.promise);
    const store = useAuthStore(), controller = new AbortController();
    const first = store.refreshUsage({ signal: controller.signal }); controller.abort();
    one.resolve({ storageUsed: 12 }); await first; expect(store.usage).toBeNull();
    const second = store.refreshUsage(); store.logout(); two.resolve({ storageUsed: 99 }); await second;
    expect(store.usage).toBeNull();
  });
});
