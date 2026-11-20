// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, h, KeepAlive, nextTick, ref } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import AgentPanel from './AgentPanel.vue';
import { useAgentStore } from '../../stores/agent.js';
import { useEditorStore } from '../../stores/editor.js';
import { api } from '../../api.js';

vi.mock('../../api.js', () => ({ getToken: () => '', api: { raw: vi.fn() } }));
const mounts = [];
const copy = value => JSON.parse(JSON.stringify(value));
async function flush() { for (let i = 0; i < 6; i++) { await Promise.resolve(); await nextTick(); } }
const modal = () => document.querySelector('.agent-worker-popover');
const stub = { render() { return h('div', null, this.$slots.default?.()); } };

async function mountPanel(prepare = () => {}) {
  const host = document.createElement('div'); document.body.append(host);
  const pinia = createPinia(); setActivePinia(pinia);
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { render: () => null } }] });
  const visible = ref(true);
  const app = createApp({ render: () => h(KeepAlive, {}, { default: () => visible.value ? h(AgentPanel) : null }) });
  app.use(pinia); app.use(router);
  for (const name of ['el-select', 'el-option', 'el-button', 'el-input', 'el-icon']) app.component(name, stub);
  const agent = useAgentStore(), editor = useEditorStore();
  editor.projectId = 'p'; editor.sidebar = 'agent';
  agent.activeChatId = 10;
  agent.loadSettings = vi.fn(async () => (agent.settings = { hasKey: true, model: 'test' }));
  agent.loadChat = vi.fn(async () => {});
  prepare(agent);
  app.mount(host); mounts.push({ app, host }); await flush();
  return { host, agent, editor, visible };
}

const startedAt = 1792824600000;
const meta = { agentId: 'verifier', agentLabel: '验证智能体', agentRole: 'verifier', agentExecutionId: 'verify-1',
  agentPhase: 'review', agentTask: '检查修改后的公式与编译图像。', agentRevision: 2, agentStartedAt: startedAt };
const image = { id: 'page1', label: '编译第 1 页', page: 1, url: '/api/projects/p/agent/artifacts/page1' };
function workflow(status = 'running') {
  return { version: 2, kind: 'multi_agent', label: '文稿修改与核验', status, currentNode: 'coordinator', activeCount: status === 'running' ? 1 : 0, maxConcurrency: 2,
    nodes: [{ id: 'analysis', label: '分析智能体', role: 'analyst', status: 'completed' },
      { id: 'coordinator', label: '协调智能体', role: 'coordinator', status },
      { id: 'verifier', label: meta.agentLabel, role: meta.agentRole, status, executionId: meta.agentExecutionId,
        task: meta.agentTask, startedAt, attempts: 1, revision: 2, history: [{ executionId: meta.agentExecutionId,
          status, task: meta.agentTask, phase: 'review', revision: 2, startedAt, attempt: 1 }] }],
    edges: [{ from: 'analysis', to: 'coordinator', label: '分析结果交接' }, { from: 'coordinator', to: 'verifier', label: '提交修订稿验证' }] };
}
function steps() {
  return [{ type: 'workflow', graph: workflow() },
    { type: 'model_thinking', text: '主模型的公开思考块保留。' },
    { type: 'text', text: '协调模型先确认正文。' },
    { type: 'tool', toolCallId: 'root-read', name: 'read_file', status: 'end', input: { path: 'main.tex' }, result: '主模型读取内容' },
    { type: 'tool', toolCallId: 'dispatch', name: 'run_agent_graph', status: 'start', input: { phase: 'review' }, result: '不应在会话展开的调度 JSON' },
    { type: 'activity', ...meta, agentStatus: 'running', text: '正在检查公式与图像。', phase: 'agent_work', source: 'system' },
    { type: 'tool', ...meta, toolCallId: 'child-compile', name: 'compile_and_preview', status: 'end', ms: 1250,
      input: { pages: '1' }, result: '验证结果正文', display: { version: 1, kind: 'compile', summary: '已编译 1 页', images: [image] } },
    { type: 'text', text: '主模型继续整理结果。' }];
}
async function openWorker(host) {
  const trigger = host.querySelector('.tl-agent-run'); trigger.focus(); trigger.click(); await flush(); return trigger;
}
async function expandTool() {
  const detail = modal().querySelector('.tl-row'); detail.click(); await flush(); return detail;
}
function finish(agent) {
  const completed = copy(agent.liveSteps);
  const graph = completed.find(step => step.type === 'workflow').graph;
  graph.status = 'completed'; graph.activeCount = 0;
  graph.nodes.forEach(node => { if (node.status === 'running') node.status = 'completed'; });
  const report = { verdict: 'needs_changes', summary: '公式标号仍需修正。', findings: [{ severity: 'warning', path: 'main.tex', line: 18, message: '请同步公式引用。' }] };
  Object.assign(graph.nodes[2].history[0], { status: 'completed', finishedAt: startedAt + 2500, durationMs: 2500, usage: { inputTokens: 123, outputTokens: 45 }, report, toolCount: 1 });
  completed.push({ type: 'agent_report', ...meta, status: 'completed', finishedAt: startedAt + 2500, durationMs: 2500, report, usage: { inputTokens: 123, outputTokens: 45 }, toolCount: 1 });
  agent.messages.push({ id: 11, role: 'assistant', content: '本轮检查结束。', steps: completed, runState: 'completed' });
  agent.liveSteps = []; agent.streaming = false; agent.runState = 'completed';
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
    if (this.classList.contains('tl-agent-run')) return { left: 20, right: 290, top: 100, bottom: 126, width: 270, height: 26 };
    if (this.classList.contains('agent-worker-popover')) return { left: 300, right: 700, top: 100, bottom: 400, width: 400, height: 300 };
    return { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 };
  });
  URL.createObjectURL = vi.fn(() => `blob:preview-${URL.createObjectURL.mock.calls.length}`);
  URL.revokeObjectURL = vi.fn();
  api.raw.mockResolvedValue({ blob: async () => new Blob(['png'], { type: 'image/png' }) });
});
afterEach(() => { for (const { app, host } of mounts.splice(0)) { app.unmount(); host.remove(); } vi.restoreAllMocks(); });


describe('local child execution details inside the conversation', () => {
  it('removes the workflow interface while keeping normal parent rows and one compact child entry', async () => {
    const { host } = await mountPanel(agent => { agent.streaming = true; agent.liveSteps = steps(); });
    expect(host.querySelector('.agent-live-progress, .agent-workflow-open, .workflow')).toBeNull();
    expect(host.querySelectorAll('.tl-agent-run')).toHaveLength(1);
    expect(host.querySelector('.tl-agent-run').textContent).toContain('验证智能体正在工作');
    expect(host.querySelectorAll('.tl-row')).toHaveLength(1);
    expect(host.textContent).toContain('协调模型先确认正文。');
    expect(host.querySelector('.thinking-block')).not.toBeNull();
    expect(host.textContent).not.toContain('不应在会话展开的调度 JSON');
    expect(host.textContent).not.toContain('验证结果正文');
    expect(api.raw).not.toHaveBeenCalled();
    await openWorker(host);
    expect(modal().getAttribute('aria-modal')).toBe('false');
    expect(document.querySelector('.agent-work-overlay, .agent-work-dialog')).toBeNull();
    expect(modal().querySelector('.worker-popover-task').open).toBe(false);
    expect(modal().textContent).toContain(meta.agentTask);
    expect(modal().textContent).toContain('正在检查公式与图像。');
    expect(modal().querySelectorAll('.tl-row')).toHaveLength(1);
    expect(modal().querySelector('.tl-phrase').textContent).toBe('编译并预览');
    expect(modal().querySelector('.tl-body')).toBeNull();
    expect(api.raw).not.toHaveBeenCalled();
    await expandTool();
    expect(modal().querySelector('.tool-image-button img').src).toBe('blob:preview-1');
    expect(modal().textContent).toContain('验证结果正文');
  });

  it('keeps live details stable, then closes detached content and reopens the saved execution after completion', async () => {
    const { host, agent } = await mountPanel(agent => { agent.activeMessageId = 11; agent.streaming = true; agent.liveSteps = steps(); });
    await openWorker(host); await expandTool();
    const panel = modal(), thumb = panel.querySelector('.tool-image-button img');
    for (let i = 0; i < 3; i++) {
      agent.liveSteps = copy(agent.liveSteps); agent.liveSteps.at(-1).text += '持续输出'; await flush();
    }
    expect(modal()).toBe(panel); expect(panel.querySelector('.tool-image-button img')).toBe(thumb);
    expect(api.raw).toHaveBeenCalledTimes(1); expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    finish(agent); await flush();
    expect(modal()).toBeNull(); expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview-1');
    host.querySelector('.tl-head').click(); await flush();
    await openWorker(host);
    expect(modal().dataset.executionId).toBe('verify-1');
    expect(modal().querySelector('.worker-popover-status').textContent).toContain('已完成 · 需修正');
    expect(modal().textContent).toContain('公式标号仍需修正。'); expect(modal().textContent).toContain('main.tex:18');
    expect(modal().querySelector('.tl-body')).toBeNull();
    await expandTool(); expect(modal().querySelector('.tool-image-button img')).not.toBeNull();
  });

  it('keeps repeated executions separate and renders report text safely', async () => {
    const graph = workflow('completed'), node = graph.nodes[2];
    node.history = [{ executionId: 'verify-old', status: 'completed', startedAt, finishedAt: startedAt + 1000, task: '初次验证任务', revision: 1, attempt: 1,
      report: { verdict: 'needs_changes', summary: '<img src=x onerror=alert(1)>', findings: [{ severity: 'error', path: 'main.tex', line: 7, message: '<b>标号错误</b>' }] }, thinking: '隐藏推理不展示' },
      { executionId: 'verify-new', status: 'running', startedAt: startedAt + 2000, task: '再次验证任务', revision: 2, attempt: 2 }];
    graph.status = 'running'; node.status = 'running'; node.executionId = 'verify-new';
    const { host, agent } = await mountPanel(agent => { agent.streaming = true; agent.liveSteps = [{ type: 'workflow', graph }]; });
    expect(host.querySelectorAll('.tl-agent-run')).toHaveLength(2);
    host.querySelector('[data-execution-id="verify-old"]').click(); await flush();
    expect(modal().textContent).toContain('初次验证任务'); expect(modal().textContent).not.toContain('再次验证任务');
    expect(modal().textContent).toContain('<img src=x onerror=alert(1)>');
    expect(modal().textContent).not.toContain('隐藏推理不展示');
    expect(modal().querySelector('img')).toBeNull(); expect(modal().querySelector('.worker-popover-report b')).toBeNull();
    agent.liveSteps[0].graph.nodes[2].history[1].report = { verdict: 'pass', summary: '新实例通过' }; await flush();
    expect(modal().dataset.executionId).toBe('verify-old'); expect(modal().textContent).not.toContain('新实例通过');
  });

  it.each(['sidebar', 'project', 'keepalive'])('closes local details and releases image previews on %s change', async change => {
    const view = await mountPanel(agent => { agent.streaming = true; agent.liveSteps = steps(); });
    await openWorker(view.host); await expandTool(); modal().querySelector('.tool-image-button').click(); await flush();
    if (change === 'sidebar') view.editor.sidebar = 'tree';
    else if (change === 'project') view.editor.projectId = 'another-project';
    else view.visible.value = false;
    await flush();
    expect(modal()).toBeNull(); expect(document.querySelector('.tool-image-overlay')).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview-1');
  });

  it('closes the image preview first, then returns focus to the worker row when details close', async () => {
    const { host } = await mountPanel(agent => { agent.streaming = true; agent.liveSteps = steps(); });
    const trigger = await openWorker(host); await expandTool(); modal().querySelector('.tool-image-button').click(); await flush();
    document.querySelector('.tool-image-overlay').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await flush();
    expect(modal()).not.toBeNull(); expect(document.querySelector('.tool-image-overlay')).toBeNull();
    modal().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await flush();
    expect(modal()).toBeNull(); expect(document.activeElement).toBe(trigger);
  });

  it('does not revive old visualization records and still shows attributed historical tools without a graph', async () => {
    const oldGraph = { version: 1, label: '文稿修改', status: 'completed', currentNode: 'verify', nodes: [{ id: 'verify', label: '编译核验', status: 'completed' }], edges: [] };
    const { host, agent } = await mountPanel(agent => {
      agent.messages = [{ id: 5, role: 'assistant', content: '已完成', steps: [{ type: 'workflow', graph: oldGraph }] }];
    });
    expect(host.querySelector('.agent-live-progress, .agent-workflow-open, .workflow')).toBeNull();
    agent.messages = [{ id: 6, role: 'assistant', content: '历史记录', toolCalls: [{ name: 'read_file', agentId: 'researcher', agentLabel: '查证智能体', input: { path: 'refs.bib' }, result: '历史原文' }] }]; await flush();
    host.querySelector('.tl-head').click(); await flush();
    expect(host.querySelectorAll('.tl-agent-run')).toHaveLength(1); expect(host.querySelectorAll('.tl-row')).toHaveLength(0);
    await openWorker(host); await expandTool();
    expect(modal().dataset.executionId).toBe('researcher:legacy'); expect(modal().textContent).toContain('历史原文');
  });
});

it('shows old draft recovery in both live and persisted activity rows with the panel project and chat', async () => {
  const recoveryStep = { type: 'activity', phase: 'draft_recovery', source: 'system', text: '旧草稿已保留，当前轮以当前文件继续。',
    recovery: { draftId: 7, projectId: 'p', chatId: 10, version: 3 } };
  const { host, agent, editor } = await mountPanel(agent => { agent.streaming = true; agent.liveSteps = [copy(recoveryStep)]; });
  expect(host.querySelector('.tl-recovery-download')?.textContent).toBe('下载旧草稿');
  agent.messages = [{ id: 25, role: 'assistant', content: '继续处理', runState: 'completed', steps: [copy(recoveryStep), { type: 'text', text: '继续处理' }] }];
  agent.streaming = false; agent.liveSteps = []; await flush();
  host.querySelector('.tl-head-toggle').click(); await flush();
  expect(host.querySelector('.tl-recovery-download')?.textContent).toBe('下载旧草稿');
  editor.projectId = 'other'; await flush();
  expect(host.querySelector('.tl-recovery-download')).toBeNull();
});
