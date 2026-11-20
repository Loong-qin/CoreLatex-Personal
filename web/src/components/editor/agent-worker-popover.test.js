// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, h, nextTick, reactive } from 'vue';
import AgentTimeline from './AgentTimeline.vue';

const mounts = [];
const flush = async () => { for (let i = 0; i < 5; i++) { await Promise.resolve(); await nextTick(); } };
let anchorRect, viewWidth, viewHeight;
const rect = (left, top, width, height) => ({ x: left, y: top, left, top, right: left + width, bottom: top + height, width, height, toJSON() {} });
const meta = (id = 'review-1') => ({ agentId: 'reviewer', agentExecutionId: id, agentRole: 'reviewer', agentLabel: '审阅智能体', agentTask: '核查当前修改的引用。', agentStatus: 'running' });
const tool = (id = 'review-1', content = '已读取的实际正文') => ({ kind: 'tool', name: 'read_file', label: '读取文件', summary: 'main.tex 第 1–20 行',
  toolCallId: id + ':read', state: 'ok', ms: 200, hasBody: true, inputText: '{"path":"main.tex"}', resultText: content, preview: content, ...meta(id) });
const report = (id, summary = '引用仍需修正。') => ({ kind: 'agent_report', ...meta(id), status: 'completed', agentStatus: 'completed',
  report: { verdict: 'needs_changes', summary, findings: [{ severity: 'warning', path: 'main.tex', line: 18, message: '核对引用键。' }] } });
const popover = () => document.querySelector('.agent-worker-popover');
async function mount(props = {}) {
  const state = reactive({ rows: [tool()], live: true, active: true, ...props });
  const host = document.createElement('div'); document.body.append(host);
  const app = createApp({ render: () => h(AgentTimeline, state) });
  app.component('el-icon', { render() { return h('span', this.$slots.default?.()); } });
  app.mount(host); mounts.push({ app, host }); await flush();
  return { host, state };
}
async function open(host, index = 0) {
  const trigger = host.querySelectorAll('.tl-agent-run')[index]; trigger.focus(); trigger.click(); await flush(); return trigger;
}
beforeEach(() => {
  anchorRect = rect(100, 200, 270, 26); viewWidth = window.innerWidth; viewHeight = window.innerHeight;
  window.innerWidth = 1200; window.innerHeight = 800;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
    if (this.classList.contains('tl-agent-run')) return anchorRect;
    if (this.classList.contains('agent-worker-popover')) return rect(0, 0, 400, 300);
    return rect(0, 0, 0, 0);
  });
});
afterEach(() => {
  for (const { app, host } of mounts.splice(0)) { app.unmount(); host.remove(); }
  window.innerWidth = viewWidth; window.innerHeight = viewHeight;
  vi.restoreAllMocks();
});

describe('child agent details anchored at their execution row', () => {

  it('shows change-specific finding evidence safely while keeping optional suggestions nonblocking', async () => {
    const row = report('review-1', '当前变更存在事实冲突。');
    row.report.coverage = [{ path: 'main.tex', truncated: true }];
    row.report.limitations = ['仅核对提供的片段，未核对其他章节。'];
    row.report.findings = [
      { severity: 'error', category: 'conflict', path: 'main.tex', line: 18, side: 'before', message: '删除了与正文结论一致的限定条件。', evidence: { source: 'results.tex:4', quote: '<img src=x onerror=alert(1)> 仅在已知条件下成立。' } },
      { severity: 'info', category: 'suggestion', message: '可选措辞建议。' },
    ];
    const { host } = await mount({ rows: [tool(), row] });
    await open(host);
    const panel = popover();
    expect(panel.textContent).toContain('内容冲突');
    expect(panel.textContent).toContain('差异片段，已截断');
    expect(panel.textContent).toContain('仅核对提供的片段，未核对其他章节。');
    expect(panel.textContent).toContain('main.tex:18（修改前）');
    expect(panel.textContent).toContain('建议 · 不要求修改');
    expect(panel.querySelector('.finding-evidence').open).toBe(false);
    panel.querySelector('.finding-evidence summary').click(); await flush();
    expect(panel.querySelector('.finding-evidence').open).toBe(true);
    expect(panel.querySelector('.finding-evidence').textContent).toContain('results.tex:4');
    expect(panel.querySelector('blockquote').textContent).toContain('<img src=x onerror=alert(1)>');
    expect(panel.querySelector('.worker-popover-report img')).toBeNull();
  });

  it('keeps parallel editors in separate rows and opens only the selected editor draft details', async () => {
    const editor = (id, text) => ({ ...tool(id, text), name: 'edit_file', agentId: id, agentRole: 'editor', agentLabel: '', agentPhase: 'edit' });
    const { host, state } = await mount({ rows: [editor('editor-intro', '引言范围的暂存修改'), editor('editor-method', '方法范围的暂存修改')] });
    expect(host.querySelectorAll('.tl-agent-run')).toHaveLength(2);
    expect(host.querySelectorAll('.tl-agent-run')[0].textContent).toContain('编辑智能体正在工作');
    await open(host, 1);
    popover().querySelector('.tl-row').click(); await flush();
    expect(popover().textContent).toContain('方法范围的暂存修改');
    expect(popover().textContent).not.toContain('引言范围的暂存修改');
    state.rows.push({ ...report('editor-intro', '引言范围已完成暂存修改。'), agentId: 'editor-intro', agentRole: 'editor', agentLabel: '', agentPhase: 'edit' });
    await flush();
    expect(host.querySelectorAll('.tl-agent-run')[0].textContent).toContain('已完成');
    expect(host.querySelectorAll('.tl-agent-run')[1].textContent).toContain('正在工作');
    expect(popover().dataset.executionId).toBe('editor-method');
  });
  it('shows the reporting phase in the same worker row and popover until its actual report finishes', async () => {
    const { host, state } = await mount();
    await open(host);
    state.rows.push({ kind: 'activity', phase: 'reporting', text: '已运行 10 分钟，正在整理已有证据并汇报。', ...meta() });
    await flush();
    expect(host.querySelector('.tl-agent-run').textContent).toContain('正在汇报');
    expect(host.querySelector('.tl-agent-run').classList.contains('running')).toBe(true);
    expect(popover().querySelector('.worker-popover-status').textContent).toContain('正在汇报');
    expect(popover().textContent).toContain('正在整理已有证据并汇报');
    expect(popover().querySelector('.worker-popover-report')).toBeNull();
    state.rows.push(report('review-1', '已核查引用，另有两处需主智能体修正。'));
    await flush();
    expect(host.querySelector('.tl-agent-run').textContent).toContain('已完成 · 需修正');
    expect(host.querySelector('.tl-agent-run').textContent).not.toContain('正在汇报');
    expect(popover().querySelector('.worker-popover-status').textContent).not.toContain('正在汇报');
    expect(popover().querySelector('.worker-popover-report').textContent).toContain('另有两处需主智能体修正');
  });

  it('shows resource handoff without turning the original blocked report into a pass', async () => {
    const blocked = { verdict: 'blocked', summary: '累计 token 预算不足，独立核查未完成。', findings: [] };
    const attempt = { id: 'reviewer', role: 'reviewer', executionId: 'review-1', status: 'failed', report: blocked,
      resourceFailure: { code: 'token_budget' }, takeover: { by: 'coordinator', reason: '已基于真实证据接管。' } };
    const graph = { version: 2, kind: 'multi_agent', status: 'completed', nodes: [{ ...attempt, history: [attempt] }] };
    const { host } = await mount({ rows: [tool(), { ...report('review-1'), status: 'failed', agentStatus: 'failed', report: blocked }], graph });
    expect(host.querySelector('.tl-agent-run').textContent).toContain('资源受限 · 主智能体已接管');
    await open(host);
    expect(popover().textContent).toContain('资源受限 · 主智能体已接管');
    expect(popover().textContent).toContain('独立核查未完成');
    expect(popover().querySelector('.worker-popover-report').textContent).toContain('受阻');
    expect(popover().querySelector('.worker-popover-report').textContent).not.toContain('通过');
  });
  it('opens beside the exact row with ordinary collapsed tool details and no backdrop or global workflow', async () => {
    const { host } = await mount();
    const trigger = await open(host);
    expect(popover()).not.toBeNull();
    expect(popover().getAttribute('aria-modal')).toBe('false');
    expect(popover().dataset.placement).toBe('right');
    expect(popover().style.left).toBe('380px'); expect(popover().style.top).toBe('200px');
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(trigger.getAttribute('aria-controls')).toBe(popover().id);
    expect(document.querySelector('.agent-work-overlay, .agent-work-dialog, .workflow')).toBeNull();
    expect(popover().querySelectorAll('.tl-row')).toHaveLength(1);
    expect(popover().querySelector('.tl-head')).toBeNull();
    expect(popover().textContent).toContain('main.tex 第 1–20 行');
    expect(popover().querySelector('.tl-body')).toBeNull();
    popover().querySelector('.tl-row').click(); await flush();
    expect(popover().querySelector('.tl-body').textContent).toContain('已读取的实际正文');
  });

  it('keeps the selected execution and expanded tool mounted while live reports and other attempts update', async () => {
    const { host, state } = await mount({ rows: [tool('review-old'), report('review-old'), tool('review-new', '另一轮正文')] });
    await open(host); popover().querySelector('.tl-row').click(); await flush();
    const panel = popover(), body = panel.querySelector('.tl-body');
    state.rows = JSON.parse(JSON.stringify(state.rows)); state.rows.push(report('review-new', '另一轮已经通过。')); await flush();
    expect(popover()).toBe(panel); expect(popover().querySelector('.tl-body')).toBe(body);
    expect(panel.dataset.executionId).toBe('review-old');
    expect(panel.textContent).toContain('引用仍需修正。'); expect(panel.textContent).not.toContain('另一轮正文');
    state.rows[1].report.summary = '<img src=x onerror=alert(1)> 尚需核对'; await flush();
    expect(panel.textContent).toContain('<img src=x onerror=alert(1)>'); expect(panel.querySelector('.worker-popover-report img')).toBeNull();
    expect(panel.textContent).toContain('main.tex:18');
  });

  it('closes with Escape or outside pointer and restores only explicitly requested focus', async () => {
    const { host } = await mount(); const trigger = await open(host);
    popover().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); await flush();
    expect(popover()).toBeNull(); expect(document.activeElement).toBe(trigger); expect(trigger.getAttribute('aria-expanded')).toBe('false');
    await open(host); document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })); await flush();
    expect(popover()).toBeNull();
    await open(host); popover().querySelector('[aria-label="关闭子智能体详情"]').click(); await flush();
    expect(document.activeElement).toBe(trigger);
  });

  it('flips to the left near the right edge and fits below the row on a narrow viewport', async () => {
    anchorRect = rect(820, 620, 270, 26);
    const { host } = await mount(); await open(host);
    expect(popover().dataset.placement).toBe('left'); expect(popover().style.left).toBe('410px');
    expect(parseFloat(popover().style.top) + 300).toBeLessThanOrEqual(792);
    popover().querySelector('button').click(); await flush();
    window.innerWidth = 390; window.innerHeight = 700; anchorRect = rect(20, 150, 350, 26);
    await open(host);
    expect(popover().dataset.placement).toBe('bottom'); expect(popover().style.width).toBe('374px');
    expect(parseFloat(popover().style.left)).toBe(8); expect(popover().style.top).toBe('186px');
  });

  it('repositions with scrolling and closes when its row leaves the viewport or the panel becomes inactive', async () => {
    const { host, state } = await mount(); await open(host);
    anchorRect = rect(100, 100, 270, 26); window.dispatchEvent(new Event('scroll')); await new Promise(resolve => setTimeout(resolve, 30)); await flush();
    expect(popover().style.top).toBe('100px');
    anchorRect = rect(100, -80, 270, 26); window.dispatchEvent(new Event('scroll')); await new Promise(resolve => setTimeout(resolve, 30)); await flush();
    expect(popover()).toBeNull();
    anchorRect = rect(100, 200, 270, 26); await open(host); state.active = false; await flush(); expect(popover()).toBeNull();
  });

  it('closes when the chat scroller clips its row, even while the row is inside the page viewport', async () => {
    const { host } = await mount();
    host.style.overflowY = 'auto';
    host.getBoundingClientRect = () => rect(80, 100, 320, 300);
    await open(host); expect(popover()).not.toBeNull();
    anchorRect = rect(100, 420, 270, 26);
    host.dispatchEvent(new Event('scroll')); await new Promise(resolve => setTimeout(resolve, 30)); await flush();
    expect(popover()).toBeNull();
  });

  it('closes without a focus trap when keyboard focus leaves the row and popover', async () => {
    const { host } = await mount(); await open(host);
    const other = document.createElement('button'); document.body.append(other); other.focus(); await flush();
    expect(popover()).toBeNull(); expect(document.activeElement).toBe(other); other.remove();
  });

  it('cleans up teleported content when the local timeline unmounts', async () => {
    const { host } = await mount(); await open(host); expect(popover()).not.toBeNull();
    const entry = mounts.pop(); entry.app.unmount(); entry.host.remove(); await flush();
    expect(popover()).toBeNull();
    window.dispatchEvent(new Event('resize')); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  });
});
