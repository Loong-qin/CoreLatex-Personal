import assert from 'node:assert/strict';
import test from 'node:test';
import { manuscriptContext, normalizeFocus, selectionFocus } from '../src/services/agent/manuscriptContext.js';

test('long paper focuses on both neighbours of the selected passage without duplicating it', () => {
  const preamble = '% preamble\n'.repeat(3000);
  const previous = 'We report posterior intervals throughout.\n\n';
  const selected = 'Our estimate was 12.3\\% (Table~\\ref{tab:res}).';
  const next = '\n\nUnder these assumptions, the contrast is descriptive.';
  const before = preamble + previous;
  const focus = selectionFocus(before + selected + next, before.length, before.length + selected.length);
  assert.equal(focus.line, 3003);
  assert.ok(focus.before.endsWith(previous));
  assert.equal(focus.after, next);
  assert.equal(focus.before.length, 1400);
  const context = manuscriptContext('results.tex', focus);
  assert.ok(!context.includes(selected));
  assert.ok(context.includes('Under these assumptions'));
  assert.deepEqual(normalizeFocus(focus), focus);
});

test('invalid focus falls back to the legacy preview, and oversized browser fields are bounded', () => {
  assert.equal(normalizeFocus({ before: 'stale', line: 1 }), null);
  assert.equal(manuscriptContext('main.tex', null), '');
  const focus = normalizeFocus({ line: 4, before: 'A'.repeat(5000) + 'B', after: 'C' + 'D'.repeat(5000) });
  assert.equal(focus.before.length, 1400);
  assert.equal(focus.after.length, 1400);
  assert.equal(focus.before.at(-1), 'B');
  assert.equal(focus.after[0], 'C');
});
