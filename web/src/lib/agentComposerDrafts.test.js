// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { composerDraftScope, createComposerDraftCache } from './agentComposerDrafts.js';

beforeEach(() => sessionStorage.clear());
describe('project composer draft isolation', () => {
  it('keeps account/project drafts separate and restores only text after a page reload', () => {
    const cache = createComposerDraftCache(sessionStorage);
    const a = composerDraftScope(1, 'a'), b = composerDraftScope(1, 'b'), other = composerDraftScope(2, 'a');
    cache.get(a).text = 'project A';
    cache.get(a).attachments.push({ name: 'figure.png', base64: 'private-data', pending: false });
    cache.persist(a);
    cache.get(b).text = 'project B'; cache.persist(b);
    expect(cache.get(other).text).toBe('');
    expect(cache.get(a).attachments[0].base64).toBe('private-data');
    const afterReload = createComposerDraftCache(sessionStorage);
    expect(afterReload.get(a)).toEqual({ text: 'project A', attachments: [] });
    expect(afterReload.get(b).text).toBe('project B');
    expect(JSON.stringify(Object.values(sessionStorage))).not.toContain('private-data');
  });
  it('preserves original project text/attachments after a failure or cancellation', () => {
    const cache = createComposerDraftCache(sessionStorage), a = composerDraftScope(1, 'a'), b = composerDraftScope(1, 'b');
    const draft = cache.get(a); draft.text = 'retry A'; draft.attachments.push({ name: 'a.txt', base64: 'A' });
    const ticket = cache.begin(a);
    expect(draft.text).toBe(''); expect(draft.attachments).toHaveLength(0);
    cache.get(b).text = 'editing B'; cache.finish(ticket, false);
    expect(cache.get(a).text).toBe('retry A'); expect(cache.get(a).attachments[0].name).toBe('a.txt');
    expect(cache.get(b).text).toBe('editing B');
  });
  it('keeps the submitted text recoverable through a reload, then clears it on success', () => {
    const cache = createComposerDraftCache(sessionStorage), scope = composerDraftScope(1, 'a');
    cache.get(scope).text = 'pending';
    const ticket = cache.begin(scope);
    expect(createComposerDraftCache(sessionStorage).get(scope).text).toBe('pending');
    cache.finish(ticket, true);
    expect(createComposerDraftCache(sessionStorage).get(scope).text).toBe('');
  });
  it('never overwrites a newer draft with a cancelled or completed submission', () => {
    const cache = createComposerDraftCache(sessionStorage), scope = composerDraftScope(1, 'a');
    cache.get(scope).text = 'old'; const ticket = cache.begin(scope);
    cache.get(scope).text = 'new correction'; cache.persist(scope);
    cache.finish(ticket, false);
    expect(cache.get(scope).text).toBe('new correction');
    cache.finish(ticket, true); expect(cache.get(scope).text).toBe('new correction');
  });
  it('purges the previous account and ignores its late send result', () => {
    const cache = createComposerDraftCache(sessionStorage), a = composerDraftScope(1, 'a'), b = composerDraftScope(2, 'a');
    cache.get(a).text = 'account 1'; const ticket = cache.begin(a);
    cache.get(b).text = 'account 2'; cache.persist(b);
    cache.clearAccount(1); cache.finish(ticket, false);
    expect(cache.get(a).text).toBe(''); expect(cache.get(a).attachments).toEqual([]);
    expect(cache.get(b).text).toBe('account 2');
  });
  it('keeps drafts usable when browser storage is unavailable', () => {
    const cache = createComposerDraftCache(() => { throw new Error('storage blocked'); });
    const scope = composerDraftScope(1, 'a'); cache.get(scope).text = 'in memory';
    expect(() => cache.persist(scope)).not.toThrow();
    const ticket = cache.begin(scope); cache.finish(ticket, false);
    expect(cache.get(scope).text).toBe('in memory');
    expect(composerDraftScope(null, 'a')).toBeNull();
  });
});
