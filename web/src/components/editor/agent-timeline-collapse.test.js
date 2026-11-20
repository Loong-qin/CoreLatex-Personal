// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, h, KeepAlive, nextTick, reactive, ref } from 'vue';
import AgentTimeline from './AgentTimeline.vue';
const mounted = [];
afterEach(() => { mounted.splice(0).forEach(({ app, host }) => { app.unmount(); host.remove(); }); });
const rows = () => [
  { kind: 'thinking', text: 'Earlier model output', durationMs: 1500 },
  { kind: 'text', text: 'Read the requested section first.' },
  { kind: 'tool', name: 'read_file', label: '已读取文件', state: 'ok', summary: 'main.tex', hasBody: true, inputText: '{"path":"main.tex"}', resultText: 'file content', preview: 'file content' },
];
async function mount(overrides = {}) {
  const props = reactive({ rows: rows(), answerHtml: '<p>Final answer remains visible.</p>', durationMs: 2500, live: false, ...overrides });
  const visible = ref(true);
  const app = createApp({ render: () => h(KeepAlive, null, { default: () => visible.value ? h(AgentTimeline, { ...props, key: 'timeline' }) : null }) });
  app.component('el-icon', { render() { return h('span', this.$slots.default?.()); } });
  const host = document.createElement('div'); document.body.appendChild(host); app.mount(host); mounted.push({ app, host }); await nextTick();
  return { props, visible, host, header: () => host.querySelector('.tl-head'), steps: () => host.querySelector('.tl-steps') };
}
describe('completed agent process disclosure', () => {
  it('collapses completed and historical work while leaving the final answer visible', async () => {
    const test = await mount();
    expect(test.header().tagName).toBe('BUTTON'); expect(test.header().getAttribute('aria-expanded')).toBe('false');
    expect(test.steps().style.display).toBe('none'); expect(test.host.querySelector('.tl-answer').textContent).toContain('Final answer');
    expect(test.header().getAttribute('aria-controls')).toBe(test.steps().id);
    test.header().click(); await nextTick();
    expect(test.header().getAttribute('aria-expanded')).toBe('true'); expect(test.steps().style.display).toBe('');
    expect(test.steps().textContent).toContain('Earlier model output'); expect(test.steps().textContent).toContain('已读取文件');
    test.header().click(); await nextTick(); expect(test.steps().style.display).toBe('none');
    expect(test.host.querySelector('.tl-answer').textContent).toContain('Final answer');
  });
  it('automatically folds the process when a live task finishes and reopens for a new live round', async () => {
    const test = await mount({ live: true }); expect(test.header().tagName).toBe('DIV'); expect(test.steps().style.display).toBe('');
    test.props.live = false; await nextTick(); expect(test.header().getAttribute('aria-expanded')).toBe('false'); expect(test.steps().style.display).toBe('none');
    test.header().click(); await nextTick(); test.props.durationMs = 3000; test.props.answerHtml = '<p>Updated result.</p>'; await nextTick();
    expect(test.steps().style.display).toBe(''); // A completed answer refresh must not reset a user choice.
    test.props.live = true; await nextTick(); expect(test.steps().style.display).toBe('');
  });
  it('preserves tool details and user expansion across collapse and project switching', async () => {
    const test = await mount(); test.header().click(); await nextTick();
    test.host.querySelector('.tl-row').click(); await nextTick(); expect(test.host.querySelector('.tl-body').textContent).toContain('file content');
    const step = test.steps(); test.header().click(); await nextTick(); test.header().click(); await nextTick();
    expect(test.steps()).toBe(step); expect(test.host.querySelector('.tl-body').textContent).toContain('file content');
    test.visible.value = false; await nextTick(); test.visible.value = true; await nextTick();
    expect(test.header().getAttribute('aria-expanded')).toBe('true'); expect(test.steps()).toBe(step);
    expect(test.host.querySelector('.tl-body').textContent).toContain('file content');
  });
  it('shows plain text answers without an empty disclosure control', async () => {
    const test = await mount({ rows: [] }); expect(test.header().tagName).toBe('DIV'); expect(test.steps()).toBeNull();
    expect(test.header().hasAttribute('aria-expanded')).toBe(false); expect(test.host.querySelector('.tl-answer').textContent).toContain('Final answer');
  });
});
