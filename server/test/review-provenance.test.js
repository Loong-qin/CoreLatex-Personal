import test from 'node:test';
import assert from 'node:assert/strict';
import { transportManualChanges as transport, reconstructLegacyReviewBase as repair } from '../src/services/agent/reviewProvenance.js';

const cases = [
  ['no new edit retains pending AI', 'title\nold\nend', 'title\nAI\nend', 'title\nAI\nend', 'title\nold\nend'],
  ['manual-only content', 'hello', 'hello', 'human hello!', 'human hello!'],
  ['independent paragraphs', 'title\nold\nend', 'title\nAI\nend', 'heading\nAI\nend', 'heading\nold\nend'],
  ['independent same-line characters', 'abc def', 'aBc def', 'aBc deF', 'abc deF'],
  ['adjacent character replacement', 'abc', 'Abc', 'ABc', 'aBc'],
  ['insert before an AI replacement', 'cat!', 'dog!', 'Xdog!', 'Xcat!'],
  ['insert after an AI replacement', 'cat!', 'dog!', 'dogX!', 'catX!'],
  ['rewrite inside an AI replacement owns that block', 'cat!', 'dog!', 'dIg!', 'dIg!'],
  ['delete inside an AI replacement owns that block', 'cat!', 'dog!', 'dg!', 'dg!'],
  ['insert inside an AI replacement owns that block', 'cat!', 'dog!', 'doXg!', 'doXg!'],
  ['rewrite AI preserves a separate pending block', 'cat / old', 'dog / NEW', 'dIg / NEW', 'dIg / old'],
  ['human deletes AI insertion without restoring it', 'ab', 'aXYZb', 'ab', 'ab'],
  ['manual insertion at AI deletion gap owns deletion', 'abc', 'ac', 'aXc', 'aXc'],
  ['manual replacement after AI deletion retains deletion', 'abc', 'ac', 'aC', 'abC'],
  ['manual replacement before AI deletion retains deletion', 'abc', 'ac', 'Ac', 'Abc'],
  ['manual edit across AI deletion takes ownership', 'abcd', 'ad', 'X', 'X'],
  ['same text occurrence is not replaced globally', 'first same / second same / old', 'first same / second same / NEW', 'first same / second HUMAN / NEW', 'first same / second HUMAN / old'],
  ['manual same insertion already in baseline is not duplicated', 'aXb / old', 'ab / NEW', 'aXb / NEW', 'aXb / old'],
  ['manual same replacement already in baseline is stable', 'aHb / old', 'axb / NEW', 'aHb / NEW', 'aHb / old'],
  ['accepted delta can transport across independent manual edit', 'a\nH\nc', 'a\nb\nc', 'A\nb\nc', 'A\nH\nc'],
  ['Unicode characters remain whole', '🐈 x / old', '🐕 x / NEW', '🐕 🐥 / NEW', '🐈 🐥 / old'],
  ['manual insertions on both sides of AI insertion preserve order', 'ab', 'aXb', 'a1X2b', 'a12b'],
  ['manual insertion before and rewrite inside same AI block', 'cat!', 'dog!', 'XdIg!', 'XdIg!'],
  ['manual deletion of all text owns all overlapping AI', 'alpha\nbeta', 'ALPHA\nbeta', '', ''],
];
for (const [name, base, previous, current, expected] of cases) {
  test(name, () => assert.equal(transport(base, previous, current), expected));
}

const initial = 'a\ntitle\nc\nend';
const ai1 = 'A\ntitle\nc\nend';
const human = 'A\nheading\nc\nend';
const ai2 = 'A\nheading\nC\nend';
const sequence = [{ before: initial, after: ai1 }, { before: human, after: ai2 }];
test('legacy repair absorbs manual work between two pending AI rounds', () => {
  assert.equal(repair(initial, ai2, sequence), 'a\nheading\nc\nend');
});
test('legacy repair does not resurrect an already accepted AI block', () => {
  assert.equal(repair('A\ntitle\nc\nend', ai2, sequence), 'A\nheading\nc\nend');
});
test('legacy repair is stable when old baseline already contains manual edits', () => {
  const fixed = 'a\nheading\nc\nend';
  assert.equal(repair(fixed, ai2, sequence), fixed);
  assert.equal(repair(repair(initial, ai2, sequence), ai2, sequence), fixed);
});
test('legacy repair does not repeat an already absorbed manual insertion', () => {
  const before = 'a\nb\nc';
  const first = 'A\nb\nc';
  const nextBefore = 'A\nmanual\nb\nc';
  const last = 'A\nmanual\nb\nC';
  const rows = [{ before, after: first }, { before: nextBefore, after: last }];
  assert.equal(repair('a\nmanual\nb\nc', last, rows), 'a\nmanual\nb\nc');
  assert.equal(repair('A\nmanual\nb\nc', last, rows), 'A\nmanual\nb\nc');
});
test('legacy repair retains human rewrite within one AI block and another pending block', () => {
  assert.equal(repair('cat / old', 'dIg / NEW', [
    { before: 'cat / old', after: 'dog / NEW' },
  ]), 'dIg / old');
});
test('remaining pending rounds advance the baseline after accepting an earlier round', () => {
  assert.equal(repair(initial, ai2, [sequence[1]]), 'A\nheading\nc\nend');
});
test('no remaining AI evidence clears the review difference', () => {
  assert.equal(repair(initial, ai2, []), ai2);
});
test('legacy partial acceptance inside ambiguous replacement cannot reappear', () => {
  assert.equal(repair('bba', 'bbb', [{ before: 'aaa', after: 'bbb' }]), 'bbb');
});
test('legacy AI deletion is retained until accepted', () => {
  assert.equal(repair('abc / old', 'ac / NEW', [{ before: 'abc / old', after: 'ac / NEW' }]), 'abc / old');
  assert.equal(repair('ac / old', 'ac / NEW', [{ before: 'abc / old', after: 'ac / NEW' }]), 'ac / old');
});
test('later accepted AI must not be revived by an earlier manual rewrite', () => {
  const rows = [{ before: 'a / old', after: 'b / old' }, { before: 'c / old', after: 'd / NEW' }];
  assert.equal(repair('d / old', 'd / NEW', rows), 'd / old');
});

test('large manual paste does not exceed JavaScript call argument limits', () => {
  const paste = 'long human text '.repeat(10000);
  assert.equal(transport('cat!', 'dog!', paste + 'dog!'), paste + 'cat!');
});
test('legacy repair is idempotent for small repeated character snapshots', () => {
  const words = ['', 'a', 'b', 'aa', 'ab', 'ba', 'bb'];
  for (const before of words) for (const after of words) for (const current of words) {
    for (const oldBase of words) {
      const sequence = [{ before, after }];
      const fixed = repair(oldBase, current, sequence);
      assert.equal(repair(fixed, current, sequence), fixed);
    }
  }
});

test('legacy AI deletion remains pending next to a manual character replacement', () => {
  assert.equal(repair('abc', 'aC', [{ before: 'abc', after: 'ac' }]), 'abC');
  assert.equal(repair('abc', 'Ac', [{ before: 'abc', after: 'ac' }]), 'Abc');
});
