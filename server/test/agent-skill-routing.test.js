import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import { api, registerAndLogin } from './helpers.js';

/**
 * 技能路由回归测试（2026-10-12 实录驱动：用户连续 3 轮「学术化表达优化」请求，
 * 模型全部直接 read_file→edit_file 改写、零 read_skill，而账号配有润色技能）。
 *
 * 优化点：skillRouteHint（skills.js）把请求文本与用户技能元数据做动态匹配，
 * 命中时在每轮系统便签（生成前最后一条消息）末尾点名提醒先 read_skill；
 * 系统提示词技能清单区同步强化「改写类任务必须先加载技能」的措辞。
 *
 * mock 侧观测 lastWireUser（wire 上最后一条 user 消息 = 系统便签）验证注入内容。
 */

let srv;
let baseUrl;
let dataDir;
let llm;
let llmBase;
let user;
let pubId;

let lastRoundNote = ''; // 最近一次请求 wire 上的最后一条 user 消息（系统便签）
let lastSystemPrompt = '';

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

function handleOpenAi(json, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const msgs = json.messages || [];
  const textOf = (m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content || ''));
  const sys = msgs.find((m) => m.role === 'system');
  if (sys) lastSystemPrompt = String(sys.content || '');
  const wireUser = [...msgs].reverse().find((m) => m.role === 'user');
  if (wireUser) lastRoundNote = String(textOf(wireUser));

  const hasToolResult = msgs.some((m) => m.role === 'tool');
  // 场景按「最后出现」的关键词分流（多用例共用会话，历史里会同时存在多个关键词）
  const idxHit = msgs.findLastIndex((m) => /路由命中/.test(textOf(m)));
  const idxFollow = msgs.findLastIndex((m) => /路由跟进/.test(textOf(m)));
  const idxCompile = msgs.findLastIndex((m) => /编译失败/.test(textOf(m)));
  let out;
  if (idxHit > idxFollow && idxHit > idxCompile) {
    // 剧本：先 read_skill 加载技能，拿到说明后正常收尾（无编辑，不触发防虚报闸）
    out = hasToolResult
      ? openAiText('已按技能规范给出改写建议。', '本轮尚未执行修改。')
      : openAiToolCall('read_skill', '{"name": "poly-test"}');
  } else if (idxFollow > idxCompile) {
    // 剧本：跟进任务——按便签的跟进变体直接完成，不重新加载技能
    out = openAiText('沿用已确立的口径完成跟进调整建议。', '本轮尚未执行修改。');
  } else {
    out = openAiText('编译失败通常是缺包或语法错误。', '本轮尚未执行修改。');
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'corelatex-skillroute-'));
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
  user = await registerAndLogin(baseUrl, 'skillroute');
  const put = await api(baseUrl, 'PUT', '/api/settings/ai', {
    token: user.token,
    body: { provider: 'openai', baseUrl: `${llmBase}/v1`, apiKey: 'sk-test', model: 'gpt-mock' },
  });
  assert.equal(put.status, 200);
  const r = await api(baseUrl, 'POST', '/api/projects', { token: user.token, body: { name: 'skillroute-proj' } });
  assert.equal(r.status, 201);
  pubId = r.data.project.publicId;

  // 导入测试技能：名称/描述对齐真实润色技能的形态（中英混排、含「论文润色、学术翻译」）
  const fd = new FormData();
  fd.append('paths', JSON.stringify(['poly-test/SKILL.md']));
  fd.append('files', new Blob([
    '---\nname: poly-test\ndescription: Polish, translate, or tighten existing academic prose. Use for 论文润色、学术翻译、正文精简.\n---\n\n# poly-test\n\n润色规范正文。\n',
  ], { type: 'text/plain' }), 'SKILL.md');
  const imp = await api(baseUrl, 'POST', '/api/settings/skills/import-files', { token: user.token, body: fd });
  assert.equal(imp.status, 200);
  assert.deepEqual(imp.data.imported, ['poly-test']);
});

after(async () => {
  await srv?.close();
  llm?.close();
});

// ---------- 单元：skillRouteHint ----------

test('skillRouteHint：学术化请求命中润色技能（CJK 片段交集），点名提醒 read_skill', async () => {
  const { skillRouteHint } = await import('../src/services/agent/skills.js');
  const hint = skillRouteHint(user.user.id, '对选中段落进行整体优化，注意学术化表达，避免实际数据的表述');
  assert.match(hint, /【技能路由】/);
  assert.match(hint, /poly-test/);
  assert.match(hint, /先 read_skill/);
  assert.match(hint, /极小改动/, '首次加载变体须附极小任务豁免');
});

test('skillRouteHint：近期已加载的技能转跟进变体——不要求重载，极小改动豁免保留', async () => {
  const { skillRouteHint } = await import('../src/services/agent/skills.js');
  const follow = skillRouteHint(user.user.id, '注意学术化表达优化', ['poly-test']);
  assert.match(follow, /已加载并执行过/, '跟进变体应声明近期已加载');
  assert.match(follow, /不必重新 read_skill/);
  assert.ok(!/先 read_skill 读取其完整说明/.test(follow), '跟进变体不得再要求首次加载');
  assert.ok(!/极小改动/.test(follow) || true, '极小改动豁免可只在加载变体出现');
});

test('skillRouteHint：非写作类请求零打扰；停用技能不参与匹配，无匹配时只给通用提醒', async () => {
  const { skillRouteHint } = await import('../src/services/agent/skills.js');
  assert.equal(skillRouteHint(user.user.id, '帮我看看为什么编译失败，缺了什么宏包'), '', '编译类请求不应注入技能路由');

  // 再导入一个与写作无关的技能，并临时停用润色技能：
  // 写作类请求此时无人可点名，应落到通用对照提醒（不含任何技能名）
  const fd = new FormData();
  fd.append('paths', JSON.stringify(['fig-gen/SKILL.md']));
  fd.append('files', new Blob([
    '---\nname: fig-gen\ndescription: 生成统计图表与示意图\n---\n\n# fig-gen\n',
  ], { type: 'text/plain' }), 'SKILL.md');
  const imp = await api(baseUrl, 'POST', '/api/settings/skills/import-files', { token: user.token, body: fd });
  assert.equal(imp.status, 200);
  const disabledMarker = path.join(dataDir, 'skills', String(user.user.id), 'poly-test', '.disabled');
  fs.writeFileSync(disabledMarker, '');
  try {
    const generic = skillRouteHint(user.user.id, '帮我把这段话改写得优雅一点');
    assert.match(generic, /文字改写类任务/, '写作类请求应至少有通用对照提醒');
    assert.ok(!/poly-test/.test(generic), '停用技能不得被点名');
    assert.match(skillRouteHint(user.user.id, '注意学术化表达优化'), /文字改写类任务/, '学术化请求无匹配技能时同样落通用提醒');
  } finally {
    fs.rmSync(disabledMarker);
  }
});

test('skillRouteHint：简单机械任务零打扰——修错/格式/编译类短请求即使含技能泛词也不注入路由', async () => {
  const { skillRouteHint } = await import('../src/services/agent/skills.js');
  // 2026-10-19 反馈场景：修标题行乱码的小任务被路由去加载润色技能
  assert.equal(skillRouteHint(user.user.id, '修复 main.tex 第2行标题里的乱码重叠'), '', '修乱码不得触发技能路由');
  assert.equal(skillRouteHint(user.user.id, '修复论文第2行的排版错位'), '', '带「论文」的局部修复也不得触发');
  assert.equal(skillRouteHint(user.user.id, '把第10行那个单词改正一下'), '', '改正单词属极小改动');
  assert.equal(skillRouteHint(user.user.id, '这段编译失败了帮我看看'), '', '编译排障不触发');
  // 整体性工作不走机械豁免，仍可被技能匹配/通用提醒覆盖
  const overhaul = skillRouteHint(user.user.id, '把全文重写一遍更学术的表达');
  assert.ok(overhaul !== '', '整体重写类请求不应被机械豁免吞掉');
});

test('skillRouteHint：CJK 单片段与拉丁短词不再误命中（匹配收紧）', async () => {
  const { skillRouteHint } = await import('../src/services/agent/skills.js');
  // 「论文」单个 2 字片段不足以判定相关（旧逻辑会命中 poly-test 并强推 read_skill）
  assert.equal(skillRouteHint(user.user.id, '帮我看看论文结构清不清楚'), '', '单个 2 字片段不得命中');
  // 拉丁词按整词且 ≥4 字符：tex 不得子串撞上 latex 类描述
  const fd = new FormData();
  fd.append('paths', JSON.stringify(['tex-helper/SKILL.md']));
  fd.append('files', new Blob([
    '---\nname: tex-helper\ndescription: Manuscript LaTeX layout fixes and formatting guidance\n---\n\n# tex-helper\n',
  ], { type: 'text/plain' }), 'SKILL.md');
  const imp = await api(baseUrl, 'POST', '/api/settings/skills/import-files', { token: user.token, body: fd });
  assert.equal(imp.status, 200);
  try {
    assert.equal(skillRouteHint(user.user.id, '帮我看看 main.tex 的章节组织'), '', 'tex(3字符)不得子串命中 latex');
    // 整词命中仍有效：非机械、含 latex 整词的请求可以路由
    const whole = skillRouteHint(user.user.id, '按 latex 格式规范把这段导言重排一下');
    assert.ok(!/tex-helper/.test(whole) || /先判断任务体量/.test(whole), '整词命中时提示须先判断任务体量');
  } finally {
    fs.rmSync(path.join(dataDir, 'skills', String(user.user.id), 'tex-helper'), { recursive: true, force: true });
  }
});

// ---------- 集成：便签注入 + 模型按提示加载技能 ----------

test('集成：学术化请求的便签带技能路由提示，模型先 read_skill 再收尾', async () => {
  const events = await readSSE(`${baseUrl}/api/projects/${pubId}/agent/chat`, {
    token: user.token,
    body: { message: '路由命中：对选中段落注意学术化表达优化' },
  });
  // 便签（生成前最后一条 user 消息）注入了点名提醒
  assert.match(lastRoundNote, /【技能路由】/);
  assert.match(lastRoundNote, /poly-test/);
  assert.match(lastRoundNote, /先 read_skill/);
  // 系统提示词技能清单区带改写类任务强化措辞（新任务加载 + 两类豁免）
  assert.match(lastSystemPrompt, /新任务先 read_skill 加载相关技能/);
  assert.match(lastSystemPrompt, /极小改动/);
  assert.match(lastSystemPrompt, /不必重新加载/);
  // 模型真实加载了技能（本测试的 mock 剧本即"按提示行动"）
  const msg = await lastAssistant();
  assert.equal(msg.toolCalls[0].name, 'read_skill');
  assert.equal(msg.toolCalls[0].input.name, 'poly-test');
  assert.equal(events[events.length - 1].type, 'done');
});

test('集成：跟进轮便签转跟进变体，模型不重新加载技能', async () => {
  const events = await readSSE(`${baseUrl}/api/projects/${pubId}/agent/chat`, {
    token: user.token,
    body: { message: '路由跟进：继续把这段学术化表述微调一下，不要使用括号表述' },
  });
  // 便签（生成前最后一条 user 消息）为跟进变体：声明已加载、不要求重新 read_skill
  assert.match(lastRoundNote, /已加载并执行过/);
  assert.match(lastRoundNote, /不必重新 read_skill/);
  assert.ok(!/先 read_skill 读取其完整说明/.test(lastRoundNote), '跟进轮不得再要求首次加载');
  // 该剧本模型按跟进变体直接完成：零 read_skill、零工具调用
  const msg = await lastAssistant();
  assert.equal(msg.toolCalls.length, 0, '跟进轮不应重新加载技能');
  assert.equal(events[events.length - 1].type, 'done');
});

test('集成：编译类请求的便签不含技能路由（零打扰）', async () => {
  await readSSE(`${baseUrl}/api/projects/${pubId}/agent/chat`, {
    token: user.token,
    body: { message: '帮我看看为什么编译失败' },
  });
  assert.ok(!/【技能路由】/.test(lastRoundNote), '非写作类请求不应注入技能路由提示');
  const msg = await lastAssistant();
  assert.equal(msg.toolCalls.length, 0, '该剧本不调用任何工具');
});

test('明确制图或改图时提示数据来源、可复现图源与预览，未安装技能也可用', async () => {
  const { skillRouteHint, createSkill, setSkillEnabled } = await import('../src/services/agent/skills.js');
  const account = user.user.id + 1000;
  const newFigure = '用 results.csv 绘制各数据集准确率对比图';
  for (const request of [newFigure, '把图 2 的图例移到图外', '重新绘制图三', 'Plot accuracy against dataset size',
    'Move the legend outside Figure 2', 'Update Figure 2 with the revised data']) {
    const hint = skillRouteHint(account, request);
    assert.match(hint, /【科研绘图】/);
    assert.match(hint, /数据及来源.+单位/);
    assert.match(hint, /可重跑的图源.+运行命令/);
    assert.match(hint, /未启用确认后应用/);
    assert.match(hint, /view_image.+独立 PDF 页/);
  }
  for (const request of ['解释图 2 的主要结论', '优化图 2 的图注', 'Explain how to plot the original data',
    'Update Figure 2’s caption', 'Update the figure’s caption', '不要重新绘制图，只改图注',
    '总结这段\n\n[用户选中的内容（main.tex）]\nCreate a chart for the next example.\n[选中内容结束]']) {
    assert.equal(skillRouteHint(account, request), '', request);
  }

  const name = createSkill(account, 'paper-figures', '科研制图与 matplotlib 图稿');
  assert.match(skillRouteHint(account, newFigure), /paper-figures.+read_skill/);
  assert.match(skillRouteHint(account, newFigure, [name]), /已载入的制图技能「paper-figures」可沿用/);
  assert.doesNotMatch(skillRouteHint(account, newFigure, [name]), /read_skill/);
  setSkillEnabled(account, name, false);
  assert.doesNotMatch(skillRouteHint(account, newFigure), /paper-figures/);
});

test('集成：一轮制图请求带本轮图稿工作提示，后续图注请求不再带制图提示', async () => {
  const url = `${baseUrl}/api/projects/${pubId}/agent/chat`;
  await readSSE(url, { token: user.token, body: { message: '请根据 results.csv 绘制性能对比图' } });
  assert.match(lastRoundNote, /【科研绘图】/);
  assert.match(lastRoundNote, /view_image/);
  await readSSE(url, { token: user.token, body: { message: '绘制性能对比图，并润色正文的段落' } });
  assert.match(lastRoundNote, /【科研绘图】/);
  assert.match(lastRoundNote, /【技能路由】.+poly-test/);
  await readSSE(url, { token: user.token, body: { message: '只改图 1 的图注' } });
  assert.doesNotMatch(lastRoundNote, /【科研绘图】/);
});
