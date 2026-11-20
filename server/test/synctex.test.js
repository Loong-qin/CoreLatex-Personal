import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { codeToPdf, pdfToCode } from '../src/services/synctex.js';

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'corelatex-synctex-'));
  const pdf = path.join(dir, 'main.pdf');
  const count = path.join(dir, 'count');
  const timeline = path.join(dir, 'timeline');
  fs.writeFileSync(pdf, 'pdf');
  fs.writeFileSync(count, '');
  fs.writeFileSync(timeline, '');
  const executable = path.join(dir, 'synctex');
  fs.writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(process.env.SYNC_TEST_COUNT, '1\\n');
fs.appendFileSync(process.env.SYNC_TEST_TIMELINE, 'S ' + Date.now() + '\\n');
const args = process.argv.slice(2);
setTimeout(() => {
  fs.appendFileSync(process.env.SYNC_TEST_TIMELINE, 'E ' + Date.now() + '\\n');
  if (process.env.SYNC_TEST_TOUCH === '1') fs.appendFileSync(args[args.length - 1], 'changed');
  if (process.env.SYNC_TEST_ROOT) {
    if (process.cwd() !== process.env.SYNC_TEST_ROOT) process.exit(1);
    if (args[0] === 'view') {
      if (args[2] !== '7:2:./chapters B/intro.tex') process.exit(2);
      console.log('SyncTeX result begin\\nOutput:document.pdf\\nPage:2\\nx:105.25\\ny:250\\nh:110\\nv:255\\nW:-90\\nH:18\\nSyncTeX result end');
    } else {
      console.log('SyncTeX result begin\\nOutput:document.pdf\\nInput:../other/intro.tex\\nLine:7\\nColumn:2\\nOutput:document.pdf\\nInput:./chapters B/intro.tex\\nLine:9\\nColumn:4\\nSyncTeX result end');
    }
    return;
  }
  if (args[0] === 'view') {
    const line = Number(args[2].split(':')[0]);
    console.log('SyncTeX result begin\\nPage:1\\nx:' + line + '\\ny:' + line * 2 + '\\nSyncTeX result end');
  } else {
    console.log('SyncTeX result begin\\nInput:./main.tex\\nLine:42\\nSyncTeX result end');
  }
}, process.env.SYNC_TEST_CONCURRENCY === '1' ? 200 : 40);
`);
  fs.chmodSync(executable, 0o755);
  const runtime = { binDir: dir, env: { ...process.env, SYNC_TEST_COUNT: count, SYNC_TEST_TIMELINE: timeline, SYNC_TEST_TOUCH: '0', SYNC_TEST_CONCURRENCY: '0' } };
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, pdf, count, timeline, runtime };
}

function executions(count) {
  return fs.readFileSync(count, 'utf8').trim().split('\n').filter(Boolean).length;
}

test('SyncTeX 异步查询合并在途请求并缓存结果', { skip: process.platform === 'win32' }, async (t) => {
  const { pdf, count, runtime } = await fixture(t);
  let ticks = 0;
  const interval = setInterval(() => { ticks++; }, 5);
  t.after(() => clearInterval(interval));
  const [a, b] = await Promise.all([
    codeToPdf(pdf, path.join(path.dirname(pdf), 'main.tex'), 7, 1, runtime),
    codeToPdf(pdf, path.join(path.dirname(pdf), 'main.tex'), 7, 1, runtime),
  ]);
  assert.deepEqual(a, { page: 1, x: 7, y: 14 });
  assert.deepEqual(b, a);
  assert.ok(ticks > 0, '查询期间事件循环应继续运行');
  assert.equal(executions(count), 1);

  assert.deepEqual(await codeToPdf(pdf, path.join(path.dirname(pdf), 'main.tex'), 7, 1, runtime), a);
  assert.equal(executions(count), 1);
  assert.deepEqual(await codeToPdf(pdf, path.join(path.dirname(pdf), 'main.tex'), 8, 1, runtime), { page: 1, x: 8, y: 16 });
  assert.equal(executions(count), 2);
  assert.deepEqual(await pdfToCode(pdf, 1, 100, 120, runtime), { file: path.join(path.dirname(pdf), 'main.tex'), line: 42 });
  assert.equal(executions(count), 3);
});

test('SyncTeX 丢弃查询期间已经变化的 PDF 结果', { skip: process.platform === 'win32' }, async (t) => {
  const { pdf, count, runtime } = await fixture(t);
  runtime.env.SYNC_TEST_TOUCH = '1';
  assert.equal(await codeToPdf(pdf, path.join(path.dirname(pdf), 'main.tex'), 7, 1, runtime), null);
  assert.equal(executions(count), 1);
  runtime.env.SYNC_TEST_TOUCH = '0';
  assert.deepEqual(await codeToPdf(pdf, path.join(path.dirname(pdf), 'main.tex'), 7, 1, runtime), { page: 1, x: 7, y: 14 });
  assert.equal(executions(count), 2);
});

test('SyncTeX publishes accurate boxes and columns and resolves included files against the source root', { skip: process.platform === 'win32' }, async t => {
  const { dir, runtime, count } = await fixture(t);
  const root = fs.realpathSync(dir);
  const published = path.join(root, '.build', 'published', '5');
  const pdf = path.join(published, 'document.pdf');
  const sidecar = path.join(published, 'document.synctex');
  const source = path.join(root, 'chapters B', 'intro.tex');
  fs.mkdirSync(published, { recursive: true });
  fs.writeFileSync(pdf, 'pdf');
  fs.writeFileSync(sidecar, 'Input:1:./chapters A/intro.tex\nInput:2:./chapters B/intro.tex\n');
  runtime.env.SYNC_TEST_ROOT = root;

  const forward = await codeToPdf(pdf, source, 7, 2, runtime, root);
  assert.deepEqual(forward, {
    page: 2, x: 105.25, y: 250,
    rect: { x: 20, y: 237, width: 90, height: 18 },
  });
  assert.equal(await codeToPdf(pdf, path.join(root, 'intro.tex'), 7, 2, runtime, root), null);
  assert.equal(executions(count), 1);
  const reverse = await pdfToCode(pdf, 2, forward.x, forward.y, runtime, root);
  assert.deepEqual(reverse, { file: source, line: 9, column: 4 });

  fs.appendFileSync(sidecar, 'Input:3:./main.tex\n');
  assert.deepEqual(await codeToPdf(pdf, source, 7, 2, runtime, root), forward);
  assert.equal(executions(count), 3);
});

test('SyncTeX 限制并发进程数且不让新请求绕过队列', { skip: process.platform === 'win32' }, async (t) => {
  const { pdf, timeline, runtime } = await fixture(t);
  runtime.env.SYNC_TEST_CONCURRENCY = '1';
  await Promise.all(Array.from({ length: 8 }, (_, i) =>
    codeToPdf(pdf, path.join(path.dirname(pdf), 'main.tex'), i + 1, 1, runtime)));
  const events = fs.readFileSync(timeline, 'utf8').trim().split('\n').filter(Boolean)
    .map(line => { const [kind, at] = line.split(' '); return { kind, at: Number(at) }; })
    .sort((a, b) => a.at - b.at);
  let active = 0, peak = 0;
  for (const event of events) {
    active += event.kind === 'S' ? 1 : -1;
    peak = Math.max(peak, active);
  }
  assert.equal(events.length, 16);
  assert.ok(peak > 1);
  assert.ok(peak <= 4, `实际峰值并发为 ${peak}`);
});
