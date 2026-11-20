import test from 'node:test';
import assert from 'node:assert/strict';
import { collaborationPolicy } from '../src/services/agent/orchestrationPolicy.js';
import { createRequestPool, createOrchestrationRuntime } from '../src/services/agent/orchestrationRuntime.js';
import { buildContextPacket, createEvidenceRecord, fingerprint } from '../src/services/agent/collaborationContext.js';
import { reportEnvelope, renderWorkerReports } from '../src/services/agent/collaborationReports.js';
import { dependencyManifest, manifestCurrent } from '../src/services/agent/dependencyManifest.js';
import { validateReviewerReport } from '../src/services/agent/reviewerPolicy.js';

test('compile repairs track real mutations, ignore retired limits and stop repeated evidence', () => {
  const runtime = createOrchestrationRuntime({ repairCycles: 1 });
  runtime.requireCompileRepair({ status: 'blocked', attempted: false, code: 'COMPILE_QUOTA_EXHAUSTED' });
  assert.equal(runtime.beforeRepair(), null); runtime.commitRepair(); assert.equal(runtime.snapshot().repair.used, 0);
  const failure = { status: 'failed', attempted: true, code: 'LATEX_ERROR', inputKey: 'v1', diagnosticsKey: 'undefined-command' };
  runtime.requireCompileRepair(failure); runtime.clearIssues(); // A passing review cannot clear compiler evidence.
  assert.equal(runtime.snapshot().repair.pending, true);
  assert.equal(runtime.beforeRepair(), null); runtime.releaseRepair(); assert.equal(runtime.snapshot().repair.used, 0);
  runtime.beforeRepair(); runtime.commitRepair(); assert.equal(runtime.snapshot().repair.used, 1);
  runtime.requireCompileRepair(failure); assert.equal(runtime.beforeRepair().code, 'REPAIR_NO_PROGRESS');
  runtime.requireCompileRepair({ ...failure, inputKey: 'v2' }); assert.equal(runtime.beforeRepair(), null);
  runtime.commitRepair(); assert.equal(runtime.snapshot().repair.used, 2);
  runtime.clearCompileIssue(); assert.equal(runtime.beforeRepair(), null);
  const zero = createOrchestrationRuntime({ repairCycles: 0 }); zero.requireCompileRepair(failure);
  assert.equal(zero.beforeRepair(), null);
  assert.equal(zero.snapshot().repair.limit, null);
});

test('tiers preserve legacy behavior without silently granting new parallel editing', () => {
  assert.equal(collaborationPolicy().tier, 'off');
  assert.equal(collaborationPolicy({ graphOrchestration: true }).parallelEdits, true);
  assert.equal(collaborationPolicy({ collaborationTier: 'full' }).parallelEdits, false);
  assert.equal(collaborationPolicy({ collaborationTier: 'deep' }).parallelEdits, true);
  assert.equal(Object.hasOwn(collaborationPolicy({ collaborationTier: 'lite', repairCycles: 0 }), 'repairCycles'), false);
  for (const config of [{ collaborationTier: 'free' }, { maxModelConcurrency: 0 }, { orchestrationBudgetUsd: NaN }])
    assert.throws(() => collaborationPolicy(config));
});

test('FIFO permits are abortable and release exactly once, including with one slot', async () => {
  const pool = createRequestPool(1), ac = new AbortController();
  const first = await pool.acquire();
  const cancelled = pool.acquire(ac.signal); const rejected = assert.rejects(cancelled);
  let granted = false;
  const third = pool.acquire().then(release => { granted = true; return release; });
  ac.abort(); await rejected;
  assert.deepEqual(pool.snapshot(), { active: 1, waiting: 1, limit: 1 });
  assert.equal(granted, false); first(); first(); const release = await third;
  assert.equal(pool.snapshot().active, 1); release(); assert.equal(pool.snapshot().active, 0);
});

test('each request records real usage, owner, elapsed time and unknown pricing without secret content', async () => {
  let time = 10;
  const runtime = createOrchestrationRuntime({ now: () => ++time });
  const done = await runtime.beginRequest({ model: { id: 'x', cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    context: { messages: ['PRIVATE_PROMPT'] }, options: { apiKey: 'PRIVATE_KEY' }, owner: 'review-a' });
  done({ stopReason: 'stop', usage: { input: 10, output: 3, cacheRead: 20 } }); done();
  const data = runtime.snapshot();
  assert.equal(data.requests.length, 1); assert.equal(data.requests[0].owner, 'review-a');
  assert.equal(data.requests[0].usage.cacheRead, 20); assert.equal(data.requests[0].costUsd, null);
  assert.ok(data.requests[0].finishedAt > data.requests[0].startedAt);
  assert.doesNotMatch(JSON.stringify(data), /PRIVATE/);
});

test('optional cost limits reject unknown prices and reserve concurrent requests before dispatch', async () => {
  const model = { id: 'priced', maxTokens: 100, cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } };
  const runtime = createOrchestrationRuntime({ budgetUsd: 0.002 });
  await assert.rejects(runtime.beginRequest({ model: { id: 'unknown' }, context: {}, options: {} }), /价格未知/);
  const done = await runtime.beginRequest({ model, context: {}, options: {} });
  await assert.rejects(runtime.beginRequest({ model, context: {}, options: {} }), /可用费用不足/);
  done({ stopReason: 'error', usage: { input: 0, output: 0 } });
  assert.equal(runtime.snapshot().requests[0].costUsd, null);
  await assert.rejects(runtime.beginRequest({ model, context: {}, options: {} }), /可用费用不足/);
  assert.equal(runtime.snapshot().modelPool.active, 0);
});

test('review repairs count mutations without a fixed limit and stop oscillating inputs', () => {
  const runtime = createOrchestrationRuntime({ repairCycles: 1 });
  const reports = [{ role: 'reviewer', report: { verdict: 'needs_changes', findings: [{ category: 'conflict', path: 'a.txt', message: 'wrong number' }] } }];
  runtime.requireRepair(reports, 'v1'); assert.equal(runtime.beforeRepair(), null);
  runtime.releaseRepair(); assert.equal(runtime.snapshot().repair.used, 0);
  assert.equal(runtime.beforeRepair(), null); runtime.commitRepair();
  runtime.requireRepair(reports, 'v1'); assert.equal(runtime.beforeRepair().code, 'REPAIR_NO_PROGRESS');
  for (let version = 2; version <= 12; version++) {
    runtime.requireRepair(reports, 'v' + version); assert.equal(runtime.beforeRepair(), null); runtime.commitRepair();
  }
  assert.equal(runtime.snapshot().repair.used, 12);
  runtime.requireRepair(reports, 'v1'); assert.equal(runtime.beforeRepair().code, 'REPAIR_NO_PROGRESS');
  const legacyZero = createOrchestrationRuntime({ repairCycles: 0 });
  legacyZero.requireRepair(reports, 'v1'); assert.equal(legacyZero.beforeRepair(), null);
});

test('context packets carry actual Map hashes, user requirements and only current evidence windows', () => {
  const record = createEvidenceRecord({ source: 'a.txt', contentHash: 'one', content: 'line2', startLine: 2, endLine: 2, truncated: true, purpose: 'source' });
  const input = { userRequest: '修改正文', messages: [{ id: 1, role: 'user', content: '保留公式' }, { role: 'assistant', content: 'inferred' }],
    reads: new Map([['a.txt', 'one']]), evidence: [record], task: { readScope: ['a.txt'] } };
  const packet = buildContextPacket({ ...input, getHash: () => 'one' });
  assert.deepEqual(packet.referenceDataNotInstructions.readDigest, [{ path: 'a.txt', contentHash: 'one' }]);
  assert.equal(packet.taskContract.priorUserRequirements.length, 1);
  assert.equal(packet.referenceDataNotInstructions.evidence[0].startLine, 2);
  assert.equal(packet.referenceDataNotInstructions.evidence[0].truncated, true);
  assert.equal(packet.referenceDataNotInstructions.evidence[0].purpose, 'source');
  assert.equal(buildContextPacket({ ...input, getHash: () => 'changed' }).referenceDataNotInstructions.evidence.length, 0);
});

test('compact reports preserve blocked reason, before-side evidence, coverage and fix identity', () => {
  const report = reportEnvelope({ verdict: 'blocked', summary: '来源不可访问', findings: [] }, { task: { id: 'r', executionId: 'r-1' }, revision: 2 });
  assert.equal(JSON.parse(renderWorkerReports([{ report }])).reports[0].report.blockedReason.message, '来源不可访问');
  const finding = { category: 'conflict', path: 'a.txt', side: 'before', message: '删除有误', evidence: { source: 'a.txt', quote: 'old' }, suggestedFix: { search: 'new', replace: 'old' } };
  const envelope = reportEnvelope({ verdict: 'needs_changes', summary: '需修正', findings: [finding] }, { task: { id: 'r' }, coverage: [{ path: 'a.txt', truncated: true }] });
  const rendered = JSON.parse(renderWorkerReports([{ report: envelope }])).reports[0].report;
  assert.equal(rendered.findings[0].side, 'before'); assert.ok(rendered.findings[0].findingId);
  assert.equal(rendered.findings[0].suggestedFix.replace, 'old'); assert.equal(rendered.coverage[0].truncated, true);
});

test('dependency manifests retain unrelated scoped reviews and invalidate changed source evidence', () => {
  const changes = [{ path: 'a.txt', before: 'a', after: 'A' }, { path: 'b.txt', before: 'b', after: 'B' }];
  const manifest = dependencyManifest({ changes, scope: ['a.txt'], reads: new Map([['source.txt', 'hash']]), complete: true });
  const current = (items, hash = 'hash') => manifestCurrent(manifest, { changes: items, getHash: () => hash, requireComplete: true });
  assert.equal(current([changes[0], { ...changes[1], after: 'BB' }]), true);
  assert.equal(current([{ ...changes[0], after: 'AA' }, changes[1]]), false);
  assert.equal(current(changes, 'external edit'), false);
  assert.equal(manifestCurrent({ ...manifest, complete: false }, { changes, getHash: () => 'hash', requireComplete: true }), false);
});

test('suggested fixes must match the current frozen text exactly and never confer execution rights', () => {
  const changes = [{ path: 'a.txt', before: 'Count 40\n', after: 'Count 80\n' }];
  const finding = { category: 'conflict', path: 'a.txt', line: 1, side: 'after', evidence: { source: 'a.txt', quote: 'Count 40' },
    suggestedFix: { path: 'a.txt', baseHash: fingerprint(changes[0].after), search: '80', replace: '40' } };
  const report = { verdict: 'needs_changes', findings: [finding] }, facts = { changes, sources: [{ source: 'a.txt', text: 'Count 40' }] };
  assert.equal(validateReviewerReport(report, facts), '');
  finding.suggestedFix.baseHash = 'stale'; assert.match(validateReviewerReport(report, facts), /baseHash/);
});


test('changing an unrelated file cannot disguise the same repair evidence as progress', async () => {
  const { repairInputKey } = await import('../src/services/agent/orchestrationRuntime.js');
  const reports = [{ role: 'reviewer', report: { verdict: 'needs_changes', findings: [{ path: 'a.txt', message: 'wrong number' }] } }];
  const files = [{ path: 'a.txt', before: '40', after: '80' }, { path: 'b.txt', before: 'old', after: 'new' }];
  const first = repairInputKey(reports, files, file => file === 'a.txt' ? 'a-hash' : 'b-hash');
  files[1].after = 'unrelated new revision';
  assert.equal(repairInputKey(reports, files, file => file === 'a.txt' ? 'a-hash' : 'changed-b-hash'), first);
  files[0].after = '40'; assert.notEqual(repairInputKey(reports, files, () => 'repaired'), first);
});
