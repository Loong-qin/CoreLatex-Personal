import { getDb } from './db.js';

/**
 * 系统级设置（全局唯一，键值存储）。
 * allow_registration     允许新用户自助注册（1/0）
 * default_storage_mb     新用户默认空间配额（MB）
 * default_compile_seconds 新用户默认编译时长配额（秒/天）
 */

export const SYSTEM_DEFAULTS = {
  allowRegistration: true,
  defaultStorageMb: 100,
  defaultCompileSeconds: 300,
};

export function getSystemSettings(db = getDb()) {
  const rows = db.prepare('SELECT key, value FROM system_settings').all();
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const num = (key, fallback) => {
    const v = map[key];
    const n = Number(v);
    return v !== undefined && Number.isFinite(n) ? n : fallback;
  };
  return {
    allowRegistration: map.allow_registration === undefined ? SYSTEM_DEFAULTS.allowRegistration : Number(map.allow_registration) === 1,
    defaultStorageMb: num('default_storage_mb', SYSTEM_DEFAULTS.defaultStorageMb),
    defaultCompileSeconds: num('default_compile_seconds', SYSTEM_DEFAULTS.defaultCompileSeconds),
  };
}

export function saveSystemSettings(patch, db = getDb()) {
  const upsert = db.prepare('INSERT INTO system_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  const set = (key, value) => upsert.run(key, String(value));
  const t = db.transaction(() => {
    if (patch.allowRegistration !== undefined) set('allow_registration', patch.allowRegistration ? 1 : 0);
    if (patch.defaultStorageMb !== undefined) set('default_storage_mb', patch.defaultStorageMb);
    if (patch.defaultCompileSeconds !== undefined) set('default_compile_seconds', patch.defaultCompileSeconds);
  });
  t();
  return getSystemSettings(db);
}
