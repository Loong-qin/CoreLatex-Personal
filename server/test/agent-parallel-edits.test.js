import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createParallelEditSession, createEditorDraft, restoreEditorDraft, validateEditorTool,
  validateEditorChanges, mergeParallelEdits, parseParallelEditTasks, assertParallelEditSession } from '../src/services/agent/parallelEdits.js';

const task = (id, scope) => ({ id, task: '修改所分配范围的内容', scope: Array.isArray(scope) ? scope : [{ path: scope }] });
const row = (path, before, after) => ({ path, before, after, encoding: 'utf8' });
function fixture(t, files, changesetBuffer = []) {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-edits-'));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(projectDir, name)), { recursive: true });
    fs.writeFileSync(path.join(projectDir, name), content);
  }
  t.after(() => fs.rmSync(projectDir, { recursive: true, force: true }));
  return { projectDir, changesetBuffer };
}
const sessionFor = (ctx, tasks) => createParallelEditSession({ tasks, ctx, revision: 3 });
const merge = (session, ctx, results, revision = 3) => mergeParallelEdits({ session, ctx, results, revision });
const result = (id, ...proposedChanges) => ({ id, proposedChanges });
const code = expected => error => error.code === 'parallel_edit_' + expected;

test('independent file proposals merge atomically, retaining parent original bases and other drafts', t => {
  const ctx = fixture(t, { 'a.tex': 'disk A', 'b.tex': 'disk B', 'keep.txt': 'keep' },
    [row('a.tex', 'disk A', 'parent A'), row('keep.txt', 'keep', 'existing draft')]);
  const session = sessionFor(ctx, [task('a', 'a.tex'), task('b', 'b.tex')]);
  const merged = merge(session, ctx, [result('a', row('a.tex', 'parent A', 'child A')), result('b', row('b.tex', 'disk B', 'child B'))]);
  assert.deepEqual(merged, [row('a.tex', 'disk A', 'child A'), row('keep.txt', 'keep', 'existing draft'), row('b.tex', 'disk B', 'child B')]);
  assert.equal(ctx.changesetBuffer[0].after, 'parent A');
  assert.equal(fs.readFileSync(path.join(ctx.projectDir, 'a.tex'), 'utf8'), 'disk A');
  assert.ok(Object.isFrozen(session.files[0]));
});

test('private buffers isolate workers and restore a reverted sentinel instead of reading live disk', t => {
  const ctx = fixture(t, { 'a.tex': 'frozen', 'b.tex': 'other' });
  const session = sessionFor(ctx, [task('a', 'a.tex'), task('b', 'b.tex')]);
  const a = createEditorDraft(session, 'a'), secondA = createEditorDraft(session, 'a');
  a[0].after = 'private';
  assert.equal(secondA[0].after, 'frozen');
  assert.deepEqual(createEditorDraft(session, 'b'), [row('a.tex', 'frozen', 'frozen'), row('b.tex', 'other', 'other')]);
  a.splice(0);
  fs.writeFileSync(path.join(ctx.projectDir, 'a.tex'), 'new user content');
  restoreEditorDraft({ session, taskId: 'a', changesetBuffer: a });
  assert.equal(a[0].after, 'frozen');
  assert.deepEqual(validateEditorChanges({ session, taskId: 'a', changesetBuffer: a }), []);
});

test('same-file original line coordinates survive earlier added and deleted lines', t => {
  const before = 'title\nintro\nmethod\nresult\nend';
  const ctx = fixture(t, { 'main.tex': before });
  const session = sessionFor(ctx, [task('intro', [{ path: 'main.tex', startLine: 1, endLine: 2 }]),
    task('results', [{ path: 'main.tex', startLine: 4, endLine: 5 }])]);
  for (const prefix of ['new title\nnew intro\nextra\n', 'intro\n']) {
    const merged = merge(session, ctx, [result('intro', row('main.tex', before, prefix + 'method\nresult\nend')),
      result('results', row('main.tex', before, 'title\nintro\nmethod\nnew result\nnew end'))]);
    assert.equal(merged[0].after, prefix + 'method\nnew result\nnew end');
  }
});

test('CRLF and final line without newline are preserved when merging adjacent scopes', t => {
  const before = '标题\r\n方法\r\n结论';
  const ctx = fixture(t, { 'main.tex': before });
  const session = sessionFor(ctx, [task('a', [{ path: 'main.tex', startLine: 1, endLine: 1 }]),
    task('b', [{ path: 'main.tex', startLine: 2, endLine: 3 }])]);
  const merged = merge(session, ctx, [result('a', row('main.tex', before, before.replace('标题', '新标题'))),
    result('b', row('main.tex', before, before.replace('结论', '新结论')))]);
  assert.equal(merged[0].after, '新标题\r\n方法\r\n新结论');
});

test('insertions at shared line boundaries belong only to the right-hand task', t => {
  const before = 'one\ntwo\nthree';
  const ctx = fixture(t, { 'main.tex': before });
  const session = sessionFor(ctx, [task('a', [{ path: 'main.tex', startLine: 1, endLine: 1 }]),
    task('b', [{ path: 'main.tex', startLine: 2, endLine: 3 }])]);
  const insertion = row('main.tex', before, 'one\ninserted\ntwo\nthree');
  assert.throws(() => validateEditorChanges({ session, taskId: 'a', changesetBuffer: [insertion] }), code('scope'));
  assert.deepEqual(validateEditorChanges({ session, taskId: 'b', changesetBuffer: [insertion] }), [insertion]);
  assert.throws(() => merge(session, ctx, [result('a', insertion), result('b', insertion)]), code('scope'));
  assert.deepEqual(ctx.changesetBuffer, []);
});

test('EOF insertion belongs to the explicitly owned final empty line, not both adjacent scopes', t => {
  const before = 'one\n';
  const ctx = fixture(t, { 'main.tex': before });
  const session = sessionFor(ctx, [task('a', [{ path: 'main.tex', startLine: 1, endLine: 1 }]),
    task('b', [{ path: 'main.tex', startLine: 2, endLine: 2 }])]);
  const proposal = row('main.tex', before, 'one\nlast');
  assert.throws(() => validateEditorChanges({ session, taskId: 'a', changesetBuffer: [proposal] }), code('scope'));
  assert.equal(merge(session, ctx, [result('a'), result('b', proposal)])[0].after, 'one\nlast');
});

test('overlapping declarations and ambiguous or out-of-range scopes fail before workers start', t => {
  const ctx = fixture(t, { 'main.tex': 'one\ntwo\nthree' });
  for (const scopes of [
    [[{ path: 'main.tex' }], [{ path: 'main.tex', startLine: 2, endLine: 2 }]],
    [[{ path: 'main.tex', startLine: 1, endLine: 2 }], [{ path: 'main.tex', startLine: 2, endLine: 3 }]],
  ]) assert.throws(() => sessionFor(ctx, scopes.map((scope, index) => task(String(index), scope))), code('overlap'));
  for (const scope of [[{ path: 'main.tex', startLine: 1 }], [{ path: 'main.tex', startLine: 4, endLine: 5 }],
    [{ path: 'main.tex' }, { path: 'main.tex' }], [{ path: 'new.tex', startLine: 1, endLine: 1 }]]) {
    assert.throws(() => sessionFor(ctx, [task('a', scope)]), code('scope'));
  }
});

test('unsafe paths, reserved directories, binary files and symlink components are refused', t => {
  const ctx = fixture(t, { 'main.tex': 'safe', 'bad.tex': Buffer.from([0xff]), 'image.png': 'fake' });
  for (const file of ['/main.tex', '../main.tex', 'a/../main.tex', 'a//main.tex', './main.tex', 'C:/main.tex',
    'a\\main.tex', '_workspace/draft.tex', '.build/out.tex', '.git/config', 'a\0.tex']) {
    assert.throws(() => parseParallelEditTasks([task('a', file)]), code('scope'));
  }
  for (const file of ['bad.tex', 'image.png']) assert.throws(() => sessionFor(ctx, [task('a', file)]), code('encoding'));
  fs.symlinkSync(path.join(ctx.projectDir, 'main.tex'), path.join(ctx.projectDir, 'link.tex'));
  fs.symlinkSync(ctx.projectDir, path.join(ctx.projectDir, 'linkdir'));
  for (const file of ['link.tex', 'linkdir/main.tex']) assert.throws(() => sessionFor(ctx, [task('a', file)]), code('path'));
});

test('tool preflight rejects an out-of-scope or cumulative range-breaking edit without mutating drafts', t => {
  const before = 'one\ntwo\nthree';
  const ctx = fixture(t, { 'main.tex': before });
  const session = sessionFor(ctx, [task('a', [{ path: 'main.tex', startLine: 2, endLine: 2 }])]);
  const changesetBuffer = createEditorDraft(session, 'a');
  const call = (toolName, input) => validateEditorTool({ session, taskId: 'a', toolName, input, changesetBuffer });
  assert.equal(call('edit_file', { path: 'main.tex', search: 'two', replace: 'second' }), true);
  assert.throws(() => call('write_file', { path: 'main.tex', content: 'changed\ntwo\nthree' }), code('scope'));
  assert.throws(() => call('edit_file', { path: '_workspace/a.tex', search: 'x', replace: 'y' }), code('scope'));
  assert.throws(() => call('write_file', { path: 'other.tex', content: 'oops' }), code('scope'));
  assert.throws(() => call('run_in_workspace', { command: 'anything' }), code('tool'));
  assert.equal(changesetBuffer[0].after, before);
  changesetBuffer[0].after = 'oops\ntwo\nthree';
  assert.throws(() => call('edit_file', { path: 'main.tex', search: 'two', replace: 'second' }), code('scope'));
});

test('new UTF8 files use full-file scope, preserve absence and never touch disk', t => {
  const ctx = fixture(t, {});
  const session = sessionFor(ctx, [task('a', 'new.tex'), task('b', 'empty.txt')]);
  assert.deepEqual(createEditorDraft(session, 'a'), []);
  assert.equal(validateEditorTool({ session, taskId: 'a', toolName: 'write_file', input: { path: 'new.tex', content: 'new' }, changesetBuffer: [] }), true);
  assert.deepEqual(merge(session, ctx, [result('a', row('new.tex', null, 'new')), result('b', row('empty.txt', null, ''))]),
    [row('new.tex', null, 'new'), row('empty.txt', null, '')]);
  assert.equal(fs.existsSync(path.join(ctx.projectDir, 'new.tex')), false);
});

test('stale revision, parent buffer or disk snapshot rejects the entire batch', t => {
  const ctx = fixture(t, { 'a.tex': 'A', 'b.tex': 'B' });
  const session = sessionFor(ctx, [task('a', 'a.tex'), task('b', 'b.tex')]);
  const results = [result('a', row('a.tex', 'A', 'new A')), result('b', row('b.tex', 'B', 'new B'))];
  assert.throws(() => merge(session, ctx, results, 4), code('stale'));
  ctx.changesetBuffer.push(row('unrelated.tex', null, 'parent addition'));
  assert.throws(() => merge(session, ctx, results), code('stale'));
  ctx.changesetBuffer.splice(0);
  fs.writeFileSync(path.join(ctx.projectDir, 'b.tex'), 'USER');
  assert.throws(() => merge(session, ctx, results), code('stale'));
  assert.deepEqual(ctx.changesetBuffer, []);
  assert.equal(fs.readFileSync(path.join(ctx.projectDir, 'a.tex'), 'utf8'), 'A');
});

test('missing/duplicate task results, forged baselines, deletion and binary proposals fail closed', t => {
  const ctx = fixture(t, { 'a.tex': 'A', 'b.tex': 'B' });
  const session = sessionFor(ctx, [task('a', 'a.tex'), task('b', 'b.tex')]);
  for (const results of [[result('a')], [result('a'), result('a')],
    [result('a', row('a.tex', 'forged', 'new')), result('b')],
    [result('a', row('a.tex', 'A', null)), result('b')],
    [result('a', { ...row('a.tex', 'A', 'new'), encoding: 'base64' }), result('b')]]) {
    assert.throws(() => merge(session, ctx, results), code('proposal'));
    assert.deepEqual(ctx.changesetBuffer, []);
  }
});

test('no-op sentinel proposals do not pollute parent changes and edits may revert parent draft', t => {
  const ctx = fixture(t, { 'a.tex': 'A', 'b.tex': 'B' }, [row('a.tex', 'A', 'parent')]);
  const session = sessionFor(ctx, [task('a', 'a.tex'), task('b', 'b.tex')]);
  assert.deepEqual(merge(session, ctx, [result('a', row('a.tex', 'parent', 'A')), result('b', row('b.tex', 'B', 'B'))]), []);
});

test('read-only overlays expose parent pending drafts without authorizing edits or returning false changes', t => {
  const ctx = fixture(t, { 'a.tex': 'A', 'context.tex': 'old context', 'b.tex': 'B' },
    [row('context.tex', 'old context', 'parent pending context')]);
  const session = sessionFor(ctx, [task('a', 'a.tex'), task('b', 'b.tex')]);
  const draft = createEditorDraft(session, 'a');
  assert.equal(draft.find(item => item.path === 'context.tex').after, 'parent pending context');
  assert.deepEqual(validateEditorChanges({ session, taskId: 'a', changesetBuffer: draft }), []);
  assert.throws(() => validateEditorTool({ session, taskId: 'a', toolName: 'edit_file', input: {
    path: 'context.tex', search: 'pending', replace: 'unauthorized' }, changesetBuffer: draft }), code('scope'));
  draft.find(item => item.path === 'context.tex').after = 'unauthorized';
  assert.throws(() => validateEditorChanges({ session, taskId: 'a', changesetBuffer: draft }), code('scope'));
});

test('forged/cloned sessions and cross-project reuse cannot grant editing permissions', t => {
  const ctx = fixture(t, { 'a.tex': 'A' }), other = fixture(t, { 'a.tex': 'OTHER' });
  const session = sessionFor(ctx, [task('a', 'a.tex')]);
  assert.equal(assertParallelEditSession(session, ctx), true);
  assert.throws(() => createEditorDraft(structuredClone(session), 'a'), code('context'));
  assert.throws(() => assertParallelEditSession(session, other), code('context'));
  assert.throws(() => merge(session, other, [result('a')]), code('context'));
});

test('real file tools edit isolated buffers, preserve frozen reads after revert, and do not write project files', async t => {
  const { getPiTools } = await import('../src/services/agent/tools.js');
  const before = 'first\nsecond\nthird';
  const ctx = fixture(t, { 'main.tex': before, 'context.tex': 'disk context' }, [row('context.tex', 'disk context', 'staged context')]);
  const session = sessionFor(ctx, [task('a', [{ path: 'main.tex', startLine: 2, endLine: 2 }])]);
  const localCtx = { ...ctx, changesetBuffer: createEditorDraft(session, 'a'), reads: new Map(),
    user: {}, project: {}, agentConfig: { confirmBeforeApply: true } };
  const execute = async (toolName, input) => {
    validateEditorTool({ session, taskId: 'a', toolName, input, changesetBuffer: localCtx.changesetBuffer });
    try { return await getPiTools(localCtx).find(tool => tool.name === toolName).execute(toolName, input); }
    finally { restoreEditorDraft({ session, taskId: 'a', changesetBuffer: localCtx.changesetBuffer }); }
  };
  const context = await execute('read_file', { path: 'context.tex' });
  assert.equal(context.details.display.text, 'staged context');
  await execute('read_file', { path: 'main.tex' });
  await execute('edit_file', { path: 'main.tex', search: 'second', replace: 'changed' });
  assert.equal(fs.readFileSync(path.join(ctx.projectDir, 'main.tex'), 'utf8'), before);
  const proposal = validateEditorChanges({ session, taskId: 'a', changesetBuffer: localCtx.changesetBuffer });
  assert.deepEqual(proposal, [row('main.tex', before, 'first\nchanged\nthird')]);
  await execute('edit_file', { path: 'main.tex', search: 'changed', replace: 'second' });
  fs.writeFileSync(path.join(ctx.projectDir, 'main.tex'), 'new user text');
  const frozen = await execute('read_file', { path: 'main.tex' });
  assert.equal(frozen.details.display.text, before);
  assert.deepEqual(validateEditorChanges({ session, taskId: 'a', changesetBuffer: localCtx.changesetBuffer }), []);
  await assert.rejects(execute('write_file', { path: '_workspace/escape.tex', content: 'must not write' }), code('scope'));
  assert.equal(fs.existsSync(path.join(ctx.projectDir, '_workspace')), false);
  assert.throws(() => merge(session, ctx, [result('a', ...proposal)]), code('stale'));
});
