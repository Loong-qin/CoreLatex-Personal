import fs from 'node:fs';
import { diffLines } from 'diff';
import { getDb } from '../../db.js';
import { projectDir } from '../../config.js';
import { safeJoin, HttpError } from '../../util.js';
import { transportManualChanges, reconstructLegacyReviewBase } from './reviewProvenance.js';

export function pendingTextReviews(projectId, filePath) {
  return getDb().prepare(`SELECT cf.id,cf.changeset_id,cf.before_content,cf.after_content FROM changeset_files cf
    JOIN changesets c ON c.id = cf.changeset_id
    WHERE c.project_id = ? AND cf.file_path = ? AND cf.status = 'pending' AND cf.applied = 1 AND cf.content_encoding = 'utf8'
    ORDER BY c.id, cf.id`).all(projectId, filePath);
}
export function reviewRow(projectId, filePath) {
  return getDb().prepare('SELECT * FROM review_bases WHERE project_id = ? AND file_path = ?').get(projectId, filePath);
}
export function readReviewCurrent(projectId, filePath) {
  try { return fs.readFileSync(safeJoin(projectDir(projectId), filePath), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export function writeReviewState(projectId, filePath, base, head) {
  const db = getDb();
  return db.transaction(() => {
    const old = reviewRow(projectId, filePath);
    if (old && old.base_content === base && old.head_content === head) return old;
    const { value: revision } = db.prepare(`UPDATE review_revision_clock
      SET value = value + 1 WHERE singleton = 1 RETURNING value`).get();
    if (!Number.isSafeInteger(revision)) throw new Error('Review revision clock exhausted');
    db.prepare(`INSERT INTO review_bases(project_id,file_path,base_content,head_content,revision)
      VALUES(?,?,?,?,?) ON CONFLICT(project_id,file_path) DO UPDATE SET
      base_content = excluded.base_content, head_content = excluded.head_content,
      revision = excluded.revision, updated_at = datetime('now')`).run(projectId, filePath, base, head, revision);
    return reviewRow(projectId, filePath);
  }).immediate();
}
function removeReviewState(projectId, filePath) {
  getDb().prepare('DELETE FROM review_bases WHERE project_id = ? AND file_path = ?').run(projectId, filePath);
}
function refreshParent(changesetId) {
  const rows = getDb().prepare('SELECT status,applied FROM changeset_files WHERE changeset_id = ?').all(changesetId);
  const pending = rows.filter((r) => r.status === 'pending');
  const status = rows.length && !pending.length ? (rows.some((r) => r.status === 'accepted') ? 'accepted' : 'reverted') : 'pending';
  getDb().prepare('UPDATE changesets SET status = ?, applied = ? WHERE id = ?').run(status, pending.every((r) => r.applied) ? 1 : 0, changesetId);
}
export function settleAppliedReviews(projectId, filePath, status = 'accepted') {
  const rows = pendingTextReviews(projectId, filePath);
  getDb().transaction(() => {
    for (const row of rows) getDb().prepare('UPDATE changeset_files SET status = ? WHERE id = ?').run(status, row.id);
    for (const id of new Set(rows.map((r) => r.changeset_id))) refreshParent(id);
    removeReviewState(projectId, filePath);
  })();
}
function sequence(rows) { return rows.map((r) => ({ before: r.before_content ?? '', after: r.after_content ?? '' })); }

// The shadow contains all human text and accepted AI text. Only the remaining
// AI-owned delta between shadow and head belongs in the review interface.
export function synchronizeReviewState(projectId, filePath, current = readReviewCurrent(projectId, filePath)) {
  const rows = pendingTextReviews(projectId, filePath);
  let state = reviewRow(projectId, filePath);
  if (current === null) {
    if (rows.length) settleAppliedReviews(projectId, filePath, 'reverted');
    else if (state) removeReviewState(projectId, filePath);
    return { base: '', current: '', revision: Number(state?.revision || 0), pending: false, deleted: true };
  }
  if (!rows.length) {
    if (state) removeReviewState(projectId, filePath);
    return { base: current, current, revision: Number(state?.revision || 0), pending: false };
  }
  let base;
  if (!state || state.head_content === null) {
    // Legacy rows never recorded provenance. Rebuild only provable, still
    // unreviewed AI regions; never mutate document bytes during this repair.
    base = reconstructLegacyReviewBase(state?.base_content ?? rows[0].before_content ?? '', current, sequence(rows));
  } else {
    base = transportManualChanges(state.base_content ?? '', state.head_content, current);
  }
  state = writeReviewState(projectId, filePath, base, current);
  const snapshot = { base, current, revision: state.revision, pending: base !== current };
  if (!snapshot.pending) settleAppliedReviews(projectId, filePath);
  return snapshot;
}

export function recordManualReviewChange(projectId, filePath, previous, current) {
  if (previous === current || !pendingTextReviews(projectId, filePath).length) return;
  const snapshot = synchronizeReviewState(projectId, filePath, previous);
  if (!snapshot.pending) return;
  const base = transportManualChanges(snapshot.base, previous, current);
  writeReviewState(projectId, filePath, base, current);
  if (base === current) settleAppliedReviews(projectId, filePath);
}

// Call before an AI disk transaction to absorb any intervening manual edits,
// then after marking the new change applied to advance head without accepting AI.
export function prepareReviewForAi(projectId, filePath, before) {
  synchronizeReviewState(projectId, filePath, before);
}
export function recordAiReviewChange(projectId, filePath, before, after) {
  const state = reviewRow(projectId, filePath);
  writeReviewState(projectId, filePath, state?.base_content ?? before ?? '', after ?? '');
}
export function rebuildRemainingReview(projectId, filePath) {
  const rows = pendingTextReviews(projectId, filePath);
  if (!rows.length) { removeReviewState(projectId, filePath); return; }
  const current = readReviewCurrent(projectId, filePath);
  if (current === null) { settleAppliedReviews(projectId, filePath, 'reverted'); return; }
  const state = reviewRow(projectId, filePath);
  const base = reconstructLegacyReviewBase(state?.base_content ?? rows[0].before_content ?? '', current, sequence(rows));
  writeReviewState(projectId, filePath, base, current);
  if (base === current) settleAppliedReviews(projectId, filePath);
}

export function assertReviewSnapshot(snapshot, revision, current) {
  if (!Number.isSafeInteger(revision) || typeof current !== 'string' || revision !== snapshot.revision || current !== snapshot.current) {
    throw new HttpError(409, '审阅内容已变化，请刷新后重试');
  }
}
export function reviewHunks(base, current) {
  const hunks = [];
  let oldOffset = 0, newOffset = 0, oldLine = 1, newLine = 1, hunk = null;
  const close = () => {
    if (!hunk) return;
    hunks.push({ ...hunk, baseTo: oldLine - 1, docTo: newLine - 1, baseEnd: oldOffset, docEnd: newOffset });
    hunk = null;
  };
  for (const part of diffLines(base, current)) {
    if (!part.added && !part.removed) {
      close(); oldOffset += part.value.length; newOffset += part.value.length;
      oldLine += part.count; newLine += part.count;
      continue;
    }
    if (!hunk) hunk = { baseFrom: oldLine, docFrom: newLine, baseStart: oldOffset, docStart: newOffset };
    if (part.removed) { oldOffset += part.value.length; oldLine += part.count; }
    if (part.added) { newOffset += part.value.length; newLine += part.count; }
  }
  close(); return hunks;
}
export function planReviewHunk(snapshot, request) {
  assertReviewSnapshot(snapshot, request.revision, request.current);
  if (!snapshot.pending) throw new HttpError(409, '该文件已无待审AI修改');
  if (!['accept', 'revert'].includes(request.action)) throw new HttpError(400, '不支持的审阅操作');
  const keys = ['baseFrom', 'baseTo', 'docFrom', 'docTo'];
  if (keys.some((key) => !Number.isSafeInteger(request[key]))) throw new HttpError(400, '非法修改块坐标');
  const hunk = reviewHunks(snapshot.base, snapshot.current).find((h) => keys.every((key) => h[key] === request[key]));
  if (!hunk) throw new HttpError(409, '修改块已变化，请刷新后重试');
  return request.action === 'accept'
    ? { base: snapshot.base.slice(0, hunk.baseStart) + snapshot.current.slice(hunk.docStart, hunk.docEnd) + snapshot.base.slice(hunk.baseEnd), current: snapshot.current }
    : { base: snapshot.base, current: snapshot.current.slice(0, hunk.docStart) + snapshot.base.slice(hunk.baseStart, hunk.baseEnd) + snapshot.current.slice(hunk.docEnd) };
}
