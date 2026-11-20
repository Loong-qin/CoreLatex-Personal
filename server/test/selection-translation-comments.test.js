import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { api, registerAndLogin } from './helpers.js';

// Exercise the real selection route, provider adapter and edit tools against a
// loopback-only model and disposable database. No production state is imported.
const paragraphOne = String.raw`Our method estimates the score $s(x)$ using 12 samples \cite{smith2025}. It does not assume that all checkpoints have equal variance.`;
const paragraphTwo = String.raw`Table~\ref{tab:results} reports a gain of 4.2\% on Dataset-A. However, the improvement may disappear when the sample count is below 8.`;
const translationOne = String.raw`% 中文：我们的方法使用 12 个样本估计分数 $s(x)$ \cite{smith2025}。
% 它不假设所有检查点都具有相同的方差。`;
const translationTwo = String.raw`% 中文：表~\ref{tab:results} 报告了在 Dataset-A 上 4.2\% 的提升。
% 然而，当样本数量低于 8 时，这种改进可能消失。`;
const prefix = String.raw`\documentclass{article}
\newcommand{\unchanged}{42}
\begin{document}
`;
const suffix = '\n\\end{document}\n';
const cases = [
  {
    name: '完整翻译两个段落，逐句保留否定、数字、引用与条件',
    selected: `${paragraphOne}\n\n${paragraphTwo}`,
    search: `${paragraphOne}\n\n${paragraphTwo}`,
    replacement: `${paragraphOne}\n${translationOne}\n\n${paragraphTwo}\n${translationTwo}`,
    annotationCount: 2,
  },
  {
    name: '读取选区周边并补全已有摘要译注，保留原英文且不堆叠译注',
    selected: paragraphOne,
    search: `${paragraphOne}\n% 中文：方法分数概述。`,
    replacement: `${paragraphOne}\n${translationOne}`,
    annotationCount: 1,
  },
];

let appServer, modelServer, baseUrl, dataDir, user, resetDb;
let activeCase;
const receivedRequests = [];
const sse = (data) => `data: ${JSON.stringify(data)}\n\n`;
const textOf = (message) => typeof message.content === 'string'
  ? message.content
  : (message.content || []).filter((part) => part.type === 'text').map((part) => part.text).join('\n');

function toolResponse(name, args, sequence) {
  const serialized = JSON.stringify(args);
  return sse({ choices: [{ index: 0, delta: { tool_calls: [{
    index: 0, id: `translation_${sequence}`, type: 'function', function: { name, arguments: '' },
  }] } }] })
    + sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: serialized.slice(0, 13) } }] } }] })
    + sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: serialized.slice(13) } }] } }] })
    + sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
    + 'data: [DONE]\n\n';
}

before(async () => {
  // Set this before dynamically importing any application/config modules.
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'corelatex-selection-translation-'));
  process.env.CORELATEX_DATA_DIR = dataDir;
  ({ resetDb } = await import('../src/db.js'));
  resetDb();
  const { requireAuth } = await import('../src/auth.js');
  const { HttpError } = await import('../src/util.js');
  const { default: authRoutes } = await import('../src/routes/auth.js');
  const { default: projectRoutes } = await import('../src/routes/projects.js');
  const { default: fileRoutes } = await import('../src/routes/files.js');
  const { default: aiRoutes, settingsRouter } = await import('../src/routes/ai.js');
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRoutes);
  app.use('/api/projects', requireAuth, projectRoutes);
  app.use('/api/projects', requireAuth, fileRoutes);
  app.use('/api/projects', requireAuth, aiRoutes);
  app.use('/api/settings', requireAuth, settingsRouter);
  app.use((err, _req, res, _next) => {
    res.status(err instanceof HttpError ? err.status : 500).json({ error: err.message });
  });
  appServer = http.createServer(app);
  await new Promise((resolve) => appServer.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${appServer.address().port}`;

  modelServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      if (req.url !== '/v1/chat/completions' || !activeCase) {
        res.writeHead(404).end();
        return;
      }
      const request = JSON.parse(body);
      receivedRequests.push(request);
      const called = new Set(request.messages.flatMap((message) =>
        (message.tool_calls || []).map((call) => call.function.name)));
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (!called.has('read_file')) {
        res.end(toolResponse('read_file', { path: 'main.tex' }, 1));
      } else if (!called.has('edit_file')) {
        res.end(toolResponse('edit_file', {
          path: 'main.tex', search: activeCase.search, replace: activeCase.replacement,
        }, 2));
      } else {
        res.end(sse({ choices: [{ index: 0, delta: { role: 'assistant', content: '已保留英文原文，并补全各句对应的中文译注。' } }] })
          + sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
          + 'data: [DONE]\n\n');
      }
    });
  });
  await new Promise((resolve) => modelServer.listen(0, '127.0.0.1', resolve));
  user = await registerAndLogin(baseUrl, 'selection-translator');
  assert.ok(user.token);
  const configured = await api(baseUrl, 'PUT', '/api/settings/ai', {
    token: user.token,
    body: {
      provider: 'openai', baseUrl: `http://127.0.0.1:${modelServer.address().port}/v1`,
      apiKey: 'mock-local-only', model: 'translation-test', chineseSupport: true,
      agentConfig: { graphOrchestration: false, confirmBeforeApply: false, allowRunScripts: false, allowWebAccess: false },
    },
  });
  assert.equal(configured.status, 200);
});

after(async () => {
  for (const server of [appServer, modelServer]) {
    if (server) await new Promise((resolve) => server.close(resolve));
  }
  resetDb?.();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

for (const fixture of cases) {
  test(`selection-action:add-comment：${fixture.name}`, { timeout: 20000 }, async () => {
    activeCase = fixture;
    receivedRequests.length = 0;
    const created = await api(baseUrl, 'POST', '/api/projects', {
      token: user.token, body: { name: fixture.name },
    });
    assert.equal(created.status, 201);
    const { publicId, id } = created.data.project;
    const source = prefix + fixture.search + suffix;
    fs.writeFileSync(path.join(dataDir, 'projects', String(id), 'main.tex'), source);
    const start = source.indexOf(fixture.selected);
    assert.ok(start >= 0);
    const response = await fetch(`${baseUrl}/api/projects/${publicId}/agent/selection-action`, {
      method: 'POST', signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${user.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'add-comment', file: 'main.tex', start, end: start + fixture.selected.length, selectionText: fixture.selected }),
    });
    assert.equal(response.status, 200);
    const events = (await response.text()).split('\n').filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)));

    // Assert the actual provider request, not an imported instruction constant.
    assert.ok(receivedRequests.length >= 3, '模型应完成读取、修改、回复三个阶段');
    const instruction = receivedRequests[0].messages.filter((message) => message.role === 'user')
      .map(textOf).find((content) => content.includes('原选区文本：'));
    assert.ok(instruction, '模型必须收到完整选区动作指令');
    assert.ok(instruction.endsWith(fixture.selected));
    assert.match(instruction, /逐段.*完整中文/);
    assert.match(instruction, /逐句.*翻译全部信息/);
    assert.match(instruction, /不能只写摘要或大意/);
    assert.match(instruction, /不设字数上限/);
    assert.doesNotMatch(instruction, /不超过\s*40\s*字|用一句[^。]*概括/);
    assert.match(instruction, /保持英文原文不变/);
    assert.match(instruction, /先读取选区附近内容/);
    assert.match(instruction, /补全或替换同一条译注.*不重复堆叠/);
    assert.ok(receivedRequests[1].messages.some((message) => message.role === 'tool' && textOf(message).includes(fixture.search)), '编辑前必须实际读到原文和已有译注');
    assert.equal(events.at(-1)?.type, 'done');
    assert.equal(events.at(-1)?.state, 'completed', JSON.stringify(events.filter((event) => ['error', 'token'].includes(event.type))));
    assert.ok(events.some((event) => event.type === 'changeset' && event.changeset.files.some((file) => file.filePath === 'main.tex')));

    const saved = await api(baseUrl, 'GET', `/api/projects/${publicId}/file?path=main.tex`, { token: user.token, raw: true });
    assert.equal(saved.status, 200);
    const content = await saved.text();
    assert.equal(content, prefix + fixture.replacement + suffix, '真实 edit_file 结果应完整写回文件，且不改动选区外内容');
    assert.equal((content.match(/^% 中文：/gm) || []).length, fixture.annotationCount);
    assert.ok(content.includes(translationOne));
    assert.ok(translationOne.length > 40, '译注必须能保留全部事实，不能被旧40字摘要要求截断');
    assert.ok(!content.includes('% 中文：方法分数概述。'));
  });
}
