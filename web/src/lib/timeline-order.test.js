import { describe, expect, it } from 'vitest';
import { buildTimeline } from './agentUtils.js';

const text = (value) => ({ type: 'text', text: value });
const thinking = (value) => ({ type: 'model_thinking', text: value, source: 'provider' });
const tool = (name = 'read_file') => ({ type: 'tool', name, status: 'end', input: { path: 'main.tex' }, result: 'ok' });
const sequence = (timeline) => timeline.rows.map((row) =>
  row.kind === 'tool' ? ['tool', row.name] : [row.kind, row.text]);

describe('natural timeline preserves returned block order', () => {
  it('does not move a public text before trailing thinking into the final answer', () => {
    const steps = [text('Public introduction'), thinking('Returned thought')];
    const timeline = buildTimeline({ steps, content: 'Public introduction' });
    expect(sequence(timeline)).toEqual([
      ['text', 'Public introduction'],
      ['thinking', 'Returned thought'],
    ]);
    expect(timeline.answer).toBe('');
  });

  it('keeps intermediate public text between separate thinking blocks', () => {
    const steps = [thinking('First thought'), text('Intermediate explanation'), thinking('Second thought')];
    const timeline = buildTimeline({ steps, content: 'Intermediate explanation' });
    expect(sequence(timeline)).toEqual([
      ['thinking', 'First thought'],
      ['text', 'Intermediate explanation'],
      ['thinking', 'Second thought'],
    ]);
    expect(timeline.answer).toBe('');
  });

  it.each([
    ['tool', tool()],
    ['activity', { type: 'activity', text: 'Waiting for input', phase: 'waiting' }],
  ])('does not move preceding public text past a trailing %s', (_label, lastStep) => {
    const steps = [thinking('Returned thought'), text('Public explanation'), lastStep];
    const timeline = buildTimeline({ steps, content: 'Public explanation' });
    expect(sequence(timeline)).toEqual([
      ['thinking', 'Returned thought'],
      ['text', 'Public explanation'],
      lastStep.type === 'tool' ? ['tool', 'read_file'] : ['activity', 'Waiting for input'],
    ]);
    expect(timeline.answer).toBe('');
  });

  it('also preserves interrupted legacy text-to-tool order when thinking is absent', () => {
    const timeline = buildTimeline({ steps: [text('I will inspect this file'), tool()], content: 'I will inspect this file' });
    expect(sequence(timeline)).toEqual([['text', 'I will inspect this file'], ['tool', 'read_file']]);
    expect(timeline.answer).toBe('');
  });

  it('extracts only a genuinely trailing text while preserving every preceding block', () => {
    const steps = [
      text('Public introduction'), thinking('First thought'), text('Public update'),
      tool(), thinking('Second thought'), text('Final answer'),
    ];
    const timeline = buildTimeline({ steps, content: 'Public introduction\n\nPublic update\n\nFinal answer' });
    expect(sequence(timeline)).toEqual([
      ['text', 'Public introduction'], ['thinking', 'First thought'], ['text', 'Public update'],
      ['tool', 'read_file'], ['thinking', 'Second thought'],
    ]);
    expect(timeline.answer).toBe('Final answer');
  });

  it('renders the same block order live and after persisted content is loaded', () => {
    const steps = [text('Before'), thinking('Thought one'), text('Between'), thinking('Thought two'), tool()];
    const live = buildTimeline({ steps });
    const loaded = buildTimeline({ steps, content: 'Before\n\nBetween' });
    expect(sequence(loaded)).toEqual(sequence(live));
    expect(loaded.answer).toBe(live.answer);
  });

  it('does not duplicate aggregate content when public text steps already exist', () => {
    const timeline = buildTimeline({
      steps: [text('First'), thinking('Returned thought'), text('Second'), tool()],
      content: 'First\n\nSecond',
    });
    expect(sequence(timeline)).toEqual([
      ['text', 'First'], ['thinking', 'Returned thought'], ['text', 'Second'], ['tool', 'read_file'],
    ]);
    expect(timeline.answer).toBe('');
  });

  it('keeps content as a fallback for older messages without any text step', () => {
    const old = buildTimeline({ toolCalls: [{ name: 'read_file', result: 'ok' }], content: 'Older answer' });
    expect(sequence(old)).toEqual([['tool', 'read_file']]);
    expect(old.answer).toBe('Older answer');

    const withNonTextSteps = buildTimeline({ steps: [thinking('Returned thought'), tool()], content: 'Fallback answer' });
    expect(sequence(withNonTextSteps)).toEqual([['thinking', 'Returned thought'], ['tool', 'read_file']]);
    expect(withNonTextSteps.answer).toBe('Fallback answer');
  });

  it('does not mutate the stored step order when extracting the final answer', () => {
    const steps = Object.freeze([
      Object.freeze(text('Introduction')),
      Object.freeze(thinking('Returned thought')),
      Object.freeze(text('Final answer')),
    ]);
    const timeline = buildTimeline({ steps, content: 'Introduction\n\nFinal answer' });
    expect(sequence(timeline)).toEqual([['text', 'Introduction'], ['thinking', 'Returned thought']]);
    expect(timeline.answer).toBe('Final answer');
    expect(steps.map((step) => step.text)).toEqual(['Introduction', 'Returned thought', 'Final answer']);
  });
});
