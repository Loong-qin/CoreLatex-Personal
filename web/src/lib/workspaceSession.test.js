import { afterEach, describe, expect, it, vi } from 'vitest';
import { readWorkspaceSession, saveWorkspaceSession, clearWorkspaceSession } from './workspaceSession.js';

const key = (userId) => `corelatex.workspaces.${encodeURIComponent(userId)}`;
function createStorage() {
  const entries = new Map();
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, String(value)),
    removeItem: (key) => entries.delete(key),
    entries,
  };
}
const empty = { projects: [], activeProjectId: null };
const sample = { projects: [{ publicId: 'A', name: 'Project A' }, { publicId: 'B', name: 'Project B' }], activeProjectId: 'B' };
afterEach(() => vi.unstubAllGlobals());

describe('workspace session persistence', () => {
  it('restores ordered open projects and active selection after a reload', () => {
    const storage = createStorage();
    saveWorkspaceSession(1, sample, storage);
    expect(readWorkspaceSession(1, storage)).toEqual(sample);
    expect(JSON.parse(storage.getItem(key('1'))).version).toBe(1);
    expect(readWorkspaceSession(1, storage)).not.toBe(readWorkspaceSession(1, storage));
  });

  it('isolates accounts and encodes the entire account id in its key', () => {
    const storage = createStorage();
    saveWorkspaceSession('user/a?b', sample, storage);
    saveWorkspaceSession('user', { projects: [{ publicId: 'C', name: '' }], activeProjectId: 'C' }, storage);
    expect(storage.entries.has('corelatex.workspaces.user%2Fa%3Fb')).toBe(true);
    expect(readWorkspaceSession('user/a?b', storage)).toEqual(sample);
    clearWorkspaceSession('user/a?b', storage);
    expect(readWorkspaceSession('user/a?b', storage)).toEqual(empty);
    expect(readWorkspaceSession('user', storage).activeProjectId).toBe('C');
  });

  it('uses tab sessionStorage by default and cannot expose another tab session', () => {
    const tabA = createStorage(), tabB = createStorage();
    vi.stubGlobal('sessionStorage', tabA);
    saveWorkspaceSession('1', sample);
    expect(readWorkspaceSession('1')).toEqual(sample);
    vi.stubGlobal('sessionStorage', tabB);
    expect(readWorkspaceSession('1')).toEqual(empty);
    saveWorkspaceSession('1', { projects: [], activeProjectId: null });
    expect(readWorkspaceSession('1', tabA)).toEqual(sample);
    clearWorkspaceSession('1');
    expect(tabB.entries.size).toBe(0);
  });

  it('persists closing projects and a completely closed list without resurrecting them', () => {
    const storage = createStorage();
    saveWorkspaceSession(1, sample, storage);
    const closedA = { projects: [{ publicId: 'B', name: 'Project B' }], activeProjectId: 'B' };
    saveWorkspaceSession(1, closedA, storage);
    expect(readWorkspaceSession(1, storage)).toEqual(closedA);
    saveWorkspaceSession(1, { projects: [], activeProjectId: 'B' }, storage);
    expect(readWorkspaceSession(1, storage)).toEqual(empty);
  });

  it('stores lightweight project and notification metadata without agent content', () => {
    const storage = createStorage();
    saveWorkspaceSession(1, {
      ...sample, token: 'SECRET_TOKEN', chat: ['PRIVATE_CHAT'], taskSnapshot: 'PRIVATE_TASK',
      projects: [{ ...sample.projects[0], apiKey: 'SECRET_KEY', messages: ['PRIVATE_MESSAGE'] }],
    }, storage);
    expect(JSON.parse(storage.getItem(key('1')))).toEqual({
      version: 1, projects: [sample.projects[0]], activeProjectId: null,
    });
    expect(storage.getItem(key('1'))).not.toMatch(/SECRET|PRIVATE/);
  });

  it('restores unread markers and validates pending run ids for the same account', () => {
    const storage = createStorage();
    saveWorkspaceSession('user', { ...sample, projects: [
      { ...sample.projects[0], unreadCompletion: true, trackedRunId: 'run-a' },
      { ...sample.projects[1], unreadCompletion: 'true', trackedRunId: '../bad' },
    ] }, storage);
    expect(readWorkspaceSession('user', storage).projects).toEqual([
      { ...sample.projects[0], unreadCompletion: true, trackedRunId: 'run-a' },
      sample.projects[1],
    ]);
    expect(readWorkspaceSession('other-user', storage)).toEqual(empty);
  });

  it('deduplicates project ids in their original order and caps the list at 100', () => {
    const storage = createStorage();
    const projects = [{ publicId: 'A', name: 'first' }, { publicId: 'A', name: 'duplicate' },
      ...Array.from({ length: 110 }, (_, i) => ({ publicId: `project-${i}`, name: `Project ${i}` }))];
    saveWorkspaceSession(1, { projects, activeProjectId: 'project-109' }, storage);
    const restored = readWorkspaceSession(1, storage);
    expect(restored.projects).toHaveLength(100);
    expect(restored.projects[0]).toEqual({ publicId: 'A', name: 'first' });
    expect(restored.projects[99].publicId).toBe('project-98');
    expect(restored.activeProjectId).toBeNull();
  });

  it('accepts UUIDs and short ids while rejecting unsafe, empty or oversized ids', () => {
    const storage = createStorage();
    const uuid = 'c4d0041f-d8ca-465b-9e62-852f523fdc60';
    const valid = ['A', 'B', uuid, 'x'.repeat(256)];
    const invalid = ['', ' ', ' A', 'A ', 'x'.repeat(257), '/a', 'a/b', 'a\\b', 'a?b', 'a#b',
      'a' + String.fromCharCode(0), 'a' + String.fromCharCode(31), 'a' + String.fromCharCode(127), 'a' + String.fromCharCode(133), 3, {}, null];
    saveWorkspaceSession(1, { projects: [...invalid, ...valid].map((publicId) => ({ publicId, name: 'x' })), activeProjectId: uuid }, storage);
    expect(readWorkspaceSession(1, storage).projects.map((p) => p.publicId)).toEqual(valid);
    expect(readWorkspaceSession(1, storage).activeProjectId).toBe(uuid);
  });

  it('bounds names and drops wrong types without coercing untrusted data', () => {
    const storage = createStorage();
    saveWorkspaceSession(1, { projects: [null, 'A', [], { publicId: 'A', name: 'n'.repeat(250) },
      { publicId: 'B', name: { toString: () => 'unsafe' } }], activeProjectId: 'missing' }, storage);
    expect(readWorkspaceSession(1, storage)).toEqual({
      projects: [{ publicId: 'A', name: 'n'.repeat(200) }, { publicId: 'B', name: '' }], activeProjectId: null,
    });
  });

  it('normalizes malformed stored projects and does not trust an active id outside the list', () => {
    const storage = createStorage();
    storage.setItem(key('1'), JSON.stringify({ version: 1, projects: [null, { publicId: 'A', name: 'first' },
      { publicId: 'A', name: 'other' }, { publicId: '../bad', name: 'bad' }], activeProjectId: 'outside' }));
    expect(readWorkspaceSession(1, storage)).toEqual({ projects: [{ publicId: 'A', name: 'first' }], activeProjectId: null });
  });

  it.each(['{', 'null', '[]', 'false', '2', '{}', '{"version":2}', '{"version":"1"}',
    '{"version":1,"projects":{}}'])('recovers safely from corrupt or unsupported snapshot %s', (raw) => {
    const storage = createStorage();
    storage.setItem(key('1'), raw);
    expect(readWorkspaceSession(1, storage)).toEqual(empty);
  });

  it('ignores excessively large persisted data before attempting to parse it', () => {
    const storage = createStorage();
    storage.setItem(key('1'), ' '.repeat(512 * 1024 + 1));
    expect(readWorkspaceSession(1, storage)).toEqual(empty);
  });

  it.each([undefined, null, '', ' ', {}, [], NaN, Infinity, 'x'.repeat(257), String.fromCharCode(0xd800)])('ignores invalid account ids', (userId) => {
    const storage = createStorage();
    expect(() => saveWorkspaceSession(userId, sample, storage)).not.toThrow();
    expect(() => clearWorkspaceSession(userId, storage)).not.toThrow();
    expect(readWorkspaceSession(userId, storage)).toEqual(empty);
    expect(storage.entries.size).toBe(0);
  });

  it('tolerates disabled storage, quota limits and unavailable storage methods', () => {
    const blocked = {
      getItem: () => { throw new Error('SecurityError'); },
      setItem: () => { throw new Error('QuotaExceededError'); },
      removeItem: () => { throw new Error('SecurityError'); },
    };
    for (const storage of [blocked, null, {}, { getItem: () => undefined }]) {
      expect(readWorkspaceSession(1, storage)).toEqual(empty);
      expect(() => saveWorkspaceSession(1, sample, storage)).not.toThrow();
      expect(() => clearWorkspaceSession(1, storage)).not.toThrow();
    }
  });

  it('handles a browser that throws when sessionStorage itself is accessed', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, get() { throw new Error('SecurityError'); } });
    try {
      expect(readWorkspaceSession(1)).toEqual(empty);
      expect(() => saveWorkspaceSession(1, sample)).not.toThrow();
      expect(() => clearWorkspaceSession(1)).not.toThrow();
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'sessionStorage', descriptor);
      else delete globalThis.sessionStorage;
    }
  });
});
