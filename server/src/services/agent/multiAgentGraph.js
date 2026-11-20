import { nonBlockingReview } from './reviewerPolicy.js';

const SCENARIOS = { answer: '解答协作', research: '资料核查协作', edit: '文稿修改协作', compile: '编译修复协作', diagnose: '只读诊断协作' };
const WRITE_TOOLS = new Set(['edit_file', 'write_file', 'copy_to_project', 'run_parallel_edits', 'run_in_workspace', 'run_skill_script']);
const REVIEW_IDS = ['reviewer', 'verifier'];
const ROLES = ['analyst', 'researcher', 'reviewer', 'verifier'];
// Retain old resource codes for persisted reports; new workers use time_limit.
const RESOURCE_CODES = new Set(['time_limit', 'token_budget', 'turn_limit', 'tool_limit']);
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const clean = (value, limit = 1200) => String(value ?? '').trim().slice(0, limit);
const clone = value => structuredClone(value);
const validPath = value => typeof value === 'string' && value.trim() && !value.startsWith('/') && !value.includes('\\') && !value.includes(':') && !value.split('/').some(part => part === '..' || part === '.');
const positive = (value, fallback) => Number.isInteger(value) && value > 0 ? value : fallback;

/** Per-run, provider-independent DAG scheduler. Workers receive reports, never
 * another worker's private conversation or a shared mutable execution context. */
export function createMultiAgentGraph({ onChange = () => {}, executeTask, getRevision = () => 0,
  maxConcurrency = 2, maxCorrections = 2, signal, tier = 'full', isReportCurrent } = {}) {
  if (typeof executeTask !== 'function') throw new TypeError('executeTask is required');
  maxConcurrency = positive(maxConcurrency, 2);
  maxCorrections = positive(maxCorrections, 2);
  const controller = new AbortController();
  let planned = false, manuallyPlanned = false, needsSources = false, needsVerifier = false, repairVerification = false;
  let planRevision = 0, executions = 0, validationExecutions = 0, editorBatchSerial = 0, corrections = 0, activePromise = null, activePhase = '', waiting = null, autoAnalysisScope = '';
  const sources = new Set();
  const selectedRoles = new Set(), attemptInputs = new Map(), assignments = new Map();
  const graph = {
    version: 2, kind: 'multi_agent', scenario: 'planning', label: '多智能体协作', status: 'running',
    currentNode: 'coordinator', activeCount: 0, maxConcurrency, executions: 0,
    validationExecutions: 0,
    revision: getRevision(), planRevision: 0,
    nodes: [
      { id: 'analysis', role: 'analyst', label: '分析智能体', phase: 'analysis', status: 'skipped' },
      { id: 'researcher', role: 'researcher', label: '查证智能体', phase: 'analysis', status: 'skipped' },
      { id: 'coordinator', role: 'coordinator', label: '主智能体', phase: 'coordination', status: 'running' },
      { id: 'reviewer', role: 'reviewer', label: '审阅智能体', phase: 'review', status: 'skipped' },
      { id: 'verifier', role: 'verifier', label: '验证智能体', phase: 'review', status: 'skipped' },
    ].map(node => ({ ...node, attempts: 0, visits: 0, toolCount: 0, usage: {}, history: [] })),
    edges: [],
  };
  const node = id => graph.nodes.find(item => item.id === id);
  const analysisIds = () => ['analysis', 'researcher'].filter(id => selectedRoles.has(node(id).role));
  const reviewIds = () => REVIEW_IDS.filter(id => selectedRoles.has(id));
  const successful = item => item.status === 'completed' && item.report && item.report.verdict !== 'blocked';
  const covered = item => (successful(item) || Boolean(item.takeover)) && item.executionScope === taskScope(item);
  const analysisReady = () => planned && analysisIds().every(id => covered(node(id)));
  const reviewPassed = item => currentReview(item) && (item.report?.verdict === 'pass' || Boolean(item.takeover));
  const isTerminal = () => TERMINAL.has(graph.status);
  const taskScope = item => item.role === 'editor' ? JSON.stringify([item.editorTaskId, item.task, item.scope]) : JSON.stringify([graph.scenario, item.role, [...sources].sort(), assignments.get(item.role) || '',
    item.role === 'verifier' && repairVerification,
    item.phase === 'review' ? analysisIds().map(id => [node(id).role, assignments.get(node(id).role) || '']) : null]);
  const reportFresh = item => isReportCurrent ? isReportCurrent(item, getRevision()) : Object.is(item.revision, getRevision());
  const currentReview = item => covered(item) && reportFresh(item) && item.executionScope === taskScope(item);
  function invalidate(item, detail) {
    attemptInputs.delete(item.id);
    delete item.takeover;
    delete item.resourceFailure;
    if (item.report) {
      item.lastReport = item.report;
      item.lastRevision = item.revision;
      delete item.report;
    }
    item.status = 'pending';
    item.detail = detail;
    delete item.revision;
    delete item.planRevision;
  }
  function refresh() {
    graph.revision = getRevision();
    graph.executions = executions;
    graph.validationExecutions = validationExecutions;
    graph.planRevision = planRevision;
    if (isTerminal()) return;
    for (const id of reviewIds()) {
      const item = node(id);
      if (item.status !== 'running' && item.revision !== undefined &&
        (!reportFresh(item) || item.executionScope !== taskScope(item))) {
        invalidate(item, '草稿或任务范围已变化，等待独立智能体重新审阅当前版本');
      }
    }
  }
  const snapshot = () => { refresh(); return clone(graph); };
  const publish = () => onChange(snapshot());
  function cancelled() {
    if (!controller.signal.aborted) controller.abort(signal?.reason || new Error('协作任务已取消'));
    if (!isTerminal()) {
      graph.status = 'cancelled';
      graph.detail = '协作任务已取消，未完成的报告不作为通过证据';
      for (const item of graph.nodes) if (item.status === 'running' || item.status === 'waiting') {
        item.status = 'pending'; item.detail = '已停止，未完成';
      }
      publish();
    }
  }
  const externalAbort = () => cancelled();
  if (signal?.aborted) cancelled();
  else signal?.addEventListener('abort', externalAbort, { once: true });

  function taskFor(item) {
    if (item.role === 'editor') return { id: item.id, editorTaskId: item.editorTaskId, role: 'editor', label: item.label,
      task: item.task, scope: clone(item.scope), phase: 'edit', scenario: 'edit' };
    const scope = `本轮任务：${graph.summary || ''}。路线：${graph.scenario}。`;
    const sourceText = sources.size ? `明确来源路径：${[...sources].join('、')}。` : '';
    const instructions = {
      analysis: '独立读取必要上下文，分析用户目标、明确编辑范围与执行约束，交付可执行建议；引用已读原文，只读核验，不修改文件、不代主智能体作决定。',
      researcher: graph.scenario === 'edit'
        ? '独立核对本次修改涉及的本地正文、表格、数据与引用，实际读取相关非空文件作为证据，报告事实依据、矛盾与缺口；不要求外部联网，只读核验。'
        : '独立核查任务所需的资料、引用与事实，实际读取允许访问的来源正文，报告证据与缺口；遵循联网权限，只读核验。',
      reviewer: '仅检查本轮新增、修改或删除的内容是否引入内容冲突或事实性错误；相关原文仅作核对依据，不审查未改动部分的优化空间。每项错误须定位变更并提供真实证据；不提润色、扩写、结构优化或可选改进，未发现确证错误即可通过，只读核验。',
      verifier: graph.scenario === 'diagnose' && !repairVerification
        ? '独立验证只读诊断报告是否有实际编译证据并准确解释成功或错误；诊断任务不要求修复编译错误，只读核验。'
        : '独立核对当前草稿的编译、排版与执行证据，检查是否为最新版本及是否存在未解决错误；只读核验，不声称未经验证的成功。',
    };
    const assignment = assignments.get(item.role);
    return { id: item.id, role: item.role, label: item.label, task: scope + sourceText + instructions[item.id] +
      (assignment ? `\n本角色独立任务：${assignment}` : ''), phase: item.phase, scenario: graph.scenario };
  }
  function updateTasks() {
    for (const item of graph.nodes) {
      if (item.role === 'editor') continue;
      const task = item.id === 'coordinator' ? '汇总独立智能体报告，执行用户授权的修改与验证，并交付结果' : taskFor(item).task;
      if (item.executionScope !== taskScope(item)) delete item.takeover;
      item.task = task;
    }
    for (const item of graph.nodes) if (item.id !== 'coordinator' && item.role !== 'editor' && !selectedRoles.has(item.role)) {
      item.status = 'skipped';
      item.detail = selectedRoles.size ? `本轮未分派${item.label}专项，由主智能体或已选专项处理`
        : '当前任务由主智能体直接处理，未分派此专项';
    }
    graph.agents = [...selectedRoles];
    graph.edges = [
      ...analysisIds().map(from => ({ from, to: 'coordinator', label: '分析报告' })),
      ...reviewIds().map(to => ({ from: 'coordinator', to, label: '当前草稿与分析报告' })),
    ];
  }
  const terminalResult = reason => ({ ready: false, failed: true, reason });
  function resultFor(phase, reason = '') {
    refresh();
    const ids = phase === 'analysis' ? analysisIds() : reviewIds();
    const ready = ids.every(id => phase === 'analysis' ? covered(node(id)) : reviewPassed(node(id)));
    return {
      phase, ready: ready && !isTerminal(), failed: isTerminal() && graph.status !== 'completed',
      ...(reason ? { reason } : {}),
      reports: ids.filter(id => node(id).report).map(id => {
        const item = node(id);
        return clone({ id, role: item.role, report: item.report, revision: item.revision, toolCount: item.toolCount, usage: item.usage,
          ...(item.resourceFailure ? { resourceFailure: item.resourceFailure } : {}), ...(item.takeover ? { takeover: item.takeover } : {}) });
      }),
    };
  }
  function blockDependencies() {
    for (const id of reviewIds()) {
      const item = node(id);
      item.blockedBy = analysisIds().filter(dep => !covered(node(dep)));
      if (item.blockedBy.length) item.detail = '依赖的分析/查证尚未成功，不能启动审阅';
      else delete item.blockedBy;
    }
  }
  function sumUsage(previous, next) {
    const result = { ...previous };
    for (const [key, value] of Object.entries(next || {})) {
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) result[key] = (Number(result[key]) || 0) + value;
      else if (value && typeof value === 'object' && !Array.isArray(value)) result[key] = sumUsage(result[key] || {}, value);
    }
    return result;
  }
  async function callWorker(task, context) {
    let abort;
    const aborted = new Promise((_, reject) => {
      abort = () => reject(controller.signal.reason || new Error('协作任务已取消'));
      controller.signal.addEventListener('abort', abort, { once: true });
    });
    try {
      controller.signal.throwIfAborted();
      return await Promise.race([Promise.resolve().then(() => executeTask(clone(task), context)), aborted]);
    } finally {
      controller.signal.removeEventListener('abort', abort);
    }
  }
  async function runNode(id, revision, plannedAt) {
    const item = node(id);
    const dependencies = item.phase === 'review'
      ? analysisIds().map(dep => ({ id: dep, role: node(dep).role, report: clone(node(dep).report), ...(node(dep).takeover ? { takeover: clone(node(dep).takeover) } : {}) })) : [];
    executions++; if (item.role !== 'editor') validationExecutions++; item.attempts++; item.visits++;
    const executionScope = taskScope(item);
    attemptInputs.set(id, { revision, executionScope });
    const started = Date.now();
    const task = { ...taskFor(item), executionId: `${id}-${item.attempts}`, startedAt: started };
    const instance = { ...clone(task), revision, planRevision: plannedAt, executionScope, status: 'running', finishedAt: null, durationMs: null,
      report: null, toolCount: 0, usage: {} };
    item.executionId = task.executionId; item.startedAt = task.startedAt;
    item.finishedAt = null; item.durationMs = null;
    item.history.push(instance);
    item.status = 'running'; item.detail = '独立智能体正在执行任务';
    if (item.report) { item.lastReport = item.report; item.lastRevision = item.revision; }
    delete item.report; delete item.blockedBy; delete item.takeover; delete item.resourceFailure;
    graph.activeCount++; graph.currentNode = id; publish();
    try {
      const result = await callWorker(task, { dependencies, revision, signal: controller.signal });
      if (controller.signal.aborted || isTerminal()) return;
      const report = item.role === 'reviewer' ? nonBlockingReview(result?.report) : result?.report;
      if (!report || typeof report.summary !== 'string' || !report.summary.trim() ||
        !['pass', 'needs_changes', 'blocked'].includes(report.verdict) || !Array.isArray(report.findings)) {
        throw new Error('智能体未返回有效的结构化报告');
      }
      const toolCount = Number(result.toolCount);
      if (Number.isFinite(toolCount) && toolCount > 0) instance.toolCount = Math.floor(toolCount);
      instance.usage = sumUsage({}, result.usage);
      item.toolCount += instance.toolCount;
      item.usage = sumUsage(item.usage, result.usage);
      item.report = clone(report); item.revision = revision; item.planRevision = plannedAt; item.executionScope = executionScope;
      if (RESOURCE_CODES.has(result.resourceFailure?.code) && report.verdict === 'blocked') {
        item.resourceFailure = clone(result.resourceFailure); instance.resourceFailure = clone(result.resourceFailure);
      }
      instance.report = clone(report); instance.status = report.verdict === 'blocked' ? 'failed' : 'completed';
      if (item.phase === 'review' && (!Object.is(revision, getRevision()) || executionScope !== taskScope(item))) {
        instance.stale = true;
        invalidate(item, '执行期间草稿或计划发生变化，此报告已过期，须审阅最新版本');
      } else {
        item.status = report.verdict === 'blocked' ? 'failed' : 'completed';
        item.detail = clean(report.summary);
      }
      return result;
    } catch (error) {
      instance.status = controller.signal.aborted ? (graph.status === 'interrupted' ? 'interrupted' : 'cancelled') : 'failed';
      instance.report = { verdict: 'blocked', summary: clean(controller.signal.aborted ? '本次执行已停止，未取得有效报告' : error?.message || error || '智能体执行失败'), findings: [] };
      if (!controller.signal.aborted && !isTerminal()) {
        item.status = 'failed'; item.detail = clean(error?.message || error || '智能体执行失败');
        item.revision = revision; item.planRevision = plannedAt; item.executionScope = executionScope;
      }
      return { report: clone(instance.report), toolCount: instance.toolCount, usage: clone(instance.usage) };
    } finally {
      if (instance.status === 'running') {
        instance.status = graph.status === 'interrupted' ? 'interrupted' : controller.signal.aborted ? 'cancelled' : 'failed';
        instance.report = { verdict: 'blocked', summary: '本次执行未完成，报告不能作为通过证据', findings: [] };
      }
      instance.finishedAt = Date.now();
      instance.durationMs = Math.max(0, instance.finishedAt - started);
      item.finishedAt = instance.finishedAt; item.durationMs = instance.durationMs;
      graph.activeCount--;
      blockDependencies();
      if (!graph.activeCount && !isTerminal() && graph.status !== 'waiting') graph.currentNode = 'coordinator';
      publish();
    }
  }
  async function executePhase(phase) {
    refresh();
    if (isTerminal() || controller.signal.aborted) return resultFor(phase, graph.detail || '本轮协作已停止');
    if (!planned) return resultFor(phase, '请先调用 plan_task_graph 规划协作任务');
    if (graph.status === 'waiting') return resultFor(phase, '等待用户回答后继续协作');
    if (phase === 'review' && !analysisReady()) {
      blockDependencies(); publish();
      return resultFor(phase, '分析/查证智能体尚未完成，先执行 analysis 阶段');
    }
    const revision = getRevision(), plannedAt = planRevision;
    const ids = phase === 'analysis' ? analysisIds() : reviewIds();
    // Reuse every outcome, including blocked reports and exceptions. Asking
    // again without a new draft, user input, or plan cannot spend another call.
    const pending = ids.filter(id => {
      if (phase === 'review' && currentReview(node(id))) return false;
      const previous = attemptInputs.get(id);
      return !previous || !Object.is(previous.revision, revision) || previous.executionScope !== taskScope(node(id));
    });
    let index = 0;
    async function worker() {
      while (index < pending.length && !controller.signal.aborted && !isTerminal()) {
        const id = pending[index++];
        await runNode(id, revision, plannedAt);
      }
    }
    await Promise.all(Array.from({ length: Math.min(maxConcurrency, pending.length) }, worker));
    const reason = !pending.length && ids.length ? '已复用相同输入版本的专项结果；只有实际修改、新用户指令或任务范围变化后才重新执行'
        : !ids.length ? '本阶段未分派专项，由主智能体直接处理' : '';
    return resultFor(phase, reason);
  }

  const api = {
    snapshot,
    plan({ scenario, summary, needsSources: requestedSources = false, sourcePaths = [], agents = [], assignments: requestedAssignments = {}, automatic = false } = {}) {
      if (isTerminal()) return { error: '本轮协作已结束，不能重新规划绕过结果' };
      if (activePromise) return { error: '独立智能体执行中，请先等待本阶段结果再更新计划' };
      if (!Object.hasOwn(SCENARIOS, scenario) || !clean(summary)) return { error: '请提供有效任务路线与简短行动摘要' };
      if (!Array.isArray(sourcePaths) || sourcePaths.length > 20 || sourcePaths.some(path => !validPath(path))) return { error: 'sourcePaths 需为最多20个有效项目相对路径' };
      if (!Array.isArray(agents) || agents.length > 4 || agents.some(role => !ROLES.includes(role))) return { error: 'agents 只能选择 analyst、researcher、reviewer、verifier；不需要专项时使用空数组' };
      if (!requestedAssignments || typeof requestedAssignments !== 'object' || Array.isArray(requestedAssignments) ||
        Object.entries(requestedAssignments).some(([role, task]) => !ROLES.includes(role) || typeof task !== 'string' || !clean(task)))
        return { error: 'assignments 需为所选角色对应的明确任务说明，角色仅限 analyst、researcher、reviewer、verifier' };
      const previous = JSON.stringify([graph.scenario, graph.summary, needsSources, [...selectedRoles], [...sources], [...assignments]]);
      planned = true;
      manuallyPlanned ||= automatic !== true;
      for (const [role, task] of Object.entries(requestedAssignments)) assignments.set(role, clean(task));
      const retainedRoles = [];
      if (automatic !== true) {
        // Explicit replanning replaces assignments. Historical execution records
        // remain available; only unresolved substantive failures retain a gate.
        for (const role of [...selectedRoles]) if (!agents.includes(role)) {
          const item = graph.nodes.find(item => item.role === role);
          const unresolved = item.report?.verdict === 'needs_changes' || item.report?.verdict === 'blocked' &&
            (!RESOURCE_CODES.has(item.resourceFailure?.code) || item.report.findings.some(finding => finding.severity === 'error')) ||
            item.status === 'failed' && !item.report;
          if (unresolved) retainedRoles.push(role);
          else { selectedRoles.delete(role); assignments.delete(role); delete item.takeover; }
        }
        sources.clear();
        needsSources = requestedSources === true || scenario === 'research';
      } else needsSources ||= requestedSources === true || scenario === 'research';
      agents.forEach(role => selectedRoles.add(role));
      needsVerifier = selectedRoles.has('verifier');
      repairVerification ||= ['edit', 'compile'].includes(scenario);
      sourcePaths.forEach(path => sources.add(path.trim()));
      graph.scenario = scenario; graph.label = SCENARIOS[scenario];
      graph.summary = clean(summary); graph.detail = graph.summary;
      if (previous !== JSON.stringify([scenario, graph.summary, needsSources, [...selectedRoles], [...sources], [...assignments]])) planRevision++;
      for (const item of graph.nodes) if (selectedRoles.has(item.role) && item.status === 'skipped') Object.assign(item, { status: item.report ? item.report.verdict === 'blocked' ? 'failed' : 'completed' : 'pending',
        detail: item.report ? '已重新选择此专项，按任务范围和草稿版本复用或更新结果' : '已分派此专项，等待实际执行' });
      updateTasks(); refresh(); blockDependencies(); publish();
      return { scenario, summary: graph.summary, needsSources, sourcePaths: [...sources], agents: [...selectedRoles], needsVerifier,
        ...(retainedRoles.length ? { retainedRoles, reason: '仍有真实问题或非资源阻塞未解决，保留对应专项职责；不能通过重规划隐藏这些结果' } : {}),
        next: !selectedRoles.size ? 'direct' : analysisReady() ? 'review' : 'analysis' };
    },
    // The host calls this from observed work, not from model-specific prompt
    // compliance. Explicit plans remain authoritative, including agents: [].
    async autoExecute({ phase, scenario = graph.scenario, summary = graph.summary,
      needsSources: requestedSources = false, sourcePaths = [], changedPaths = [], requireCompile = false } = {}) {
      if (manuallyPlanned) return { automatic: false, executed: false };
      if (!['analysis', 'review'].includes(phase)) return { error: 'phase 必须为 analysis 或 review', automatic: true, executed: false };
      if (isTerminal() || controller.signal.aborted) return { ...resultFor(phase, graph.detail), automatic: true, executed: false };
      const agents = [];
      if (tier !== 'lite' && phase === 'analysis' && ['edit', 'compile', 'diagnose', 'research'].includes(scenario)) {
        agents.push('analyst');
        if (requestedSources || scenario === 'research') agents.push('researcher');
      }
      if (phase === 'review') {
        if (changedPaths.length) agents.push('reviewer');
        if (requireCompile && tier !== 'lite') agents.push('verifier');
      }
      if (!agents.length && !selectedRoles.size) return { automatic: true, executed: false, ready: true, reports: [] };
      const planned = api.plan({ scenario, summary: clean(summary) || '按实际任务分工，独立检查后由主智能体汇总交付',
        needsSources: requestedSources, sourcePaths, agents, automatic: true });
      if (planned.error) return { ...planned, automatic: true, executed: false };
      const before = executions;
      // Initial analysis is about scope, not each draft revision. Retain the
      // completed result until requirements/user input invalidate it explicitly.
      const scope = JSON.stringify(analysisIds().map(id => [id, taskScope(node(id))]));
      const result = phase === 'analysis' && analysisReady() && autoAnalysisScope === scope ? resultFor(phase) : await api.execute({ phase });
      if (phase === 'analysis') autoAnalysisScope = scope;
      return { ...result, automatic: true, executed: executions > before };
    },
    execute({ phase } = {}) {
      if (!['analysis', 'review'].includes(phase)) return Promise.resolve({ error: 'phase 必须为 analysis 或 review' });
      if (activePromise) return activePhase === phase ? activePromise : activePromise.then(() => api.execute({ phase }));
      activePhase = phase;
      activePromise = executePhase(phase).finally(() => { activePromise = null; activePhase = ''; });
      return activePromise;
    },
    // Explicit editor batches have their own bounded fan-out. They never spend
    // the analysis/review budget needed to validate the merged draft afterwards.
    executeEditors({ tasks } = {}) {
      refresh();
      if (isTerminal() || controller.signal.aborted || graph.status === 'waiting' || activePromise)
        return Promise.resolve({ error: '当前阶段不能启动并行编辑，请等待现有任务完成' });
      if (!planned || !analysisReady()) return Promise.resolve({ error: '并行编辑前须完成所选分析/查证' });
      if (!Array.isArray(tasks) || tasks.length < 2 || tasks.length > 4 ||
        tasks.some(task => !task || typeof task.id !== 'string' || !task.id || typeof task.task !== 'string' || !task.task.trim() || !Array.isArray(task.scope) || !task.scope.length) ||
        new Set(tasks.map(task => task.id)).size !== tasks.length)
        return Promise.resolve({ error: '请显式提供2至4个标识唯一且边界明确的编辑任务' });
      const batch = ++editorBatchSerial, revision = getRevision(), plannedAt = planRevision;
      const ids = tasks.map((task, index) => {
        const id = `editor-${batch}-${index + 1}`;
        graph.nodes.push({ id, editorTaskId: task.id, role: 'editor', label: clean(task.label || `编辑智能体 ${index + 1}`, 120),
          task: task.task, scope: clone(task.scope), phase: 'edit', status: 'pending', attempts: 0, visits: 0, toolCount: 0, usage: {}, history: [] });
        return id;
      });
      const results = new Array(ids.length).fill(null);
      let index = 0;
      const worker = async () => {
        while (index < ids.length && !controller.signal.aborted && !isTerminal()) {
          const at = index++;
          const result = await runNode(ids[at], revision, plannedAt);
          results[at] = { id: tasks[at].id, executionId: node(ids[at]).executionId, ...result };
        }
      };
      activePhase = 'edit';
      activePromise = Promise.all(Array.from({ length: Math.min(maxConcurrency, ids.length) }, worker))
        .then(() => ({ phase: 'edit', results: results.filter(Boolean), cancelled: controller.signal.aborted,
          ready: !controller.signal.aborted && results.every(result => result?.report?.verdict === 'pass') }))
        .finally(() => { activePromise = null; activePhase = ''; });
      return activePromise;
    },
    // Host-only recovery: do not rewrite a worker's blocked report as pass.
    // Actual coordinator evidence and final workflow gates remain mandatory.
    takeOverResourceFailures({ phase, readPaths = [], sourceRead = false, workflowReady = false,
      compileSucceeded = false, revision = getRevision(), reason = '' } = {}) {
      refresh();
      if (!['analysis', 'review'].includes(phase) || isTerminal() || activePromise || graph.activeCount || graph.status === 'waiting')
        return { takenOver: false, ready: false, reason: '当前阶段不允许接管子任务' };
      const paths = [...(readPaths instanceof Set || Array.isArray(readPaths) ? readPaths : [])].filter(validPath);
      if (!paths.length || !Object.is(revision, getRevision()) || phase === 'review' && workflowReady !== true)
        return { ...resultFor(phase), takenOver: false, reason: '主智能体的真实读取或当前版本工作流验证证据尚不完整' };
      const ids = phase === 'analysis' ? analysisIds() : reviewIds();
      const takenOverAgents = [];
      for (const id of ids) {
        const item = node(id);
        if (item.takeover || item.report?.verdict !== 'blocked' || !RESOURCE_CODES.has(item.resourceFailure?.code) ||
          item.report.findings.some(finding => finding.severity === 'error') || item.executionScope !== taskScope(item) ||
          item.role === 'researcher' && sourceRead !== true ||
          phase === 'review' && (!Object.is(item.revision, revision) || item.executionScope !== taskScope(item)) ||
          item.role === 'verifier' && compileSucceeded !== true) continue;
        const takeover = { by: 'coordinator', phase, revision, at: Date.now(),
          reason: clean(reason || '子智能体达到资源边界；主智能体已取得真实证据并接管剩余职责，原报告仍为未完成'),
          evidence: { readPaths: paths.slice(0, 40), sourceRead: sourceRead === true,
            workflowReady: workflowReady === true, compileSucceeded: compileSucceeded === true },
          originalFailure: clone(item.resourceFailure) };
        item.takeover = takeover;
        const execution = item.history.find(entry => entry.executionId === item.executionId);
        if (execution) execution.takeover = clone(takeover);
        // Keep failed status and original execution history for honest UI/reporting.
        item.detail = takeover.reason;
        takenOverAgents.push({ id, role: item.role, report: clone(item.report), takeover: clone(takeover) });
      }
      if (takenOverAgents.length) { blockDependencies(); publish(); }
      return { ...resultFor(phase), takenOver: takenOverAgents.length > 0, takenOverAgents,
        reason: takenOverAgents.length ? '主智能体已接管资源受限专项，须如实说明原专项未独立完成' : '' };
    },
    invalidate({ reason = '', includeAnalysis = false } = {}) {
      if (isTerminal()) return { error: '本轮协作已结束' };
      if (activePromise || graph.activeCount) return { error: '独立智能体仍在执行，请等待本阶段结束后更新任务' };
      planRevision++;
      if (includeAnalysis) {
        // A later re-selection must not revive evidence from an earlier user goal.
        attemptInputs.clear();
        for (const item of graph.nodes) if (item.id !== 'coordinator') {
          delete item.executionScope; delete item.takeover; delete item.resourceFailure;
        }
      }
      const ids = includeAnalysis ? [...analysisIds(), ...reviewIds()] : reviewIds();
      for (const id of ids) {
        attemptInputs.delete(id);
        invalidate(node(id), clean(reason || (includeAnalysis
          ? '用户要求已更新，等待智能体重新分析当前任务' : '执行证据已更新，等待重新审阅')));
      }
      graph.detail = clean(reason || '任务上下文已更新');
      blockDependencies(); publish();
      return { invalidated: ids, planRevision };
    },
    beforeTool(name) {
      if (!WRITE_TOOLS.has(name)) return null;
      if (isTerminal()) return '本轮协作已结束，不能继续修改文件';
      if (!analysisReady()) return '执行修改或脚本前，须先规划并执行 analysis 阶段，取得分析/查证智能体的真实报告';
      if (activePromise) return '独立智能体正在检查当前草稿，请等待本阶段结束后再修改或执行脚本';
      return null;
    },
    prepareCompletion({ consumeCorrection = true } = {}) {
      refresh();
      if (isTerminal()) return graph.status === 'completed' ? { ready: true } : terminalResult(graph.detail || '协作未完成');
      let reason = '';
      if (!planned) reason = '尚未规划多智能体任务，请先调用 plan_task_graph';
      else if (graph.status === 'waiting') reason = '等待用户回答后，才能继续验证并完成本轮协作';
      else if (activePromise || graph.activeCount) reason = '独立智能体仍在执行，须等待其真实报告';
      else if (!analysisReady()) reason = '分析/查证任务尚未成功，请执行 analysis 阶段并解决报告中的阻塞';
      else if (!reviewIds().every(id => currentReview(node(id)))) reason = '当前草稿尚未取得完整独立审阅报告，请执行 review 阶段';
      else {
        const failed = reviewIds().map(node).filter(item => !reviewPassed(item));
        if (failed.length) reason = failed.map(item => `${item.label}：${clean(item.report.summary)}`).join('；') + '。请修复后重新执行 review 阶段';
      }
      if (!reason) {
        graph.currentNode = 'coordinator'; graph.detail = selectedRoles.size
          ? '已满足本轮所分派专项的交付条件，等待主智能体完成交付'
          : '本轮由主智能体直接处理，无需额外专项请求'; publish();
        return { ready: true };
      }
      if (!consumeCorrection) return { ready: false, failed: false, reason, message: '【多智能体图编排】' + reason };
      if (corrections >= maxCorrections) {
        graph.status = 'failed'; graph.detail = reason;
        node('coordinator').status = 'failed'; publish();
        return terminalResult(graph.detail);
      }
      corrections++; graph.detail = reason; publish();
      return { ready: false, failed: false, reason,
        message: `【多智能体图编排】${reason}。这是第 ${corrections}/${maxCorrections} 次补执行机会；必须实际执行所需智能体，不得重复完成声明。仍未通过时保留草稿并报告未完成。` };
    },
    coordinatorToolStart(name) {
      if (isTerminal()) return;
      const item = node('coordinator'); item.status = 'running'; item.visits++; item.detail = `执行 ${clean(name, 100)}`;
      graph.currentNode = item.id; publish();
    },
    coordinatorToolEnd(name, { succeeded = true, error = '' } = {}) {
      if (isTerminal()) return;
      const item = node('coordinator'); item.toolCount++; item.detail = succeeded ? `${clean(name, 100)} 已执行` : clean(error || `${name} 执行失败`);
      refresh(); publish();
    },
    wait() {
      if (isTerminal() || waiting) return;
      const item = node(graph.currentNode);
      waiting = { id: item.id, status: item.status };
      item.status = 'waiting'; graph.status = 'waiting'; publish();
    },
    resume() {
      if (!waiting || isTerminal()) return;
      const item = node(waiting.id);
      if (item.status === 'waiting') item.status = waiting.status;
      graph.currentNode = waiting.id; graph.status = 'running'; waiting = null; publish();
    },
    finish(status, detail = '') {
      if (!TERMINAL.has(status)) throw new TypeError('Invalid terminal graph status');
      refresh();
      if (status === 'completed' && (isTerminal() && graph.status !== 'completed' || !analysisReady() ||
        !reviewIds().every(id => reviewPassed(node(id))) || graph.activeCount || graph.status === 'waiting')) {
        status = 'failed'; detail ||= '独立智能体尚未验证当前版本，不能标记完成';
      }
      graph.status = status; graph.detail = clean(detail || (status === 'completed'
        ? graph.nodes.some(item => item.takeover) ? '主智能体已基于实际证据接管资源受限专项并交付；原独立专项未完成'
          : selectedRoles.size ? '已完成本轮分派的专项并交付' : '主智能体已完成本轮任务，未分派额外专项'
        : '本轮协作未完成'));
      graph.currentNode = 'coordinator'; node('coordinator').status = status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : 'pending';
      for (const item of graph.nodes) if (item.status === 'running' || item.status === 'waiting') { item.status = 'pending'; item.detail = '已停止，未完成'; }
      if (!controller.signal.aborted) controller.abort(new Error('本轮协作已结束'));
      signal?.removeEventListener('abort', externalAbort);
      waiting = null; publish();
    },
  };
  updateTasks(); publish();
  return api;
}
