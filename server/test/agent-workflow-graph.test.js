import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkflowGraph } from '../src/services/agent/workflowGraph.js';

const plan = (g, scenario, extra = {}) => g.plan({ scenario, summary: '读取相关材料并执行所需步骤', ...extra });
const end = (g, name, extra = {}) => { g.toolStart(name); g.toolEnd(name, { succeeded: true, ...extra }); };
const edit = (g, file = 'main.tex') => end(g, 'edit_file', { outcome: { changed: true, scope: 'project' }, changedPaths: [file] });

test('planning gates execution, and editing requires current context even on the answer route', () => {
  const g = createWorkflowGraph();
  assert.match(g.beforeTool('write_file'), /尚未规划/);
  assert.equal(g.beforeTool('ask_user'), null);
  plan(g, 'answer'); assert.equal(g.beforeTool('write_file'), null, 'new files need no unrelated context read');
  g.observeToolIntent('edit_file'); assert.match(g.beforeTool('edit_file'), /本轮上下文/);
  end(g, 'read_workspace'); assert.equal(g.beforeTool('write_file'), null);
});

test('empty document context does not authorize work and no-op/workspace edits require no compile', () => {
  const g = createWorkflowGraph(); plan(g, 'edit');
  end(g, 'get_document_context', { outcome: { file: null, content: '' } });
  assert.match(g.beforeTool('write_file'), /本轮上下文/);
  end(g, 'read_file');
  end(g, 'edit_file', { outcome: { changed: false, scope: 'project' } });
  end(g, 'write_file', { outcome: { changed: true, scope: 'workspace' } });
  assert.equal(g.prepareCompletion({ changedPaths: [] }).ready, true);
});

test('render-affecting edits require compile after the latest real edit, including bibliography/assets', () => {
  for (const file of ['main.tex', 'refs.bib', 'format.sty', 'paper.cls', 'figure.png', 'figure.tikz', 'plot.pgf', 'results.dat', 'table.csv', 'values.tsv', 'font.ttf', 'font.otf']) {
    const g = createWorkflowGraph(); plan(g, 'edit'); end(g, 'read_file');
    end(g, 'compile_and_preview'); edit(g, file);
    assert.match(g.prepareCompletion({ changedPaths: [file] }).reason, /尚未验证/);
    end(g, 'compile_and_preview'); assert.equal(g.prepareCompletion({ changedPaths: [file] }).ready, true);
    edit(g, file); assert.equal(g.prepareCompletion({ changedPaths: [file] }).ready, false);
  }
});

test('non-rendering project edits and reverted net changes do not force compilation', () => {
  const g = createWorkflowGraph(); plan(g, 'edit'); end(g, 'read_file'); edit(g, 'notes.txt');
  assert.equal(g.prepareCompletion({ changedPaths: ['notes.txt'] }).ready, true);
  edit(g); assert.equal(g.prepareCompletion({ changedPaths: [] }).ready, true);
});

test('replanning cannot erase compile failures, unresolved render changes or research requirements', () => {
  const g = createWorkflowGraph(); plan(g, 'edit', { needsSources: true, sourcePaths: ['sources.txt'] }); end(g, 'read_file', { input: { path: 'sources.txt' }, resultText: 'Original source evidence' }); edit(g);
  plan(g, 'answer'); assert.equal(g.prepareCompletion({ changedPaths: ['main.tex'] }).ready, false);
  end(g, 'compile_and_preview', { succeeded: false, error: 'missing package' }); plan(g, 'answer');
  assert.match(g.prepareCompletion({ changedPaths: ['main.tex'] }).reason, /编译验证仍失败/);
  end(g, 'compile_and_preview'); assert.equal(g.prepareCompletion({ changedPaths: ['main.tex'] }).ready, true);
  const local = createWorkflowGraph({ allowWebAccess: false }); plan(local, 'research'); plan(local, 'answer');
  assert.match(local.prepareCompletion().reason, /联网已关闭/);
});

test('search summaries cannot satisfy research; local source reads are supported without web access', () => {
  const g = createWorkflowGraph({ allowWebAccess: false }); plan(g, 'research', { sourcePaths: ['sources.txt'] }); end(g, 'web_search');
  assert.match(g.prepareCompletion().reason, /read_file/);
  end(g, 'read_file', { succeeded: false }); assert.equal(g.prepareCompletion().ready, false);
  end(g, 'read_file', { input: { path: 'sources.txt' }, resultText: 'Nonempty source text' }); assert.equal(g.prepareCompletion().ready, true);
  assert.equal(g.snapshot().nodes.find(n => n.id === 'research').status, 'completed');
});

test('compile failure follows repair edge and is not relabeled successful without a real successful compile', () => {
  const g = createWorkflowGraph(); plan(g, 'compile'); end(g, 'read_file');
  end(g, 'compile_and_preview', { succeeded: false, error: 'Undefined control sequence' });
  assert.equal(g.snapshot().currentNode, 'edit');
  assert.equal(g.snapshot().nodes.find(n => n.id === 'verify').status, 'failed');
  assert.equal(g.prepareCompletion().ready, false);
  end(g, 'compile_and_preview'); assert.equal(g.prepareCompletion().ready, true);
});

test('completion correction budget is bounded and preserves the exact failing node', () => {
  const g = createWorkflowGraph(); plan(g, 'research');
  assert.equal(g.prepareCompletion().failed, false);
  assert.equal(g.prepareCompletion().failed, false);
  assert.equal(g.prepareCompletion().failed, true);
  g.finish('failed');
  assert.equal(g.snapshot().status, 'failed');
  assert.equal(g.snapshot().nodes.find(n => n.id === 'research').status, 'failed');
  assert.notEqual(g.snapshot().nodes.find(n => n.id === 'deliver').status, 'completed');
});

test('human input pauses and resumes the same node, cancellation never reports it completed', () => {
  const g = createWorkflowGraph(); plan(g, 'edit'); g.toolStart('read_file');
  g.wait(); assert.equal(g.snapshot().status, 'waiting'); assert.equal(g.snapshot().currentNode, 'context');
  g.resume(); assert.equal(g.snapshot().status, 'running'); assert.equal(g.snapshot().nodes.find(n => n.id === 'context').status, 'running');
  g.wait(); g.finish('cancelled');
  assert.equal(g.snapshot().status, 'cancelled'); assert.equal(g.snapshot().nodes.find(n => n.id === 'context').status, 'pending');
});

test('published snapshots are detached and completed answers skip irrelevant execution branches', () => {
  const seen = []; const g = createWorkflowGraph({ onChange: graph => seen.push(graph) }); plan(g, 'answer');
  const old = seen.at(-1); g.prepareCompletion(); g.finish('completed');
  assert.equal(old.status, 'running');
  const final = g.snapshot(); assert.equal(final.status, 'completed');
  assert.equal(final.nodes.find(n => n.id === 'deliver').status, 'completed');
  assert.equal(final.nodes.find(n => n.id === 'edit').status, 'skipped');
});

test('manuscript context, undeclared prior reads and empty local files cannot satisfy source verification', () => {
  const g = createWorkflowGraph(); plan(g, 'answer');
  end(g, 'read_file', { input: { path: 'main.tex' }, resultText: 'A manuscript claim.' });
  plan(g, 'edit', { needsSources: true, sourcePaths: ['source.txt'] });
  assert.equal(g.prepareCompletion().ready, false);
  end(g, 'read_file', { input: { path: 'main.tex' }, resultText: 'A manuscript claim.' });
  assert.equal(g.prepareCompletion().ready, false);
  end(g, 'read_file', { input: { path: 'source.txt' }, resultText: '   \n' });
  assert.equal(g.prepareCompletion().ready, false);
  end(g, 'read_file', { input: { path: 'source.txt' }, resultText: 'Actual source body' });
  assert.equal(g.prepareCompletion().ready, true);
  const prior = createWorkflowGraph(); plan(prior, 'answer');
  end(prior, 'read_file', { input: { path: 'source.txt' }, resultText: 'Prior body' });
  plan(prior, 'research', { sourcePaths: ['source.txt'] });
  assert.equal(prior.prepareCompletion().ready, false, 'source must be declared before its evidence read');
});

test('workspace listings are not evidence; a declared file with actual nonempty preview body is', () => {
  const g = createWorkflowGraph({ allowWebAccess: false }); plan(g, 'research', { sourcePaths: ['_workspace/data.csv'] });
  end(g, 'read_workspace', { resultText: 'data.csv（10240 字节）' }); assert.equal(g.prepareCompletion().ready, false);
  end(g, 'read_workspace', { resultText: 'data.csv（0 字节）\n--- data.csv 内容 ---\n\n--- 结束 ---' }); assert.equal(g.prepareCompletion().ready, false);
  end(g, 'read_workspace', { resultText: 'data.csv（12 字节）\n--- data.csv 内容 ---\na,b\n1,2\n--- 结束 ---' }); assert.equal(g.prepareCompletion().ready, true);
});

test('web page metadata without body does not count as source content', () => {
  const g = createWorkflowGraph(); plan(g, 'research');
  end(g, 'web_fetch', { resultText: '【Title】\n来源：https://example.test\n---\n   ' }); assert.equal(g.prepareCompletion().ready, false);
  end(g, 'web_fetch', { resultText: '【Title】\n来源：https://example.test\n---\nActual source body.' }); assert.equal(g.prepareCompletion().ready, true);
});

test('read-only diagnosis requires a compile attempt but can honestly deliver a failing result without repairs', () => {
  const g = createWorkflowGraph(); plan(g, 'diagnose');
  assert.match(g.beforeTool('edit_file'), /只读编译诊断/);
  assert.match(g.prepareCompletion().reason, /尚未执行/);
  end(g, 'compile_and_preview', { succeeded: false, error: 'Undefined control sequence' });
  assert.equal(g.snapshot().currentNode, 'verify');
  assert.equal(g.prepareCompletion().ready, true); g.finish('completed');
  assert.equal(g.snapshot().nodes.find(n => n.id === 'verify').status, 'failed');
  assert.match(g.snapshot().detail, /未执行修复/);
  const answer = createWorkflowGraph(); plan(answer, 'answer');
  end(answer, 'compile_and_preview', { succeeded: false, error: 'diagnostic error' });
  assert.equal(answer.prepareCompletion().ready, true);
});

test('diagnosis cannot remove earlier compile-repair obligations or excuse formal render edits', () => {
  const g = createWorkflowGraph(); plan(g, 'compile'); end(g, 'read_file');
  end(g, 'compile_and_preview', { succeeded: false }); plan(g, 'diagnose');
  assert.equal(g.prepareCompletion().ready, false);
  const changed = createWorkflowGraph(); plan(changed, 'diagnose'); end(changed, 'compile_and_preview', { succeeded: false });
  assert.equal(changed.prepareCompletion({ changedPaths: ['figure.tikz'] }).ready, false);
});

test('script execution invalidates existing compile evidence even if script reports an error', () => {
  const g = createWorkflowGraph(); plan(g, 'edit'); end(g, 'read_file'); edit(g); end(g, 'compile_and_preview');
  end(g, 'run_in_workspace', { succeeded: false, error: 'script failed after writing' });
  assert.equal(g.prepareCompletion({ changedPaths: ['main.tex'] }).ready, false);
  end(g, 'compile_and_preview'); assert.equal(g.prepareCompletion({ changedPaths: ['main.tex'] }).ready, true);
});

test('explicit read-only diagnosis blocks unclassified MCP mutation capabilities', () => {
  const g = createWorkflowGraph(); plan(g, 'diagnose');
  g.observeToolIntent('mcp__filesystem__write_file');
  assert.match(g.beforeTool('mcp__filesystem__write_file'), /只读编译诊断/);
  g.observeToolIntent('edit_file'); assert.match(g.beforeTool('edit_file'), /只读编译诊断/);
});
test('script and MCP effects invalidate prior compile evidence even without staged file edits', () => {
  for (const name of ['run_in_workspace','run_skill_script','mcp__filesystem__write_file']) {
    const g=createWorkflowGraph(); plan(g,'answer'); end(g,'compile_and_preview');
    end(g,name); assert.equal(g.prepareCompletion({changedPaths:[]}).ready,false);
    end(g,'compile_and_preview'); assert.equal(g.prepareCompletion({changedPaths:[]}).ready,true);
  }
});

test('observed unchanged inputs keep compile proof after queries and failing QA', () => {
  const g = createWorkflowGraph(); plan(g, 'edit'); end(g, 'read_file'); edit(g); end(g, 'compile_and_preview');
  const executionEffects = { compilationUnchanged: true };
  end(g, 'run_skill_script', { succeeded: false, error: 'No matches', executionEffects });
  end(g, 'mcp__research__lookup', { executionEffects });
  assert.equal(g.prepareCompletion({ changedPaths: ['main.tex'] }).ready, true);
});

test('rejected tool calls neither affect inputs nor count as a compile attempt', () => {
  const g = createWorkflowGraph(); plan(g, 'diagnose');
  const rejected = { succeeded: false, compilationToolInvoked: false };
  g.toolEnd('compile_and_preview', rejected);
  assert.match(g.prepareCompletion().reason, /尚未执行/);
  end(g, 'compile_and_preview');
  end(g, 'run_in_workspace', rejected);
  g.toolEnd('compile_and_preview', rejected);
  assert.equal(g.prepareCompletion().ready, true);
  assert.equal(g.snapshot().nodes.find(n => n.id === 'verify').status, 'completed');
});

test('local source body is declared and read in one tool call without collaboration planning', () => {
  const g=createWorkflowGraph(); g.plan({scenario:'answer',summary:'直接核查来源',automatic:true});
  const input={path:'source.txt',purpose:'source'};
  assert.equal(g.beforeTool('read_file',input),null);
  assert.equal(g.prepareCompletion().ready,false);
  end(g,'read_file',{input,resultText:'Original primary-source evidence.'});
  assert.equal(g.prepareCompletion().ready,true);
});
