import test from 'node:test';
import assert from 'node:assert/strict';
import { buildChineseAlignmentPrompt, inspectChineseAlignment, assessChangedChineseAlignment } from '../src/services/agent/chineseAlignment.js';

const file = (before, after, extra = {}) => ({ path: 'sections/results.tex', before, after, ...extra });
const inspect = (before, after, extra) => inspectChineseAlignment([file(before, after, extra)]);
const original = 'Our method improves accuracy by 5\\% on this dataset.';
const translated = '% 中文：我们的方法在该数据集上将准确率提高了 5\\%。';

test('prompt integrates faithful complete translation into normal edits without extra review tools', () => {
  const prompt = buildChineseAlignmentPrompt();
  assert.match(prompt, /完整中文/); assert.match(prompt, /忠实对应/); assert.match(prompt, /数字、单位、引用key、公式/);
  assert.match(prompt, /同一次编辑/); assert.match(prompt, /用户明确指定/);
  assert.doesNotMatch(prompt, /set_chinese_alignment_scope|交付前.*逐句/);
  assert.equal(buildChineseAlignmentPrompt({ enabled: false }), '');
});

test('new and changed ordinary English prose requires adjacent Chinese, with path and line for correction', () => {
  const result = inspect('', '\\section{Results}\n\n' + original + '\n');
  assert.equal(result.checkedParagraphs, 1); assert.equal(result.requiresSemanticReview, true);
  assert.deepEqual(result.issues.map(i => [i.kind, i.severity, i.path, i.line]), [['missing_translation', 'error', 'sections/results.tex', 3]]);
  assert.match(result.issues[0].source, /Our method/);
});

test('unchanged unrelated legacy paragraphs and existing number mismatches are not flagged', () => {
  const old = original + '\n% 一个不完整的旧概括。\n\nWe use a consistent evaluation procedure throughout the study.\n% 本研究始终使用一致的评估程序。\n';
  const next = old.replace('consistent evaluation', 'reproducible evaluation').replace('一致的评估程序', '可复现的评估程序');
  const result = inspect(old, next);
  assert.equal(result.checkedParagraphs, 1); assert.deepEqual(result.issues, []);
});

test('multi-line complete Chinese comments and legacy unmarked Chinese are accepted', () => {
  const source = original + ' We do not claim a causal relationship.\n';
  const result = inspect('', source + '% 中文：我们的方法在该数据集上将准确率提高了 5%。\n% 我们并不声称存在因果关系。\n');
  assert.deepEqual(result.issues, []); assert.equal(result.checkedParagraphs, 1);
  assert.deepEqual(inspect('', original + '\n' + translated.replace('中文：', '')).issues, []);
});

test('changed English with unchanged adjacent Chinese is a review diagnostic, not a semantic error verdict', () => {
  const before = original + '\n' + translated;
  const after = before.replace('improves accuracy', 'may improve accuracy');
  const result = inspect(before, after);
  assert.deepEqual(result.issues.map(i => [i.kind, i.severity]), [['stale_translation', 'review']]);
  assert.equal(result.issues[0].paragraphLine, 1); assert.equal(result.issues[0].line, 2);
});

test('numbers changed in the English source must be present in the paired translation', () => {
  const before = original + '\n' + translated;
  const result = inspect(before, before.replace('by 5', 'by 12'));
  const mismatch = result.issues.find(i => i.kind === 'numeric_mismatch');
  assert.equal(mismatch.severity, 'error'); assert.deepEqual(mismatch.missingNumbers, ['12']); assert.deepEqual(mismatch.unexpectedNumbers, ['5']);
});

test('equivalent number formatting, percent escaping, citation keys and numeric reference keys avoid false mismatches', () => {
  const source = String.raw`Our method evaluates 1\,000 examples at a threshold of .05 and a rate of 1e-3, as reported in \cite{smith2024} and \ref{fig:2}.`;
  const translation = String.raw`% 中文：我们的方法以 0.05 的阈值和 0.001 的速率评估 1,000 个样本，参见 \cite{smith2024} 和 \ref{fig:2}。`;
  assert.deepEqual(inspect('', source + '\n' + translation).issues, []);
});

test('numeric omissions in translation-only edits are detected but unchanged English prose is not treated as new', () => {
  const before = original + '\n' + translated;
  const result = inspect(before, original + '\n% 中文：我们的方法在该数据集上提高了准确率。');
  assert.deepEqual(result.issues.map(i => i.kind), ['numeric_mismatch']);
  assert.deepEqual(result.issues[0].missingNumbers, ['5']);
});

test('extra numbers alone request review rather than declaring an invented fact', () => {
  const result = inspect('', original + '\n' + translated + ' 结果见图 2。');
  assert.equal(result.issues[0].kind, 'numeric_mismatch'); assert.equal(result.issues[0].severity, 'review');
});

test('deleting an existing adjacent translation is detected without flagging the rest of the file', () => {
  const before = original + '\n' + translated + '\n';
  const result = inspect(before, original + '\n');
  assert.deepEqual(result.issues.map(i => i.kind), ['missing_translation']);
});

test('whitespace and common emphasis-only English changes do not demand a rewritten translation', () => {
  const before = original + '\n' + translated;
  const after = original.replace('improves accuracy', '\\emph{improves accuracy}').replace(' on this', '\n on this') + '\n' + translated;
  const result = inspect(before, after);
  assert.deepEqual(result.issues, []); assert.equal(result.checkedParagraphs, 0);
});

test('preamble, comments, equations, tables, code and unknown environments are excluded', () => {
  const text = String.raw`\documentclass{article}
\title{This is an English title with 15 words in preamble}
\newcommand{\instruction}{
This would otherwise be natural English prose with 10 values.
}
\begin{document}
% This is an English engineering comment with 15 values.
\begin{equation}
This should never be treated as ordinary prose with 10 values.
\end{equation}
\begin{table}
\begin{tabular}{cc}
This is not prose & And this is not prose 10
\end{tabular}
\caption{This is a caption kept for model semantic review only.}
\end{table}
\begin{verbatim}
This is code-like text and must be ignored 10.
\end{verbatim}
\begin{customenvironment}
This is ambiguous custom environment text and is not structurally checked.
\end{customenvironment}
\[
These are identifiers in display math and should be ignored 10.
\]
\end{document}
This is after the document and should be ignored.
`;
  const result = inspect('', text); assert.deepEqual(result.issues, []); assert.equal(result.checkedParagraphs, 0);
});

test('body prose inside abstract and after preamble remains covered', () => {
  const text = '\\documentclass{article}\n\\begin{document}\n\\begin{abstract}\n' + original + '\n\\end{abstract}\n\\end{document}';
  assert.equal(inspect('', text).issues[0].kind, 'missing_translation');
});

test('multiline macro arguments in included files are excluded without suppressing subsequent prose', () => {
  const macro = '\\newcommand{\\mytext}{\nThis is macro content not ordinary paragraph prose.\n}\n';
  const result = inspect('', macro + '\n' + original + '\n' + translated);
  assert.deepEqual(result.issues, []); assert.equal(result.checkedParagraphs, 1);
});

test('engineering directives are not accepted as translation counterparts', () => {
  const result = inspect('', original + '\n% TODO: 补充中文说明\n');
  assert.deepEqual(result.issues.map(i => i.kind), ['missing_translation']);
});

test('inline Chinese comments and escaped English percentages retain the correct pair', () => {
  assert.deepEqual(inspect('', original + ' ' + translated).issues, []);
});

test('non-TeX, workspace, binary and removed files are not diagnosed', () => {
  const result = inspectChineseAlignment([
    file('', original, { path: 'analysis.py' }), file('', original, { path: '_workspace/draft.tex' }),
    file('', original, { encoding: 'base64' }), file(original, null), null,
  ]);
  assert.deepEqual(result.issues, []); assert.equal(result.checkedParagraphs, 0);
});

test('the object-argument adapter preserves the same diagnostic contract', () => {
  const files = [file('', original)];
  assert.deepEqual(assessChangedChineseAlignment({ files }), inspectChineseAlignment(files));
});
