import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { randomUUID } from 'node:crypto';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'corelatex-freshness-'));
const savedPath = process.env.PATH;
process.env.CORELATEX_DATA_DIR = root;
let db, database, user, executeTool, getPiTools, runAgent, fileState, scanFileChanges, recovery;
before(async () => {
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  const binary = (name, body) => fs.writeFileSync(path.join(bin, name), '#!' + process.execPath + '\n' + body, { mode: 0o755 });
  binary('pdflatex', `const fs=require('node:fs');fs.mkdirSync('.build',{recursive:true});
    if(fs.readFileSync(process.argv.at(-1),'utf8').includes('FAIL')){fs.writeFileSync('.build/main.log','main.tex:3: Undefined control sequence.');process.exit(1);}
    fs.writeFileSync('.build/main.pdf','%PDF-1.4 fake');fs.writeFileSync('.build/main.log','Output written on main.pdf.');`);
  binary('pdfinfo', "console.log('Pages: 1')");
  binary('pdftoppm', "require('node:fs').writeFileSync(process.argv.at(-1)+'-1.jpg',Buffer.from([255,216,255,217]))");
  process.env.PATH = bin + path.delimiter + savedPath;
  database = await import('../src/db.js'); db = database.getDb();
  ({ executeTool, getPiTools } = await import('../src/services/agent/tools.js'));
  ({ runAgent } = await import('../src/services/agent/agentLoop.js'));
  ({ fileState, scanFileChanges } = await import('../src/services/agent/fileState.js'));
  ({ createExecutionRecovery: recovery } = await import('../src/services/agent/executionRecovery.js'));
  const id = Number(db.prepare("INSERT INTO users(username,password_hash,role) VALUES('freshness','unused','admin')").run().lastInsertRowid);
  user = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  db.prepare('INSERT OR REPLACE INTO settings(user_id,agent_config) VALUES(?,?)').run(id, JSON.stringify({ collaborationTier: 'off', allowWebAccess: false }));
});
after(() => { database.resetDb(); process.env.PATH = savedPath; fs.rmSync(root, { recursive: true, force: true }); });
function fixture(content = 'Original body.\n') {
  const id = Number(db.prepare('INSERT INTO projects(name,owner_id,public_id) VALUES(?,?,?)').run('fresh', user.id, randomUUID()).lastInsertRowid);
  const chatId = Number(db.prepare('INSERT INTO chats(project_id,user_id) VALUES(?,?)').run(id, user.id).lastInsertRowid);
  const projectDir = path.join(root, 'projects', String(id)); fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'notes.txt'), content);
  return { user, db, chatId, project: db.prepare('SELECT * FROM projects WHERE id=?').get(id), projectDir,
    workspaceDir: path.join(projectDir, '_workspace'), reads: new Map(), fileReads: new Map(), readEvidence: new Map(), changesetBuffer: [], agentConfig: {} };
}
const read = (ctx, extra = {}) => executeTool('read_file', { path: 'notes.txt', ...extra }, ctx);
const edit = (ctx, search, replace) => executeTool('edit_file', { path: 'notes.txt', search, replace }, ctx);
const disk = ctx => path.join(ctx.projectDir, 'notes.txt');

test('searching CR-only manuscripts returns exact source bytes and line positions', async () => {
  const raw = 'First\rTarget\rFollowing\rFinal';
  const ctx = fixture(raw);
  const found = await read(ctx, { find: 'Target', limit: 2 });
  assert.deepEqual(found.matchLines, [2]);
  assert.match(found.text, /^Target\rFollowing\n/);
  assert.equal((await edit(ctx, 'First', 'Unread')).code, 'READ_SCOPE_REQUIRED');
  assert.equal(await read(ctx), raw);
});

test('literal search checks the effective draft and grants read coverage only for the returned excerpt', async () => {
  const ctx = fixture('Old wording\nUnseen heading\nFooter');
  const draft = 'New wording\nUnseen heading\nNew wording again';
  ctx.changesetBuffer.push({ path: 'notes.txt', before: fs.readFileSync(disk(ctx), 'utf8'), after: draft });
  const noMatch = await read(ctx, { find: 'Old wording', purpose: 'source' });
  assert.equal(noMatch.matchedLines, 0);
  assert.equal(noMatch.text, '');
  assert.equal(ctx.readEvidence.size, 0);
  assert.equal((await edit(ctx, 'Unseen', 'Another')).code, 'FILE_READ_REQUIRED');
  const found = await read(ctx, { find: 'New wording' });
  assert.deepEqual(found.matchLines, [1, 3]);
  assert.equal(found.staged, true);
  assert.match(found.text, /^New wording\n/);
  assert.equal((await edit(ctx, 'Unseen', 'Another')).code, 'READ_SCOPE_REQUIRED');
  assert.deepEqual((await read(ctx, { find: 'New wording', offset: 2 })).matchLines, [3]);
  assert.deepEqual((await read(ctx, { find: 'Old wording', view: 'project' })).matchLines, [1]);
  assert.equal((await read(ctx, { find: 'New wording', offset: 4 })).matchedLines, 0);
});

test('same-size external edits with restored mtime require actual reread; repeated reads remain executable', async () => {
  const ctx = fixture('Old body.\n'), stat = fs.statSync(disk(ctx));
  assert.equal(await read(ctx), 'Old body.\n');
  fs.writeFileSync(disk(ctx), 'New body.\n'); fs.utimesSync(disk(ctx), stat.atime, stat.mtime);
  assert.equal((await edit(ctx, 'body', 'text')).code, 'FILE_CHANGED');
  assert.equal(scanFileChanges(ctx).length, 1);
  assert.equal(await read(ctx), 'New body.\n'); assert.equal(await read(ctx), 'New body.\n');
  assert.equal(scanFileChanges(ctx).length, 0);
  assert.equal((await edit(ctx, 'body', 'text')).changed, true);
  assert.equal(ctx.changesetBuffer[0].before, 'New body.\n');
});

test('drafts expose concurrent user changes, require both current versions, and rebase without overwriting disk', async () => {
  const ctx = fixture(); await read(ctx); await edit(ctx, 'Original', 'Revised');
  fs.writeFileSync(disk(ctx), 'User heading.\nOriginal body.\n');
  assert.equal((await edit(ctx, 'body', 'text')).code, 'DRAFT_BASE_CHANGED');
  const draft = await read(ctx), project = await read(ctx, { view: 'project' });
  assert.equal(draft.conflict, true); assert.equal(draft.text, 'Revised body.\n');
  assert.equal(project.text, 'User heading.\nOriginal body.\n');
  const merged = await executeTool('write_file', { path: 'notes.txt', content: 'User heading.\nRevised body.\n',
    rebase: { projectHash: project.contentHash, draftHash: draft.contentHash } }, ctx);
  assert.equal(merged.rebased, true);
  assert.equal(ctx.changesetBuffer[0].before, 'User heading.\nOriginal body.\n');
  assert.equal(ctx.changesetBuffer[0].after, 'User heading.\nRevised body.\n');
  assert.equal(fs.readFileSync(disk(ctx), 'utf8'), 'User heading.\nOriginal body.\n');
  assert.deepEqual(scanFileChanges(ctx), []);
});

test('rebase rejects a second user edit, partial reads, and deleted files without changing either version', async () => {
  const ctx = fixture(); await read(ctx); await edit(ctx, 'Original', 'Revised');
  fs.writeFileSync(disk(ctx), 'Human\nOriginal body.\n');
  const draft = await read(ctx); const project = await read(ctx, { view: 'project', limit: 1 });
  const input = { path: 'notes.txt', content: 'Human\nRevised body.\n', rebase: { projectHash: project.contentHash, draftHash: draft.contentHash } };
  assert.equal((await executeTool('write_file', input, ctx)).code, 'REBASE_STALE');
  await read(ctx, { view: 'project' }); fs.writeFileSync(disk(ctx), 'Human changed again\nOriginal body.\n');
  assert.equal((await executeTool('write_file', input, ctx)).code, 'REBASE_STALE');
  fs.unlinkSync(disk(ctx));
  assert.equal((await executeTool('write_file', input, ctx)).code, 'REBASE_STALE');
  assert.equal(ctx.changesetBuffer[0].after, 'Revised body.\n'); assert.equal(fs.existsSync(disk(ctx)), false);
});

test('window hashes do not confer unread edits or whole-file writes; paged coverage and chained edits work', async () => {
  const ctx = fixture('first\nsecond\nthird'); await read(ctx, { limit: 1 });
  assert.equal((await edit(ctx, 'third', 'THIRD')).code, 'READ_SCOPE_REQUIRED');
  assert.equal((await executeTool('write_file', { path: 'notes.txt', content: 'bad' }, ctx)).code, 'READ_SCOPE_REQUIRED');
  assert.equal((await edit(ctx, 'first', 'a much longer first')).changed, true);
  assert.equal((await edit(ctx, 'longer', 'longest')).changed, true);
  assert.equal((await edit(ctx, 'second', 'SECOND')).code, 'READ_SCOPE_REQUIRED');
  await read(ctx, { offset: 2 });
  assert.equal((await executeTool('write_file', { path: 'notes.txt', content: 'a much longest first\nSECOND\nthird' }, ctx)).changed, true);
});

test('Pi adapter shares actual read evidence and rollback restores read permissions and draft baselines', async () => {
  const ctx = fixture();
  let fail = false; ctx.checkpointDraft = () => { if (fail) throw new Error('checkpoint failed'); };
  const tools = getPiTools(ctx), run = (name, input) => tools.find(tool => tool.name === name).execute(name, input);
  await run('read_file', { path: 'notes.txt' }); assert.equal(ctx.readEvidence.get('notes.txt').content, 'Original body.\n');
  const before = structuredClone(ctx.fileReads); fail = true;
  await assert.rejects(run('edit_file', { path: 'notes.txt', search: 'Original', replace: 'Lost' }), /checkpoint failed/);
  assert.deepEqual(ctx.changesetBuffer, []); assert.deepEqual(ctx.fileReads, before);
  fail = false; assert.equal((await run('edit_file', { path: 'notes.txt', search: 'Original', replace: 'Saved' })).details.display.kind, 'edit');
});

test('only identical deterministic failures are stopped; changed bytes and corrected arguments can proceed', async () => {
  const ctx = fixture(); ctx.executionRecovery = recovery(); let blocked;
  ctx.onNoProgress = value => { blocked = value; };
  const tools = getPiTools(ctx), run = (name, input) => tools.find(tool => tool.name === name).execute(name, input);
  await run('read_file', { path: 'notes.txt' });
  const input = { path: 'notes.txt', search: 'Absent', replace: 'Present' };
  await assert.rejects(run('edit_file', input), /未找到/);
  await run('read_file', { path: 'notes.txt' });
  await assert.rejects(run('edit_file', input), /重复失败/); assert.equal(blocked.code, 'TOOL_NO_PROGRESS');
  fs.writeFileSync(disk(ctx), 'Absent body.\n'); await run('read_file', { path: 'notes.txt' });
  await run('edit_file', input); assert.equal(ctx.changesetBuffer[0].after, 'Present body.\n');
});

const chunk = value => 'data: ' + JSON.stringify({ choices: [{ index: 0, ...value }] }) + '\n\n';
const call = (name, input) => ({ name, input });
async function runScript(handler, content, { repairCycles, compile = false } = {}) {
  const ctx = fixture(content), payloads = [], events = [];
  db.prepare('UPDATE settings SET agent_config=? WHERE user_id=?').run(JSON.stringify({ collaborationTier: 'off', allowWebAccess: false, repairCycles }), user.id);
  if (compile) fs.writeFileSync(path.join(ctx.projectDir, 'main.tex'), '\\documentclass{article}\n\\begin{document}\nFAIL\n\\end{document}\n');
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', part => raw += part); req.on('end', () => {
      const payload = JSON.parse(raw); payloads.push(payload);
      let result;
      try { result = handler({ ctx, payload, turn: payloads.length }); }
      catch (error) { result = '测试服务失败：' + error.message; }
      if (payloads.length > 12) { res.writeHead(400).end('{"error":{"message":"test runaway"}}'); return; }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(typeof result === 'string' ? chunk({ delta: { content: result } }) + chunk({ delta: {}, finish_reason: 'stop' }) + 'data: [DONE]\n\n'
        : chunk({ delta: { tool_calls: [{ index: 0, id: 'c' + payloads.length, type: 'function', function: { name: result.name, arguments: JSON.stringify(result.input) } }] } }) +
          chunk({ delta: {}, finish_reason: 'tool_calls' }) + 'data: [DONE]\n\n');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await runAgent({ user, project: ctx.project, chat: db.prepare('SELECT * FROM chats WHERE id=?').get(ctx.chatId),
      messages: [{ role: 'user', content: compile ? '请修复 main.tex 的编译错误并验证。' : '请修改 notes.txt 的正文，保留用户的其他修改。' }],
      modelConfig: { provider: 'openai', model: 'freshness-mock', apiKey: 'synthetic', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, maxTokens: 2048, contextLength: 100000 },
      emit: event => events.push(event) });
    const row = db.prepare('SELECT * FROM chat_messages WHERE id=?').get(result.messageId);
    return { ctx, result, payloads, events, row, steps: JSON.parse(row.steps) };
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

test('single agent defers a response generated before the human edit and succeeds after rereading current text', async () => {
  const f = await runScript(({ ctx, turn }) => {
    if (turn === 1 || turn === 3) return call('read_file', { path: 'notes.txt' });
    if (turn === 2) { fs.writeFileSync(disk(ctx), 'Human body.\n'); return call('edit_file', { path: 'notes.txt', search: 'Original', replace: 'Revised' }); }
    if (turn === 4) return call('edit_file', { path: 'notes.txt', search: 'Human body.', replace: 'Human body, revised.' });
    return '正文调整完成，保留了用户的新内容。';
  });
  assert.equal(f.result.status, 'completed', f.row.content);
  assert.equal(fs.readFileSync(disk(f.ctx), 'utf8'), 'Human body, revised.\n');
  assert.ok(f.steps.some(step => step.name === 'edit_file' && step.status === 'error'));
  assert.ok(JSON.stringify(f.payloads[2]).includes('当前文件版本核对'));
  assert.equal(f.steps.filter(step => step.name === 'read_file').length, 2);
});

test('single agent cannot publish a stale answer if a file changes during model generation', async () => {
  const f = await runScript(({ ctx, turn }) => {
    if (turn === 1) return call('read_file', { path: 'notes.txt' });
    if (turn === 2) fs.writeFileSync(disk(ctx), 'Changed during answer.\n');
    return turn > 3 ? '文件已变化，本轮尚未完成核对；请基于最新文件继续。' : 'OLD_UNVERIFIED_FINAL';
  });
  assert.equal(f.result.status, 'failed');
  assert.doesNotMatch(f.row.content, /OLD_UNVERIFIED_FINAL/);
  assert.equal(fs.readFileSync(disk(f.ctx), 'utf8'), 'Changed during answer.\n');
});

test('single agent exposes both versions and safely rebases its draft after a concurrent human edit', async () => {
  let versions;
  const f = await runScript(({ ctx, payload, turn }) => {
    if (turn === 1 || turn === 3) {
      if (turn === 3) fs.writeFileSync(disk(ctx), 'Human heading.\nOriginal body.\n');
      return call('read_file', { path: 'notes.txt' });
    }
    if (turn === 2) return call('edit_file', { path: 'notes.txt', search: 'Original', replace: 'Revised' });
    if (turn === 4) return call('read_file', { path: 'notes.txt', view: 'project' });
    if (turn === 5) {
      const outputs = payload.messages.filter(message => message.role === 'tool').map(message => { try { return JSON.parse(message.content); } catch { return {}; } });
      const project = outputs.findLast(value => value.view === 'project'), draft = outputs.findLast(value => value.view === 'effective');
      versions = { projectHash: project.contentHash, draftHash: draft.contentHash };
      return call('write_file', { path: 'notes.txt', content: 'Human heading.\nRevised body.\n', rebase: versions });
    }
    return '正文已调整，保留了新标题。';
  });
  assert.ok(versions); assert.equal(f.result.status, 'completed', f.row.content);
  assert.equal(fs.readFileSync(disk(f.ctx), 'utf8'), 'Human heading.\nRevised body.\n');
});

test('unchanged deterministic edit failure ends with a truthful handoff instead of unbounded model turns', async () => {
  const f = await runScript(({ turn }) => turn === 1 ? call('read_file', { path: 'notes.txt' })
    : turn < 4 ? call('edit_file', { path: 'notes.txt', search: 'Never existed', replace: 'Anything' })
      : '目标片段不存在，本轮尚未修改；请确认目标文字后继续。');
  assert.equal(f.result.status, 'failed'); assert.equal(f.payloads.length, 4);
  assert.equal(fs.readFileSync(disk(f.ctx), 'utf8'), 'Original body.\n');
  assert.ok(f.events.some(event => event.code === 'TOOL_NO_PROGRESS'));
});

test('persistent draft conflict cannot bypass the no-progress guard by failing before the file tool', async () => {
  const f = await runScript(({ ctx, turn }) => {
    if (turn === 1) return call('read_file', { path: 'notes.txt' });
    if (turn === 2) return call('edit_file', { path: 'notes.txt', search: 'Original', replace: 'Revised' });
    if (turn === 3) fs.writeFileSync(disk(ctx), 'Human replacement.\n');
    if (turn < 6) return call('edit_file', { path: 'notes.txt', search: 'Revised', replace: 'Ignored user' });
    return '正式文件与草稿发生冲突，本轮尚未完成；请核对双方内容后继续。';
  });
  assert.equal(f.result.status, 'failed'); assert.equal(f.payloads.length, 6);
  assert.ok(f.events.some(event => event.code === 'TOOL_NO_PROGRESS'));
  assert.equal(fs.readFileSync(disk(f.ctx), 'utf8'), 'Human replacement.\n');
  assert.equal(f.steps.find(step => step.type === 'workflow').graph.accounting.toolRecovery.prevented, 1);
});

test('single-agent compiler feedback spends one mutation cycle and verifies the updated draft', async () => {
  const f = await runScript(({ turn }) => {
    if (turn === 1) return call('read_file', { path: 'main.tex' });
    if (turn === 2 || turn === 4) return call('compile_and_preview', { pages: '1' });
    if (turn === 3) return call('edit_file', { path: 'main.tex', search: 'FAIL', replace: 'Fixed' });
    return '编译问题已修复并通过验证。';
  }, undefined, { compile: true });
  assert.equal(f.result.status, 'completed', f.row.content);
  assert.equal(f.steps.find(step => step.type === 'workflow').graph.accounting.repair.used, 1);
  assert.match(fs.readFileSync(path.join(f.ctx.projectDir, 'main.tex'), 'utf8'), /Fixed/);
});

test('a saved zero limit no longer blocks automatic compile repairs beyond the old default', async () => {
  const f = await runScript(({ turn }) => {
    if (turn === 1) return call('read_file', { path: 'main.tex' });
    if (turn <= 10 && turn % 2 === 0) return call('compile_and_preview', {});
    if (turn < 10) {
      const cycle = (turn - 1) / 2;
      return call('edit_file', { path: 'main.tex', search: cycle === 1 ? 'FAIL' : `FAIL_${cycle - 1}`,
        replace: cycle === 4 ? 'Fixed' : `FAIL_${cycle}` });
    }
    return '编译问题已修复并通过验证。';
  }, undefined, { compile: true, repairCycles: 0 });
  assert.equal(f.result.status, 'completed', f.row.content);
  const repair = f.steps.find(step => step.type === 'workflow').graph.accounting.repair;
  assert.equal(repair.used, 4); assert.equal(repair.limit, null);
  assert.equal(f.steps.filter(step => step.name === 'compile_and_preview').length, 5);
  assert.match(fs.readFileSync(path.join(f.ctx.projectDir, 'main.tex'), 'utf8'), /Fixed/);
});

test('repeating a failed compile with identical inputs stops the loop without charging a repair cycle', async () => {
  const f = await runScript(({ turn }) => turn === 1 ? call('read_file', { path: 'main.tex' })
    : turn < 4 ? call('compile_and_preview', {}) : '编译错误仍然存在，重复验证无法修复；请根据诊断调整后继续。', undefined, { compile: true });
  assert.equal(f.result.status, 'failed'); assert.equal(f.payloads.length, 4);
  assert.ok(f.events.some(event => event.code === 'COMPILE_NO_PROGRESS'));
  assert.equal(f.steps.find(step => step.type === 'workflow').graph.accounting.repair.used, 0);
});
