import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { getDb } from './db.js';
import { getJwtSecret } from './config.js';
import { getSystemSettings } from './systemSettings.js';
import { HttpError } from './util.js';
import { compileQuotaForUser } from './quotas.js';

const TOKEN_TTL = '7d';

export function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    role: u.role,
    status: u.status,
    projectQuota: u.project_quota,
    ...compileQuotaForUser(u),
    storageQuotaBytes: u.storage_quota_bytes,
    createdAt: u.created_at,
  };
}

export function register({ username, password, displayName }) {
  const db = getDb();
  username = String(username || '').trim();
  if (!/^[a-zA-Z0-9_.-]{2,32}$/.test(username)) {
    throw new HttpError(400, '用户名需为 2-32 位字母数字或 _.-');
  }
  if (!password || String(password).length < 4) throw new HttpError(400, '密码至少 4 位');
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (exists) throw new HttpError(409, '用户名已存在');
  // 首个用户自动成为管理员（系统仅允许一个管理员）
  const count = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  const role = count === 0 ? 'admin' : 'user';
  // 新用户套用系统默认配额：空间（MB→字节）、编译时长（秒/天）
  const ss = getSystemSettings(db);
  const hash = bcrypt.hashSync(String(password), 10);
  const info = db
    .prepare(`INSERT INTO users (username, password_hash, display_name, role, project_quota, storage_quota_bytes, compile_seconds_quota, compile_reset_date)
              VALUES (?,?,?,?,?,?,?,?)`)
    .run(username, hash, String(displayName || username), role, -1, ss.defaultStorageMb * 1024 * 1024, ss.defaultCompileSeconds, '');
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  db.prepare('INSERT OR IGNORE INTO settings (user_id) VALUES (?)').run(user.id);
  return user;
}

export function login({ username, password }) {
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || '').trim());
  if (!user || !bcrypt.compareSync(String(password || ''), user.password_hash)) {
    throw new HttpError(401, '用户名或密码错误');
  }
  if (user.status !== 'active') throw new HttpError(403, '账号已被禁用，请联系管理员');
  return { token: signToken(user), user };
}

export function signToken(user) {
  return jwt.sign({ uid: user.id, role: user.role }, getJwtSecret(), { expiresIn: TOKEN_TTL });
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, getJwtSecret());
  } catch {
    return null;
  }
}

export function requireAuth(req, _res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : req.query.token;
  const payload = token ? verifyToken(token) : null;
  if (!payload) return next(new HttpError(401, '未登录或登录已过期'));
  const user = getDb().prepare('SELECT * FROM users WHERE id = ?').get(payload.uid);
  if (!user) return next(new HttpError(401, '用户不存在'));
  if (user.status !== 'active') return next(new HttpError(403, '账号已被禁用'));
  req.user = user;
  next();
}

export function requireAdmin(req, _res, next) {
  if (!req.user || req.user.role !== 'admin') return next(new HttpError(403, '需要管理员权限'));
  next();
}
