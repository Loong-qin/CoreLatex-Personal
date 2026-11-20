// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, h, nextTick, reactive } from 'vue';
import AgentQuestionCard from './AgentQuestionCard.vue';
let app, host;
const flush = async () => { for (let i = 0; i < 3; i++) await nextTick(); };
afterEach(() => { app?.unmount(); host?.remove(); });
describe('bounded agent questions', () => {
  it('retains the complete literal question in a keyboard-readable region and offers a compact default view', async () => {
    const question = ('Please verify this scientific claim, <b>literal text</b>, and its references.\n\n').repeat(80);
    const option = 'Use the complete original answer ' + 'with supporting details '.repeat(30), answer = vi.fn();
    const state = reactive({ question: { questionId: 'q1', question, options: [{ label: option }, 'Skip'] }, disabled: false });
    host = document.createElement('div'); document.body.appendChild(host);
    app = createApp({ render: () => h(AgentQuestionCard, { ...state, onAnswer: answer }) }); app.mount(host); await flush();
    const body = host.querySelector('.question-body'), toggle = host.querySelector('.question-toggle');
    expect(body.textContent).toBe(question); expect(body.querySelector('b')).toBeNull(); expect(body.tabIndex).toBe(0);
    expect(toggle.getAttribute('aria-expanded')).toBe('false'); expect(toggle.getAttribute('aria-controls')).toBe(body.id);
    body.focus(); expect(document.activeElement).toBe(body);
    toggle.click(); await flush(); expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const optionButton = host.querySelector('.question-option'); expect(optionButton.title).toBe(option);
    optionButton.click(); expect(answer).toHaveBeenCalledWith(option);
    state.disabled = true; await flush(); optionButton.click(); expect(answer).toHaveBeenCalledTimes(1);
    state.question = { questionId: 'q2', question: 'Next question', options: ['Continue'] }; await flush();
    expect(toggle.getAttribute('aria-expanded')).toBe('false'); expect(body.textContent).toBe('Next question');
  });
});
