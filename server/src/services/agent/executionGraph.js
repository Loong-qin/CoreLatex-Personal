// A projection of observed execution events, independent of scheduling gates.
// It never plans work or calls a model. Full tool results remain in the timeline.
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const SKIP = new Set(['report_progress', 'submit_agent_report']);
const TYPES = {
  list_files: ['context', '读取上下文'], read_file: ['context', '读取上下文'], read_workspace: ['context', '读取上下文'],
  get_document_context: ['context', '读取上下文'], view_image: ['context', '查看图像'], read_skill: ['context', '读取技能'],
  edit_file: ['edit', '修改文件'], write_file: ['edit', '修改文件'], copy_to_project: ['edit', '复制到项目'], run_parallel_edits: ['edit', '并行编辑'],
  web_search: ['research', '联网检索'], web_fetch: ['source', '读取来源正文'],
  compile_and_preview: ['verify', '编译与预览'], run_in_workspace: ['command', '运行命令'], run_skill_script: ['command', '运行技能脚本'],
  plan_task_graph: ['planning', '安排专项协作'], run_agent_graph: ['collaboration', '执行专项协作'], ask_user: ['waiting', '等待用户回答'],
};
const clean = (value, limit = 600) => String(value ?? '').trim().slice(0, limit);
const clone = value => structuredClone(value);

export function createExecutionGraph({ task = '', onChange = () => {}, now = Date.now, maxStages = 64, maxConcurrency = 2, redact = value => value } = {}) {
  const startedAt = now();
  const root = { id: 'coordinator', type: 'coordinator', role: 'coordinator', label: '主智能体', phase: 'response',
    task: clean(task, 1200), status: 'running', startedAt, finishedAt: null, toolCount: 0, responseCount: 0,
    detail: '已接收任务，正在处理请求', tools: [] };
  const graph = { version: 3, kind: 'execution', label: '实际工作流程', status: 'running', currentNode: root.id,
    startedAt, finishedAt: null, nodes: [root], edges: [], activeCount: 1, activeAgentCount: 0, maxConcurrency,
    toolCount: 0, responseCount: 0, stageCount: 0 };
  const open = new Map(), completedCalls = new Set(), pendingReports = new Set();
  let previous = root, stageSerial = 0, callSerial = 0, activeIntegration = null;
  const node = id => graph.nodes.find(item => item.id === id);
  const terminal = () => TERMINAL.has(graph.status);
  const edge = (from, to, type = 'sequence', label = '') => {
    if (!from || !to || from === to || !node(from) || !node(to)) return;
    if (!graph.edges.some(item => item.from === from && item.to === to && item.type === type)) graph.edges.push({ from, to, type, label });
  };
  const publicValue = value => typeof value === 'string' ? redact(value) : Array.isArray(value) ? value.map(publicValue) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, publicValue(item)])) : value;
  const snapshot = () => {
    graph.activeCount = graph.nodes.filter(item => item.status === 'running').length;
    graph.activeAgentCount = graph.nodes.filter(item => item.type === 'agent' && item.status === 'running').length;
    return publicValue(clone(graph));
  };
  const publish = () => onChange(snapshot());
  const finishNode = (item, status, detail) => {
    item.status = status; item.finishedAt = now(); item.durationMs = Math.max(0, item.finishedAt - item.startedAt);
    if (detail) item.detail = clean(detail);
  };
  function remember(item, record) {
    item.tools.push(record);
    if (item.tools.length > 8) item.tools.shift();
  }
  function closeIntegration() {
    if (activeIntegration?.status === 'running') finishNode(activeIntegration, 'completed', '主智能体已返回对专项反馈的处理');
    activeIntegration = null;
  }
  function newStage(phase, label) {
    closeIntegration();
    let item;
    if (graph.stageCount < maxStages) {
      item = { id: `stage-${++stageSerial}`, type: 'stage', role: 'coordinator', phase, label,
        status: 'running', startedAt: now(), finishedAt: null, toolCount: 0, visits: 0, tools: [] };
      graph.nodes.push(item); graph.stageCount++;
    } else {
      item = node('continued-work');
      if (!item) {
        item = { id: 'continued-work', type: 'stage', role: 'coordinator', phase: 'continued', label: '后续执行',
          status: 'running', startedAt: now(), finishedAt: null, toolCount: 0, visits: 0, tools: [], aggregated: true };
        graph.nodes.push(item);
      }
    }
    edge(previous.id, item.id, previous.status === 'failed' ? 'feedback' : 'sequence', previous.status === 'failed' ? '失败后继续处理' : '继续执行');
    for (const id of pendingReports) edge(id, item.id, 'handoff', '处理专项报告');
    pendingReports.clear(); previous = item; graph.currentNode = item.id;
    return item;
  }
  function callKey(event, create = false) {
    if (event.toolCallId) return `${event.executionId || 'main'}:${event.toolCallId}`;
    const old = [...open].find(([, entry]) => entry.name === event.name && entry.executionId === (event.executionId || ''));
    return old?.[0] || (create ? `${event.executionId || 'main'}:call-${++callSerial}` : '');
  }
  function startTool(event, implicit = false) {
    const key = callKey(event, true);
    if (open.has(key) || completedCalls.has(key) || terminal() || SKIP.has(event.name)) return key;
    const [phase, label] = TYPES[event.name] || ['external', event.name?.startsWith('mcp__') ? '执行外部工具' : '执行工具'];
    let item = event.executionId ? node(`agent-${event.executionId}`) : null;
    if (event.executionId && !item) return key; // No synthetic worker without a real start.
    if (!item) {
      const merge = previous.type === 'stage' && previous.phase === phase && previous.status === 'completed' && !pendingReports.size;
      item = merge ? previous : newStage(phase, label);
      item.status = event.name === 'ask_user' ? 'waiting' : 'running';
      item.finishedAt = null; delete item.durationMs; item.visits++;
      root.status = 'waiting'; root.phase = 'tool'; root.detail = event.name === 'ask_user' ? '正在等待用户回答' : `正在${label}`;
      graph.currentNode = item.id;
    }
    const record = { toolCallId: clean(event.toolCallId, 160), name: clean(event.name, 160), label: clean(event.label || label, 100),
      summary: clean(event.summary || event.input?.path || event.input?.query || '', 300), status: implicit ? 'pending' : 'running', startedAt: now() };
    item.toolCount++; graph.toolCount++;
    if (!event.executionId) root.toolCount++;
    item.detail = `${record.label}${record.summary ? '：' + record.summary : ''}`;
    remember(item, record);
    open.set(key, { item, record, name: event.name, executionId: event.executionId || '' });
    publish(); return key;
  }
  return {
    snapshot,
    responseStart() {
      if (terminal()) return;
      root.responseCount++; graph.responseCount++;
      root.status = 'running'; root.phase = 'response';
      root.detail = root.responseCount === 1 ? '主智能体正在处理用户请求' : '主智能体正在根据当前结果继续处理';
      if (pendingReports.size) {
        activeIntegration = newStage('integration', '处理专项反馈');
        activeIntegration.responseCount = 1;
      }
      graph.currentNode = activeIntegration?.id || root.id; publish();
    },
    responseEnd({ succeeded = true } = {}) {
      if (terminal()) return;
      if (!succeeded && activeIntegration?.status === 'running') { finishNode(activeIntegration, 'failed', '处理专项反馈的模型响应未正常完成'); activeIntegration = null; }
      else closeIntegration();
      publish();
    },
    toolStart: startTool,
    toolEnd(event) {
      if (terminal() || SKIP.has(event.name)) return;
      let key = callKey(event);
      if (completedCalls.has(key)) return;
      if (!open.has(key)) key = startTool(event, true);
      const entry = open.get(key);
      if (!entry) return;
      open.delete(key); completedCalls.add(key);
      const status = event.status === 'cancelled' ? 'cancelled' : event.succeeded === false || event.status === 'error' ? 'failed' : 'completed';
      Object.assign(entry.record, { status, finishedAt: now(), ms: Math.max(0, Number(event.ms) || now() - entry.record.startedAt) });
      if (event.summary) entry.record.summary = clean(event.summary, 300);
      entry.item.detail = clean(event.summary || `${entry.record.label}${status === 'completed' ? '已返回结果' : status === 'cancelled' ? '已取消' : '执行失败'}`);
      if (!event.executionId) {
        finishNode(entry.item, status);
        root.status = 'running'; root.phase = 'response'; root.detail = '已收到工具结果，主智能体继续处理';
        graph.currentNode = root.id;
      }
      publish();
    },
    agentStart(task) {
      if (terminal() || !task.executionId || node(`agent-${task.executionId}`)) return;
      closeIntegration();
      const item = { ...clone(task), id: `agent-${task.executionId}`, agentId: task.id, type: 'agent', status: 'running',
        startedAt: task.startedAt || now(), finishedAt: null, toolCount: 0, tools: [], detail: '独立智能体正在执行所分配任务' };
      graph.nodes.push(item); edge(previous.id, item.id, 'dispatch', '实际分派子任务');
      root.status = 'waiting'; root.detail = '正在等待已分派的专项任务'; publish();
    },
    agentEnd({ executionId, status = 'completed', report, usage, toolCount }) {
      const item = node(`agent-${executionId}`);
      if (terminal() || !item || TERMINAL.has(item.status)) return;
      finishNode(item, status, report?.summary);
      item.report = report ? clone(report) : null; item.usage = usage ? clone(usage) : {};
      if (Number.isFinite(toolCount)) item.toolCount = Math.max(item.toolCount, toolCount);
      pendingReports.add(item.id); publish();
    },
    note(text, { executionId = '', phase = '' } = {}) {
      if (terminal()) return;
      const item = executionId ? node('agent-' + executionId) : root;
      if (!item) return;
      item.detail = clean(text);
      if (phase === 'retry') { item.retryCount = (item.retryCount || 0) + 1; item.phase = phase; }
      publish();
    },
    finish(status, detail = '') {
      if (terminal()) return;
      activeIntegration = null;
      graph.status = status; graph.finishedAt = now();
      for (const item of graph.nodes) if (!TERMINAL.has(item.status)) finishNode(item, status === 'completed' && item.id === root.id ? 'completed' : status === 'completed' ? 'interrupted' : status);
      for (const { record } of open.values()) if (record.status === 'running' || record.status === 'pending') Object.assign(record, { status: status === 'completed' ? 'interrupted' : status, finishedAt: now() });
      open.clear();
      const end = { id: 'delivery', type: 'delivery', role: 'coordinator', label: status === 'completed' ? '本轮完成' : status === 'cancelled' ? '本轮停止' : '本轮未完成',
        status, startedAt: graph.finishedAt, finishedAt: graph.finishedAt, durationMs: 0, detail: clean(detail || (status === 'completed' ? '已结束本轮实际执行' : '保留已发生的执行记录')) };
      graph.nodes.push(end); edge(previous.id, end.id, 'sequence', '本轮结束');
      for (const id of pendingReports) edge(id, end.id, 'handoff', '专项执行结果');
      pendingReports.clear(); graph.currentNode = end.id;
      root.detail = clean(detail || (status === 'completed' ? '本轮处理已完成' : status === 'cancelled' ? '本轮已停止' : '本轮处理未完成'));
      publish();
    },
  };
}
