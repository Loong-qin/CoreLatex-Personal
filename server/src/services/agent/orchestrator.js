import { createWorkflowGraph, validateWorkflowPlan } from './workflowGraph.js';
import { createMultiAgentGraph } from './multiAgentGraph.js';
import { createExecutionGraph } from './executionGraph.js';
import { createTaskGraph, validateTaskPlan } from './taskGraph.js';

/** One publication/coordination boundary. Legacy controllers remain private
 * adapters so persisted graphs and existing safety checks retain their meaning. */
export function createOrchestrator({ policy, requestRuntime, signal, onChange = () => {}, task = '', redact = value => value }) {
  let workflow, execution, collaboration, legacy, instances, instanceMode = false, depth = 0, dirty = false;
  let validation = null, projection = null, workers = null, sequence = 0, followups = 0;
  let manual = false;
  const automaticTasks = new Map();
  const snapshot = () => ({ activeCount: 0, revision: 0, ...(workers || validation || { nodes: [], edges: [] }), version: 4, kind: 'orchestration',
    schemaVersion: 4, sequence, tier: policy.tier, validation, execution: projection,
    instances: (workers?.nodes || []).filter(node => node.role !== 'coordinator'),
    gates: { status: validation?.status, current: validation?.currentNode }, budget: requestRuntime.snapshot().repair,
    accounting: requestRuntime.snapshot(),
  });
  const publish = () => { dirty = true; if (!depth) { dirty = false; sequence++; onChange(structuredClone(snapshot())); } };
  const batch = fn => { depth++; try { return fn(); } finally { depth--; if (!depth && dirty) publish(); } };
  workflow = createWorkflowGraph({ allowWebAccess: policy.allowWebAccess !== false, onChange: graph => { validation = graph; publish(); } });
  execution = createExecutionGraph({ task, redact, maxConcurrency: policy.maxConcurrency, onChange: graph => { projection = graph; publish(); } });
  const consumeFollowup = gate => {
    if (gate.ready || gate.failed) return gate;
    if (followups >= (policy.legacy ? 2 : 3)) return { ...gate, failed: true, limitReached: true, code: 'FOLLOWUP_BUDGET_EXHAUSTED' };
    followups++; return gate;
  };
  return {
    workflow, execution, snapshot,
    plan(input) {
      const error = validateWorkflowPlan(input); if (error) return { error };
      return batch(() => {
        const agents = collaboration?.plan(input); if (agents?.error) return agents;
        const validation = workflow.plan({ ...input, automatic: false });
        return { ...validation, collaboration: agents, nextAction: !agents || agents.next === 'direct' ? 'continue' : 'run_agent_graph', phase: agents?.next };
      });
    },
    enableWorkers(options) {
      const update = graph => { workers = graph; publish(); };
      legacy = createMultiAgentGraph({ ...options, tier: policy.tier, onChange: graph => { if (!instanceMode) update(graph); } });
      instances = createTaskGraph({ ...options, onChange: graph => { if (instanceMode) update(graph); } });
      const active = () => instanceMode ? instances : legacy;
      collaboration = new Proxy({}, { get(_target, key) {
        if (key === 'plan') return input => {
          if (input.tasks !== undefined) {
            const error = validateTaskPlan(input.tasks); if (error) return { error };
            if (input.agents !== undefined || input.assignments !== undefined) return { error: 'tasks 与 agents/assignments 不能同时提供' };
            if (policy.tier === 'lite' && (input.tasks.length > 1 || input.tasks.some(t => t.archetype !== 'reviewer')))
              return { error: '轻量协作只允许一个增量审阅任务；更大分工请在设置中选择 full 或 deep' };
            if (!instanceMode && legacy.snapshot().nodes.some(n => n.role !== 'coordinator' && n.status !== 'skipped' &&
              (n.report?.verdict !== 'pass' || n.status !== 'completed'))) return { error: '先解决现有必要任务，不能通过切换计划绕过核验' };
            const result = instances.plan(input); if (result.error) return result;
            instanceMode = true; manual = true; update(instances.snapshot()); return result;
          }
          if (instanceMode) return input.automatic ? { automatic: false } : { error: '当前为任务实例计划，请使用 tasks 更新，不可降级绕过必要核验' };
          if (policy.tier === 'lite' && input.agents?.some(role => role !== 'reviewer')) return { error: '轻量协作仅允许增量审阅任务' };
          const result = legacy.plan(input);
          if (!result.error && !input.automatic) manual = true;
          return result;
        };
        if (key === 'autoExecute') return async input => {
          if (manual) return { automatic: false, executed: false };
          const verifyCompilation = input.requireCompile && input.compileSucceeded !== true;
          if (policy.legacy) return legacy.autoExecute({ ...input, requireCompile: verifyCompilation });
          const { phase, scenario, summary, needsSources, sourcePaths = [], changedPaths = [], localEdit } = input;
          const scope = [...new Set([...(input.readScope || []), ...sourcePaths].filter(Boolean))];
          const next = new Map(automaticTasks);
          const add = (id, archetype, readScope, objective, dependsOn = []) => {
            if (readScope.length) next.set(id, { taskId: id, archetype, readScope, objective, dependsOn });
          };
          if (phase === 'analysis' && policy.analysis) {
            const sourceCheck = needsSources || scenario === 'research';
            if (policy.tier === 'deep' || !localEdit && !sourceCheck)
              add('analysis', 'analyst', scope, '分析本次修改的范围、约束与风险，给出可执行建议。引用已读原文，复用已有证据。');
            if (sourceCheck) add('researcher', 'researcher', sourcePaths.length ? sourcePaths : scope, '核对本次任务所需来源原文，区分事实、推断与未知，报告可核查的路径或来源链接。');
          }
          if (phase === 'review') {
            const deps = [...next.values()].filter(t => ['analyst', 'researcher'].includes(t.archetype)).map(t => ({ taskId: t.taskId, requires: 'usable_report' }));
            if (changedPaths.length) add('reviewer', 'reviewer', changedPaths, '仅核对本轮变更引入的确证事实错误与冲突，每项附变更定位与证据；无确证问题即 pass，不润色返工。', deps);
            if (verifyCompilation && policy.tier !== 'lite') add('verifier', 'verifier', changedPaths.length ? changedPaths : scope, '独立核验当前版本的编译与实际预览，复用相同输入的真实编译产物，区分失败、受阻与通过。', deps);
          }
          if (!next.size) return { automatic: true, executed: false, ready: true, reports: [] };
          const planned = instances.plan({ scenario, summary, tasks: [...next.values()] });
          if (planned.error) return { ...planned, automatic: true, executed: false, ready: false };
          automaticTasks.clear(); for (const [id, task] of next) automaticTasks.set(id, task);
          instanceMode = true; update(instances.snapshot());
          const before = instances.snapshot().executions;
          const result = await instances.execute({ phase });
          return { ...result, automatic: true, executed: instances.snapshot().executions > before };
        };
        if (key === 'execute') return async input => {
          if (!instanceMode && input?.phase === 'all') {
            const analysis = await legacy.execute({ phase: 'analysis' });
            if (!analysis.ready) return analysis;
            const review = await legacy.execute({ phase: 'review' });
            return { ...review, phase: 'all', reports: [...analysis.reports, ...review.reports] };
          }
          return active().execute(input);
        };
        if (key === 'executeEditors') return input => {
          if (!policy.parallelEdits) return Promise.resolve({ error: '当前协作档位不允许并行编辑' });
          const block = active().beforeTool('run_parallel_edits');
          return block ? Promise.resolve({ error: block }) : legacy.executeEditors(input);
        };
        const value = active()[key]; return typeof value === 'function' ? value.bind(active()) : value;
      } });
      return collaboration;
    },
    toolStart(event, { trackValidation = true } = {}) { return batch(() => {
      if (event.name !== 'run_agent_graph') {
        if (trackValidation) workflow.toolStart(event.name);
        collaboration?.coordinatorToolStart(event.name);
      }
      execution.toolStart(event);
    }); },
    toolEnd(event, facts) { return batch(() => {
      execution.toolEnd(event);
      if (event.name !== 'run_agent_graph') { workflow.toolEnd(event.name, facts); collaboration?.coordinatorToolEnd(event.name, facts); }
    }); },
    checkWorkflow: facts => consumeFollowup(workflow.prepareCompletion(facts, { consumeCorrection: false })),
    checkCollaboration: () => collaboration ? consumeFollowup(collaboration.prepareCompletion({ consumeCorrection: false })) : { ready: true },
    finish(status, detail) { return batch(() => { workflow.finish(status, detail); legacy?.finish(status, detail); instances?.finish(status, detail); execution.finish(status, detail); }); },
  };
}
