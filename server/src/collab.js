import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import { getDb } from './db.js';
import { recordManualReviewChange } from './services/agent/reviewState.js';
import { verifyToken } from './auth.js';
import { getProjectAccess, touchProject } from './access.js';
import { projectDir } from './config.js';
import { safeJoin } from './util.js';

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;
const MSG_ROOM_STATE = 4;
const MAX_PAYLOAD = 2 * 1024 * 1024; // 单条消息上限 2MB
const SAVE_DEBOUNCE_MS = 2000;
const IDLE_DESTROY_MS = 5 * 60 * 1000;
const CLOSE_FORBIDDEN = 4403;

/** key = `${projectId}:${file}` → room */
const rooms = new Map();

function send(ws, buf) {
  if (ws.readyState === ws.OPEN) ws.send(buf);
}

function hashText(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

// Yjs 文档状态持久化：保留 item ID，服务重启后陈旧客户端的 update 能正确合并为 no-op，
// 而不是被当成全新插入导致内容翻倍。状态放在 .build/collab/ 下（快照与编译打包已排除 .build）。
function collabStatePath(projectId, file) {
  const name = hashText(`${projectId}:${file}`);
  return path.join(projectDir(projectId), '.build', 'collab', `${name}.json`);
}

function persistRoomState(room, { strict = false } = {}) {
  try {
    const text = room.doc.getText('content').toString();
    const stateFile = collabStatePath(room.projectId, room.file);
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({
      epoch: room.epoch,
      diskHash: hashText(text),
      update: Buffer.from(Y.encodeStateAsUpdate(room.doc)).toString('base64'),
    }));
    return true;
  } catch (err) {
    if (strict) throw err;
    console.error(`[collab] 状态持久化失败 ${room.key}:`, err.message);
    return false;
  }
}

function acknowledgeSavedCheckpoints(room) {
  if (room.dirty || !room.durable) return;
  for (const [ws, state] of [...room.conns]) {
    if (!state.epochReady || state.pendingCheckpoint === null || !refreshConnection(ws, room, state) || state.readOnly) continue;
    if (state.pendingCheckpoint <= state.savedCheckpoint) continue;
    state.savedCheckpoint = state.pendingCheckpoint;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MSG_ROOM_STATE);
    encoding.writeVarString(encoder, JSON.stringify({ version: 1, epoch: room.epoch, savedCheckpoint: state.savedCheckpoint }));
    send(ws, encoding.toUint8Array(encoder));
  }
}

let shutdownRequested = false;

/** Stop receiving new collaborative updates, persist all already accepted
 * changes, then close rooms. A failed flush retains every room for retry. */
export function closeCollabForShutdown() {
  shutdownRequested = true;
  const pending = [...rooms.values()];
  for (const room of pending) { clearTimeout(room.saveTimer); clearTimeout(room.idleTimer); }
  for (const room of pending) saveRoom(room, { strict: true });
  const sockets = pending.flatMap(room => [...room.conns.keys()]);
  for (const room of pending) destroyRoom(room, { persist: false, reason: 'Service restarting' });
  return sockets;
}

function saveRoom(room, { strict = false } = {}) {
  if (room.destroyed || !room.dirty) return;
  try {
    // 文件已被人工删除时不再写盘(协同房间可能因客户端重连被重建),防止已删文件以空内容或旧内容复活
    if (!fs.existsSync(room.absPath)) {
      room.durable = false;
      if (strict) {
        const error = new Error('协作文件已被删除，尚有已接收修改未同步：' + room.file);
        error.code = 'COLLAB_FILE_DELETED';
        throw error;
      }
      room.dirty = false;
      return;
    }
    fs.mkdirSync(path.dirname(room.absPath), { recursive: true });
    const text = room.doc.getText('content').toString();
    fs.writeFileSync(room.absPath, text);
    touchProject(room.projectId);
    // Review provenance is updated per client transaction, not by accepting the whole saved document.
    if (!persistRoomState(room, { strict })) { room.durable = false; return; }
    // A strict caller must be able to retry all accepted changes after either
    // the document or its collaborative state could not be persisted.
    room.dirty = false;
    room.durable = true;
    acknowledgeSavedCheckpoints(room);
  } catch (err) {
    room.durable = false;
    if (strict) throw err;
    console.error(`[collab] 落盘失败 ${room.key}:`, err.message);
  }
}

function scheduleSave(room) {
  clearTimeout(room.saveTimer);
  room.saveTimer = setTimeout(() => saveRoom(room), SAVE_DEBOUNCE_MS);
  room.saveTimer.unref();
}

function destroyRoom(room, { persist = true, code = 1012, reason = 'reload' } = {}) {
  if (room.destroyed) return;
  clearTimeout(room.saveTimer);
  clearTimeout(room.idleTimer);
  if (persist) saveRoom(room);
  room.destroyed = true;
  // An old socket's delayed close must never save or remove a replacement room.
  if (rooms.get(room.key) === room) rooms.delete(room.key);
  const conns = [...room.conns.keys()];
  room.conns.clear();
  for (const ws of conns) {
    try { ws.close(code, reason); } catch {}
  }
  room.awareness.destroy();
  room.doc.destroy();
}

function removeConnection(ws, room, connState) {
  if (room.destroyed || !room.conns.delete(ws)) return;
  if (connState.controlledIds.size) {
    awarenessProtocol.removeAwarenessStates(room.awareness, [...connState.controlledIds], null);
  }
  if (!room.conns.size) {
    clearTimeout(room.saveTimer);
    if (shutdownRequested) {
      // A failed strict shutdown still owns this dirty document. In particular,
      // the ordinary missing-file save path would clear dirty and lose it.
      clearTimeout(room.idleTimer);
      return;
    }
    saveRoom(room);
    clearTimeout(room.idleTimer);
    room.idleTimer = setTimeout(() => destroyRoom(room), IDLE_DESTROY_MS);
    room.idleTimer.unref();
  }
}

// Both input and output must use current permissions: an idle revoked client
// must not receive the next document/awareness update from another client.
function refreshConnection(ws, room, connState) {
  if (room.destroyed || !room.conns.has(ws)) return false;
  const user = getDb().prepare('SELECT * FROM users WHERE id = ?').get(connState.userId);
  const { project, access } = user?.status === 'active'
    ? getProjectAccess(user, connState.publicId)
    : { project: null, access: null };
  if (!project || !access || Date.now() >= connState.expiresAt) {
    removeConnection(ws, room, connState);
    try { ws.close(CLOSE_FORBIDDEN, 'Access revoked or login expired'); } catch {}
    return false;
  }
  connState.readOnly = access === 'viewer' || !!project.archived || !!project.deleted;
  return true;
}

/** Refresh active connections synchronously before the permission-changing API returns. */
export function refreshProjectRoomPermissions(projectId) {
  for (const room of rooms.values()) {
    if (String(room.projectId) !== String(projectId)) continue;
    clearTimeout(room.saveTimer);
    saveRoom(room); // Keep edits already accepted before the restriction changed.
    for (const [ws, state] of [...room.conns]) refreshConnection(ws, room, state);
  }
}

export function refreshUserRoomPermissions(userId) {
  for (const room of rooms.values()) {
    for (const [ws, state] of [...room.conns]) {
      if (state.userId === Number(userId)) refreshConnection(ws, room, state);
    }
  }
}

/** Forget a permanently deleted project without allowing a delayed close to recreate it. */
export function removeProjectRooms(projectId) {
  for (const room of [...rooms.values()]) {
    if (String(room.projectId) === String(projectId)) {
      destroyRoom(room, { persist: false, code: CLOSE_FORBIDDEN, reason: 'Project deleted' });
    }
  }
}

/** Flush accepted edits before reading disk. Strict snapshot/merge callers
 * must stop on a failed save instead of proceeding with an older disk image. */
export function flushProjectRooms(projectId, { strict = false } = {}) {
  const prefix = `${projectId}:`;
  for (const room of rooms.values()) {
    if (room.key.startsWith(prefix)) {
      clearTimeout(room.saveTimer);
      saveRoom(room, { strict });
    }
  }
}

/** 外部写盘后直接替换在线房间的内容（滚动审阅/变更集应用用）：
 * 以原子事务把房间文本替换为最新内容并广播给所有连接的客户端——
 * 不销毁房间、不触发客户端重连，因此不存在新旧状态 CRDT 合并导致内容翻倍的风险。 */
export function replaceProjectRoomContent(projectId, filePath, content) {
  const canonicalFile = path.normalize(String(filePath)).split(path.sep).join('/');
  const room = rooms.get(`${projectId}:${canonicalFile}`);
  if (!room) return;
  const ytext = room.doc.getText('content');
  const current = ytext.toString();
  if (current === content) return;
  // 最小差异区间替换(公共前缀/后缀裁剪):避免全量删除+全量插入把编辑器视口
  // 打回文档开头——AI 提交修改时用户可能正在浏览其他区域,视口应保持原地
  let start = 0;
  const minLen = Math.min(current.length, content.length);
  while (start < minLen && current[start] === content[start]) start++;
  let endCur = current.length;
  let endNew = content.length;
  while (endCur > start && endNew > start && current[endCur - 1] === content[endNew - 1]) { endCur--; endNew--; }
  room.doc.transact(() => {
    ytext.delete(start, endCur - start);
    ytext.insert(start, content.slice(start, endNew));
  });
  room.dirty = true;
  scheduleSave(room);
}

/** 外部（变更集应用/撤销等）写盘后调用：销毁受影响文件的房间并断开其全部连接。
 * 客户端检测到断开会丢弃本地文档重连，服务端届时以磁盘内容重建房间并重新同步——
 * 在线编辑器由此拿到最新内容，旧内容也不会再反写覆盖磁盘。 */
export function reloadProjectRooms(projectId, filePaths = null) {
  const prefix = `${projectId}:`;
  const wanted = filePaths ? new Set(filePaths.map((file) => path.normalize(String(file)).split(path.sep).join('/'))) : null;
  for (const room of [...rooms.values()]) {
    if (!room.key.startsWith(prefix)) continue;
    if (wanted && !wanted.has(room.key.slice(prefix.length))) continue;
    destroyRoom(room, { persist: false });
  }
}

/** Close a moved file or directory's rooms regardless of AI review state.
 * The caller must successfully flush before moving the corresponding bytes. */
export function reloadProjectPathRooms(projectId, filePath) {
  const prefix = path.normalize(String(filePath)).split(path.sep).join('/').replace(/\/$/, '');
  for (const room of [...rooms.values()]) {
    if (String(room.projectId) === String(projectId) &&
      (room.file === prefix || room.file.startsWith(prefix + '/'))) destroyRoom(room, { persist: false, code: 4404, reason: 'File moved or deleted' });
  }
}

function getOrCreateRoom(projectId, file, absPath) {
  const key = `${projectId}:${file}`;
  let room = rooms.get(key);
  if (room) {
    clearTimeout(room.idleTimer);
    room.idleTimer = null;
    return room;
  }
  // 以磁盘文件为初始真源；文件不存在(如刚被人工删除)时只在内存建空房间,
  // 不落盘创建——防止还开着编辑器标签的客户端重连时把已删除的文件以空文件复活
  const diskContent = fs.existsSync(absPath) ? fs.readFileSync(absPath, 'utf8') : '';
  const doc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(doc);
  awareness.setLocalState(null);
  room = {
    key,
    epoch: crypto.randomUUID(),
    projectId,
    file,
    absPath,
    doc,
    awareness,
    conns: new Map(), // ws → { readOnly, controlledIds:Set<number> }
    dirty: false,
    durable: false,
    destroyed: false,
    saveTimer: null,
    idleTimer: null,
  };
  // 初始载入不触发广播/落盘（此时 conns 为空、update 监听尚未注册）。
  // 优先恢复持久化的 Yjs 状态（diskHash 与磁盘内容匹配才可信），
  // 否则回退磁盘文本播种并立即持久化新状态。
  let restored = false, restoredEpoch = false;
  try {
    const stateFile = collabStatePath(projectId, file);
    if (fs.existsSync(stateFile)) {
      const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (saved.diskHash === hashText(diskContent) && saved.update) {
        Y.applyUpdate(doc, Buffer.from(saved.update, 'base64'));
        if (typeof saved.epoch === 'string' && saved.epoch) { room.epoch = saved.epoch; restoredEpoch = true; }
        restored = true;
      }
    }
  } catch (err) {
    console.error(`[collab] 状态恢复失败 ${key}，回退磁盘播种:`, err.message);
  }
  if (!restored && diskContent) doc.getText('content').insert(0, diskContent);
  room.durable = restored && restoredEpoch ? true : persistRoomState(room);

  let observedText = doc.getText('content').toString();
  doc.on('update', (update, origin) => {
    if (room.destroyed) return;
    room.durable = false;
    const currentText = doc.getText('content').toString();
    const previousText = observedText;
    observedText = currentText;
    if (origin && previousText !== currentText) {
      recordManualReviewChange(projectId, file, previousText, currentText);
    }
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MSG_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    const buf = encoding.toUint8Array(encoder);
    for (const [conn, state] of room.conns) {
      if (conn !== origin && refreshConnection(conn, room, state) && state.epochReady) send(conn, buf);
    }
    if (origin) { // 仅客户端来源的变更需要落盘
      room.dirty = true;
      scheduleSave(room);
    }
  });

  awareness.on('update', ({ added, updated, removed }, origin) => {
    const changed = added.concat(updated).concat(removed);
    if (!changed.length) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MSG_AWARENESS);
    encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(awareness, changed));
    const buf = encoding.toUint8Array(encoder);
    // 必须广播给所有连接、包括 origin 自己:y-websocket 客户端有 30s 看门狗,
    // 30s 收不到任何服务端消息就主动断线重连(重连会销毁本地文档,选区/光标随之丢失)。
    // 独占房间且无文档变更时,自己的 awareness 心跳(15s 一次)回声是唯一消息源;
    // 客户端按逻辑时钟去重,回声是 no-op。参考 y-websocket 官方服务端即此行为。
    for (const [conn, state] of room.conns) {
      if (refreshConnection(conn, room, state) && state.epochReady) send(conn, buf);
    }
  });

  rooms.set(key, room);
  return room;
}

/** awareness update 帧格式：len, [clientID, clock, stateJson]* —— 手工解码以追踪每连接控制的 clientID */
function decodeAwarenessClientIds(update) {
  const ids = [];
  try {
    const decoder = decoding.createDecoder(update);
    const len = decoding.readVarUint(decoder);
    for (let i = 0; i < len; i++) {
      const clientID = decoding.readVarUint(decoder);
      decoding.readVarUint(decoder); // clock
      decoding.readVarString(decoder); // state
      ids.push(clientID);
    }
  } catch {}
  return ids;
}

function setupConn(ws, room, { readOnly, userId, publicId, expiresAt, epochProtocol = false }) {
  const connState = { readOnly, userId, publicId, expiresAt, epochReady: !epochProtocol, pendingCheckpoint: null, savedCheckpoint: -1, controlledIds: new Set() };
  room.conns.set(ws, connState);
  const sendRoomState = () => {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MSG_ROOM_STATE);
    encoding.writeVarString(encoder, JSON.stringify({ version: 1, epoch: room.epoch }));
    send(ws, encoding.toUint8Array(encoder));
  };
  // A reconnecting client must acknowledge the persisted document epoch before
  // either side exchanges Yjs state. Never merge stale items into a new seed.
  const beginSync = () => {
    {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MSG_SYNC);
      syncProtocol.writeSyncStep1(encoder, room.doc);
      send(ws, encoding.toUint8Array(encoder));
    }
    {
      const states = room.awareness.getStates();
      if (states.size > 0) {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MSG_AWARENESS);
        encoding.writeVarUint8Array(
          encoder,
          awarenessProtocol.encodeAwarenessUpdate(room.awareness, Array.from(states.keys()))
        );
        send(ws, encoding.toUint8Array(encoder));
      }
    }
  };
  if (epochProtocol) sendRoomState();
  else beginSync();

  ws.on('message', (data) => {
    if (shutdownRequested || room.destroyed) return;
    if (!refreshConnection(ws, room, connState)) return;
    const buf = data instanceof Buffer ? data : Buffer.from(data);
    if (buf.length > MAX_PAYLOAD) {
      ws.close(4409, '消息过大');
      return;
    }
    let decoder;
    let messageType;
    try {
      decoder = decoding.createDecoder(buf);
      messageType = decoding.readVarUint(decoder);
    } catch { return; }

    if (messageType === MSG_ROOM_STATE && epochProtocol) {
      try {
        const acknowledgement = JSON.parse(decoding.readVarString(decoder));
        if (acknowledgement?.version !== 1 || acknowledgement.epoch !== room.epoch) return;
        if (Object.prototype.hasOwnProperty.call(acknowledgement, 'checkpoint')) {
          if (!connState.epochReady || connState.readOnly || !Number.isSafeInteger(acknowledgement.checkpoint) || acknowledgement.checkpoint < 0) return;
          connState.pendingCheckpoint = Math.max(connState.pendingCheckpoint ?? -1, acknowledgement.checkpoint);
          // A compile can request immediate persistence on the same socket as
          // its edits, before its separate HTTP request reaches the server.
          if (acknowledgement.flush === true && acknowledgement.checkpoint > connState.savedCheckpoint && room.dirty) {
            saveRoom(room);
          }
          acknowledgeSavedCheckpoints(room);
        } else if (!connState.epochReady) { connState.epochReady = true; beginSync(); }
      } catch { /* An invalid handshake never permits document updates. */ }
      return;
    }
    if (!connState.epochReady) return;

    if (messageType === MSG_SYNC) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MSG_SYNC);
      try {
        const syncType = decoding.readVarUint(decoder);
        if (syncType === syncProtocol.messageYjsSyncStep1) {
          syncProtocol.readSyncStep1(decoder, encoder, room.doc);
        } else if (syncType === syncProtocol.messageYjsSyncStep2 || syncType === syncProtocol.messageYjsUpdate) {
          if (connState.readOnly) {
            // 只读连接：拒绝应用，回发服务端当前状态纠正客户端
            syncProtocol.writeSyncStep2(encoder, room.doc);
          } else {
            syncProtocol.readSyncStep2(decoder, room.doc, ws);
          }
        }
      } catch (err) {
        console.error(`[collab] sync 消息处理失败 ${room.key}:`, err.message);
      }
      if (encoding.length(encoder) > 1) send(ws, encoding.toUint8Array(encoder));
    } else if (messageType === MSG_AWARENESS) {
      try {
        const update = decoding.readVarUint8Array(decoder);
        for (const id of decodeAwarenessClientIds(update)) connState.controlledIds.add(id);
        awarenessProtocol.applyAwarenessUpdate(room.awareness, update, ws);
      } catch {}
    }
  });

  ws.on('error', () => {});

  ws.on('close', () => removeConnection(ws, room, connState));
}

/**
 * 挂到 http server 的 /collab 路径。其他 upgrade 请求（vite hmr 等）直接销毁。
 * query: project=<id>&file=<path>&token=<jwt>
 * viewer/归档/回收站项目 → 只读（可收 sync，update 被拒绝并回发服务端状态）。
 */
export function setupCollab(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });

  server.on('upgrade', (req, socket, head) => {
    if (shutdownRequested) { socket.destroy(); return; }
    let url;
    try { url = new URL(req.url, 'http://127.0.0.1'); } catch { socket.destroy(); return; }
    if (!url.pathname.startsWith('/collab')) { socket.destroy(); return; }

    wss.handleUpgrade(req, socket, head, (ws) => {
      const reject = (msg) => { try { ws.close(CLOSE_FORBIDDEN, msg); } catch {} };

      const token = url.searchParams.get('token') || '';
      const payload = token ? verifyToken(token) : null;
      if (!payload) return reject('未登录或登录已过期');
      const user = getDb().prepare('SELECT * FROM users WHERE id = ?').get(payload.uid);
      if (!user || user.status !== 'active') return reject('账号不可用');

      const projectId = String(url.searchParams.get('project') || '');
      let file = String(url.searchParams.get('file') || '');
      if (!projectId || !file) return reject('缺少 project 或 file 参数');
      const { project, access } = getProjectAccess(user, projectId);
      if (!project || !access) return reject('无权访问该项目');

      let absPath;
      try {
        absPath = safeJoin(projectDir(project.id), file);
        file = path.relative(projectDir(project.id), absPath).split(path.sep).join('/');
      } catch {
        return reject('非法文件路径');
      }

      if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
        try { ws.close(4404, 'File moved or deleted'); } catch {}
        return;
      }
      const readOnly = access === 'viewer' || !!project.archived || !!project.deleted;
      let room;
      try {
        room = getOrCreateRoom(project.id, file, absPath);
      } catch (err) {
        console.error('[collab] 房间创建失败:', err.message);
        return reject('协同房间初始化失败');
      }
      setupConn(ws, room, { readOnly, userId: user.id, publicId: project.public_id, expiresAt: payload.exp * 1000,
        epochProtocol: url.searchParams.get('epochProtocol') === '1' });
    });
  });

  // 服务关闭时销毁全部房间：flush 落盘并释放 awareness 的定时器，避免进程悬挂
  server.on('close', () => {
    for (const room of [...rooms.values()]) destroyRoom(room);
    wss.close();
  });

  return wss;
}
