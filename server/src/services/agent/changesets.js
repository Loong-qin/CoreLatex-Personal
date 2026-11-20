import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { diffLines, createTwoFilesPatch } from 'diff';
import { getDb } from '../../db.js';
import { projectDir } from '../../config.js';
import { touchProject } from '../../access.js';
import { flushProjectRooms, reloadProjectRooms, replaceProjectRoomContent } from '../../collab.js';
import { safeJoin, HttpError } from '../../util.js';
import { synchronizeReviewState, prepareReviewForAi, recordAiReviewChange, rebuildRemainingReview, writeReviewState, readReviewCurrent, assertReviewSnapshot, planReviewHunk, pendingTextReviews, settleAppliedReviews } from './reviewState.js';

/**
 * 变更集（changeset）：agent 写文件修改的 before/after 记录。
 * status 语义：pending = 待审查；accepted = 用户保留/应用；reverted = 用户撤销/放弃。
 * changeset_files.applied 记录该文件是否实际写盘；pending 文件据此决定应用还是仅确认。
 * changesets.applied 为聚合值：待审文件均已写盘，或审阅流程已全部了结。
 */

function statDiff(before, after) {
  let adds = 0;
  let dels = 0;
  for (const part of diffLines(before ?? '', after ?? '')) {
    if (part.added) adds += part.count || 0;
    else if (part.removed) dels += part.count || 0;
  }
  return { adds, dels };
}

function loadChangeset(db, changesetId) {
  const cs = db.prepare('SELECT * FROM changesets WHERE id = ?').get(changesetId);
  if (!cs) throw new HttpError(404, '变更集不存在');
  return cs;
}

function refreshStatus(db, changesetId) {
  const rows = db.prepare('SELECT status, applied FROM changeset_files WHERE changeset_id = ?').all(changesetId);
  const pending = rows.filter((r) => r.status === 'pending');
  const status = rows.length && !pending.length
    ? (rows.some((r) => r.status === 'accepted') ? 'accepted' : 'reverted')
    : 'pending';
  // 已了结变更集保持 applied=true；待审时必须逐文件判断是否实际写盘。
  const applied = pending.every((r) => r.applied) ? 1 : 0;
  db.prepare('UPDATE changesets SET status = ?, applied = ? WHERE id = ?').run(status, applied, changesetId);
}

function currentContent(dir, filePath, encoding = 'utf8') {
  try {
    return fs.readFileSync(safeJoin(dir, filePath)).toString(encoding);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err; // 不把读取错误当成“不存在”再覆盖。
  }
}

function oldestAppliedPending(db, projectId, filePath) {
  return db.prepare(`SELECT cf.id, cf.before_content FROM changeset_files cf
    JOIN changesets c ON c.id = cf.changeset_id
    WHERE c.project_id = ? AND cf.file_path = ? AND cf.status = 'pending' AND cf.applied = 1 AND cf.content_encoding = 'utf8'
    ORDER BY c.id ASC, cf.id ASC LIMIT 1`).get(projectId, filePath);
}

function refreshReviewBase(db, projectId, filePath, previousFirst) {
  rebuildRemainingReview(projectId, filePath);
}

function conflictError(paths) {
  return new HttpError(409, `文件在变更生成后已被修改，请先处理冲突：${paths.join(', ')}`);
}

function isBinary(row) { return row.content_encoding === 'base64'; }
function diskContent(dir, row) { return currentContent(dir, row.file_path, row.content_encoding || 'utf8'); }

/** Prepare all bytes first, then journal same-filesystem renames inside one DB transaction.
 * A write or DB failure restores every original before publishing collaborative updates.
 * If the filesystem also refuses rollback, keep the journal for manual recovery. */
function commitFileBatch(db, cs, writes, commit) {
  const dir = projectDir(cs.project_id);
  let journal;
  const prepared = [];
  let keepJournal = false;
  try {
    if (writes.length) {
      fs.mkdirSync(path.join(dir, '.build'), { recursive: true });
      journal = fs.mkdtempSync(path.join(dir, '.build', '.changeset-'));
      for (const [index, write] of writes.entries()) {
        const abs = safeJoin(dir, write.row.file_path);
        const exists = fs.existsSync(abs);
        const item = { ...write, abs, backup: path.join(journal, index + '.before'), next: path.join(journal, index + '.after'), existed: exists, backed: false, installed: false };
        if (write.content !== null) {
          const bytes = Buffer.from(write.content ?? '', write.row.content_encoding || 'utf8');
          fs.writeFileSync(item.next, bytes, exists ? { mode: fs.statSync(abs).mode } : {});
        }
        prepared.push(item);
      }
    }
    db.transaction(() => {
      for (const item of prepared) {
        fs.mkdirSync(path.dirname(item.abs), { recursive: true });
        if (item.existed) { fs.renameSync(item.abs, item.backup); item.backed = true; }
        if (item.content !== null) { fs.renameSync(item.next, item.abs); item.installed = true; }
      }
      commit();
      if (writes.length) touchProject(cs.project_id);
    })();
  } catch (error) {
    const failures = [];
    for (const item of [...prepared].reverse()) {
      try {
        if (item.installed) fs.rmSync(item.abs, { force: true });
        if (item.backed) fs.renameSync(item.backup, item.abs);
      } catch (rollbackError) { failures.push(rollbackError); }
    }
    if (failures.length) {
      keepJournal = true;
      throw new AggregateError([error, ...failures], '文件回滚失败，请保留并恢复事务目录：' + journal);
    }
    throw error;
  } finally {
    if (journal && !keepJournal) {
      try { fs.rmSync(journal, { recursive: true, force: true }); }
      catch (error) { console.warn('[changeset] 无法清理事务临时目录 ' + journal + ': ' + error.message); }
    }
  }
  // Disk and DB now agree. Never broadcast partial writes.
  for (const { row, content } of writes) {
    try {
      if (content === null || isBinary(row)) reloadProjectRooms(cs.project_id, [row.file_path]);
      else replaceProjectRoomContent(cs.project_id, row.file_path, content);
    } catch {
      reloadProjectRooms(cs.project_id, [row.file_path]);
    }
  }
}

/** Only byte-level net changes are reviewable. File absence differs from an
 * existing empty file, so null -> '' remains a meaningful file creation. */
export function filterMeaningfulChanges(files = []) {
  return (Array.isArray(files) ? files : []).filter((file) => {
    if (!file || typeof file.path !== 'string' || !file.path) return false;
    const before = file.before ?? null;
    const after = file.after ?? null;
    if (before === null || after === null) return before !== after;
    const encoding = file.encoding === 'base64' ? 'base64' : 'utf8';
    return !Buffer.from(before, encoding).equals(Buffer.from(after, encoding));
  });
}

export function createChangeset({ projectId, chatId, files }) {
  files = filterMeaningfulChanges(files);
  if (!files.length) return { id: null, files: [] };
  const db = getDb();
  return db.transaction(() => {
    const info = db.prepare("INSERT INTO changesets (project_id, chat_id, status, applied) VALUES (?,?,'pending',0)")
      .run(projectId, chatId ?? null);
    const id = Number(info.lastInsertRowid);
    const insert = db.prepare('INSERT INTO changeset_files (changeset_id,file_path,before_content,after_content,content_encoding,adds,dels,status) VALUES (?,?,?,?,?,?,?,?)');
    const out = [];
    for (const file of files) {
      const encoding = file.encoding === 'base64' ? 'base64' : 'utf8';
      const { adds, dels } = encoding === 'base64' ? { adds: 0, dels: 0 } : statDiff(file.before, file.after);
      insert.run(id, file.path, file.before, file.after, encoding, adds, dels, 'pending');
      out.push({ filePath: file.path, adds, dels, status: 'pending', binary: encoding === 'base64' });
    }
    return { id, files: out };
  })();
}

/** Exact review identity, not a content-deduplication key. It changes on any
 * file decision, application, or proposal revision. */
export function pendingChangesetState(changesetId) {
  const db = getDb();
  const cs = loadChangeset(db, changesetId);
  const rows = db.prepare('SELECT * FROM changeset_files WHERE changeset_id = ? ORDER BY id').all(changesetId);
  return { cs, rows, fingerprint: createHash('sha256').update(JSON.stringify([cs, rows])).digest('hex') };
}

/** Continue one identified draft. Reviewed/applied history is never rewritten. */
export function revisePendingChangeset({ id, projectId, chatId, files, fingerprint }) {
  const db = getDb();
  return db.transaction(() => {
    const state = pendingChangesetState(id);
    if (state.cs.project_id !== projectId || state.cs.chat_id !== chatId ||
        state.fingerprint !== fingerprint || state.cs.status !== 'pending' || state.cs.applied ||
        state.rows.some(row => row.status !== 'pending' || row.applied)) {
      throw new HttpError(409, '草稿的审核状态已变化，不能覆盖已应用、保留或撤销的提案；请先完成当前审核再继续。');
    }
    files = filterMeaningfulChanges(files);
    const byPath = new Map(state.rows.map(row => [row.file_path, row]));
    const kept = new Set(files.map(file => file.path));
    for (const row of state.rows) if (!kept.has(row.file_path))
      db.prepare('DELETE FROM changeset_files WHERE id = ?').run(row.id);
    for (const file of files) {
      const encoding = file.encoding === 'base64' ? 'base64' : 'utf8';
      const { adds, dels } = encoding === 'base64' ? { adds: 0, dels: 0 } : statDiff(file.before, file.after);
      const row = byPath.get(file.path);
      if (row) db.prepare('UPDATE changeset_files SET before_content=?,after_content=?,content_encoding=?,adds=?,dels=? WHERE id=?')
        .run(file.before, file.after, encoding, adds, dels, row.id);
      else db.prepare("INSERT INTO changeset_files(changeset_id,file_path,before_content,after_content,content_encoding,adds,dels,status,applied) VALUES(?,?,?,?,?,?,?,'pending',0)")
        .run(id, file.path, file.before, file.after, encoding, adds, dels);
    }
    db.prepare('UPDATE changesets SET proposal_revision=proposal_revision+1 WHERE id=?').run(id);
    if (!files.length) db.prepare("UPDATE changesets SET status='reverted',applied=1 WHERE id=?").run(id);
    return { id };
  })();
}

/** 自动应用前先冲刷协作；只写入仍与 before 一致的文件，冲突提案保持未应用。
 * @returns {{applied: number, skipped: string[]}} */
export function applyChangeset(changesetId, { allOrNothing = false } = {}) {
  const db = getDb();
  const cs = loadChangeset(db, changesetId);
  flushProjectRooms(cs.project_id);
  const dir = projectDir(cs.project_id);
  const rows = db.prepare("SELECT * FROM changeset_files WHERE changeset_id = ? AND status = 'pending' AND applied = 0")
    .all(changesetId);
  const skipped = [];
  const ready = rows.filter((r) => {
    if (diskContent(dir, r) !== (r.before_content ?? null)) {
      skipped.push(r.file_path);
      return false;
    }
    return true;
  });
  // Automatic agent delivery must not apply a subset and then claim that the
  // entire draft was delivered when any edited file conflicts with the user.
  if (allOrNothing && skipped.length) return { applied: 0, skipped };
  for (const row of ready) if (!isBinary(row)) prepareReviewForAi(cs.project_id, row.file_path, row.before_content ?? null);
  commitFileBatch(db, cs, ready.map((row) => ({ row, content: row.after_content ?? '' })), () => {
    for (const row of ready) {
      db.prepare('UPDATE changeset_files SET applied = 1 WHERE id = ?').run(row.id);
      if (!isBinary(row)) {
        recordAiReviewChange(cs.project_id, row.file_path, row.before_content, row.after_content);
      }
    }
    refreshStatus(db, changesetId);
  });
  if (skipped.length) console.log(`[changeset] #${changesetId} 运行期间被人工修改,转人工审查:${skipped.join(', ')}`);
  return { applied: ready.length, skipped };
}

// ---------- 审阅基线（滚动基线模型） ----------
// 每个 (项目, 文件) 维护一份「上次确认时的内容」快照；审阅 = diff(基线, 当前文档)。
// agent 新一轮修改不产生新条目，自然并入同一份滚动 diff；
// 用户逐块「保存」即把基线对应区域更新为文档内容；全部处理完毕后删除基线行。

export function ensureReviewBase(projectId, filePath, fallbackContent = '') {
  const db = getDb();
  const row = db
    .prepare('SELECT base_content FROM review_bases WHERE project_id = ? AND file_path = ?')
    .get(projectId, filePath);
  if (row) return row.base_content ?? '';
  db.prepare('INSERT INTO review_bases (project_id, file_path, base_content) VALUES (?,?,?)')
    .run(projectId, filePath, fallbackContent);
  return fallbackContent;
}

export function getReviewBase(projectId, filePath) {
  const db = getDb();
  const row = db
    .prepare('SELECT base_content FROM review_bases WHERE project_id = ? AND file_path = ?')
    .get(projectId, filePath);
  return row ? (row.base_content ?? '') : null;
}

export function setReviewBase(projectId, filePath, content) {
  writeReviewState(projectId, filePath, content, readReviewCurrent(projectId, filePath) ?? '');
}

/** Read one synchronized snapshot; callers must not fetch base and current separately. */
export function getReviewSnapshot(projectId, filePath) {
  flushProjectRooms(projectId);
  return synchronizeReviewState(projectId, filePath);
}

export function updateReviewBase(projectId, filePath, { content, revision, current }) {
  const snapshot = getReviewSnapshot(projectId, filePath);
  assertReviewSnapshot(snapshot, revision, current);
  if (typeof content !== 'string') throw new HttpError(400, '缺少 content 参数');
  if (!snapshot.pending) throw new HttpError(409, '该文件已无待审AI修改');
  writeReviewState(projectId, filePath, content, snapshot.current);
  return synchronizeReviewState(projectId, filePath, snapshot.current);
}

export function resolveReviewHunk(projectId, filePath, request) {
  const snapshot = getReviewSnapshot(projectId, filePath);
  const next = planReviewHunk(snapshot, request);
  const db = getDb();
  const writes = next.current === snapshot.current ? [] : [{ row: { file_path: filePath, content_encoding: 'utf8' }, content: next.current }];
  let result;
  commitFileBatch(db, { project_id: projectId }, writes, () => {
    writeReviewState(projectId, filePath, next.base, next.current);
    result = synchronizeReviewState(projectId, filePath, next.current);
  });
  // Return the authoritative pending list from this same synchronous decision.
  // A successful hunk review must not require a second request to clear its UI.
  return { ...result, changesets: listChangesets(projectId, 'pending') };
}

/** Resolve the current, provenance-aware text delta once per file. Every
 * snapshot is checked before any file or review decision is committed. */
export function resolveReviewFiles(projectId, { action, files } = {}) {
  if (!['accept', 'revert'].includes(action)) throw new HttpError(400, '不支持的审阅操作');
  if (!Array.isArray(files) || files.length > 500) throw new HttpError(400, '非法审阅文件列表');
  const db = getDb();
  const dir = projectDir(projectId);
  const seen = new Set();
  const inputs = files.map((file) => {
    if (typeof file?.filePath !== 'string' || !file.filePath) throw new HttpError(400, '缺少 filePath 参数');
    const filePath = path.relative(dir, safeJoin(dir, file.filePath)).split(path.sep).join('/');
    if (seen.has(filePath)) throw new HttpError(400, '审阅文件列表包含重复路径');
    seen.add(filePath);
    return { ...file, filePath };
  });
  flushProjectRooms(projectId);
  const plans = inputs.map((input) => {
    const filePath = input.filePath;
    const binary = db.prepare(`SELECT 1 FROM changeset_files cf JOIN changesets c ON c.id = cf.changeset_id
      WHERE c.project_id = ? AND cf.file_path = ? AND cf.status = 'pending' AND cf.applied = 1 AND cf.content_encoding != 'utf8' LIMIT 1`).get(projectId, filePath);
    if (binary) throw new HttpError(400, '二进制文件需使用变更集审阅：' + filePath);
    const snapshot = synchronizeReviewState(projectId, filePath);
    // Already-settled requests are harmless only if the caller still has the
    // exact current bytes. A stale body must never be used to restore content.
    if (snapshot.pending) assertReviewSnapshot(snapshot, input.revision, input.current);
    else if (typeof input.current !== 'string' || input.current !== snapshot.current) throw new HttpError(409, '审阅内容已变化，请刷新后重试');
    const rows = pendingTextReviews(projectId, filePath);
    const removeCreation = action === 'revert' && snapshot.pending && snapshot.base === '' && rows[0]?.before_content === null;
    return { filePath, snapshot, nextCurrent: !snapshot.pending ? (snapshot.deleted ? null : snapshot.current)
      : action === 'revert' ? (removeCreation ? null : snapshot.base) : snapshot.current };
  });
  const writes = plans.filter((plan) => plan.snapshot.pending && plan.nextCurrent !== plan.snapshot.current)
    .map((plan) => ({ row: { file_path: plan.filePath, content_encoding: 'utf8' }, content: plan.nextCurrent }));
  const results = [];
  commitFileBatch(db, { project_id: projectId }, writes, () => {
    for (const plan of plans) {
      if (plan.snapshot.pending) {
        writeReviewState(projectId, plan.filePath, action === 'accept' ? plan.snapshot.current : plan.snapshot.base, plan.nextCurrent ?? '');
        settleAppliedReviews(projectId, plan.filePath, action === 'accept' ? 'accepted' : 'reverted');
      }
      results.push({ filePath: plan.filePath,
        ...synchronizeReviewState(projectId, plan.filePath, plan.nextCurrent), resolved: plan.snapshot.pending });
    }
  });
  return { ok: true, results, changesets: listChangesets(projectId, 'pending') };
}

export function deleteReviewBase(projectId, filePath) {
  getDb().prepare('DELETE FROM review_bases WHERE project_id = ? AND file_path = ?').run(projectId, filePath);
}

/** 基线缺失时优先取最早的已应用待审变更的 before（滚动审阅基线），
 * 否则取磁盘当前内容。绝不能回落到空串——否则审阅会把整个文件标成新增。 */
export function reviewBaseFallback(projectId, filePath) {
  const db = getDb();
  const row = db
    .prepare(`SELECT cf.before_content FROM changeset_files cf
              JOIN changesets c ON c.id = cf.changeset_id
              WHERE c.project_id = ? AND cf.file_path = ? AND cf.status = 'pending' AND cf.applied = 1 AND cf.content_encoding = 'utf8'
              ORDER BY cf.changeset_id ASC LIMIT 1`)
    .get(projectId, filePath);
  if (row) return row.before_content ?? '';
  try {
    return fs.readFileSync(safeJoin(projectDir(projectId), filePath), 'utf8');
  } catch {
    return '';
  }
}

/** 启动只恢复审阅簿记，不重放历史 after，避免覆盖人工编辑或静默确认 AI 改动。 */
export function migratePendingReviews() {
  const db = getDb();
  const projects = db.prepare(`SELECT DISTINCT c.project_id FROM changesets c
    JOIN changeset_files cf ON cf.changeset_id = c.id
    WHERE cf.status = 'pending' AND cf.applied = 1`).all();
  for (const { project_id: projectId } of projects) {
    reconcileMissingOnDisk(projectId);
    const files = db.prepare(`SELECT DISTINCT cf.file_path FROM changeset_files cf
      JOIN changesets c ON c.id = cf.changeset_id
      WHERE c.project_id = ? AND cf.status = 'pending' AND cf.applied = 1`).all(projectId);
    for (const { file_path: filePath } of files) {
      const first = oldestAppliedPending(db, projectId, filePath);
      if (first) ensureReviewBase(projectId, filePath, first.before_content ?? '');
    }
  }
}

function assertProposalRevision(cs, expectedRevision) {
  const actual = cs.proposal_revision;
  // Existing never-revised proposals remain compatible with old clients. Once
  // their identity has been continued, only the version actually shown can be
  // accepted or discarded, including whole-proposal and binary decisions.
  if (expectedRevision === undefined && actual === 0) return;
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision !== actual)
    throw new HttpError(409, '待审提案版本已变化，请重新打开当前差异后再应用或放弃。');
}

/** 已应用文件只确认当前内容；未应用文件必须仍匹配 before 才可写盘。 */
export function acceptChangeset(changesetId, filePath, expectedRevision) {
  const db = getDb();
  const cs = loadChangeset(db, changesetId);
  assertProposalRevision(cs, expectedRevision);
  flushProjectRooms(cs.project_id);
  let rows = db.prepare("SELECT * FROM changeset_files WHERE changeset_id = ? AND status = 'pending'").all(changesetId);
  if (filePath) rows = rows.filter((r) => r.file_path === filePath);
  const dir = projectDir(cs.project_id);
  const unapplied = rows.filter((r) => !r.applied);
  const conflicts = unapplied.filter((r) => {
    const current = diskContent(dir, r);
    return current !== (r.before_content ?? null) && current !== (r.after_content ?? '');
  });
  // 先检查全部选中文件，冲突不能导致同批其他文件被部分应用或确认。
  if (conflicts.length) throw conflictError(conflicts.map((r) => r.file_path));
  for (const file of new Set(rows.filter((r) => !isBinary(r)).map((r) => r.file_path))) synchronizeReviewState(cs.project_id, file);
  const previous = new Map(rows.map((r) => [r.file_path, oldestAppliedPending(db, cs.project_id, r.file_path)]));
  commitFileBatch(db, cs, unapplied.map((row) => ({ row, content: row.after_content ?? '' })), () => {
    assertProposalRevision(loadChangeset(db, changesetId), expectedRevision);
    for (const row of unapplied) db.prepare('UPDATE changeset_files SET applied = 1 WHERE id = ?').run(row.id);
    for (const row of rows) db.prepare("UPDATE changeset_files SET status = 'accepted' WHERE id = ?").run(row.id);
    for (const [file, first] of previous) refreshReviewBase(db, cs.project_id, file, first);
    refreshStatus(db, changesetId);
  });
  return getChangeset(changesetId);
}

/** 撤销只恢复仍匹配 after 的已应用文件；有后续编辑则拒绝，未应用提案仅放弃。 */
export function revertChangeset(changesetId, filePath, expectedRevision) {
  const db = getDb();
  const cs = loadChangeset(db, changesetId);
  assertProposalRevision(cs, expectedRevision);
  flushProjectRooms(cs.project_id);
  const dir = projectDir(cs.project_id);
  let rows = db.prepare("SELECT * FROM changeset_files WHERE changeset_id = ? AND status = 'pending'").all(changesetId);
  if (filePath) rows = rows.filter((r) => r.file_path === filePath);
  const applied = rows.filter((r) => r.applied);
  const conflicts = applied.filter((r) => {
    const current = diskContent(dir, r);
    return current !== (r.after_content ?? '') && current !== (r.before_content ?? null);
  });
  if (conflicts.length) throw conflictError(conflicts.map((r) => r.file_path));
  for (const file of new Set(rows.filter((r) => !isBinary(r)).map((r) => r.file_path))) {
    const snapshot = synchronizeReviewState(cs.project_id, file);
    const earliest = pendingTextReviews(cs.project_id, file)[0];
    if (applied.some((row) => row.file_path === file) && snapshot.pending && earliest && snapshot.base !== (earliest.before_content ?? '')) {
      throw new HttpError(409, '审阅基线已推进，请刷新并按当前文件审阅：' + file);
    }
  }
  const previous = new Map(rows.map((r) => [r.file_path, oldestAppliedPending(db, cs.project_id, r.file_path)]));
  commitFileBatch(db, cs, applied.map((row) => ({ row, content: row.before_content ?? null })), () => {
    assertProposalRevision(loadChangeset(db, changesetId), expectedRevision);
    for (const row of rows) db.prepare("UPDATE changeset_files SET status = 'reverted' WHERE id = ?").run(row.id);
    for (const [file, first] of previous) refreshReviewBase(db, cs.project_id, file, first);
    refreshStatus(db, changesetId);
  });
  return getChangeset(changesetId);
}

export function getChangeset(changesetId) {
  const db = getDb();
  const cs = loadChangeset(db, changesetId);
  const files = db
    .prepare('SELECT file_path, adds, dels, status, applied, content_encoding, before_content, after_content FROM changeset_files WHERE changeset_id = ? ORDER BY id')
    .all(changesetId);
  return {
    id: cs.id,
    proposalRevision: cs.proposal_revision,
    status: cs.status,
    applied: !!cs.applied,
    createdAt: cs.created_at,
    files: files.map((f) => ({ filePath: f.file_path, adds: f.adds, dels: f.dels, status: f.status, applied: !!f.applied, binary: isBinary(f), ...(isBinary(f) ? { beforeBytes: Buffer.byteLength(f.before_content || '', 'base64'), afterBytes: Buffer.byteLength(f.after_content || '', 'base64') } : {}) })),
  };
}

export function listChangesets(projectId, status = 'pending') {
  const db = getDb();
  // 懒对账:pending 列表返回前先与磁盘核对,人工删过的文件就地作废残留条目(自愈历史脏数据)
  if (status === 'pending') reconcileMissingOnDisk(projectId);
  const rows = db
    .prepare('SELECT id FROM changesets WHERE project_id = ? AND status = ? ORDER BY id DESC')
    .all(projectId, status);
  return rows.map((r) => getChangeset(r.id));
}

// ---------- 人工操作对账 ----------
// 项目文件有两个写入口:AI 走变更集管线(维护审查簿记),人工走文件路由(直接改磁盘)。
// 人工删除/重命名/覆盖后必须对账,否则残留的 pending 条目与审查基线会把已消失的文件
// 当成待审变更，或把人工内容误标成 AI 修改。

/** 把某路径(或其目录前缀下所有路径)的 pending 条目标 reverted 并清理审查基线 */
function invalidatePendingForPaths(db, projectId, pathPrefixes) {
  const affected = [];
  for (const prefix of pathPrefixes) {
    const rows = db
      .prepare(`SELECT cf.id, cf.changeset_id, cf.file_path FROM changeset_files cf
                JOIN changesets c ON c.id = cf.changeset_id
                WHERE c.project_id = ? AND cf.status = 'pending' AND c.status = 'pending'
                  AND (cf.file_path = ? OR cf.file_path LIKE ? ESCAPE '\\')`)
      .all(projectId, prefix, prefix.replace(/[%_\\]/g, '\\$&') + '/%');
    for (const r of rows) {
      db.prepare("UPDATE changeset_files SET status = 'reverted' WHERE id = ?").run(r.id);
      deleteReviewBase(projectId, r.file_path);
      affected.push(r.file_path);
    }
    // 条目全部了结的变更集刷新整体状态
    const csIds = [...new Set(rows.map((r) => r.changeset_id))];
    for (const cid of csIds) refreshStatus(db, cid);
  }
  return affected;
}

/** 人工删除文件/目录后调用:作废相关 pending 条目、删基线、销毁协同房间防旧内容反写复活 */
export function reconcilePathRemoved(projectId, path) {
  const db = getDb();
  const affected = invalidatePendingForPaths(db, projectId, [path]);
  if (affected.length) {
    touchProject(projectId);
    reloadProjectRooms(projectId, affected);
  }
  return affected;
}

/** 人工重命名后调用:旧路径上的待审条目作废(不迁移到新路径) */
export function reconcilePathRenamed(projectId, oldPath) {
  return reconcilePathRemoved(projectId, oldPath);
}

/** Manual replacement takes ownership of its text delta. Independent applied
 * AI regions remain reviewable; stale unapplied proposals and binary entries
 * are invalidated because they cannot safely be merged into replacement bytes. */
export function reconcileContentReplaced(projectId, paths) {
  const db = getDb();
  const affected = [];
  db.transaction(() => {
    for (const p of paths) {
      const rows = db.prepare(`SELECT cf.id,cf.changeset_id,cf.applied,cf.content_encoding FROM changeset_files cf
        JOIN changesets c ON c.id = cf.changeset_id
        WHERE c.project_id = ? AND cf.status = 'pending' AND cf.file_path = ?`).all(projectId, p);
      if (!rows.length) continue;
      synchronizeReviewState(projectId, p);
      for (const row of rows) {
        if (!row.applied || row.content_encoding !== 'utf8') {
          db.prepare("UPDATE changeset_files SET status = 'reverted' WHERE id = ?").run(row.id);
        }
      }
      for (const id of new Set(rows.map((row) => row.changeset_id))) refreshStatus(db, id);
      affected.push(p);
    }
    if (affected.length) touchProject(projectId);
  })();
  // Explicit file replacement supersedes any older debounced room text.
  reloadProjectRooms(projectId, paths);
  return affected;
}

/** 懒对账:列出 pending 变更集时与磁盘核对,已消失的文件就地作废(自愈历史脏数据)。
 * @returns {{invalidated: string[]}} 本次被作废的路径 */
export function reconcileMissingOnDisk(projectId) {
  const db = getDb();
  const rows = db
    .prepare(`SELECT DISTINCT cf.file_path FROM changeset_files cf
              JOIN changesets c ON c.id = cf.changeset_id
              WHERE c.project_id = ? AND cf.status = 'pending' AND cf.applied = 1 AND c.status = 'pending'`)
    .all(projectId);
  if (!rows.length) return { invalidated: [] };
  const dir = projectDir(projectId);
  const missing = [];
  for (const r of rows) {
    try {
      if (!fs.existsSync(safeJoin(dir, r.file_path))) missing.push(r.file_path);
    } catch { /* 无法判定时保守不动 */ }
  }
  if (!missing.length) return { invalidated: [] };
  const affected = invalidatePendingForPaths(db, projectId, missing);
  if (affected.length) {
    touchProject(projectId);
    reloadProjectRooms(projectId, affected);
  }
  return { invalidated: affected };
}

export function getFileDiff(changesetId, filePath) {
  const db = getDb();
  loadChangeset(db, changesetId);
  const r = db
    .prepare('SELECT f.*,c.proposal_revision FROM changeset_files f JOIN changesets c ON c.id=f.changeset_id WHERE f.changeset_id = ? AND f.file_path = ?')
    .get(changesetId, filePath);
  if (!r) throw new HttpError(404, '文件不在该变更集中');
  if (isBinary(r)) return {
    proposalRevision: r.proposal_revision, binary: true, before: null, after: null, patch: '',
    beforeBytes: Buffer.byteLength(r.before_content || '', 'base64'),
    afterBytes: Buffer.byteLength(r.after_content || '', 'base64'),
  };
  const before = r.before_content ?? '';
  const after = r.after_content ?? '';
  return {
    proposalRevision: r.proposal_revision,
    before,
    after,
    patch: createTwoFilesPatch(`a/${filePath}`, `b/${filePath}`, before, after),
  };
}
