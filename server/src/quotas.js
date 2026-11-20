import { getDb } from './db.js';
import { projectDir } from './config.js';
import { projectStorageBytes, projectStorageBytesAsync, HttpError } from './util.js';
import { normalizeModelUsage } from './services/agent/modelUsage.js';
import { AI_USAGE_RESET_KEY } from './services/agent/usageReset.js';

export function isAdmin(user) {
  return user.role === 'admin';
}

/** 项目数配额（不含回收站中的项目） */
export function canCreateProject(user) {
  if (isAdmin(user)) return true;
  if (user.project_quota < 0) return true;
  const db = getDb();
  const c = db
    .prepare('SELECT COUNT(*) AS c FROM projects WHERE owner_id = ? AND deleted = 0')
    .get(user.id).c;
  return c < user.project_quota;
}

export function assertCanCreateProject(user) {
  if (!canCreateProject(user)) throw new HttpError(403, '已达到项目数量上限，请联系管理员');
}

/** 用户全部项目（含回收站）占用空间字节数 */
export function storageUsedBytes(userId) {
  const db = getDb();
  const rows = db.prepare('SELECT id FROM projects WHERE owner_id = ?').all(userId);
  let total = 0;
  for (const r of rows) total += projectStorageBytes(projectDir(r.id));
  total += db.prepare('SELECT COALESCE(SUM(size_bytes),0) AS bytes FROM agent_artifacts WHERE user_id=?').get(userId).bytes;
  return total;
}

/** Accurate read-only total, asynchronously collected; write admission keeps
 * using the synchronous storageUsedBytes so its quota decision cannot race. */
export async function storageUsedBytesAsync(userId, { signal } = {}) {
  const db = getDb();
  const rows = db.prepare('SELECT id FROM projects WHERE owner_id = ?').all(userId);
  let total = 0;
  for (const row of rows) {
    signal?.throwIfAborted();
    total += await projectStorageBytesAsync(projectDir(row.id), { signal });
  }
  signal?.throwIfAborted();
  total += db.prepare('SELECT COALESCE(SUM(size_bytes),0) AS bytes FROM agent_artifacts WHERE user_id=?').get(userId).bytes;
  return total;
}

export function assertStorageQuota(user, additionalBytes = 0) {
  if (isAdmin(user)) return;
  if (user.storage_quota_bytes < 0) return;
  const used = storageUsedBytes(user.id);
  if (used + additionalBytes > user.storage_quota_bytes) {
    throw new HttpError(403, '存储空间不足，请联系管理员调整配额');
  }
}

const todayStr = () => new Date().toISOString().slice(0, 10);

/** 当前配额快照。基础配额长期有效；管理员补额只在发放当天有效。 */
export function compileQuotaForUser(user) {
  const currentDay = user.compile_reset_date === todayStr();
  const base = user.compile_seconds_quota;
  const bonus = currentDay ? Math.max(0, Number(user.compile_seconds_bonus) || 0) : 0;
  const used = currentDay ? Math.max(0, Number(user.compile_seconds_used) || 0) : 0;
  const quota = base < 0 ? -1 : base + bonus;
  return {
    compileSecondsUsed: Math.round(used),
    compileSecondsQuota: quota,
    compileSecondsBaseQuota: base,
    compileSecondsBonus: bonus,
    compileSecondsRemaining: quota < 0 ? -1 : Math.max(0, quota - used),
  };
}

/** 编译计时按「天」归零：日期变更时同时清除用量与当日补额。 */
export function applyDailyCompileReset(db, userId) {
  const today = todayStr();
  const r = db
    .prepare("UPDATE users SET compile_seconds_used = 0, compile_seconds_bonus = 0, compile_reset_date = ? WHERE id = ? AND (compile_reset_date IS NULL OR compile_reset_date != ?)")
    .run(today, userId, today);
  return r.changes > 0;
}

/** 兼容 reset-compile API：追加一份基础日配额，不抹掉已用时长。 */
export function grantDailyCompileQuota(db, userId) {
  return db.transaction(() => {
    applyDailyCompileReset(db, userId);
    db.prepare(`UPDATE users SET compile_seconds_bonus = compile_seconds_bonus + compile_seconds_quota
                WHERE id = ? AND compile_seconds_quota > 0`).run(userId);
    return db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  })();
}

export function assertCompileQuota(user) {
  const db = getDb();
  applyDailyCompileReset(db, user.id);
  // 长任务保留的 user 对象可能早于管理员修改配额，始终读取最新值。
  const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  if (!fresh) throw new HttpError(404, '用户不存在');
  if (isAdmin(fresh) || fresh.compile_seconds_quota < 0) return;
  const quota = fresh.compile_seconds_quota + fresh.compile_seconds_bonus;
  if (fresh.compile_seconds_used >= quota) {
    const error = new HttpError(403, '今日编译时长配额已用完，请明天再试或联系管理员补充今日额度');
    error.code = 'COMPILE_QUOTA_EXHAUSTED';
    error.retryable = false;
    throw error;
  }
}

export function recordCompileSeconds(userId, seconds) {
  if (!userId || !Number.isFinite(seconds) || seconds <= 0) return;
  const db = getDb();
  db.transaction(() => {
    // 跨日结束的编译计入结束当天，避免随后读用量时把这次计时清掉。
    applyDailyCompileReset(db, userId);
    db.prepare('UPDATE users SET compile_seconds_used = compile_seconds_used + ? WHERE id = ?')
      .run(seconds, userId);
  })();
}

export function usageForUser(user, { storageUsed: measuredStorage } = {}) {
  const db = getDb();
  applyDailyCompileReset(db, user.id);
  const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id) || user;
  const projectCount = db
    .prepare('SELECT COUNT(*) AS c FROM projects WHERE owner_id = ? AND deleted = 0')
    .get(fresh.id).c;
  const storageUsed = measuredStorage === undefined ? storageUsedBytes(fresh.id) : measuredStorage;
  return {
    projectCount,
    projectQuota: fresh.project_quota,
    storageUsed,
    storageQuota: fresh.storage_quota_bytes,
    ...compileQuotaForUser(fresh),
    ...aiUsageForUser(fresh.id),
    ...systemDailyFor('project_id IN (SELECT id FROM projects WHERE owner_id = ?)', fresh.id),
  };
}

export async function usageForUserAsync(user, { signal } = {}) {
  const storageUsed = await storageUsedBytesAsync(user.id, { signal });
  signal?.throwIfAborted();
  return usageForUser(user, { storageUsed });
}

// ---------- AI 用量统计（每次供应商请求尝试独立记录） ----------

function usageLabel(value) {
  return typeof value === 'string' ? value : '';
}

export function recordAiUsage({ userId, projectId, chatId, entry, db }) {
  if (!userId || !usageLabel(entry?.requestKey) || entry.dispatched === false) return;
  const { input = 0, output = 0, cacheRead = 0, cacheWrite = 0 } = normalizeModelUsage(entry.usage) || {};
  const status = usageLabel(entry.status) || 'error';
  const usageStatus = entry.usageStatus ?? (entry.usage ? (['error', 'aborted'].includes(status) ? 'partial' : 'reported') : 'unknown');
  const startedAt = Number.isSafeInteger(entry.startedAt) ? entry.startedAt : null;
  const createdAt = new Date(startedAt ?? Date.now()).toISOString().slice(0, 19).replace('T', ' ');
  const requestedModel = usageLabel(entry.model);
  // Check the reset cutoff in the INSERT itself so an independently committed
  // reset cannot race an old request between its cutoff check and its write.
  return (db ?? getDb()).prepare(`INSERT INTO ai_usage
    (request_key, user_id, project_id, chat_id, provider, provider_id, model, requested_model, owner, phase,
     status, usage_status, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, created_at)
    SELECT @requestKey, @userId, @projectId, @chatId, @provider, @providerId, @model, @requestedModel, @owner, @phase,
      @status, @usageStatus, @inputTokens, @output, @cacheRead, @cacheWrite, @createdAt
    WHERE NOT EXISTS (
      SELECT 1 FROM system_settings WHERE key = @resetKey
      AND (@startedAt IS NULL OR @startedAt <= CAST(value AS INTEGER))
    )
    ON CONFLICT(request_key) DO NOTHING`).run({
    requestKey: entry.requestKey, userId, projectId: projectId ?? null, chatId: chatId ?? null,
    provider: usageLabel(entry.provider), providerId: usageLabel(entry.providerId),
    model: usageLabel(entry.responseModel) || requestedModel, requestedModel,
    owner: usageLabel(entry.owner), phase: usageLabel(entry.phase), status, usageStatus,
    inputTokens: input + cacheRead + cacheWrite, output, cacheRead, cacheWrite, createdAt, startedAt,
    resetKey: AI_USAGE_RESET_KEY,
  });
}

// Input includes cache reads and writes. Writes populated the cache, so they
// count toward misses. Requests without observed usage contribute zero tokens.
export const AI_USAGE_TOTALS_SQL = `COALESCE(SUM(input_tokens), 0) AS inputTokens,
  COALESCE(SUM(cache_read_tokens), 0) AS cacheReadTokens,
  COALESCE(SUM(input_tokens - cache_read_tokens), 0) AS uncachedInputTokens,
  COALESCE(SUM(output_tokens), 0) AS outputTokens,
  COALESCE(SUM(input_tokens + output_tokens), 0) AS totalTokens,
  COALESCE(SUM(usage_status <> 'legacy'), 0) AS requests,
  COALESCE(SUM(usage_status = 'legacy'), 0) AS legacyRuns,
  COALESCE(SUM(usage_status = 'unknown'), 0) AS unknownUsageRequests,
  COALESCE(SUM(usage_status = 'partial'), 0) AS partialUsageRequests`;

const EMPTY_AI_USAGE = {
  inputTokens: 0, cacheReadTokens: 0, uncachedInputTokens: 0, outputTokens: 0, totalTokens: 0,
  requests: 0, legacyRuns: 0, unknownUsageRequests: 0, partialUsageRequests: 0,
};

export function prefixedAiUsage(usage = EMPTY_AI_USAGE) {
  return {
    aiInputTokens: usage.inputTokens,
    aiCacheReadTokens: usage.cacheReadTokens, aiUncachedInputTokens: usage.uncachedInputTokens,
    aiOutputTokens: usage.outputTokens, aiTotalTokens: usage.totalTokens,
    aiRequests: usage.requests, aiLegacyRuns: usage.legacyRuns,
    aiUnknownUsageRequests: usage.unknownUsageRequests, aiPartialUsageRequests: usage.partialUsageRequests,
  };
}

export function aiUsageTotals(where, ...params) {
  return getDb().prepare(`SELECT ${AI_USAGE_TOTALS_SQL} FROM ai_usage WHERE (${where})`).get(...params);
}

const DAILY_DAYS = 30;

/** 把按天聚合行补齐成连续 N 天序列（缺的一天补零），最旧在前 */
function fillDailyDays(rows, keyFor) {
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const out = [];
  const now = new Date();
  for (let i = DAILY_DAYS - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    const day = d.toISOString().slice(0, 10);
    const row = byDay.get(day);
    out.push(keyFor(day, row));
  }
  return out;
}

/** AI 用量累计和近 30 天序列（where 为调用方定义的 SQL）。 */
export function aiUsageSummary(where, ...params) {
  const rows = getDb().prepare(
    `SELECT substr(created_at, 1, 10) AS day, ${AI_USAGE_TOTALS_SQL}
     FROM ai_usage WHERE (${where}) AND created_at >= datetime('now', '-${DAILY_DAYS} days') GROUP BY day`
  ).all(...params);
  return {
    ai: aiUsageTotals(where, ...params),
    aiDaily: fillDailyDays(rows, (day, row) => row || { day, ...EMPTY_AI_USAGE }),
  };
}

export function aiUsageForUser(userId) {
  return aiUsageSummary('user_id = ?', userId);
}

/**
 * 系统使用（编译）按天序列。where 片段 + 参数由调用方给出：
 *   systemDailyFor('project_id IN (SELECT id FROM projects WHERE owner_id = ?)', userId)  — 单用户
 *   systemDailyFor('1=1')                                                                 — 全体
 */
export function systemDailyFor(where, ...params) {
  const db = getDb();
  const rows = db.prepare(
    `SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS compiles, SUM(duration_ms) AS durationMs
     FROM compile_jobs WHERE (${where}) AND created_at >= datetime('now', '-${DAILY_DAYS} days') GROUP BY day`
  ).all(...params);
  return {
    systemDaily: fillDailyDays(rows, (day, r) => ({
      day, compiles: r ? r.compiles : 0, compileSeconds: r ? Math.round(r.durationMs / 1000) : 0,
    })),
  };
}
