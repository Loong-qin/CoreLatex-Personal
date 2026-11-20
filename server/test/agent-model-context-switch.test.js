import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'corelatex-model-switch-'));
process.env.CORELATEX_DATA_DIR=dataDir;
let db, resetDb, runAgent, prepareModelContext, contextModelKey, server, calls=[], fail=false, serial=0, summaryText='摘要：保留旧目标、约束和未完成工作。', failAtCall=0;
before(async()=>{
  ({getDb:db,resetDb}=await import('../src/db.js')); db=db();
  ({runAgent}=await import('../src/services/agent/agentLoop.js'));
  ({prepareModelContext,contextModelKey}=await import('../src/services/agent/context.js'));
  server=http.createServer((req,res)=>{let raw='';req.setEncoding('utf8');req.on('data',x=>raw+=x);req.on('end',()=>{
    const body=JSON.parse(raw); calls.push(body);
    const summary=!body.tools?.length;
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    const delta={content: summary ? (fail || calls.length === failAtCall ? '' : summaryText) : '收到。'};
    res.end('data: '+JSON.stringify({choices:[{index:0,delta}]})+'\n\n'+'data: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');
  });});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
});
after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));resetDb();fs.rmSync(dataDir,{recursive:true,force:true});});
function fixture({history=true, priorSummary=''}={}) {
  const n=++serial; calls=[];fail=false;failAtCall=0;summaryText='摘要：保留旧目标、约束和未完成工作。';
  const uid=Number(db.prepare("INSERT INTO users(username,password_hash,role) VALUES(?,'unused','admin')").run('switch-'+n).lastInsertRowid);
  db.prepare('INSERT INTO settings(user_id,agent_config,chinese_support) VALUES(?,?,0)').run(uid,JSON.stringify({graphOrchestration:false,allowWebAccess:false}));
  const pid=Number(db.prepare('INSERT INTO projects(name,owner_id,public_id) VALUES(?,?,?)').run('switch',uid,'switch-'+n).lastInsertRowid);
  const cid=Number(db.prepare('INSERT INTO chats(project_id,user_id,summary) VALUES(?,?,?)').run(pid,uid,priorSummary).lastInsertRowid);
  fs.mkdirSync(path.join(dataDir,'projects',String(pid)),{recursive:true});
  if(history) for(const [role,content] of [['user','OLD_GOAL'],['assistant','OLD_DECISION']]) db.prepare('INSERT INTO chat_messages(chat_id,role,content) VALUES(?,?,?)').run(cid,role,content);
  db.prepare("INSERT INTO chat_messages(chat_id,role,content) VALUES(?,'user','CURRENT_REQUEST 请只回答收到')").run(cid);
  const modelConfig={id:'model-b',providerId:'p',provider:'openai',model:'new-model',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,apiKey:'fixture',contextLength:128000,maxTokens:2048,reasoningLevels:[]};
  const old={...modelConfig,id:'model-a',model:'old-model'};
  db.prepare('UPDATE chats SET context_model_key=? WHERE id=?').run(contextModelKey(old),cid);
  return {user:db.prepare('SELECT * FROM users WHERE id=?').get(uid),project:db.prepare('SELECT * FROM projects WHERE id=?').get(pid),chat:db.prepare('SELECT * FROM chats WHERE id=?').get(cid),messages:db.prepare('SELECT * FROM chat_messages WHERE chat_id=? ORDER BY id').all(cid),modelConfig,events:[],db};
}
test('switching models summarizes with the new model before any normal work and persists the handoff',async()=>{
  const f=fixture();const result=await runAgent({...f,emit:e=>f.events.push(e)});
  assert.equal(result.status,'completed');assert.equal(calls.length,2);
  assert.equal(calls[0].model,'new-model');assert.ok(!calls[0].tools?.length);
  assert.match(JSON.stringify(calls[0].messages),/OLD_GOAL/);assert.doesNotMatch(JSON.stringify(calls[0].messages),/CURRENT_REQUEST/);
  assert.ok(calls[1].tools.length);assert.match(JSON.stringify(calls[1].messages),/CURRENT_REQUEST/);
  assert.doesNotMatch(JSON.stringify(calls[1].messages),/OLD_DECISION/);
  assert.match(JSON.stringify(calls[1].messages),/保留旧目标/);
  const saved=db.prepare('SELECT * FROM chats WHERE id=?').get(f.chat.id);
  assert.equal(saved.context_model_key,contextModelKey(f.modelConfig));assert.equal(saved.summary_msg_id,f.messages[1].id);
  const steps=JSON.parse(db.prepare('SELECT steps FROM chat_messages WHERE id=?').get(result.messageId).steps);
  assert.ok(steps.some(s=>s.phase==='context_compaction'));
  const ledger=steps.find(s=>s.type==='workflow').graph.accounting;
  assert.equal(ledger.requests.length,calls.length); assert.equal(ledger.requests[0].phase,'history_compaction');
  assert.equal(db.prepare('SELECT content FROM chat_messages WHERE id=?').get(f.messages[0].id).content,'OLD_GOAL');
});
test('changing reasoning alone or output limit does not trigger model handoff',async()=>{
  const f=fixture();db.prepare('UPDATE chats SET context_model_key=? WHERE id=?').run(contextModelKey(f.modelConfig),f.chat.id);
  const result=await prepareModelContext({...f,modelConfig:{...f.modelConfig,reasoningEffort:'max',maxTokens:4096}});
  assert.equal(result.modelChanged,false);assert.equal(result.compressed,false);assert.equal(calls.length,0);
});
test('switching back to an older model triggers another handoff',async()=>{
  const f=fixture();await prepareModelContext(f);
  calls=[];const updated=db.prepare('SELECT * FROM chats WHERE id=?').get(f.chat.id);
  const result=await prepareModelContext({...f,chat:updated,messages:[f.messages.at(-1)],modelConfig:{...f.modelConfig,id:'model-a',model:'old-model'}});
  assert.equal(result.modelChanged,true);assert.equal(calls[0].model,'old-model');assert.match(JSON.stringify(calls[0]),/先前保存的历史摘要/);
});
test('new empty conversations skip unnecessary summaries but remember the selected model',async()=>{
  const f=fixture({history:false});const result=await prepareModelContext(f);
  assert.equal(result.compressed,false);assert.equal(calls.length,0);
  assert.equal(db.prepare('SELECT context_model_key k FROM chats WHERE id=?').get(f.chat.id).k,contextModelKey(f.modelConfig));
});
test('summary failure preserves old context identity, cutoff, history and prevents business execution',async()=>{
  const f=fixture({priorSummary:'ORIGINAL_SUMMARY'});fail=true;
  await assert.rejects(runAgent({...f,emit:e=>f.events.push(e)}),/摘要为空/);
  assert.equal(calls.length,1);assert.ok(!calls[0].tools?.length);
  const saved=db.prepare('SELECT * FROM chats WHERE id=?').get(f.chat.id);
  assert.equal(saved.summary,'ORIGINAL_SUMMARY');assert.equal(saved.summary_msg_id,0);assert.equal(saved.context_model_key,f.chat.context_model_key);
  fail=false;await prepareModelContext(f);assert.equal(calls.length,2);
});
test('pre-cancelled handoff neither calls a model nor updates the saved identity',async()=>{
  const f=fixture();const ctrl=new AbortController();ctrl.abort();
  await assert.rejects(prepareModelContext({...f,signal:ctrl.signal}),{name:'AbortError'});
  assert.equal(calls.length,0);assert.equal(db.prepare('SELECT context_model_key k FROM chats WHERE id=?').get(f.chat.id).k,f.chat.context_model_key);
});
test('model identity is per conversation and excludes credentials, labels and reasoning',()=>{
  const f=fixture();assert.equal(contextModelKey(f.modelConfig),contextModelKey({...f.modelConfig,apiKey:'changed',name:'renamed',reasoningEffort:'low'}));
  for(const change of [{id:'another'},{providerId:'other'},{model:'other'},{baseUrl:'https://another/v1'}]) assert.notEqual(contextModelKey(f.modelConfig),contextModelKey({...f.modelConfig,...change}));
});

test('switching into a smaller context batches all earlier content without dropping history', async()=>{
  const f=fixture({priorSummary:'PREVIOUS_SUMMARY_MARKER'});
  const long=Array.from({length:12},(_,i)=>`UNIQUE_HISTORY_MARKER_${i} `+'x'.repeat(1000)).join('\n');
  f.messages[0].content=long;
  const result=await prepareModelContext({...f,modelConfig:{...f.modelConfig,contextLength:4096,maxTokens:512}});
  assert.equal(result.compressed,true);assert.ok(calls.length>1);
  const sent=JSON.stringify(calls);
  for(let i=0;i<12;i++) assert.ok(sent.includes(`UNIQUE_HISTORY_MARKER_${i}`));
  assert.match(sent,/PREVIOUS_SUMMARY_MARKER/);assert.doesNotMatch(sent,/CURRENT_REQUEST/);
  assert.deepEqual(result.messages,[f.messages.at(-1)]);
  assert.ok(calls.every(call=>call.model==='new-model' && !call.tools?.length));
});

test('1024-token handoff includes rolling summaries, prompt and output in every real HTTP request budget', async()=>{
  const f=fixture();
  const oldText='OLD_CONSTRAINT_BEGIN '+Array.from({length:600},(_,i)=>String(i).padStart(4,'0')).join(' ')+' OLD_CONSTRAINT_END';
  f.messages[0].content=oldText;
  f.messages.splice(1,1);
  summaryText='s'.repeat(800); // ~200 tokens, within the requested 204-token output.
  const result=await prepareModelContext({...f,maxTokens:512,modelConfig:{...f.modelConfig,contextLength:1024,maxTokens:512}});
  assert.ok(calls.length>2);
  let replayed='';
  for (const call of calls) {
    const textOf=content=>typeof content==='string' ? content : content.filter(x=>x.type==='text').map(x=>x.text).join('');
    const input=call.messages.reduce((total,message)=>total+Math.ceil(textOf(message.content).length/4),0);
    const output=call.max_tokens ?? call.max_completion_tokens;
    assert.equal(output,204);
    assert.ok(input+output<=1024, `actual HTTP payload ${input} + output ${output} exceeds 1024`);
    const prompt=textOf(call.messages.find(message=>message.role==='user').content);
    const conversation=prompt.match(/<conversation>\n([\s\S]*?)\n<\/conversation>/)[1];
    replayed+=conversation.replace(/^\[User\]: /,'').replace(/^\[同一历史消息的连续分段\]\n/,'');
    assert.doesNotMatch(prompt,/CURRENT_REQUEST/);
  }
  assert.equal(replayed,oldText);
  assert.deepEqual(result.messages,[f.messages.at(-1)]);
  assert.equal(result.historySummary,summaryText);
});

test('failure after an initial small-window summary preserves the original summary, cutoff and model identity', async()=>{
  const f=fixture({priorSummary:'ORIGINAL_SUMMARY'});
  f.messages[0].content='history '.repeat(800);
  summaryText='s'.repeat(800);failAtCall=2;
  await assert.rejects(prepareModelContext({...f,maxTokens:512,modelConfig:{...f.modelConfig,contextLength:1024,maxTokens:512}}),/摘要为空/);
  assert.equal(calls.length,2);
  const saved=db.prepare('SELECT * FROM chats WHERE id=?').get(f.chat.id);
  assert.equal(saved.summary,'ORIGINAL_SUMMARY');
  assert.equal(saved.summary_msg_id,0);
  assert.equal(saved.context_model_key,f.chat.context_model_key);
});

for (const mode of ['forced handoff', 'automatic compaction']) {
  test(`1024-token ${mode} budgets every Chinese history chunk and preserves its text`, async () => {
    const priorSummary = mode === 'automatic compaction' ? '已有研究结论🌏与未完成任务。'.repeat(55) : '';
    const f = fixture({ priorSummary });
    const oldText = '第一段👩‍🔬保留用户约束。'.repeat(65) + '结束🚀';
    f.messages[0].content = oldText;
    f.messages.splice(1, 1);
    const modelConfig = { ...f.modelConfig, contextLength: 1024, maxTokens: 512 };
    if (mode === 'automatic compaction') {
      db.prepare('UPDATE chats SET context_model_key=? WHERE id=?').run(contextModelKey(modelConfig), f.chat.id);
    }
    summaryText = '保留约束和结论。'.repeat(15);
    const result = await prepareModelContext({ ...f, modelConfig });
    assert.equal(result.modelChanged, mode === 'forced handoff');
    assert.ok(result.compressed);
    assert.ok(calls.length > 2);

    let replayed = '';
    for (const call of calls) {
      const textOf = content => typeof content === 'string' ? content : content.filter(block => block.type === 'text').map(block => block.text).join('');
      const tokenEstimate = text => Math.ceil([...text].reduce((total, char) => total + (char.codePointAt(0) <= 127 ? 0.25 : 1.5), 0));
      const input = call.messages.reduce((total, message) => total + 8 + tokenEstimate(textOf(message.content)), 8);
      const output = call.max_tokens ?? call.max_completion_tokens;
      assert.equal(output, 204);
      assert.ok(input + output <= 1024, `Chinese HTTP payload ${input} + output ${output} exceeds 1024`);
      const prompt = textOf(call.messages.find(message => message.role === 'user').content);
      assert.doesNotMatch(prompt, /[\uD800-\uDFFF]/u);
      assert.doesNotMatch(prompt, /CURRENT_REQUEST/);
      const conversation = prompt.match(/<conversation>\n([\s\S]*?)\n<\/conversation>/)[1];
      replayed += conversation.replace(/(?:^|\n\n)\[User\]: /g, '').replaceAll('[同一历史消息的连续分段]\n', '');
    }
    assert.equal(replayed, (priorSummary ? `先前保存的历史摘要：\n${priorSummary}` : '') + oldText);
    assert.deepEqual(result.messages, [f.messages.at(-1)]);
    assert.equal(result.historySummary, summaryText);
  });
}

test('a one-token output limit is retained on the HTTP summary request', async () => {
  const f = fixture();
  summaryText = 'a';
  await prepareModelContext({ ...f, modelConfig: { ...f.modelConfig, contextLength: 1024, maxTokens: 1 } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].max_tokens ?? calls[0].max_completion_tokens, 1);
});
