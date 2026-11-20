import { Router } from 'express';
import { getDb } from '../db.js';
import { requireProjectAccess } from '../access.js';
import { asyncHandler, HttpError } from '../util.js';

const router = Router();

function rowToReview(r) {
  return {
    id: r.id,
    filePath: r.file_path,
    start: r.start_offset,
    end: r.end_offset,
    quotedText: r.quoted_text || '',
    content: r.content,
    authorId: r.author_id,
    authorName: r.dname || r.uname || '',
    status: r.status,
    createdAt: r.created_at,
    resolvedBy: r.resolved_by,
    resolvedAt: r.resolved_at,
  };
}

const REVIEW_SELECT = `
  SELECT r.*, u.username AS uname, u.display_name AS dname
  FROM reviews r LEFT JOIN users u ON u.id = r.author_id`;

function getReviewChecked(db, projectId, rid) {
  const r = db.prepare(`${REVIEW_SELECT} WHERE r.id = ? AND r.project_id = ?`).get(Number(rid), projectId);
  if (!r) throw new HttpError(404, '评论不存在');
  return r;
}

function checkOffsets(start, end) {
  const s = Number(start);
  const e = Number(end);
  if (!Number.isInteger(s) || !Number.isInteger(e) || s < 0 || e <= s) {
    throw new HttpError(400, '选区偏移非法（需 0 ≤ start < end）');
  }
  return [s, e];
}

const REPLIES_SELECT = `
  SELECT rr.*, u.username AS uname, u.display_name AS dname
  FROM review_replies rr JOIN users u ON u.id = rr.author_id`;

function rowToReply(r) {
  return {
    id: r.id,
    authorId: r.author_id,
    authorName: r.dname || r.uname || '',
    content: r.content,
    createdAt: r.created_at,
  };
}

/** 批量取一批批注的回复并挂到 review 上 */
function attachReplies(db, reviews) {
  if (!reviews.length) return reviews;
  const ids = reviews.map((r) => r.id);
  const marks = ids.map(() => '?').join(',');
  const rows = db
    .prepare(`${REPLIES_SELECT} WHERE rr.review_id IN (${marks}) ORDER BY rr.created_at ASC, rr.id ASC`)
    .all(...ids);
  const byReview = new Map(reviews.map((r) => [r.id, []]));
  for (const row of rows) {
    byReview.get(row.review_id)?.push(rowToReply(row));
  }
  for (const r of reviews) r.replies = byReview.get(r.id) || [];
  return reviews;
}

router.get('/:id/reviews', asyncHandler(async (req, res) => {
  const { project } = requireProjectAccess(req.user, req.params.id);
  const db = getDb();
  const file = req.query.file ? String(req.query.file) : null;
  const rows = file
    ? db.prepare(`${REVIEW_SELECT} WHERE r.project_id = ? AND r.file_path = ? ORDER BY r.created_at ASC, r.id ASC`).all(project.id, file)
    : db.prepare(`${REVIEW_SELECT} WHERE r.project_id = ? ORDER BY r.created_at ASC, r.id ASC`).all(project.id);
  const reviews = attachReplies(db, rows.map(rowToReview));
  res.json({ reviews });
}));

router.post('/:id/reviews', asyncHandler(async (req, res) => {
  const { project } = requireProjectAccess(req.user, req.params.id, { write: true });
  const filePath = String(req.body?.filePath || '').trim();
  if (!filePath) throw new HttpError(400, 'filePath 不能为空');
  const content = String(req.body?.content || '').trim();
  if (!content) throw new HttpError(400, '评论内容不能为空');
  const [s, e] = checkOffsets(req.body?.start, req.body?.end);
  const db = getDb();
  const info = db
    .prepare('INSERT INTO reviews (project_id, file_path, start_offset, end_offset, quoted_text, content, author_id) VALUES (?,?,?,?,?,?,?)')
    .run(project.id, filePath, s, e, String(req.body?.quotedText || ''), content, req.user.id);
  res.status(201).json({ review: rowToReview(getReviewChecked(db, project.id, info.lastInsertRowid)) });
}));

router.post('/:id/reviews/reanchor', asyncHandler(async (req, res) => {
  const { project } = requireProjectAccess(req.user, req.params.id, { write: true });
  const updates = req.body?.updates;
  if (!Array.isArray(updates) || !updates.length) throw new HttpError(400, 'updates 不能为空');
  if (updates.length > 500) throw new HttpError(400, '一次最多更新 500 条');
  const db = getDb();
  const stmt = db.prepare('UPDATE reviews SET start_offset = ?, end_offset = ? WHERE id = ? AND project_id = ?');
  db.transaction((list) => {
    for (const u of list) {
      const [s, e] = checkOffsets(u?.start, u?.end);
      stmt.run(s, e, Number(u.id), project.id);
    }
  })(updates);
  res.json({ ok: true });
}));

router.post('/:id/reviews/:rid/resolve', asyncHandler(async (req, res) => {
  const { project } = requireProjectAccess(req.user, req.params.id, { write: true });
  const db = getDb();
  const r = getReviewChecked(db, project.id, req.params.rid);
  // 完成前必须至少有一条回复（推动批注被真正回应，而不是被直接略过）
  const replyCount = db.prepare('SELECT COUNT(*) AS n FROM review_replies WHERE review_id = ?').get(r.id).n;
  if (!replyCount) throw new HttpError(400, '批注需至少一条回复后才能标记完成');
  db.prepare("UPDATE reviews SET status = 'done', resolved_by = ?, resolved_at = datetime('now') WHERE id = ?")
    .run(req.user.id, r.id);
  const updated = getReviewChecked(db, project.id, r.id);
  const [review] = attachReplies(db, [rowToReview(updated)]);
  res.json({ review });
}));

// 批注回复：任意项目成员可回复；有回复后批注才允许标记完成
router.post('/:id/reviews/:rid/replies', asyncHandler(async (req, res) => {
  const { project } = requireProjectAccess(req.user, req.params.id, { write: true });
  const content = String(req.body?.content || '').trim();
  if (!content) throw new HttpError(400, '回复内容不能为空');
  const db = getDb();
  const r = getReviewChecked(db, project.id, req.params.rid);
  const info = db
    .prepare('INSERT INTO review_replies (review_id, author_id, content) VALUES (?,?,?)')
    .run(r.id, req.user.id, content);
  const replyRow = db.prepare(`${REPLIES_SELECT} WHERE rr.id = ?`).get(info.lastInsertRowid);
  res.status(201).json({ reply: rowToReply(replyRow) });
}));

router.post('/:id/reviews/:rid/unresolve', asyncHandler(async (req, res) => {
  const { project } = requireProjectAccess(req.user, req.params.id, { write: true });
  const db = getDb();
  const r = getReviewChecked(db, project.id, req.params.rid);
  db.prepare("UPDATE reviews SET status = 'open', resolved_by = NULL, resolved_at = NULL WHERE id = ?").run(r.id);
  res.json({ review: rowToReview(getReviewChecked(db, project.id, r.id)) });
}));

// 一键删除：只删除自己已完成（done）的批注，未完成的保留（须注册在 /:rid 路由之前）
router.delete('/:id/reviews/mine', asyncHandler(async (req, res) => {
  const { project } = requireProjectAccess(req.user, req.params.id);
  const db = getDb();
  const info = db
    .prepare("DELETE FROM reviews WHERE project_id = ? AND author_id = ? AND status = 'done'")
    .run(project.id, req.user.id);
  res.json({ ok: true, deleted: info.changes });
}));

router.delete('/:id/reviews/:rid', asyncHandler(async (req, res) => {
  const { project } = requireProjectAccess(req.user, req.params.id);
  const db = getDb();
  const r = getReviewChecked(db, project.id, req.params.rid);
  // 仅批注作者可删除自己的批注（项目拥有者也不例外）
  if (r.author_id !== req.user.id) {
    throw new HttpError(403, '仅批注作者可删除自己的批注');
  }
  db.prepare('DELETE FROM reviews WHERE id = ?').run(r.id);
  res.json({ ok: true });
}));

export default router;
