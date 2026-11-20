import { Router } from 'express';
import { register, login, publicUser, requireAuth } from '../auth.js';
import { usageForUser, usageForUserAsync } from '../quotas.js';
import { getDb } from '../db.js';
import { getSystemSettings } from '../systemSettings.js';
import { asyncHandler, HttpError, sendCancellableJson } from '../util.js';

const router = Router();

router.post('/register', asyncHandler(async (req, res) => {
  const db = getDb();
  // 系统关闭注册时仅允许引导创建首个管理员账号
  const count = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (count > 0 && !getSystemSettings(db).allowRegistration) {
    throw new HttpError(403, '注册已关闭，请联系管理员开通账号');
  }
  const user = register(req.body || {});
  res.status(201).json({ user: publicUser(user) });
}));

router.post('/login', asyncHandler(async (req, res) => {
  const { token, user } = login(req.body || {});
  res.json({ token, user: publicUser(user) });
}));

router.get('/me', requireAuth, asyncHandler(async (req, res) => {
  if (req.query.summary === '1') {
    res.json({ user: publicUser(req.user), usage: usageForUser(req.user, { storageUsed: null }) });
    return;
  }
  await sendCancellableJson(res, async signal => ({ user: publicUser(req.user), usage: await usageForUserAsync(req.user, { signal }) }));
}));

export default router;
