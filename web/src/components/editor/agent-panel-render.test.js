// @vitest-environment jsdom
// AgentPanel 渲染冒烟测试：时间线形态——轮次头一行小字、过程按序展示、
// 最终回答始终可见、叙述与工具按顺序交错、老消息降级、进行中一轮展开且计时。
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createApp, h, nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { createRouter, createMemoryHistory } from 'vue-router';
import AgentPanel from './AgentPanel.vue';
import { useAgentStore } from '../../stores/agent.js';

// 只关心面板自身逻辑，Element Plus 组件用占位实现
const stub = (name) => ({
  name,
  render() {
    return h('div', null, this.$slots?.default ? this.$slots.default() : null);
  },
});

const mounted = [];
afterEach(() => {
  vi.restoreAllMocks();
  while (mounted.length) {
    const { app, el } = mounted.pop();
    app.unmount();
    el.remove();
  }
});

async function mountPanel(prepare) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const pinia = createPinia();
  setActivePinia(pinia);
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { render: () => null } }],
  });
  const app = createApp({ render: () => h(AgentPanel) });
  app.use(pinia);
  app.use(router);
  for (const n of ['el-select', 'el-option', 'el-button', 'el-input', 'el-icon']) app.component(n, stub(n));
  const agent = useAgentStore();
  agent.loadSettings = async () => {
    agent.settings = { hasKey: true, model: 'test-model' };
    return agent.settings;
  };
  if (prepare) prepare(agent);
  app.mount(el);
  mounted.push({ app, el });
  await new Promise((r) => setTimeout(r, 0));
  await nextTick();
  return { el, agent, app };
}

const head = (el) => el.querySelector('.msg-wrap.assistant .tl-head');

describe('AgentPanel 渲染：时间线', () => {
  it('助手一轮按序展示叙述和工具，最终回答可见，工具详情默认收起', async () => {
    const { el } = await mountPanel((agent) => {
      agent.messages = [
        { id: 1, role: 'user', content: '看下 main.tex\n第二行', createdAt: '2026-09-23 10:00:00' },
        {
          id: 2,
          role: 'assistant',
          content: '先看现状。改好了。',
          createdAt: '2026-09-23 10:03:36',
          steps: [
            { type: 'text', text: '收到，先看现状。' },
            { type: 'tool', name: 'read_file', input: { path: 'main.tex' }, result: '\\documentclass{article}', ms: 120 },
            { type: 'text', text: '改好了。' },
          ],
        },
      ];
    });
    await nextTick();
    const html = el.innerHTML;

    // 用户消息仍是气泡 + Markdown（保留换行）
    expect(el.querySelector('.msg-wrap.user .bubble')).toBeTruthy();
    expect(html).toContain('<br>');
    // 完成后头部收起工作过程，最终回答始终可见
    expect(head(el).textContent).toContain('已工作 3 分 36 秒');
    expect(head(el).tagName).toBe('BUTTON');
    expect(head(el).getAttribute('aria-expanded')).toBe('false');
    expect(el.querySelector('.tl-steps').style.display).toBe('none');
    expect(el.querySelector('.tl-answer').textContent).toContain('改好了。');
    head(el).click(); await nextTick();
    expect(head(el).getAttribute('aria-expanded')).toBe('true');
    expect(el.querySelector('.tl-steps').style.display).toBe('');
    // 展开后叙述和工具行按序可见，工具详情仍默认收起
    expect(el.querySelector('.tl-answer').textContent).toContain('改好了。');
    expect(el.querySelectorAll('.tl-row').length).toBe(1);
    expect(html).toContain('收到，先看现状。');
    expect(html).not.toContain('documentclass');
    // 没有「过程（N）」标题与边框卡片
    expect(html).not.toContain('过程（');
    expect(el.querySelector('.tool-calls')).toBeNull();

    // 叙述与工具行按发生顺序交错
    const blocks = [...el.querySelectorAll('.tl-steps > *')];
    expect(blocks.length).toBe(2);
    expect(blocks[0].classList.contains('tl-text')).toBe(true);
    expect(blocks[0].textContent).toContain('收到，先看现状。');
    expect(blocks[1].querySelector('.tl-row').textContent).toContain('已读取文件');
    expect(blocks[1].querySelector('.tl-row').textContent).toContain('main.tex');
    // 完成后工具行不再转圈
    expect(el.querySelector('.tl-spin')).toBeNull();
    // 默认不显示参数 JSON 与结果正文
    expect(el.querySelector('.tl-body')).toBeNull();
    expect(el.innerHTML).not.toContain('"path"');
    expect(el.innerHTML).not.toContain('documentclass');

    // 点工具行才看参数与结果
    el.querySelector('.tl-row').click();
    await nextTick();
    const body = el.querySelector('.tl-body');
    expect(body.textContent).toContain('参数');
    expect(body.textContent).toContain('"path": "main.tex"');
    expect(body.textContent).toContain('结果');
    expect(body.textContent).toContain('documentclass');
    expect(body.querySelector('.tl-pre')).toBeTruthy();
  });

  it('最终回答走 Markdown 渲染，紧凑样式已注入', async () => {
    const { el } = await mountPanel((agent) => {
      agent.messages = [
        {
          id: 1,
          role: 'assistant',
          content: '# 标题\n\n**加粗** 和 `code`\n\n1. 一\n2. 二\n\n| A | B |\n|---|---|\n| 1 | 2 |',
          createdAt: '2026-09-23 10:00:02',
        },
      ];
    });
    await nextTick();
    const html = el.innerHTML;
    expect(html).toContain('<h1>标题</h1>');
    expect(html).toContain('<strong>加粗</strong>');
    expect(html).toContain('<code>code</code>');
    expect(html).toContain('<li>一</li>');
    expect(html).toContain('<table>');
    expect(html).toContain('.md-chat table');
    expect(html).toContain('white-space: pre-wrap');
    // 缺少上一轮用户消息时不敢编时间，只显示「本轮」
    expect(head(el).textContent).toContain('本轮');
  });

  it('老消息（没有 steps）用 toolCalls 降级出工具步骤行，不缺内容', async () => {
    const { el } = await mountPanel((agent) => {
      agent.messages = [
        { id: 1, role: 'user', content: '改一下', createdAt: '2026-09-23 10:00:00' },
        {
          id: 2,
          role: 'assistant',
          content: '改好了',
          createdAt: '2026-09-23 10:00:08',
          toolCalls: [
            { name: 'edit_file', input: { path: 'main.tex', search: 'a', replace: 'b' }, result: 'ok' },
            { name: 'mcp__github__create_issue', input: { title: 'x' }, result: '{"error":"权限不足"}' },
          ],
        },
      ];
    });
    await nextTick();
    expect(head(el).textContent).toContain('已工作 8 秒');
    expect(el.querySelector('.tl-answer').textContent).toContain('改好了');
    const rows = [...el.querySelectorAll('.tl-row')];
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain('编辑结果待核对');
    expect(rows[1].textContent).toContain('外部工具');
    expect(rows[1].textContent).toContain('github · create_issue');
    // 失败的工具行标红提示
    expect(el.querySelectorAll('.tl-step.error').length).toBe(1);
    expect(el.querySelectorAll('.tl-step.ok').length).toBe(1);
  });

  it('进行中的一轮：默认展开、默认计时、正在跑的一步转圈、流式正文带光标', async () => {
    const { el, agent } = await mountPanel();
    agent.streamStartedAt = Date.now() - 5000;
    agent.streamText = '先读取文件。开始写入 ';
    agent.liveSteps = [
      { type: 'text', text: '先读取文件。' },
      { type: 'tool', name: 'read_file', status: 'end', detail: 'main.tex\nrefs.bib' },
      { type: 'tool', name: 'write_file', status: 'start' },
      { type: 'text', text: '开始写入 ' },
    ];
    agent.streaming = true;
    await nextTick();

    // 展开态默认可见：叙述在前、工具行在后
    expect(head(el).tagName).toBe('DIV');
    expect(head(el).querySelector('.tl-spin')).toBeTruthy();
    const m = /已工作 (\d+) 秒/.exec(head(el).textContent);
    expect(m).toBeTruthy();
    expect(Number(m[1])).toBeGreaterThanOrEqual(5);
    expect(el.querySelectorAll('.tl-text').length).toBe(1);
    expect(el.querySelectorAll('.tl-text')[0].textContent).toContain('先读取文件。');
    expect(el.querySelectorAll('.tl-row').length).toBe(2);
    expect(el.querySelector('.tl-step.running .tl-spin')).toBeTruthy();
    // 末尾叙述就是正在流出的正文，不重复渲染
    const answer = el.querySelector('.tl-answer .md-chat');
    expect(answer.classList.contains('is-streaming')).toBe(true);
    expect(answer.textContent).toContain('开始写入');
    expect(el.querySelectorAll('.tl-text')[0].textContent).not.toContain('开始写入');
  });

  it('在底部时跟随原思考块追加的文本，渲染后使用更新后的内容高度', async () => {
    const { el, agent } = await mountPanel();
    agent.liveSteps = [{ type: 'model_thinking', text: '先确认引用。' }];
    agent.streaming = true;
    await nextTick();
    await nextTick();
    const messages = el.querySelector('.messages');
    // jsdom 无布局，用已渲染的正文模拟新增内容造成的实际高度增长。
    Object.defineProperty(messages, 'clientHeight', { value: 200, configurable: true });
    Object.defineProperty(messages, 'scrollHeight', {
      get: () => messages.querySelector('.thinking-content')?.textContent.includes('再核对公式。') ? 1000 : 800,
      configurable: true,
    });
    messages.scrollTop = 600; messages.dispatchEvent(new Event('scroll'));
    const count = agent.liveSteps.length;
    agent.liveSteps[0].text += '再核对公式。';
    await nextTick();
    await nextTick();
    expect(agent.liveSteps).toHaveLength(count);
    expect(agent.streamText).toBe('');
    expect(messages.querySelector('.thinking-content').textContent).toBe('先确认引用。再核对公式。');
    expect(messages.scrollTop).toBe(1000);
  });

  it('手动向上阅读时，思考文本追加保持用户的滚动位置', async () => {
    const { el, agent } = await mountPanel();
    agent.liveSteps = [{ type: 'model_thinking', text: '先确认引用。' }];
    agent.streaming = true;
    await nextTick();
    await nextTick();
    const messages = el.querySelector('.messages');
    Object.defineProperty(messages, 'clientHeight', { value: 200, configurable: true });
    Object.defineProperty(messages, 'scrollHeight', {
      get: () => messages.querySelector('.thinking-content')?.textContent.includes('再核对公式。') ? 1000 : 800,
      configurable: true,
    });
    messages.scrollTop = 100; messages.dispatchEvent(new Event('scroll'));
    agent.liveSteps[0].text += '再核对公式。';
    await nextTick();
    await nextTick();
    expect(messages.scrollHeight).toBe(1000);
    expect(messages.scrollTop).toBe(100);
  });

  it('移交流式思考为最终消息时保留阅读位置和折叠，并隔离下一轮及清空后的状态', async () => {
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function () {
      return this.classList.contains('thinking-content') ? 800 : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(100);
    const { el, agent } = await mountPanel((state) => {
      state.messages = [{ id: 1, role: 'user', content: '检查引用' }];
      state.liveSteps = [
        { type: 'model_thinking', text: '正在分析的较长思考' },
        { type: 'model_thinking', text: '第二段思考' },
      ];
      state.streaming = true;
    });
    const bodies = el.querySelectorAll('.thinking-content');
    bodies[0].scrollTop = 120; bodies[0].dispatchEvent(new Event('scroll'));
    el.querySelectorAll('.thinking-heading')[1].click(); await nextTick();
    const messages = el.querySelector('.messages');
    Object.defineProperty(messages, 'clientHeight', { value: 200, configurable: true });
    Object.defineProperty(messages, 'scrollHeight', {
      get: () => 800 + messages.querySelectorAll('.tl-row').length * 400,
      configurable: true,
    });
    messages.scrollTop = 600; messages.dispatchEvent(new Event('scroll'));
    agent.liveSteps.push({ type: 'tool', name: 'read_file', status: 'end', detail: 'main.tex' });
    for (let i = 0; i < 3; i++) await nextTick();
    expect(messages.scrollTop).toBe(600); // New output must not move the thought out of view.
    expect(bodies[0].scrollTop).toBe(120);
    const final = { id: 2, role: 'assistant', content: '完成', steps: agent.liveSteps.map((step) => ({ ...step })) };
    agent.messages.push(final);
    agent.liveSteps = [];
    agent.streaming = false;
    for (let i = 0; i < 3; i++) await nextTick();
    expect(head(el).getAttribute('aria-expanded')).toBe('false');
    head(el).click(); for (let i = 0; i < 3; i++) await nextTick();
    const completed = el.querySelectorAll('.thinking-content');
    expect(completed[0]).not.toBe(bodies[0]);
    expect(completed[0].scrollTop).toBe(120);
    expect(completed[1].style.display).toBe('none');
    expect(messages.scrollTop).toBe(600);

    // Returning to the thought's bottom permits normal outer following again.
    completed[0].scrollTop = 700; completed[0].dispatchEvent(new Event('scroll'));
    messages.scrollTop = 1000; messages.dispatchEvent(new Event('scroll'));
    agent.messages[1].steps.push({ type: 'tool', name: 'list_files', status: 'end', detail: 'main.tex' });
    agent.messages.push({ id: 'follow-check', role: 'user', content: '确认' });
    for (let i = 0; i < 3; i++) await nextTick();
    expect(messages.scrollTop).toBe(1600);

    agent.messages.push({ id: 3, role: 'user', content: '继续核对' });
    agent.liveSteps = [{ type: 'model_thinking', text: '新一轮完整思考' }];
    agent.streaming = true;
    for (let i = 0; i < 3; i++) await nextTick();
    const next = [...el.querySelectorAll('.thinking-content')].at(-1);
    expect(next.scrollTop).toBe(800);
    expect(next.style.display).not.toBe('none');
    expect(el.querySelector('.thinking-content').scrollTop).toBe(700);

    agent.streaming = false; agent.resetting = true;
    await nextTick();
    agent.messages = [final]; agent.resetting = false;
    for (let i = 0; i < 3; i++) await nextTick();
    expect(el.querySelector('.thinking-content').scrollTop).toBe(800);
    expect(el.querySelectorAll('.thinking-content')[1].style.display).not.toBe('none');
  });

  it('流式中途（工具在跑，尚无新叙述）正文区只留光标', async () => {
    const { el, agent } = await mountPanel();
    agent.liveSteps = [
      { type: 'text', text: '先看现状。' },
      { type: 'tool', name: 'run_in_workspace', status: 'start' },
    ];
    agent.streaming = true;
    await nextTick();
    expect(head(el).textContent).toContain('已工作');
    expect(el.querySelector('.tl-answer .md-chat.is-streaming').textContent).toBe('');
    expect(el.querySelectorAll('.tl-row').length).toBe(1);
    expect(el.querySelector('.tl-row').textContent).toContain('正在运行命令');
  });

  it('只调工具没说话的助手消息：不渲染空气泡，仍有轮次头与步骤行', async () => {
    const { el } = await mountPanel((agent) => {
      agent.messages = [
        {
          id: 1,
          role: 'assistant',
          content: '',
          createdAt: '2026-09-23 10:00:01',
          steps: [{ type: 'tool', name: 'list_files', input: {}, result: 'a.tex\nb.tex' }],
        },
      ];
    });
    await nextTick();
    expect(el.querySelectorAll('.bubble').length).toBe(0);
    expect(el.querySelector('.tl-answer')).toBeNull();
    expect(head(el)).toBeTruthy();
    expect(el.querySelector('.tl-row').textContent).toContain('已列出文件');
  });

  it('流结束后这一轮的步骤由消息自身承载，进行中的时间线不再重复显示', async () => {
    const { el, agent } = await mountPanel();
    agent.messages = [
      {
        id: 1,
        role: 'assistant',
        content: '读完了',
        createdAt: '2026-09-23 10:00:04',
        steps: [
          { type: 'tool', name: 'read_file', input: { path: 'main.tex' }, result: 'ok' },
          { type: 'text', text: '读完了' },
        ],
      },
    ];
    agent.liveSteps = [
      { type: 'tool', name: 'read_file', status: 'end', detail: 'ok' },
      { type: 'text', text: '读完了' },
    ];
    agent.streaming = false;
    await nextTick();
    expect(el.querySelectorAll('.timeline').length).toBe(1);
    expect(el.querySelector('.md-chat.is-streaming')).toBeNull();
  });
});
