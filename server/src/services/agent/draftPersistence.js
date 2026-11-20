import fs from 'node:fs';
import { requireProjectAccess } from '../../access.js';
import { flushProjectRooms } from '../../collab.js';
import { safeJoin, HttpError } from '../../util.js';
import { createChangeset, filterMeaningfulChanges, pendingChangesetState, revisePendingChangeset } from './changesets.js';

const clone = value => structuredClone(value);
const RECOVERABLE = new Set(['DRAFT_DISK_CONFLICT', 'DRAFT_REVIEW_CONFLICT']);
function conflict(message, code = 'DRAFT_CONFLICT', paths = []) {
  const error = new HttpError(409, `草稿接续冲突：${message}。原草稿完整保留，未自动应用，请处理现有审核或文件冲突后继续。`);
  return Object.assign(error, { code, reason: message, paths });
}

/** A server-owned identity and optimistic revision for a user's chat draft.
 * No tools are replayed during recovery. The entire proposed byte content is
 * committed synchronously before an editing tool may report success. */
export function openAgentDraft(ctx) {
  const { db, project, user, chatId } = ctx;
  const authorize = (write = false) => {
    const activeUser = db.prepare('SELECT * FROM users WHERE id=?').get(user.id);
    if (!activeUser || activeUser.status !== 'active') throw new HttpError(403, '账号已被禁用或删除，无法继续草稿');
    requireProjectAccess(activeUser, project.public_id, { write });
    if (!db.prepare('SELECT id FROM chats WHERE id=? AND project_id=? AND user_id=?').get(chatId, project.id, user.id))
      throw new HttpError(403, '无法访问此会话的草稿');
  };
  ctx.signal?.throwIfAborted();
  authorize();
  let row = db.prepare("SELECT * FROM agent_drafts WHERE project_id=? AND chat_id=? AND user_id=? AND state='active'")
    .get(project.id, chatId, user.id);
  const recoveries = [];
  let files = [], resumed = false;
  const proposalState = () => {
    const state = pendingChangesetState(row.changeset_id);
    if (state.cs.project_id !== project.id || state.cs.chat_id !== chatId)
      throw conflict('草稿关联的提案不属于当前项目或会话');
    return state;
  };
  function transitionRow(state) {
    // Never detach or close a snapshot advanced by another executor. Metadata
    // and every original byte stay untouched; only its lifecycle state changes.
    const result = db.prepare(`UPDATE agent_drafts SET state=? WHERE id=? AND state='active'
      AND project_id=? AND chat_id=? AND user_id=? AND version=? AND published_version=?
      AND changeset_id IS ? AND review_fingerprint IS ? AND files_json=?`)
      .run(state, row.id, project.id, chatId, user.id, row.version, row.published_version,
        row.changeset_id, row.review_fingerprint, row.files_json);
    if (result.changes !== 1) throw conflict('另一个执行已更新此草稿版本或发布状态');
  }
  function selectDraft() {
    if (row?.changeset_id) {
      const state = proposalState();
      const remaining = state.rows.filter(file => file.status === 'pending');
      // Already-applied review overlays live on disk, not in an active draft.
      if (!remaining.length || remaining.every(file => file.applied)) {
        if (row.version !== row.published_version)
          throw conflict('上次检查点之后的提案已经被审核，仍有未发布的后续版本', 'DRAFT_REVIEW_CONFLICT');
        transitionRow('closed');
        row = null;
      }
    }
    if (!row) {
      // Only an unowned legacy identity can be adopted. Archived/conflicted
      // snapshots must never be silently adopted again on the following turn.
      const candidates = db.prepare(`SELECT DISTINCT c.id FROM changesets c JOIN changeset_files f ON f.changeset_id=c.id
        WHERE c.project_id=? AND c.chat_id=? AND c.status='pending' AND f.status='pending' AND f.applied=0
          AND NOT EXISTS (SELECT 1 FROM agent_drafts d WHERE d.changeset_id=c.id)
        ORDER BY c.id`).all(project.id, chatId);
      if (candidates.length > 1) throw conflict('本会话有多个未应用提案，无法确定要接续的草稿');
      if (candidates.length) {
        const state = pendingChangesetState(candidates[0].id);
        if (state.rows.some(file => file.status !== 'pending' || file.applied)) throw conflict('现有提案已经部分审核');
        const proposalFiles = state.rows.map(file => ({ path: file.file_path, before: file.before_content, after: file.after_content, encoding: file.content_encoding }));
        const result = db.prepare(`INSERT INTO agent_drafts(project_id,chat_id,user_id,version,published_version,changeset_id,review_fingerprint,files_json)
          VALUES(?,?,?,1,1,?,?,?)`).run(project.id, chatId, user.id, state.cs.id, state.fingerprint, JSON.stringify(proposalFiles));
        row = db.prepare('SELECT * FROM agent_drafts WHERE id=?').get(Number(result.lastInsertRowid));
      }
    }
  }
  function validateFiles(items, allowDiskChanges = []) {
    const paths = new Set(), checked = [], changed = [];
    // Validate every boundary before considering a recoverable baseline change.
    // A later unsafe path or I/O failure must not be hidden by an earlier conflict.
    for (const file of items) {
      if (!file || typeof file.path !== 'string' || file.path === '_workspace' || file.path.startsWith('_workspace/') || paths.has(file.path))
        throw conflict('检查点文件边界无效');
      const abs = safeJoin(ctx.projectDir, file.path);
      paths.add(file.path); checked.push({ file, abs });
    }
    for (const { file, abs } of checked) {
      let current;
      try { current = fs.readFileSync(abs).toString(file.encoding === 'base64' ? 'base64' : 'utf8'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; current = null; }
      if (current !== (file.before ?? null) && allowDiskChanges !== true && !allowDiskChanges.includes(file.path)) changed.push(file.path);
    }
    if (changed.length) throw conflict(`${changed.join('、')} 的磁盘版本在草稿生成后已改变`, 'DRAFT_DISK_CONFLICT', changed);
  }
  function assertCheckpoint(allowDiskChanges = []) {
    // Final preservation is server bookkeeping for already-authorized bytes.
    // Deleted identities cannot recreate orphaned content. Account/member state
    // may have changed, but no model tool or new draft content is accepted here.
    const identity = db.prepare(`SELECT c.id FROM chats c JOIN projects p ON p.id=c.project_id JOIN users u ON u.id=c.user_id
      WHERE c.id=? AND c.project_id=? AND c.user_id=? AND p.public_id=?`)
      .get(chatId, project.id, user.id, project.public_id);
    if (!identity) throw conflict('草稿所属用户、项目或会话已经删除');
    if (row) {
      const current = db.prepare("SELECT * FROM agent_drafts WHERE id=? AND state='active'").get(row.id);
      if (!current || current.version !== row.version || current.published_version !== row.published_version ||
          current.changeset_id !== row.changeset_id || current.review_fingerprint !== row.review_fingerprint)
        throw conflict('另一个执行已更新此草稿版本或发布状态');
      if (row.changeset_id) {
        const state = proposalState();
        if (state.fingerprint !== row.review_fingerprint || state.cs.status !== 'pending' || state.cs.applied ||
            state.rows.some(file => file.status !== 'pending' || file.applied)) throw conflict('原提案的应用或审核状态已变化', 'DRAFT_REVIEW_CONFLICT');
      }
    }
    if (!row && db.prepare("SELECT id FROM agent_drafts WHERE project_id=? AND chat_id=? AND user_id=? AND state='active'")
      .get(project.id, chatId, user.id)) throw conflict('另一个执行已建立当前会话草稿');
    flushProjectRooms(project.id, { strict: true });
    validateFiles(files, allowDiskChanges);
  }
  function assertCurrent() { authorize(); assertCheckpoint(); }
  try {
    selectDraft();
    files = row ? JSON.parse(row.files_json) : [];
    assertCurrent();
    resumed = Boolean(row && files.length);
  } catch (error) {
    // Archival recovery is a startup decision only. Active handles retain
    // ownership/review checks; an explicit hash-checked rebase is separate.
    if (!row || !RECOVERABLE.has(error.code)) throw error;
    const retained = JSON.parse(row.files_json);
    try { validateFiles(retained); }
    catch (validation) { if (validation.code !== 'DRAFT_DISK_CONFLICT') throw validation; }
    db.transaction(() => { ctx.signal?.throwIfAborted(); authorize(true); transitionRow('conflicted'); })();
    recoveries.push({ id: row.id, version: row.version, changesetId: row.changeset_id ?? null,
      reason: error.reason, paths: error.paths.length ? [...error.paths] : retained.map(file => file.path) });
    row = null; files = [];
    // Recheck concurrent ownership, but never adopt another proposal on this
    // turn: the new instruction starts from the current project files.
    assertCurrent();
  }
  ctx.changesetBuffer.splice(0, ctx.changesetBuffer.length, ...clone(files));
  const api = {
    resumed, recoveries: clone(recoveries),
    get id() { return row?.id ?? null; },
    get version() { return row?.version ?? 0; },
    assertCurrent,
    checkpoint({ rebasePath } = {}) {
      authorize(true);
      const next = filterMeaningfulChanges(ctx.changesetBuffer).map(file => ({ path: file.path, before: file.before ?? null, after: file.after ?? null, encoding: file.encoding === 'base64' ? 'base64' : 'utf8' }));
      const nextJson = JSON.stringify(next);
      let savedRow = row;
      db.transaction(() => {
        // Rebase is an explicit compare-and-stage operation. Every changed
        // baseline must match disk; unrelated unresolved drafts stay intact.
        authorize(); assertCheckpoint(rebasePath ? true : []);
        // Several files can conflict at once. A one-file rebase may preserve
        // the other byte-identical pending drafts, but cannot alter them using
        // stale baselines. Publishing stays strict until all are resolved.
        const unchanged = rebasePath ? next.filter(file => file.path !== rebasePath &&
          files.some(previous => JSON.stringify(previous) === JSON.stringify(file))).map(file => file.path) : [];
        validateFiles(next, unchanged);
        if (nextJson === JSON.stringify(files)) return;
        if (!row) {
          const result = db.prepare('INSERT INTO agent_drafts(project_id,chat_id,user_id,version,files_json) VALUES(?,?,?,1,?)')
            .run(project.id, chatId, user.id, nextJson);
          savedRow = db.prepare('SELECT * FROM agent_drafts WHERE id=?').get(Number(result.lastInsertRowid));
        } else {
          const updated = db.prepare("UPDATE agent_drafts SET files_json=?,version=version+1,updated_at=datetime('now') WHERE id=? AND version=? AND state='active'")
            .run(nextJson, row.id, row.version);
          if (updated.changes !== 1) throw conflict('草稿版本已变化');
          savedRow = { ...row, files_json: nextJson, version: row.version + 1 };
        }
      })();
      row = savedRow;
      files = clone(next);
      return { draftId: api.id, version: api.version };
    },
    publish: () => publishCheckpoint(),
    // This accepts no bytes/paths from callers: only the snapshot committed
    // by checkpoint() can survive loss of editing permission at finalization.
    preserveCheckpoint: () => publishCheckpoint(true),
  };
  function publishCheckpoint(preserveOnly = false) {
    const check = preserveOnly ? assertCheckpoint : assertCurrent;
    check();
    if (!row || row.version === row.published_version) return { id: row?.changeset_id ?? null, changed: false };
    if (!preserveOnly) authorize(true);
    let result, savedRow;
    db.transaction(() => {
      check();
      result = row.changeset_id
        ? revisePendingChangeset({ id: row.changeset_id, projectId: project.id, chatId, files, fingerprint: row.review_fingerprint })
        : createChangeset({ projectId: project.id, chatId, files });
      const fingerprint = result.id ? pendingChangesetState(result.id).fingerprint : null;
      db.prepare("UPDATE agent_drafts SET changeset_id=?,review_fingerprint=?,published_version=version,state=? WHERE id=? AND version=?")
        .run(result.id, fingerprint, files.length ? 'active' : 'closed', row.id, row.version);
      savedRow = { ...row, changeset_id: result.id, review_fingerprint: fingerprint, published_version: row.version };
    })();
    row = savedRow;
    return { ...result, changed: true, draftId: api.id, version: api.version };
  }
  ctx.assertDraftCurrent = assertCurrent;
  ctx.assertDraftReadable = () => { authorize(); assertCheckpoint(true); };
  ctx.assertDraftRebaseCurrent = () => { authorize(); assertCheckpoint(true); };
  ctx.checkpointDraft = options => api.checkpoint(options);
  return api;
}
