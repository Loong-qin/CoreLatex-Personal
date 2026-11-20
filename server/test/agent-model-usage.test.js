import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { inputTokensForUsage, normalizeModelUsage, normalizeProviderUsage } from '../src/services/agent/modelUsage.js';

test('pi normalization includes cache reads and writes with no synthetic zero usage', () => {
  const usage = { input: 30, output: 5, cacheRead: 100, cacheWrite: 20, totalTokens: 155 };
  assert.deepEqual(normalizeModelUsage(usage), { input: 30, output: 5, cacheRead: 100, cacheWrite: 20 });
  assert.equal(inputTokensForUsage(usage), 150);
  const missing = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
  assert.equal(normalizeModelUsage(missing), null);
  assert.equal(inputTokensForUsage(missing), null);
  assert.equal(inputTokensForUsage({ output: 50 }), null);
});

test('raw Chat, Responses and Anthropic usage count reported totals without adding reasoning twice', () => {
  assert.deepEqual(normalizeProviderUsage('openai', { prompt_tokens: 200, completion_tokens: 40, prompt_cache_hit_tokens: 160,
    completion_tokens_details: { reasoning_tokens: 29 } }), { input: 40, output: 40, cacheRead: 160, cacheWrite: 0 });
  assert.deepEqual(normalizeProviderUsage('openai', { prompt_tokens: 200, completion_tokens: 40,
    prompt_tokens_details: { cached_tokens: 160, cache_write_tokens: 20 } }), { input: 40, output: 40, cacheRead: 140, cacheWrite: 20 });
  assert.deepEqual(normalizeProviderUsage('openai-responses', { input_tokens: 200, output_tokens: 40,
    input_tokens_details: { cached_tokens: 160 }, output_tokens_details: { reasoning_tokens: 29 } }),
  { input: 40, output: 40, cacheRead: 160, cacheWrite: 0 });
  assert.deepEqual(normalizeProviderUsage('anthropic', { input_tokens: 40, output_tokens: 40,
    cache_read_input_tokens: 140, cache_creation_input_tokens: 20 }), { input: 40, output: 40, cacheRead: 140, cacheWrite: 20 });
  assert.equal(normalizeProviderUsage('openai', { cached_tokens: 12 }), null);
  assert.deepEqual(normalizeProviderUsage('openai', { prompt_tokens: 0, completion_tokens: 0 }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});

test('existing usage rows keep their known totals and migrate as legacy runs', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'corelatex-model-usage-'));
  process.env.CORELATEX_DATA_DIR = dataDir;
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const { DB_PATH } = await import('../src/config.js');
  const old = new Database(DB_PATH);
  old.exec(`CREATE TABLE ai_usage (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
    project_id INTEGER, chat_id INTEGER, model TEXT DEFAULT '', input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    INSERT INTO ai_usage (user_id, model, input_tokens, output_tokens, created_at)
    VALUES (7, 'old-model', 252, 14, '2026-11-01 00:00:00'), (7, 'old-model', 7, 0, '2026-11-02 00:00:00');`);
  old.close();
  const { getDb, resetDb } = await import('../src/db.js');
  const { aiUsageTotals, recordAiUsage } = await import('../src/quotas.js');
  try {
    const db = getDb();
    assert.equal(db.prepare('SELECT request_key FROM ai_usage WHERE id = 1').get().request_key, null);
    assert.deepEqual(aiUsageTotals('user_id = ?', 7), { inputTokens: 259, cacheReadTokens: 0, uncachedInputTokens: 259,
      outputTokens: 14, totalTokens: 273,
      requests: 0, legacyRuns: 2, unknownUsageRequests: 0, partialUsageRequests: 0 });
    const zero = normalizeProviderUsage('openai', { prompt_tokens: 0, completion_tokens: 0 });
    recordAiUsage({ userId: 7, entry: { requestKey: 'direct-zero', model: 'direct', status: 'stop', usage: zero } });
    resetDb();
    const totals = aiUsageTotals('user_id = ?', 7);
    assert.equal(totals.requests, 1);
    assert.equal(totals.unknownUsageRequests, 0);
    assert.equal(totals.legacyRuns, 2);
  } finally { resetDb(); }
});
