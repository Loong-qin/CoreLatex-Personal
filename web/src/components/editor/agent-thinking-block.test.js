// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, KeepAlive, nextTick, reactive } from 'vue';
import AgentTimeline from './AgentTimeline.vue';

let app, host;
const flush = async () => { for (let i = 0; i < 3; i++) { await Promise.resolve(); await nextTick(); } };
const thought = (text, extra = {}) => ({ kind: 'thinking', text, ...extra });
const tool = { kind: 'tool', name: 'read_file', label: '已读取文件', state: 'ok', hasBody: true, inputText: '{"path":"main.tex"}', resultText: 'file contents', preview: 'file contents' };
async function mount(initial, render) {
  const state = reactive(initial);
  host = document.createElement('div'); document.body.appendChild(host);
  app = createApp({ render: () => render ? render(state) : h(AgentTimeline, state) });
  app.component('el-icon', { render() { return h('span', this.$slots.default?.()); } });
  app.mount(host); await flush();
  return state;
}
afterEach(() => { app?.unmount(); host?.remove(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('inline model thinking blocks', () => {
  it('expands completed work to show thinking, narration and tools in event order', async () => {
    await mount({
      rows: [
        thought('先确认章节引用。', { durationMs: 1400 }),
        { kind: 'text', text: '正在读取相关文件。' },
        tool,
        thought('引用已核对，准备给出结果。', { durationMs: 2000 }),
      ], answerHtml: '<p>检查完成。</p>',
    });
    expect(host.querySelector('.tl-steps').style.display).toBe('none');
    host.querySelector('.tl-head').click(); await flush();
    const blocks = [...host.querySelector('.tl-steps').children];
    expect(blocks.map((el) => el.classList[0])).toEqual(['thinking-block', 'tl-text', 'tl-step', 'thinking-block']);
    expect(blocks[0].querySelector('.thinking-heading').textContent).toContain('思考 · 持续了 1.4 秒');
    expect(blocks[0].querySelector('.thinking-content').textContent).toBe('先确认章节引用。');
    expect(blocks[3].textContent).toContain('持续了 2 秒');
    expect(host.querySelector('.tl-head').tagName).toBe('BUTTON');
    expect(host.querySelector('.tl-answer').textContent).toBe('检查完成。');
    expect(host.querySelector('.thinking-box')).toBeNull();
    expect(host.querySelector('.thinking-footer')).toBeNull();
    expect(host.textContent).not.toContain('回到最新');
  });

  it('folds each thinking block independently while tool details keep their own toggle', async () => {
    await mount({ rows: [thought('第一段'), tool, thought('第二段')] });
    host.querySelector('.tl-head').click(); await flush();
    const buttons = host.querySelectorAll('.thinking-heading');
    const contents = host.querySelectorAll('.thinking-content');
    expect(buttons[0].getAttribute('aria-controls')).toBe(contents[0].id);
    expect(buttons[0].getAttribute('aria-expanded')).toBe('true');
    buttons[0].click(); await flush();
    expect(buttons[0].getAttribute('aria-expanded')).toBe('false');
    expect(contents[0].style.display).toBe('none');
    expect(contents[1].style.display).not.toBe('none');
    expect(host.querySelector('.tl-body')).toBeNull();
    host.querySelector('.tl-row').click(); await flush();
    expect(host.querySelector('.tl-body').textContent).toContain('file contents');
    expect(contents[0].style.display).toBe('none');
    buttons[0].click(); await flush();
    expect(contents[0].style.display).not.toBe('none');
  });

  it('updates an existing streamed block without duplicating text or overriding manual collapse', async () => {
    const state = await mount({ rows: [thought('已返回')], live: true });
    host.querySelector('.thinking-heading').click(); await flush();
    state.rows[0].text += '的后续文本'; await flush();
    expect(host.querySelectorAll('.thinking-block')).toHaveLength(1);
    expect(host.querySelector('.thinking-content').textContent).toBe('已返回的后续文本');
    expect(host.querySelector('.thinking-content').style.display).toBe('none');
  });

  it('follows the latest text by default, pauses when reading above and resumes at the bottom', async () => {
    let height = 500;
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function () {
      return this.classList.contains('thinking-content') ? height : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(100);
    const state = await mount({ rows: [thought('第一行\n第二行\n第三行\n第四行\n第五行\n最新行')], live: true });
    const body = host.querySelector('.thinking-content');
    expect(body.getAttribute('role')).toBe('region');
    expect(body.tabIndex).toBe(0);
    expect(body.scrollTop).toBe(500);

    body.scrollTop = 120;
    body.dispatchEvent(new Event('scroll'));
    height = 700;
    state.rows[0].text += '\n流式新增内容'; await flush();
    expect(body.scrollTop).toBe(120);
    expect(body.textContent).toContain('第一行');
    expect(body.textContent).toContain('流式新增内容');

    body.scrollTop = 600;
    body.dispatchEvent(new Event('scroll'));
    height = 800;
    state.rows[0].text += '\n最新内容'; await flush();
    expect(body.scrollTop).toBe(800);
  });

  it('keeps the reading position independent for each thought and preserves it across folding', async () => {
    let height = 400;
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function () {
      return this.classList.contains('thinking-content') && this.style.display !== 'none' ? height : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function () {
      return this.style.display === 'none' ? 0 : 100;
    });
    const state = await mount({ rows: [thought('第一段'), thought('第二段')], live: true });
    const [first, second] = host.querySelectorAll('.thinking-content');
    second.scrollTop = 80;
    second.dispatchEvent(new Event('scroll'));
    const button = host.querySelectorAll('.thinking-heading')[1];
    button.click(); await flush();
    second.dispatchEvent(new Event('scroll'));
    height = 600;
    state.rows[0].text += '继续'; state.rows[1].text += '继续'; await flush();
    expect(first.scrollTop).toBe(600);
    expect(second.scrollTop).toBe(80);
    button.click(); await flush();
    expect(second.scrollTop).toBe(80);
  });

  it('restores the latest completed thought when the same KeepAlive node returns with scrollTop reset', async () => {
    const OtherProject = defineComponent({ render: () => h('div', 'project B') });
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function () {
      return this.classList.contains('thinking-content') && this.isConnected ? 900 : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function () { return this.isConnected ? 100 : 0; });
    const state = await mount({ selected: 'a', rows: [thought('completed first line\nlatest line', { durationMs: 1000 })], readings: new Map() },
      (current) => h(KeepAlive, null, { default: () => current.selected === 'a'
        ? h(AgentTimeline, { key: 'a', rows: current.rows, thinkingReadings: current.readings })
        : h(OtherProject, { key: 'b' }) }));
    host.querySelector('.tl-head').click(); await flush();
    const body = host.querySelector('.thinking-content'); expect(body.scrollTop).toBe(900);
    state.selected = 'b'; await flush();
    expect(body.isConnected).toBe(false);
    body.scrollTop = 0; body.dispatchEvent(new Event('scroll'));
    expect(state.readings.get(0).followLatest).toBe(true);
    state.selected = 'a'; await flush();
    expect(host.querySelector('.thinking-content')).toBe(body);
    expect(body.scrollTop).toBe(900); expect(state.readings.get(0).followLatest).toBe(true);
  });

  it('keeps following background text after KeepAlive activation without saving zero-height geometry', async () => {
    let height = 500;
    const OtherProject = defineComponent({ render: () => h('div', 'project B') });
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function () {
      return this.classList.contains('thinking-content') && this.isConnected ? height : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function () { return this.isConnected ? 100 : 0; });
    const state = await mount({ selected: 'a', rows: [thought('first part')], readings: new Map() },
      (current) => h(KeepAlive, null, { default: () => current.selected === 'a'
        ? h(AgentTimeline, { key: 'a', live: true, rows: current.rows, thinkingReadings: current.readings })
        : h(OtherProject, { key: 'b' }) }));
    const body = host.querySelector('.thinking-content'); body.dispatchEvent(new Event('scroll'));
    state.selected = 'b'; await flush();
    body.scrollTop = 0; body.dispatchEvent(new Event('scroll'));
    height = 1200; state.rows[0].text += '\nbackground latest'; await flush();
    expect(state.readings.get(0)).toMatchObject({ followLatest: true, scrollTop: 500 });
    state.selected = 'a'; await flush();
    expect(host.querySelector('.thinking-content')).toBe(body); expect(body.scrollTop).toBe(1200);
    expect(body.textContent).toContain('background latest');
  });

  it('preserves manual upward reading through hidden scroll events and background completion', async () => {
    let height = 600;
    const OtherProject = defineComponent({ render: () => h('div', 'project B') });
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function () {
      return this.classList.contains('thinking-content') && this.isConnected ? height : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function () { return this.isConnected ? 100 : 0; });
    const state = await mount({ selected: 'a', live: true, rows: [thought('old text')], readings: new Map() },
      (current) => h(KeepAlive, null, { default: () => current.selected === 'a'
        ? h(AgentTimeline, { key: 'a', live: current.live, rows: current.rows, thinkingReadings: current.readings })
        : h(OtherProject, { key: 'b' }) }));
    const body = host.querySelector('.thinking-content'); body.scrollTop = 120; body.dispatchEvent(new Event('scroll'));
    state.selected = 'b'; await flush();
    body.scrollTop = 0; body.dispatchEvent(new Event('scroll'));
    height = 1600; state.rows[0].text += '\ncompleted in background'; state.rows[0].durationMs = 2300; state.live = false; await flush();
    expect(state.readings.get(0)).toMatchObject({ followLatest: false, scrollTop: 120 });
    state.selected = 'a'; await flush();
    expect(host.querySelector('.thinking-content')).toBe(body); expect(body.scrollTop).toBe(120);
    expect(host.querySelector('.thinking-heading').textContent).toContain('2.3 秒');
  });

  it('does not mistake restoration-induced scroll events for a user choosing to resume following', async () => {
    let height = 600;
    const OtherProject = defineComponent({ render: () => h('div', 'project B') });
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function () {
      return this.classList.contains('thinking-content') && this.isConnected ? height : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function () { return this.isConnected ? 100 : 0; });
    const state = await mount({ selected: 'a', rows: [thought('manual reading')], readings: new Map() },
      (current) => h(KeepAlive, null, { default: () => current.selected === 'a'
        ? h(AgentTimeline, { key: 'a', rows: current.rows, thinkingReadings: current.readings })
        : h(OtherProject, { key: 'b' }) }));
    const body = host.querySelector('.thinking-content');
    body.scrollTop = 120; body.dispatchEvent(new Event('scroll'));
    expect(state.readings.get(0).followLatest).toBe(false);
    state.selected = 'b'; await flush(); height = 220;
    let top = 0;
    Object.defineProperty(body, 'scrollTop', { configurable: true, get: () => top, set(value) { top = value; body.dispatchEvent(new Event('scroll')); } });
    state.selected = 'a'; await flush();
    expect(body.scrollTop).toBe(120); expect(state.readings.get(0).followLatest).toBe(false);
    height = 1000; state.rows[0].text += ' background additions'; await flush(); expect(body.scrollTop).toBe(120);
  });

  it('renders returned text literally, including line breaks and markup characters', async () => {
    const text = '<script>unexpected()</script>\n**literal model text**';
    await mount({ rows: [thought(text)] });
    const body = host.querySelector('.thinking-content');
    expect(body.textContent).toBe(text);
    expect(body.querySelector('script')).toBeNull();
    expect(body.querySelector('strong')).toBeNull();
  });

  it('shows no invented duration for old history that has no measured thinking time', async () => {
    await mount({ rows: [thought('旧消息中保留的模型文本')], durationMs: 90000 });
    expect(host.querySelector('.thinking-heading').textContent.trim()).toBe('思考');
    expect(host.querySelector('.thinking-heading').textContent).not.toContain('90');
  });

  it('counts only a live thought with startedAt and stops at the measured block duration', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-22T12:00:00Z'));
    const state = await mount({ rows: [thought('正在返回的文本', { startedAt: Date.now() - 1200 })], live: true });
    expect(host.querySelector('.thinking-heading').textContent).toContain('持续了 1.2 秒');
    vi.advanceTimersByTime(1000); await flush();
    expect(host.querySelector('.thinking-heading').textContent).toContain('持续了 2.2 秒');
    state.rows[0].durationMs = 2400; state.rows.push(tool); await flush();
    vi.advanceTimersByTime(4000); await flush();
    expect(host.querySelector('.thinking-heading').textContent).toContain('持续了 2.4 秒');
    expect(host.querySelector('.thinking-block').getAttribute('aria-busy')).toBe('false');
  });

  it('folds completed work while preserving the inner thought expansion choice', async () => {
    const state = await mount({ rows: [thought('完成前后的同一段原文', { durationMs: 500 })], live: true });
    state.live = false; state.answerHtml = '<p>最终回答</p>'; await flush();
    expect(host.querySelector('.thinking-heading').getAttribute('aria-expanded')).toBe('true');
    expect(host.querySelector('.thinking-content').style.display).not.toBe('none');
    expect(host.querySelector('.tl-answer').textContent).toBe('最终回答');
    host.querySelector('.thinking-heading').click(); await flush();
    expect(host.querySelector('.thinking-content').style.display).toBe('none');
  });

  it('does not create thinking from activity, placeholders or final answers', async () => {
    await mount({ rows: [
      { kind: 'activity', phase: 'planning', text: '正在检查请求与项目上下文，关键判断和执行计划会显示在这里。' },
      { kind: 'activity', phase: 'planning', text: '模型正在整理信息，执行计划与关键判断会以简短摘要展示。' },
      { kind: 'activity', source: 'model', phase: 'planning', text: '已核对公式' },
      { kind: 'activity', source: 'system', phase: 'retry', text: '连接重试 1/5' },
      { kind: 'tool', name: 'report_progress', label: '进度报告' },
    ], live: false, answerHtml: '<p>任务完成</p>' });
    expect(host.querySelector('.thinking-block')).toBeNull();
    expect(host.querySelectorAll('.tl-activity')).toHaveLength(2);
    expect(host.textContent).toContain('系统重试：连接重试 1/5');
    expect(host.textContent).not.toContain('关键判断和执行计划会显示');
    expect(host.textContent).not.toContain('模型正在整理信息');
    expect(host.querySelector('.tl-row')).toBeNull();
  });

  it('preserves independent ordered records for multiple completed rounds', async () => {
    await mount({ rounds: [
      { id: 1, rows: [thought('第一轮思考'), { kind: 'text', text: '第一轮正文' }] },
      { id: 2, rows: [thought('第二轮思考'), tool], answerHtml: '<p>第二轮回答</p>' },
    ] }, (state) => h('div', state.rounds.map((round) => h(AgentTimeline, { ...round, key: round.id }))));
    expect([...host.querySelectorAll('.thinking-content')].map((node) => node.textContent)).toEqual(['第一轮思考', '第二轮思考']);
    expect(host.querySelectorAll('.timeline')).toHaveLength(2);
  });
});
