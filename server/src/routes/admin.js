import fs from 'node:fs';
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { getDb } from '../db.js';
import { refreshUserRoomPermissions, removeProjectRooms } from '../collab.js';
import { requireAdmin, publicUser, register } from '../auth.js';
import { projectDir } from '../config.js';
import { storageUsedBytes, aiUsageSummary, aiUsageTotals, prefixedAiUsage, systemDailyFor, compileQuotaForUser, grantDailyCompileQuota } from '../quotas.js';
import { getSystemSettings, saveSystemSettings } from '../systemSettings.js';
import { asyncHandler, HttpError, projectStorageBytes } from '../util.js';

const router = Router();
router.use(requireAdmin);

// 系统设置：注册开关 + 新用户默认配额
router.get('/system-settings', asyncHandler((req, res) => {
  res.json(getSystemSettings(getDb()));
}));

router.put('/system-settings', asyncHandler(async (req, res) => {
  const b = req.body || {};
  const patch = {};
  if (b.allowRegistration !== undefined) patch.allowRegistration = !!b.allowRegistration;
  if (b.defaultStorageMb !== undefined) {
    const n = Number(b.defaultStorageMb);
    if (!Number.isFinite(n) || n < 0) throw new HttpError(400, '空间配额需 ≥ 0');
    patch.defaultStorageMb = n;
  }
  if (b.defaultCompileSeconds !== undefined) {
    const n = Number(b.defaultCompileSeconds);
    if (!Number.isFinite(n) || n < 0) throw new HttpError(400, '编译时长需 ≥ 0');
    patch.defaultCompileSeconds = n;
  }
  const saved = saveSystemSettings(patch, getDb());
  // 修改默认配额后,同步到所有未自定义配额的用户(管理员除外,其配额由编辑配额单独管理)
  if (patch.defaultStorageMb !== undefined || patch.defaultCompileSeconds !== undefined) {
    const s = getSystemSettings(getDb());
    getDb().prepare(`UPDATE users SET storage_quota_bytes = ?, compile_seconds_quota = ?
                     WHERE quota_customized = 0 AND role != 'admin'`)
      .run(s.defaultStorageMb * 1024 * 1024, s.defaultCompileSeconds);
  }
  res.json(saved);
}));

function projectCountOf(db, userId) {
  return db.prepare('SELECT COUNT(*) AS c FROM projects WHERE owner_id = ? AND deleted = 0').get(userId).c;
}

function getUserChecked(db, id) {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(id));
  if (!u) throw new HttpError(404, '用户不存在');
  return u;
}

router.get('/stats', asyncHandler(async (_req, res) => {
  const db = getDb();
  const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  const projectCount = db.prepare('SELECT COUNT(*) AS c FROM projects WHERE deleted = 0').get().c;
  let totalStorageBytes = 0;
  for (const r of db.prepare('SELECT id FROM projects').all()) {
    totalStorageBytes += projectStorageBytes(projectDir(r.id));
  }
  const totalCompileSeconds = Math.round(
    db.prepare('SELECT * FROM users').all().reduce((sum, u) => sum + compileQuotaForUser(u).compileSecondsUsed, 0)
  );
  const perUser = db.prepare('SELECT * FROM users ORDER BY id ASC').all().map((u) => {
    const ai = aiUsageTotals('user_id = ?', u.id);
    const compileCount = db.prepare('SELECT COUNT(*) AS c FROM compile_jobs WHERE user_id = ?').get(u.id).c;
    return {
      userId: u.id,
      username: u.username,
      displayName: u.display_name,
      role: u.role,
      projectCount: projectCountOf(db, u.id),
      storageBytes: storageUsedBytes(u.id),
      compileCount,
      ...compileQuotaForUser(u),
      ...prefixedAiUsage(ai),
    };
  });
  res.json({
    userCount, projectCount, totalStorageBytes, totalCompileSeconds,
    ...aiUsageSummary('1=1'),
    ...systemDailyFor('1=1'),
    perUser,
  });
}));

router.get('/users', asyncHandler(async (_req, res) => {
  const db = getDb();
  const users = db.prepare('SELECT * FROM users ORDER BY id ASC').all().map((u) => {
    const ai = aiUsageTotals('user_id = ?', u.id);
    return {
      ...publicUser(u),
      projectCount: projectCountOf(db, u.id),
      storageBytes: storageUsedBytes(u.id),
      ...prefixedAiUsage(ai),
    };
  });
  res.json({ users });
}));

router.post('/users', asyncHandler(async (req, res) => {
  const role = req.body?.role;
  if (role !== undefined && role !== 'user') {
    throw new HttpError(400, '系统仅允许一个管理员，不能创建管理员账号');
  }
  const user = register({
    username: req.body?.username,
    password: req.body?.password,
    displayName: req.body?.displayName,
  });
  res.status(201).json({ user: publicUser(user) });
}));

// 批量用户操作：状态（启用/禁用）、配额、补充今日编译额度；管理员账号自动跳过
router.post('/users/batch', asyncHandler(async (req, res) => {
  const db = getDb();
  const userIds = Array.isArray(req.body?.userIds) ? req.body.userIds.map(Number).filter(Number.isInteger) : [];
  if (!userIds.length) throw new HttpError(400, '请先选择要操作的用户');
  const patch = req.body?.patch || {};
  const status = patch.status;
  if (status !== undefined && !['active', 'disabled'].includes(status)) {
    throw new HttpError(400, 'status 仅支持 active/disabled');
  }
  const quotaSets = {};
  for (const [field, col] of Object.entries(QUOTA_FIELDS)) {
    const v = patch[field];
    if (v === undefined) continue;
    const n = Number(v);
    if (!Number.isInteger(n) || n < -1) throw new HttpError(400, `${field} 需为 ≥ -1 的整数（-1 表示不限）`);
    quotaSets[col] = n;
  }
  if (status === undefined && !Object.keys(quotaSets).length && !patch.resetCompile) {
    throw new HttpError(400, '没有需要批量修改的内容');
  }
  let updated = 0;
  let skippedAdmins = 0;
  db.transaction(() => {
    for (const id of [...new Set(userIds)]) {
      const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
      if (!u) continue;
      if (u.role === 'admin') { skippedAdmins += 1; continue; }
      if (status !== undefined) {
        db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, u.id);
      }
      for (const [col, v] of Object.entries(quotaSets)) {
        db.prepare(`UPDATE users SET ${col} = ? WHERE id = ?`).run(v, u.id);
      }
      if (patch.resetCompile) {
        grantDailyCompileQuota(db, u.id);
      }
      // 批量设置配额同样视为单独定制,此后不跟随系统默认
      if (Object.keys(quotaSets).length) {
        db.prepare('UPDATE users SET quota_customized = 1 WHERE id = ?').run(u.id);
      }
      updated += 1;
    }
  })();
  if (status !== undefined) {
    for (const id of new Set(userIds)) refreshUserRoomPermissions(id);
  }
  res.json({ updated, skippedAdmins });
}));

const QUOTA_FIELDS = {
  projectQuota: 'project_quota',
  compileSecondsQuota: 'compile_seconds_quota',
  storageQuotaBytes: 'storage_quota_bytes',
};

router.patch('/users/:id', asyncHandler(async (req, res) => {
  const db = getDb();
  const target = getUserChecked(db, req.params.id);
  const { displayName, status, role } = req.body || {};
  if (role !== undefined) throw new HttpError(400, '不支持修改角色，系统仅允许一个管理员');
  if (status !== undefined) {
    if (!['active', 'disabled'].includes(status)) throw new HttpError(400, 'status 仅支持 active/disabled');
    if (target.role === 'admin' && status === 'disabled') throw new HttpError(400, '不能禁用管理员账号');
  }
  let touchedQuota = false;
  for (const [field, col] of Object.entries(QUOTA_FIELDS)) {
    const v = req.body?.[field];
    if (v === undefined) continue;
    const n = Number(v);
    if (!Number.isInteger(n) || n < -1) throw new HttpError(400, `${field} 需为 ≥ -1 的整数（-1 表示不限）`);
    db.prepare(`UPDATE users SET ${col} = ? WHERE id = ?`).run(n, target.id);
    touchedQuota = true;
  }
  // 管理员单独编辑过配额 = 已自定义,此后不再跟随系统默认配额变化
  if (touchedQuota) db.prepare('UPDATE users SET quota_customized = 1 WHERE id = ?').run(target.id);
  if (displayName !== undefined) {
    db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(String(displayName).trim().slice(0, 120), target.id);
  }
  if (status !== undefined) {
    db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, target.id);
    refreshUserRoomPermissions(target.id);
  }
  res.json({ user: publicUser(getUserChecked(db, target.id)) });
}));

router.post('/users/:id/reset-password', asyncHandler(async (req, res) => {
  const db = getDb();
  const target = getUserChecked(db, req.params.id);
  const password = String(req.body?.password || '');
  if (password.length < 4) throw new HttpError(400, '密码至少 4 位');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(password, 10), target.id);
  res.json({ ok: true });
}));

router.post('/users/:id/reset-compile', asyncHandler(async (req, res) => {
  const db = getDb();
  const target = getUserChecked(db, req.params.id);
  const user = grantDailyCompileQuota(db, target.id);
  res.json({ ok: true, user: publicUser(user) });
}));

router.delete('/users/:id', asyncHandler(async (req, res) => {
  const db = getDb();
  const target = getUserChecked(db, req.params.id);
  if (target.role === 'admin') throw new HttpError(400, '不能删除管理员账号');
  const owned = db.prepare('SELECT id FROM projects WHERE owner_id = ?').all(target.id);
  db.transaction(() => {
    for (const p of owned) {
      db.prepare('DELETE FROM versions WHERE project_id = ?').run(p.id);
      db.prepare('DELETE FROM reviews WHERE project_id = ?').run(p.id);
      db.prepare('DELETE FROM compile_jobs WHERE project_id = ?').run(p.id);
      db.prepare('DELETE FROM project_members WHERE project_id = ?').run(p.id);
      for (const c of db.prepare('SELECT id FROM chats WHERE project_id = ?').all(p.id)) {
        db.prepare('DELETE FROM chat_messages WHERE chat_id = ?').run(c.id);
      }
      db.prepare('DELETE FROM chats WHERE project_id = ?').run(p.id);
      for (const c of db.prepare('SELECT id FROM changesets WHERE project_id = ?').all(p.id)) {
        db.prepare('DELETE FROM changeset_files WHERE changeset_id = ?').run(c.id);
      }
      db.prepare('DELETE FROM changesets WHERE project_id = ?').run(p.id);
      db.prepare('DELETE FROM projects WHERE id = ?').run(p.id);
    }
    db.prepare('DELETE FROM project_members WHERE user_id = ?').run(target.id);
    db.prepare('DELETE FROM ai_usage WHERE user_id = ?').run(target.id);
    db.prepare('DELETE FROM settings WHERE user_id = ?').run(target.id);
    db.prepare('DELETE FROM users WHERE id = ?').run(target.id);
  })();
  refreshUserRoomPermissions(target.id);
  for (const p of owned) {
    removeProjectRooms(p.id);
    fs.rmSync(projectDir(p.id), { recursive: true, force: true });
  }
  res.json({ ok: true });
}));

export default router;
