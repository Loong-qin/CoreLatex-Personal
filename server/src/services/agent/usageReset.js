import { assertMaintenanceOwner } from '../maintenance.js';

export const AI_USAGE_RESET_KEY = 'ai_usage_reset_at';

export function aiUsageResetAt(db) {
  const value = db.prepare('SELECT value FROM system_settings WHERE key = ?').pluck().get(AI_USAGE_RESET_KEY);
  if (value === undefined) return null;
  const resetAt = Number(value);
  if (!Number.isSafeInteger(resetAt) || resetAt <= 0) throw new Error('Invalid AI usage reset timestamp.');
  return resetAt;
}

export function resetAiUsage(db, { apply = false, ownerToken } = {}) {
  const reset = db.transaction(() => {
    const resetAt = aiUsageResetAt(db);
    const countRows = db.prepare('SELECT COUNT(*) FROM ai_usage').pluck();
    const beforeRows = countRows.get();
    const report = { dryRun: !apply, resetAt, beforeRows, afterRows: beforeRows, removedRows: 0, otherRowsChanged: 0 };
    if (!apply) return report;
    assertMaintenanceOwner(db, ownerToken);
    if (resetAt !== null) return report;
    const active = db.prepare("SELECT 1 FROM agent_runs WHERE state IN ('running','waiting_for_user','cancelling') LIMIT 1");
    if (active.get()) throw new Error('Wait until all active agent runs have finished before resetting AI usage.');

    const countChanges = db.prepare('SELECT total_changes()').pluck();
    const startingChanges = countChanges.get();
    const removedRows = db.prepare('DELETE FROM ai_usage').run().changes;
    const afterRows = countRows.get();
    if (afterRows !== 0 || removedRows !== beforeRows) throw new Error('AI usage rows remain after deletion.');
    const cutoff = Date.now();
    db.prepare('INSERT INTO system_settings (key, value) VALUES (?, ?)').run(AI_USAGE_RESET_KEY, String(cutoff));
    if (countChanges.get() - startingChanges !== removedRows + 1) {
      throw new Error('The AI usage reset would modify unrelated rows.');
    }
    return { ...report, resetAt: cutoff, afterRows, removedRows };
  });
  return apply ? reset.immediate() : reset();
}
