import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { getDb } from '../db.js';
import { projectDir } from '../config.js';
import { usageForUserAsync, storageUsedBytes, isAdmin, AI_USAGE_TOTALS_SQL, aiUsageTotals, prefixedAiUsage } from '../quotas.js';
import { asyncHandler, HttpError, projectStorageBytes, sendCancellableJson } from '../util.js';
import { parseModelSettings } from '../services/agent/models.js';

const router = Router();

router.get('/me/usage', asyncHandler(async (req, res) => {
  await sendCancellableJson(res, signal => usageForUserAsync(req.user, { signal }));
}));

// 更新自己的资料（昵称）
router.put('/me/profile', asyncHandler((req, res) => {
  const displayName = String(req.body?.displayName ?? '').trim().slice(0, 120);
  getDb().prepare('UPDATE users SET display_name = ? WHERE id = ?').run(displayName, req.user.id);
  res.json({ ok: true, displayName });
}));

// 修改自己的密码（需验证原密码）
router.put('/me/password', asyncHandler(async (req, res) => {
  const oldPassword = String(req.body?.oldPassword ?? '');
  const newPassword = String(req.body?.newPassword ?? '');
  if (newPassword.length < 4) throw new HttpError(400, '新密码至少 4 位');
  const row = getDb().prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!row || !bcrypt.compareSync(oldPassword, row.password_hash)) {
    throw new HttpError(400, '原密码不正确');
  }
  getDb().prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(newPassword, 10), req.user.id);
  res.json({ ok: true });
}));

/**
 * 数据统计页（Web 端 /stats）。
 *   scope=user   用户维度：缺省查自己；管理员可用 userId 查任意用户
 *   scope=global 全局维度：仅管理员
 * days 为包含北京时间今天在内的自然日范围（1–90，默认 30）。编译口径为 compile_jobs.user_id（发起人）。
 */
router.get('/stats', asyncHandler((req, res) => {
  const db = getDb();
  const scope = req.query.scope === 'global' ? 'global' : 'user';
  const days = Math.min(90, Math.max(1, Math.floor(Number(req.query.days) || 30)));
  if (scope === 'global' && !isAdmin(req.user)) throw new HttpError(403, '仅管理员可查看全局统计');

  let where = '1=1';
  let ownerWhere = '1=1';
  let params = [];
  let target = null;
  if (scope === 'user') {
    const userId = req.query.userId ? Number(req.query.userId) : req.user.id;
    if (!Number.isInteger(userId) || !isAdmin(req.user) && userId !== req.user.id) {
      throw new HttpError(403, '只能查看自己的统计');
    }
    target = db.prepare('SELECT id, username, display_name FROM users WHERE id = ?').get(userId);
    if (!target) throw new HttpError(404, '用户不存在');
    where = 'user_id = ?';
    ownerWhere = 'owner_id = ?';
    params = [userId];
  }

  // Persisted timestamps stay UTC. Treat the shifted Date as a Beijing wall
  // clock and use UTC methods so neither the host nor browser timezone matters.
  const offsetMs = 8 * 60 * 60 * 1000;
  const now = new Date(Date.now() + offsetMs);
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  const since = new Date(start.getTime() - offsetMs).toISOString().slice(0, 19).replace('T', ' ');
  const rangeParams = [...params, since];
  const until = new Date(now.getTime() - offsetMs).toISOString().slice(0, 19).replace('T', ' ');
  const aiRangeWhere = `(${where}) AND created_at BETWEEN ? AND ?`;
  const aiRangeParams = [...rangeParams, until];
  const dayExpression = "date(created_at, '+8 hours')";
  const aiRows = db.prepare(
    `SELECT ${dayExpression} AS day, ${AI_USAGE_TOTALS_SQL}
     FROM ai_usage WHERE ${aiRangeWhere} GROUP BY day`
  ).all(...aiRangeParams);
  const cjRows = db.prepare(
    `SELECT ${dayExpression} AS day, COUNT(*) AS compiles, SUM(duration_ms) AS durationMs
     FROM compile_jobs WHERE (${where}) AND created_at >= ? GROUP BY day`
  ).all(...rangeParams);
  const aiMap = new Map(aiRows.map((r) => [r.day, r]));
  const cjMap = new Map(cjRows.map((r) => [r.day, r]));

  const daily = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    const day = d.toISOString().slice(0, 10);
    const a = aiMap.get(day);
    const c = cjMap.get(day);
    daily.push({
      day,
      ...prefixedAiUsage(a),
      compiles: c ? c.compiles : 0,
      compileSeconds: c ? Math.round((c.durationMs || 0) / 1000) : 0,
    });
  }

  // Only the three short-range trend charts use hourly points. Aggregate cards
  // and distribution queries retain their existing range and response shape.
  const hourlyMode = days <= 3;
  const hourly = [];
  let toolHourly = [];
  let skillHourly = [];
  if (hourlyMode) {
    const hour = "strftime('%Y-%m-%d %H', created_at, '+8 hours')";
    const aiHourRows = db.prepare(
      `SELECT ${hour} AS time, ${AI_USAGE_TOTALS_SQL}
       FROM ai_usage WHERE ${aiRangeWhere} GROUP BY time`
    ).all(...aiRangeParams);
    const cjHourRows = db.prepare(
      `SELECT ${hour} AS time, COUNT(*) AS compiles, SUM(duration_ms) AS durationMs
       FROM compile_jobs WHERE (${where}) AND created_at >= ? GROUP BY time`
    ).all(...rangeParams);
    toolHourly = db.prepare(
      `SELECT ${hour} AS time, tool AS name, COUNT(*) AS count
       FROM tool_usage WHERE (${where}) AND created_at >= ? GROUP BY time, tool`
    ).all(...rangeParams).map(row => ({ ...row, time: `${row.time}:00` }));
    skillHourly = db.prepare(
      `SELECT ${hour} AS time, skill AS name, COUNT(*) AS count
       FROM tool_usage WHERE (${where}) AND created_at >= ?
         AND tool = 'read_skill' AND skill <> '' GROUP BY time, skill`
    ).all(...rangeParams).map(row => ({ ...row, time: `${row.time}:00` }));

    const aiHourMap = new Map(aiHourRows.map(row => [row.time, row]));
    const cjHourMap = new Map(cjHourRows.map(row => [row.time, row]));
    const cursor = new Date(now);
    cursor.setUTCHours(0, 0, 0, 0);
    cursor.setUTCDate(cursor.getUTCDate() - (days - 1));
    const last = new Date(now);
    last.setUTCMinutes(0, 0, 0);
    while (cursor <= last) {
      const hourKey = cursor.toISOString().slice(0, 13).replace('T', ' ');
      const a = aiHourMap.get(hourKey);
      const c = cjHourMap.get(hourKey);
      hourly.push({
        time: `${hourKey}:00`,
        ...prefixedAiUsage(a),
        compiles: c ? c.compiles : 0,
        compileSeconds: c ? Math.round((c.durationMs || 0) / 1000) : 0,
      });
      cursor.setUTCHours(cursor.getUTCHours() + 1);
    }
  }

  const aiTotals = prefixedAiUsage(aiUsageTotals(where, ...params));
  const cjTotals = db.prepare(
    `SELECT COUNT(*) AS compileCount, COALESCE(SUM(duration_ms), 0) AS durationMs FROM compile_jobs WHERE (${where})`
  ).get(...params);

  let totals;
  if (scope === 'global') {
    let storageBytes = 0;
    for (const r of db.prepare('SELECT id FROM projects').all()) {
      storageBytes += projectStorageBytes(projectDir(r.id));
    }
    totals = {
      userCount: db.prepare('SELECT COUNT(*) AS c FROM users').get().c,
      projectCount: db.prepare('SELECT COUNT(*) AS c FROM projects WHERE deleted = 0').get().c,
      storageBytes,
      compileCount: cjTotals.compileCount,
      compileSeconds: Math.round(cjTotals.durationMs / 1000),
      ...aiTotals,
    };
  } else {
    totals = {
      projectCount: db.prepare(`SELECT COUNT(*) AS c FROM projects WHERE deleted = 0 AND ${ownerWhere}`).get(...params).c,
      storageBytes: storageUsedBytes(target.id),
      compileCount: cjTotals.compileCount,
      compileSeconds: Math.round(cjTotals.durationMs / 1000),
      ...aiTotals,
    };
  }

  // 供应商和响应型号共同标识用量来源。
  const models = db.prepare(
    `SELECT COALESCE(NULLIF(model, ''), '未知模型') AS model, provider, provider_id AS providerId,
       GROUP_CONCAT(DISTINCT user_id) AS contributorIds, ${AI_USAGE_TOTALS_SQL}
     FROM ai_usage WHERE ${aiRangeWhere}
     GROUP BY ai_usage.model, provider, provider_id ORDER BY requests DESC, legacyRuns DESC, model, provider, providerId`
  ).all(...aiRangeParams);
  // Provider IDs are scoped to an account. Only attach a display name when
  // every contributing account resolves this exact ID/protocol unambiguously.
  // Credentials and connection settings must never enter the stats response.
  const providerNames = new Map();
  const settingsFor = db.prepare(`SELECT ai_providers, ai_models, ai_model, ai_provider, ai_base_url, ai_api_key
    FROM settings WHERE user_id = ?`);
  for (const row of models) {
    const names = String(row.contributorIds || '').split(',').filter(Boolean).map(userId => {
      if (!row.providerId) return null;
      if (!providerNames.has(userId)) providerNames.set(userId, parseModelSettings(settingsFor.get(userId)).providers);
      const matches = providerNames.get(userId).filter(p => p.id === row.providerId && p.apiFormat === row.provider);
      return matches.length === 1 ? matches[0].name.trim() || null : null;
    });
    row.providerName = names.length && names[0] && names.every(name => name === names[0]) ? names[0] : null;
    delete row.contributorIds;
  }

  // 工具调用分布（独立使用统计表 tool_usage：清空会话、删除消息不影响统计）
  const tools = db.prepare(
    `SELECT tool AS name, COUNT(*) AS count
     FROM tool_usage WHERE (${where}) AND created_at >= ?
     GROUP BY tool ORDER BY count DESC, tool ASC`
  ).all(...rangeParams);

  // Skill 调用分布（read_skill 的 skill 字段即技能名）
  const skills = db.prepare(
    `SELECT skill AS name, COUNT(*) AS count
     FROM tool_usage WHERE (${where}) AND created_at >= ?
       AND tool = 'read_skill' AND skill <> ''
     GROUP BY skill ORDER BY count DESC LIMIT 12`
  ).all(...rangeParams);

  // 工具 / Skill 按天×名称明细（前端透视为堆叠柱 + 累计折线复合图）
  const toolDaily = db.prepare(
    `SELECT ${dayExpression} AS day, tool AS name, COUNT(*) AS count
     FROM tool_usage WHERE (${where}) AND created_at >= ?
     GROUP BY day, tool`
  ).all(...rangeParams);
  const skillDaily = db.prepare(
    `SELECT ${dayExpression} AS day, skill AS name, COUNT(*) AS count
     FROM tool_usage WHERE (${where}) AND created_at >= ?
       AND tool = 'read_skill' AND skill <> ''
     GROUP BY day, skill`
  ).all(...rangeParams);

  res.json({
    scope,
    days,
    timeZone: 'Asia/Shanghai',
    utcOffset: '+08:00',
    range: { start: start.toISOString().slice(0, 10), end: now.toISOString().slice(0, 10) },
    target: target ? { id: target.id, username: target.username, displayName: target.display_name } : null,
    totals,
    rangeTotals: prefixedAiUsage(aiUsageTotals(aiRangeWhere, ...aiRangeParams)),
    granularity: hourlyMode ? 'hour' : 'day',
    daily,
    hourly,
    toolHourly,
    skillHourly,
    models,
    tools,
    skills,
    toolDaily,
    skillDaily,
  });
}));

export default router;
