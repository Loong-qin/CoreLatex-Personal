import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'corelatex-evidence-integration-'));
process.env.CORELATEX_DATA_DIR = dataDir;
const originalPath = process.env.PATH;
const compileLog = path.join(dataDir, 'compiles');
let dbModule, db, runAgent, contextModelKey, llm, owner, mode, requests, wires;
const originalReview = 'The paper should state its main contribution, explain the novelty over prior ranking methods, and clarify the role of LADDER in the manuscript.';
const reviewQuestion = '这一条评审基本就是改完了？';
const currentManuscript = '\\section{Introduction}\n' +
  'The contribution is an independent calibration stage that prior ranking methods omit.\n' +
  'LADDER serves as the screening baseline.\n' +
  '\\deleted{LADDER itself is the main contribution.}\n';
const statusAnswer = '已落实。引言明确把独立校准阶段列为本文贡献，指出既有排序方法缺少该阶段，并将 LADDER 定位为筛选基线。';
const manuscriptStateAnswer = '从当前 main.tex 可见，稿件已修改贡献表述，现稿已将 LADDER 调整为筛选基线。';
const historicalStateAnswer = '上一轮已修改 main.tex。当前正文仍保留独立校准阶段与 LADDER 基线的区分。';
const sse = delta => 'data: ' + JSON.stringify({ choices: [{ index: 0, delta }] }) + '\n\n';
function text(res, value) {
  // Every character is a separate provider delta, including completion verbs.
  for (const part of value) res.write(sse({ content: part }));
  res.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
}
function tool(res, name, args) {
  res.end(sse({ tool_calls: [{ index: 0, id: 'call_' + requests, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }) +
    'data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }) + '\n\ndata: [DONE]\n\n');
}
before(async () => {
  const bin = path.join(dataDir, 'bin');
  fs.mkdirSync(bin);
  process.env.PATH = [bin, path.dirname(process.execPath), originalPath].join(path.delimiter);
  const binary = (name, body) => fs.writeFileSync(path.join(bin, name), '#!/usr/bin/env node\n' + body, { mode: 0o755 });
  binary('pdflatex', String.raw`
const fs=require('node:fs'),path=require('node:path');
const dir=process.argv.find(arg=>arg.startsWith('-output-directory=')).slice('-output-directory='.length);
fs.appendFileSync(${JSON.stringify(compileLog)},fs.readFileSync(process.argv.at(-1),'utf8')+'\n');
fs.writeFileSync(path.join(dir,'main.pdf'),'%PDF test');
fs.writeFileSync(path.join(dir,'main.log'),'Output written on main.pdf');`);
  binary('pdfinfo', "console.log('Pages: 1')");
  binary('pdftoppm', "require('node:fs').writeFileSync(process.argv.at(-1)+'-1.jpg','mock image')");
  dbModule = await import('../src/db.js'); db = dbModule.getDb(); ({ runAgent } = await import('../src/services/agent/agentLoop.js'));
  ({ contextModelKey } = await import('../src/services/agent/context.js'));
  const id = Number(db.prepare("INSERT INTO users(username,password_hash,role) VALUES('evidence-owner','unused','admin')").run().lastInsertRowid);
  owner = db.prepare('SELECT * FROM users WHERE id=?').get(id); db.prepare('INSERT INTO settings(user_id) VALUES(?)').run(id);
  llm = http.createServer((req,res) => {
    let raw=''; req.setEncoding('utf8'); req.on('data',c=>raw+=c); req.on('end',()=>{
      requests++; const body=JSON.parse(raw); wires.push(body); const messages=body.messages||[];
      const calls=messages.filter(m=>m.role==='assistant').flatMap(m=>m.tool_calls||[]);
      const n=name=>calls.filter(c=>c.function.name===name).length;
      const corrected=messages.some(m=>m.role==='user' && typeof m.content==='string' && m.content.startsWith('【系统核对】'));
      res.writeHead(200,{'Content-Type':'text/event-stream'});
      if (mode.startsWith('source-follow-up')) {
        const read = file => calls.some(call => call.function.name === 'read_file' && JSON.parse(call.function.arguments).path === file);
        if (!read('main.tex')) return tool(res, 'read_file', { path: 'main.tex' });
        if (!n('edit_file')) return tool(res, 'edit_file', { path: 'main.tex', search: 'Original text.', replace: 'Revised text.' });
        if (!n('copy_to_project')) return tool(res, 'copy_to_project', { workspacePath: 'plot.pdf', targetPath: 'plot.pdf' });
        if (!n('compile_and_preview')) return tool(res, 'compile_and_preview', { pages: '1' });
        if (!read('empty.txt')) return tool(res, 'read_file', { path: 'empty.txt', purpose: 'source' });
        const prompted = messages.some(message => message.role === 'user' && typeof message.content === 'string' &&
          message.content.includes('来源核查尚未完成'));
        if (!prompted) return text(res, '本轮已经修改稿件并验证。');
        if (!read('source.txt')) return tool(res, 'read_file', { path: 'source.txt', purpose: 'source' });
        return text(res, '本轮只完成来源核查，没有新增正文或图文件修改。原文说明横轴单位为毫米。本次补查没有再次修改正文。');
      }
      if (mode.startsWith('review-')) {
        if (mode === 'review-with-edit') {
          if (!n('read_file')) return tool(res, 'read_file', { path: 'notes.txt' });
          if (!n('edit_file')) return tool(res, 'edit_file', { path: 'notes.txt', search: 'Original text.', replace: 'Actual edit.' });
          return text(res, '已修改 notes.txt。');
        }
        if (!n('read_file')) return tool(res, 'read_file', { path: 'main.tex' });
        if (mode === 'review-attempt-edit' && !n('edit_file')) {
          return tool(res, 'edit_file', { path: 'main.tex', search: 'independent calibration stage', replace: 'unrequested addition' });
        }
        if (mode === 'review-fake-operations' && !corrected) return text(res, '我已修改 main.tex。编译通过。');
        if (mode === 'review-current-state' && !corrected) return text(res, manuscriptStateAnswer);
        if (mode === 'review-historical-state' && !corrected) return text(res, historicalStateAnswer);
        return text(res, statusAnswer);
      }
      if (mode==='fake-then-noop') {
        if (!corrected) return text(res,'已完成编辑，请审核。notes.txt 已修改。');
        if (!n('read_file')) return tool(res,'read_file',{path:'notes.txt'});
        if (!n('edit_file')) return tool(res,'edit_file',{path:'notes.txt',search:'Original text.',replace:'Original text.'});
        return text(res,'已完成编辑，请审核。notes.txt 已修改。');
      }
      if (mode==='fake-progress' || mode==='fake-question') {
        const name=mode==='fake-progress'?'report_progress':'ask_user';
        if (!n(name)) return tool(res,name,name==='report_progress'?{summary:'已完成编辑，请审核。'}:{question:'notes.txt 已修改，请审核本次修改。',options:['确认']});
        return text(res,'本轮尚未执行修改。');
      }
      if (!n('read_file')) return tool(res,'read_file',{path: mode==='failed-read'?'missing.tex':'notes.txt'});
      if (corrected) return text(res,mode==='partial'?'已完成编辑，请审核。notes.txt 已修改。':'本轮未产生项目修改。');
      if (mode==='read-fake-other') return text(res,'已读取 untouched.tex。');
      if (mode==='failed-read') return text(res,'已读取 missing.tex。');
      if (mode==='fake-compile') return text(res,'编译通过。');
      if (!n('edit_file')) return tool(res,'edit_file',{path:'notes.txt',search:'Original text.',replace:mode==='noop'?'Original text.':'Actual edit.'});
      if (mode==='reverted' && n('edit_file')===1) return tool(res,'edit_file',{path:'notes.txt',search:'Actual edit.',replace:'Original text.'});
      if (mode==='partial') return text(res,'已修改 notes.txt、untouched.tex，请审核。');
      return text(res,'已完成编辑，请审核。notes.txt 已修改。');
    });
  });
  await new Promise(resolve=>llm.listen(0,'127.0.0.1',resolve));
});
after(async()=>{ llm?.closeAllConnections(); await new Promise(resolve=>llm.close(resolve)); dbModule.resetDb(); process.env.PATH = originalPath; assert.ok(dataDir.startsWith(path.join(os.tmpdir(),'corelatex-evidence-integration-'))); fs.rmSync(dataDir,{recursive:true,force:true}); });
function fixture() {
  const id=Number(db.prepare('INSERT INTO projects(name,owner_id,public_id) VALUES(?,?,?)').run('Evidence fixture',owner.id,randomUUID()).lastInsertRowid);
  const dir=path.join(dataDir,'projects',String(id)); fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'notes.txt'),'Original text.\n'); fs.writeFileSync(path.join(dir,'untouched.tex'),'Human-owned original.\n');
  const cid=Number(db.prepare('INSERT INTO chats(project_id,user_id) VALUES(?,?)').run(id,owner.id).lastInsertRowid);
  return {project:db.prepare('SELECT * FROM projects WHERE id=?').get(id),chat:db.prepare('SELECT * FROM chats WHERE id=?').get(cid),dir};
}
async function run(scenario, control) {
  mode=scenario; requests=0; wires=[]; const f=fixture(),events=[];
  const followUp = scenario.startsWith('source-follow-up');
  const savedConfig = followUp ? db.prepare('SELECT agent_config FROM settings WHERE user_id=?').get(owner.id).agent_config : null;
  if (followUp) {
    fs.writeFileSync(path.join(f.dir, 'main.tex'), 'Original text.\n');
    fs.writeFileSync(path.join(f.dir, 'empty.txt'), '');
    fs.writeFileSync(path.join(f.dir, 'source.txt'), 'The axis is measured in millimetres.\n');
    fs.mkdirSync(path.join(f.dir, '_workspace'));
    fs.writeFileSync(path.join(f.dir, '_workspace/plot.pdf'), '%PDF figure');
    fs.writeFileSync(compileLog, '');
    db.prepare('UPDATE settings SET agent_config=? WHERE user_id=?')
      .run(JSON.stringify({ confirmBeforeApply: scenario === 'source-follow-up-staged' }), owner.id);
  }
  let result;
  try {
    result=await runAgent({user:owner,project:f.project,chat:f.chat,messages:[{role:'user',content:'请修改文稿。'}],
      modelConfig:{provider:'openai',model:'evidence-mock',apiKey:'synthetic',baseUrl:'http://127.0.0.1:'+llm.address().port+'/v1',maxTokens:1024,contextLength:100000},
      emit:e=>events.push(e),runControl:control});
  } finally {
    if (followUp) db.prepare('UPDATE settings SET agent_config=? WHERE user_id=?').run(savedConfig, owner.id);
  }
  const row=db.prepare('SELECT * FROM chat_messages WHERE id=?').get(result.messageId);
  return {...f,result,events,row,steps:JSON.parse(row.steps)};
}
const noReview=f=>{ assert.equal(f.result.changeset,null); assert.equal(f.events.some(e=>e.type==='changeset'),false); assert.equal(db.prepare('SELECT COUNT(*) n FROM changesets WHERE project_id=?').get(f.project.id).n,0); };

function reviewFixture() {
  const f = fixture();
  const modelConfig = { provider: 'openai', model: 'evidence-mock', apiKey: 'synthetic',
    baseUrl: 'http://127.0.0.1:' + llm.address().port + '/v1', maxTokens: 1024, contextLength: 100000 };
  db.prepare('UPDATE chats SET context_model_key=? WHERE id=?').run(contextModelKey(modelConfig), f.chat.id);
  fs.writeFileSync(path.join(f.dir, 'main.tex'), currentManuscript);
  return { ...f, modelConfig };
}

async function runReview(f, scenario, question) {
  mode = scenario; requests = 0; wires = [];
  db.prepare("INSERT INTO chat_messages(chat_id,role,content) VALUES (?,'user',?)").run(f.chat.id, question);
  const messages = db.prepare('SELECT * FROM chat_messages WHERE chat_id=? ORDER BY id').all(f.chat.id);
  const events = [];
  const result = await runAgent({ user: owner, ...f, messages, emit: event => events.push(event) });
  const row = db.prepare('SELECT * FROM chat_messages WHERE id=?').get(result.messageId);
  return { ...f, result, events, row, steps: JSON.parse(row.steps), calls: wires };
}
test('split hallucinated completion never reaches streamed or saved text; one repair with no-op cannot submit',async()=>{
  const f=await run('fake-then-noop'); noReview(f); assert.equal(requests,4); assert.equal(f.result.status,'failed');
  assert.doesNotMatch(f.row.content,/已完成编辑，请审核|notes\.txt 已修改/);
  assert.doesNotMatch(f.events.filter(e=>e.type==='token').map(e=>e.text).join(''),/已完成编辑|notes\.txt 已修改/);
  assert.match(f.row.content,/没有可提交的有效修改/); assert.equal(fs.readFileSync(path.join(f.dir,'notes.txt'),'utf8'),'Original text.\n');
  assert.equal(f.events.filter(e=>e.type==='activity'&&e.phase==='verification').length,1);
  const edits=f.steps.filter(s=>s.type==='tool'&&s.name==='edit_file'); assert.equal(JSON.parse(edits[0].result).changed,false);
});
for (const scenario of ['noop','reverted']) test(scenario+' edits leave no net diff or review entry',async()=>{
  const f=await run(scenario); noReview(f); assert.equal(f.result.status,'completed'); assert.match(f.row.content,/本轮未产生项目修改/);
  assert.doesNotMatch(f.row.content,/已完成编辑，请审核/); assert.equal(fs.readFileSync(path.join(f.dir,'notes.txt'),'utf8'),'Original text.\n');
});
test('one real edit does not authorize claiming a second untouched file was edited',async()=>{
  const f=await run('partial'); assert.equal(f.result.status,'completed'); assert.ok(f.result.changeset);
  assert.deepEqual(f.result.changeset.files.map(v=>v.filePath),['notes.txt']); assert.doesNotMatch(f.row.content,/已修改 notes\.txt、untouched\.tex/);
  assert.equal(fs.readFileSync(path.join(f.dir,'untouched.tex'),'utf8'),'Human-owned original.\n');
});
for (const scenario of ['read-fake-other','failed-read','fake-compile']) test(scenario+' requires its own successful execution evidence',async()=>{
  const f=await run(scenario); noReview(f); assert.equal(requests,3); assert.equal(f.result.status,'completed');
  assert.doesNotMatch(f.row.content,/已读取 untouched|已读取 missing|编译通过/);
  if (scenario==='failed-read') {
    const step=f.steps.find(s=>s.type==='tool'); assert.equal(step.status,'error'); assert.equal(step.display.summary,'执行失败');
    assert.match(step.display.notice,/文件不存在/);
    assert.deepEqual(f.events.find(e=>e.type==='tool'&&e.status==='error').display,step.display);
  }
});
for (const scenario of ['fake-progress','fake-question']) test(scenario+' cannot bypass publication validation',async()=>{
  let questions=0; const f=await run(scenario,{askUser:async()=>{questions++;return 'yes';}});
  noReview(f); assert.equal(questions,0); assert.equal(requests,2);
  assert.equal(f.events.some(e=>e.type==='activity'&&e.source==='model'&&e.text.includes('已完成编辑')),false);
  assert.equal(f.steps.find(s=>s.type==='tool').status,'error');
});
test('genuine read/edit completion still applies the exact proposal without extra verification API requests',async()=>{
  const f=await run('real'); assert.equal(requests,3); assert.equal(f.result.status,'completed'); assert.ok(f.result.changeset);
  assert.equal(fs.readFileSync(path.join(f.dir,'notes.txt'),'utf8'),'Actual edit.\n'); assert.match(f.row.content,/已完成编辑，请审核/);
  assert.equal(f.events.some(e=>e.type==='activity'&&e.phase==='verification'),false);
  const persistedCalls=JSON.parse(f.row.tool_calls);
  for (const step of f.steps.filter(s=>s.type==='tool')) {
    const event=f.events.find(e=>e.type==='tool'&&e.toolCallId===step.toolCallId&&e.status==='end');
    assert.deepEqual(event.display,step.display);
    assert.deepEqual(persistedCalls.find(c=>c.name===step.name).display,step.display);
  }
  assert.ok(f.events.filter(e=>e.type==='tool'&&e.status==='start').every(e=>e.display.summary==='正在执行'));
  assert.equal(JSON.stringify(wires).includes('\"version\":1,\"kind\"'),false,'presentation metadata is not included in model requests');
});

for (const scenario of ['source-follow-up-applied', 'source-follow-up-staged']) {
  test('the final answer retains same-run edit and compile evidence after source follow-up: ' + scenario, async () => {
    const f = await run(scenario);
    assert.equal(f.result.status, 'completed');
    assert.equal(requests, 8, 'the source follow-up does not add a model request for rewriting the answer');
    assert.deepEqual(f.result.changeset.files.map(file => file.filePath).sort(), ['main.tex', 'plot.pdf']);
    const staged = scenario.endsWith('-staged');
    assert.equal(f.result.changeset.applied, !staged);
    assert.equal(fs.readFileSync(path.join(f.dir, 'main.tex'), 'utf8'), staged ? 'Original text.\n' : 'Revised text.\n');
    assert.equal(fs.readFileSync(compileLog, 'utf8').trim(), 'Revised text.');
    const guard = wires.flatMap(wire => wire.messages).find(message => message.role === 'user' &&
      typeof message.content === 'string' && message.content.startsWith('【标准工作流程】来源核查尚未完成'));
    assert.match(guard.content, /同一轮.*改动、编译与补查结果/s);
    assert.match(guard.content, /\["main\.tex","plot\.pdf"\].*已通过编译验证/s);
    const streamed = f.events.filter(event => event.type === 'token').map(event => event.text).join('');
    for (const rendered of [f.row.content, streamed]) {
      assert.match(rendered, staged ? /2 个项目文件.*待审草稿。暂存版本已通过编译/ : /2 个项目文件.*已写入项目。当前版本已通过编译/);
      assert.doesNotMatch(rendered, /本轮只完成来源核查|没有新增正文或图文件修改/);
      assert.match(rendered, /原文说明横轴单位为毫米。本次补查没有再次修改正文/);
      assert.match(rendered, /来源正文也已补查/);
    }
    assert.equal(f.steps.some(step => step.code === 'EXECUTION_CLAIM_UNSUPPORTED'), false);
  });
}

test('a review status follow-up answers first from the original request and current manuscript without edits', async () => {
  const f = reviewFixture();
  for (const question of [originalReview + '\n\n' + reviewQuestion, reviewQuestion]) {
    const result = await runReview(f, 'review-status', question);
    noReview(result);
    assert.equal(result.result.status, 'completed');
    assert.equal(result.row.content, statusAnswer);
    assert.equal(result.calls.length, 2);
    assert.deepEqual(result.steps.filter(step => step.type === 'tool').map(step => [step.name, step.status]), [['read_file', 'end']]);
    const initialPrompt = JSON.stringify(result.calls[0].messages);
    assert.ok(initialPrompt.includes(originalReview));
    assert.match(initialPrompt, /核对审稿意见是否落实.*逐项对照.*保留并生效/u);
    assert.match(initialPrompt, /初始问题仅核对审稿意见是否落实/u);
    const readResult = result.calls[1].messages.find(message => message.role === 'tool');
    assert.match(readResult.content, /independent calibration stage that prior ranking methods omit/);
    assert.match(readResult.content, /LADDER serves as the screening baseline/);
  }
  assert.equal(fs.readFileSync(path.join(f.dir, 'main.tex'), 'utf8'), currentManuscript);
});

test('a standalone review status question cannot perform an opportunistic edit', async () => {
  const f = reviewFixture();
  const result = await runReview(f, 'review-attempt-edit', originalReview + '\n\n' + reviewQuestion);
  noReview(result);
  assert.equal(result.result.status, 'completed');
  assert.equal(result.row.content, statusAnswer);
  const attempt = result.steps.find(step => step.type === 'tool' && step.name === 'edit_file');
  assert.equal(attempt.status, 'error');
  assert.match(attempt.result, /用户只询问审稿意见的落实状态/);
  assert.equal(fs.readFileSync(path.join(f.dir, 'main.tex'), 'utf8'), currentManuscript);
});

for (const question of [originalReview + '\n\n' + reviewQuestion, '这条意见针对本文贡献还是 LADDER 基线？']) {
  test('observed manuscript state is delivered unchanged without a correction request: ' + question.slice(-30), async () => {
    const result = await runReview(reviewFixture(), 'review-current-state', question);
    noReview(result);
    assert.equal(result.result.status, 'completed');
    assert.equal(result.row.content, manuscriptStateAnswer);
    assert.equal(result.calls.length, 2, 'one read request and one answer; no regeneration');
    assert.deepEqual(result.steps.filter(step => step.type === 'tool').map(step => [step.name, step.status]), [['read_file', 'end']]);
    assert.equal(result.events.some(event => event.type === 'activity' && event.phase === 'verification'), false);
    assert.equal(result.events.some(event => event.type === 'status' && /核对|拦截/.test(event.text)), false);
    assert.equal(fs.readFileSync(path.join(result.dir, 'main.tex'), 'utf8'), currentManuscript);
  });
}

test('historical edits do not require manufacturing a new edit or rereading the manuscript', async () => {
  const result = await runReview(reviewFixture(), 'review-historical-state', originalReview + '\n\n' + reviewQuestion);
  noReview(result);
  assert.equal(result.result.status, 'completed');
  assert.equal(result.row.content, historicalStateAnswer);
  assert.equal(result.calls.length, 2);
  assert.equal(result.events.some(event => event.type === 'activity' && event.phase === 'verification'), false);
});

test('current source inspection cannot validate false edit or compile claims in a status answer', async () => {
  const result = await runReview(reviewFixture(), 'review-fake-operations', originalReview + '\n\n' + reviewQuestion);
  noReview(result);
  assert.equal(result.result.status, 'completed');
  assert.equal(result.row.content, statusAnswer);
  assert.equal(result.calls.length, 3);
  const streamed = result.events.filter(event => event.type === 'token').map(event => event.text).join('');
  assert.match(streamed, /^已落实/);
  assert.doesNotMatch(streamed, /已修改|编译通过/);
  const correction = result.calls[2].messages.find(message => typeof message.content === 'string' && message.content.startsWith('【系统核对】'));
  assert.match(correction.content, /edit: main\.tex、compile/);
  assert.match(correction.content, /用户只问状态时，根据原始要求和本轮查阅的当前正文给出明确判断/);
  assert.match(correction.content, /复用已经成功读取的内容/);
  assert.match(correction.content, /我已修改 main\.tex/);
  const diagnostic = result.steps.find(step => step.code === 'EXECUTION_CLAIM_UNSUPPORTED');
  assert.ok(diagnostic, 'future misclassification can be traced to the actual bounded claim');
  assert.deepEqual(diagnostic.issues.map(issue => issue.kind), ['edit', 'compile']);
  assert.equal(diagnostic.issues[0].sentence, '我已修改 main.tex');
  assert.deepEqual(diagnostic.evidence.changedPaths, []);
  assert.deepEqual(diagnostic.evidence.readPaths, ['main.tex']);
  assert.equal(diagnostic.evidence.compileSucceeded, false);
});

test('a status question with an explicit extra edit follows the normal write workflow', async () => {
  const result = await runReview(reviewFixture(), 'review-with-edit',
    originalReview + '\n\n' + reviewQuestion + '\n顺便把 notes.txt 中的 Original text. 改为 Actual edit.');
  assert.equal(result.result.status, 'completed');
  assert.ok(result.result.changeset);
  assert.match(result.row.content, /已修改 notes\.txt/);
  assert.equal(fs.readFileSync(path.join(result.dir, 'notes.txt'), 'utf8'), 'Actual edit.\n');
});
