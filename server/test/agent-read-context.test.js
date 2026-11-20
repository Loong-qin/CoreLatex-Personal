import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { compactDuplicateReads, retainVisibleReadPermissions } from '../src/services/agent/readContext.js';
const hash = text => createHash('sha256').update(text).digest('hex');
function read(body, extra = {}) {
  return { role: 'toolResult', toolName: 'read_file', content: [{ type: 'text', text: body }],
    details: { readVersion: { path: 'notes.txt', view: 'effective', purpose: 'context', contentHash: hash(body),
      start: 1, end: 100, resultHash: hash(body), ...extra } } };
}
test('only old identical version/window/body copies shrink; latest body and original history remain exact', () => {
  const body = 'source material\n'.repeat(1000), first = read(body), latest = read(body);
  const before = JSON.stringify([first, latest]), result = compactDuplicateReads([first, latest]);
  assert.equal(result[1].content[0].text, body); assert.ok(result[0].content[0].text.length < body.length / 5);
  assert.equal(JSON.stringify([first, latest]), before);
  assert.ok(JSON.stringify(result).length < before.length * 0.6);
});
test('different versions, windows, purpose and view retain their own evidence even with identical visible text', () => {
  const body = 'partial body\n'.repeat(100);
  const messages = [read(body), read(body, { contentHash: 'changed outside window' }), read(body, { start: 101 }),
    read(body, { purpose: 'source' }), read(body, { view: 'project' }), read(body, { path: 'other.txt' })];
  assert.deepEqual(compactDuplicateReads(messages), messages);
});
test('a shortened or failed latest result cannot replace an earlier full source body; small reads do not grow', () => {
  const body = 'evidence\n'.repeat(200), full = read(body), partial = read(body); partial.content[0].text = '[shortened]';
  assert.deepEqual(compactDuplicateReads([full, partial]), [full, partial]);
  const failed = { ...read(body), isError: true };
  assert.deepEqual(compactDuplicateReads([full, failed]), [full, failed]);
  const small = [read('short'), read('short')]; assert.deepEqual(compactDuplicateReads(small), small);
});

test('overflow revokes unseen edit ranges and retains only raw current windows still present in context', () => {
  const message = read('first\n', { startOffset: 0, endOffset: 6, contentHash: 'current' });
  const ctx = { reads: new Map([['notes.txt', 'current'], ['lost.txt', 'gone']]),
    fileReads: new Map([['effective:notes.txt', { hash: 'current', ranges: [[0, 200]], size: 200 }],
      ['effective:lost.txt', { hash: 'gone', ranges: [[0, 100]], size: 100 }]]),
    readEvidence: new Map([['lost.txt', { content: 'old body' }]]) };
  assert.deepEqual(retainVisibleReadPermissions(ctx, [message]), ['lost.txt']);
  assert.deepEqual(ctx.fileReads.get('effective:notes.txt').ranges, [[0, 6]]);
  assert.equal(ctx.reads.has('lost.txt'), false); assert.equal(ctx.readEvidence.has('lost.txt'), false);
  message.content[0].text = '[shortened]';
  assert.deepEqual(retainVisibleReadPermissions(ctx, [message]), ['notes.txt']);
  assert.equal(ctx.reads.size, 0);
});
