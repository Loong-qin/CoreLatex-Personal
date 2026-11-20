import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'corelatex-chinese-alignment-'));
process.env.CORELATEX_DATA_DIR = dataDir;
const savedPath = process.env.PATH;
const originalEnglish = 'Our method compares the predictions of several independent models on each sample.';
const originalChinese = '% 我们的方法比较多个独立模型对每个样本的预测。';
const revisedEnglish = 'Our method compares the predictions of several independent models on each sample and records their disagreements for further analysis.';
const revisedChinese = '% 我们的方法比较多个独立模型对每个样本的预测，并记录它们之间的分歧以供进一步分析。';
const synonymEnglish = 'Our approach compares the predictions of several independent models on each sample.';
const originalParagraph = originalEnglish + '\n' + originalChinese;
const document = paragraph => '\\documentclass{article}\n\\begin{document}\n\n' + paragraph + '\n\n\\end{document}\n';
const messageText = message => typeof message.content === 'string' ? message.content : (message.content || []).filter(p => p.type === 'text').map(p => p.text).join('\n');
let dbModule, db, runAgent, llm, user, mode, requests, payloads;
const sse = value => 'data: ' + JSON.stringify({ choices: [{ index: 0, ...value }] }) + '\n\n';
const text = (res, content) => res.end(sse({ delta: { content } }) + sse({ delta: {}, finish_reason: 'stop' }) + 'data: [DONE]\n\n');
const tool = (res, name, args) => res.end(sse({ delta: { tool_calls: [{ index: 0, id: 'call_' + requests, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }) + sse({ delta: {}, finish_reason: 'tool_calls' }) + 'data: [DONE]\n\n');

before(async () => {
  // A deterministic successful compiler isolates the normal TeX verification
  // step from the removed translation-review loop. No production files/tools.
  const bin = path.join(dataDir, 'bin'); fs.mkdirSync(bin);
  const binary = (name, body) => fs.writeFileSync(path.join(bin, name), '#!/usr/bin/env node\n' + body, { mode: 0o755 });
  process.env.PATH = [bin, path.dirname(process.execPath), savedPath].join(path.delimiter);
  binary('pdflatex', String.raw`const fs=require('node:fs');fs.mkdirSync('.build',{recursive:true});fs.writeFileSync('.build/main.pdf','%PDF fixture');fs.writeFileSync('.build/main.log','Output written on main.pdf.');`);
  binary('pdfinfo', "console.log('Pages: 1');");
  binary('pdftoppm', "require('node:fs').writeFileSync(process.argv.at(-1)+'-1.jpg',Buffer.from([255,216,255,217]));");
  dbModule = await import('../src/db.js'); db = dbModule.getDb();
  ({ runAgent } = await import('../src/services/agent/agentLoop.js'));
  const uid = Number(db.prepare("INSERT INTO users(username,password_hash,role) VALUES('chinese-alignment-owner','unused','admin')").run().lastInsertRowid);
  user = db.prepare('SELECT * FROM users WHERE id=?').get(uid); db.prepare('INSERT INTO settings(user_id) VALUES(?)').run(uid);
  llm = http.createServer((req, res) => {
    let raw = ''; req.on('data', value => raw += value); req.on('end', () => {
      requests++; const payload = JSON.parse(raw); payloads.push(payload);
      const calls = payload.messages.filter(m => m.role === 'assistant').flatMap(m => m.tool_calls || []);
      const count = name => calls.filter(c => c.function.name === name).length;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (mode === 'prompt') return text(res, '会根据你的要求提供对应翻译。');
      if (!count('read_file')) return tool(res, 'read_file', { path: 'main.tex' });
      if (!count('edit_file')) {
        const keepExisting = ['stale-comment', 'preserve-existing', 'english-only'].includes(mode);
        const replacement = mode === 'synchronized' ? revisedEnglish + '\n' + revisedChinese
          : mode === 'preserve-existing' ? synonymEnglish : revisedEnglish;
        return tool(res, 'edit_file', { path: 'main.tex', search: keepExisting ? originalEnglish : originalParagraph, replace: replacement });
      }
      if (!count('compile_and_preview')) return tool(res, 'compile_and_preview', { pages: '1' });
      return text(res, '已修改 main.tex。');
    });
  });
  await new Promise(resolve => llm.listen(0, '127.0.0.1', resolve));
});
after(async () => {
  if (llm) { llm.closeAllConnections(); await new Promise(resolve => llm.close(resolve)); }
  dbModule?.resetDb(); process.env.PATH = savedPath;
  assert.ok(dataDir.startsWith(path.join(os.tmpdir(), 'corelatex-chinese-alignment-')));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function run(scenario) {
  mode = scenario; requests = 0; payloads = [];
  db.prepare('UPDATE settings SET chinese_support=?,agent_config=? WHERE user_id=?')
    .run(scenario === 'off' ? 0 : 1, JSON.stringify({ graphOrchestration: false, confirmBeforeApply: false }), user.id);
  const pid = Number(db.prepare('INSERT INTO projects(name,owner_id,public_id,compile_engine) VALUES(?,?,?,?)').run('Chinese fixture', user.id, randomUUID(), 'pdflatex').lastInsertRowid);
  const cid = Number(db.prepare('INSERT INTO chats(project_id,user_id) VALUES(?,?)').run(pid, user.id).lastInsertRowid);
  const dir = path.join(dataDir, 'projects', String(pid)); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'main.tex'), document(scenario === 'english-only' ? originalEnglish : originalParagraph));
  const userRequest = scenario === 'english-only' ? '本轮只修改英文，不要新增或修改中文注释。'
    : scenario === 'preserve-existing' ? '请修改英文，现有中文注释保持不变。' : '请按要求修改文稿。';
  const events = [];
  const result = await runAgent({ user, project: db.prepare('SELECT * FROM projects WHERE id=?').get(pid), chat: db.prepare('SELECT * FROM chats WHERE id=?').get(cid),
    messages: [{ role: 'user', content: userRequest }],
    modelConfig: { provider: 'openai', model: 'chinese-alignment-mock', apiKey: 'synthetic', baseUrl: 'http://127.0.0.1:' + llm.address().port + '/v1', maxTokens: 1024, contextLength: 100000 },
    emit: event => events.push(event) });
  const row = db.prepare('SELECT * FROM chat_messages WHERE id=?').get(result.messageId);
  const steps = JSON.parse(row.steps);
  return { result, events, row, steps, userRequest, disk: fs.readFileSync(path.join(dir, 'main.tex'), 'utf8'),
    graph: steps.find(step => step.type === 'workflow')?.graph };
}
function assertNoTranslationFollowups() {
  for (const payload of payloads) {
    assert.equal(payload.tools.some(tool => tool.function.name === 'set_chinese_alignment_scope'), false);
    assert.equal(payload.tools.some(tool => tool.function.name === 'submit_agent_report'), false);
    const injected = payload.messages.filter(message => message.role === 'user').map(messageText);
    assert.ok(injected.every(text => !/【中英逐段对照检查】|中英对照检查未通过/.test(text)));
  }
}
function assertOrdinaryEdit(f, expected) {
  assert.equal(f.result.status, 'completed'); assert.equal(requests, 4);
  assert.equal(f.disk, document(expected)); assert.equal(f.result.changeset.applied, true);
  assert.deepEqual(f.steps.filter(step => step.type === 'tool').map(step => step.name), ['read_file', 'edit_file', 'compile_and_preview']);
  assert.equal(f.graph.version, 4); assert.equal(f.graph.validation.version, 1); assert.equal(f.graph.status, 'completed');
  assert.equal(f.graph.nodes.find(node => node.id === 'verify').status, 'completed');
  assert.equal(f.steps.some(step => step.agentId || step.chineseAlignmentScope), false);
  assertNoTranslationFollowups();
}

test('Chinese support supplies complete faithful synchronized-edit guidance in the first request only', async () => {
  const f = await run('prompt'); assert.equal(f.result.status, 'completed'); assert.equal(requests, 1);
  const prompt = messageText(payloads[0].messages[0]);
  assert.match(prompt, /中英文同步编辑（已开启）/); assert.match(prompt, /同一次编辑.*完整中文注释/);
  assert.match(prompt, /忠实对应每个分句/); assert.match(prompt, /用户明确指定的语言、格式或翻译范围优先/);
  assert.doesNotMatch(prompt, /概括该段含义/);
  assert.equal(payloads[0].tools.some(tool => tool.function.name === 'plan_task_graph'), false);
  assertNoTranslationFollowups();
});
test('a synchronized English and Chinese edit is applied in the normal read-edit-compile path', async () => {
  assertOrdinaryEdit(await run('synchronized'), revisedEnglish + '\n' + revisedChinese);
});
test('omitted Chinese is not repaired by hidden extra model rounds after the ordinary edit', async () => {
  assertOrdinaryEdit(await run('missing-comment'), revisedEnglish);
});
test('changed English with unchanged Chinese does not trigger a separate review agent or followup', async () => {
  assertOrdinaryEdit(await run('stale-comment'), revisedEnglish + '\n' + originalChinese);
});
test('turning Chinese support off uses the same ordinary path without the translation system prompt', async () => {
  assertOrdinaryEdit(await run('off'), revisedEnglish);
  assert.doesNotMatch(messageText(payloads[0].messages[0]), /中英文同步编辑（已开启）/);
});
test('an explicit English-only request is preserved and needs no scope tool or extra translation check', async () => {
  const f = await run('english-only'); assertOrdinaryEdit(f, revisedEnglish);
  assert.ok(payloads[0].messages.some(message => message.role === 'user' && messageText(message).includes(f.userRequest)));
});
test('explicitly preserving existing comments leaves them untouched without a translation-check turn', async () => {
  const f = await run('preserve-existing'); assertOrdinaryEdit(f, synonymEnglish + '\n' + originalChinese);
  assert.ok(payloads[0].messages.some(message => message.role === 'user' && messageText(message).includes(f.userRequest)));
});
