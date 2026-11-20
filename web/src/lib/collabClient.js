import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import { WebsocketProvider } from 'y-websocket';
import { getToken } from '../api.js';

// A room epoch identifies its Yjs item history. Ordinary reconnects retain the
// document; a new epoch must never receive updates from the old item history.
const MSG_ROOM_STATE = 4;
const HANDSHAKE_TIMEOUT_MS = 10000;
const sessions = new Map();
// A storage failure must not erase the only recovery copy when a view closes.
const recoveryMemory = new Map();
let collabUser = null;

function recoveryOwner() {
  try {
    const raw = getToken().split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const uid = JSON.parse(atob(raw)).uid;
    return Number.isSafeInteger(uid) && uid > 0 ? String(uid) : null;
  } catch { return null; }
}

function recoveryState(owner, projectId, filePath) {
  const key = owner && `corelatex.collab-recovery.v1:${owner}:${encodeURIComponent(projectId)}:${encodeURIComponent(filePath)}`;
  if (key && recoveryMemory.has(key)) return recoveryMemory.get(key);
  const drafts = [];
  let storageError = false;
  try {
    // Each immutable recovery copy has its own key. A second tab saving or
    // acknowledging its draft must not overwrite another tab's recovery copy.
    for (let i = 0; key && i < localStorage.length; i++) {
      const itemKey = localStorage.key(i);
      if (!itemKey?.startsWith(key + ':')) continue;
      const row = JSON.parse(localStorage.getItem(itemKey));
      if (row && typeof row.id === 'string' && typeof row.text === 'string' && typeof row.epoch === 'string' && Number.isFinite(row.capturedAt)) drafts.push(row);
    }
  } catch { storageError = true; }
  drafts.sort((a, b) => a.capturedAt - b.capturedAt);
  const state = { key, drafts, persistedIds: new Set(drafts.map(draft => draft.id)), storageError };
  if (key) recoveryMemory.set(key, state);
  return state;
}

function notifyRecovery(s) {
  for (const cb of [...s.recoveryCbs]) { try { cb(); } catch {} }
}

function persistRecovery(s) {
  const state = s.recovery;
  try {
    if (!state.key) throw new Error('No account recovery storage');
    const ids = new Set(state.drafts.map(draft => draft.id));
    for (const id of [...state.persistedIds]) if (!ids.has(id)) {
      localStorage.removeItem(`${state.key}:${id}`); state.persistedIds.delete(id);
    }
    for (const draft of state.drafts) if (!state.persistedIds.has(draft.id)) {
      localStorage.setItem(`${state.key}:${draft.id}`, JSON.stringify(draft)); state.persistedIds.add(draft.id);
    }
    state.storageError = false;
  } catch { state.storageError = true; }
  notifyRecovery(s);
}

function preserveDraft(s, reason) {
  if (!s.hasLocalEdits || s.destroyed || s.editVersion <= s.dismissedVersion) return;
  const text = s.ytext.toString();
  if (s.recovery.drafts.some(draft => draft.epoch === s.epoch && draft.text === text)) return;
  s.recovery.drafts.push({ id: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`, epoch: s.epoch || '', documentId: s.documentId, editVersion: s.editVersion, text, capturedAt: Date.now(), reason });
  persistRecovery(s);
}

function hueOf(s) {
  let h = 0;
  for (const ch of String(s || '')) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

export function setCollabUser(name) {
  const n = String(name || '').trim();
  if (!n) return;
  const hue = hueOf(n);
  collabUser = { name: n, color: `hsl(${hue}, 65%, 42%)`, colorLight: `hsl(${hue}, 65%, 88%)` };
  for (const s of sessions.values()) applyAwarenessUser(s);
}

function applyAwarenessUser(s) {
  if (!collabUser) return;
  try { s.provider?.awareness?.setLocalStateField('user', collabUser); } catch {}
}

function failHandshake(s, provider, message, { disconnect = true } = {}) {
  if (s.destroyed || s.provider !== provider) return;
  preserveDraft(s, 'handshake_failed');
  s.connectionError = message;
  clearTimeout(s.handshakeTimer);
  provider.shouldConnect = false;
  if (disconnect) provider.disconnect();
  // Also notify views when the provider was never connected (for example an
  // unsupported server), so they cannot silently remain in a connecting state.
  s.status = 'disconnected';
  provider.emit('status', [{ status: 'disconnected' }]);
}

function sendEncoded(provider, build) {
  const encoder = encoding.createEncoder();
  build(encoder);
  provider.ws.send(encoding.toUint8Array(encoder));
}

function sendCheckpoint(s, provider) {
  if (s.destroyed || s.provider !== provider || !s.handshakeReady || !provider.synced || !provider.wsconnected || !s.hasLocalEdits) return;
  const state = { version: 1, epoch: s.epoch, checkpoint: s.editVersion };
  if (s.saveWaiters.size) state.flush = true;
  sendEncoded(provider, encoder => {
    encoding.writeVarUint(encoder, MSG_ROOM_STATE);
    encoding.writeVarString(encoder, JSON.stringify(state));
  });
}

function acceptCheckpoint(s, state) {
  if (!s.handshakeReady || state.epoch !== s.epoch || !Number.isSafeInteger(state.savedCheckpoint) ||
      state.savedCheckpoint < 0 || state.savedCheckpoint > s.editVersion) return;
  s.savedVersion = Math.max(s.savedVersion, state.savedCheckpoint);
  s.hasLocalEdits = s.editVersion > s.savedVersion;
  for (const check of s.saveWaiters) check();
  // Only this document's explicitly acknowledged checkpoints prove a recovery
  // copy is saved. A merged local document or a matching state vector does not.
  const oldLength = s.recovery.drafts.length;
  s.recovery.drafts = s.recovery.drafts.filter(draft => !(draft.documentId === s.documentId &&
    draft.epoch === s.epoch && draft.editVersion <= s.savedVersion));
  if (s.recovery.drafts.length !== oldLength) persistRecovery(s);
}

function createProvider(s) {
  // BroadcastChannel would merge documents before the server can check their
  // epochs. Other tabs still collaborate through the authenticated server.
  const provider = new WebsocketProvider(s.url, s.room, s.doc, { params: s.params, connect: false, disableBc: true });
  s.provider = provider;
  s.handshakeReady = false;
  const current = () => !s.destroyed && s.provider === provider;
  const syncHandler = provider.messageHandlers[0];
  provider.messageHandlers[0] = (...args) => {
    if (current() && s.handshakeReady) syncHandler(...args);
    else if (current()) failHandshake(s, provider, '协同服务尚未支持安全重连，当前内容保持只读；请更新服务并刷新页面重试。');
  };
  const awarenessHandler = provider.messageHandlers[1];
  provider.messageHandlers[1] = (...args) => { if (current() && s.handshakeReady) awarenessHandler(...args); };
  provider.messageHandlers[MSG_ROOM_STATE] = (_encoder, decoder) => {
    if (!current()) return;
    let state;
    try { state = JSON.parse(decoding.readVarString(decoder)); } catch {}
    if (state?.version !== 1 || typeof state.epoch !== 'string' || !state.epoch || state.epoch.length > 128) {
      failHandshake(s, provider, '协同服务握手失败，当前内容保持只读；断线前草稿仍可下载。');
      return;
    }
    if (Object.hasOwn(state, 'savedCheckpoint')) { acceptCheckpoint(s, state); return; }
    clearTimeout(s.handshakeTimer);
    if (s.epoch && s.epoch !== state.epoch) {
      preserveDraft(s, 'room_changed');
      rebuildSession(s);
      return;
    }
    s.epoch = state.epoch;
    s.handshakeReady = true;
    s.connectionError = '';
    // The provider's open-time sync was deliberately ignored by the server.
    // Acknowledge first, then restart both directions of the normal protocol.
    sendEncoded(provider, encoder => { encoding.writeVarUint(encoder, MSG_ROOM_STATE); encoding.writeVarString(encoder, JSON.stringify({ version: 1, epoch: s.epoch })); });
    sendEncoded(provider, encoder => { encoding.writeVarUint(encoder, 0); syncProtocol.writeSyncStep1(encoder, s.doc); });
    if (provider.awareness.getLocalState() !== null) sendEncoded(provider, encoder => {
      encoding.writeVarUint(encoder, 1);
      encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(provider.awareness, [s.doc.clientID]));
    });
  };
  provider.on('status', ({ status }) => {
    if (!current()) return;
    s.status = status;
    if (status === 'connected') {
      clearTimeout(s.handshakeTimer);
      s.handshakeTimer = setTimeout(() => failHandshake(s, provider, '协同服务握手超时，当前内容保持只读；断线前草稿仍可下载。'), HANDSHAKE_TIMEOUT_MS);
      s.handshakeTimer.unref?.();
    } else if (status === 'disconnected') {
      clearTimeout(s.handshakeTimer);
      s.handshakeReady = false;
      preserveDraft(s, 'connection_lost');
    }
  });
  provider.on('sync', synced => {
    if (current() && synced && s.handshakeReady) {
      s.syncedOnce = true;
      // Let the provider finish sending any sync response before the marker.
      queueMicrotask(() => sendCheckpoint(s, provider));
    }
  });
  provider.on('connection-close', event => {
    if (!current()) return;
    if ([4403, 4404].includes(event?.code)) {
      failHandshake(s, provider, event.code === 4404 ? '文件已移动或删除，当前内容保持只读；可下载断线前草稿。' : '协同访问权限已失效，当前内容保持只读；可下载断线前草稿。', { disconnect: false });
    }
  });
  // Registered after the provider's update handler: its Yjs update is sent
  // before our durability marker, including deletion-only transactions.
  s.doc.on('update', (_update, _origin, _doc, transaction) => {
    if (current() && transaction.local && transaction.changed.has(s.ytext)) {
      ++s.editVersion;
      s.hasLocalEdits = true;
      sendCheckpoint(s, provider);
    }
  });
  applyAwarenessUser(s);
  wireAwareness(s);
  return provider;
}

function rebuildSession(s) {
  clearTimeout(s.handshakeTimer);
  // Invalidate callbacks from the old socket before destroying it.
  const provider = s.provider;
  s.provider = null;
  provider.destroy();
  s.doc.destroy();
  s.doc = new Y.Doc();
  s.ytext = s.doc.getText('content');
  s.epoch = null;
  s.hasLocalEdits = false;
  s.editVersion = 0; s.savedVersion = 0; s.dismissedVersion = -1;
  s.documentId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
  for (const check of s.saveWaiters) check();
  s.status = 'connecting';
  s.syncedOnce = false;
  createProvider(s);
  for (const cb of [...s.resetCbs]) {
    try { cb(); } catch (err) { console.error('[collab] reset 回调失败:', err); }
  }
  s.provider.connect();
}

export function attachCollab(projectId, filePath) {
  const owner = recoveryOwner();
  const key = `${owner || 'anonymous'}:${projectId}/${filePath}`;
  let s = sessions.get(key);
  if (s) { s.refs++; return s; }
  const doc = new Y.Doc();
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  s = {
    key, owner, projectId: String(projectId),
    url: `${protocol}://${location.host}/collab`, room: `${projectId}/${encodeURIComponent(filePath)}`,
    params: { token: getToken(), project: String(projectId), file: filePath, epochProtocol: '1' },
    doc, provider: null, ytext: doc.getText('content'), refs: 1, status: 'connecting',
    epoch: null, hasLocalEdits: false, editVersion: 0, savedVersion: 0, dismissedVersion: -1,
    documentId: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`, syncedOnce: false, destroyed: false,
    connectionError: '', recovery: recoveryState(owner, projectId, filePath), recoveryCbs: new Set(), resetCbs: new Set(), saveWaiters: new Set(),
    get recoveryDrafts() { return this.owner === recoveryOwner() ? this.recovery.drafts : []; },
    get recoveryStorageError() { return this.recovery.storageError; },
    clearRecoveryDraft(id) {
      if (this.owner !== recoveryOwner()) return;
      const index = this.recovery.drafts.findIndex(draft => draft.id === id);
      if (index >= 0) {
        const draft = this.recovery.drafts[index];
        if (draft.documentId === this.documentId) this.dismissedVersion = Math.max(this.dismissedVersion, draft.editVersion);
        this.recovery.drafts.splice(index, 1); persistRecovery(this);
      }
    },
    destroy() {
      if (this.destroyed) return;
      preserveDraft(this, 'view_closed');
      this.destroyed = true;
      for (const check of this.saveWaiters) check();
      clearTimeout(this.handshakeTimer);
      sessions.delete(key);
      this.provider.destroy(); this.doc.destroy();
      this.resetCbs.clear(); this.recoveryCbs.clear();
      notifyPresence();
    },
  };
  createProvider(s);
  sessions.set(key, s);
  s.provider.connect();
  return s;
}

export function detachCollab(projectId, filePath, attachedSession = null) {
  const s = attachedSession || sessions.get(`${recoveryOwner() || 'anonymous'}:${projectId}/${filePath}`);
  if (!s || s.destroyed || s.refs === 0 || --s.refs > 0) return;
  if (!s.hasLocalEdits || s.owner !== recoveryOwner() || !s.handshakeReady || !s.provider.synced || !s.provider.wsconnected) {
    s.destroy();
    return;
  }
  // Keep the last edit visible to a compile started immediately after closing
  // this tab. Project teardown still destroys the session immediately.
  preserveDraft(s, 'view_closed');
  const waiting = waitForSavedEdits([s]);
  s.closeWait = waiting;
  const close = () => { if (!s.refs && s.closeWait === waiting) s.destroy(); };
  waiting.then(close, close);
}

export function detachProjectCollab(projectId) {
  for (const s of [...sessions.values()]) if (s.projectId === String(projectId)) s.destroy();
}

// Compile and selection requests travel separately from Yjs updates. A
// selection action only needs the durability checkpoint for its own file.
export function pendingProjectEdits(projectId, signal, filePath) {
  const owner = recoveryOwner();
  const dirty = [...sessions.values()].filter(s => s.owner === owner && s.projectId === String(projectId) &&
    s.hasLocalEdits && (filePath === undefined || s.params.file === filePath));
  if (!dirty.length) return null;
  const message = filePath === undefined
    ? '协作修改尚未保存到服务器，请在连接恢复后重新编译'
    : '所选文件的协作修改尚未保存到服务器，请在连接恢复后重新选择文字';
  return waitForSavedEdits(dirty, signal, message);
}

function waitForSavedEdits(dirty, signal, message) {
  const pending = dirty.map(session => ({ session, version: session.editVersion, documentId: session.documentId }));
  return new Promise((resolve, reject) => {
    function finish(error) {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      for (const { session } of pending) session.saveWaiters.delete(check);
      if (error) reject(error);
      else resolve();
    }
    function cancel() { finish(signal.reason); }
    function check() {
      if (pending.some(({ session, documentId }) => session.destroyed || session.documentId !== documentId)) {
        finish(new Error(message));
      } else if (pending.every(({ session, version }) => session.savedVersion >= version)) {
        finish();
      }
    }
    const timer = setTimeout(() => finish(new Error(message)), 8000);
    for (const { session } of pending) session.saveWaiters.add(check);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    else {
      try {
        for (const { session } of pending) sendCheckpoint(session, session.provider);
      } catch { finish(new Error(message)); }
    }
  });
}

export function detachAllCollab() {
  for (const s of [...sessions.values()]) s.destroy();
  notifyPresence();
}

// Refreshing/closing a tab may happen before WebSocket delivery is confirmed.
// Keep an account-scoped recovery copy without writing it back automatically.
globalThis.window?.addEventListener('pagehide', () => {
  for (const s of sessions.values()) preserveDraft(s, 'page_closed');
});

// ---- 项目在线协作者聚合 ----
// 同一项目可能同时打开多个文件、同一浏览器也可能开多个标签页，每份会话都是独立的
// awareness clientID；按 user.name 去重后得到项目级在线名单（同一人只计一次）。
// awareness 变化（进入/离开/改名）时通过 onPresence 通知订阅方（editor store）。
let onPresence = null;
let presenceTimer = null;
const projectPresenceListeners = new Map();

export function setPresenceListener(cb) {
  onPresence = typeof cb === 'function' ? cb : null;
}

/** Subscribe to collaborators from only this project; returns its cleanup function. */
export function subscribeProjectPresence(projectId, cb) {
  if (typeof cb !== 'function') return () => {};
  const id = String(projectId);
  if (!projectPresenceListeners.has(id)) projectPresenceListeners.set(id, new Set());
  const listeners = projectPresenceListeners.get(id);
  listeners.add(cb);
  try { cb(presenceForProject(id)); } catch (err) { console.error('[collab] presence 回调失败:', err); }
  return () => {
    listeners.delete(cb);
    if (!listeners.size && projectPresenceListeners.get(id) === listeners) projectPresenceListeners.delete(id);
  };
}

function schedulePresence() {
  clearTimeout(presenceTimer);
  presenceTimer = setTimeout(notifyPresence, 150);
}

function presenceForProject(projectId = null) {
  const byName = new Map();
  for (const s of sessions.values()) {
    if (s.destroyed || !s.provider?.awareness || (projectId != null && s.projectId !== projectId)) continue;
    for (const state of s.provider.awareness.getStates().values()) {
      const name = state?.user?.name;
      if (name && !byName.has(name)) byName.set(name, { name, color: state.user.color });
    }
  }
  return [...byName.values()];
}

function notifyPresence() {
  if (onPresence) {
    try { onPresence(presenceForProject()); } catch (err) { console.error('[collab] presence 回调失败:', err); }
  }
  for (const [projectId, listeners] of projectPresenceListeners) {
    const users = presenceForProject(projectId);
    for (const cb of [...listeners]) {
      try { cb(users); } catch (err) { console.error('[collab] presence 回调失败:', err); }
    }
  }
}

// 注册到会话的 awareness：状态变化（进入/离开/改名）→ 聚合通知
function wireAwareness(s) {
  try {
    s.provider.awareness.on('update', () => schedulePresence());
    s.provider.awareness.on('destroy', () => schedulePresence());
  } catch { /* awareness 未就绪 */ }
}
