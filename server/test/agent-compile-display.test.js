import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildToolDisplay } from '../src/services/agent/toolDisplay.js';

const compile = { engine: 'xelatex', reused: true, durationMs: 0, originalDurationMs: 2430, totalPages: 10, pages: [4], dpi: 100, previewMode: true, errors: [], warnings: [] };
const fields = display => Object.fromEntries(display.fields.map(field => [field.label, field.value]));

test('reused PDF presentation explicitly distinguishes first compilation duration from the current preview', () => {
  const result = buildToolDisplay('compile_and_preview', {}, { text: '编译成功' }, { meta: { compile } });
  assert.equal(result.summary, '复用本轮同版本编译结果，未重新编译，已读取 1 页图像');
  assert.equal(fields(result)['原编译耗时'], '2430 ms');
  assert.equal(fields(result)['耗时'], undefined);
  assert.equal(fields(result)['页面来源'], '由本轮 PDF 快照重新渲染');
  assert.equal(fields(result)['版本'], '磁盘基线 + 本轮暂存修改（隔离预览）');
  const cachedPages = buildToolDisplay('compile_and_preview', {}, {}, { meta: { compile: { ...compile, renderedFromCache: true } } });
  assert.equal(fields(cachedPages)['页面来源'], '复用本轮页面快照');
});

test('missing original duration is omitted instead of showing the cache sentinel zero as compilation time', () => {
  const result = buildToolDisplay('compile_and_preview', {}, {}, { meta: { compile: { ...compile, originalDurationMs: undefined } } });
  assert.equal(fields(result)['原编译耗时'], undefined); assert.equal(fields(result)['耗时'], undefined);
  const fresh = buildToolDisplay('compile_and_preview', {}, {}, { meta: { compile: { ...compile, reused: false, durationMs: 351 } } });
  assert.equal(fields(fresh)['耗时'], '351 ms');assert.equal(fields(fresh)['原编译耗时'], undefined);assert.match(fresh.summary,/^编译成功/);
});

test('reused failure diagnostics stay failed, rendering errors stay preview failures, and cancellation stays cancelled', () => {
  const errors = [{ file: 'main.tex', line: 3, message: 'Undefined control sequence' }];
  const failed = buildToolDisplay('compile_and_preview', {}, { error: '编译失败' }, { status: 'error', meta: { compile: { ...compile, errors } } });
  assert.match(failed.summary, /^编译失败.*未重新编译/);assert.equal(fields(failed)['原编译耗时'],'2430 ms');assert.equal(failed.items[0].label,errors[0].message);
  const render = buildToolDisplay('compile_and_preview', {}, { error: 'PDF 渲染失败' }, { status: 'error', meta: { compile } });
  assert.match(render.summary, /^预览失败/);assert.doesNotMatch(render.summary,/编译成功/);
  const cancelled = buildToolDisplay('compile_and_preview', {}, { error: '已取消' }, { status: 'cancelled', meta: { compile } });
  assert.equal(cancelled.summary,'操作已停止，结果未确认');
});
