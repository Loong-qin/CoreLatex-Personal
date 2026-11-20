import { AI_USAGE_TOTALS_SQL, recordAiUsage } from '../../quotas.js';
import { aiUsageResetAt } from './usageReset.js';

const terminalRuns = new Set(['completed', 'failed', 'cancelled']);
const reportedStops = new Set(['stop', 'toolUse', 'length']);
const interruptedStops = new Set(['error', 'aborted']);
const tokenFields = ['input', 'output', 'cacheRead', 'cacheWrite'];
const validCount = value => Number.isSafeInteger(value) && value >= 0;
const sqliteTimestamp = time => new Date(time).toISOString().slice(0, 19).replace('T', ' ');

function utcTime(timestamp) {
  if (typeof timestamp !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(timestamp)) return NaN;
  const time = Date.parse(timestamp.replace(' ', 'T') + 'Z');
  if (Number.isFinite(time) && sqliteTimestamp(time) === timestamp) return time;
  return NaN;
}

function readLedger(snapshot, run, legacy) {
  const startedAt = utcTime(run.created_at);
  const insertedAt = utcTime(legacy.created_at);
  const lastRunEvent = utcTime(run.updated_at);
  if (!Number.isFinite(startedAt) || !Number.isFinite(insertedAt) || !Number.isFinite(lastRunEvent) ||
      snapshot.version !== 4 || snapshot.status !== run.state || snapshot.active !== 0 || snapshot.waiting !== 0 ||
      !Number.isSafeInteger(snapshot.finishedAt) || snapshot.finishedAt < startedAt ||
      snapshot.finishedAt >= insertedAt + 1000 || insertedAt > lastRunEvent) return null;

  const entries = JSON.parse(snapshot.requests);
  const ledgerTotals = JSON.parse(snapshot.usage);
  if (!Array.isArray(entries) || !entries.length || !ledgerTotals) return null;
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const [index, entry] of entries.entries()) {
    if (!entry || entry.requestId !== index + 1 || entry.dispatched === false ||
        !['openai', 'anthropic'].includes(entry.provider) || typeof entry.owner !== 'string' || !entry.owner ||
        typeof entry.phase !== 'string' || !entry.phase || typeof entry.model !== 'string' || !entry.model ||
        !Number.isSafeInteger(entry.queuedAt) || entry.queuedAt < startedAt ||
        !Number.isSafeInteger(entry.startedAt) || entry.startedAt < entry.queuedAt ||
        !Number.isSafeInteger(entry.finishedAt) || entry.finishedAt < entry.startedAt || entry.finishedAt > snapshot.finishedAt) return null;
    // The old ledger explicitly stored null when an interrupted attempt had no reported usage.
    if (entry.usage === null && interruptedStops.has(entry.status)) continue;
    // A successful old SDK result with all-zero usage may mean the gateway omitted usage.
    if (!reportedStops.has(entry.status) ||
        !entry.usage || !tokenFields.every(field => validCount(entry.usage[field])) ||
        !tokenFields.some(field => entry.usage[field] > 0) ||
        !validCount(entry.usage.input + entry.usage.cacheRead + entry.usage.cacheWrite)) return null;
    for (const field of tokenFields) totals[field] += entry.usage[field];
  }
  if (!entries.some(entry => entry.owner === 'coordinator' && entry.phase !== 'history_compaction') ||
      entries.some(entry => entry.owner === 'coordinator' && entry.model !== legacy.model) ||
      !Object.values(totals).every(validCount) || totals.input !== ledgerTotals.inputTokens ||
      totals.output !== ledgerTotals.outputTokens || totals.cacheRead !== ledgerTotals.cacheRead ||
      totals.cacheWrite !== ledgerTotals.cacheWrite) return null;
  return { entries, totals };
}

export function reconcileAiUsage(db, { apply = false, from } = {}) {
  const firstDay = from === undefined ? -Infinity : utcTime(`${from} 00:00:00`) - 8 * 60 * 60 * 1000;
  if (Number.isNaN(firstDay)) throw new Error('--from must be a valid Beijing calendar date in YYYY-MM-DD format.');
  const windowStart = Number.isFinite(firstDay) ? sqliteTimestamp(firstDay) : '';
  const columns = new Set(db.pragma('table_info(ai_usage)').map(column => column.name));
  const hasRequestKey = columns.has('request_key');
  const legacyFilter = [hasRequestKey && 'request_key IS NULL', columns.has('usage_status') && "usage_status = 'legacy'"]
    .filter(Boolean).join(' AND ') || '1 = 1';
  if (apply && (!hasRequestKey || !columns.has('usage_status'))) {
    throw new Error('Apply requires the per-request ai_usage schema. Start the updated server to migrate the database first.');
  }

  const reads = columns.has('cache_read_tokens') ? 'cache_read_tokens' : '0';
  const totalsSQL = columns.has('usage_status') && reads !== '0' ? AI_USAGE_TOTALS_SQL
    : `COALESCE(SUM(input_tokens), 0) AS inputTokens, COALESCE(SUM(${reads}), 0) AS cacheReadTokens,
       COALESCE(SUM(input_tokens - ${reads}), 0) AS uncachedInputTokens, COALESCE(SUM(output_tokens), 0) AS outputTokens,
       COALESCE(SUM(input_tokens + output_tokens), 0) AS totalTokens, 0 AS requests, COUNT(*) AS legacyRuns,
       0 AS unknownUsageRequests, 0 AS partialUsageRequests`;
  const getTotals = db.prepare(`SELECT ${totalsSQL} FROM ai_usage WHERE created_at >= ?`);
  const listLegacy = db.prepare(`SELECT id, user_id, project_id, chat_id, model, input_tokens, output_tokens, ${reads} AS cacheRead, created_at
    FROM ai_usage WHERE ${legacyFilter} AND created_at >= ? ORDER BY id`);
  const findRuns = db.prepare(`SELECT id, state, last_seq, message_id, created_at, updated_at FROM agent_runs
    WHERE user_id = ? AND project_id = ? AND chat_id = ? AND created_at <= ? AND updated_at >= ? LIMIT 2`);
  const findLegacy = db.prepare(`SELECT id FROM ai_usage WHERE ${legacyFilter} AND user_id = ? AND project_id = ?
    AND chat_id = ? AND created_at BETWEEN ? AND ? LIMIT 2`);
  const hasDone = db.prepare(`SELECT 1 FROM agent_run_events WHERE run_id = @id AND seq = @last_seq
    AND CASE WHEN json_valid(event) THEN json_extract(event,'$.type') = 'done'
      AND json_extract(event,'$.runId') = @id AND json_extract(event,'$.state') = @state
      AND json_extract(event,'$.messageId') = @message_id END`);
  const lastWorkflow = db.prepare(`WITH latest AS (
    SELECT event FROM agent_run_events WHERE run_id = ? AND seq < ?
      AND CASE WHEN json_valid(event) THEN json_extract(event,'$.type') = 'workflow' END
    ORDER BY seq DESC LIMIT 1
  ) SELECT json_extract(event,'$.graph.schemaVersion') AS version,
      json_extract(event,'$.graph.execution.status') AS status,
      json_extract(event,'$.graph.execution.finishedAt') AS finishedAt,
      json_extract(event,'$.graph.accounting.modelPool.active') AS active,
      json_extract(event,'$.graph.accounting.modelPool.waiting') AS waiting,
      json_extract(event,'$.graph.accounting.requests') AS requests,
      json_extract(event,'$.graph.accounting.usage') AS usage FROM latest
    WHERE json_type(event,'$.graph.accounting.requests') = 'array'
      AND json_type(event,'$.graph.accounting.usage') = 'object'`);
  const requestExists = hasRequestKey ? db.prepare('SELECT 1 FROM ai_usage WHERE request_key = ?') : null;
  const removeLegacy = apply ? db.prepare(`DELETE FROM ai_usage WHERE id = ? AND ${legacyFilter}`) : null;
  const activeRuns = db.prepare("SELECT 1 FROM agent_runs WHERE state IN ('running','waiting_for_user','cancelling') LIMIT 1");

  const reconcile = db.transaction(() => {
    const before = getTotals.get(windowStart);
    const report = { dryRun: !apply, fromBeijing: from ?? null, examinedLegacyRows: 0, matchedRuns: 0, reconciledRuns: 0,
      providerRequests: 0, recoveredCacheReadTokens: 0, recoveredUncachedInputTokens: 0,
      skipped: { noRun: 0, ambiguousMatch: 0, incompleteLedger: 0, totalsMismatch: 0, existingRequest: 0 } };
    // After the one-time reset, the old run ledgers no longer belong to the
    // usage statistics. New usage is written directly by provider request.
    const resetAt = aiUsageResetAt(db);
    if (resetAt !== null) return { ...report, resetAt, before, after: before };
    if (apply && activeRuns.get()) throw new Error('Wait until all active agent runs have finished before applying the reconciliation.');
    const projected = { ...before };
    // Materialize legacy rows before writing to the same table. Both matching
    // directions include all plausible rows, even those later deemed incomplete.
    for (const row of listLegacy.all(windowStart)) {
      report.examinedLegacyRows++;
      const identity = [row.user_id, row.project_id, row.chat_id];
      const runs = findRuns.all(...identity, row.created_at, row.created_at);
      if (!runs.length) { report.skipped.noRun++; continue; }
      if (runs.length !== 1) { report.skipped.ambiguousMatch++; continue; }
      const run = runs[0];
      const legacy = findLegacy.all(...identity, run.created_at, run.updated_at);
      if (legacy.length !== 1 || legacy[0].id !== row.id) { report.skipped.ambiguousMatch++; continue; }
      const snapshot = terminalRuns.has(run.state) && run.message_id && hasDone.get(run) && lastWorkflow.get(run.id, run.last_seq);
      const ledger = snapshot && readLedger(snapshot, run, row);
      if (!ledger) { report.skipped.incompleteLedger++; continue; }
      if (ledger.totals.input !== row.input_tokens || ledger.totals.output !== row.output_tokens) {
        report.skipped.totalsMismatch++;
        continue;
      }
      const entries = ledger.entries.map(entry => ({
        ...entry,
        requestKey: `legacy:${run.id}:${entry.requestId}`,
        usageStatus: entry.usage === null ? 'unknown' : 'reported',
      }));
      if (entries.some(entry => requestExists?.get(entry.requestKey))) { report.skipped.existingRequest++; continue; }
      if (apply) {
        for (const entry of entries) {
          recordAiUsage({ db, userId: row.user_id, projectId: row.project_id, chatId: row.chat_id, entry });
          if (!requestExists.get(entry.requestKey)) throw new Error('A reconciled model request could not be inserted.');
        }
        if (removeLegacy.run(row.id).changes !== 1) throw new Error('The matching legacy aggregate could not be replaced.');
        report.reconciledRuns++;
      }
      report.matchedRuns++;
      report.providerRequests += entries.length;
      report.recoveredCacheReadTokens += ledger.totals.cacheRead;
      report.recoveredUncachedInputTokens += ledger.totals.input + ledger.totals.cacheWrite;

      // A model call can start the previous day even if its old run aggregate
      // was recorded after midnight. Preview the same date scope as the final query.
      projected.legacyRuns--;
      projected.inputTokens -= row.input_tokens;
      projected.outputTokens -= row.output_tokens;
      projected.cacheReadTokens -= row.cacheRead;
      projected.uncachedInputTokens -= row.input_tokens - row.cacheRead;
      for (const entry of entries) {
        if (entry.startedAt < firstDay) continue;
        projected.requests++;
        if (entry.usageStatus === 'unknown') {
          projected.unknownUsageRequests++;
          continue;
        }
        const { input, output, cacheRead, cacheWrite } = entry.usage;
        projected.inputTokens += input + cacheRead + cacheWrite;
        projected.outputTokens += output;
        projected.cacheReadTokens += cacheRead;
        projected.uncachedInputTokens += input + cacheWrite;
      }
    }
    projected.totalTokens = projected.inputTokens + projected.outputTokens;
    return { ...report, before, after: apply ? getTotals.get(windowStart) : projected };
  });
  return apply ? reconcile.immediate() : reconcile();
}
