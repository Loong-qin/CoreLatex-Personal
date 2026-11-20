import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import WebSocket from 'ws';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as syncProtocol from 'y-protocols/sync';
import { startTestServer, api, registerAndLogin } from './helpers.js';

let srv, llm, owner, other, project, db, runs;
let mode = 'immediate';
let held = [];
let wire = [];
const sockets = new Set();
const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const finish = (res, text = 'Completed mock response.') => res.end(
  sse({ choices: [{ index: 0, delta: { content: text } }] })
  + sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n');
const events = (text) => text.split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)));
const endpoint = (suffix) => `/api/projects/${project.publicId}${suffix}`;
const call = (method, suffix, body, token = owner.token) => api(srv.baseUrl, method, endpoint(suffix), { token, body });
const waitUntil = async (predicate) => {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error('Timed out waiting for isolated mock state');
};
async function postChat(message) {
  return fetch(srv.baseUrl + endpoint('/agent/chat'), {
    method: 'POST', headers: { Authorization: `Bearer ${owner.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ message }),
  });
}
function fixtureChat() {
  const id = Number(db.prepare('INSERT INTO chats(project_id,user_id) VALUES(?,?)').run(project.id, owner.user.id).lastInsertRowid);
  return id;
}

before(async () => {
  llm = http.createServer((req, res) => {
    let body = '';
    req.on('data', (data) => { body += data; });
    req.on('end', () => {
      const value = JSON.parse(body); wire.push(value);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (mode === 'hold') held.push(res);
      else if (mode === 'isolated-final') {
        const corrected = value.messages.some((m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('PROJECT_B_CORRECTION_ONLY'));
        finish(res, corrected ? 'PROJECT_B_RESULT_ONLY_AFTER_CORRECTION' : 'UNEXPECTED_MISSING_CORRECTION');
      }
      else if ((mode === 'question' && !value.messages.some((m) => m.role === 'tool')) || (mode === 'two-questions' && value.messages.filter(m => m.role === 'tool').length < 2)) {
        const number = value.messages.filter(m => m.role === 'tool').length;
        res.end(sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `question_tool_${number}`, type: 'function', function: { name: 'ask_user', arguments: JSON.stringify({ question: number ? 'Select output format' : 'Select output style', options: ['Concise', 'Detailed'] }) } }] } }] })
          + sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }) + 'data: [DONE]\n\n');
      } else finish(res);
    });
  });
  await new Promise((r) => llm.listen(0, '127.0.0.1', r));
  srv = await startTestServer();
  ({ getDb: db } = await import('../src/db.js')); db = db();
  runs = await import('../src/services/agent/runs.js');
  owner = await registerAndLogin(srv.baseUrl, 'runs-owner');
  other = await registerAndLogin(srv.baseUrl, 'runs-other');
  project = (await api(srv.baseUrl, 'POST', '/api/projects', { token: owner.token, body: { name: 'run-state-test' } })).data.project;
  await call('POST', '/members', { username: 'runs-other', role: 'editor' });
  const settings = await api(srv.baseUrl, 'PUT', '/api/settings/ai', { token: owner.token, body: {
    provider: 'openai', baseUrl: `http://127.0.0.1:${llm.address().port}/v1`, apiKey: 'test-only', model: 'gpt-mock',
  } });
  assert.equal(settings.status, 200);
});

after(async () => {
  for (const socket of sockets) socket.terminate();
  for (const run of db.prepare("SELECT id FROM agent_runs WHERE state IN ('running','waiting_for_user','cancelling')").all()) await runs.cancelRun(run.id);
  llm.closeAllConnections(); await new Promise((r) => llm.close(r));
  srv.server.closeAllConnections(); await srv.close();
});

test('disconnect does not cancel; replay is ordered and duplicate chat cannot start', async () => {
  mode = 'hold'; held = []; wire = [];
  const res = await postChat('Keep working through a disconnect');
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  const first = events(new TextDecoder().decode((await reader.read()).value));
  const runId = first.find((e) => e.type === 'run').runId;
  await waitUntil(() => held.length === 1);
  await reader.cancel();
  assert.equal((await call('GET', '/agent/runs/active')).data.run.id, runId);
  const duplicate = await call('POST', '/agent/chat', { message: 'Must not start a second run' });
  assert.equal(duplicate.status, 409);
  assert.equal(wire.length, 1);
  const replay = await fetch(srv.baseUrl + endpoint(`/agent/runs/${runId}/events?after=${first.at(-1).seq}`), { headers: { Authorization: `Bearer ${owner.token}` } });
  mode = 'immediate'; finish(held[0]);
  const rest = events(await replay.text());
  assert.ok(rest.some((e) => e.type === 'token' && e.text.includes('Completed')));
  assert.equal(rest.at(-1).type, 'done'); assert.equal(rest.at(-1).state, 'completed');
  const seqs = [...first, ...rest].map((e) => e.seq);
  assert.deepEqual(seqs, [...new Set(seqs)].sort((a, b) => a - b));
  assert.ok(rest.every((e) => e.runId === runId));
  const noActive = await call('GET', '/agent/runs/active'); assert.equal(noActive.data.run, null);
  const full = await fetch(srv.baseUrl + endpoint(`/agent/runs/${runId}/events`), { headers: { Authorization: `Bearer ${owner.token}` } });
  assert.equal(events(await full.text()).at(-1).state, 'completed');
  assert.equal((await call('GET', `/agent/runs/${runId}/events`, undefined, other.token)).status, 404);
  assert.equal((await call('POST', `/agent/runs/${runId}/cancel`, {}, other.token)).status, 404);
});

test('independent cancellation waits for completion and clear removes completed audit only after cancellation', async () => {
  mode = 'hold'; held = [];
  const res = await postChat('Cancel this held request'); const body = res.text();
  await waitUntil(() => held.length === 1);
  const runId = (await call('GET', '/agent/runs/active')).data.run.id;
  const cancelled = await call('POST', `/agent/runs/${runId}/cancel`, {});
  assert.equal(cancelled.data.run.state, 'cancelled');
  assert.equal(events(await body).at(-1).state, 'cancelled');
  const replay = await fetch(srv.baseUrl + endpoint(`/agent/runs/${runId}/events`), { headers: { Authorization: `Bearer ${owner.token}` } });
  assert.ok(events(await replay.text()).some((e) => e.type === 'run' && e.state === 'cancelling'));
  held = [];
  const again = await postChat('Clear during execution'); const againBody = again.text();
  await waitUntil(() => held.length === 1);
  assert.equal((await call('DELETE', '/chat')).status, 200);
  assert.equal(events(await againBody).at(-1).state, 'cancelled');
  assert.equal((await call('GET', '/chat')).data.messages.length, 0);
  assert.equal((await call('GET', '/agent/runs/active')).data.run, null);
  mode = 'immediate';
});

test('question, answer, queued input and sealInputs use one owned run', async () => {
  const chatId = fixtureChat();
  const run = runs.createRun({ projectId: project.id, chatId, userId: owner.user.id });
  const assistantId = Number(db.prepare("INSERT INTO chat_messages(chat_id,role,content) VALUES(?,'assistant','')").run(chatId).lastInsertRowid);
  run.control.setMessageId(assistantId);
  assert.equal(runs.runSnapshot(run.id).messageId, assistantId);
  assert.throws(() => runs.createRun({ projectId: project.id, chatId, userId: owner.user.id }), /运行中/);
  let answer;
  const done = runs.startRun(run, async () => {
    answer = await run.control.askUser({ question: 'Which format?', options: ['A', 'B'] });
    const inputs = await run.control.takeInputs(); assert.equal(inputs[0].content, 'Use fewer words');
    assert.equal(run.control.sealInputs(), true);
    assert.throws(() => runs.queueRunInput(run.id, 'Too late'), /已结束/);
    return { status: 'completed' };
  });
  const waiting = (await call('GET', '/agent/runs/active')).data.run;
  assert.equal(waiting.state, 'waiting_for_user'); assert.equal(waiting.question.question, 'Which format?');
  const queued = await call('POST', `/agent/runs/${run.id}/input`, { message: 'Use fewer words' }); assert.equal(queued.status, 200);
  assert.equal(run.control.sealInputs(), false);
  assert.equal((await call('POST', `/agent/runs/${run.id}/answer`, { questionId: 'stale', answer: 'A' })).status, 409);
  const accepted = await call('POST', `/agent/runs/${run.id}/answer`, { questionId: waiting.question.questionId, answer: 'B' }); assert.equal(accepted.status, 200);
  await done; assert.equal(answer, 'B');
  const history = db.prepare('SELECT content FROM chat_messages WHERE chat_id = ? ORDER BY id').all(chatId);
  assert.equal(history.length, 3); assert.match(history[2].content, /Which format/);
  const logged = []; runs.observeRun(run.id, 0, (e) => logged.push(e));
  assert.ok(logged.find((e) => e.type === 'run' && e.messageId === assistantId));
  assert.ok(logged.find((e) => e.type === 'input').chatMessageId);
  assert.ok(logged.find((e) => e.type === 'answer').chatMessageId);
  assert.ok(logged.some((e) => e.type === 'input_consumed'));
});

test('cancel rejects a pending question and failed agent result remains failed', async () => {
  const chatId = fixtureChat();
  const run = runs.createRun({ projectId: project.id, chatId, userId: owner.user.id });
  const work = runs.startRun(run, async () => {
    await run.control.askUser({ question: 'Wait for answer' });
    assert.fail('Cancelled question must not resume');
  });
  const result = await runs.cancelRun(run.id); await work;
  assert.equal(result.state, 'cancelled'); assert.equal(result.question, null);
  const next = runs.createRun({ projectId: project.id, chatId, userId: owner.user.id });
  await runs.startRun(next, async () => ({ status: 'failed' }));
  assert.equal(runs.runSnapshot(next.id).state, 'failed');
});

test('clear holds the chat lock until work and cancellation finalization have finished', async () => {
  const chatId = fixtureChat();
  const run = runs.createRun({ projectId: project.id, chatId, userId: owner.user.id });
  let stopped = false;
  runs.startRun(run, async () => {
    await new Promise((resolve) => run.controller.signal.addEventListener('abort', () => setTimeout(resolve, 25), { once: true }));
    stopped = true;
    db.prepare("INSERT INTO chat_messages(chat_id,role,content) VALUES(?,'assistant','final cancelled audit')").run(chatId);
    return { status: 'cancelled' };
  });
  const clear = runs.clearChatAfterCancellation(chatId);
  assert.throws(() => runs.createRun({ projectId: project.id, chatId, userId: owner.user.id }), /清空/);
  await clear; assert.equal(stopped, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM chat_messages WHERE chat_id = ?').get(chatId).n, 0);
  assert.equal(runs.getRun(run.id), undefined);
});

test('model ask_user and live correction reach the same run, then replay before its report', async () => {
  await call('DELETE', '/chat');
  const chatId = (await call('GET', '/chat')).data.chatId;
  mode = 'question'; wire = [];
  const response = await postChat('Ask me to choose an output style');
  const stream = response.text();
  await waitUntil(() => runs.activeRunForChat(chatId)?.state === 'waiting_for_user');
  const waiting = (await call('GET', '/agent/runs/active')).data.run;
  assert.equal(waiting.question.question, 'Select output style');
  await call('POST', `/agent/runs/${waiting.id}/input`, { message: 'MID-RUN-CORRECTION: use fewer words' });
  await call('POST', `/agent/runs/${waiting.id}/answer`, { questionId: waiting.question.questionId, answer: 'Concise' });
  const received = events(await stream);
  assert.equal(received.at(-1).state, 'completed');
  assert.ok(received.some((e) => e.type === 'question'));
  assert.ok(wire.some((request) => request.messages.some((m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('MID-RUN-CORRECTION'))));
  assert.ok(wire.some((request) => request.messages.some((m) => m.role === 'tool' && String(m.content).includes('Concise'))));
  const messages = (await call('GET', '/chat')).data.messages;
  assert.equal(messages.at(-1).role, 'assistant', 'The completed report follows every consumed answer and correction');
  const answers = messages.filter(m => m.inputKind === 'answer');
  const steering = messages.find(m => m.inputKind === 'steering');
  assert.equal(answers.length, 1); assert.equal(answers[0].inputText, 'Concise');
  assert.equal(answers[0].question, 'Select output style'); assert.equal(answers[0].questionId, waiting.question.questionId);
  for (const input of [answers[0], steering]) {
    assert.equal(input.runId, waiting.id); assert.equal(input.parentMessageId, messages.at(-1).id);
    assert.equal(input.runState, 'completed'); assert.equal(input.consumed, true);
  }
  const beforeRetry = wire.length;
  const receipt = await call('POST', `/agent/runs/${waiting.id}/answer`, { questionId: waiting.question.questionId, answer: 'Concise' });
  assert.equal(receipt.status, 200); assert.equal(receipt.data.run.state, 'completed');
  assert.equal(receipt.data.answer.chatMessageId, answers[0].id);
  assert.deepEqual((await call('GET', '/chat')).data.messages, messages);
  assert.equal(wire.length, beforeRetry, 'Acknowledging an accepted answer does not call the model again');
  assert.equal((await call('POST', `/agent/runs/${waiting.id}/answer`, { questionId: waiting.question.questionId, answer: 'Different' })).status, 409);

  mode = 'immediate'; wire = [];
  await (await postChat('Next independent question')).text();
  const history = wire[0].messages;
  const correctionIndex = history.findIndex((m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('MID-RUN-CORRECTION'));
  const answerIndex = history.findIndex((m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('[回答]'));
  const reportIndex = history.findIndex((m) => m.role === 'assistant' && typeof m.content === 'string' && m.content.includes('Completed mock response'));
  assert.ok(correctionIndex >= 0 && correctionIndex < reportIndex);
  assert.ok(answerIndex >= 0 && answerIndex < reportIndex);
});

test('consecutive questions stay in one run and retries never dismiss a newer question', async () => {
  await call('DELETE', '/chat');
  const chatId = (await call('GET', '/chat')).data.chatId;
  mode = 'two-questions'; wire = [];
  const response = await postChat('Ask two clarification questions and then finish');
  const stream = response.text();
  await waitUntil(() => runs.activeRunForChat(chatId)?.state === 'waiting_for_user');
  const first = runs.runSnapshot(runs.activeRunForChat(chatId).id);
  const accepted = await call('POST', `/agent/runs/${first.id}/answer`, { questionId: first.question.questionId, answer: 'Concise' });
  assert.equal(accepted.status, 200); assert.equal(accepted.data.answer.inputKind, 'answer');
  assert.equal(accepted.data.answer.inputText, 'Concise'); assert.equal(accepted.data.answer.consumed, true);
  await waitUntil(() => runs.runSnapshot(first.id)?.question?.questionId && runs.runSnapshot(first.id).question.questionId !== first.question.questionId);
  const second = runs.runSnapshot(first.id);
  const duplicate = await call('POST', `/agent/runs/${first.id}/answer`, { questionId: first.question.questionId, answer: 'Concise' });
  assert.equal(duplicate.status, 200); assert.equal(duplicate.data.run.question.questionId, second.question.questionId);
  assert.equal(wire.length, 2);
  await call('POST', `/agent/runs/${first.id}/answer`, { questionId: second.question.questionId, answer: 'Markdown' });
  assert.equal(events(await stream).at(-1).state, 'completed');
  const history = (await call('GET', '/chat')).data.messages;
  assert.deepEqual(history.map(m => m.role), ['user','user','user','assistant']);
  assert.deepEqual(history.filter(m => m.inputKind === 'answer').map(m => m.inputText), ['Concise','Markdown']);
  assert.equal(history.at(-1).runId, first.id); assert.equal(history.at(-1).runState, 'completed');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agent_runs WHERE chat_id=?').get(chatId).n, 1);
  const count = wire.length; assert.equal(count, 3);
  await call('GET', '/chat'); await call('GET', '/agent/runs/active');
  assert.equal(wire.length, count, 'History recovery has no new model request');
  mode = 'immediate';
});

test('unconsumed steering survives cancellation as an explicitly unhandled trailing message', async () => {
  const chatId = fixtureChat();
  const run = runs.createRun({ projectId: project.id, chatId, userId: owner.user.id });
  const assistantId = Number(db.prepare("INSERT INTO chat_messages(chat_id,role,content) VALUES(?,'assistant','Stopped before consuming input')").run(chatId).lastInsertRowid);
  run.control.setMessageId(assistantId);
  runs.startRun(run, async () => {
    await new Promise(resolve => run.controller.signal.addEventListener('abort', resolve, { once:true }));
    return { status:'cancelled' };
  });
  const response = await call('POST', `/agent/runs/${run.id}/input`, { message:'This correction is still unhandled' });
  assert.equal(response.data.input.inputKind, 'steering'); assert.equal(response.data.input.consumed, false);
  assert.equal(response.data.input.parentMessageId, assistantId);
  await runs.cancelRun(run.id);
  const messages = (await call('GET', '/chat')).data.messages;
  assert.equal(messages.at(-1).id, response.data.input.chatMessageId);
  assert.equal(messages.at(-1).consumed, false); assert.equal(messages.at(-1).runState, 'cancelled');
});

test('legacy persisted events recover ownership without guessing from user text or requiring new columns', async () => {
  const chatId = fixtureChat();
  const request = Number(db.prepare("INSERT INTO chat_messages(chat_id,role,content) VALUES(?,'user','Original request')").run(chatId).lastInsertRowid);
  const assistant = Number(db.prepare("INSERT INTO chat_messages(chat_id,role,content) VALUES(?,'assistant','Legacy completed report')").run(chatId).lastInsertRowid);
  const answer = Number(db.prepare("INSERT INTO chat_messages(chat_id,role,content) VALUES(?,'user','[回答] Which style?\nConcise')").run(chatId).lastInsertRowid);
  const correction = Number(db.prepare("INSERT INTO chat_messages(chat_id,role,content) VALUES(?,'user','Legacy consumed correction')").run(chatId).lastInsertRowid);
  const ordinary = Number(db.prepare("INSERT INTO chat_messages(chat_id,role,content) VALUES(?,'user','[回答] This is a new ordinary request, not a tool answer')").run(chatId).lastInsertRowid);
  const id = 'legacy-owned-inputs';
  db.prepare("INSERT INTO agent_runs(id,project_id,chat_id,user_id,state,message_id,last_seq) VALUES(?,?,?,?,'completed',?,5)").run(id,project.id,chatId,owner.user.id,assistant);
  const journal = [
    {type:'question',questionId:'legacy-q',question:'Which style?'},
    {type:'answer',questionId:'legacy-q',answer:'Concise',chatMessageId:answer},
    {type:'input',inputId:99991,message:'Legacy consumed correction',chatMessageId:correction},
    {type:'input_consumed',inputIds:[99991]},
  ];
  journal.forEach((event,i) => db.prepare('INSERT INTO agent_run_events(run_id,seq,event) VALUES(?,?,?)').run(id,i+1,JSON.stringify(event)));
  db.prepare('INSERT INTO agent_run_events(run_id,seq,event) VALUES(?,?,?)').run(id,5,'not valid JSON');
  const messages = (await call('GET', '/chat')).data.messages;
  assert.deepEqual(messages.map(m => m.id), [request,answer,correction,assistant,ordinary]);
  assert.equal(messages[1].inputText, 'Concise'); assert.equal(messages[1].question, 'Which style?');
  assert.equal(messages[2].consumed, true); assert.equal(messages.at(-1).inputKind, undefined);
  assert.match(messages.at(-1).content, /^\[回答\]/);
});

test('attachment count and whole-batch validation reject without saving prefixes', async () => {
  const dir = path.join(srv.dataDir, 'projects', String(project.id), '_workspace', 'uploads');
  const list = () => fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  const before = list();
  const file = { name: 'same.txt', mime: 'text/plain', data: Buffer.from('ok').toString('base64') };
  const image = { ...file, name: 'image.png', mime: 'image/png' };
  const tooMany = await call('POST', '/agent/chat', { message: 'Attachments', images: Array(4).fill(image), files: Array(9).fill(file) });
  assert.equal(tooMany.status, 400); assert.deepEqual(list(), before);
  const invalid = await call('POST', '/agent/chat', { message: 'Attachments', files: [file, { ...file, data: '' }] });
  assert.equal(invalid.status, 400); assert.deepEqual(list(), before);
  const response = await fetch(srv.baseUrl + endpoint('/agent/chat'), { method: 'POST', headers: { Authorization: `Bearer ${owner.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'Two same-name files', files: [file, file] }) });
  assert.equal(response.status, 200); await response.text();
  assert.equal(list().length - before.length, 2); assert.equal(new Set(list()).size, list().length);
});

function connectDoc(file) {
  const doc = new Y.Doc();
  const ws = new WebSocket(srv.baseUrl.replace('http', 'ws') + `/collab?project=${project.publicId}&file=${file}&token=${owner.token}`); sockets.add(ws);
  ws.on('message', (data) => {
    const decoder = decoding.createDecoder(new Uint8Array(data));
    if (decoding.readVarUint(decoder) !== 0) return;
    const encoder = encoding.createEncoder(); encoding.writeVarUint(encoder, 0);
    syncProtocol.readSyncMessage(decoder, encoder, doc, 'remote');
    if (encoding.length(encoder) > 1 && ws.readyState === ws.OPEN) ws.send(encoding.toUint8Array(encoder));
  });
  doc.on('update', (update, origin) => {
    if (origin === 'remote' || ws.readyState !== ws.OPEN) return;
    const encoder = encoding.createEncoder(); encoding.writeVarUint(encoder, 0); syncProtocol.writeUpdate(encoder, update); ws.send(encoding.toUint8Array(encoder));
  });
  const opened = new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  opened.then(() => { const encoder = encoding.createEncoder(); encoding.writeVarUint(encoder, 0); syncProtocol.writeSyncStep1(encoder, doc); ws.send(encoding.toUint8Array(encoder)); });
  return { doc, ws, opened };
}

test('selection actions flush current collaboration content and reject stale text/hash', async () => {
  const file = 'selection-current.tex';
  await call('POST', '/files', { path: file, content: 'OLD' });
  const a = connectDoc(file), b = connectDoc(file); await Promise.all([a.opened, b.opened]);
  await waitUntil(() => a.doc.getText('content').toString() === 'OLD' && b.doc.getText('content').toString() === 'OLD');
  a.doc.transact(() => { a.doc.getText('content').delete(0, 3); a.doc.getText('content').insert(0, 'LATEST'); });
  await waitUntil(() => b.doc.getText('content').toString() === 'LATEST');
  wire = [];
  const stale = await call('POST', '/agent/selection-action', { action: 'explain', file, start: 0, end: 3, selectionText: 'OLD' });
  assert.equal(stale.status, 409); assert.equal(wire.length, 0);
  const invalidHash = await call('POST', '/agent/selection-action', { action: 'explain', file, start: 0, end: 6, selectionText: 'LATEST', selectionHash: 'wrong' });
  assert.equal(invalidHash.status, 409);
  const response = await fetch(srv.baseUrl + endpoint('/agent/selection-action'), { method: 'POST', headers: { Authorization: `Bearer ${owner.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'explain', file, start: 0, end: 6, selectionText: 'LATEST', selectionHash: createHash('sha256').update('LATEST').digest('hex') }) });
  assert.equal(response.status, 200); await response.text();
  assert.ok(wire.some((request) => request.messages.some((m) => typeof m.content === 'string' && m.content.includes('LATEST'))));
  assert.equal(fs.readFileSync(path.join(srv.dataDir, 'projects', String(project.id), file), 'utf8'), 'LATEST');
  a.ws.close(); b.ws.close();
});

test('one user can run two projects concurrently and cancelling one leaves the other isolated', { timeout: 10000 }, async () => {
  const create = async (name) => {
    const result = await api(srv.baseUrl, 'POST', '/api/projects', { token: owner.token, body: { name } });
    assert.equal(result.status, 201);
    return result.data.project;
  };
  const [a, b] = await Promise.all([create('parallel-run-a'), create('parallel-run-b')]);
  const forProject = (p, method, suffix, body) => api(srv.baseUrl, method, `/api/projects/${p.publicId}${suffix}`, { token: owner.token, body });
  const send = (p, message) => fetch(`${srv.baseUrl}/api/projects/${p.publicId}/agent/chat`, {
    method: 'POST', headers: { Authorization: `Bearer ${owner.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });
  mode = 'hold'; held = []; wire = [];
  let runA, runB;
  try {
    const responseA = await send(a, 'PROJECT_A_ONLY: work in the first project');
    assert.equal(responseA.status, 200);
    const streamA = responseA.text();
    await waitUntil(() => held.length === 1);
    runA = (await forProject(a, 'GET', '/agent/runs/active')).data.run;
    const responseB = await send(b, 'PROJECT_B_ONLY: work in the second project');
    assert.equal(responseB.status, 200);
    const streamB = responseB.text();
    await waitUntil(() => held.length === 2);
    runB = (await forProject(b, 'GET', '/agent/runs/active')).data.run;
    assert.ok(runA && runB);
    assert.notEqual(runA.id, runB.id);
    assert.equal(runs.runSnapshot(runA.id).state, 'running');
    assert.equal(runs.runSnapshot(runB.id).state, 'running');
    assert.equal((await forProject(a, 'POST', `/agent/runs/${runB.id}/cancel`, {})).status, 404);
    assert.equal((await forProject(a, 'GET', `/agent/runs/${runB.id}/events`)).status, 404);
    assert.equal((await forProject(a, 'POST', `/agent/runs/${runA.id}/cancel`, {})).data.run.state, 'cancelled');
    assert.equal(events(await streamA).at(-1).state, 'cancelled');
    assert.equal((await forProject(b, 'GET', '/agent/runs/active')).data.run.id, runB.id);
    const correction = await forProject(b, 'POST', `/agent/runs/${runB.id}/input`, { message: 'PROJECT_B_CORRECTION_ONLY' });
    assert.equal(correction.status, 200);
    mode = 'isolated-final';
    finish(held[1], 'PROJECT_B_SUPERSEDED_CANDIDATE_ONLY');
    const bEvents = events(await streamB);
    assert.equal(bEvents.at(-1).state, 'completed');
    assert.ok(bEvents.every((event) => event.runId === runB.id));
    const visibleB = bEvents.filter((event) => event.type === 'token').map((event) => event.text).join('');
    assert.match(visibleB, /PROJECT_B_RESULT_ONLY_AFTER_CORRECTION/);
    assert.doesNotMatch(visibleB, /PROJECT_B_SUPERSEDED_CANDIDATE_ONLY/);
    assert.ok(wire.at(-1).messages.some((message) => message.role === 'user' && typeof message.content === 'string' && message.content.includes('PROJECT_B_CORRECTION_ONLY')),
      'the final B result is generated after consuming its own queued correction');
    assert.doesNotMatch(JSON.stringify(wire.at(-1).messages), /PROJECT_A_ONLY/);
    const [historyA, historyB] = await Promise.all([
      forProject(a, 'GET', '/chat'), forProject(b, 'GET', '/chat'),
    ]);
    const contents = (result) => result.data.messages.map((message) => message.content).join('\n');
    assert.match(contents(historyA), /PROJECT_A_ONLY/);
    assert.doesNotMatch(contents(historyA), /PROJECT_B_/);
    assert.match(contents(historyB), /PROJECT_B_ONLY/);
    assert.match(contents(historyB), /PROJECT_B_CORRECTION_ONLY/);
    assert.match(contents(historyB), /PROJECT_B_RESULT_ONLY_AFTER_CORRECTION/);
    assert.doesNotMatch(contents(historyB), /PROJECT_B_SUPERSEDED_CANDIDATE_ONLY/);
    assert.doesNotMatch(contents(historyB), /PROJECT_A_ONLY/);
    assert.equal((await forProject(a, 'GET', '/agent/runs/active')).data.run, null);
    assert.equal((await forProject(b, 'GET', '/agent/runs/active')).data.run, null);
  } finally {
    mode = 'immediate';
    for (const run of [runA, runB]) if (run) await runs.cancelRun(run.id);
    for (const response of held) response.destroy();
  }
});

test('reopening the database marks abandoned runs interrupted without replaying work', async () => {
  const id = 'simulated-process-restart';
  const chatId = fixtureChat();
  db.prepare("INSERT INTO agent_runs(id,project_id,chat_id,user_id,state) VALUES(?,?,?,?,'running')").run(id, project.id, chatId, owner.user.id);
  const module = await import('../src/db.js'); module.resetDb(); db = module.getDb();
  assert.equal(runs.runSnapshot(id).state, 'interrupted');
  const logged = []; runs.observeRun(id, 0, (event) => logged.push(event));
  assert.deepEqual(logged.map((e) => e.type), ['run', 'done']);
  assert.ok(logged.every((e) => e.state === 'interrupted'));
});
