import { expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { editorManuscriptFocus } from './agentUtils.js';

it('sends adjacent paragraphs around an attached Results selection even beyond the opening preview', () => {
  const head = '%'.repeat(15000) + '\nAdjacent results paragraph.\n';
  const target = 'Our original result.';
  const tail = '\nThe following paragraph.';
  const from = head.length, to = from + target.length;
  const view = { state: EditorState.create({ doc: head + target + tail, selection: { anchor: from, head: to } }) };
  const focus = editorManuscriptFocus(view, { from, to });
  expect(focus.line).toBe(3);
  expect(focus.before.length).toBe(1400);
  expect(focus.before.endsWith('Adjacent results paragraph.\n')).toBe(true);
  expect(focus.after).toBe(tail);
  expect(editorManuscriptFocus(view, null)).toBeNull();
});
