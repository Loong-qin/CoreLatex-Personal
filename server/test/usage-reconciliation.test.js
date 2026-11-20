import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, beforeEach, after } from 'node:test';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'corelatex-usage-reconciliation-'));
process.env.CORELATEX_DATA_DIR = dataDir;
const { DB_PATH } = await import('../src/config.js');
const { getDb, resetDb } = await import('../src/db.js');
const { reconcileAiUsage } = await import('../src/services/agent/usageReconciliation.js');
const { AI_USAGE_RESET_KEY } = await import('../src/services/agent/usageReset.js');
const db = getDb();
const origin = Date.parse('2026-11-01T15:59:52Z');
const at = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

beforeEach(() => {
  db.exec('DELETE FROM agent_runs; DELETE FROM ai_usage');
  db.prepare('DELETE FROM system_settings WHERE key = ?').run(AI_USAGE_RESET_KEY);
});
after(() => {
  resetDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function insertLegacy(run, { input = 60, output = 15 } = {}) {
  db.prepare('INSERT INTO ai_usage(user_id,project_id,chat_id,model,input_tokens,output_tokens,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(run.userId, run.projectId, run.chatId, 'main-model', input, output, run.legacyAt);
}

function addRun({ id = 'run-a', chatId = 1, state = 'completed', includeDone = true, includeWorkflow = true,
  requests: adjustRequests, snapshot: adjustSnapshot, earlierComplete = false } = {}) {
  const events = [];
  const run = { id, userId: 2, projectId: 3, chatId, legacyAt: at(origin + 9200) };
  const messageId = 4;
  const requests = [
    { requestId: 1, owner: 'coordinator', phase: 'history_compaction', model: 'main-model', provider: 'openai',
      queuedAt: origin + 200, startedAt: origin + 500, finishedAt: origin + 900, status: 'stop',
      usage: { input: 10, output: 4, cacheRead: 40, cacheWrite: 0 } },
    { requestId: 2, owner: 'reviewer-1', phase: 'reporting', model: 'worker-model', provider: 'anthropic',
      queuedAt: origin + 1000, startedAt: origin + 1200, finishedAt: origin + 2000, status: 'toolUse',
      usage: { input: 20, output: 5, cacheRead: 50, cacheWrite: 25 } },
    { requestId: 3, owner: 'coordinator', phase: 'investigation', model: 'main-model', provider: 'openai',
      queuedAt: origin + 7000, startedAt: origin + 7950, finishedAt: origin + 9000, status: 'stop',
      usage: { input: 30, output: 6, cacheRead: 10, cacheWrite: 0 } },
  ];
  const snapshot = { schemaVersion: 4, execution: { status: state, finishedAt: origin + 9150 }, accounting: {
    modelPool: { active: 0, waiting: 0 }, requests, usage: { inputTokens: 60, outputTokens: 15, cacheRead: 100, cacheWrite: 25 },
  } };
  if (earlierComplete) events.push({ type: 'workflow', graph: structuredClone(snapshot) });
  adjustRequests?.(requests);
  adjustSnapshot?.(snapshot);
  if (includeWorkflow) events.push({ type: 'workflow', graph: snapshot });
  if (includeDone) events.push({ type: 'done', runId: id, state, messageId });
  db.prepare(`INSERT INTO agent_runs(id,project_id,chat_id,user_id,state,last_seq,message_id,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(id, run.projectId, chatId, run.userId, state, events.length, messageId, at(origin), at(origin + 9500));
  const save = db.prepare('INSERT INTO agent_run_events(run_id,seq,event) VALUES (?,?,?)');
  events.forEach((event, index) => save.run(id, index + 1, JSON.stringify(event)));
  return run;
}

const allUsage = () => db.prepare('SELECT * FROM ai_usage ORDER BY id').all();

test('dry run previews and apply restores cached input, request models and timestamps exactly once', () => {
  insertLegacy(addRun());
  const before = allUsage();
  const preview = reconcileAiUsage(db);
  assert.deepEqual(preview, { dryRun: true, fromBeijing: null, examinedLegacyRows: 1, matchedRuns: 1, reconciledRuns: 0,
    providerRequests: 3, recoveredCacheReadTokens: 100, recoveredUncachedInputTokens: 85,
    skipped: { noRun: 0, ambiguousMatch: 0, incompleteLedger: 0, totalsMismatch: 0, existingRequest: 0 },
    before: { inputTokens: 60, cacheReadTokens: 0, uncachedInputTokens: 60, outputTokens: 15, totalTokens: 75,
      requests: 0, legacyRuns: 1, unknownUsageRequests: 0, partialUsageRequests: 0 },
    after: { inputTokens: 185, cacheReadTokens: 100, uncachedInputTokens: 85, outputTokens: 15, totalTokens: 200,
      requests: 3, legacyRuns: 0, unknownUsageRequests: 0, partialUsageRequests: 0 } });
  assert.deepEqual(allUsage(), before);

  assert.deepEqual(reconcileAiUsage(db, { apply: true }), { ...preview, dryRun: false, reconciledRuns: 1 });
  const restored = allUsage();
  assert.deepEqual(restored.map(row => [row.request_key, row.model, row.provider, row.owner, row.phase, row.usage_status]), [
    ['legacy:run-a:1', 'main-model', 'openai', 'coordinator', 'history_compaction', 'reported'],
    ['legacy:run-a:2', 'worker-model', 'anthropic', 'reviewer-1', 'reporting', 'reported'],
    ['legacy:run-a:3', 'main-model', 'openai', 'coordinator', 'investigation', 'reported'],
  ]);
  assert.deepEqual(restored.map(row => [row.input_tokens, row.output_tokens, row.cache_read_tokens, row.cache_write_tokens]),
    [[50, 4, 40, 0], [95, 5, 50, 25], [40, 6, 10, 0]]);
  assert.deepEqual(restored.map(row => row.created_at), ['2026-11-01 15:59:52', '2026-11-01 15:59:53', '2026-11-01 15:59:59']);
  assert.equal(reconcileAiUsage(db, { apply: true }).examinedLegacyRows, 0);
  assert.deepEqual(allUsage(), restored);
});

test('pre-migration read-only preview matches the classified totals of a migrated database', async () => {
  insertLegacy(addRun());
  const snapshot = path.join(dataDir, 'pre-migration.db');
  await db.backup(snapshot);
  const copy = new Database(snapshot);
  try {
    copy.exec(`CREATE TABLE original_ai_usage AS
      SELECT id, user_id, project_id, chat_id, model, input_tokens, output_tokens, created_at FROM ai_usage;
      DROP TABLE ai_usage;
      ALTER TABLE original_ai_usage RENAME TO ai_usage;`);
  } finally {
    copy.close();
  }
  const oldSchema = new Database(snapshot, { readonly: true, fileMustExist: true });
  try {
    assert.deepEqual(reconcileAiUsage(oldSchema), reconcileAiUsage(db));
  } finally {
    oldSchema.close();
  }
});

test('known cache reads in a historical row are counted once', () => {
  insertLegacy(addRun());
  db.prepare('UPDATE ai_usage SET cache_read_tokens = 25').run();
  const preview = reconcileAiUsage(db);
  assert.equal(preview.before.cacheReadTokens, 25);
  assert.equal(preview.before.uncachedInputTokens, 35);
  assert.equal(preview.after.uncachedInputTokens, 85);
  assert.deepEqual(reconcileAiUsage(db, { apply: true }), { ...preview, dryRun: false, reconciledRuns: 1 });
});

test('Beijing date filtering previews the shifted requests of a run that crossed midnight', () => {
  insertLegacy(addRun({ requests: entries => { entries[2].startedAt = origin + 8050; } }));
  assert.equal(reconcileAiUsage(db, { from: '2026-11-03' }).examinedLegacyRows, 0);
  assert.throws(() => reconcileAiUsage(db, { from: '2026-02-30' }), /valid Beijing calendar date/);
  const sinceMidnight = { from: '2026-11-02' };
  const preview = reconcileAiUsage(db, sinceMidnight);
  assert.equal(preview.before.totalTokens, 75);
  assert.equal(preview.providerRequests, 3);
  assert.equal(preview.recoveredCacheReadTokens, 100);
  assert.equal(preview.after.totalTokens, 46);
  assert.equal(preview.after.requests, 1);
  assert.equal(preview.after.cacheReadTokens, 10);
  assert.equal(preview.after.uncachedInputTokens, 30);
  assert.deepEqual(reconcileAiUsage(db, { ...sinceMidnight, apply: true }), { ...preview, dryRun: false, reconciledRuns: 1 });
  assert.equal(reconcileAiUsage(db).before.totalTokens, 200);
});

test('explicitly unknown failed attempts preserve known usage and respect the Beijing date boundary', () => {
  insertLegacy(addRun({ state: 'cancelled',
    requests: entries => {
      Object.assign(entries[1], { status: 'error', usage: null });
      Object.assign(entries[2], { status: 'aborted', usage: null, startedAt: origin + 8050 });
    },
    snapshot: graph => { graph.accounting.usage = { inputTokens: 10, outputTokens: 4, cacheRead: 40, cacheWrite: 0 }; },
  }), { input: 10, output: 4 });
  const before = allUsage();
  const allDates = reconcileAiUsage(db);
  assert.deepEqual(allDates.after, { inputTokens: 50, cacheReadTokens: 40, uncachedInputTokens: 10, outputTokens: 4, totalTokens: 54,
    requests: 3, legacyRuns: 0, unknownUsageRequests: 2, partialUsageRequests: 0 });

  const sinceMidnight = { from: '2026-11-02' };
  const preview = reconcileAiUsage(db, sinceMidnight);
  assert.equal(preview.providerRequests, 3);
  assert.equal(preview.recoveredCacheReadTokens, 40);
  assert.deepEqual(preview.after, { inputTokens: 0, cacheReadTokens: 0, uncachedInputTokens: 0, outputTokens: 0, totalTokens: 0,
    requests: 1, legacyRuns: 0, unknownUsageRequests: 1, partialUsageRequests: 0 });
  assert.deepEqual(allUsage(), before);
  assert.deepEqual(reconcileAiUsage(db, { ...sinceMidnight, apply: true }), { ...preview, dryRun: false, reconciledRuns: 1 });

  const restored = allUsage();
  assert.deepEqual(restored.map(row => [row.request_key, row.status, row.usage_status, row.input_tokens,
    row.output_tokens, row.cache_read_tokens, row.cache_write_tokens, row.created_at]), [
    ['legacy:run-a:1', 'stop', 'reported', 50, 4, 40, 0, '2026-11-01 15:59:52'],
    ['legacy:run-a:2', 'error', 'unknown', 0, 0, 0, 0, '2026-11-01 15:59:53'],
    ['legacy:run-a:3', 'aborted', 'unknown', 0, 0, 0, 0, '2026-11-01 16:00:00'],
  ]);
  const repeated = reconcileAiUsage(db, { apply: true });
  assert.equal(repeated.examinedLegacyRows, 0);
  assert.deepEqual(repeated.after, allDates.after);
  assert.deepEqual(allUsage(), restored);
});

test('an unknown attempt still requires explicit null usage and evidence of a finished dispatch', () => {
  const invalidAttempts = [
    entry => { entry.status = 'stop'; },
    entry => { delete entry.usage; },
    entry => { entry.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }; },
    entry => { delete entry.finishedAt; },
    entry => { entry.dispatched = false; },
  ];
  for (const [index, invalidate] of invalidAttempts.entries()) {
    insertLegacy(addRun({ id: `invalid-attempt-${index}`, chatId: index + 1,
      requests: entries => {
        const attempt = Object.assign(entries[1], { status: 'error', usage: null });
        invalidate(attempt);
      },
      snapshot: graph => { graph.accounting.usage = { inputTokens: 40, outputTokens: 10, cacheRead: 50, cacheWrite: 0 }; },
    }), { input: 40, output: 10 });
  }
  const before = allUsage();
  const result = reconcileAiUsage(db, { apply: true });
  assert.equal(result.skipped.incompleteLedger, invalidAttempts.length);
  assert.deepEqual(allUsage(), before);
});

test('ambiguous matches, incomplete ledgers and totals discrepancies leave the original rows intact', () => {
  insertLegacy(addRun({ id: 'two-runs', chatId: 1 }));
  addRun({ id: 'two-runs-no-ledger', chatId: 1, includeWorkflow: false });
  const twoRows = addRun({ id: 'two-aggregates', chatId: 2 });
  insertLegacy(twoRows);
  insertLegacy(twoRows);
  insertLegacy({ ...twoRows, chatId: 3 });
  insertLegacy(addRun({ id: 'missing-ledger', chatId: 4, includeWorkflow: false }));
  insertLegacy(addRun({ id: 'missing-terminal-event', chatId: 5, includeDone: false }));
  insertLegacy(addRun({ id: 'later-incomplete', chatId: 6, earlierComplete: true,
    snapshot: graph => { graph.accounting.modelPool.active = 1; } }));
  insertLegacy(addRun({ id: 'partial-usage', chatId: 7, requests: entries => { entries[1].status = 'aborted'; } }));
  insertLegacy(addRun({ id: 'malformed-ledger', chatId: 8, snapshot: graph => { graph.accounting.requests = 'invalid'; } }));
  insertLegacy(addRun({ id: 'totals-mismatch', chatId: 9 }), { input: 59 });
  insertLegacy(addRun({ id: 'missing-provider-usage', chatId: 10,
    requests: entries => { entries[1].usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }; },
    snapshot: graph => { graph.accounting.usage = { inputTokens: 40, outputTokens: 10, cacheRead: 50, cacheWrite: 0 }; },
  }), { input: 40, output: 10 });
  const before = allUsage();
  const result = reconcileAiUsage(db, { apply: true });
  assert.equal(result.reconciledRuns, 0);
  assert.deepEqual(result.skipped, { noRun: 1, ambiguousMatch: 3, incompleteLedger: 6, totalsMismatch: 1, existingRequest: 0 });
  assert.deepEqual(allUsage(), before);
});

test('an existing request key never causes the legacy aggregate to be dropped', () => {
  insertLegacy(addRun());
  db.prepare("INSERT INTO ai_usage(user_id,request_key,usage_status) VALUES (2,'legacy:run-a:2','reported')").run();
  const before = allUsage();
  assert.equal(reconcileAiUsage(db, { apply: true }).skipped.existingRequest, 1);
  assert.deepEqual(allUsage(), before);
});

test('legacy reconciliation cannot restore a matching run ledger after the usage reset', () => {
  insertLegacy(addRun());
  assert.equal(reconcileAiUsage(db).matchedRuns, 1);
  const resetAt = origin + 10_000;
  db.prepare('INSERT INTO system_settings(key,value) VALUES (?,?)').run(AI_USAGE_RESET_KEY, String(resetAt));
  const before = allUsage();
  for (const apply of [false, true]) {
    const result = reconcileAiUsage(db, { apply });
    assert.equal(result.resetAt, resetAt);
    assert.equal(result.matchedRuns, 0);
    assert.equal(result.providerRequests, 0);
    assert.deepEqual(result.before, result.after);
    assert.deepEqual(allUsage(), before);
  }
});

test('an insert failure rolls back every inserted request and keeps the legacy aggregate', () => {
  insertLegacy(addRun());
  const before = allUsage();
  db.exec(`CREATE TEMP TRIGGER block_request BEFORE INSERT ON ai_usage
    WHEN NEW.request_key = 'legacy:run-a:2' BEGIN SELECT RAISE(ABORT, 'test insert failure'); END`);
  try {
    assert.throws(() => reconcileAiUsage(db, { apply: true }), /test insert failure|could not be inserted/);
    assert.deepEqual(allUsage(), before);
  } finally {
    db.exec('DROP TRIGGER block_request');
  }
});

test('the CLI defaults to read-only and apply refuses to run during an active agent task', () => {
  insertLegacy(addRun());
  addRun({ id: 'live', chatId: 2, state: 'running', includeWorkflow: false, includeDone: false });
  const before = allUsage();
  const script = fileURLToPath(new URL('../../scripts/reconcile-ai-usage.mjs', import.meta.url));
  const invoke = (...args) => spawnSync(process.execPath, [script, '--database', DB_PATH, ...args], { encoding: 'utf8' });
  const dryRun = invoke();
  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.equal(JSON.parse(dryRun.stdout).matchedRuns, 1);
  assert.equal(db.prepare("SELECT state FROM agent_runs WHERE id = 'live'").pluck().get(), 'running');
  const apply = invoke('--apply');
  assert.equal(apply.status, 1);
  assert.match(apply.stderr, /active agent runs/);
  assert.deepEqual(allUsage(), before);
});
