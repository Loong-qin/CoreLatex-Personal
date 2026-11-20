import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { api, registerAndLogin } from './helpers.js';
import { parseLatexLog } from '../src/services/latexLog.js';
import { computeTexStats } from '../src/services/texStats.js';

const hasXelatex = spawnSync('which', ['xelatex']).status === 0;

// index.js 的挂载由集成方负责；测试自建等价 app（挂载 auth/projects/files/compile）
async function startCompileTestApp() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'corelatex-compile-test-'));
  process.env.CORELATEX_DATA_DIR = dataDir;
  const { resetDb } = await import('../src/db.js');
  resetDb();
  const express = (await import('express')).default;
  const { requireAuth } = await import('../src/auth.js');
  const { HttpError } = await import('../src/util.js');
  const authRoutes = (await import('../src/routes/auth.js')).default;
  const projectRoutes = (await import('../src/routes/projects.js')).default;
  const fileRoutes = (await import('../src/routes/files.js')).default;
  const compileRoutes = (await import('../src/routes/compile.js')).default;
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use('/api/auth', authRoutes);
  app.use('/api/projects', requireAuth, projectRoutes);
  app.use('/api/projects', requireAuth, fileRoutes);
  app.use('/api/projects', requireAuth, compileRoutes);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    console.error('[test server error]', err);
    res.status(500).json({ error: '服务器内部错误' });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.on('listening', r));
  const { port } = server.address();
  return {
    dataDir,
    baseUrl: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise((r) => server.close(r));
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

const ctx = {};

before(async () => {
  ctx.app = await startCompileTestApp();
  const { token } = await registerAndLogin(ctx.app.baseUrl, 'compiletester');
  ctx.token = token;
});

after(async () => {
  if (ctx.app) await ctx.app.close();
});

async function createProject(baseUrl, token, name, mainTex) {
  const { status, data } = await api(baseUrl, 'POST', '/api/projects', { token, body: { name } });
  assert.equal(status, 201);
  const id = data.project.publicId;
  await api(baseUrl, 'PATCH', `/api/projects/${id}`, { token, body: { texVersion: 'system' } });
  if (mainTex !== undefined) {
    const r = await api(baseUrl, 'POST', `/api/projects/${id}/files`, {
      token,
      body: { path: 'main.tex', content: mainTex, overwrite: true },
    });
    assert.equal(r.status, 200);
  }
  return id;
}

test('latexLog: 解析 file-line-error 错误、警告续行、忽略 Overfull', () => {
  const log = [
    'This is XeTeX, Version 3.141592653-2.6-0.999995 (TeX Live 2023/Debian)',
    '(./main.tex',
    '(/usr/share/texlive/texmf-dist/tex/latex/base/article.cls)',
    "LaTeX Warning: Reference `foo' on page 1 undefined on input line 4.",
    './main.tex:5: Undefined control sequence.',
    'l.5 \\undefinedcommand',
    '',
    'Overfull \\hbox (12.0pt too wide) in paragraph at lines 6--7',
    'Package hyperref Warning: Token not allowed in a PDF string',
    'on input line 8.',
    ')',
  ].join('\n');
  const { errors, warnings } = parseLatexLog(log);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].file, 'main.tex');
  assert.equal(errors[0].line, 5);
  assert.match(errors[0].message, /Undefined control sequence/);
  assert.equal(warnings.length, 2);
  assert.equal(warnings[0].line, 4);
  assert.match(warnings[0].message, /Reference/);
  assert.equal(warnings[1].line, 8);
  assert.match(warnings[1].message, /Token not allowed/);
});

test('latexLog: 经典 ! 错误用括号文件栈归属文件', () => {
  const log = [
    '(./chapters/intro.tex',
    '! Undefined control sequence.',
    'l.12 \\badcmd',
    ')',
  ].join('\n');
  const { errors } = parseLatexLog(log);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].file, 'chapters/intro.tex');
  assert.equal(errors[0].line, 12);
});

test('texStats: 标题/图表/公式/词数统计', () => {
  const src = [
    '% 注释行 ignored words here',
    '\\documentclass{article} % trailing comment',
    '\\begin{document}',
    '\\section{Intro 介绍}',
    'Body text here. % comment',
    '\\begin{figure}',
    'inside figure words',
    '\\end{figure}',
    'Inline $x^2$ and \\[ y=1 \\] and $$ z=2 $$.',
    '\\subsection*{Sub Two}',
    '\\end{document}',
  ].join('\n');
  const s = computeTexStats([src]);
  assert.equal(s.headings, 2);
  assert.equal(s.headingWords, 5); // Intro + 介 + 绍 + Sub + Two
  assert.equal(s.figuresAndTables, 1);
  assert.equal(s.inlineMath, 1);
  assert.equal(s.displayMath, 2);
  assert.ok(s.bodyWords >= 3, `bodyWords=${s.bodyWords}`);
  assert.ok(s.words > s.bodyWords, `words=${s.words} bodyWords=${s.bodyWords}`);
  assert.ok(s.otherWords >= 0);
  assert.equal(s.otherWords, s.words - s.bodyWords - s.headingWords);
});

test('编译: 最小文档成功，PDF/synctex/log/jobs 可用', { timeout: 120000 }, async (t) => {
  if (!hasXelatex) { t.skip('xelatex 不可用'); return; }
  const { baseUrl } = ctx.app; const { token } = ctx;
  const id = await createProject(baseUrl, token, 'compile-ok',
    '\\documentclass{article}\n\\begin{document}\nHello $x^2$ world.\n\\end{document}\n');

  const r = await api(baseUrl, 'POST', `/api/projects/${id}/compile`, { token, body: {} });
  assert.equal(r.status, 200);
  assert.equal(r.data.status, 'success');
  assert.ok(r.data.jobId > 0);
  assert.equal(r.data.errors.length, 0);
  assert.equal(r.data.synctexAvailable, true);

  const pdfRes = await api(baseUrl, 'GET', `/api/projects/${id}/pdf`, { token, raw: true });
  assert.equal(pdfRes.status, 200);
  const buf = Buffer.from(await pdfRes.arrayBuffer());
  assert.equal(buf.subarray(0, 4).toString(), '%PDF');

  const fwd = await api(baseUrl, 'GET', `/api/projects/${id}/synctex/code?file=main.tex&line=3&col=1`, { token });
  assert.equal(fwd.status, 200);
  assert.equal(fwd.data.page, 1);
  assert.ok(Number.isFinite(fwd.data.x) && Number.isFinite(fwd.data.y));

  const back = await api(baseUrl, 'GET',
    `/api/projects/${id}/synctex/pdf?page=${fwd.data.page}&x=${fwd.data.x}&y=${fwd.data.y}`, { token });
  assert.equal(back.status, 200);
  assert.equal(back.data.file, 'main.tex');
  assert.ok(back.data.line >= 1);

  const logById = await api(baseUrl, 'GET', `/api/projects/${id}/log?jobId=${r.data.jobId}`, { token, raw: true });
  assert.equal(logById.status, 200);
  const logText = await logById.text();
  assert.match(logText, /Output written/);

  const logLatest = await api(baseUrl, 'GET', `/api/projects/${id}/log`, { token, raw: true });
  assert.equal(logLatest.status, 200);

  const jobs = await api(baseUrl, 'GET', `/api/projects/${id}/compile/jobs`, { token });
  assert.equal(jobs.status, 200);
  assert.ok(jobs.data.jobs.length >= 1);
  assert.equal(jobs.data.jobs[0].username, 'compiletester');
  assert.equal(jobs.data.jobs[0].status, 'success');
});

test('编译: 历史 PDF 和 SyncTeX 保持同一构建，失败后保留最近成功的版本', { timeout: 120000 }, async (t) => {
  if (!hasXelatex) { t.skip('xelatex 不可用'); return; }
  const { baseUrl } = ctx.app;
  const { token } = ctx;
  const included = 'sections/chapter/intro.tex';
  const main = (prefix = '') => [
    '\\documentclass{article}', '\\begin{document}', prefix,
    `\\input{${included}}`, '\\end{document}',
  ].join('\n');
  const id = await createProject(baseUrl, token, 'compile-versioned-sync', main());
  const project = `/api/projects/${id}`;
  const write = async (file, content) => {
    const result = await api(baseUrl, 'POST', `${project}/files`, { token, body: { path: file, content, overwrite: true } });
    assert.equal(result.status, 200);
  };
  const compile = async () => {
    const result = await api(baseUrl, 'POST', `${project}/compile`, { token, body: {} });
    assert.equal(result.status, 200);
    return result.data;
  };
  const pdf = async (url) => {
    const result = await api(baseUrl, 'GET', url, { token, raw: true });
    assert.equal(result.status, 200);
    return Buffer.from(await result.arrayBuffer());
  };
  const sync = async (route, params) => {
    const result = await api(baseUrl, 'GET', `${project}/synctex/${route}?${new URLSearchParams(params)}`, { token });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    return result.data;
  };

  await write(included, 'A nested source paragraph.\\par\n');
  const first = await compile();
  assert.equal(first.status, 'success', JSON.stringify(first.errors));
  assert.equal(first.pdfJobId, first.jobId);
  assert.equal(first.pdfUrl, `${project}/pdf?jobId=${first.jobId}`);
  const firstPdf = await pdf(first.pdfUrl);

  await write('main.tex', main('\\null\\newpage'));
  const second = await compile();
  assert.equal(second.status, 'success', JSON.stringify(second.errors));
  assert.equal(second.pdfJobId, second.jobId);
  assert.notEqual(first.pdfJobId, second.pdfJobId);
  const secondPdf = await pdf(second.pdfUrl);
  assert.notDeepEqual(firstPdf, secondPdf);
  assert.deepEqual(await pdf(first.pdfUrl), firstPdf);

  for (const [build, expectedPage] of [[first, 1], [second, 2]]) {
    const jobId = build.pdfJobId;
    const forward = await sync('code', { file: included, line: 1, jobId });
    assert.equal(forward.page, expectedPage);
    const inverse = await sync('pdf', { page: forward.page, x: forward.x, y: forward.y, jobId });
    assert.equal(inverse.file, included);
    assert.equal(inverse.line, 1);
    const map = await sync('map', { file: included, jobId });
    assert.ok(map.lines.some(anchor => anchor.line === 1 && anchor.page === expectedPage));
    assert.ok(map.lines.every(anchor => anchor.page === expectedPage));
  }

  await write('main.tex', main('\\UndefinedTestCommand'));
  const failed = await compile();
  assert.equal(failed.status, 'failed');
  assert.equal(failed.pdfJobId, null);
  assert.equal((await api(baseUrl, 'GET', `${project}/pdf?jobId=${failed.jobId}`, { token })).status, 404);
  const output = await api(baseUrl, 'GET', `${project}/compile/output`, { token });
  assert.equal(output.status, 200);
  assert.deepEqual(output.data, { pdfUrl: second.pdfUrl, pdfJobId: second.pdfJobId });
  assert.deepEqual(await pdf(`${project}/pdf`), secondPdf);
  assert.deepEqual(await sync('map', { file: included }), await sync('map', { file: included, jobId: second.pdfJobId }));
});

test('编译: 错误文档返回 failed 且 errors 可识别', { timeout: 120000 }, async (t) => {
  if (!hasXelatex) { t.skip('xelatex 不可用'); return; }
  const { baseUrl } = ctx.app; const { token } = ctx;
  const id = await createProject(baseUrl, token, 'compile-bad',
    '\\documentclass{article}\n\\begin{document}\n\\undefinedcommand\n\\end{document}\n');

  const r = await api(baseUrl, 'POST', `/api/projects/${id}/compile`, { token, body: {} });
  assert.equal(r.status, 200);
  assert.equal(r.data.status, 'failed');
  assert.ok(r.data.errors.length > 0);
  const err = r.data.errors.find((e) => /Undefined control sequence/.test(e.message));
  assert.ok(err, JSON.stringify(r.data.errors));
  assert.equal(err.file, 'main.tex');
  assert.equal(err.line, 3);
});

test('stats: 聚合项目全部 .tex 返回 8 项指标', { timeout: 120000 }, async (t) => {
  if (!hasXelatex) { t.skip('xelatex 不可用'); return; }
  const { baseUrl } = ctx.app; const { token } = ctx;
  const id = await createProject(baseUrl, token, 'stats-demo', [
    '\\documentclass{article}',
    '\\begin{document}',
    '\\section{Introduction}',
    '这是正文内容 with English words.',
    '\\begin{figure}\\caption{demo}\\end{figure}',
    'Inline $a+b$ math.',
    '\\end{document}',
  ].join('\n'));
  await api(baseUrl, 'POST', `/api/projects/${id}/mkdir`, { token, body: { path: 'chapters' } });
  const w = await api(baseUrl, 'POST', `/api/projects/${id}/files`, {
    token,
    body: { path: 'chapters/extra.tex', content: '\\section{Second}\\begin{table}x\\end{table}\n' },
  });
  assert.equal(w.status, 200);

  const r = await api(baseUrl, 'GET', `/api/projects/${id}/stats`, { token });
  assert.equal(r.status, 200);
  assert.ok(r.data.headings >= 1, JSON.stringify(r.data));
  assert.ok(r.data.inlineMath >= 1);
  assert.ok(r.data.figuresAndTables >= 1);
  assert.ok(r.data.words > 0);
  for (const k of ['words', 'bodyWords', 'headingWords', 'otherWords', 'headings', 'figuresAndTables', 'inlineMath', 'displayMath']) {
    assert.equal(typeof r.data[k], 'number', k);
  }
});

test('权限: 未登录访问编译接口返回 401', async () => {
  const r = await api(ctx.app.baseUrl, 'POST', '/api/projects/1/compile', { body: {} });
  assert.equal(r.status, 401);
});
