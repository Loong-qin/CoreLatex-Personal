import { randomUUID } from 'node:crypto';
import { fingerprint } from './collaborationContext.js';
import { createExecutionRecovery } from './executionRecovery.js';
import { normalizeModelUsage } from './modelUsage.js';

export function repairInputKey(reports, changes, getHash = () => undefined) {
  const unresolved = (reports || []).filter(item => item.current !== false && item.report?.verdict === 'needs_changes');
  const paths = [...new Set(unresolved.flatMap(item => [
    ...(item.report.findings || []).map(finding => finding.path),
    ...(item.report.dependencyManifest?.reads || []).map(read => read.path),
  ]).filter(Boolean))].sort();
  return fingerprint([changes.filter(file => !paths.length || paths.includes(file.path))
    .map(file => [file.path, file.before, file.after]).sort((a, b) => a[0].localeCompare(b[0])),
    paths.map(path => [path, getHash(path) ?? null])]);
}

/** FIFO permits cover remote model requests, not agent lifetimes or tool waits. */
export function createRequestPool(limit = 2) {
  if (!Number.isInteger(limit) || limit < 1) throw new TypeError('Invalid model concurrency');
  let active = 0;
  const queue = [];
  const drain = () => {
    while (active < limit && queue.length) {
      const entry = queue.shift(); entry.signal?.removeEventListener('abort', entry.abort);
      if (entry.signal?.aborted) { entry.reject(entry.signal.reason); continue; }
      active++; let released = false;
      entry.resolve(() => { if (!released) { released = true; active--; drain(); } });
    }
  };
  return { snapshot: () => ({ active, waiting: queue.length, limit }),
    acquire(signal) {
      if (signal?.aborted) return Promise.reject(signal.reason);
      return new Promise((resolve, reject) => {
        const entry = { signal, resolve, reject, abort: null };
        entry.abort = () => { const i = queue.indexOf(entry); if (i >= 0) queue.splice(i, 1); reject(signal.reason); drain(); };
        queue.push(entry); signal?.addEventListener('abort', entry.abort, { once: true }); drain();
      });
    } };
}

function sumRequestUsage(requests, owner) {
  const totals = { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 };
  for (const entry of requests) {
    if (!entry.usage || (owner !== undefined && entry.owner !== owner)) continue;
    const { input, output, cacheRead, cacheWrite } = entry.usage;
    totals.inputTokens += input + cacheRead + cacheWrite;
    totals.outputTokens += output;
    totals.cacheRead += cacheRead;
    totals.cacheWrite += cacheWrite;
  }
  return totals;
}

function notifyRequest(callback, data) {
  try { callback?.(data); }
  catch (error) {
    // An accounting or UI error must not cause a second provider request.
    console.error('[agent][accounting] request hook failed', error?.code || error?.name || 'Error');
  }
}

export function createOrchestrationRuntime({ maxConcurrency = 2, budgetUsd = null, now = Date.now,
  onRequestStart, onRequestSettled } = {}) {
  const pool = createRequestPool(maxConcurrency), requests = [], cycles = [], seen = new Set();
  let serial = 0, reservedUsd = 0, spentUsd = 0, reservation = null;
  const issues = new Map();
  const toolRecovery = createExecutionRecovery();
  return {
    toolRecovery,
    async beginRequest({ model, context, options, owner = 'coordinator', phase = 'investigation', beforeDispatch }) {
      const queuedAt = now(), release = await pool.acquire(options.signal);
      try {
        options.signal?.throwIfAborted();
        await beforeDispatch?.();
        options.signal?.throwIfAborted();
        const requestPhase = typeof phase === 'function' ? phase() : phase;
        const rates = model.cost;
        const priced = rates && ['input', 'output', 'cacheRead', 'cacheWrite'].every(key => Number.isFinite(rates[key]) && rates[key] >= 0) && Object.values(rates).some(value => value > 0);
        const estimate = priced ? ((Buffer.byteLength(JSON.stringify(context)) + 1024) * Math.max(rates.input, rates.cacheRead, rates.cacheWrite) +
          (options.maxTokens || model.maxTokens || 8192) * rates.output) / 1e6 : null;
        if (budgetUsd != null && (estimate == null || estimate + spentUsd + reservedUsd > budgetUsd)) {
          throw new Error('400 ORCHESTRATION_BUDGET: ' + (estimate == null ? '模型价格未知，无法在费用限制内准入新请求' : '本轮可用费用不足，停止新增模型请求'));
        }
        const entry = { requestId: ++serial, requestKey: randomUUID(), owner, phase: requestPhase,
          provider: model.provider, providerId: model.providerId, model: model.id,
          queuedAt, startedAt: now(), status: 'running', usage: null, costUsd: null };
        requests.push(entry);
        reservedUsd += estimate || 0;
        notifyRequest(onRequestStart, { requestId: entry.requestId, model, context, options, owner, phase: requestPhase });
        return (result, { dispatched = true } = {}) => {
          if (entry.finishedAt !== undefined) return;
          entry.finishedAt = now();
          entry.status = result?.stopReason || 'error';
          entry.dispatched = dispatched;
          entry.usage = dispatched ? normalizeModelUsage(result?.usage) : null;
          const responseModel = result?.responseModel;
          if (typeof responseModel === 'string' && (!options.apiKey || !responseModel.includes(options.apiKey))) {
            entry.responseModel = responseModel;
          }
          const interrupted = ['error', 'aborted'].includes(entry.status);
          entry.usageStatus = entry.usage ? (interrupted ? 'partial' : 'reported') : 'unknown';
          entry.costUsd = priced && entry.usage ? Object.entries(entry.usage).reduce((total, [key, value]) => total + value * rates[key] / 1e6, 0) : null;
          spentUsd += entry.costUsd || 0;
          // A partially observed error may have been billed beyond the usage
          // observed so far. Only confirmed usage releases all of its reserve.
          if (!dispatched || budgetUsd == null || entry.usageStatus === 'reported') reservedUsd -= estimate || 0;
          else reservedUsd -= Math.min(estimate || 0, entry.costUsd || 0);
          release();
          notifyRequest(onRequestSettled, { entry, result, model, context, options });
        };
      } catch (error) {
        release();
        throw error;
      }
    },
    usageForOwner: owner => sumRequestUsage(requests, owner),
    requireRepair(reports, contentKey) {
      const unresolved = (reports || []).filter(item => item.current !== false && item.report?.verdict === 'needs_changes');
      if (!unresolved.length) return;
      const signature = fingerprint(unresolved.map(item => [item.role, item.report.findings.map(f => [f.category, f.path, f.side, f.message, f.evidence]) ]));
      const key = fingerprint([signature, contentKey]);
      issues.set('review', { signature, key });
    },
    requireCompileRepair(evidence) {
      if (evidence?.status !== 'failed' || evidence.attempted !== true || evidence.code !== 'LATEX_ERROR') return;
      const signature = fingerprint(['compile', evidence.diagnosticsKey || evidence.code]);
      // An unknown dependency fingerprint cannot prove identical inputs. Track
      // the repair without fabricating a no-progress match.
      issues.set('compile', { signature, key: evidence.inputKey ? fingerprint([signature, evidence.inputKey]) : fingerprint([signature, now(), cycles.length]) });
    },
    clearCompileIssue() { issues.delete('compile'); },
    beforeRepair() {
      if (!issues.size || reservation) return null;
      if ([...issues.values()].some(issue => seen.has(issue.key))) return { failed: true, code: 'REPAIR_NO_PROGRESS', reason: '相同问题与相关证据再次出现，已停止无效返工；草稿保留待审。' };
      reservation = { issues: [...issues.values()], at: now() }; return null;
    },
    commitRepair() { if (reservation) { cycles.push(reservation); for (const issue of reservation.issues) seen.add(issue.key); reservation = null; issues.clear(); } },
    releaseRepair() { reservation = null; },
    clearIssues() { issues.delete('review'); reservation = null; },
    snapshot: () => structuredClone({ requests, modelPool: pool.snapshot(), toolRecovery: toolRecovery.snapshot(),
      usage: sumRequestUsage(requests),
      repair: { mode: 'automatic', limit: null, used: cycles.length, pending: issues.size > 0, cycles },
      budget: { limitUsd: budgetUsd, spentKnownUsd: spentUsd, reservedUsd, unknownRequests: requests.filter(r => r.dispatched !== false && (r.costUsd == null || r.usageStatus === 'partial')).length } }),
  };
}
