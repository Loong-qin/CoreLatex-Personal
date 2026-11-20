import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import { api, registerAndLogin } from './helpers.js';

/**
 * 防幻觉循环回归测试（2026-10 HalluProbe 项目实录驱动的三道防线）：
 *  1. 零调用叙述闸：整轮零工具调用却叙述「已读取/已完成编辑」→ 注入系统核对；
 *  2. 纠正语升级：第 2 次起换机械硬约束（下一条必须以工具调用开始）；
 *  3. 耗尽警示：3 次纠正后仍虚报 → 正文追加系统警示，虚假完成声明不得留给用户；
 *  4. 历史回放标注：带真实工具调用的历史 assistant 行附「系统标注」，
 *     打破「历史=纯文字报告」的错误示范（弱模型模仿写报告而不调工具）。
 *
 * mock LLM 按用户消息中的关键词编排剧本：
 *  - 「幻觉耗尽」：永远输出凭空完成声明（零工具调用），验证 3 次升级纠正与耗尽警示；
 *  - 「幻觉自愈」：先虚报一次，被纠正后真实 read_file → edit_file → 合规收尾；
 *  - 「幻觉标记检查」：普通回复，mock 侧检查历史回放里是否出现「系统标注」。
 */

let srv;         // CoreLatex 测试服务器
let baseUrl;
let dataDir;
let llm;         // mock 模型服务器
let llmBase;
let user;        // { token, user }
let pubId;       // 项目 public_id（路由访问标识）
let diskId;      // 项目数字编号（磁盘目录名）

// mock 侧观测：收到的全部【系统核对】注入语、历史回放里的系统标注数
const correctionNotes = [];
let replayMarkersSeen = [];

// ---------- mock LLM ----------

const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

function chunkWrite(res, text) {
  const buf = Buffer.from(text, 'utf8');
  let i = 0;
  const step = () => {
    if (i >= buf.length) return res.end();
    const n = Math.min(buf.length - i, 7);
    res.write(buf.subarray(i, i + n));
    i += n;
    setImmediate(step);
  };
  step();
}

function openAiToolCall(name, args) {
  return sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name, arguments: '' } }] } }] })
    + sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(0, 12) } }] } }] })
    + sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(12) } }] } }] })
    + sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
    + 'data: [DONE]\n\n';
}

function openAiText(t1, t2) {
  return sse({ choices: [{ index: 0, delta: { role: 'assistant', content: t1 } }] })
    + (t2 ? sse({ choices: [{ index: 0, delta: { content: t2 } }] }) : '')
    + sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
    + sse({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } })
    + 'data: [DONE]\n\n';
}

/** 凭空完成声明：零工具调用却叙述已读取+已改完（幻觉剧本的标准形态） */
const fakeCompletion = () => openAiText('已读取文件当前内容并核对，两处修改都已生效。', '已完成编辑，请审核。');

function handleOpenAi(json, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const msgs = json.messages || [];
  const textOf = (m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content || ''));

  // 观测：系统核对注入语（同一轮中同一注入只记一次）
  for (const m of msgs) {
    if (m.role === 'user' && /【系统核对/.test(textOf(m))) {
      const note = textOf(m);
      if (!correctionNotes.includes(note)) correctionNotes.push(note);
    }
  }
  // 观测：历史回放里带「系统标注」的 assistant 消息
  replayMarkersSeen = msgs
    .filter((m) => m.role === 'assistant' && /系统标注：本条回复撰写时实际执行过/.test(textOf(m)))
    .map(textOf);

  const toolMsgs = msgs.filter((m) => m.role === 'tool');
  const didRead = toolMsgs.some((m) => /AAA/.test(textOf(m)));
  const didEdit = toolMsgs.some((m) => /已暂存对 halluc\.txt/.test(textOf(m)));

  let out;
  // 剧本按「最后出现」的场景关键词分流：三个用例共用同一会话，历史里会同时
  // 存在多个关键词与历史核对注入语——以最近一条场景消息为准，本轮纠正计数
  // 也只统计该消息之后的注入语（历史里的属于先前用例）
  const SCENARIOS = [['幻觉耗尽', 'exhaust'], ['幻觉自愈', 'recover'], ['幻觉标记检查', 'marker']];
  let scenario = null;
  let lastScenarioIdx = -1;
  msgs.forEach((m, i) => {
    if (m.role !== 'user') return;
    for (const [kw, tag] of SCENARIOS) {
      if (textOf(m).includes(kw)) { scenario = tag; lastScenarioIdx = i; }
    }
  });
  const corrections = msgs.filter((m, i) =>
    i > lastScenarioIdx && m.role === 'user' && /【系统核对/.test(textOf(m))).length;
  if (scenario === 'exhaust') {
    out = fakeCompletion(); // 永不悔改：每轮都凭空虚报
  } else if (scenario === 'recover') {
    if (corrections === 0) out = fakeCompletion();               // 第一次：虚报
    else if (!didRead) out = openAiToolCall('read_file', '{"path": "halluc.txt"}');
    else if (!didEdit) out = openAiToolCall('edit_file', '{"path": "halluc.txt", "search": "BBB", "replace": "CCC"}');
    else out = openAiText('已完成编辑，请审核。真实改动：BBB → CCC。'); // 有成功编辑后的合规收尾
  } else {
    out = openAiText('检查完毕。');
  }
  chunkWrite(res, out);
}

function startMockLlm() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let json = {};
        try { json = JSON.parse(body || '{}'); } catch { /* ignore */ }
        if (req.url === '/v1/chat/completions') return handleOpenAi(json, res);
        res.writeHead(404);
        res.end('unknown endpoint');
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// ---------- 测试服务器 ----------

async function startTestApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'corelatex-antihalluc-'));
  process.env.CORELATEX_DATA_DIR = dir;
  const { resetDb } = await import('../src/db.js');
  resetDb();
  const { requireAuth } = await import('../src/auth.js');
  const { HttpError } = await import('../src/util.js');
  const { default: authRoutes } = await import('../src/routes/auth.js');
  const { default: projectRoutes } = await import('../src/routes/projects.js');
  const aiMod = await import('../src/routes/ai.js');
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use('/api/auth', authRoutes);
  app.use('/api/projects', requireAuth, projectRoutes);
  app.use('/api/projects', requireAuth, aiMod.default);
  app.use('/api/settings', requireAuth, aiMod.settingsRouter);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    console.error('[test server error]', err);
    res.status(500).json({ error: '服务器内部错误' });
  });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    server,
    dataDir: dir,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    async close() {
      await new Promise((r) => server.close(r));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function readSSE(url, { token, body }) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 200);
  const events = [];
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, i);
      buf = buf.slice(i + 2);
      for (const line of raw.split('\n')) {
        if (line.startsWith('data: ')) events.push(JSON.parse(line.slice(6)));
      }
    }
  }
  return events;
}

function projectFile(rel) {
  return path.join(dataDir, 'projects', String(diskId), rel);
}

async function lastAssistant() {
  const r = await api(baseUrl, 'GET', `/api/projects/${pubId}/chat`, { token: user.token });
  const list = r.data.messages.filter((m) => m.role === 'assistant');
  return list[list.length - 1];
}

// ---------- 生命周期 ----------

before(async () => {
  llm = await startMockLlm();
  llmBase = `http://127.0.0.1:${llm.address().port}`;
  srv = await startTestApp();
  baseUrl = srv.baseUrl;
  dataDir = srv.dataDir;
  user = await registerAndLogin(baseUrl, 'antihalluc');
  const put = await api(baseUrl, 'PUT', '/api/settings/ai', {
    token: user.token,
    body: { provider: 'openai', baseUrl: `${llmBase}/v1`, apiKey: 'sk-test', model: 'gpt-mock' },
  });
  assert.equal(put.status, 200);
  const r = await api(baseUrl, 'POST', '/api/projects', { token: user.token, body: { name: 'antihalluc-proj' } });
  assert.equal(r.status, 201);
  pubId = r.data.project.publicId;
  diskId = r.data.project.id;
});

after(async () => {
  await srv?.close();
  llm?.close();
});

// ---------- 用例 ----------

test('一次自动纠正后仍虚报：拦截假声明并明确失败，不产生变更集', async () => {
  correctionNotes.length = 0;
  const events = await readSSE(`${baseUrl}/api/projects/${pubId}/agent/chat`, {
    token: user.token,
    body: { message: '幻觉耗尽压力测试：请修改 halluc.txt' },
  });
  assert.equal(correctionNotes.length, 1, '只允许一次针对执行证据的自动纠正');
  assert.match(correctionNotes[0], /唯一一次自动纠正/);
  assert.match(correctionNotes[0], /复用已有的有效读取/);
  assert.doesNotMatch(correctionNotes[0], /下一步直接调用 read_file/);
  const msg = await lastAssistant();
  assert.equal(msg.steps.filter((s) => s.type === 'activity' && s.phase === 'verification').length, 1);
  assert.match(msg.content, /系统核对未通过/);
  assert.match(msg.content, /没有可提交的有效修改/);
  assert.doesNotMatch(msg.content, /已完成编辑，请审核/);
  assert.equal(events.find((e) => e.type === 'changeset'), undefined);
  assert.equal(events[events.length - 1].type, 'done');
  assert.equal(events[events.length - 1].state, 'failed');
});

test('自愈路径：纠正一次后真实读取并编辑 → 正常收尾，无警示', async () => {
  correctionNotes.length = 0;
  fs.writeFileSync(projectFile('halluc.txt'), 'AAA\nBBB\n');

  const events = await readSSE(`${baseUrl}/api/projects/${pubId}/agent/chat`, {
    token: user.token,
    body: { message: '幻觉自愈压力测试：把 halluc.txt 的 BBB 改为 CCC' },
  });

  // 仅第 1 次虚报触发核对；之后 read_file → edit_file → 合规收尾，不再触发
  assert.equal(correctionNotes.length, 1, `自愈场景只应注入 1 次核对，实际 ${correctionNotes.length}`);

  const msg = await lastAssistant();
  const corrections = msg.steps.filter((s) => s.type === 'activity' && s.phase === 'verification' && s.code === 'EXECUTION_CLAIM_UNSUPPORTED');
  assert.equal(corrections.length, 1, '真实纠正过程应保留一次，未公开的初稿不应留下正文核对占位');
  assert.equal(events.filter((e) => e.type === 'activity' && e.phase === 'verification' && e.code === 'EXECUTION_CLAIM_UNSUPPORTED').length, 1);
  assert.doesNotMatch(msg.content, /两处修改都已生效/, '未执行工具时的虚报初稿不得进入历史正文');
  assert.doesNotMatch(events.filter((e) => e.type === 'token').map((e) => e.text).join(''), /两处修改都已生效/, '虚报初稿不得在 SSE 中短暂公开');
  assert.match(msg.content, /真实改动：BBB → CCC/);
  assert.doesNotMatch(msg.content, /系统警示/, '真实编辑成功后不得出现耗尽警示');
  // 工具调用真实发生且顺序正确
  assert.deepEqual(msg.toolCalls.map((c) => c.name), ['read_file', 'edit_file']);
  // 变更集产生且已应用
  const cs = events.find((e) => e.type === 'changeset');
  assert.ok(cs, '自愈成功应产生变更集');
  assert.equal(cs.changeset.files[0].filePath, 'halluc.txt');
  assert.equal(cs.changeset.applied, true);
  assert.equal(events.at(-1).state, 'completed');
  assert.equal(fs.readFileSync(projectFile('halluc.txt'), 'utf8'), 'AAA\nCCC\n');
});

test('历史标注：带真实工具调用的历史回复，回放时附加系统标注', async () => {
  replayMarkersSeen = [];
  await readSSE(`${baseUrl}/api/projects/${pubId}/agent/chat`, {
    token: user.token,
    body: { message: '幻觉标记检查' },
  });
  // 自愈轮的 assistant 消息（read_file + edit_file 共 2 次调用）应带「实际执行过 2 次工具调用」标注
  assert.ok(replayMarkersSeen.length >= 1, '历史回放中应出现系统标注');
  assert.match(replayMarkersSeen.join('\n'), /实际执行过 2 次工具调用/);
});
