import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessExecutionClaims as assess, reconcileFollowUpConclusion, splitVerifiedNarration as split } from '../src/services/agent/executionEvidence.js';

const issuePaths = (result) => result.issues.map(({ kind, path, reason }) => ({ kind, path, reason }));
test('source follow-up preserves findings and removes only contradictions about the whole run', () => {
  const facts = { changedPaths: ['main.tex', 'figures/result.pdf'], compileSucceeded: true, compiledEarlier: true };
  assert.equal(reconcileFollowUpConclusion('本轮只完成来源核查，没有新增正文或图文件修改。原文说明横轴使用毫米。', facts),
    '原文说明横轴使用毫米。');
  assert.equal(reconcileFollowUpConclusion('本轮没有编译。This run, I only checked the sources. The source defines the unit.', facts).trim(),
    'The source defines the unit.');
  for (const statement of [
    '本次补查没有再次修改正文。', '本轮补查阶段未改动正文或图文件。', '本轮没有额外修改文件。',
    '本轮没有修改工作区文件。', '上一轮没有修改项目文件。', '本轮未修改 `other.tex`。',
    '本轮没有编译错误。', '本轮没有修改权限设置。', '本轮只完成来源核查和图例更新。',
    '本轮没有修改完成。', '本轮没有修改实验数据。', '本轮未修改原文内容，只调整排版。',
    '本轮没有修改图表数据。', '本轮没有修改正文。', '本轮没有新增文件。',
    '本轮未修改 `main.tex` 的研究数据。', '本轮未对 `main.tex` 中的参数作任何修改。',
    '来源的说明写着“本轮没有修改正文”。', '> 本轮没有修改正文。\n', '```text\n本轮没有修改正文。\n```',
  ]) assert.equal(reconcileFollowUpConclusion(statement, facts), statement);
  for (const contradiction of [
    '本轮没有修改任何项目文件。', '本轮没有任何正式文件改动。', '本轮未修改 `main.tex`。',
    '本轮未对 `main.tex` 作任何修改。', 'This run, I did not modify main.tex.',
  ]) assert.equal(reconcileFollowUpConclusion(contradiction, facts), '');
  assert.equal(reconcileFollowUpConclusion('本轮没有新增正文或图文件修改。', { changedPaths: ['plot.pdf'] }), '');
  assert.equal(reconcileFollowUpConclusion('本轮没有新增正文或图文件修改。', { changedPaths: ['paper.pdf', 'main.tex'] }),
    '本轮没有新增正文或图文件修改。');
  assert.equal(reconcileFollowUpConclusion('本轮只完成来源核查，没有修改项目文件。', { changedPaths: [] }),
    '本轮只完成来源核查，没有修改项目文件。');
});
test('successful tool counts alone cannot substantiate completion without a real net change', () => {
  assert.ok(assess('已完成修改。请审核。', { toolCallsTotal: 20, changedPaths: [] }).issues.length);
  assert.equal(assess('已完成修改。请审核。', { changedPaths: new Set(['a.tex']) }).issues.length, 0);
});
test('each explicitly completed file needs its own current-run change evidence', () => {
  assert.deepEqual(issuePaths(assess('已修改 a.tex 和 b.tex。', { changedPaths: ['a.tex'] })), [{ kind: 'edit', path: 'b.tex', reason: 'edit' }]);
  assert.equal(assess('已修改 `sec/intro.tex`。', { changedPaths: ['./sec/intro.tex'] }).issues.length, 0);
  assert.equal(assess('已修改 `章节/方法.tex`。', { changedPaths: ['章节/方法.tex'] }).issues.length, 0);
});
test('future work and referenced paths are not attributed to another completed file', () => {
  assert.equal(assess('已修改 a.tex；b.tex 还待处理。', { changedPaths: ['a.tex'] }).issues.length, 0);
  assert.equal(assess('已修改 a.tex，b.tex 还待处理。', { changedPaths: ['a.tex'] }).issues.length, 0);
  assert.equal(assess('已参照 b.tex 修改 a.tex。', { changedPaths: ['a.tex'] }).issues.length, 0);
});
test('read and edit claims in adjacent clauses use their own paths and operation evidence', () => {
  assert.equal(assess('已读取 a.tex，并已修改 b.tex。', { readPaths: ['a.tex'], changedPaths: ['b.tex'] }).issues.length, 0);
  assert.equal(assess('已读取 a.tex，并修改 b.tex。', { readPaths: ['a.tex'], changedPaths: ['b.tex'] }).issues.length, 0);
  assert.deepEqual(issuePaths(assess('已核对 a.tex。', { readPaths: [] })), [{ kind: 'read', path: 'a.tex', reason: 'read' }]);
  assert.equal(assess('已读取 a.tex。', { readPaths: new Map([['a.tex', 'hash']]) }).issues.length, 0);
});
test('ordinary staged write wording is supported by real project changes', () => {
  assert.equal(assess('已写入完成。已完成编辑 a.tex。', { changedPaths: ['a.tex'] }).issues.length, 0);
  assert.equal(assess('已暂存 a.tex。', { changedPaths: ['a.tex'] }).issues.length, 0);
});
test('workspace changes support workspace completion but cannot pretend a project review changeset exists', () => {
  assert.equal(assess('已修改 _workspace/plot.py。', { workspacePaths: ['_workspace/plot.py'] }).issues.length, 0);
  const result = assess('已完成修改。请审核。', { workspacePaths: ['_workspace/plot.py'] });
  assert.deepEqual(result.issues.map((issue) => issue.reason), ['review']);
  assert.equal(assess('变更集已生成。', { workspacePaths: ['_workspace/plot.py'] }).issues.length, 1);
});
test('explicit disk/application claims need applied evidence rather than staging only', () => {
  assert.equal(assess('已将 a.tex 应用到项目。', { changedPaths: ['a.tex'] }).issues.length, 1);
  assert.equal(assess('已将 a.tex 应用到项目。', { changedPaths: ['a.tex'], appliedPaths: ['a.tex'] }).issues.length, 0);
  assert.equal(assess('已写入磁盘 _workspace/a.py。', { workspacePaths: ['_workspace/a.py'] }).issues.length, 0);
});
test('compilation claims require actual successful compilation', () => {
  assert.deepEqual(assess('编译成功。').issues.map((issue) => issue.kind), ['compile']);
  assert.equal(assess('编译已完成。', { compileSucceeded: true }).issues.length, 0);
  assert.equal(assess('I compiled successfully.', { compileSucceeded: true }).issues.length, 0);
});
test('plans, negation, conditional advice, quoted labels and code examples are not completion claims', () => {
  for (const text of [
    '本轮尚未执行修改。', '我会在修改完成后通知你。', '如果已完成编辑，请检查差异。',
    '没有任何已修改的文件。', '不要声称已完成编辑。', '例如：已完成编辑 a.tex。',
    '建议使用“已完成编辑”标签。', '原文：已修改 a.tex。',
    '示例：`已修改 a.tex`。', '```text\n已修改 a.tex。\n```', '> 已完成编辑 a.tex。',
    '这里是分析结果，请审核以上建议。',
  ]) assert.equal(assess(text).issues.length, 0, text);
});
test('a negative previous clause does not hide a later positive completion claim', () => {
  assert.deepEqual(issuePaths(assess('尚未处理 b.tex，但已修改 a.tex。')), [{ kind: 'edit', path: 'a.tex', reason: 'edit' }]);
});
test('English completed-file statements are checked without treating future tense as success', () => {
  assert.equal(assess('I have modified a.tex.').issues.length, 1);
  assert.equal(assess('I will have modified a.tex tomorrow.').issues.length, 0);
  assert.equal(assess('I have modified a.tex.', { changedPaths: ['a.tex'] }).issues.length, 0);
});
test('incremental publication withholds split completion keywords and releases complete verified sentences', () => {
  assert.deepEqual(split('已').visibleText, '');
  assert.deepEqual(split('已完成编辑').visibleText, '');
  const blocked = split('已完成编辑。');
  assert.ok(blocked.issues.length); assert.doesNotMatch(blocked.visibleText, /已完成编辑/);
  assert.match(blocked.visibleText, /系统核对/);
  const verified = split('已完成编辑。', { evidence: { changedPaths: ['a.tex'] } });
  assert.equal(verified.visibleText, '已完成编辑。'); assert.equal(verified.pendingText, '');
});
test('an incomplete final sentence is checked only when the provider response ends', () => {
  assert.equal(split('已修改 a.tex').pendingText, '已修改 a.tex');
  assert.equal(split('已修改 a.tex', { final: true }).issues.length, 1);
  assert.equal(split('普通分析没有句号', { final: true }).visibleText, '普通分析没有句号');
});
test('multiple unsupported claims become one placeholder while genuine surrounding analysis is preserved', () => {
  const text = '建议先检查引用，已修改 a.tex。这里解释方程。已修改 b.tex。请审核。最后说明限制。';
  const result = split(text);
  assert.equal(result.visibleText.match(/系统核对/g)?.length, 1);
  assert.match(result.visibleText, /建议先检查引用/); assert.match(result.visibleText, /这里解释方程/); assert.match(result.visibleText, /最后说明限制/);
  assert.doesNotMatch(result.visibleText, /已修改/); assert.doesNotMatch(result.visibleText, /请审核/);
});
test('streamed code and quoted examples remain complete and literal rather than triggering a false guard', () => {
  const code = '```text\n已修改 a.tex。\n已完成编辑。\n```\n后面是分析。';
  const result = split(code);
  assert.equal(result.visibleText, code); assert.deepEqual(result.issues, []);
});
test('a projected claim is released as its real tool evidence arrives without another model request', () => {
  const raw = '已修改 a.tex。';
  const before = split(raw); const after = split(raw, { evidence: { changedPaths: ['a.tex'] } });
  assert.match(before.visibleText, /系统核对/); assert.equal(after.visibleText, raw);
});

test('unquoted Unicode filenames require their own net-change evidence even when another file really changed', () => {
  assert.deepEqual(assess('已修改 章节二.tex。', { changedPaths: ['a.tex'] }).issues.map((issue) => issue.path), ['章节二.tex']);
  assert.equal(assess('已修改章节二.tex。', { changedPaths: ['章节二.tex'] }).issues.length, 0);
  assert.deepEqual(assess('已修改章节二.tex。', { changedPaths: ['a.tex'] }).issues.map((issue) => issue.path), ['章节二.tex']);
  assert.equal(assess('已修改 章节/方法.tex。', { changedPaths: ['章节/方法.tex'] }).issues.length, 0);
});
test('published path lists keep completion context across complete sentence units and semicolons', () => {
  for (const raw of ['已修改 a.tex；b.tex。', '已修改 a.tex\nb.tex\n']) {
    const result = split(raw, { evidence: { changedPaths: ['a.tex'] } });
    assert.deepEqual(result.issues.map((issue) => issue.path), ['b.tex']);
    assert.match(result.visibleText, /已修改 a\.tex/); assert.doesNotMatch(result.visibleText, /b\.tex/);
  }
  const partial = split('已修改 a.tex；b.te', { evidence: { changedPaths: ['a.tex'] } });
  assert.equal(partial.pendingText, 'b.te'); assert.doesNotMatch(partial.visibleText, /b\.te/);
});
test('unfinished quoted file paths and split completion tokens never leak before their sentence is checked', () => {
  for (const raw of ['已', '已完成', '已完成修改 `章节', '已完成修改 `章节二.tex。']) {
    assert.equal(split(raw, { evidence: { changedPaths: ['a.tex'] } }).visibleText, '');
  }
  const result = split('已完成修改 `章节二.tex`。', { evidence: { changedPaths: ['a.tex'] } });
  assert.deepEqual(result.issues.map((issue) => issue.path), ['章节二.tex']); assert.doesNotMatch(result.visibleText, /章节二/);
});

test('plain 未 negates completion but does not exempt a later positive clause', () => {
  for (const text of ['未修改完成。', '本轮未修改完成。', '尚未真正修改完成。', '未编译成功。']) assert.deepEqual(assess(text).issues, [], text);
  assert.deepEqual(assess('未修改完成，但已修改 a.tex。').issues.map((issue) => issue.path), ['a.tex']);
  assert.equal(assess('原先未完成的内容现已修改 a.tex。').issues.length, 1);
});
test('reading explicitly supplied user messages or text needs no file-read evidence', () => {
  for (const text of ['I have read your request.', 'I have read your provided text.', '已读取你提供的消息。', '已读取用户需求。', '已读取上面粘贴的文本。', '已读取本轮消息。']) {
    assert.deepEqual(assess(text).issues, [], text);
    assert.equal(split(text, { final: true }).visibleText, text);
  }
});
test('user-provided text exemption never bypasses explicit file or document reads', () => {
  for (const text of ['已读取你提供的文件。', '已读取你提供的文档。', 'I have read your document.', '已读取你提供的消息 a.tex。', 'I have read your request in a.tex.']) assert.ok(assess(text).issues.some((issue) => issue.kind === 'read'), text);
});
test('completing edit suggestions is analysis, while completing edits then giving suggestions remains a claim', () => {
  for (const text of ['已完成修改建议。', '我已完成了修改建议的整理。', '已完成修改方案。']) {
    assert.deepEqual(assess(text).issues, [], text);
    assert.equal(split(text, { final: true }).visibleText, text);
  }
  assert.equal(assess('已完成修改，建议你检查引用。').issues.length, 1);
  assert.equal(assess('已完成修改。建议你检查引用。').issues.length, 1);
});

test('reporting how the read manuscript already addresses a review comment is not a current edit', () => {
  const text = '从当前 `sn-article.tex` 可见，稿件已修改贡献表述，现稿已将 LADDER 调整为筛选基线。' +
    '我上一轮已修改 5.7 节；当前正文仍保留对计算时间的说明。' +
    '现稿中表 9 的图注已按审稿人意见修改。请审核上述修改。';
  const evidence = { readPaths: ['sn-article.tex'] };
  assert.deepEqual(assess(text, evidence), { issues: [], hasClaims: false });
  assert.equal(split(text, { final: true, evidence }).visibleText, text);
  assert.equal(split(text, { final: true, evidence: { ...evidence, reviewStatusOnly: true } }).visibleText, text);
});

test('read-backed exceptions use the named current sources, including the preceding reference clause', () => {
  const exact = { readPaths: ['sections/results.tex'], reviewStatusOnly: true };
  const partial = { readPaths: ['main.tex'], reviewStatusOnly: true };
  for (const text of [
    '现稿 `sections/results.tex` 已修改到位。',
    '从 `sections/results.tex` 看，稿件已修改了复现说明。',
    '根据 `sections/results.tex` 可见，稿件已修改了复现说明。',
    '从 `sections/results.tex` 看，`main.tex` 已修改到位。',
  ]) {
    const reads = text.includes('main.tex') ? { ...exact, readPaths: [...exact.readPaths, 'main.tex'] } : exact;
    assert.equal(assess(text, reads).issues.length, 0, text);
    assert.ok(assess(text, partial).issues.length, text);
  }
  assert.equal(assess('已修改到位。', exact).issues.length, 0);
  assert.equal(assess('已修改到位。', { reviewStatusOnly: true }).issues.length, 1);
  assert.equal(assess('稿件已修改完成。请审核。', { readPaths: ['main.tex'] }).issues.length, 2);
});

test('historical and observed edits do not hide an explicit current change, save, read, or compile claim', () => {
  const text = '上一轮，我已修改 `main.tex`。现稿已修改复现说明，但我已按审稿意见修改 `method.tex`。' +
    '本轮已将 `main.tex` 写入磁盘。已读取 `missing.tex`。编译成功。';
  const evidence = { readPaths: ['main.tex'], reviewStatusOnly: true };
  assert.deepEqual(issuePaths(assess(text, evidence)), [
    { kind: 'edit', path: 'method.tex', reason: 'edit' },
    { kind: 'edit', path: 'main.tex', reason: 'applied' },
    { kind: 'read', path: 'missing.tex', reason: 'read' },
    { kind: 'compile', path: undefined, reason: 'compile' },
  ]);
  const projected = split(text, { final: true, evidence });
  assert.match(projected.visibleText, /上一轮，我已修改 `main\.tex`。现稿已修改复现说明/);
  assert.doesNotMatch(projected.visibleText, /method\.tex|missing\.tex|编译成功/);
  assert.equal(assess(text, { ...evidence, changedPaths: ['method.tex'], appliedPaths: ['main.tex'],
    readPaths: ['main.tex', 'missing.tex'], compileSucceeded: true }).issues.length, 0);
  assert.deepEqual(issuePaths(assess('In the previous turn, I modified main.tex. I modified method.tex.')),
    [{ kind: 'edit', path: 'method.tex', reason: 'edit' }]);
});

test('review invitations, questions and notes after a read do not manufacture file edits', () => {
  const text = '我已核对 `main.tex` 的对应段落，修改建议如下。已检查 `main.tex`，删除线只是修订痕迹。修改是否已完成？' +
    '已按审稿人的修改意见给出分析。已把修改建议整理成以下几条，请审核上述结论。';
  const evidence = { readPaths: ['main.tex'] };
  assert.equal(split(text, { final: true, evidence }).visibleText, text);
  const unsupported = '我已核对 `main.tex`，修改了 `method.tex`。请审核本次修改。';
  assert.deepEqual(issuePaths(assess(unsupported, evidence)), [
    { kind: 'edit', path: 'method.tex', reason: 'edit' }, { kind: 'edit', path: undefined, reason: 'review' },
  ]);
  for (const text of ['我已写入修改建议 `review.md`。', '我已完成修改说明文件 `review.md`。']) {
    assert.equal(assess(text).issues[0]?.path, 'review.md', text);
  }
});

test('mentioning earlier material does not exempt a current action', () => {
  const evidence = { readPaths: ['a.tex'] };
  for (const [text, reason, path] of [
    ['根据此前核对结果我已修改 `a.tex`。', 'edit', 'a.tex'],
    ['早前几轮写入的口径句我已经调整。', 'edit'],
    ['为核对此前出现的差异我已读取 `b.tex`。', 'read', 'b.tex'],
    ['为核对此前报告的错误我已成功编译。', 'compile'],
  ]) assert.deepEqual(assess(text, evidence).issues.map(issue => [issue.reason, issue.path]), [[reason, path]], text);

  const staged = { stagedOnly: true, changedPaths: ['a.tex'] };
  for (const text of [
    'Based on the previous run I applied the changes.',
    '为核对先前审查发现的问题我已经将变更合并到主草稿。',
  ]) assert.deepEqual(assess(text, staged).issues.map(issue => issue.reason), ['applied'], text);
  assert.equal(assess('现稿中我已修改表 9。', evidence).issues[0]?.reason, 'edit');
});

test('a named follow-on operation and an invitation explicitly about a current edit still need their own evidence', () => {
  assert.deepEqual(issuePaths(assess('我已修改 `a.tex`，删除 `b.tex`。', { changedPaths: ['a.tex'] })),
    [{ kind: 'edit', path: 'b.tex', reason: 'edit' }]);
  for (const text of ['请审核我刚刚对 `a.tex` 的修改。', '请审核我已修改的 `a.tex`。',
    '请审核本轮在 `a.tex` 的改动。', '请审核 `a.tex` 的变更。', '请审核 a.tex 的变更。']) {
    assert.deepEqual(issuePaths(assess(text, { workspacePaths: ['a.tex'] })),
      [{ kind: 'edit', path: 'a.tex', reason: 'review' }], text);
    assert.equal(assess(text, { changedPaths: ['a.tex'] }).issues.length, 0, text);
  }
  assert.equal(assess('请审核 `a.tex` 的变更建议。').issues.length, 0);
});

test('adjacent status conclusions can share one manuscript comparison and still distinguish later current operations', () => {
  const state = '核对现稿 `a.tex` 可见，表 5 已修改，表 9 已更新';
  const evidence = { readPaths: ['a.tex'] };
  assert.equal(split(`${state}。`, { evidence }).visibleText, `${state}。`);
  assert.equal(split('核对现稿可见，表 5 已修改，表 9 已更新。', { evidence }).issues.length, 0);
  assert.equal(assess(`${state}。`, { readPaths: ['b.tex'] }).issues.length, 2);
  assert.deepEqual(issuePaths(assess(`${state}，我已更新 \`b.tex\`。`, evidence)),
    [{ kind: 'edit', path: 'b.tex', reason: 'edit' }]);
  assert.deepEqual(issuePaths(assess(`${state}，已完成修改 \`a.tex\`。`, evidence)),
    [{ kind: 'edit', path: 'a.tex', reason: 'edit' }]);
});
