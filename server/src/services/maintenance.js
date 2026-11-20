import { createHash, randomUUID } from 'node:crypto';
import { HttpError } from '../util.js';
import { assertRuntimeReady } from './runtimeEnvironment.js';

const PROCESS_ID = randomUUID();
const admissionFrames = new WeakMap();
let shuttingDown = false;
const DEFAULT_TTL_MS = 15 * 60 * 1000;
const MIN_TTL_MS = 5000;
const MAX_TTL_MS = 60 * 60 * 1000;
const ACTIVE_RUNS = "('running','waiting_for_user','cancelling')";

// This module deliberately never opens or migrates a database. The host CLI
// uses its own connection so inspecting maintenance cannot interrupt live runs.
function ownerHash(token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw new HttpError(400, '维护凭据无效');
  return createHash('sha256').update(token).digest('hex');
}
function ttl(value = DEFAULT_TTL_MS) {
  if (!Number.isSafeInteger(value) || value < MIN_TTL_MS || value > MAX_TTL_MS) throw new HttpError(400, '维护期限须为5秒至1小时');
  return value;
}
function gateRow(db) { return db.prepare('SELECT * FROM maintenance_gate WHERE id=1').get(); }
function currentWork(db) {
  const runs = db.prepare(`SELECT id,project_id,chat_id,state FROM agent_runs WHERE state IN ${ACTIVE_RUNS} ORDER BY created_at,id`).all();
  const compiles = db.prepare('SELECT id,project_id,user_id,kind,state,created_at FROM compile_leases ORDER BY created_at,id').all();
  return { runs, compiles };
}
function gateShape(row, now = Date.now()) {
  return { active: !!row && row.expires_at > now, expiresAt: row?.expires_at ?? null };
}

export function maintenanceStatus(db) {
  return db.transaction(() => ({ ...gateShape(gateRow(db)), ...currentWork(db) }))();
}

export function beginShutdown() { shuttingDown = true; }

export function assertWorkAdmission(db) {
  if (shuttingDown) throw new HttpError(503, '服务正在重启，尚未启动本次任务；请稍后重试。');
  if (gateShape(gateRow(db)).active) throw new HttpError(503, '服务正在维护发布，尚未启动本次任务；请稍后重试。');
}

export function assertMaintenanceOwner(db, ownerToken) {
  const hash = ownerHash(ownerToken);
  const row = gateRow(db);
  if (!row || row.owner_hash !== hash || row.expires_at <= Date.now()) {
    throw new HttpError(409, 'Maintenance ownership does not match or the gate has expired.');
  }
}

/** Gate acquisition and every work admission contend for the same SQLite
 * writer lock, including when the operator uses a separate host process. */
export function withWorkAdmission(db, fn) {
  const parent = admissionFrames.get(db);
  const frame = parent || { committed: [] };
  const checkpoint = frame.committed.length;
  if (!parent) admissionFrames.set(db, frame);
  let result;
  try {
    result = db.transaction(() => {
      assertWorkAdmission(db);
      const value = fn();
      if (value && typeof value.then === 'function') throw new Error('Work admission must be synchronous');
      return value;
    }).immediate();
  } catch (error) {
    frame.committed.length = checkpoint;
    throw error;
  } finally {
    if (!parent) admissionFrames.delete(db);
  }
  if (!parent) for (const committed of frame.committed) committed();
  return result;
}

/** In-memory schedulers must not register a run rolled back by its outer
 * message/attachment admission transaction. Callbacks here only mutate memory. */
export function afterWorkAdmissionCommit(db, fn) {
  const frame = admissionFrames.get(db);
  if (frame) frame.committed.push(fn);
  else fn();
}

export function acquireMaintenance(db, { ownerToken, ttlMs = DEFAULT_TTL_MS } = {}) {
  const hash = ownerHash(ownerToken), duration = ttl(ttlMs);
  return db.transaction(() => {
    assertRuntimeReady();
    const now = Date.now(), existing = gateRow(db);
    if (existing?.expires_at > now && existing.owner_hash !== hash) throw new HttpError(409, '维护门禁已由另一发布持有');
    const work = currentWork(db);
    if (work.runs.length || work.compiles.length) {
      const error = new HttpError(409, '仍有智能体任务或编译排队/执行，未进入维护；现有任务继续运行。');
      error.work = work;
      throw error;
    }
    db.prepare(`INSERT INTO maintenance_gate(id,owner_hash,created_at,expires_at) VALUES(1,?,?,?)
      ON CONFLICT(id) DO UPDATE SET owner_hash=excluded.owner_hash,created_at=excluded.created_at,expires_at=excluded.expires_at`)
      .run(hash, now, now + duration);
    return { ...gateShape(gateRow(db), now), ...work };
  }).immediate();
}

export function renewMaintenance(db, { ownerToken, ttlMs = DEFAULT_TTL_MS } = {}) {
  const hash = ownerHash(ownerToken), duration = ttl(ttlMs);
  return db.transaction(() => {
    const now = Date.now(), row = gateRow(db);
    if (!row || row.owner_hash !== hash || row.expires_at <= now) throw new HttpError(409, '维护凭据不匹配或门禁已到期，不能续期');
    db.prepare('UPDATE maintenance_gate SET expires_at=? WHERE id=1 AND owner_hash=?').run(now + duration, hash);
    return gateShape(gateRow(db), now);
  }).immediate();
}

export function releaseMaintenance(db, { ownerToken } = {}) {
  const hash = ownerHash(ownerToken);
  return db.transaction(() => {
    const row = gateRow(db);
    if (!row) return { released: false, active: false };
    if (row.owner_hash !== hash) throw new HttpError(409, '维护凭据不匹配，不能解除另一发布的门禁');
    db.prepare('DELETE FROM maintenance_gate WHERE id=1 AND owner_hash=?').run(hash);
    return { released: true, active: false };
  }).immediate();
}

/** Only the real application startup calls this, never an inspecting CLI.
 * The application has one server process per database. A new process cannot
 * resume the previous process's in-memory compile queues; the deployment gate
 * remains owned by its original operator across this cleanup and restart. */
export function initializeMaintenanceProcess(db) {
  db.transaction(() => db.prepare('DELETE FROM compile_leases WHERE process_id<>?').run(PROCESS_ID)).immediate();
}

export function createCompileLease(db, { projectId, userId, kind }) {
  if (!['compile', 'preview'].includes(kind)) throw new Error('Invalid compile lease kind');
  return withWorkAdmission(db, () => {
    assertRuntimeReady({ allowIndependentInstall: true });
    const id = randomUUID();
    db.prepare("INSERT INTO compile_leases(id,process_id,project_id,user_id,kind,state,created_at) VALUES(?,?,?,?,?,'queued',?)")
      .run(id, PROCESS_ID, projectId, userId, kind, Date.now());
    return id;
  });
}

export function startCompileLease(db, id) {
  const result = db.prepare("UPDATE compile_leases SET state='running' WHERE id=? AND process_id=?").run(id, PROCESS_ID);
  if (result.changes !== 1) throw new Error('Compile lease disappeared before execution');
}

export function finishCompileLease(db, id) {
  db.prepare('DELETE FROM compile_leases WHERE id=? AND process_id=?').run(id, PROCESS_ID);
}
