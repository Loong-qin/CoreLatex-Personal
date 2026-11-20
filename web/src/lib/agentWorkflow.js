const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const UNFINISHED_STATES = new Set(['pending', 'running', 'waiting']);

export function isExecutionGraph(graph) {
  return !!graph && graph.version === 3 && graph.kind === 'execution'
    && Array.isArray(graph.nodes) && Array.isArray(graph.edges);
}

export function isWorkflowGraph(graph) {
  return !!graph && (graph.version === 1 || graph.version === 2 && graph.kind === 'multi_agent' || graph.version === 4 && graph.kind === 'orchestration' || isExecutionGraph(graph))
    && Array.isArray(graph.nodes) && Array.isArray(graph.edges);
}

function reconcileExecution(graph, runState) {
  const status = TERMINAL_STATES.has(runState) ? runState : graph.status;
  if (!TERMINAL_STATES.has(status)) return graph;
  let changed = graph.status !== status || graph.activeCount !== 0 || graph.activeAgentCount !== 0;
  const nodes = graph.nodes.map(node => {
    if (!node || !UNFINISHED_STATES.has(node.status)) return node;
    changed = true;
    if (status !== 'completed') return { ...node, status };
    if (node.type === 'coordinator' || node.type === 'delivery' || node.id === 'coordinator') return { ...node, status: 'completed' };
    return { ...node, status: 'interrupted', detail: [node.detail, '本轮任务已结束，此节点未记录完整执行结果，无法确认完成。'].filter(Boolean).join('\n') };
  });
  return changed ? { ...graph, status, nodes, activeCount: 0, activeAgentCount: 0 } : graph;
}

// Persisted snapshots may precede a disconnect or server restart. Reconcile every
// active node without inventing a worker report or an unrecorded stage result.
export function workflowForSteps(steps, runState) {
  const graph = [...(Array.isArray(steps) ? steps : [])].reverse()
    .find(step => step?.type === 'workflow' && isWorkflowGraph(step.graph))?.graph;
  if (!graph) return null;
  if (isExecutionGraph(graph)) return reconcileExecution(graph, runState);
  const status = TERMINAL_STATES.has(runState) ? runState : graph.status;
  const execution = isExecutionGraph(graph.execution) ? reconcileExecution(graph.execution, status) : graph.execution;
  if (!TERMINAL_STATES.has(status)) return execution === graph.execution ? graph : { ...graph, execution };
  const multiAgent = graph.version === 2 || graph.version === 4 && graph.tier !== 'off';
  let changed = graph.status !== status || multiAgent && graph.activeCount !== 0 || execution !== graph.execution;
  const nodes = graph.nodes.map(node => {
    if (!node || !UNFINISHED_STATES.has(node.status) || !multiAgent && node.status === 'pending') return node;
    changed = true;
    if (!multiAgent) return { ...node, status };
    if (status === 'completed') {
      if (node.id === 'coordinator' || node.role === 'coordinator') return { ...node, status: 'completed' };
      if (node.status === 'pending') return { ...node, status: 'skipped', detail: node.detail || '本轮任务已结束，此智能体没有开始执行。' };
      return { ...node, status: 'interrupted', detail: [node.detail, '本轮任务已结束，此智能体的完成结果未记录，无法确认。'].filter(Boolean).join('\n') };
    }
    return { ...node, status };
  });
  return changed ? { ...graph, status, nodes, ...(execution ? { execution } : {}), ...(multiAgent ? { activeCount: 0 } : {}) } : graph;
}
