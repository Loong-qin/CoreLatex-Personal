import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

let temp, bin, db, resetDb, executeTool, getPiTools, createCompilationCache;
let serial = 0;
const caches = [];
const saved = { PATH: process.env.PATH, CORELATEX_DATA_DIR: process.env.CORELATEX_DATA_DIR, CORELATEX_CACHE_MARKERS: process.env.CORELATEX_CACHE_MARKERS };
function binary(name, body) { fs.writeFileSync(path.join(bin, name), '#!/usr/bin/env node\n' + body, { mode: 0o755 }); }
before(async () => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'corelatex-compile-cache-test-'));
  bin = path.join(temp, 'bin'); fs.mkdirSync(bin);
  process.env.CORELATEX_DATA_DIR = path.join(temp, 'data');
  process.env.PATH = [bin, path.dirname(process.execPath), saved.PATH].join(path.delimiter);
  ({ getDb: db, resetDb } = await import('../src/db.js')); db = db();
  ({ executeTool, getPiTools, createCompilationCache } = await import('../src/services/agent/tools.js'));
  const engine = String.raw`
const fs=require('node:fs'),path=require('node:path');
const markers=process.env.CORELATEX_CACHE_MARKERS;
const compileLog=path.join(markers,'compiles');
const pass=fs.existsSync(compileLog)?fs.readFileSync(compileLog,'utf8').trim().split('\n').length:0;
fs.appendFileSync(compileLog,JSON.stringify({cwd:process.cwd(),engine:path.basename(process.argv[1]),main:process.argv.at(-1)})+'\n');
const main=process.argv.at(-1),base=path.basename(main).replace(/\.tex$/i,'');
const source=fs.readFileSync(main,'utf8');
const outputDirectory=process.argv.find(arg=>arg.startsWith('-output-directory=')).slice('-output-directory='.length);
const recorder=path.join(markers,'recorder-inputs.json');
const configured=fs.existsSync(recorder)?JSON.parse(fs.readFileSync(recorder,'utf8')):null;
const inputs=Array.isArray(configured?.[0])?configured[pass % configured.length]:configured;
const readInputs=inputs?.map(input=>[path.resolve(input),fs.readFileSync(input,'utf8')]);
const finish=()=>{
 fs.mkdirSync(outputDirectory,{recursive:true});
 if(source.includes('FAIL')){fs.writeFileSync(path.join(outputDirectory,base+'.log'),'! Undefined control sequence.\nl.1 \\bad');process.exitCode=1;return;}
 fs.writeFileSync(path.join(outputDirectory,base+'.pdf'),'%PDF fake\n'+source+(readInputs?.map(([file,text])=>'\nRECORDED '+path.basename(file)+': '+text).join('')||''));
 fs.writeFileSync(path.join(outputDirectory,base+'.log'),(Array.isArray(configured?.[0])&&pass%configured.length===0?'Rerun LaTeX\n':'')+'Output written on '+base+'.pdf');
 if(inputs){
  if(!process.argv.includes('-recorder')) throw Error('recording requires -recorder');
  const records=['PWD '+process.cwd(),...readInputs.map(([file])=>'INPUT '+file),'OUTPUT '+path.join(outputDirectory,base+'.pdf')];
  fs.writeFileSync(path.join(outputDirectory,base+'.fls'), records.join('\n')+'\n');
 }
};
if(fs.existsSync(path.join(markers,'hold-engine'))){
 fs.writeFileSync(path.join(markers,'engine-running'),'');
 const timer=setInterval(()=>{if(fs.existsSync(path.join(markers,'release-engine'))){clearInterval(timer);finish();}},5);
}else finish();`;
  for (const name of ['pdflatex', 'xelatex', 'lualatex']) binary(name, engine);
  binary('pdfinfo', String.raw`const fs=require('node:fs'),path=require('node:path');const m=process.env.CORELATEX_CACHE_MARKERS;fs.appendFileSync(path.join(m,'pdfs'),process.argv[2]+'\n');console.log('Pages: 30');`);
  binary('pdftotext', String.raw`
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2);
assert.equal(args.length,6);
assert.equal(args[0],'-f'); assert.equal(args[2],'-l'); assert.equal(args.at(-1),'-');
fs.appendFileSync(path.join(process.env.CORELATEX_CACHE_MARKERS,'text-reads'),args[1]+'-'+args[3]+'\n');
process.stdout.write(fs.readFileSync(args.at(-2),'utf8'));`);
  binary('pdftoppm', String.raw`
const fs=require('node:fs'),path=require('node:path'),m=process.env.CORELATEX_CACHE_MARKERS;
const pdf=process.argv.at(-2),page=process.argv[process.argv.indexOf('-f')+1],dpi=process.argv[process.argv.indexOf('-r')+1];
fs.appendFileSync(path.join(m,'renders'),JSON.stringify({pdf,page,dpi})+'\n');
const finish=()=>fs.writeFileSync(process.argv.at(-1)+'-'+page+'.jpg',fs.readFileSync(pdf)+' page='+page+' dpi='+dpi);
if(fs.existsSync(path.join(m,'hold-render'))){fs.writeFileSync(path.join(m,'render-running'),'');const t=setInterval(()=>{if(fs.existsSync(path.join(m,'release-render'))){clearInterval(t);finish();}},5);}else finish();`);
});
afterEach(async () => { await Promise.all(caches.splice(0).map(cache => cache.cleanup())); });
after(() => {
  resetDb?.();
  for (const [key,value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  if (temp) fs.rmSync(temp,{recursive:true,force:true});
});
function cache(signal) { const item=createCompilationCache({signal}); caches.push(item); return item; }
function fixture() {
  const n=++serial;
  const uid=db.prepare("INSERT INTO users(username,password_hash,role) VALUES (?,'unused','admin')").run('cache'+n).lastInsertRowid;
  const pid=db.prepare("INSERT INTO projects(name,owner_id,public_id,compile_engine) VALUES ('cache',?,?,'pdflatex')").run(uid,'cache'+n).lastInsertRowid;
  const chatId=db.prepare('INSERT INTO chats(project_id,user_id) VALUES (?,?)').run(pid,uid).lastInsertRowid;
  const projectDir=path.join(process.env.CORELATEX_DATA_DIR,'projects',String(pid));
  const workspaceDir=path.join(projectDir,'_workspace'); fs.mkdirSync(workspaceDir,{recursive:true});
  fs.writeFileSync(path.join(projectDir,'main.tex'),'\\documentclass{article}\n\\begin{document}original\\end{document}');
  const markers=path.join(temp,'markers'+n);fs.mkdirSync(markers);process.env.CORELATEX_CACHE_MARKERS=markers;
  return {project:db.prepare('SELECT * FROM projects WHERE id=?').get(pid),user:db.prepare('SELECT * FROM users WHERE id=?').get(uid),
    projectDir,workspaceDir,chatId,db,markers,changesetBuffer:[],compilationCache:cache(),agentConfig:{}};
}
function lines(f,name){const file=path.join(f.markers,name);return fs.existsSync(file)?fs.readFileSync(file,'utf8').trim().split('\n').filter(Boolean):[];}
function recordInputs(f,inputs){fs.writeFileSync(path.join(f.markers,'recorder-inputs.json'),JSON.stringify(inputs));}
function dynamicTemplate(f){
  fs.writeFileSync(path.join(f.projectDir,'journal.cls'),'% Historical setting: \\catcode 38=12\n\\LoadClass{article}\n\\expandafter\\def\\csname fixture\\endcsname{yes}');
  const main=path.join(f.projectDir,'main.tex');
  fs.writeFileSync(main,fs.readFileSync(main,'utf8').replace('{article}','{journal}'));
  recordInputs(f,['main.tex','journal.cls']);
}
async function preview(f,input={pages:'1'}) {const presentation={};const result=await executeTool('compile_and_preview',input,{...f,presentation});return {...result,meta:presentation.compile};}
async function waitFor(file){const deadline=Date.now()+3000;while(!fs.existsSync(file)){if(Date.now()>deadline)throw Error('marker timeout '+file);await new Promise(r=>setTimeout(r,5));}}

test('same input reuses PDF across pages/DPI and same page bytes, with truthful metadata and cleanup', async()=>{
  const f=fixture();
  const a=await preview(f),b=await preview(f),c=await preview(f,{pages:'2'}),d=await preview(f,{pages:'2',dpi:120});
  for(const result of [a,b,c,d])assert.equal(result.error,undefined);
  assert.equal(lines(f,'compiles').length,1);assert.equal(lines(f,'renders').length,3);assert.equal(lines(f,'pdfs').length,1);
  assert.equal(a.meta.reused,false);assert.equal(b.meta.reused,true);assert.equal(b.meta.renderedFromCache,true);assert.equal(c.meta.renderedFromCache,false);
  assert.equal(b.meta.durationMs,0);assert.equal(b.meta.originalDurationMs,a.meta.durationMs);assert.match(b.text,/未重新编译/);
  assert.deepEqual(a.images,b.images);assert.match(Buffer.from(c.images[0].imageBase64,'base64').toString(),/page=2/);
  const pdf=lines(f,'pdfs')[0];assert.equal(path.dirname(path.dirname(pdf)),os.tmpdir());assert.ok(fs.existsSync(pdf));
  await f.compilationCache.cleanup();assert.equal(fs.existsSync(path.dirname(pdf)),false);
  assert.deepEqual(fs.readdirSync(f.workspaceDir),[]);
});

test('concurrent workers share one compilation and independently render requested pages', async()=>{
  const f=fixture();const [a,b,c]=await Promise.all([preview(f),preview(f,{pages:'2'}),preview(f)]);
  assert.equal(a.error,undefined);assert.equal(b.error,undefined);assert.equal(c.error,undefined);
  assert.equal(lines(f,'compiles').length,1);assert.equal(lines(f,'renders').length,2);
});

test('all formal input bytes and settings invalidate while generated outputs/workspace do not', async()=>{
  const f=fixture();await preview(f);let expected=1;
  for(const name of ['refs.bib','custom.sty','custom.cls','figure.png','included.pdf','.latexmkrc','chapters/body.tex']){
    const file=path.join(f.projectDir,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'first');
    await preview(f);assert.equal(lines(f,'compiles').length,++expected,name+' creation');
    const stat=fs.statSync(file);fs.writeFileSync(file,'other');fs.utimesSync(file,stat.atime,stat.mtime);
    await preview(f);assert.equal(lines(f,'compiles').length,++expected,name+' same size and restored mtime');
  }
  fs.writeFileSync(path.join(f.workspaceDir,'scratch.txt'),'draft');fs.writeFileSync(path.join(f.projectDir,'.build','ignored.log'),'new output');
  await preview(f);assert.equal(lines(f,'compiles').length,expected);
  fs.unlinkSync(path.join(f.projectDir,'refs.bib'));await preview(f);assert.equal(lines(f,'compiles').length,++expected);
  db.prepare("UPDATE projects SET compile_engine='xelatex' WHERE id=?").run(f.project.id);
  await preview(f);assert.equal(lines(f,'compiles').length,++expected);
  fs.writeFileSync(path.join(f.projectDir,'other.tex'),'other main');
  db.prepare("UPDATE projects SET main_file='other.tex' WHERE id=?").run(f.project.id);
  await preview(f);assert.equal(lines(f,'compiles').length,++expected);
  assert.deepEqual(JSON.parse(lines(f,'compiles').at(-1)),{cwd:f.projectDir,engine:'xelatex',main:'other.tex'});
});

test('staged text/binary changes are fingerprinted and frozen while queued', async()=>{
  const f=fixture();f.changesetBuffer=[{path:'main.tex',before:fs.readFileSync(path.join(f.projectDir,'main.tex'),'utf8'),after:'first staged'}];
  const a=await preview(f);assert.match(Buffer.from(a.images[0].imageBase64,'base64').toString(),/first staged/);
  f.changesetBuffer[0].after='second staged';await preview(f);assert.equal(lines(f,'compiles').length,2);
  f.changesetBuffer.push({path:'plot.png',encoding:'base64',before:null,after:Buffer.from('png1').toString('base64')});await preview(f);
  f.changesetBuffer[1].after=Buffer.from('png2').toString('base64');await preview(f);assert.equal(lines(f,'compiles').length,4);
  fs.writeFileSync(path.join(f.markers,'hold-engine'),'');f.changesetBuffer[0].after='holding staged';
  const holding=preview(f);await waitFor(path.join(f.markers,'engine-running'));
  f.changesetBuffer[0].after='queued frozen';const queued=preview(f);f.changesetBuffer[0].after='mutated later';
  fs.writeFileSync(path.join(f.markers,'release-engine'),'');await holding;const result=await queued;
  assert.match(Buffer.from(result.images[0].imageBase64,'base64').toString(),/queued frozen/);
  assert.match(fs.readFileSync(path.join(f.projectDir,'main.tex'),'utf8'),/original/);
});

test('input changed while TeX runs and explicit script invalidation never populate stale cache', async()=>{
  const f=fixture();fs.writeFileSync(path.join(f.markers,'hold-engine'),'');
  const pending=preview(f);await waitFor(path.join(f.markers,'engine-running'));
  fs.writeFileSync(path.join(f.projectDir,'refs.bib'),'changed during compilation');
  fs.writeFileSync(path.join(f.markers,'release-engine'),'');await pending;await preview(f);
  assert.equal(lines(f,'compiles').length,2);
  const script=await executeTool('run_in_workspace',{command:'printf side-effect > scratch.txt'},f);assert.equal(script.error,undefined);
  f.compilationCache.invalidate();await preview(f);assert.equal(lines(f,'compiles').length,3);
  await preview(f);assert.equal(lines(f,'compiles').length,3);
});

test('failed diagnostics may be reused but never become success and recover only after changed input', async()=>{
  const f=fixture();fs.writeFileSync(path.join(f.projectDir,'main.tex'),'FAIL');
  const a=await preview(f),b=await preview(f,{pages:'2'});assert.match(a.error,/编译失败/);assert.match(b.error,/复用/);
  assert.ok(b.meta.errors.length);assert.equal(b.images,undefined);assert.equal(b.meta.reused,true);assert.equal(lines(f,'compiles').length,1);
  fs.writeFileSync(path.join(f.projectDir,'main.tex'),'fixed');const c=await preview(f);assert.equal(c.error,undefined);assert.equal(lines(f,'compiles').length,2);
});

test('separate runs/users do not reuse another scope and retained version/page count stays bounded', async()=>{
  const f=fixture();await preview(f);const firstPdf=lines(f,'pdfs')[0];
  await preview({...f,compilationCache:cache()});assert.equal(lines(f,'compiles').length,2);
  const uid=db.prepare("INSERT INTO users(username,password_hash,role) VALUES (?,'unused','admin')").run('other'+serial).lastInsertRowid;
  await preview({...f,user:db.prepare('SELECT * FROM users WHERE id=?').get(uid)});assert.equal(lines(f,'compiles').length,3);
  assert.ok(fs.existsSync(firstPdf));
  fs.writeFileSync(path.join(f.projectDir,'main.tex'),'new version');await preview(f);assert.equal(fs.existsSync(firstPdf),false);
  const count=lines(f,'compiles').length;
  for(let page=2;page<=17;page++)assert.equal((await preview(f,{pages:String(page)})).error,undefined);
  const before=lines(f,'renders').length;await preview(f);assert.equal(lines(f,'renders').length,before+1,'oldest page evicted after 16 entries');
  assert.equal(lines(f,'compiles').length,count);
});

test('symlinks, uncertain dependencies and oversized projects bypass reuse conservatively', async()=>{
  for(const mode of ['symlink','dynamic','computed-command','external','workspace','oversize']){
    const f=fixture();
    if(mode==='symlink')fs.symlinkSync('main.tex',path.join(f.projectDir,'linked.tex'));
    if(mode==='dynamic')fs.writeFileSync(path.join(f.projectDir,'main.tex'),'\\input{\\generatedName}');
    if(mode==='computed-command')fs.writeFileSync(path.join(f.projectDir,'main.tex'),'\\csname input\\endcsname{generated}');
    if(mode==='external')fs.writeFileSync(path.join(f.projectDir,'main.tex'),'\\input{../outside.tex}');
    if(mode==='workspace')fs.writeFileSync(path.join(f.projectDir,'main.tex'),'\\input{_workspace/draft.tex}');
    if(mode==='oversize'){const fd=fs.openSync(path.join(f.projectDir,'large.bin'),'w');fs.ftruncateSync(fd,129*1024*1024);fs.closeSync(fd);}
    await preview(f);await preview(f);assert.equal(lines(f,'compiles').length,2,mode);
    for(const pdf of lines(f,'pdfs'))assert.equal(fs.existsSync(pdf),false,mode+' snapshot cleanup');
  }
});

test('abort kills rendering and releases retained PDF; cleanup also stops an active engine', async()=>{
  const f=fixture(),controller=new AbortController();f.compilationCache=cache(controller.signal);f.signal=controller.signal;
  await preview(f);const pdf=lines(f,'pdfs')[0];fs.writeFileSync(path.join(f.markers,'hold-render'),'');
  const pending=preview(f,{pages:'2'});await waitFor(path.join(f.markers,'render-running'));controller.abort();
  assert.equal(typeof (await pending).error,'string');await f.compilationCache.cleanup();assert.equal(fs.existsSync(path.dirname(pdf)),false);
  const g=fixture();fs.writeFileSync(path.join(g.markers,'hold-engine'),'');const engine=preview(g);await waitFor(path.join(g.markers,'engine-running'));
  await g.compilationCache.cleanup();assert.equal(typeof (await engine).error,'string');assert.equal(lines(g,'pdfs').length,0);
});

test('cancelling a queued worker returns promptly without cancelling its active sibling', async()=>{
  const f=fixture();fs.writeFileSync(path.join(f.markers,'hold-engine'),'');
  const active=preview(f);await waitFor(path.join(f.markers,'engine-running'));
  const controller=new AbortController();const queued=preview({...f,signal:controller.signal},{pages:'2'});controller.abort();
  let timer;
  try { const result=await Promise.race([queued,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('queued abort was blocked')),150);})]);assert.equal(typeof result.error,'string'); }
  finally { clearTimeout(timer);fs.writeFileSync(path.join(f.markers,'release-engine'),''); }
  assert.equal((await active).error,undefined);assert.equal(lines(f,'compiles').length,1);
  assert.equal((await preview(f,{pages:'2'})).error,undefined);assert.equal(lines(f,'compiles').length,1);
});

test('reused bytes still create independently authorized persistent tool-image artifacts', async()=>{
  const f=fixture(),tool=getPiTools(f).find(t=>t.name==='compile_and_preview');
  const a=await tool.execute('a',{pages:'1'}),b=await tool.execute('b',{pages:'1'});
  assert.equal(lines(f,'compiles').length,1);assert.equal(a.content[1].data,b.content[1].data);
  assert.notEqual(a.details.display.images[0].id,b.details.display.images[0].id);
  const records=db.prepare('SELECT user_id,project_id,chat_id FROM agent_artifacts WHERE chat_id=?').all(f.chatId);
  assert.equal(records.length,2);assert.ok(records.every(row=>row.user_id===f.user.id&&row.project_id===f.project.id));
  await f.compilationCache.cleanup();assert.equal(db.prepare('SELECT count(*) AS n FROM agent_artifacts WHERE chat_id=?').get(f.chatId).n,2);
});


test('a script refused before dispatch leaves successful compilation evidence in place', async () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.projectDir, 'main.tex'), '\\input{\\unresolvedInput}');
  await preview(f);
  f.agentConfig.confirmBeforeApply = true;
  const tools = getPiTools(f);
  for (const name of ['run_in_workspace', 'run_skill_script']) {
    const tool = tools.find(item => item.name === name);
    await assert.rejects(tool.execute(name, { command: 'false' }), /禁用/);
    assert.equal(f.toolEffects.get(name).compilationUnchanged, true);
  }
});

test('script evidence preserves only an unchanged successful compilation, including failing read-only checks', async () => {
  const { createWorkflowGraph } = await import('../src/services/agent/workflowGraph.js');
  for (const mode of ['read', 'workspace', 'failed-read', 'write', 'failed-write', 'staged-change', 'already-changed', 'unknown-input']) {
    const f = fixture();
    if (mode === 'unknown-input') fs.writeFileSync(path.join(f.projectDir, 'main.tex'), '\\input{../outside.tex}');
    await preview(f);
    if (mode === 'already-changed') fs.writeFileSync(path.join(f.projectDir, 'refs.bib'), 'external modification before command');
    const command = mode === 'workspace' ? 'printf notes > note.txt; mkdir -p ../.build; printf output > ../.build/extra.log'
      : mode === 'write' || mode === 'failed-write' ? 'printf changed > ../refs.bib' + (mode === 'failed-write' ? '; exit 1' : '')
        : mode === 'failed-read' ? 'wc -l ../main.tex; exit 1' : 'wc -l ../main.tex';
    const tool = getPiTools(f).find(tool => tool.name === 'run_in_workspace');
    let failed = false;
    await tool.execute('script', { command }).catch(() => { failed = true; });
    const unchanged = ['read', 'workspace', 'failed-read'].includes(mode);
    if (mode === 'staged-change') {
      // A concurrent proposal update during the script must also invalidate.
      const { makePiTool } = await import('../src/services/agent/tools.js');
      const stagedTool = makePiTool({ name: 'run_skill_script', description: '', parameters: {}, run: async () => {
        f.changesetBuffer.push({ path: 'main.tex', before: 'original', after: 'new staged content' }); return 'done';
      } }, f);
      await stagedTool.execute('script', {});
    }
    assert.equal(f.toolEffects.get('script').compilationUnchanged, unchanged, mode);
    if (mode.startsWith('failed')) assert.equal(failed, true, mode);
    const graph = createWorkflowGraph();
    graph.plan({ scenario: 'compile', summary: '验证本轮结果' });
    graph.toolEnd('read_file', { succeeded: true });
    graph.toolEnd('compile_and_preview', { succeeded: true });
    graph.toolEnd('run_in_workspace', { succeeded: !failed, executionEffects: f.toolEffects.get('script') });
    assert.equal(graph.prepareCompletion().ready, unchanged, mode);
  }
});

for (const mode of ['readonly', 'workspace-notes', 'changed-input', 'pdf-review', 'pdf-diagnosis', 'net-reverted', 'workspace-read-changed', 'inherited-draft', 'blocked-qa']) test('delivery with compilation evidence: ' + mode, async () => {
  const { runAgent } = await import('../src/services/agent/agentLoop.js');
  const f = fixture();
  const blockedQa = mode === 'blocked-qa';
  const pdfChecks = mode.startsWith('pdf-'), diagnosis = mode === 'pdf-diagnosis' || blockedQa;
  const changedRead = mode === 'workspace-read-changed', inheritedDraft = mode === 'inherited-draft';
  const notesPath = path.join(f.workspaceDir, 'qa.txt');
  if (changedRead) fs.writeFileSync(notesPath, 'First QA note.');
  if (pdfChecks) dynamicTemplate(f);
  const original = fs.readFileSync(path.join(f.projectDir, 'main.tex'), 'utf8');
  let proposal;
  if (inheritedDraft) {
    const { openAgentDraft } = await import('../src/services/agent/draftPersistence.js');
    const draft = openAgentDraft(f);
    f.changesetBuffer.push({ path: 'main.tex', before: original, after: original.replace('original', 'updated') });
    draft.checkpoint();
    const compiled = await preview(f);
    assert.equal(compiled.error, undefined);
    proposal = draft.publish();
    assert.ok(proposal.id);
  }
  const fakePopplerPath = "'" + process.env.PATH.replaceAll("'", "'\\''") + "'";
  db.prepare('INSERT INTO settings(user_id, agent_config) VALUES(?,?)')
    .run(f.user.id, JSON.stringify(blockedQa ? { graphOrchestration: true } : {}));
  let requests = 0;
  const sse = value => 'data: ' + JSON.stringify({ choices: [{ index: 0, ...value }] }) + '\n\n';
  const llm = http.createServer((req, res) => {
    let raw = ''; req.on('data', chunk => raw += chunk); req.on('end', () => {
      const payload = JSON.parse(raw); requests++;
      const calls = payload.messages.filter(m => m.role === 'assistant').flatMap(m => m.tool_calls || []);
      const count = name => calls.filter(c => c.function.name === name).length;
      const call = (name, args) => res.end(sse({ delta: { tool_calls: [{ index: 0, id: 'call_' + requests, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }) + sse({ delta: {}, finish_reason: 'tool_calls' }) + 'data: [DONE]\n\n');
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (blockedQa && !count('plan_task_graph')) return call('plan_task_graph', { scenario: 'diagnose', summary: '只读检查', agents: [] });
      if (!count('read_file')) return call('read_file', { path: 'main.tex' });
      if (inheritedDraft) return res.end(sse({ delta: { content: '暂存正文的关键词是 updated。' } }) + sse({ delta: {}, finish_reason: 'stop' }) + 'data: [DONE]\n\n');
      if (!diagnosis && !count('edit_file')) return call('edit_file', { path: 'main.tex', search: 'original', replace: 'updated' });
      if (changedRead) {
        const noteReads = calls.filter(c => c.function.name === 'read_file' && JSON.parse(c.function.arguments).path === '_workspace/qa.txt').length;
        const refreshRequested = payload.messages.some(m => m.role === 'user' && String(m.content).includes('【当前文件版本核对】'));
        if (!noteReads || noteReads === 1 && refreshRequested) return call('read_file', { path: '_workspace/qa.txt' });
      }
      if (!count('compile_and_preview')) return call('compile_and_preview', { pages: '1' });
      if (mode === 'net-reverted' && count('edit_file') < 3) return call('edit_file', count('edit_file') === 1
        ? { path: 'main.tex', search: 'updated', replace: 'temporary' }
        : { path: 'main.tex', search: 'temporary', replace: 'updated' });
      const scripts = count('run_in_workspace');
      if (pdfChecks && scripts < 2) {
        const pdf = diagnosis ? '../.build/work/main.pdf' : '../.preview/.build/main.pdf';
        const match = scripts ? 'no-such-layout-issue' : diagnosis ? 'original' : 'updated';
        return call('run_in_workspace', { command: `PATH=${fakePopplerPath} pdftotext -f 6 -l ${scripts ? 8 : 9} ${pdf} - | grep -n ${match}` });
      }
      if (!scripts && !changedRead) return call('run_in_workspace', { command: mode === 'changed-input'
        ? 'printf changed > ../refs.bib' : mode === 'workspace-notes' ? 'printf verified > check.txt' : 'wc -l ../main.tex' });
      if (mode === 'changed-input' && count('compile_and_preview') < 2 && payload.messages.some(m => m.role === 'user' && String(m.content).includes('【标准工作流程】')))
        return call('compile_and_preview', { pages: '1' });
      res.end(sse({ delta: { content: diagnosis ? '编译成功。本轮没有修改文件。' : '已完成编辑，编译成功，请审核。' } }) + sse({ delta: {}, finish_reason: 'stop' }) + 'data: [DONE]\n\n');
    });
  });
  await new Promise(resolve => llm.listen(0, '127.0.0.1', resolve));
  const events = [];
  try {
    const result = await runAgent({ user: f.user, project: f.project, chat: db.prepare('SELECT * FROM chats WHERE id=?').get(f.chatId),
      messages: [{ role: 'user', content: inheritedDraft ? '请读取暂存文稿，说明当前正文的表述。'
        : diagnosis ? '请只编译并检查分页，不要修改正文。' : '请精简正文并检查排版。' }],
      modelConfig: { provider: 'openai', model: 'command-gate-fixture', apiKey: 'synthetic', baseUrl: 'http://127.0.0.1:' + llm.address().port + '/v1', maxTokens: 1024, contextLength: 100000 },
      emit: event => {
        events.push(event);
        if (changedRead && event.type === 'tool' && event.name === 'compile_and_preview' && event.status === 'end')
          fs.writeFileSync(notesPath, 'Updated QA note.');
      } });
    assert.equal(result.status, 'completed');
    assert.equal(lines(f, 'compiles').length, mode === 'changed-input' ? 2 : 1);
    assert.equal(requests, inheritedDraft ? 2 : ['changed-input', 'net-reverted'].includes(mode) ? 7 : mode === 'pdf-review' || changedRead ? 6 : 5);
    const verification = events.filter(e => e.type === 'activity' && e.phase === 'verification');
    if (mode === 'changed-input') assert.ok(verification.some(e => (e.text || e.detail || '').includes('尚未验证')));
    else if (changedRead) {
      assert.deepEqual(verification.map(event => event.text), ['已读文件发生变化，正在更新依据并保留用户修改。']);
      assert.ok(events.some(event => event.type === 'tool' && event.name === 'read_file' && event.detail === 'Updated QA note.'));
      assert.match(events.filter(e => e.type === 'token').map(e => e.text).join(''), /编译成功/);
    }
    else assert.equal(verification.length, 0, 'unchanged inputs finish without correction or repeat model turns');
    if (inheritedDraft) {
      assert.equal(result.changeset, null);
      assert.deepEqual(db.prepare('SELECT status, applied FROM changesets WHERE id=?').get(proposal.id), { status: 'pending', applied: 0 });
      assert.ok(events.some(event => event.type === 'tool' && event.name === 'read_file' && event.status === 'end' && event.detail.includes('updated')));
      assert.equal(fs.readFileSync(path.join(f.projectDir, 'main.tex'), 'utf8'), original);
    }
    if (blockedQa) {
      assert.match(events.find(event => event.type === 'tool' && event.name === 'run_in_workspace' && event.status === 'error').detail, /只读编译诊断/);
      assert.match(events.filter(e => e.type === 'token').map(e => e.text).join(''), /编译成功/);
    }
    if (pdfChecks) {
      assert.deepEqual(lines(f, 'text-reads'), ['6-9', '6-8'], 'both page ranges were inspected');
      assert.deepEqual(events.filter(e => e.type === 'tool' && e.name === 'run_in_workspace' && e.status !== 'start').map(e => e.status), ['end', 'error']);
      assert.match(events.filter(e => e.type === 'token').map(e => e.text).join(''), /编译成功/);
      if (diagnosis) {
        assert.equal(result.changeset, null);
        assert.equal(fs.readFileSync(path.join(f.projectDir, 'main.tex'), 'utf8'), original);
      }
    }
    if (mode === 'net-reverted') assert.match(fs.readFileSync(path.join(f.projectDir, 'main.tex'), 'utf8'), /updated/);
  } finally {
    llm.closeAllConnections(); await new Promise(resolve => llm.close(resolve));
  }
});

test('an earlier TeX pass still contributes workspace and external dependencies to non-cacheable proof', async () => {
  const { checkCompilationFreshness } = await import('../src/services/agent/tools.js');
  const f = fixture(); dynamicTemplate(f);
  const workspace = path.join(f.workspaceDir, 'used.tex');
  const external = path.join(temp, 'external-' + serial + '.tex');
  fs.writeFileSync(workspace, 'first');
  fs.writeFileSync(external, 'external');
  recordInputs(f, [['main.tex', 'journal.cls', '_workspace/used.tex', external], ['main.tex', 'journal.cls']]);
  const tools = getPiTools(f);
  await tools.find(item => item.name === 'compile_and_preview').execute('compile', { pages: '1' });
  const compiled = f.toolEvidence.get('compile');
  assert.equal(compiled.inputKey, null, 'dynamic templates still bypass PDF reuse');
  assert.equal(compiled.inputsCurrent, true);
  assert.equal(await checkCompilationFreshness(f), 'current');
  assert.equal(lines(f, 'compiles').length, 2, 'the fake engine requested a second TeX pass');
  const scratch = tools.find(item => item.name === 'run_in_workspace');
  await scratch.execute('restored', { command: 'printf temporary > used.tex; printf first > used.tex' });
  assert.equal(f.toolEffects.get('restored').compilationUnchanged, true, 'only net input bytes count');
  await assert.rejects(scratch.execute('changed', { command: 'printf changed > used.tex; exit 1' }));
  assert.equal(f.toolEffects.get('changed').compilationUnchanged, false, 'a failing script may still change an input');
  assert.equal(await checkCompilationFreshness(f), 'changed');
  fs.writeFileSync(workspace, 'first');
  fs.writeFileSync(external, 'modified');
  assert.equal(await checkCompilationFreshness(f), 'changed', 'external input came only from the first pass');
});

test('custom lookup roots keep proof conservative without hiding changes to recorded external files', async () => {
  const { checkCompilationFreshness } = await import('../src/services/agent/tools.js');
  const f = fixture(); dynamicTemplate(f);
  const external = path.join(temp, 'search-' + serial + '.tex');
  fs.writeFileSync(external, 'found');
  recordInputs(f, ['main.tex', 'journal.cls', external]);
  const previous = process.env.TEXINPUTS;
  process.env.TEXINPUTS = temp + ':';
  try {
    await getPiTools(f).find(item => item.name === 'compile_and_preview').execute('custom', { pages: '1' });
    const compiled = f.toolEvidence.get('custom');
    assert.equal(compiled.status, 'succeeded');
    assert.equal(compiled.inputsCurrent, undefined);
    assert.equal(await checkCompilationFreshness(f), 'unknown', 'a higher-priority unrecorded match remains possible');
    fs.writeFileSync(external, 'changed');
    assert.equal(await checkCompilationFreshness(f), 'changed');
  } finally {
    if (previous === undefined) delete process.env.TEXINPUTS;
    else process.env.TEXINPUTS = previous;
  }
});


test('persistent runtime resource revision invalidates cached PDFs and command proofs', async () => {
  const { bumpRuntimeResourceRevision } = await import('../src/services/runtimeEnvironment.js');
  const f = fixture(); await preview(f);
  bumpRuntimeResourceRevision();
  const tool = getPiTools(f).find(tool => tool.name === 'run_in_workspace');
  await tool.execute('environment-changed', { command: 'wc -l ../main.tex' });
  assert.equal(f.toolEffects.get('environment-changed').compilationUnchanged, false);
  await preview(f); assert.equal(lines(f, 'compiles').length, 2);
  await preview(f); assert.equal(lines(f, 'compiles').length, 2);
});

test('runtime installation tools enforce live account and editor permissions and reject unsafe font sources', async () => {
  const f = fixture();
  db.prepare("UPDATE users SET role='user' WHERE id=?").run(f.user.id);
  const viewerId = db.prepare("INSERT INTO users(username,password_hash,role) VALUES('runtime-viewer','unused','user')").run().lastInsertRowid;
  db.prepare("INSERT INTO project_members(project_id,user_id,role) VALUES(?,?,'viewer')").run(f.project.id, viewerId);
  const viewer = { ...f, user: { id: viewerId, role: 'admin' } };
  db.prepare("UPDATE users SET status='disabled' WHERE id=?").run(f.user.id);
  for (const [name, input] of [['install_font', { path: 'font.ttf' }], ['install_tex_packages', { packages: ['amsmath'] }]]) {
    assert.match((await executeTool(name, input, viewer)).error, /只读成员/);
    assert.match((await executeTool(name, input, f)).error, /账号已被禁用/);
  }
  db.prepare("UPDATE users SET status='active' WHERE id=?").run(f.user.id);
  fs.writeFileSync(path.join(f.projectDir, 'font.ttf'), 'not an actual font');
  fs.symlinkSync('font.ttf', path.join(f.projectDir, 'linked.ttf'));
  fs.symlinkSync(f.workspaceDir, path.join(f.projectDir, 'linked-dir'));
  fs.writeFileSync(path.join(f.workspaceDir, 'font.ttf'), 'also not a font');
  for (const path of ['../outside.ttf', '/tmp/outside.ttf', 'https://example.test/font.ttf', 'C:\\font.ttf', 'linked.ttf', 'linked-dir/font.ttf']) {
    const result = await executeTool('install_font', { path }, f);
    assert.ok(result.error, path);
    assert.match(result.error, /路径|符号链接/, path);
  }
});


test('a dependency changed during compilation makes the result stale; unchanged retry is reused', async () => {
  const { createWorkflowGraph } = await import('../src/services/agent/workflowGraph.js');
  const { checkCompilationFreshness } = await import('../src/services/agent/tools.js');
  const f = fixture();
  const original = fs.readFileSync(path.join(f.projectDir, 'main.tex'), 'utf8');
  f.changesetBuffer = [{ path: 'main.tex', before: original, after: original.replace('original', 'updated') }];
  const dependency = path.join(f.projectDir, 'refs.bib');
  fs.writeFileSync(dependency, 'before');
  fs.writeFileSync(path.join(f.markers, 'hold-engine'), '');
  const tool = getPiTools(f).find(item => item.name === 'compile_and_preview');
  const compiling = tool.execute('stale', { pages: '1' });
  await waitFor(path.join(f.markers, 'engine-running'));
  fs.writeFileSync(dependency, 'after');
  fs.writeFileSync(path.join(f.markers, 'release-engine'), '');
  const stale = await compiling;
  const evidence = f.toolEvidence.get('stale');
  assert.equal(evidence.status, 'succeeded');
  assert.equal(evidence.inputsCurrent, false);
  assert.match(stale.content[0].text, /旧快照/);
  const workflow = createWorkflowGraph();
  workflow.plan({ scenario: 'edit', summary: '修改并验证' });
  workflow.toolEnd('read_file', { succeeded: true });
  workflow.toolEnd('edit_file', { succeeded: true, outcome: { changed: true, scope: 'project' }, changedPaths: ['main.tex'] });
  workflow.toolEnd('compile_and_preview', { succeeded: true, compileEvidence: evidence });
  assert.equal(workflow.prepareCompletion({ renderChangedPaths: ['main.tex'] }).ready, false);
  const verified = await tool.execute('verified', { pages: '1' });
  const current = f.toolEvidence.get('verified');
  assert.equal(current.inputsCurrent, true);
  workflow.toolEnd('compile_and_preview', { succeeded: true, compileEvidence: current });
  assert.equal(workflow.prepareCompletion({ renderChangedPaths: ['main.tex'] }).ready, true);
  assert.equal(await checkCompilationFreshness(f), 'current');
  await tool.execute('reuse', { pages: '1' });
  assert.equal(lines(f, 'compiles').length, 2, 'only the genuinely changed inputs require a new compile');
  assert.ok(verified.content.some(item => item.type === 'image'));
  fs.writeFileSync(dependency, 'changed after verification');
  assert.equal(await checkCompilationFreshness(f), 'changed');
  assert.equal(lines(f, 'compiles').length, 2, 'checking freshness never compiles');
});

for (const phase of ['before-gate', 'after-gate', 'unverifiable']) test('concurrent dependency change ' + phase + ' cannot publish stale compile evidence', async () => {
  const { runAgent } = await import('../src/services/agent/agentLoop.js');
  const f = fixture();
  const original = fs.readFileSync(path.join(f.projectDir, 'main.tex'), 'utf8');
  const dependency = path.join(f.projectDir, 'refs.bib');
  fs.writeFileSync(dependency, 'before');
  db.prepare('INSERT INTO settings(user_id,agent_config) VALUES(?,?)').run(f.user.id,
    JSON.stringify({ graphOrchestration: false, confirmBeforeApply: false, allowWebAccess: false }));
  let changed = false;
  const sse = value => 'data: ' + JSON.stringify({ choices: [{ index: 0, ...value }] }) + '\n\n';
  const llm = http.createServer((req, res) => {
    let raw = ''; req.on('data', chunk => raw += chunk); req.on('end', () => {
      const payload = JSON.parse(raw);
      const calls = payload.messages.filter(message => message.role === 'assistant').flatMap(message => message.tool_calls || []);
      const count = name => calls.filter(call => call.function.name === name).length;
      const call = (name, args) => res.end(sse({ delta: { tool_calls: [{ index: 0, id: 'call_' + calls.length + '_' + name,
        type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }) + sse({ delta: {}, finish_reason: 'tool_calls' }) + 'data: [DONE]\n\n');
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (!count('read_file')) return call('read_file', { path: 'main.tex' });
      if (!count('edit_file')) return call('edit_file', { path: 'main.tex', search: 'original', replace: 'updated' });
      if (!count('compile_and_preview')) return call('compile_and_preview', { pages: '1' });
      if ((phase === 'before-gate' || phase === 'unverifiable') && !changed) {
        changed = true; fs.writeFileSync(dependency, phase === 'unverifiable' ? '\\directlua{dynamic}' : 'after');
      }
      if (phase === 'before-gate' && count('compile_and_preview') < 2 && payload.messages.some(message =>
        message.role === 'user' && String(message.content).includes('【标准工作流程】')))
        return call('compile_and_preview', { pages: '1' });
      res.end(sse({ delta: { content: '已完成修改，编译通过，请审核。' } }) + sse({ delta: {}, finish_reason: 'stop' }) + 'data: [DONE]\n\n');
    });
  });
  await new Promise(resolve => llm.listen(0, '127.0.0.1', resolve));
  const events = [];
  try {
    const result = await runAgent({ user: f.user, project: f.project, chat: db.prepare('SELECT * FROM chats WHERE id=?').get(f.chatId),
      messages: [{ role: 'user', content: '请修改正文并编译。' }],
      modelConfig: { provider: 'openai', model: 'concurrent-compile-fixture', apiKey: 'synthetic',
        baseUrl: 'http://127.0.0.1:' + llm.address().port + '/v1', maxTokens: 1024, contextLength: 100000 },
      emit: event => {
        events.push(event);
        if (phase === 'after-gate' && !changed && event.type === 'workflow' && event.graph?.currentNode === 'deliver' &&
            event.graph?.detail === '已满足当前路线的交付条件') {
          changed = true;
          fs.writeFileSync(dependency, 'after');
        }
      } });
    assert.equal(changed, true, phase);
    if (phase === 'before-gate') {
      assert.equal(result.status, 'completed');
      assert.equal(lines(f, 'compiles').length, 2);
      assert.match(fs.readFileSync(path.join(f.projectDir, 'main.tex'), 'utf8'), /updated/);
      assert.ok(events.some(event => event.type === 'activity' && /输入已变化/.test(event.text)));
    } else if (phase === 'unverifiable') {
      assert.equal(result.status, 'failed');
      assert.equal(lines(f, 'compiles').length, 1, 'unverifiable evidence does not trigger repeated compilation');
      assert.equal(fs.readFileSync(path.join(f.projectDir, 'main.tex'), 'utf8'), original);
      assert.equal(result.changeset.applied, false);
      assert.ok(events.some(event => /无法重新确认项目输入/.test(event.text || '')));
    } else {
      assert.equal(result.status, 'failed');
      assert.equal(lines(f, 'compiles').length, 1);
      assert.equal(fs.readFileSync(path.join(f.projectDir, 'main.tex'), 'utf8'), original);
      assert.equal(result.changeset.applied, false);
      assert.ok(events.some(event => event.type === 'token' && /编译验证后项目输入已变化/.test(event.text)));
    }
  } finally { await new Promise(resolve => llm.close(resolve)); }
});


test('cache invalidation during an active compile cannot approve the old snapshot', async () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.markers, 'hold-engine'), '');
  const tool = getPiTools(f).find(item => item.name === 'compile_and_preview');
  const compiling = tool.execute('invalidated', { pages: '1' });
  await waitFor(path.join(f.markers, 'engine-running'));
  f.compilationCache.invalidate();
  fs.writeFileSync(path.join(f.markers, 'release-engine'), '');
  const result = await compiling;
  const evidence = f.toolEvidence.get('invalidated');
  assert.equal(evidence.status, 'succeeded');
  assert.equal(evidence.inputsCurrent, false);
  assert.equal(evidence.inputStatus, 'invalidated');
  assert.match(result.content[0].text, /旧快照/);
});

test('concurrent edit conflict preserves the complete draft without publishing a success claim', async () => {
  const { runAgent } = await import('../src/services/agent/agentLoop.js');
  const f = fixture();
  const first = path.join(f.projectDir, 'notes-a.md'), second = path.join(f.projectDir, 'notes-b.md');
  fs.writeFileSync(first, 'first original'); fs.writeFileSync(second, 'second original');
  db.prepare('INSERT INTO settings(user_id,agent_config) VALUES(?,?)').run(f.user.id,
    JSON.stringify({ graphOrchestration: false, confirmBeforeApply: false, allowWebAccess: false }));
  let changed = false;
  const sse = value => 'data: ' + JSON.stringify({ choices: [{ index: 0, ...value }] }) + '\n\n';
  const llm = http.createServer((req, res) => {
    let raw = ''; req.on('data', chunk => raw += chunk); req.on('end', () => {
      const payload = JSON.parse(raw);
      const calls = payload.messages.filter(message => message.role === 'assistant').flatMap(message => message.tool_calls || []);
      const seen = (name, file) => calls.some(item => item.function.name === name && JSON.parse(item.function.arguments).path === file);
      const call = (name, args) => res.end(sse({ delta: { tool_calls: [{ index: 0, id: 'call_' + calls.length + '_' + name,
        type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }) + sse({ delta: {}, finish_reason: 'tool_calls' }) + 'data: [DONE]\n\n');
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (!seen('read_file', 'notes-a.md')) return call('read_file', { path: 'notes-a.md' });
      if (!seen('edit_file', 'notes-a.md')) return call('edit_file', { path: 'notes-a.md', search: 'first original', replace: 'first updated' });
      if (!seen('read_file', 'notes-b.md')) return call('read_file', { path: 'notes-b.md' });
      if (!seen('edit_file', 'notes-b.md')) return call('edit_file', { path: 'notes-b.md', search: 'second original', replace: 'second updated' });
      res.end(sse({ delta: { content: '已完成修改，请审核。' } }) + sse({ delta: {}, finish_reason: 'stop' }) + 'data: [DONE]\n\n');
    });
  });
  await new Promise(resolve => llm.listen(0, '127.0.0.1', resolve));
  const events = [];
  try {
    const result = await runAgent({ user: f.user, project: f.project, chat: db.prepare('SELECT * FROM chats WHERE id=?').get(f.chatId),
      messages: [{ role: 'user', content: '请更新两份备注。' }],
      modelConfig: { provider: 'openai', model: 'conflicting-edit-fixture', apiKey: 'synthetic',
        baseUrl: 'http://127.0.0.1:' + llm.address().port + '/v1', maxTokens: 1024, contextLength: 100000 },
      emit: event => {
        events.push(event);
        if (!changed && event.type === 'workflow' && event.graph?.currentNode === 'deliver' &&
            event.graph?.detail === '已满足当前路线的交付条件') {
          changed = true; fs.writeFileSync(first, 'manual edit');
        }
      } });
    assert.equal(changed, true);
    assert.equal(result.status, 'failed');
    assert.equal(result.changeset, null, 'a conflict before publication keeps the original checkpoint');
    const draft = db.prepare('SELECT files_json FROM agent_drafts WHERE chat_id=?').get(f.chatId);
    assert.deepEqual(JSON.parse(draft.files_json).map(file => file.path), ['notes-a.md', 'notes-b.md']);
    assert.equal(fs.readFileSync(first, 'utf8'), 'manual edit');
    assert.equal(fs.readFileSync(second, 'utf8'), 'second original', 'nonconflicting files must also stay unapplied');
    assert.ok(events.some(event => event.type === 'token' && /草稿接续冲突：notes-a\.md/.test(event.text)));
    assert.equal(events.some(event => event.type === 'token' && /已完成修改，请审核/.test(event.text)), false);
  } finally { await new Promise(resolve => llm.close(resolve)); }
});


test('automatic changeset application is all-or-nothing when any file conflicts', async () => {
  const { createChangeset, applyChangeset, getChangeset } = await import('../src/services/agent/changesets.js');
  const f = fixture();
  fs.writeFileSync(path.join(f.projectDir, 'notes-a.md'), 'first original');
  fs.writeFileSync(path.join(f.projectDir, 'notes-b.md'), 'second original');
  const proposal = createChangeset({ projectId: f.project.id, chatId: f.chatId, files: [
    { path: 'notes-a.md', before: 'first original', after: 'first updated' },
    { path: 'notes-b.md', before: 'second original', after: 'second updated' },
  ] });
  fs.writeFileSync(path.join(f.projectDir, 'notes-a.md'), 'manual edit');
  assert.deepEqual(applyChangeset(proposal.id, { allOrNothing: true }), { applied: 0, skipped: ['notes-a.md'] });
  assert.equal(fs.readFileSync(path.join(f.projectDir, 'notes-a.md'), 'utf8'), 'manual edit');
  assert.equal(fs.readFileSync(path.join(f.projectDir, 'notes-b.md'), 'utf8'), 'second original');
  assert.equal(getChangeset(proposal.id).applied, false);
});

test('cancellation during the final fingerprint still preserves the draft and emits done', async () => {
  const { runAgent } = await import('../src/services/agent/agentLoop.js');
  const f = fixture(), controller = new AbortController();
  const original = fs.readFileSync(path.join(f.projectDir, 'main.tex'), 'utf8');
  db.prepare('INSERT INTO settings(user_id,agent_config) VALUES(?,?)').run(f.user.id,
    JSON.stringify({ graphOrchestration: false, confirmBeforeApply: false, allowWebAccess: false }));
  const sse = value => 'data: ' + JSON.stringify({ choices: [{ index: 0, ...value }] }) + '\n\n';
  const llm = http.createServer((req, res) => {
    let raw = ''; req.on('data', chunk => raw += chunk); req.on('end', () => {
      const payload = JSON.parse(raw);
      const calls = payload.messages.filter(message => message.role === 'assistant').flatMap(message => message.tool_calls || []);
      const count = name => calls.filter(call => call.function.name === name).length;
      const call = (name, args) => res.end(sse({ delta: { tool_calls: [{ index: 0, id: 'call_' + calls.length + '_' + name,
        type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }) + sse({ delta: {}, finish_reason: 'tool_calls' }) + 'data: [DONE]\n\n');
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (!count('read_file')) return call('read_file', { path: 'main.tex' });
      if (!count('edit_file')) return call('edit_file', { path: 'main.tex', search: 'original', replace: 'updated' });
      if (!count('compile_and_preview')) return call('compile_and_preview', { pages: '1' });
      res.end(sse({ delta: { content: '已完成修改，编译通过，请审核。' } }) + sse({ delta: {}, finish_reason: 'stop' }) + 'data: [DONE]\n\n');
    });
  });
  await new Promise(resolve => llm.listen(0, '127.0.0.1', resolve));
  const events = [], originalStream = fs.createReadStream;
  let finalGate = false, cancelled = false;
  fs.createReadStream = function(file, options) {
    const stream = originalStream.call(this, file, options);
    if (finalGate && !cancelled && String(file).endsWith('/main.tex')) {
      cancelled = true;
      stream.once('data', () => controller.abort(new DOMException('用户已停止执行', 'AbortError')));
    }
    return stream;
  };
  try {
    const result = await runAgent({ user: f.user, project: f.project, chat: db.prepare('SELECT * FROM chats WHERE id=?').get(f.chatId),
      messages: [{ role: 'user', content: '请修改正文并编译。' }], signal: controller.signal,
      modelConfig: { provider: 'openai', model: 'cancel-final-check-fixture', apiKey: 'synthetic',
        baseUrl: 'http://127.0.0.1:' + llm.address().port + '/v1', maxTokens: 1024, contextLength: 100000 },
      emit: event => { events.push(event); if (event.type === 'workflow' && event.graph?.currentNode === 'deliver' &&
        event.graph?.detail === '已满足当前路线的交付条件') finalGate = true; } });
    assert.equal(cancelled, true);
    assert.equal(result.status, 'cancelled');
    assert.equal(fs.readFileSync(path.join(f.projectDir, 'main.tex'), 'utf8'), original);
    assert.equal(result.changeset.applied, false);
    assert.ok(events.some(event => event.type === 'token' && /已手动停止/.test(event.text)));
    assert.ok(events.some(event => event.type === 'done' && event.state === 'cancelled'));
  } finally { fs.createReadStream = originalStream; await new Promise(resolve => llm.close(resolve)); }
});


test('a once-fingerprintable input becoming unverifiable blocks, while initially unsupported inputs remain compatible', async () => {
  const { checkCompilationFreshness } = await import('../src/services/agent/tools.js');
  const { createWorkflowGraph } = await import('../src/services/agent/workflowGraph.js');
  const f = fixture(), dependency = path.join(f.projectDir, 'refs.bib');
  fs.writeFileSync(dependency, 'before');
  fs.writeFileSync(path.join(f.markers, 'hold-engine'), '');
  const tool = getPiTools(f).find(item => item.name === 'compile_and_preview');
  const compiling = tool.execute('unverifiable', { pages: '1' });
  await waitFor(path.join(f.markers, 'engine-running'));
  fs.writeFileSync(dependency, '\\directlua{dynamic}');
  fs.writeFileSync(path.join(f.markers, 'release-engine'), '');
  const result = await compiling, evidence = f.toolEvidence.get('unverifiable');
  assert.equal(evidence.status, 'succeeded');
  assert.equal(evidence.inputsCurrent, false);
  assert.equal(evidence.inputStatus, 'unverifiable');
  assert.match(result.content[0].text, /无法重新核验/);
  const graph = createWorkflowGraph();
  graph.plan({ scenario: 'compile', summary: '核验当前版本' });
  graph.toolEnd('read_file', { succeeded: true });
  graph.toolEnd('compile_and_preview', { succeeded: true, compileEvidence: evidence });
  assert.equal(graph.getCompileBlock().code, 'COMPILE_INPUT_UNVERIFIABLE');
  assert.equal(graph.prepareCompletion().failed, true);

  const g = fixture();
  fs.writeFileSync(path.join(g.projectDir, 'main.tex'), '\\directlua{dynamic}');
  const initiallyUnknown = getPiTools(g).find(item => item.name === 'compile_and_preview');
  await initiallyUnknown.execute('unknown', { pages: '1' });
  assert.equal(g.toolEvidence.get('unknown').inputsCurrent, undefined);
  assert.equal(await checkCompilationFreshness(g), 'unknown');
});
