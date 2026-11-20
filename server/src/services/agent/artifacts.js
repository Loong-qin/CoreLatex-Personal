import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { DATA_DIR } from '../../config.js';
import { getDb } from '../../db.js';
import { HttpError } from '../../util.js';
import { assertStorageQuota } from '../../quotas.js';

const ROOT = path.join(DATA_DIR, 'agent-artifacts');
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
let lastSweep = 0;

// No user path is ever joined here. These files are immutable tool-result bytes,
// outside the project tree, and do not affect a document's source or compilation.
export function cleanupOrphanArtifacts(db = getDb()) {
  if (!fs.existsSync(ROOT)) return;
  const rows = db.prepare('SELECT a.id FROM agent_artifacts a LEFT JOIN chats c ON c.id=a.chat_id LEFT JOIN projects p ON p.id=a.project_id WHERE c.id IS NULL OR p.id IS NULL OR c.user_id<>a.user_id OR c.project_id<>a.project_id').all();
  for (const { id } of rows) removeArtifact(db, id);
  const live = new Set(db.prepare('SELECT id FROM agent_artifacts').all().map((r) => r.id));
  for (const item of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (!item.isFile() || !ID.test(item.name) || live.has(item.name)) continue;
    const file = path.join(ROOT, item.name);
    // A concurrent process may still be between file creation and DB insertion.
    if (Date.now() - fs.statSync(file).mtimeMs > 3_600_000) fs.rmSync(file, { force: true });
  }
}

function removeArtifact(db, id) {
  if (ID.test(id)) fs.rmSync(path.join(ROOT, id), { force: true });
  db.prepare('DELETE FROM agent_artifacts WHERE id=?').run(id);
}

export function deleteChatArtifacts(chatId, db = getDb()) {
  for (const { id } of db.prepare('SELECT id FROM agent_artifacts WHERE chat_id=?').all(chatId)) removeArtifact(db, id);
}
export function deleteProjectArtifacts(projectId, db = getDb()) {
  for (const { id } of db.prepare('SELECT id FROM agent_artifacts WHERE project_id=?').all(projectId)) removeArtifact(db, id);
}

export function persistToolImages(ctx, images) {
  if (!images?.length) return [];
  const db = ctx.db || getDb();
  const chat = db.prepare('SELECT id FROM chats WHERE id=? AND user_id=? AND project_id=?').get(ctx.chatId ?? null, ctx.user?.id ?? null, ctx.project?.id ?? null);
  const project = db.prepare('SELECT public_id FROM projects WHERE id=?').get(ctx.project?.id ?? null);
  if (!chat || !project) throw new Error('当前会话不可保存图像预览');
  if (Date.now() - lastSweep > 3_600_000) { cleanupOrphanArtifacts(db); lastSweep = Date.now(); }
  fs.mkdirSync(ROOT, { recursive: true });
  const saved = [];
  try {
    let total = 0;
    for (const img of images) {
      const mimeType = img.mediaType || img.mimeType || 'image/png';
      if (!MIMES.has(mimeType)) throw new Error('图像格式不支持安全预览');
      const encoded = String(img.imageBase64 || '');
      if (!encoded || !/^[A-Za-z0-9+/\r\n]*={0,2}$/.test(encoded)) throw new Error('图像数据无效');
      const bytes = Buffer.from(encoded, 'base64');
      total += bytes.length;
      if (!bytes.length || total > 32 * 1024 * 1024 || saved.length >= 32) throw new Error('图像快照超过单次保存上限');
      assertStorageQuota(ctx.user, bytes.length);
      const id = randomUUID();
      const file = path.join(ROOT, id);
      fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
      try {
        db.prepare('INSERT INTO agent_artifacts(id,project_id,chat_id,user_id,mime_type,size_bytes,sha256) VALUES(?,?,?,?,?,?,?)')
          .run(id, ctx.project.id, chat.id, ctx.user.id, mimeType, bytes.length, createHash('sha256').update(bytes).digest('hex'));
      } catch (error) { fs.rmSync(file, { force: true }); throw error; }
      saved.push({ id, url: `/api/projects/${project.public_id}/agent/artifacts/${id}`, label: img.page ? `第 ${img.page} 页` : `图像 ${saved.length + 1}`, ...(img.page ? { page: img.page } : {}), mimeType });
    }
    return saved;
  } catch (error) { for (const { id } of saved) removeArtifact(db, id); throw error; }
}

export function getArtifactForUser(artifactId, projectId, userId, db = getDb()) {
  if (!ID.test(String(artifactId))) throw new HttpError(404, '图像预览不存在');
  const row = db.prepare('SELECT a.* FROM agent_artifacts a JOIN chats c ON c.id=a.chat_id WHERE a.id=? AND a.project_id=? AND a.user_id=? AND c.user_id=? AND c.project_id=?')
    .get(artifactId, projectId, userId, userId, projectId);
  if (!row || !fs.existsSync(path.join(ROOT, row.id))) throw new HttpError(404, '图像预览不存在');
  return { ...row, file: path.join(ROOT, row.id) };
}
