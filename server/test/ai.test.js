import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import archiver from 'archiver';
import { api, registerAndLogin } from './helpers.js';
import { toolDigest, safeToolInput } from '../src/services/agent/toolDigest.js';

/**
 * AI 模块测试。index.js 不在本任务范围内（由主会话接线），
 * 因此这里自行装配 express app（挂载 ai 路由）+ 本地 mock LLM SSE 服务器。
 */

let srv;         // CoreLatex 测试服务器
let baseUrl;
let dataDir;
let llm;         // mock 模型服务器
let llmBase;
let user;        // { token, user }
let pid;
let diskId;         // 项目 id
let lastSystemPrompt = ''; // 最近一次请求的系统提示词（断言过程叙述要求用）
let lastWireUser = ''; // 最近一次发给模型的最后一条 user 消息（断言选中内容注入用）
let lastManuscriptReference;
const originalPath = process.env.PATH;

// ---------- mock LLM ----------

const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const ev = (name, obj) => `event: ${name}\ndata: ${JSON.stringify(obj)}\n\n`;

/** 以 5~17 字节的小块推送，必然产生跨 chunk 半行/多字节字符切断 */
function chunkWrite(res, text) {
  const buf = Buffer.from(text, 'utf8');
  let i = 0;
  const step = () => {
    if (i >= buf.length) return res.end();
    const n = Math.min(buf.length - i, 5 + (i % 13));
    res.write(buf.subarray(i, i + n));
    i += n;
    setImmediate(step);
  };
  step();
}

function openAiToolCall(name, args) {
  return sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name, arguments: '' } }] } }] })
    + sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(0, 15) } } ] } }] })
    + sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(15) } } ] } }] })
    + sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
    + 'data: [DONE]\n\n';
}

function openAiText(t1, t2) {
  return sse({ choices: [{ index: 0, delta: { role: 'assistant', content: t1 } }] })
    + sse({ choices: [{ index: 0, delta: { content: t2 } }] })
    + sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
    + sse({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 4 } })
    + 'data: [DONE]\n\n';
}

function handleOpenAi(json, res) {
  if (!json.stream) { // /settings/ai/test 的非流式最小请求
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      id: 'cmpl-mock',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }));
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const msgs = json.messages || [];
  const sys = msgs.find((m) => m.role === 'system');
  if (sys) lastSystemPrompt = String(sys.content || '');
  const textOf = (m) => typeof m.content === 'string' ? m.content : (m.content || []).filter((p) => p.type === 'text').map((p) => p.text).join('\n');
  const reference = msgs.findLast(m => m.role === 'user' && textOf(m).startsWith('【稿件参考资料】'));
  lastManuscriptReference = reference ? JSON.parse(textOf(reference).split('\n').at(-1)) : null;
  const wireUser = [...msgs].reverse().find((m) => m.role === 'user' && !/^【系统便签|^【用户当前打开的文件】|^【稿件参考资料】/.test(textOf(m)));
  if (wireUser) lastWireUser = textOf(wireUser);
  const lastContent = wireUser ? textOf(wireUser) : '';
  const toolMessages = msgs.filter((m) => m.role === 'tool');
  const calledTools = new Set(msgs.filter((m) => m.role === 'assistant').flatMap((m) => (m.tool_calls || []).map((t) => t.function?.name)));
  let out;
  if (msgs.some((m) => typeof m.content === 'string' && /循环到停/.test(m.content))) {
    // 轮次无上限回归：连续调工具 3 轮后模型自行收尾（不再有轮数上限截断）
    const toolResults = msgs.filter((m) => m.role === 'tool').length;
    out = toolResults >= 3
      ? openAiText('循环', '完成。')
      : openAiToolCall('write_file', JSON.stringify({ path: 'loop.txt', content: 'x\n' }));
  } else if (/解释/.test(lastContent)) {
    out = openAiText('这段 LaTeX ', '用于输出问候语。');
  } else if (/翻译|精简|扩写|优化/.test(lastContent)) {
    if (!calledTools.has('read_file')) {
      out = openAiToolCall('read_file', JSON.stringify({ path: 'main.tex' }));
    } else if (!calledTools.has('edit_file')) {
      out = openAiToolCall('edit_file', JSON.stringify({
        path: 'main.tex', search: 'Hello, CoreLatex!', replace: 'Hello, optimized CoreLatex!',
      }));
    } else if (!calledTools.has('compile_and_preview')) {
      out = openAiToolCall('compile_and_preview', JSON.stringify({ pages: '1' }));
    } else out = openAiText('已完成', '修改。');
  } else if (toolMessages.length) {
    out = openAiText('已完成', '修改。');
  } else if (/写工作区/.test(lastContent)) {
    out = openAiToolCall('write_file', JSON.stringify({ path: '_workspace/scratch.py', content: 'print(1)\n' }));
  } else {
    out = sse({ choices: [{ index: 0, delta: { role: 'assistant', content: '好的' } }] })
      + openAiToolCall('write_file', JSON.stringify({ path: 'note.txt', content: 'line1\nline2\n' }));
  }
  chunkWrite(res, out);
}

function handleAnthropic(json, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const msgs = json.messages || [];
  const hasToolResult = msgs.some((m) => Array.isArray(m.content) && m.content.some((c) => c.type === 'tool_result'));
  let out;
  if (hasToolResult) {
    out = ev('message_start', { type: 'message_start', message: { id: 'msg_m', usage: { input_tokens: 30, output_tokens: 1 } } })
      + ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      + ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '已经' } })
      + ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '写入完成' } })
      + ev('content_block_stop', { type: 'content_block_stop', index: 0 })
      + ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 8 } })
      + ev('message_stop', { type: 'message_stop' });
  } else {
    const args = '{"path": "anthro.txt", "content": "anthropic content\\n"}';
    out = ev('message_start', { type: 'message_start', message: { id: 'msg_m', usage: { input_tokens: 12, output_tokens: 1 } } })
      + ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'write_file', input: {} } })
      + ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: args.slice(0, 22) } })
      + ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: args.slice(22) } })
      + ev('content_block_stop', { type: 'content_block_stop', index: 0 })
      + ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 30 } })
      + ev('message_stop', { type: 'message_stop' });
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
        if (req.url === '/v1/messages') return handleAnthropic(json, res);
        res.writeHead(404);
        res.end('unknown endpoint');
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// ---------- 测试服务器（自装配 app，不改 index.js） ----------

async function startAiTestServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'corelatex-ai-test-'));
  process.env.CORELATEX_DATA_DIR = dir;
  const { resetDb } = await import('../src/db.js');
  resetDb();
  const { requireAuth } = await import('../src/auth.js');
  const { HttpError } = await import('../src/util.js');
  const { default: authRoutes } = await import('../src/routes/auth.js');
  const { default: projectRoutes } = await import('../src/routes/projects.js');
  const { default: fileRoutes } = await import('../src/routes/files.js');
  const aiMod = await import('../src/routes/ai.js');
  const { default: usersRoutes } = await import('../src/routes/users.js');
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use('/api/auth', authRoutes);
  app.use('/api/projects', requireAuth, projectRoutes);
  app.use('/api/projects', requireAuth, fileRoutes);
  app.use('/api/projects', requireAuth, aiMod.default);
  app.use('/api/users', requireAuth, usersRoutes);
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

async function makeZip(files) {
  const archive = archiver('zip', { zlib: { level: 9 } });
  const chunks = [];
  archive.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve, reject) => {
    archive.on('end', resolve);
    archive.on('error', reject);
  });
  for (const f of files) archive.append(Buffer.from(f.content), { name: f.name });
  archive.finalize();
  await done;
  return Buffer.concat(chunks);
}

function crc32(buf) {
  if (!crc32.table) {
    crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crc32.table[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ crc32.table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

/** 手工构造 zip（store 不压缩）。archiver 会净化条目名，恶意名（如 ../ 穿越）只能手工构造 */
function makeRawZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const { name, content } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.from(content, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 文件名
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    chunks.push(local, nameBuf, data);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cenBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cenBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cenBuf, eocd]);
}

// ---------- 生命周期与公共准备 ----------

before(async () => {
  llm = await startMockLlm();
  llmBase = `http://127.0.0.1:${llm.address().port}`;
  srv = await startAiTestServer();
  baseUrl = srv.baseUrl;
  dataDir = srv.dataDir;
  // Exercise the normal compile tool with isolated deterministic binaries.
  // Capture input bytes to prove selection edits compile the staged draft.
  const bin = path.join(dataDir, 'bin'); fs.mkdirSync(bin);
  const binary = (name, body) => fs.writeFileSync(path.join(bin, name), '#!/usr/bin/env node\n' + body, { mode: 0o755 });
  process.env.PATH = [bin, path.dirname(process.execPath), originalPath].join(path.delimiter);
  const compiler = `const fs=require('node:fs'),path=require('node:path');
const main=process.argv.at(-1),base=path.basename(main).replace(/\\.tex$/i,'');
fs.appendFileSync(${JSON.stringify(path.join(dataDir, 'compiled-sources.jsonl'))},JSON.stringify(fs.readFileSync(main,'utf8'))+'\\n');
fs.mkdirSync('.build',{recursive:true});fs.writeFileSync(path.join('.build',base+'.pdf'),'%PDF fixture');fs.writeFileSync(path.join('.build',base+'.log'),'Output written on '+base+'.pdf.');`;
  for (const name of ['pdflatex', 'xelatex', 'lualatex']) binary(name, compiler);
  binary('pdfinfo', "console.log('Pages: 1');");
  binary('pdftoppm', "require('node:fs').writeFileSync(process.argv.at(-1)+'-1.jpg',Buffer.from([255,216,255,217]));");
  user = await registerAndLogin(baseUrl, 'aiuser');
  const r = await api(baseUrl, 'POST', '/api/projects', { token: user.token, body: { name: 'ai-proj' } });
  pid = r.data.project.publicId;
  diskId = r.data.project.id;
  // These deterministic binaries model the ambient legacy toolchain.
  await api(baseUrl, 'PATCH', `/api/projects/${pid}`, { token: user.token, body: { texVersion: 'system' } });
});

after(async () => {
  await srv?.close();
  llm?.close();
  process.env.PATH = originalPath;
});

// ---------- 设置 ----------

test('设置：保存 AI 配置，GET 脱敏返回', async () => {
  const put = await api(baseUrl, 'PUT', '/api/settings/ai', {
    token: user.token,
    body: {
      provider: 'openai',
      baseUrl: `${llmBase}/v1`,
      apiKey: 'sk-abcdef123456',
      model: 'gpt-mock',
      chineseSupport: true,
      agentConfig: { allowRunScripts: false, temperature: 0.3 },
    },
  });
  assert.equal(put.status, 200);
  const get = await api(baseUrl, 'GET', '/api/settings/ai', { token: user.token });
  assert.equal(get.status, 200);
  assert.equal(get.data.provider, 'openai');
  assert.equal(get.data.model, 'gpt-mock');
  assert.equal(get.data.apiKey, '***3456');
  assert.equal(get.data.hasKey, true);
  assert.equal(get.data.chineseSupport, true);
  assert.equal(get.data.agentConfig.allowRunScripts, false);
  // apiKey 传 *** 开头 → 不修改
  const put2 = await api(baseUrl, 'PUT', '/api/settings/ai', {
    token: user.token, body: { model: 'gpt-mock-2', apiKey: '***3456' },
  });
  assert.equal(put2.status, 200);
  const get2 = await api(baseUrl, 'GET', '/api/settings/ai', { token: user.token });
  assert.equal(get2.data.model, 'gpt-mock-2');
  assert.equal(get2.data.apiKey, '***3456');
  // 改回 gpt-mock 供后续用例
  await api(baseUrl, 'PUT', '/api/settings/ai', { token: user.token, body: { model: 'gpt-mock' } });
});

test('设置：连接测试成功与失败', async () => {
  const ok = await api(baseUrl, 'POST', '/api/settings/ai/test', { token: user.token, body: {} });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.ok, true);
  const bad = await api(baseUrl, 'POST', '/api/settings/ai/test', {
    token: user.token, body: { baseUrl: 'http://127.0.0.1:1/v1' },
  });
  assert.equal(bad.status, 200);
  assert.equal(bad.data.ok, false);
  assert.ok(bad.data.error);
});

// ---------- 当前 pi provider 的真实流协议回归（本地 mock，无外部请求） ----------

async function piChat(provider, messages, events = [], baseUrl = `${llmBase}/v1`) {
  const { streamSimple } = await import('@mariozechner/pi-ai');
  const { toPiModel } = await import('../src/services/agent/context.js');
  const model = toPiModel({ provider, baseUrl, model: provider === 'anthropic' ? 'claude-mock' : 'gpt-mock' });
  const stream = streamSimple(model, {
    systemPrompt: 'sys', messages,
    tools: [{ name: 'write_file', description: 'Write a test file', parameters: { type: 'object', properties: {} } }],
  }, { apiKey: 'test-only', maxRetries: 0 });
  for await (const event of stream) events.push(event);
  return stream.result();
}

const userMessage = (content) => ({ role: 'user', content, timestamp: Date.now() });
const messageText = (message) => message.content.filter((p) => p.type === 'text').map((p) => p.text).join('');
const messageCalls = (message) => message.content.filter((p) => p.type === 'toolCall');
const toolResult = (call) => ({
  role: 'toolResult', toolCallId: call.id, toolName: call.name,
  content: [{ type: 'text', text: '已暂存' }], isError: false, timestamp: Date.now(),
});

test('pi providers：OpenAI 跨 chunk 文本/工具参数与用量聚合', async () => {
  const messages = [userMessage('写个文件')];
  const events = [];
  const first = await piChat('openai', messages, events);
  assert.equal(first.stopReason, 'toolUse', first.errorMessage);
  assert.equal(messageText(first), '好的');
  const calls = messageCalls(first);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'write_file');
  assert.deepEqual(calls[0].arguments, { path: 'note.txt', content: 'line1\nline2\n' });
  assert.ok(events.some((e) => e.type === 'toolcall_end'));
  events.length = 0;
  const second = await piChat('openai', [...messages, first, toolResult(calls[0])], events);
  assert.equal(second.stopReason, 'stop', second.errorMessage);
  assert.equal(messageText(second), '已完成修改。');
  assert.equal(messageCalls(second).length, 0);
  assert.equal(events.filter((e) => e.type === 'text_delta').map((e) => e.delta).join(''), '已完成修改。');
  assert.equal(second.usage.input, 11);
});

test('pi providers：Anthropic 工具调用和工具结果转换', async () => {
  const messages = [userMessage('写个文件')];
  const first = await piChat('anthropic', messages);
  assert.equal(first.stopReason, 'toolUse', first.errorMessage);
  const calls = messageCalls(first);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, 'toolu_1');
  assert.equal(calls[0].name, 'write_file');
  assert.deepEqual(calls[0].arguments, { path: 'anthro.txt', content: 'anthropic content\n' });
  assert.equal(first.usage.input, 12);
  const second = await piChat('anthropic', [...messages, first, toolResult(calls[0])]);
  assert.equal(second.stopReason, 'stop', second.errorMessage);
  assert.equal(messageText(second), '已经写入完成');
  assert.equal(messageCalls(second).length, 0);
});

test('pi providers：HTTP 非 2xx 返回明确错误终态', async () => {
  const events = [];
  const result = await piChat('openai', [userMessage('x')], events, `${llmBase}/nope`);
  assert.equal(result.stopReason, 'error');
  assert.ok(result.errorMessage);
  assert.ok(events.some((e) => e.type === 'error'));
});

// ---------- agent chat 全流程 ----------

let chatId;
let changesetId;

test('会话：进入项目自动获得单会话，消息为空；再次进入不新建', async () => {
  const r = await api(baseUrl, 'GET', `/api/projects/${pid}/chat`, { token: user.token });
  assert.equal(r.status, 200);
  assert.ok(r.data.chatId);
  chatId = r.data.chatId;
  assert.deepEqual(r.data.messages, []);
  const again = await api(baseUrl, 'GET', `/api/projects/${pid}/chat`, { token: user.token });
  assert.equal(again.data.chatId, chatId, '同一用户同一项目应复用同一会话');
});

test('agent chat：SSE 事件流 + 变更自动应用 + 消息持久化', async () => {
  const events = await readSSE(`${baseUrl}/api/projects/${pid}/agent/chat`, {
    token: user.token,
    body: { message: '请创建 note.txt，写入两行' },
  });
  const types = events.map((e) => e.type);
  assert.ok(types.includes('token'), `缺 token 事件: ${types}`);
  assert.ok(types.includes('tool'), '缺 tool 事件');
  assert.ok(types.includes('changeset'), '缺 changeset 事件');
  assert.equal(types[types.length - 1], 'done');

  // Meaningful progress can accompany tools without inserting another request.
  assert.match(lastSystemPrompt, /## 过程叙述/);
  assert.match(lastSystemPrompt, /进度可与下一组工具同轮输出/);
  assert.doesNotMatch(lastSystemPrompt, /每次调用工具前|每轮只调用一两个工具/);
  // 选中内容引用块约定（前端会把选中片段附进消息开头）；没收到选区时必须先问而非盲改
  assert.match(lastSystemPrompt, /## 选中上下文/);
  assert.match(lastSystemPrompt, /不要猜测目标范围/);

  // token 拼接 = 最终文本
  const text = events.filter((e) => e.type === 'token').map((e) => e.text).join('');
  assert.equal(text, '好的已完成修改。');

  // tool 事件 start/end 成对
  const toolEvents = events.filter((e) => e.type === 'tool');
  assert.deepEqual(toolEvents.map((e) => e.status), ['start', 'end']);
  assert.equal(toolEvents[0].name, 'write_file');
  // 运行中即可看到「操作对象」：start 带摘要与脱敏参数，end 带耗时
  assert.equal(toolEvents[0].summary, 'note.txt');
  assert.equal(toolEvents[0].input.path, 'note.txt');
  assert.ok(Number.isFinite(toolEvents[1].ms));
  // 长字段（整份文件内容）不进事件，只留省略标记；短字段原样保留
  assert.equal(safeToolInput({ path: 'a.tex', content: 'x'.repeat(500) }).content, '…（省略 500 字符）');
  assert.equal(safeToolInput({ content: 'short' }).content, 'short');
  // 摘要优先级：路径 > 命令首行；复制类工具给出「来源 → 目标」
  assert.equal(toolDigest('read_file', { path: 'refs.bib' }), 'refs.bib');
  assert.equal(toolDigest('run_in_workspace', { command: 'python3 a.py --x 1\n第二行' }), 'python3 a.py --x 1');
  assert.equal(toolDigest('copy_to_project', { workspacePath: 'out.png', targetPath: 'Fig/out.png' }), 'out.png → Fig/out.png');

  // changeset
  const cs = events.find((e) => e.type === 'changeset').changeset;
  changesetId = cs.id;
  assert.equal(cs.status, 'pending'); // pending = 已应用待审查
  assert.equal(cs.files.length, 1);
  assert.equal(cs.files[0].filePath, 'note.txt');
  assert.equal(cs.files[0].adds, 2);
  assert.equal(cs.files[0].dels, 0);

  // 磁盘已自动应用
  assert.equal(fs.readFileSync(projectFile('note.txt'), 'utf8'), 'line1\nline2\n');

  // 消息持久化
  const msgs = await api(baseUrl, 'GET', `/api/projects/${pid}/chat`, { token: user.token });
  assert.deepEqual(msgs.data.messages.map((m) => m.role), ['user', 'assistant']);
  const assistant = msgs.data.messages[1];
  assert.equal(assistant.content, '好的\n\n已完成修改。'); // 各轮叙述以空行分隔，不糊成一段
  assert.equal(assistant.toolCalls.length, 1);
  assert.equal(assistant.toolCalls[0].name, 'write_file');
  assert.equal(events.find((e) => e.type === 'done').messageId, assistant.id);

  // 时间线步骤：叙述与工具按真实发生顺序交错，工具带耗时
  const activity = assistant.steps.filter((s) => s.type === 'activity');
  assert.deepEqual(activity, [], '模型未提供进度时不生成固定占位说明');
  const workflowSteps = assistant.steps.filter((s) => s.type === 'workflow');
  assert.equal(workflowSteps.length, 1);
  assert.equal(workflowSteps[0].graph.version, 4); assert.equal(workflowSteps[0].graph.validation.version, 1);
  assert.equal(workflowSteps[0].graph.status, 'completed');
  const workSteps = assistant.steps.filter((s) => ['text', 'tool'].includes(s.type));
  assert.deepEqual(workSteps.map((s) => s.type), ['text', 'tool', 'text']);
  assert.equal(workSteps[0].text, '好的');
  assert.equal(workSteps[1].name, 'write_file');
  assert.equal(workSteps[1].input.path, 'note.txt');
  assert.ok(workSteps[1].result.includes('note.txt'), '工具步骤应带结果');
  assert.ok(Number.isInteger(workSteps[1].ms) && workSteps[1].ms >= 0, '工具步骤应带耗时');
  assert.equal(workSteps[2].text, '已完成修改。');
  // 用户消息不产生步骤
  assert.deepEqual(msgs.data.messages[0].steps, []);
  // tool_calls 与 steps 并存，未被 steps 污染
  assert.deepEqual(assistant.toolCalls.map((c) => c.name), ['write_file']);
});

test('工作区写入：直接落盘，不产生变更集', async () => {
  const events = await readSSE(`${baseUrl}/api/projects/${pid}/agent/chat`, {
    token: user.token,
    body: { message: '请直接写工作区脚本' },
  });
  // _workspace/ 路径不进变更审查：无 changeset 事件，内容已直接在盘上
  assert.equal(events.find((e) => e.type === 'changeset'), undefined);
  assert.equal(fs.readFileSync(projectFile('_workspace/scratch.py'), 'utf8'), 'print(1)\n');
  assert.ok(events.find((e) => e.type === 'done').messageId);
});

test('read_file：小文件整读不截断，offset/limit 分页，10MB 单次上限', async () => {
  const { executeTool } = await import('../src/services/agent/tools.js');
  const ctx = { projectDir: path.join(dataDir, 'projects', String(diskId)), changesetBuffer: [] };

  // 小文件整读：原样返回，无包装头（防止再把常规稿件截断）
  const raw = fs.readFileSync(projectFile('main.tex'), 'utf8');
  assert.equal(await executeTool('read_file', { path: 'main.tex' }, ctx), raw);

  // 行窗口：offset/limit 按行分页，带总数与继续读取提示
  fs.writeFileSync(projectFile('big.txt'), Array.from({ length: 30 }, (_, i) => `L${i + 1}`).join('\n'));
  const paged = await executeTool('read_file', { path: 'big.txt', offset: 10, limit: 5 }, ctx);
  assert.ok(paged.includes('（big.txt 共 30 行；本次返回第 10–14 行'), paged);
  assert.ok(paged.includes('L10') && paged.includes('L14') && !paged.includes('L15'));
  assert.ok(paged.includes('可用 offset 参数继续读取'));

  // offset 超出总行数时钳到末行
  const clamped = await executeTool('read_file', { path: 'big.txt', offset: 999 }, ctx);
  assert.ok(clamped.includes('L30') && clamped.includes('第 30–30 行'));

  // 超 10MB 触发单次上限，并给出截断说明
  const bigLine = 'x'.repeat(99) + '\n';
  fs.writeFileSync(projectFile('huge.txt'), bigLine.repeat(120_000)); // ~12MB
  const capped = await executeTool('read_file', { path: 'huge.txt' }, ctx);
  assert.ok(capped.includes('已达单次读取 10MB 上限'), '应有截断说明');
  assert.ok(Buffer.byteLength(capped, 'utf8') < 11 * 1024 * 1024);
});

test('changeset：详情 / diff / revert 回滚 / accept 保留', async () => {
  // 详情
  const detail = await api(baseUrl, 'GET', `/api/projects/${pid}/changesets/${changesetId}`, { token: user.token });
  assert.equal(detail.status, 200);
  assert.equal(detail.data.changeset.files[0].filePath, 'note.txt');

  // diff
  const diff = await api(baseUrl, 'GET', `/api/projects/${pid}/changesets/${changesetId}/diff?file=note.txt`, { token: user.token });
  assert.equal(diff.status, 200);
  assert.equal(diff.data.before, '');
  assert.equal(diff.data.after, 'line1\nline2\n');
  assert.ok(diff.data.patch.includes('+line1'));

  // revert（before=null → 删除文件）
  const rev = await api(baseUrl, 'POST', `/api/projects/${pid}/changesets/${changesetId}/revert`, {
    token: user.token, body: {},
  });
  assert.equal(rev.status, 200);
  assert.equal(rev.data.changeset.status, 'reverted');
  assert.equal(rev.data.changeset.files[0].status, 'reverted');
  assert.ok(!fs.existsSync(projectFile('note.txt')), 'revert 后文件应被删除');

  // 再来一轮产生新 changeset，然后 accept
  const events = await readSSE(`${baseUrl}/api/projects/${pid}/agent/chat`, {
    token: user.token, body: { message: '再写一次 note.txt' },
  });
  const cs2 = events.find((e) => e.type === 'changeset').changeset;
  assert.ok(fs.existsSync(projectFile('note.txt')));
  const acc = await api(baseUrl, 'POST', `/api/projects/${pid}/changesets/${cs2.id}/accept`, {
    token: user.token, body: {},
  });
  assert.equal(acc.status, 200);
  assert.equal(acc.data.changeset.status, 'accepted');
  assert.equal(fs.readFileSync(projectFile('note.txt'), 'utf8'), 'line1\nline2\n');

  // accepted 的文件跳过 revert（幂等保护）
  const rev2 = await api(baseUrl, 'POST', `/api/projects/${pid}/changesets/${cs2.id}/revert`, {
    token: user.token, body: {},
  });
  assert.equal(rev2.data.changeset.status, 'accepted');
  assert.ok(fs.existsSync(projectFile('note.txt')));

  // 跨项目访问防护
  const other = await api(baseUrl, 'GET', `/api/projects/9999/changesets/${cs2.id}`, { token: user.token });
  assert.equal(other.status, 404);
});

test('selection-action：explain 不产 changeset，optimize 产 changeset', async () => {
  const content = fs.readFileSync(projectFile('main.tex'), 'utf8');
  const start = content.indexOf('Hello, CoreLatex!');
  const end = start + 'Hello, CoreLatex!'.length;
  assert.ok(start >= 0);

  const evExplain = await readSSE(`${baseUrl}/api/projects/${pid}/agent/selection-action`, {
    token: user.token, body: { action: 'explain', file: 'main.tex', start, end },
  });
  assert.ok(evExplain.some((e) => e.type === 'token'));
  assert.equal(lastManuscriptReference.file, 'main.tex');
  assert.equal(lastManuscriptReference.precedingText, content.slice(0, start).slice(-1400));
  assert.equal(lastManuscriptReference.followingText, content.slice(end, end + 1400));
  assert.ok(!evExplain.some((e) => e.type === 'changeset'), 'explain 不应产生 changeset');
  assert.equal(evExplain[evExplain.length - 1].type, 'done');
  assert.ok(fs.readFileSync(projectFile('main.tex'), 'utf8').includes('Hello, CoreLatex!'));

  const evOpt = await readSSE(`${baseUrl}/api/projects/${pid}/agent/selection-action`, {
    token: user.token, body: { action: 'optimize', file: 'main.tex', start, end },
  });
  const csEv = evOpt.find((e) => e.type === 'changeset');
  assert.ok(csEv, 'optimize 应产生 changeset');
  assert.equal(csEv.changeset.files[0].filePath, 'main.tex');
  assert.equal(csEv.changeset.applied, true);
  assert.deepEqual(evOpt.filter((e) => e.type === 'tool' && e.status === 'end').map((e) => e.name), ['read_file', 'edit_file', 'compile_and_preview']);
  assert.equal(evOpt.findLast((e) => e.type === 'workflow').graph.status, 'completed');
  const compiledSources = fs.readFileSync(path.join(dataDir, 'compiled-sources.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(compiledSources.length > 0);
  assert.ok(compiledSources.every(source => source.includes('Hello, optimized CoreLatex!')), '正常编译必须读取最新暂存稿');
  const after = fs.readFileSync(projectFile('main.tex'), 'utf8');
  assert.ok(after.includes('Hello, optimized CoreLatex!'));
  assert.ok(!after.includes('Hello, CoreLatex!'));

  // 非法 action
  const bad = await api(baseUrl, 'POST', `/api/projects/${pid}/agent/selection-action`, {
    token: user.token, body: { action: 'hack', file: 'main.tex', start: 0, end: 1 },
  });
  assert.equal(bad.status, 400);
});

test('选中内容：对话只存一行引用，原文注入模型消息而不落库', async () => {
  const events = await readSSE(`${baseUrl}/api/projects/${pid}/agent/chat`, {
    token: user.token,
    body: {
      chatId,
      message: '> 📎 **选中内容** · main.tex（第 1–2 行）\n\n解释这段',
      selection: { file: 'main.tex', startLine: 1, endLine: 2, text: 'SECRET-SELECTION-TEXT' },
    },
  });
  assert.equal(events[events.length - 1].type, 'done');

  // 落库的用户消息不含原文（对话面板只显示一行引用）
  const msgs = await api(baseUrl, 'GET', `/api/projects/${pid}/chat`, { token: user.token });
  const lastUser = [...msgs.data.messages].reverse().find((m) => m.role === 'user');
  assert.ok(!lastUser.content.includes('SECRET-SELECTION-TEXT'), '原文不应落库');
  assert.match(lastUser.content, /选中内容/);

  // 模型收到的最后一条 user 消息带原文注入块
  assert.match(lastWireUser, /\[用户选中的内容（main\.tex · 第 1–2 行）\]/);
  assert.match(lastWireUser, /SECRET-SELECTION-TEXT/);
  assert.match(lastWireUser, /\[选中内容结束\]/);
});

test('review handoff passes the live discussion to the model and keeps the review open', async () => {
  const { getDb } = await import('../src/db.js');
  const db = getDb();
  const insert = db.prepare('INSERT INTO reviews(project_id,file_path,start_offset,end_offset,quoted_text,content,author_id) VALUES(?,?,?,?,?,?,?)');
  const args = ['results.tex', 42, 58, 'The effect was significant.', 'Report the interval and qualify the claim.', user.user.id];
  const id = Number(insert.run(diskId, ...args).lastInsertRowid);
  const otherId = Number(insert.run(diskId + 99, ...args).lastInsertRowid);
  for (const reply of ['Use the paired analysis.', 'The interval includes zero.']) {
    db.prepare('INSERT INTO review_replies(review_id,author_id,content) VALUES(?,?,?)').run(id, user.user.id, reply);
  }
  const endpoint = '/api/projects/' + pid + '/agent/chat';
  const body = { message: '解释批注对应的结果', reviewId: id, currentFile: 'old-tab.tex' };
  const events = await readSSE(baseUrl + endpoint, { token: user.token, body });
  assert.equal(events.at(-1).type, 'done');
  assert.equal(lastManuscriptReference.file, 'results.tex');
  assert.equal(lastManuscriptReference.review.quote, args[3]);
  assert.deepEqual(lastManuscriptReference.review.recentReplies.map(item => item.text), ['Use the paired analysis.', 'The interval includes zero.']);
  assert.ok(lastManuscriptReference.review.recentReplies.every(item => item.author));
  assert.equal(db.prepare('SELECT status FROM reviews WHERE id=?').get(id).status, 'open');
  const history = await api(baseUrl, 'GET', '/api/projects/' + pid + '/chat', { token: user.token });
  assert.match(history.data.messages.findLast(m => m.role === 'user').content, /> .+：The interval includes zero/);
  const reject = other => api(baseUrl, 'POST', endpoint, { token: user.token, body: { ...body, reviewId: other } });
  assert.equal((await reject(otherId)).status, 404);
  db.prepare("UPDATE reviews SET status='done' WHERE id=?").run(id);
  assert.equal((await reject(id)).status, 409);
});

test('轮次无上限：连续多轮工具调用直到模型自行收尾', async () => {
  const events = await readSSE(`${baseUrl}/api/projects/${pid}/agent/chat`, {
    token: user.token,
    body: { message: '请循环到停测试' },
  });
  const toolEnds = events.filter((e) => e.type === 'tool' && e.status === 'end');
  assert.equal(toolEnds.length, 3); // 3 轮工具全部执行，无轮数截断
  assert.equal(events[events.length - 1].type, 'done');
  const text = events.filter((e) => e.type === 'token').map((e) => e.text).join('');
  assert.match(text, /循环完成。/);
  assert.ok(!/暂停/.test(text), '自然收尾不应出现暂停说明');
});

// ---------- skills ----------

test('skills：zip 导入（单层顶层目录）/ 列表 / 删除', async () => {
  const zip = await makeZip([
    { name: 'demo-skill/SKILL.md', content: '---\nname: demo-skill\ndescription: 演示技能\n---\n\n# demo-skill\n\n正文说明。\n' },
    { name: 'demo-skill/scripts/run.sh', content: 'echo hi\n' },
  ]);
  const form = new FormData();
  form.append('file', new Blob([zip], { type: 'application/zip' }), 'skill.zip');
  const imp = await api(baseUrl, 'POST', '/api/settings/skills/import', { token: user.token, body: form });
  assert.equal(imp.status, 200);
  assert.deepEqual(imp.data.imported, ['demo-skill']);
  // 目录与文件落盘
  const skillDir = path.join(dataDir, 'skills', String(user.user.id), 'demo-skill');
  assert.ok(fs.existsSync(path.join(skillDir, 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(skillDir, 'scripts', 'run.sh')));

  const list = await api(baseUrl, 'GET', '/api/settings/skills', { token: user.token });
  assert.equal(list.status, 200);
  assert.deepEqual(list.data.skills, [{ name: 'demo-skill', description: '演示技能', enabled: true }]);

  const del = await api(baseUrl, 'DELETE', '/api/settings/skills/demo-skill', { token: user.token });
  assert.equal(del.status, 200);
  const list2 = await api(baseUrl, 'GET', '/api/settings/skills', { token: user.token });
  assert.deepEqual(list2.data.skills, []);
});

test('skills：zip 根即 skill 目录 / 路径穿越防护', async () => {
  const rootZip = await makeZip([
    { name: 'SKILL.md', content: '# 根目录技能\n\n说明文字。\n' },
  ]);
  const form = new FormData();
  form.append('file', new Blob([rootZip]), 'root.zip');
  const imp = await api(baseUrl, 'POST', '/api/settings/skills/import', { token: user.token, body: form });
  assert.equal(imp.status, 200);
  assert.equal(imp.data.imported.length, 1);

  const evil = makeRawZip([{ name: '../evil/SKILL.md', content: '# x\n' }]);
  const form2 = new FormData();
  form2.append('file', new Blob([evil]), 'evil.zip');
  const imp2 = await api(baseUrl, 'POST', '/api/settings/skills/import', { token: user.token, body: form2 });
  assert.equal(imp2.status, 400, '全部条目穿越 → 无 SKILL.md → 400');
  assert.ok(!fs.existsSync(path.join(dataDir, 'skills', 'evil')));
});

// ---------- mcp ----------

test('mcp：SDK 未安装时 getMcpTools 返回 []（不崩溃）', async () => {
  // 配置一个 server，验证缺包降级路径
  await api(baseUrl, 'PUT', '/api/settings/ai', {
    token: user.token, body: { mcpConfig: { servers: [{ name: 'noop', command: 'cat' }] } },
  });
  const { getMcpTools } = await import('../src/services/agent/mcp.js');
  assert.deepEqual(await getMcpTools(user.user.id), []);
  const r = await api(baseUrl, 'POST', '/api/settings/mcp/test', { token: user.token, body: {} });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.tools, []);
});

// ---------- 错误路径 ----------

test('未配置模型：agent chat 返回 400 错误', async () => {
  const u2 = await registerAndLogin(baseUrl, 'noconfig');
  const p = await api(baseUrl, 'POST', '/api/projects', { token: u2.token, body: { name: 'p2' } });
  const r = await api(baseUrl, 'POST', `/api/projects/${p.data.project.publicId}/agent/chat`, {
    token: u2.token, body: { message: 'hi' }, raw: true,
  });
  assert.equal(r.status, 400);
});

test('权限：viewer 不能调用 agent chat / changeset 写操作', async () => {
  // owner 把 noconfig 加为 viewer
  await api(baseUrl, 'POST', `/api/projects/${pid}/members`, {
    token: user.token, body: { username: 'noconfig', role: 'viewer' },
  });
  const viewer = { token: (await api(baseUrl, 'POST', '/api/auth/login', { body: { username: 'noconfig', password: 'pass1234' } })).data.token };
  const r = await api(baseUrl, 'POST', `/api/projects/${pid}/agent/chat`, {
    token: viewer.token, body: { message: 'x' }, raw: true,
  });
  assert.equal(r.status, 403);
  const rv = await api(baseUrl, 'POST', `/api/projects/${pid}/changesets/1/revert`, {
    token: viewer.token, body: {},
  });
  assert.equal(rv.status, 403);
  // viewer 可读自己的会话（每用户每项目一条，互不可见对方消息）
  const list = await api(baseUrl, 'GET', `/api/projects/${pid}/chat`, { token: viewer.token });
  assert.equal(list.status, 200);
  assert.deepEqual(list.data.messages, []);
});

test('时间线步骤：老库缺 steps 列时由轻量迁移补齐，老消息返回空数组', async () => {
  const { getDb, resetDb } = await import('../src/db.js');
  const db = getDb();
  const info = db.prepare("INSERT INTO chat_messages (chat_id, role, content) VALUES (?, 'assistant', ?)")
    .run(chatId, '老版本落库的回答');

  // 模拟老库：去掉 steps 列后重开，迁移应补回该列且老行读作空数组
  db.exec('ALTER TABLE chat_messages DROP COLUMN steps');
  resetDb();
  const db2 = getDb();
  const cols = db2.prepare('PRAGMA table_info(chat_messages)').all().map((r) => r.name);
  assert.ok(cols.includes('steps'), '轻量迁移应补回 steps 列');

  const msgs = await api(baseUrl, 'GET', `/api/projects/${pid}/chat`, { token: user.token });
  const legacy = msgs.data.messages.find((m) => m.id === Number(info.lastInsertRowid));
  assert.equal(legacy.content, '老版本落库的回答');
  assert.deepEqual(legacy.steps, [], '老数据 steps 缺省为空数组');
  assert.deepEqual(legacy.toolCalls, []);
});

test('会话：清空会话删除全部消息并重置压缩摘要', async () => {
  const del = await api(baseUrl, 'DELETE', `/api/projects/${pid}/chat`, { token: user.token });
  assert.equal(del.status, 200);
  const msgs = await api(baseUrl, 'GET', `/api/projects/${pid}/chat`, { token: user.token });
  assert.equal(msgs.status, 200);
  assert.equal(msgs.data.chatId, chatId, '清空后会话行保留');
  assert.deepEqual(msgs.data.messages, []);
});

test('AI 用量：agent chat 记录 token 用量，usage 端点返回累计与 30 天序列', async () => {
  // 一轮带工具的对话（mock 每轮 usage：prompt 11 / completion 4，多轮循环累计更多）
  const events = await readSSE(`${baseUrl}/api/projects/${pid}/agent/chat`, {
    token: user.token, body: { message: '请循环到停测试' },
  });
  assert.equal(events[events.length - 1].type, 'done');
  const usage = await api(baseUrl, 'GET', '/api/users/me/usage', { token: user.token });
  assert.equal(usage.status, 200);
  assert.ok(usage.data.ai.requests >= 1, '至少记录一次 AI 请求');
  assert.ok(usage.data.ai.inputTokens > 0 && usage.data.ai.outputTokens > 0);
  assert.equal(usage.data.aiDaily.length, 30, '按天序列固定 30 天');
  const today = usage.data.aiDaily[29];
  assert.ok(today.inputTokens > 0, '当天应有用量');
  assert.ok(usage.data.systemDaily.length === 30);
});

test('多模型：models 数组保存/脱敏返回/切换 active/旧字段同步', async () => {
  const put = await api(baseUrl, 'PUT', '/api/settings/ai', {
    token: user.token,
    body: {
      models: [
        { id: 'm1', name: '主力', provider: 'openai', baseUrl: `${llmBase}/v1`, apiKey: 'sk-key111222333', model: 'gpt-mock', contextLength: 262144 },
        { id: 'm2', name: '备选', provider: 'anthropic', baseUrl: '', apiKey: '***9999', model: 'claude-mock' },
      ],
      activeModelId: 'm2',
    },
  });
  assert.equal(put.status, 200);
  const get = await api(baseUrl, 'GET', '/api/settings/ai', { token: user.token });
  assert.equal(get.data.models.length, 2);
  assert.equal(get.data.activeModelId, 'm2');
  // m2 的 apiKey 传 *** 开头 → 保留旧值；这里旧值不存在 → 空
  assert.equal(get.data.models[1].hasKey, false);
  assert.equal(get.data.models[0].apiKey, '***2333');
  // 兼容旧字段 = 选中条目
  assert.equal(get.data.provider, 'anthropic');
  assert.equal(get.data.model, 'claude-mock');
  // 切回 m1 供其他用例使用；请求级 modelId 持久化为 active
  await api(baseUrl, 'PUT', '/api/settings/ai', {
    token: user.token,
    body: { models: [{ id: 'm1', name: '主力', provider: 'openai', baseUrl: `${llmBase}/v1`, apiKey: 'sk-key111222333', model: 'gpt-mock', contextLength: 262144 }], activeModelId: 'm1' },
  });
  const get2 = await api(baseUrl, 'GET', '/api/settings/ai', { token: user.token });
  assert.equal(get2.data.activeModelId, 'm1');
  assert.equal(get2.data.model, 'gpt-mock');
});

test('上下文压缩：超预算历史自动压缩为摘要，旧消息不再回放给模型', async () => {
  const { getDb } = await import('../src/db.js');
  getDb().prepare("INSERT INTO chat_messages (chat_id, role, content) VALUES (?, 'user', ?)").run(chatId, '历史上下文'.repeat(2000));
  // 模型上下文长度有最小值，使用真实超预算历史验证压缩，而非依赖过量输出预留
  await api(baseUrl, 'PUT', '/api/settings/ai', {
    token: user.token,
    body: {
      models: [{ id: 'mtiny', name: 'tiny', provider: 'openai', baseUrl: `${llmBase}/v1`, apiKey: 'sk-tiny', model: 'gpt-mock', contextLength: 300 }],
      activeModelId: 'mtiny',
    },
  });
  // 已经有多轮历史（前面用例写入），再发一条触发压缩
  const events = await readSSE(`${baseUrl}/api/projects/${pid}/agent/chat`, {
    token: user.token, body: { message: '压缩后再聊一句' },
  });
  assert.equal(events[events.length - 1].type, 'done');

  const chat = getDb().prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
  assert.ok(chat.summary.length > 0, '压缩摘要应写入会话行');
  assert.ok(chat.summary_msg_id > 0, '压缩水位应推进');
  // 水位之后仍有本轮消息
  const after = getDb().prepare('SELECT COUNT(*) AS c FROM chat_messages WHERE chat_id = ? AND id > ?').get(chatId, chat.summary_msg_id);
  assert.ok(after.c >= 2, '水位后应保留最新一轮消息');
  // 切回正常模型
  await api(baseUrl, 'PUT', '/api/settings/ai', {
    token: user.token,
    body: {
      models: [{ id: 'm1', name: '主力', provider: 'openai', baseUrl: `${llmBase}/v1`, apiKey: 'sk-key111222333', model: 'gpt-mock', contextLength: 262144 }],
      activeModelId: 'm1',
    },
  });
});
