import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderAffectingPaths } from '../src/services/agent/workflowGraph.js';

test('a comment at the start of a CR-only manuscript cannot hide a later body edit', () => {
  const before = '% journal header\rOriginal discussion.\r';
  assert.deepEqual(renderAffectingPaths([{ path: 'main.tex', before, after: before.replace('Original', 'Revised') }]), ['main.tex']);
  assert.deepEqual(renderAffectingPaths([{ path: 'main.tex', before, after: before.replace('header', 'note') }]), []);
});

test('synchronized pure Chinese comments do not create an extra compile requirement', () => {
  const before = 'First paragraph.\n\nSecond paragraph.\n';
  assert.deepEqual(renderAffectingPaths([{path:'main.tex',before,after:'First paragraph.\n% 中文：第一段。\n\nSecond paragraph.\n% 中文：第二段。\n'}]), []);
  assert.deepEqual(renderAffectingPaths([{path:'main.tex',before:'Text. % old\n',after:'Text. % 新注释\n'}]), []);
});
test('rendering changes and percent literals still require current-version compile', () => {
  for (const [before,after] of [['A\nB','A% comment\nB'],['Old.\n','New.\n'],['Text.\n\nMore.','Text.\nMore.'],['\\% 1','\\% 2'],['\\begin{verbatim}\n% old\n\\end{verbatim}','\\begin{verbatim}\n% new\n\\end{verbatim}']]) {
    assert.deepEqual(renderAffectingPaths([{path:'main.tex',before,after}]), ['main.tex']);
  }
  assert.deepEqual(renderAffectingPaths([{path:'refs.bib',before:'a',after:'b'},{path:'image.png',encoding:'base64',before:'a',after:'b'},{path:'notes.txt',before:'a',after:'b'}]), ['refs.bib','image.png']);
});

test('literal percent content and spaced verbatim environments conservatively require compile', () => {
  for (const before of [String.raw`\verb|alpha%before|`, String.raw`\lstinline|alpha%before|`, String.raw`\url{https://example.test/a%20before}`, '\\begin {verbatim}\n% before\n\\end{verbatim}']) {
    assert.deepEqual(renderAffectingPaths([{path:'main.tex',before,after:before.replace('before','after')}]), ['main.tex']);
  }
});
