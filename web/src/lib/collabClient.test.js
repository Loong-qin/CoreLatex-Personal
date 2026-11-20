// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { attachCollab, detachCollab, detachAllCollab, detachProjectCollab, pendingProjectEdits, subscribeProjectPresence, setPresenceListener } from './collabClient.js';

const auth = vi.hoisted(() => ({ uid: 1 }));
vi.mock('../api.js', () => ({ getToken: () => `header.${btoa(JSON.stringify({ uid: auth.uid }))}.signature` }));
vi.mock('y-websocket', async () => {
  const { Awareness } = await import('y-protocols/awareness');
  return { WebsocketProvider: class {
    constructor(url, room, doc, options) {
      this.url = url; this.room = room; this.doc = doc; this.options = options;
      this.listeners = new Map(); this.messageHandlers = [vi.fn(), vi.fn()];
      this.awareness = new Awareness(doc); this.awareness.on = vi.fn(this.awareness.on.bind(this.awareness));
      this.synced = false; this.wsconnected = true;
      this.ws = { send: vi.fn() }; this.connect = vi.fn(); this.disconnect = vi.fn();
      this.destroy = vi.fn(() => this.awareness.destroy());
    }
    on(name, cb) {
      if (!this.listeners.has(name)) this.listeners.set(name, new Set());
      this.listeners.get(name).add(cb);
    }
    emit(name, value) {
      const args = Array.isArray(value) ? value : [value];
      if (name === 'sync') this.synced = args[0];
      if (name === 'status') this.wsconnected = args[0].status === 'connected';
      for (const cb of this.listeners.get(name) || []) cb(...args);
    }
  } };
});

function deliverState(provider, state) {
  const encoder = encoding.createEncoder(); encoding.writeVarString(encoder, JSON.stringify(state));
  provider.messageHandlers[4](encoding.createEncoder(), decoding.createDecoder(encoding.toUint8Array(encoder)), provider, true);
}
function deliverEpoch(provider, epoch) { deliverState(provider, { version: 1, epoch }); }
function seedFromServer(session, text) {
  const server = new Y.Doc(); server.getText('content').insert(0, text);
  Y.applyUpdate(session.doc, Y.encodeStateAsUpdate(server), session.provider); server.destroy();
}
beforeEach(() => { auth.uid++; localStorage.clear(); });
afterEach(() => { detachAllCollab(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('collaboration session lifecycle', () => {
  it('waits for the requested project checkpoints before compiling', async () => {
    const main = attachCollab('p', 'main.tex');
    const chapter = attachCollab('p', 'chapter.tex');
    const other = attachCollab('other', 'main.tex');
    for (const session of [main, chapter, other]) {
      deliverEpoch(session.provider, 'e');
      session.provider.emit('sync', true);
      session.ytext.insert(0, 'new text');
    }
    const ready = vi.fn();
    const waiting = pendingProjectEdits('p').then(ready);
    const frame = decoding.createDecoder(main.provider.ws.send.mock.calls.at(-1)[0]);
    expect(decoding.readVarUint(frame)).toBe(4);
    expect(JSON.parse(decoding.readVarString(frame))).toMatchObject({ checkpoint: main.editVersion, flush: true });
    deliverState(main.provider, { version: 1, epoch: 'e', savedCheckpoint: main.editVersion });
    await Promise.resolve();
    expect(ready).not.toHaveBeenCalled();
    deliverState(chapter.provider, { version: 1, epoch: 'e', savedCheckpoint: chapter.editVersion });
    await waiting;
    expect(ready).toHaveBeenCalledOnce();
    expect(pendingProjectEdits('p')).toBeNull();
  });

  it('rejects the compile wait if a changed epoch replaces an unsaved document', async () => {
    const main = attachCollab('p', 'main.tex');
    deliverEpoch(main.provider, 'old');
    main.ytext.insert(0, 'draft');
    const waiting = pendingProjectEdits('p');
    deliverEpoch(main.provider, 'new');
    await expect(waiting).rejects.toThrow('协作修改尚未保存');
  });

  it('waits only for the selected file and returns immediately once that file is saved', async () => {
    const main = attachCollab('p', 'main.tex');
    const chapter = attachCollab('p', 'chapter.tex');
    for (const session of [main, chapter]) {
      deliverEpoch(session.provider, 'e');
      session.provider.emit('sync', true);
      session.ytext.insert(0, 'uncommitted text');
      session.provider.ws.send.mockClear();
    }
    const waiting = pendingProjectEdits('p', undefined, 'main.tex');
    const frame = decoding.createDecoder(main.provider.ws.send.mock.calls.at(-1)[0]);
    expect(decoding.readVarUint(frame)).toBe(4);
    expect(JSON.parse(decoding.readVarString(frame))).toMatchObject({ checkpoint: main.editVersion, flush: true });
    expect(chapter.provider.ws.send).not.toHaveBeenCalled();
    deliverState(main.provider, { version: 1, epoch: 'e', savedCheckpoint: main.editVersion });
    await waiting;
    expect(chapter.hasLocalEdits).toBe(true);
    expect(pendingProjectEdits('p', undefined, 'main.tex')).toBeNull();
  });

  it('keeps the last edit of a closing tab in the compile barrier until it is saved', async () => {
    const chapter = attachCollab('p', 'chapter.tex');
    deliverEpoch(chapter.provider, 'e');
    chapter.provider.emit('sync', true);
    chapter.ytext.insert(0, 'draft');
    detachCollab('p', 'chapter.tex');
    expect(chapter.destroyed).toBe(false);
    const waiting = pendingProjectEdits('p');
    expect(waiting).not.toBeNull();
    deliverState(chapter.provider, { version: 1, epoch: 'e', savedCheckpoint: chapter.editVersion });
    await waiting;
    expect(chapter.destroyed).toBe(true);
  });

  it('registers the epoch gate before connecting and restarts sync only after acknowledging', () => {
    const session = attachCollab('p', 'main.tex'); const provider = session.provider;
    expect(provider.options).toMatchObject({ connect: false, disableBc: true, params: { epochProtocol: '1' } });
    expect(provider.connect).toHaveBeenCalledOnce();
    deliverEpoch(provider, 'epoch-one');
    const frames = provider.ws.send.mock.calls.map(([bytes]) => decoding.createDecoder(bytes));
    expect(decoding.readVarUint(frames[0])).toBe(4);
    expect(JSON.parse(decoding.readVarString(frames[0]))).toEqual({ version: 1, epoch: 'epoch-one' });
    expect(decoding.readVarUint(frames[1])).toBe(0);
    expect(decoding.readVarUint(frames[1])).toBe(0); // sync step 1
  });

  it('retains unacknowledged Yjs edits across repeated reconnects in the same epoch', () => {
    const session = attachCollab('p', 'main.tex'); const provider = session.provider; const doc = session.doc;
    deliverEpoch(provider, 'same-epoch'); seedFromServer(session, 'saved\n'); provider.emit('sync', true);
    session.ytext.insert(session.ytext.length, 'unsent\n');
    for (let i = 0; i < 2; i++) {
      provider.emit('status', { status: 'disconnected' });
      expect(session.doc).toBe(doc); expect(session.provider).toBe(provider);
      deliverEpoch(provider, 'same-epoch'); provider.emit('sync', true);
    }
    expect(provider.destroy).not.toHaveBeenCalled();
    expect(session.ytext.toString()).toBe('saved\nunsent\n');
    expect(session.recoveryDrafts).toHaveLength(1);
    expect(session.recoveryDrafts[0].text).toBe('saved\nunsent\n');
  });

  it('preserves a recovery copy before replacing a changed epoch and never acknowledges on the old socket', () => {
    const session = attachCollab('p', 'main.tex'); const original = session.provider;
    deliverEpoch(original, 'old'); seedFromServer(session, 'saved\n'); original.emit('sync', true);
    session.ytext.insert(session.ytext.length, 'unsent paragraph\n');
    const reset = vi.fn(); session.resetCbs.add(reset); original.ws.send.mockClear();
    deliverEpoch(original, 'new');
    expect(original.ws.send).not.toHaveBeenCalled(); expect(original.destroy).toHaveBeenCalledOnce();
    expect(session.provider).not.toBe(original); expect(session.ytext.toString()).toBe(''); expect(reset).toHaveBeenCalledOnce();
    expect(session.recoveryDrafts[0].text).toContain('unsent paragraph');
    deliverEpoch(session.provider, 'new'); seedFromServer(session, 'restored version\n'); session.provider.emit('sync', true);
    expect(session.ytext.toString()).toBe('restored version\n');
    expect(session.recoveryDrafts[0].text).toContain('unsent paragraph');
  });

  it('does not create recovery drafts after the server confirms normal edits are durably saved', () => {
    const session = attachCollab('p', 'main.tex'); deliverEpoch(session.provider, 'e');
    seedFromServer(session, 'old'); session.provider.emit('sync', true);
    session.ytext.insert(3, ' updated');
    expect(session.hasLocalEdits).toBe(true);
    deliverState(session.provider, { version: 1, epoch: 'e', savedCheckpoint: session.editVersion });
    expect(session.hasLocalEdits).toBe(false);
    detachCollab('p', 'main.tex');
    expect(attachCollab('p', 'main.tex').recoveryDrafts).toEqual([]);
  });

  it('requires an acknowledgement of deletion-only edits and ignores stale or foreign acknowledgements', () => {
    const session = attachCollab('p', 'main.tex'); deliverEpoch(session.provider, 'e'); seedFromServer(session, 'keep delete'); session.provider.emit('sync', true);
    session.ytext.insert(0, 'first '); const first = session.editVersion;
    deliverState(session.provider, { version: 1, epoch: 'e', savedCheckpoint: first });
    session.ytext.delete(0, 6); const deletion = session.editVersion;
    expect(deletion).toBeGreaterThan(first);
    deliverState(session.provider, { version: 1, epoch: 'e', savedCheckpoint: first });
    deliverState(session.provider, { version: 1, epoch: 'other', savedCheckpoint: deletion });
    expect(session.hasLocalEdits).toBe(true); expect(session.epoch).toBe('e');
    session.provider.emit('status', { status: 'disconnected' });
    expect(session.recoveryDrafts[0].text).toBe('keep delete');
    session.provider.emit('status', { status: 'connected' }); deliverEpoch(session.provider, 'e'); session.provider.emit('sync', true);
    deliverState(session.provider, { version: 1, epoch: 'e', savedCheckpoint: deletion });
    expect(session.hasLocalEdits).toBe(false); expect(session.recoveryDrafts).toEqual([]);
  });

  it('does not restore an explicitly cleared copy unless another local edit occurs', () => {
    const session = attachCollab('p', 'main.tex'); deliverEpoch(session.provider, 'e'); session.ytext.insert(0, 'draft');
    session.provider.emit('status', { status: 'disconnected' });
    session.clearRecoveryDraft(session.recoveryDrafts[0].id);
    detachCollab('p', 'main.tex');
    expect(attachCollab('p', 'main.tex').recoveryDrafts).toEqual([]);
  });

  it('keeps recovery copies across view release and isolates accounts, projects and files', () => {
    const account = auth.uid;
    const session = attachCollab('p', 'main.tex'); deliverEpoch(session.provider, 'e');
    session.ytext.insert(0, 'private draft'); detachCollab('p', 'main.tex');
    const reopened = attachCollab('p', 'main.tex');
    expect(reopened.recoveryDrafts[0].text).toBe('private draft');
    expect(attachCollab('p2', 'main.tex').recoveryDrafts).toEqual([]);
    expect(attachCollab('p', 'other.tex').recoveryDrafts).toEqual([]);
    auth.uid++;
    expect(reopened.recoveryDrafts).toEqual([]);
    expect(attachCollab('p', 'main.tex').recoveryDrafts).toEqual([]);
    auth.uid = account;
    const saved = reopened.recoveryDrafts[0]; reopened.clearRecoveryDraft(saved.id);
    expect(reopened.recoveryDrafts).toEqual([]);
  });

  it('saves a dirty old-account session on late logout teardown without exposing it to the new account', () => {
    const originalAccount = auth.uid;
    const old = attachCollab('p', 'main.tex'); deliverEpoch(old.provider, 'e'); old.ytext.insert(0, 'old account unsent');
    auth.uid++; const nextAccount = auth.uid;
    const next = attachCollab('p', 'main.tex');
    detachCollab('p', 'main.tex', old);
    expect(old.destroyed).toBe(true); expect(old.recoveryDrafts).toEqual([]); expect(next.recoveryDrafts).toEqual([]);
    expect(next.provider.destroy).not.toHaveBeenCalled();
    const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i));
    expect(keys.some(key => key.startsWith(`corelatex.collab-recovery.v1:${originalAccount}:p:main.tex:`))).toBe(true);
    expect(keys.some(key => key.startsWith(`corelatex.collab-recovery.v1:${nextAccount}:`))).toBe(false);
    auth.uid = originalAccount;
    expect(attachCollab('p', 'main.tex').recoveryDrafts[0].text).toBe('old account unsent');
  });

  it('never overwrites another browser tab recovery record when saving or acknowledging its own', () => {
    const prefix = `corelatex.collab-recovery.v1:${auth.uid}:p:main.tex:`;
    const session = attachCollab('p', 'main.tex'); deliverEpoch(session.provider, 'e');
    const other = { id: 'other-tab', epoch: 'e', documentId: 'other-doc', editVersion: 1, capturedAt: Date.now(), text: 'other tab unsent' };
    localStorage.setItem(prefix + other.id, JSON.stringify(other));
    session.ytext.insert(0, 'this tab draft'); session.provider.emit('status', { status: 'disconnected' });
    expect(JSON.parse(localStorage.getItem(prefix + other.id))).toEqual(other);
    session.provider.emit('status', { status: 'connected' }); deliverEpoch(session.provider, 'e'); session.provider.emit('sync', true);
    deliverState(session.provider, { version: 1, epoch: 'e', savedCheckpoint: session.editVersion });
    expect(session.recoveryDrafts).toEqual([]);
    expect(JSON.parse(localStorage.getItem(prefix + other.id))).toEqual(other);
  });

  it('retains an in-memory recovery copy when storage is full, including a closed view', () => {
    const session = attachCollab('p', 'main.tex'); deliverEpoch(session.provider, 'e');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('QuotaExceededError'); });
    session.ytext.insert(0, 'not lost on quota failure');
    session.provider.emit('status', { status: 'disconnected' });
    expect(session.recoveryStorageError).toBe(true); expect(session.recoveryDrafts[0].text).toBe('not lost on quota failure');
    detachCollab('p', 'main.tex');
    expect(attachCollab('p', 'main.tex').recoveryDrafts[0].text).toBe('not lost on quota failure');
  });

  it('fails closed with a visible reason for unsupported servers and handshake timeouts', async () => {
    const first = attachCollab('p', 'main.tex');
    first.provider.messageHandlers[0]();
    expect(first.connectionError).toContain('尚未支持'); expect(first.provider.disconnect).toHaveBeenCalledOnce();
    vi.useFakeTimers();
    const second = attachCollab('p', 'other.tex'); second.provider.emit('status', { status: 'connected' });
    await vi.advanceTimersByTimeAsync(10001);
    expect(second.connectionError).toContain('超时'); expect(second.status).toBe('disconnected');
  });

  it('does not recursively disconnect a socket rejected for permissions or a renamed file', () => {
    const session = attachCollab('p', 'main.tex');
    session.provider.emit('connection-close', { code: 4403 });
    expect(session.provider.disconnect).not.toHaveBeenCalled();
    expect(session.provider.shouldConnect).toBe(false); expect(session.connectionError).toContain('权限');
  });

  it('releases only after the last consumer, and releases the exact account session', () => {
    const session = attachCollab('p', 'main.tex'); expect(attachCollab('p', 'main.tex')).toBe(session);
    detachCollab('p', 'main.tex'); expect(session.provider.destroy).not.toHaveBeenCalled();
    auth.uid++; const other = attachCollab('p', 'main.tex');
    detachCollab('p', 'main.tex', session);
    expect(session.provider.destroy).toHaveBeenCalledOnce(); expect(other.provider.destroy).not.toHaveBeenCalled();
  });
});

describe('cached project collaboration isolation', () => {
  it('closes only the requested project without destroying another project session', () => {
    const a = attachCollab('alpha', 'main.tex');
    const b = attachCollab('beta', 'main.tex');
    detachProjectCollab('alpha');
    expect(a.destroyed).toBe(true);
    expect(a.provider.destroy).toHaveBeenCalledOnce();
    expect(b.destroyed).toBe(false);
    expect(b.provider.destroy).not.toHaveBeenCalled();
    expect(attachCollab('beta', 'main.tex')).toBe(b);
  });

  it('groups presence within each project and unsubscribes one consumer without affecting another', async () => {
    vi.useFakeTimers();
    const a = attachCollab('alpha', 'main.tex');
    const aSecond = attachCollab('alpha', 'notes.tex');
    const b = attachCollab('beta', 'main.tex');
    a.provider.awareness.getStates = () => new Map([[1, { user: { name: 'Alice', color: 'green' } }]]);
    aSecond.provider.awareness.getStates = () => new Map([[2, { user: { name: 'Alice', color: 'green' } }]]);
    b.provider.awareness.getStates = () => new Map([[3, { user: { name: 'Bob', color: 'blue' } }]]);
    const alpha = vi.fn(), beta = vi.fn(), legacy = vi.fn();
    const stopAlpha = subscribeProjectPresence('alpha', alpha);
    const stopBeta = subscribeProjectPresence('beta', beta);
    setPresenceListener(legacy);
    try {
      expect(alpha).toHaveBeenLastCalledWith([{ name: 'Alice', color: 'green' }]);
      expect(beta).toHaveBeenLastCalledWith([{ name: 'Bob', color: 'blue' }]);
      const update = b.provider.awareness.on.mock.calls.find(([event]) => event === 'update')[1];
      update();
      await vi.advanceTimersByTimeAsync(150);
      expect(legacy).toHaveBeenLastCalledWith([{ name: 'Alice', color: 'green' }, { name: 'Bob', color: 'blue' }]);
      stopAlpha();
      const count = alpha.mock.calls.length;
      detachProjectCollab('alpha');
      expect(alpha).toHaveBeenCalledTimes(count);
      expect(beta).toHaveBeenLastCalledWith([{ name: 'Bob', color: 'blue' }]);
      expect(b.provider.destroy).not.toHaveBeenCalled();
    } finally {
      stopAlpha(); stopBeta(); setPresenceListener(null); vi.useRealTimers();
    }
  });
});
