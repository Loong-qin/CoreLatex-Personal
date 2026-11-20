import { fingerprint } from './collaborationContext.js';
import { nonBlockingReview } from './reviewerPolicy.js';

const roles = ['analyst', 'researcher', 'reviewer', 'verifier'];
const pathValid = value => typeof value === 'string' && value.trim() && !/^(?:\/|[A-Za-z]:)/.test(value) &&
  !value.includes('\\') && !value.split('/').some(part => part === '..' || part === '.');
const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const writes = new Set(['edit_file', 'write_file', 'copy_to_project', 'run_parallel_edits', 'run_in_workspace', 'run_skill_script']);
// Retain old resource codes for persisted reports; new workers use time_limit.
const RESOURCE_CODES = new Set(['time_limit', 'token_budget', 'turn_limit', 'tool_limit']);
const clean = (value, limit = 1200) => String(value ?? '').trim().slice(0, limit);

export function validateTaskPlan(tasks) {
  if (!Array.isArray(tasks) || !tasks.length || tasks.length > 6) return 'tasks 需为 1 至 6 个有边界的任务';
  const ids = new Set(tasks.map(t => t?.taskId));
  if (ids.size !== tasks.length) return '任务 ID 不能重复';
  for (const task of tasks) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(task?.taskId || '') || task.taskId === 'coordinator' || !roles.includes(task.archetype) ||
      typeof task.objective !== 'string' || !task.objective.trim() || task.objective.length > 6000)
      return '任务需要合法 taskId、只读能力模板与明确 objective；编辑必须使用服务器授权的 run_parallel_edits';
    if (!Array.isArray(task.readScope) || !task.readScope.length || task.readScope.length > 40 || task.readScope.some(p => !pathValid(p)))
      return 'readScope 需为 1 至 40 个有效项目相对路径';
    if (task.writeScope?.length) return '只读任务不能声明写权限';
    if (task.required === false) return '已选择的独立任务需完成；可选调查请不要加入必要执行计划';
    if (!Array.isArray(task.dependsOn || []) || (task.dependsOn || []).some(dep => !ids.has(dep?.taskId) || dep.taskId === task.taskId || !['usable_report', 'pass'].includes(dep.requires)))
      return '依赖必须引用本计划其他任务，并声明 usable_report 或 pass';
  }
  const visited = new Set(), visiting = new Set(), map = new Map(tasks.map(t => [t.taskId, t]));
  function visit(id) {
    if (visiting.has(id)) return false;
    if (visited.has(id)) return true;
    visiting.add(id);
    for (const dep of map.get(id).dependsOn || []) if (!visit(dep.taskId)) return false;
    visiting.delete(id); visited.add(id); return true;
  }
  return tasks.every(t => visit(t.taskId)) ? null : '任务依赖不能成环';
}

/** Instance scheduler. Retains immutable attempts and releases ready dependants
 * immediately, instead of waiting for every task in a phase. */
export function createTaskGraph({ executeTask, getRevision = () => 0, onChange = () => {}, signal, maxConcurrency = 2, isReportCurrent, getChangedPaths = () => [] }) {
  if (typeof executeTask !== 'function' || !Number.isInteger(maxConcurrency) || maxConcurrency < 1) throw new TypeError('Invalid task executor or concurrency');
  const tasks = new Map(); let status = 'running', active = null, activePhase = '', planVersion = 0, executions = 0, scenario = 'answer', summary = '', corrections = 0;
  const controller = new AbortController();
  const abort = () => { status = 'cancelled'; controller.abort(signal?.reason); publish(); };
  signal?.addEventListener('abort', abort, { once: true });
  const phaseOf = role => ['analyst', 'researcher'].includes(role) ? 'analysis' : 'review';
  const dependencyKey = task => fingerprint(task.dependsOn.map(dep => [dep.taskId, tasks.get(dep.taskId)?.report]));
  const current = task => task.report && task.executionScope === task.scopeHash && task.executionDependencies === dependencyKey(task) &&
    task.dependsOn.every(dep => current(tasks.get(dep.taskId))) && (task.phase === 'analysis' ||
      (isReportCurrent ? isReportCurrent(task, getRevision()) : Object.is(task.revision, getRevision())));
  // A coordinator takeover is a separate evidence path: it satisfies coverage for the
  // current scope without rewriting the worker's blocked verdict into an independent pass.
  const takenOver = task => Boolean(task.takeover) && task.report?.verdict === 'blocked';
  const usable = task => current(task) && (['pass', 'needs_changes'].includes(task.report.verdict) || takenOver(task));
  const passed = task => current(task) && (task.phase === 'analysis' ? usable(task) : task.report.verdict === 'pass' || takenOver(task));
  const currentAttempt = task => task.history.find(entry => entry.executionId === task.executionId);
  // usable_report may consume a takeover as reference material; pass still requires a real
  // independent pass, so a takeover never substitutes for required independent verification.
  const depSatisfied = dep => {
    const up = tasks.get(dep.taskId);
    if (!up || !current(up)) return false;
    if (dep.requires === 'pass') return up.report.verdict === 'pass';
    if (dep.requires === 'merged_draft') return up.merged === true && up.report.verdict === 'pass';
    return usable(up);
  };
  const snapshot = () => ({ version: 4, kind: 'orchestration', scenario, summary, status, planRevision: planVersion,
    revision: getRevision(), executions, maxConcurrency, activeCount: [...tasks.values()].filter(t => t.status === 'running').length,
    nodes: structuredClone([{ id: 'coordinator', role: 'coordinator', label: '主智能体', phase: 'coordination', status: terminal.has(status) ? status : 'running' },
      ...[...tasks.values()].map(t => ({ ...t, status: t.report && !current(t) ? 'pending' : t.status }))]),
    edges: [...tasks.values()].flatMap(t => t.dependsOn.map(d => ({ from: d.taskId, to: t.id, label: d.requires }))) });
  const publish = () => onChange(snapshot());
  const result = (phase = 'all') => {
    const selected = [...tasks.values()].filter(t => phase === 'all' || t.phase === phase);
    return { phase, ready: !terminal.has(status) && selected.every(passed), failed: terminal.has(status) && status !== 'completed',
      reports: selected.filter(t => t.report).map(t => ({ id: t.id, role: t.role, revision: t.revision, current: !!current(t),
        ...(t.takeover && current(t) ? { takeover: structuredClone(t.takeover) } : {}), report: structuredClone(t.report) })) };
  };
  const api = {
    snapshot,
    plan(input) {
      if (terminal.has(status) || active) return { error: '当前执行状态不允许重新规划' };
      if (input.agents !== undefined) return { error: 'tasks 与 agents 不能同时提供' };
      const error = validateTaskPlan(input.tasks); if (error) return { error };
      const ids = new Set(input.tasks.map(t => t.taskId));
      // Removing or rewriting a requirement is not a repair of its findings.
      for (const old of tasks.values()) if ((!ids.has(old.id) || fingerprint(input.tasks.find(t => t.taskId === old.id)) !== old.specHash) &&
        (!passed(old) || old.report?.verdict !== 'pass')) return { error: `任务 ${old.id} 尚未完成，不能通过重新规划删除或替换必要核验` };
      scenario = input.scenario || scenario; summary = input.summary || summary; planVersion++;
      for (const spec of input.tasks) {
        const specHash = fingerprint(spec), old = tasks.get(spec.taskId);
        if (old?.specHash === specHash) {
          const scopeHash = fingerprint([spec, scenario]);
          if (old.scopeHash !== scopeHash) { old.scopeHash = scopeHash; delete old.lastInput; old.status = 'pending'; }
          continue;
        }
        tasks.set(spec.taskId, { ...structuredClone(spec), specHash, scopeHash: fingerprint([spec, scenario]),
          id: spec.taskId, role: spec.archetype, label: spec.taskId, task: spec.objective,
          phase: phaseOf(spec.archetype), dependsOn: structuredClone(spec.dependsOn || []), status: 'pending',
          attempts: old?.attempts || 0, history: old?.history || [], toolCount: old?.toolCount || 0, usage: {} });
      }
      for (const id of tasks.keys()) if (!ids.has(id)) tasks.delete(id);
      publish(); return { planned: true, next: 'all', taskIds: [...tasks.keys()] };
    },
    execute({ phase = 'all' } = {}) {
      if (!['analysis', 'review', 'all'].includes(phase)) return Promise.resolve({ error: 'phase 需为 analysis、review 或 all' });
      if (active) return activePhase === phase ? active : active.then(() => api.execute({ phase }));
      if (signal?.aborted || controller.signal.aborted || terminal.has(status) || status === 'waiting') return Promise.resolve(result(phase));
      const wanted = new Set([...tasks.values()].filter(t => phase === 'all' || t.phase === phase).map(t => t.id));
      const includeDeps = id => { for (const dep of tasks.get(id).dependsOn) if (!wanted.has(dep.taskId)) { wanted.add(dep.taskId); includeDeps(dep.taskId); } };
      [...wanted].forEach(includeDeps);
      const attempted = new Set(), running = new Map();
      const run = async task => {
        const revision = getRevision(), scope = task.scopeHash, plannedAt = planVersion, dependenciesAt = dependencyKey(task);
        const attempt = { id: task.id, executionId: `${task.id}-${++task.attempts}`, role: task.role, label: task.label, task: task.task,
          phase: task.phase, readScope: task.readScope, scenario, startedAt: Date.now(), status: 'running', revision };
        task.history.push(attempt); task.status = 'running'; task.executionId = attempt.executionId; task.startedAt = attempt.startedAt;
        task.lastInput = fingerprint([scope, revision]); executions++; publish();
        let abortRequest;
        try {
          const cancelled = new Promise((_resolve, reject) => {
            abortRequest = () => reject(controller.signal.reason || Error('任务已取消'));
            controller.signal.addEventListener('abort', abortRequest, { once: true });
            if (controller.signal.aborted) abortRequest();
          });
          const outcome = await Promise.race([Promise.resolve().then(() => executeTask(structuredClone(attempt), { revision, signal: controller.signal,
            dependencies: task.dependsOn.map(dep => ({ id: dep.taskId, role: tasks.get(dep.taskId).role, report: structuredClone(tasks.get(dep.taskId).report) })) })), cancelled]);
          if (controller.signal.aborted || terminal.has(status)) { attempt.status = 'cancelled'; return; }
          const report = task.role === 'reviewer' ? nonBlockingReview(outcome.report) : outcome.report;
          if (!report?.summary || !['pass', 'needs_changes', 'blocked'].includes(report.verdict) || !Array.isArray(report.findings)) throw Error('无有效结构化报告');
          attempt.report = structuredClone(report); attempt.status = 'completed'; attempt.usage = outcome.usage; attempt.toolCount = outcome.toolCount;
          if (outcome.resourceFailure) attempt.resourceFailure = structuredClone(outcome.resourceFailure);
          if (plannedAt !== planVersion || scope !== task.scopeHash || task.phase === 'review' && !Object.is(revision, getRevision())) {
            attempt.status = 'superseded'; task.status = 'pending'; return;
          }
          task.report = structuredClone(report); task.revision = revision; task.executionScope = scope; task.executionDependencies = dependenciesAt; task.status = 'completed';
          task.toolCount += outcome.toolCount || 0; task.usage = outcome.usage || {};
        } catch (error) {
          attempt.status = controller.signal.aborted ? 'cancelled' : 'failed';
          attempt.report = { verdict: 'blocked', summary: String(error.message || error), findings: [] };
          if (!controller.signal.aborted) { task.report = structuredClone(attempt.report); task.revision = revision; task.executionScope = scope; task.executionDependencies = dependenciesAt; task.status = 'failed'; }
        } finally {
          controller.signal.removeEventListener('abort', abortRequest);
          if (controller.signal.aborted) task.status = 'cancelled';
          attempt.finishedAt = Date.now(); attempt.durationMs = attempt.finishedAt - attempt.startedAt;
          task.finishedAt = attempt.finishedAt; task.durationMs = attempt.durationMs; publish();
        }
      };
      activePhase = phase;
      active = (async () => {
        while (!controller.signal.aborted && !terminal.has(status)) {
          for (const id of wanted) {
            if (running.size >= maxConcurrency) break;
            const task = tasks.get(id);
            if (attempted.has(id) || current(task) && (usable(task) || task.lastInput === fingerprint([task.scopeHash, getRevision()]))) continue;
            if (!task.dependsOn.every(depSatisfied)) continue;
            attempted.add(id); const promise = run(task).finally(() => running.delete(id)); running.set(id, promise);
          }
          if (!running.size) break;
          await Promise.race(running.values());
        }
        await Promise.allSettled(running.values()); return result(phase);
      })().finally(() => { active = null; activePhase = ''; publish(); });
      return active;
    },
    autoExecute: async () => ({ automatic: false, executed: false }),
    beforeTool(name) {
      if (!writes.has(name)) return null;
      if (terminal.has(status) || active) return '独立任务尚在执行或本轮已结束，不能修改当前草稿';
      if ([...tasks.values()].some(t => t.phase === 'analysis' && !usable(t))) return '先完成计划中的分析或查证任务，再执行修改';
      return null;
    },
    prepareCompletion({ consumeCorrection = true } = {}) {
      const pending = [...tasks.values()].filter(t => !passed(t));
      const reviews = [...tasks.values()].filter(t => t.role === 'reviewer');
      const uncovered = reviews.length ? getChangedPaths().filter(path => !reviews.some(t => current(t) && t.readScope.includes(path))) : [];
      if (!pending.length && !uncovered.length && !active && !terminal.has(status)) return { ready: true };
      const reason = uncovered.length ? `本轮变更尚未纳入审阅范围：${uncovered.join('、')}。请补充审阅任务。` :
        pending.map(t => `${t.id}：${t.report?.summary || '尚未完成当前版本核验'}`).join('；') || '等待当前任务结束';
      if (consumeCorrection && ++corrections > 2) status = 'failed';
      return { ready: false, failed: terminal.has(status), reason, message: `【任务编排】${reason}` };
    },
    invalidate({ includeAnalysis = false, reason = '' } = {}) {
      planVersion++;
      for (const task of tasks.values()) if (includeAnalysis || task.phase === 'review') { delete task.executionScope; delete task.lastInput; delete task.takeover; task.status = 'pending'; task.detail = reason; }
      publish(); return { invalidated: [...tasks.keys()] };
    },
    // Host-only recovery: a coordinator with real evidence may take over a resource-limited
    // task. The original blocked verdict and attempt history are preserved; takeover is recorded
    // as a separate coverage path, never rewritten into an independent pass (INV-08).
    takeOverResourceFailures({ phase, readPaths = [], sourceRead = false, workflowReady = false,
      compileSucceeded = false, revision = getRevision(), reason = '' } = {}) {
      if (!['analysis', 'review'].includes(phase) || terminal.has(status) || active || status === 'waiting')
        return { takenOver: false, ready: false, reason: '当前阶段不允许接管子任务' };
      const paths = [...(readPaths instanceof Set || Array.isArray(readPaths) ? readPaths : [])].filter(pathValid);
      if (!paths.length || !Object.is(revision, getRevision()) || phase === 'review' && workflowReady !== true)
        return { ...result(phase), takenOver: false, reason: '主智能体的真实读取或当前版本工作流验证证据尚不完整' };
      const takenOverAgents = [];
      for (const task of [...tasks.values()].filter(t => t.phase === phase)) {
        const resourceFailure = currentAttempt(task)?.resourceFailure;
        if (task.takeover || task.report?.verdict !== 'blocked' || !RESOURCE_CODES.has(resourceFailure?.code) ||
          task.report.findings.some(finding => finding.severity === 'error') ||
          task.executionScope !== task.scopeHash ||
          task.role === 'researcher' && sourceRead !== true ||
          phase === 'review' && (!Object.is(task.revision, revision) || task.executionScope !== task.scopeHash) ||
          task.role === 'verifier' && compileSucceeded !== true) continue;
        const takeover = { by: 'coordinator', phase, revision, at: Date.now(),
          reason: clean(reason || '子智能体达到资源边界；主智能体已取得真实证据并接管剩余职责，原报告仍为未完成'),
          evidence: { readPaths: paths.slice(0, 40), sourceRead: sourceRead === true, workflowReady: workflowReady === true, compileSucceeded: compileSucceeded === true },
          originalFailure: structuredClone(resourceFailure) };
        task.takeover = takeover;
        const execution = currentAttempt(task);
        if (execution) execution.takeover = structuredClone(takeover);
        task.detail = takeover.reason;
        takenOverAgents.push({ id: task.id, role: task.role, report: structuredClone(task.report), takeover: structuredClone(takeover) });
      }
      if (takenOverAgents.length) publish();
      return { ...result(phase), takenOver: takenOverAgents.length > 0, takenOverAgents,
        reason: takenOverAgents.length ? '主智能体已接管资源受限专项，须如实说明原专项未独立完成' : '' };
    },
    coordinatorToolStart() {}, coordinatorToolEnd() {},
    wait() { status = 'waiting'; publish(); }, resume() { if (status === 'waiting') { status = 'running'; publish(); } },
    finish(next, detail = '') {
      if (next === 'completed' && (active || ![...tasks.values()].every(passed) || terminal.has(status) && status !== 'completed')) next = 'failed';
      status = next; summary = detail || summary; controller.abort(); signal?.removeEventListener('abort', abort); publish();
    },
  };
  if (signal?.aborted) abort();
  return api;
}
