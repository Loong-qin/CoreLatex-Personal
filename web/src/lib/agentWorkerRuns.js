const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted', 'skipped', 'blocked']);
const LABELS = { editor: '编辑智能体', analyst: '分析智能体', researcher: '查证智能体', reviewer: '审阅智能体', verifier: '验证智能体' };
const CHILD_KINDS = new Set(['tool', 'activity', 'agent_report']);
const value = (source, first, second) => source?.[first] ?? source?.[second];
function timestamp(input) {
  if (input == null || input === '') return null;
  const parsed = typeof input === 'number' ? input : /^\d+$/.test(input) ? Number(input) : Date.parse(input);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
function identity(source) {
  const agentId = String(source?.agentId || source?.id || '');
  const role = source?.agentRole || source?.role;
  if (agentId === 'coordinator' || role === 'coordinator') return null;
  const explicit = source?.agentExecutionId || source?.executionId;
  if (!agentId && !explicit) return null;
  return { executionId: String(explicit || `${agentId}:legacy`), agentId };
}
function rowIdentity(row) {
  return CHILD_KINDS.has(row?.kind) && (row.agentId || row.agentExecutionId) ? identity(row) : null;
}
function phaseOf(row) {
  if (row.agentPhase) return row.agentPhase;
  try { return JSON.parse(row.inputText || '{}').phase || ''; } catch { return ''; }
}
function normalizedStatus(status) {
  return ({ error: 'failed', ok: 'completed', waiting_for_user: 'waiting', superseded: 'interrupted' })[status] || status;
}

/** Merge live/persisted worker rows with graph history by execution identity.
 * A graph node is a role; its attempts are separate runs, never cumulative rows.
 * Times are epoch milliseconds (older ISO snapshots are accepted), unknown=null.
 */
export function buildAgentWorkerRuns(rows = [], graph) {
  rows = Array.isArray(rows) ? rows : [];
  const runs = new Map();
  let serial = 0;
  function record(source, { firstIndex = Infinity, reportEvent = false, currentGraph = false } = {}) {
    const ids = identity(source);
    if (!ids) return null;
    let item = runs.get(ids.executionId);
    if (!item) {
      item = { run: { ...ids, label: '', role: '', phase: '', task: '', status: 'running', revision: null,
        startedAt: null, finishedAt: null, durationMs: null, toolCount: 0, usage: {}, report: null, tools: [], activities: [] },
      firstIndex, serial: serial++, hasReportEvent: false, count: null, explicitDuration: null };
      runs.set(ids.executionId, item);
    }
    const run = item.run;
    if (source.resourceFailure?.code) run.resourceFailure = source.resourceFailure;
    if (source.takeover?.by === 'coordinator') run.takeover = source.takeover;
    item.firstIndex = Math.min(item.firstIndex, firstIndex);
    for (const [field, prefixed] of Object.entries({ agentId: 'agentId', label: 'agentLabel', role: 'agentRole',
      phase: 'agentPhase', task: 'agentTask', revision: 'agentRevision' })) {
      const next = field === 'agentId' ? ids.agentId : value(source, prefixed, field);
      if (next != null && next !== '') run[field] = next;
    }
    const startedAt = timestamp(value(source, 'agentStartedAt', 'startedAt'));
    const finishedAt = timestamp(source.finishedAt);
    if (startedAt != null) run.startedAt = startedAt;
    if (finishedAt != null) run.finishedAt = finishedAt;
    if (Number.isFinite(source.durationMs) && source.durationMs >= 0) item.explicitDuration = source.durationMs;
    const attempt = source.attempt ?? source.attempts;
    if (Number.isInteger(attempt) && attempt > 0) run.attempt = attempt;
    let status = normalizedStatus(value(source, 'agentStatus', 'status'));
    if (source.report && typeof source.report === 'object') {
      // The terminal SSE report is fresher than an older graph snapshot.
      if (reportEvent || !item.hasReportEvent) {
        run.report = source.report;
        if (!status) status = source.report.verdict === 'blocked' ? 'failed' : 'completed';
      }
    }
    if (status && (reportEvent || !TERMINAL.has(run.status) || TERMINAL.has(status))) run.status = status;
    if (!currentGraph || !item.hasHistory) {
      if (source.usage && typeof source.usage === 'object' && (reportEvent || !item.hasReportEvent)) run.usage = { ...source.usage };
      if (Number.isFinite(source.toolCount) && source.toolCount >= 0 && (reportEvent || !item.hasReportEvent)) item.count = source.toolCount;
    }
    if (reportEvent) item.hasReportEvent = true;
    return item;
  }

  if (graph?.version === 2 && graph.kind === 'multi_agent' || graph?.version === 4 && graph.kind === 'orchestration') {
    // v4 root nodes can be validation stages (for example "verify") before
    // workers start. Only instances represent workers; v2 used nodes directly.
    const instances = graph.version === 4 ? graph.instances : graph.nodes;
    for (const node of Array.isArray(instances) ? instances : []) {
      if (!node || node.id === 'coordinator' || node.role === 'coordinator') continue;
      const history = Array.isArray(node.history) ? node.history : [];
      for (const [index, entry] of history.entries()) {
        if (!entry || typeof entry !== 'object') continue;
        const item = record({ id: node.id, label: node.label, role: node.role, phase: node.phase, task: node.task,
          attempt: index + 1, ...entry, agentId: entry.agentId || node.id });
        if (item) item.hasHistory = true;
      }
      const current = identity({ ...node, agentId: node.id });
      const existing = current && runs.get(current.executionId);
      // A pending role with no execution is not a worker invocation. A running
      // worker must still be visible before its first tool/activity arrives.
      if (node.executionId || node.agentExecutionId || node.startedAt != null || node.agentStartedAt != null ||
          ['running', 'waiting'].includes(node.status) || node.report || node.attempts > 0) {
        if (existing?.hasHistory) {
          if (node.takeover?.by === 'coordinator') existing.run.takeover = node.takeover;
          if (node.resourceFailure?.code) existing.run.resourceFailure = node.resourceFailure;
          // History owns per-attempt task/revision/usage/counts. The node may now
          // be pending for a new revision and its counters can be cumulative.
          if (!existing.run.report && node.report) existing.run.report = node.report;
          if (!TERMINAL.has(existing.run.status) && TERMINAL.has(node.status) && (node.status !== 'completed' || existing.run.report)) existing.run.status = node.status;
        } else record({ ...node, agentId: node.id }, { currentGraph: true });
      }
    }
  }

  rows.forEach((row, index) => {
    if (!rowIdentity(row)) return;
    const { status, phase, ...rest } = row;
    const item = record({ ...rest, ...(row.kind === 'agent_report' ? { status } : {}) },
      { firstIndex: index, reportEvent: row.kind === 'agent_report' });
    if (!item) return;
    if (row.kind === 'tool') {
      const base = row.toolCallId || `${item.run.executionId}:tool:${index}`;
      const repeated = item.run.tools.some(tool => tool.key === base);
      item.run.tools.push({ ...row, key: repeated ? `${base}:row:${index}` : base });
    } else if (row.kind === 'activity') item.run.activities.push(row);
  });

  return [...runs.values()].sort((a, b) => {
    if (Number.isFinite(a.firstIndex) && Number.isFinite(b.firstIndex)) return a.firstIndex - b.firstIndex;
    if (a.run.startedAt != null && b.run.startedAt != null && a.run.startedAt !== b.run.startedAt) return a.run.startedAt - b.run.startedAt;
    if (a.firstIndex !== b.firstIndex) return a.firstIndex - b.firstIndex;
    return a.serial - b.serial;
  }).map(({ run, count, explicitDuration, hasReportEvent }) => {
    let status = run.status;
    if (!TERMINAL.has(status) && ['completed', 'failed', 'cancelled', 'interrupted'].includes(graph?.status))
      status = graph.status === 'completed' ? 'interrupted' : graph.status;
    return {
      ...run, status,
      phase: run.phase || (run.role === 'editor' ? 'edit' : ['analyst', 'researcher'].includes(run.role) ? 'analysis' : ['reviewer', 'verifier'].includes(run.role) ? 'review' : ''),
      label: run.label || LABELS[run.role] || `协作智能体（${run.agentId || run.executionId}）`,
      durationMs: explicitDuration ?? (run.startedAt != null && run.finishedAt != null ? Math.max(0, run.finishedAt - run.startedAt) : null),
      toolCount: hasReportEvent && count != null ? count : Math.max(count || 0, run.tools.filter(tool => tool.name !== 'submit_agent_report').length),
    };
  });
}

/** Move child logs into one expandable row per execution, keeping ordinary
 * parent narration/thinking/tools in place. An orphan failed dispatch stays
 * visible: an empty worker graph must never hide the dispatch error. */
export function groupAgentProcessRows(rows = [], graph) {
  rows = Array.isArray(rows) ? rows : [];
  const runs = buildAgentWorkerRuns(rows, graph);
  if (!runs.length) return rows;
  const first = new Map();
  const parents = [];
  rows.forEach((row, index) => {
    const ids = rowIdentity(row);
    if (ids && !first.has(ids.executionId)) first.set(ids.executionId, index);
    if (!ids && row?.kind === 'tool' && row.name === 'run_agent_graph') parents.push({ index, phase: phaseOf(row), row });
  });
  const placements = new Map();
  const hiddenParents = new Set();
  for (const run of runs) {
    let at = first.get(run.executionId);
    if (at != null) {
      const parent = [...parents].reverse().find(item => item.index < at && (!item.phase || item.phase === run.phase));
      if (parent) hiddenParents.add(parent.index);
    } else {
      const matching = parents.filter(item => (!item.phase || item.phase === run.phase) && !['error', 'cancelled'].includes(item.row.state));
      const parent = matching[Math.min(matching.length - 1, Math.max(0, (run.attempt || (run.status === 'running' ? matching.length : 1)) - 1))];
      at = parent?.index ?? rows.length;
      if (parent) hiddenParents.add(parent.index);
    }
    const placed = placements.get(at) || [];
    placed.push({ kind: 'agent_run', key: run.executionId, run });
    placements.set(at, placed);
  }
  const grouped = [];
  for (let index = 0; index <= rows.length; index++) {
    grouped.push(...(placements.get(index) || []));
    const row = rows[index];
    if (row && !rowIdentity(row) && !hiddenParents.has(index)) grouped.push(row);
  }
  return grouped;
}
