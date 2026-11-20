import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

test('the reset CLI clears usage once and rejects pre-reset completions across connections and restarts', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'corelatex-usage-reset-'));
  process.env.CORELATEX_DATA_DIR = dataDir;
  const { DB_PATH } = await import('../src/config.js');
  const { getDb, resetDb } = await import('../src/db.js');
  t.after(() => {
    resetDb();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const { aiUsageSummary, recordAiUsage } = await import('../src/quotas.js');
  const { reconcileAiUsage } = await import('../src/services/agent/usageReconciliation.js');
  const { acquireMaintenance, releaseMaintenance } = await import('../src/services/maintenance.js');
  const db = getDb();
  db.exec(`
    INSERT INTO users(id,username,password_hash,compile_seconds_used) VALUES (7,'fixture','fixture',42);
    INSERT INTO projects(id,name,owner_id,public_id) VALUES (3,'Document',7,'usagefixture');
    INSERT INTO chats(id,project_id,user_id,title) VALUES (2,3,7,'Draft');
    INSERT INTO chat_messages(id,chat_id,role,content) VALUES (5,2,'assistant','Earlier reply');
    INSERT INTO compile_jobs(project_id,user_id,status,duration_ms) VALUES (3,7,'succeeded',1200);
    INSERT INTO tool_usage(user_id,project_id,chat_id,tool,skill) VALUES (7,3,2,'read_skill','latex');
    INSERT INTO agent_runs(id,project_id,user_id,chat_id,state,last_seq,message_id) VALUES ('earlier',3,7,2,'completed',1,5);
    INSERT INTO agent_run_events(run_id,seq,event) VALUES ('earlier',1,'{"type":"done"}');
    INSERT INTO system_settings(key,value) VALUES ('allow_registration','0');
    INSERT INTO ai_usage(user_id,project_id,chat_id,input_tokens,output_tokens) VALUES (7,3,2,800,300);
  `);
  const entry = { requestKey: 'historical-request', startedAt: Date.now() - 1000, status: 'stop',
    usage: { input: 1000, cacheRead: 8000, cacheWrite: 2000, output: 500 } };
  const record = updates => recordAiUsage({ userId: 7, projectId: 3, chatId: 2, entry: { ...entry, ...updates } }).changes;
  assert.equal(record(), 1);
  const preserved = ['users', 'projects', 'chats', 'chat_messages', 'compile_jobs', 'tool_usage', 'agent_runs', 'agent_run_events'];
  const snapshot = () => preserved.map(table => db.prepare(`SELECT * FROM ${table}`).all());
  const original = snapshot();

  const script = fileURLToPath(new URL('../../scripts/reset-ai-usage.mjs', import.meta.url));
  const invoke = (...args) => spawnSync(process.execPath, [script, '--database', DB_PATH, ...args], { encoding: 'utf8' });
  const read = result => {
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const errorFrom = result => {
    assert.equal(result.status, 1, result.stdout);
    return JSON.parse(result.stderr).error;
  };
  const preview = { dryRun: true, resetAt: null, beforeRows: 2, afterRows: 2, removedRows: 0, otherRowsChanged: 0 };
  assert.deepEqual(read(invoke()), preview);
  assert.match(errorFrom(invoke('--apply')), /--owner-file is required/);

  const ownerToken = randomBytes(32).toString('hex');
  const ownerFile = path.join(dataDir, 'maintenance-owner');
  fs.writeFileSync(ownerFile, ownerToken + '\n', { mode: 0o600 });
  const apply = () => invoke('--apply', '--owner-file', ownerFile);
  assert.match(errorFrom(apply()), /Maintenance ownership/);
  acquireMaintenance(db, { ownerToken });

  db.prepare("UPDATE agent_runs SET state = 'running' WHERE id = 'earlier'").run();
  assert.match(errorFrom(apply()), /active agent runs/);
  db.prepare("UPDATE agent_runs SET state = 'completed' WHERE id = 'earlier'").run();

  db.exec(`CREATE TRIGGER reset_fixture_side_effect AFTER DELETE ON ai_usage BEGIN
    UPDATE projects SET name = 'Would damage project data' WHERE id = 3;
  END`);
  assert.match(errorFrom(apply()), /modify unrelated rows/);
  assert.deepEqual(read(invoke()), preview);
  assert.deepEqual(snapshot(), original);
  db.exec('DROP TRIGGER reset_fixture_side_effect');

  const reset = read(apply());
  assert.ok(Number.isSafeInteger(reset.resetAt) && reset.resetAt > entry.startedAt);
  assert.deepEqual(reset, { ...preview, dryRun: false, resetAt: reset.resetAt, afterRows: 0, removedRows: 2 });
  assert.deepEqual(snapshot(), original);
  assert.equal(db.prepare("SELECT value FROM system_settings WHERE key = 'allow_registration'").pluck().get(), '0');
  assert.deepEqual(read(invoke()), { ...reset, dryRun: true, beforeRows: 0, removedRows: 0 });

  assert.equal(record(), 0);
  assert.equal(record({ requestKey: 'same-millisecond', startedAt: reset.resetAt }), 0);
  assert.equal(record({ requestKey: 'missing-timestamp', startedAt: undefined }), 0);
  assert.equal(record({ requestKey: 'new', startedAt: reset.resetAt + 1 }), 1);
  assert.equal(record({ requestKey: 'new', startedAt: reset.resetAt + 1 }), 0);
  assert.equal(record({ requestKey: 'new-unknown', startedAt: reset.resetAt + 2, status: 'error', usage: null }), 1);
  assert.deepEqual(read(apply()), { ...reset, beforeRows: 2, afterRows: 2, removedRows: 0 });
  assert.equal(reconcileAiUsage(db, { apply: true }).examinedLegacyRows, 0);
  releaseMaintenance(db, { ownerToken });

  resetDb();
  assert.equal(record(), 0);
  const { ai, aiDaily } = aiUsageSummary('user_id = ?', 7);
  assert.deepEqual(ai, { inputTokens: 11000, cacheReadTokens: 8000, uncachedInputTokens: 3000, outputTokens: 500,
    totalTokens: 11500, requests: 2, legacyRuns: 0, unknownUsageRequests: 1, partialUsageRequests: 0 });
  assert.equal(aiDaily.reduce((sum, day) => sum + day.totalTokens, 0), ai.totalTokens);
});
