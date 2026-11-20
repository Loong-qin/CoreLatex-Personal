import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'corelatex-tool-safety-'));
process.env.CORELATEX_DATA_DIR = temp;
let db, resetDb, executeTool, getPiTools, changes, runProcess, compressHistoryIfNeeded;
let serial = 0;
before(async () => {
  const database = await import('../src/db.js');
  db = database.getDb(); resetDb = database.resetDb;
  ({ executeTool, getPiTools } = await import('../src/services/agent/tools.js'));
  changes = await import('../src/services/agent/changesets.js');
  ({ runProcess } = await import('../src/services/process.js'));
  ({ compressHistoryIfNeeded } = await import('../src/services/agent/context.js'));
});
after(() => { resetDb(); fs.rmSync(temp, { recursive: true, force: true }); });

function fixture(content = 'A\n') {
  const userId = Number(db.prepare("INSERT INTO users(username,password_hash,role) VALUES (?,'unused','admin')").run('safety-' + (++serial)).lastInsertRowid);
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
  const projectId = Number(db.prepare('INSERT INTO projects(name,owner_id,public_id) VALUES (?,?,?)').run('safety',userId,'safety-' + serial).lastInsertRowid);
  const project = db.prepare('SELECT * FROM projects WHERE id=?').get(projectId);
  const projectDir = path.join(temp,'projects',String(projectId));
  const workspaceDir = path.join(projectDir,'_workspace');
  fs.mkdirSync(workspaceDir,{recursive:true});
  fs.writeFileSync(path.join(projectDir,'main.tex'),content);
  return { user, project, projectDir, workspaceDir, changesetBuffer: [], reads: new Map(), agentConfig: {} };
}

test('write and copy chains compare staged content while preserving the original conflict baseline', async () => {
  const ctx = fixture();
  assert.equal(await executeTool('read_file',{path:'main.tex'},ctx),'A\n');
  assert.equal((await executeTool('write_file',{path:'main.tex',content:'B\n'},ctx)).error,undefined);
  assert.equal((await executeTool('write_file',{path:'main.tex',content:'C\n'},ctx)).error,undefined);
  fs.writeFileSync(path.join(ctx.workspaceDir,'copy.tex'),'D\n');
  assert.equal((await executeTool('copy_to_project',{workspacePath:'copy.tex',targetPath:'main.tex'},ctx)).error,undefined);
  assert.deepEqual(ctx.changesetBuffer[0],{path:'main.tex',before:'A\n',after:'D\n',encoding:'utf8'});
  fs.writeFileSync(path.join(ctx.projectDir,'main.tex'),'human\n');
  const cs=changes.createChangeset({projectId:ctx.project.id,files:ctx.changesetBuffer});
  assert.deepEqual(changes.applyChangeset(cs.id),{applied:0,skipped:['main.tex']});
  assert.equal(fs.readFileSync(path.join(ctx.projectDir,'main.tex'),'utf8'),'human\n');
});

test('binary copies stay staged, support acceptance and conflict-safe rollback without text baselines', async () => {
  const ctx=fixture();
  const before=Buffer.from([0,255,1,2]), after=Buffer.from([0,254,3,4,5]);
  fs.writeFileSync(path.join(ctx.projectDir,'figure.png'),before);
  fs.writeFileSync(path.join(ctx.workspaceDir,'figure.png'),after);
  const result=await executeTool('copy_to_project',{workspacePath:'figure.png',targetPath:'figure.png'},ctx);
  assert.equal(result.error,undefined);
  assert.deepEqual(fs.readFileSync(path.join(ctx.projectDir,'figure.png')),before);
  const first=changes.createChangeset({projectId:ctx.project.id,files:ctx.changesetBuffer});
  assert.equal(changes.getChangeset(first.id).files[0].binary,true);
  assert.deepEqual(changes.getFileDiff(first.id,'figure.png'),{proposalRevision:0,binary:true,before:null,after:null,patch:'',beforeBytes:4,afterBytes:5});
  changes.acceptChangeset(first.id);
  assert.deepEqual(fs.readFileSync(path.join(ctx.projectDir,'figure.png')),after);
  assert.equal(changes.getReviewBase(ctx.project.id,'figure.png'),null);
  const second=changes.createChangeset({projectId:ctx.project.id,files:[{path:'figure.png',before:after.toString('base64'),after:before.toString('base64'),encoding:'base64'}]});
  changes.applyChangeset(second.id);
  changes.revertChangeset(second.id);
  assert.deepEqual(fs.readFileSync(path.join(ctx.projectDir,'figure.png')),after);
  const third=changes.createChangeset({projectId:ctx.project.id,files:[{path:'figure.png',before:after.toString('base64'),after:before.toString('base64'),encoding:'base64'}]});
  changes.applyChangeset(third.id);
  fs.writeFileSync(path.join(ctx.projectDir,'figure.png'),Buffer.from([22]));
  assert.throws(()=>changes.revertChangeset(third.id),error=>error.status===409);
});

test('confirm mode blocks arbitrary workspace and skill scripts before they can write', async () => {
  const ctx=fixture();
  ctx.agentConfig.confirmBeforeApply=true;
  const result=await executeTool('run_in_workspace',{command:'printf bypass > ../bypass.tex'},ctx);
  assert.match(result.error,/确认/);
  assert.match((await executeTool('run_skill_script',{skill:'anything',script:'anything.py'},ctx)).error,/确认/);
  assert.equal(fs.existsSync(path.join(ctx.projectDir,'bypass.tex')),false);
});

test('already aborted tool calls cannot write or start a process', async () => {
  const ctx=fixture();
  const ac=new AbortController(); ac.abort();
  const tool=getPiTools(ctx).find(t=>t.name==='write_file');
  await assert.rejects(tool.execute('test',{path:'new.tex',content:'unwanted'},ac.signal),{name:'AbortError'});
  assert.equal(ctx.changesetBuffer.length,0);
  await assert.rejects(async()=>runProcess('bash',['-c','touch should-not-exist'],{cwd:ctx.workspaceDir,signal:ac.signal}),{name:'AbortError'});
  assert.equal(fs.existsSync(path.join(ctx.workspaceDir,'should-not-exist')),false);
});

test('cancelling a Pi shell tool terminates child processes before delayed writes', async () => {
  const ctx=fixture(); const ac=new AbortController();
  const tool=getPiTools(ctx).find(t=>t.name==='run_in_workspace');
  const pending=tool.execute('test',{command:'( sleep 0.4; printf escaped > escaped.txt ) & printf ready > ready.txt; wait'},ac.signal);
  const deadline=Date.now()+2000;
  while(!fs.existsSync(path.join(ctx.workspaceDir,'ready.txt'))) {
    assert.ok(Date.now()<deadline);
    await new Promise(r=>setTimeout(r,5));
  }
  ac.abort();
  await assert.rejects(pending,{name:'AbortError'});
  await new Promise(r=>setTimeout(r,500));
  assert.equal(fs.existsSync(path.join(ctx.workspaceDir,'escaped.txt')),false);
});

test('subprocess output is bounded during capture, and nonzero shell exit is a tool error', async () => {
  const ctx=fixture();
  const result=await runProcess(process.execPath,['-e',"process.stdout.write('x'.repeat(1000000)); process.stderr.write('y'.repeat(1000000))"],{maxOutputBytes:128});
  assert.equal(result.stdout.length,128); assert.equal(result.stderr.length,128); assert.equal(result.outputTruncated,true);
  assert.match((await executeTool('run_in_workspace',{command:'exit 7'},ctx)).error,/7/);
});

async function summaryServer(handler, operation) {
  const server=http.createServer(handler);
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try { return await operation('http://127.0.0.1:'+server.address().port+'/v1'); }
  finally { server.closeAllConnections(); await new Promise(r=>server.close(r)); }
}
const messages=Array.from({length:12},(_,i)=>({id:i+1,role:i%2?'assistant':'user',content:String(i)+'x'.repeat(10000)}));
function compactArgs(baseUrl,signal) {
  const calls=[];
  return { calls, args:{db:{prepare:()=>({run:(...a)=>calls.push(a)})},chat:{id:1,summary:'prior',summary_msg_id:0},messages,
    modelConfig:{provider:'openai',model:'gpt-mock',apiKey:'test',baseUrl,contextLength:1024},maxTokens:128,signal} };
}

test('summary transport failure leaves prior summary and cutoff unchanged', async () => {
  await summaryServer((_req,res)=>{res.writeHead(400,{'Content-Type':'application/json'});res.end('{"error":{"message":"synthetic failure"}}');},async base=>{
    const {calls,args}=compactArgs(base);
    await assert.rejects(compressHistoryIfNeeded(args),/历史记录未省略/);
    assert.equal(calls.length,0);
  });
});
test('cancelling an in-flight summary never advances its cutoff', async () => {
  const ac=new AbortController();
  await summaryServer((req,_res)=>{req.resume();req.on('end',()=>ac.abort());},async base=>{
    const {calls,args}=compactArgs(base,ac.signal);
    await assert.rejects(compressHistoryIfNeeded(args),{name:'AbortError'});
    assert.equal(calls.length,0);
  });
});

test('compaction does not cut across replayed run messages with nonmonotonic IDs', async () => {
  await summaryServer((req,res)=>{
    req.resume();
    req.on('end',()=>{
      res.writeHead(200,{'Content-Type':'text/event-stream'});
      const frame=(data)=>'data: '+JSON.stringify(data)+'\n\n';
      res.end(frame({choices:[{index:0,delta:{role:'assistant',content:'Preserved summary'}}]})+
        frame({choices:[{index:0,delta:{},finish_reason:'stop'}]})+'data: [DONE]\n\n');
    });
  },async base=>{
    const {calls,args}=compactArgs(base);
    args.messages=messages.map((row,i)=>({...row,id:i<2?i+1:i===2?12:i}));
    const result=await compressHistoryIfNeeded(args);
    assert.equal(result.compressed,true);
    assert.equal(calls.length,1);
    const cutoff=calls[0][1];
    assert.equal(cutoff,2);
    assert.ok(result.messages.every(row=>row.id>cutoff));
    assert.ok(result.messages.some(row=>row.id===12));
    assert.ok(result.messages.some(row=>row.id===3));
  });
});
test('already cancelled MCP and web operations reject before discovery or networking', async () => {
  const {callMcpTool,getMcpTools}=await import('../src/services/agent/mcp.js');
  const {fetchPageText,webSearch}=await import('../src/services/webService.js');
  const ac=new AbortController();ac.abort();
  await assert.rejects(callMcpTool(0,'missing','missing',{}, {signal:ac.signal}),{name:'AbortError'});
  await assert.rejects(getMcpTools(0,{signal:ac.signal}),{name:'AbortError'});
  await assert.rejects(fetchPageText('https://example.com',{signal:ac.signal}),{name:'AbortError'});
  await assert.rejects(webSearch('test',{signal:ac.signal}),{name:'AbortError'});
});

test('web tool cancellation reaches the request rather than only hiding its result', async () => {
  const ctx=fixture(), ac=new AbortController();
  const oldFetch=globalThis.fetch;
  let requestSignal;
  globalThis.fetch=async (_url,options)=>new Promise((_resolve,reject)=>{
    requestSignal=options.signal;
    requestSignal.addEventListener('abort',()=>reject(requestSignal.reason),{once:true});
    queueMicrotask(()=>ac.abort());
  });
  try {
    const tool=getPiTools(ctx).find(t=>t.name==='web_fetch');
    await assert.rejects(tool.execute('test',{url:'https://8.8.8.8/synthetic'},ac.signal),{name:'AbortError'});
    assert.equal(requestSignal.aborted,true);
  } finally { globalThis.fetch=oldFetch; }
});
test('background descendants do not survive a completed subprocess tool', async () => {
  const ctx=fixture();
  const result=await runProcess('bash',['-c','( sleep 0.3; printf escaped > escaped.txt ) > /dev/null 2>&1 &'],{cwd:ctx.workspaceDir});
  assert.equal(result.exitCode,0);
  await new Promise(r=>setTimeout(r,400));
  assert.equal(fs.existsSync(path.join(ctx.workspaceDir,'escaped.txt')),false);
});


test('same-content text writes, identical replacements and byte-identical copies leave no project proposal', async () => {
  const ctx = fixture('human heading\noriginal body\n');
  await executeTool('read_file', { path: 'main.tex' }, ctx);
  const write = await executeTool('write_file', { path: 'main.tex', content: 'human heading\noriginal body\n' }, ctx);
  const edit = await executeTool('edit_file', { path: 'main.tex', search: 'original body', replace: 'original body' }, ctx);
  fs.writeFileSync(path.join(ctx.workspaceDir, 'same.tex'), 'human heading\noriginal body\n');
  const copy = await executeTool('copy_to_project', { workspacePath: 'same.tex', targetPath: 'main.tex' }, ctx);
  const bytes = Buffer.from([0, 255, 18, 128]);
  fs.writeFileSync(path.join(ctx.projectDir, 'same.png'), bytes);
  fs.writeFileSync(path.join(ctx.workspaceDir, 'same.png'), bytes);
  const binary = await executeTool('copy_to_project', { workspacePath: 'same.png', targetPath: 'same.png' }, ctx);
  for (const result of [write, edit, copy, binary]) {
    assert.equal(result.changed, false);
    assert.equal(result.scope, 'project');
    assert.equal(result.staged, false);
    assert.equal(result.applied, false);
  }
  assert.deepEqual(ctx.changesetBuffer, []);
  assert.deepEqual(changes.createChangeset({ projectId: ctx.project.id, files: ctx.changesetBuffer }), { id: null, files: [] });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM changesets WHERE project_id=?').get(ctx.project.id).n, 0);
  assert.equal(fs.readFileSync(path.join(ctx.projectDir, 'main.tex'), 'utf8'), 'human heading\noriginal body\n');
});

test('staging then restoring original bytes removes the net proposal without hiding the real operation', async () => {
  const ctx = fixture();
  await executeTool('read_file', { path: 'main.tex' }, ctx);
  const edit = await executeTool('write_file', { path: 'main.tex', content: 'B\n' }, ctx);
  assert.equal(edit.changed, true); assert.equal(edit.staged, true); assert.equal(edit.applied, false);
  const restore = await executeTool('edit_file', { path: 'main.tex', search: 'B', replace: 'A' }, ctx);
  assert.equal(restore.changed, true); assert.equal(restore.staged, false); assert.equal(restore.applied, false);
  assert.match(restore.text, /无待提交修改/);
  assert.deepEqual(ctx.changesetBuffer, []);
  assert.equal(changes.createChangeset({ projectId: ctx.project.id, files: ctx.changesetBuffer }).id, null);
  assert.equal(fs.readFileSync(path.join(ctx.projectDir, 'main.tex'), 'utf8'), 'A\n');
});

test('workspace evidence distinguishes direct writes from no-ops and never populates formal changes', async () => {
  const ctx = fixture();
  const first = await executeTool('write_file', { path: '_workspace/note.txt', content: 'workspace only' }, ctx);
  assert.equal(first.scope, 'workspace'); assert.equal(first.changed, true); assert.equal(first.applied, true); assert.equal(first.staged, false);
  const same = await executeTool('write_file', { path: '_workspace/note.txt', content: 'workspace only' }, ctx);
  await executeTool('read_file', { path: '_workspace/note.txt' }, ctx);
  const sameEdit = await executeTool('edit_file', { path: '_workspace/note.txt', search: 'only', replace: 'only' }, ctx);
  const sameCopy = await executeTool('copy_to_project', { workspacePath: 'note.txt', targetPath: '_workspace/note.txt' }, ctx);
  for (const result of [same, sameEdit, sameCopy]) {
    assert.equal(result.scope, 'workspace'); assert.equal(result.changed, false); assert.equal(result.applied, false); assert.equal(result.staged, false);
  }
  assert.deepEqual(ctx.changesetBuffer, []);
});

test('failed and stale writes cannot turn old human edits into this run changes', async () => {
  const ctx = fixture('manual title\noriginal body\n');
  const untouched = await executeTool('write_file', { path: 'main.tex', content: 'unread overwrite' }, ctx);
  assert.match(untouched.error, /先用 read_file/);
  await executeTool('read_file', { path: 'main.tex' }, ctx);
  fs.writeFileSync(path.join(ctx.projectDir, 'main.tex'), 'newer manual title\noriginal body\n');
  const stale = await executeTool('edit_file', { path: 'main.tex', search: 'original body', replace: 'AI body' }, ctx);
  assert.match(stale.error, /外部改动/);
  const missingCopy = await executeTool('copy_to_project', { workspacePath: 'missing.tex', targetPath: 'main.tex' }, ctx);
  assert.match(missingCopy.error, /不存在/);
  assert.deepEqual(ctx.changesetBuffer, []);
  assert.equal(changes.createChangeset({ projectId: ctx.project.id, files: ctx.changesetBuffer }).id, null);
  assert.equal(fs.readFileSync(path.join(ctx.projectDir, 'main.tex'), 'utf8'), 'newer manual title\noriginal body\n');
});

test('new empty files remain meaningful while empty and same-byte changesets do not create audit records', () => {
  const ctx = fixture();
  const files = [
    { path: 'same.tex', before: 'same\n', after: 'same\n' },
    { path: 'same.png', before: 'YQ==', after: 'YQ', encoding: 'base64' },
    { path: 'absent.tex', before: null, after: null },
    { path: 'empty.tex', before: null, after: '' },
  ];
  assert.deepEqual(changes.filterMeaningfulChanges(files), [files[3]]);
  for (const proposals of [[], files.slice(0, 3)]) {
    assert.deepEqual(changes.createChangeset({ projectId: ctx.project.id, files: proposals }), { id: null, files: [] });
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM changesets WHERE project_id=?').get(ctx.project.id).n, 0);
  const creation = changes.createChangeset({ projectId: ctx.project.id, files });
  assert.equal(creation.files.length, 1); assert.equal(creation.files[0].filePath, 'empty.tex');
  assert.deepEqual(changes.applyChangeset(creation.id), { applied: 1, skipped: [] });
  assert.equal(fs.existsSync(path.join(ctx.projectDir, 'empty.tex')), true);
  assert.equal(fs.statSync(path.join(ctx.projectDir, 'empty.tex')).size, 0);
});


test('review fix identity cannot skip fresh reads and rejects stale base hashes', async () => {
  const { fingerprint } = await import('../src/services/agent/collaborationContext.js');
  const ctx = fixture('Count 80\n');
  const fix = { path: 'main.tex', search: '80', replace: '40', baseHash: fingerprint('Count 80\n'), fixAppliedFor: 'finding-1' };
  assert.ok((await executeTool('edit_file', fix, ctx)).error);
  await executeTool('read_file', { path: 'main.tex' }, ctx);
  assert.ok((await executeTool('edit_file', { ...fix, baseHash: 'stale' }, ctx)).error);
  assert.equal(ctx.changesetBuffer.length, 0);
  const changed = await executeTool('edit_file', fix, ctx);
  assert.equal(changed.changed, true); assert.equal(changed.fixAppliedFor, 'finding-1');
  assert.equal(fs.readFileSync(path.join(ctx.projectDir, 'main.tex'), 'utf8'), 'Count 80\n');
});
