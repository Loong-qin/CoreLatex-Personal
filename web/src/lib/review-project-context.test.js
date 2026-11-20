// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { EditorState } from '@codemirror/state';
import { useEditorStore } from '../stores/editor.js';
import { reviewDecorationsExtension, reviewDecoField, refreshReviewsEffect } from './reviewDecorations.js';
describe('review decoration project binding', () => {
  it('refreshes each retained document from its original project even when the global store and active file differ', () => {
    setActivePinia(createPinia());
    const fallback = useEditorStore(); fallback.activeFile = 'other.tex'; fallback.reviews = [];
    const make = (start) => ({ activeFile: 'other.tex', reviews: [{ id: start, status: 'open', filePath: 'main.tex', start, end: start + 1 }], $subscribe: () => () => {} });
    const a = make(1), b = make(3);
    let stateA = EditorState.create({ doc: 'abcdef', extensions: reviewDecorationsExtension({ store: a, filePath: 'main.tex' }) });
    const stateB = EditorState.create({ doc: 'abcdef', extensions: reviewDecorationsExtension({ store: b, filePath: 'main.tex' }) });
    expect(stateA.field(reviewDecoField).iter().from).toBe(1);
    expect(stateB.field(reviewDecoField).iter().from).toBe(3);
    a.reviews = [{ id: 1, status: 'open', filePath: 'main.tex', start: 2, end: 4 }];
    stateA = stateA.update({ effects: refreshReviewsEffect.of(null) }).state;
    expect(stateA.field(reviewDecoField).iter().from).toBe(2);
    expect(stateB.field(reviewDecoField).iter().from).toBe(3);
  });
});
