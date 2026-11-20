import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { parseSynctex, buildLineMap, spToBp, synctexLineMap } from '../src/services/synctexMap.js';

// Coordinates are in scaled points (sp); 4736286.72 sp = 1 inch = 72 bp.
const FIXTURE = [
  'SyncTeX Version:1',
  'Input:1:/proj/main.tex',
  'Input:2:/proj/other.tex',
  'Output:pdf',
  'Magnification:1000',
  'Unit:1',
  'X Offset:0',
  'Y Offset:0',
  'Content:',
  '{1',
  '[1,10:100000,657818:3000000,131072,0',
  '(1,10:100000,657818:3000000,65536,0',
  ')1,10:3100000,657818:3000000,65536,0',
  ']1,10:100000,657818:3000000,131072,0',
  '(1,20:100000,1315636:3000000,65536,0',
  '(2,99:0,500000:100,100,0',
  '}1',
  '{2',
  '(1,30:100000,657818:3000000,65536,0',
  '}2',
  'Postamble:',
  'Count:10',
].join('\n');

test('spToBp converts scaled points to big points', () => {
  assert.ok(Math.abs(spToBp(4736286.72) - 72) < 1e-6);
  assert.ok(Math.abs(spToBp(65781.76) - 1) < 1e-6);
  assert.equal(spToBp(0), 0);
});

test('parseSynctex reads inputs, pages and box records', () => {
  const { inputs, boxes } = parseSynctex(FIXTURE);
  assert.equal(inputs.get(1), '/proj/main.tex');
  assert.equal(inputs.get(2), '/proj/other.tex');
  const line10 = boxes.filter(b => b.line === 10 && b.tag === 1);
  assert.ok(line10.length >= 2);
  assert.ok(line10.every(b => b.page === 1));
  const line30 = boxes.find(b => b.line === 30 && b.tag === 1);
  assert.equal(line30.page, 2);
  const other = boxes.find(b => b.tag === 2);
  assert.equal(other.line, 99);
});

test('buildLineMap returns topmost box per line for the target file only, in bp', () => {
  const lines = buildLineMap(FIXTURE, '/proj/main.tex');
  assert.deepEqual(lines.map(l => l.line), [10, 20, 30]);
  const byLine = Object.fromEntries(lines.map(l => [l.line, l]));
  assert.equal(byLine[10].page, 1);
  assert.equal(byLine[30].page, 2);
  assert.ok(Math.abs(byLine[10].y - 10) < 0.01, `line10 y=${byLine[10].y}`);
  assert.ok(Math.abs(byLine[20].y - 20) < 0.01, `line20 y=${byLine[20].y}`);
  assert.ok(!lines.some(l => l.line === 99), 'other-file line must be excluded');
});

test('buildLineMap keeps the earliest page then topmost y for a line', () => {
  const fixture = [
    'Input:1:/proj/main.tex', 'Content:',
    '{1', '(1,5:0,1315636:100,100,0', '}1',
    '{2', '(1,5:0,657818:100,100,0', '}2',
  ].join('\n');
  const lines = buildLineMap(fixture, '/proj/main.tex');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].page, 1);
  assert.ok(Math.abs(lines[0].y - 20) < 0.01);
});

test('buildLineMap returns empty for an unknown file', () => {
  assert.deepEqual(buildLineMap(FIXTURE, '/proj/missing.tex'), []);
});

test('line map applies SyncTeX coordinate transforms and prefers text to a vertical container', () => {
  const root = path.resolve('source');
  const file = path.join(root, 'chapters', 'intro.tex');
  const fixture = [
    'Input:1:./chapters/intro.tex', 'Unit:2', 'Magnification:1250', 'Y Offset:65782',
    'Content:', '{1',
    '[1,12:100,10:500000,131072,0',
    'x1,12,5:500,263127',
    'x1,13:600,=',
    '}1', 'Postamble:', 'Count:3',
  ].join('\n');
  const baseline = buildLineMap(fixture, file, root);
  assert.deepEqual(baseline.map(row => row.line), [12, 13]);
  assert.ok(baseline.every(row => Math.abs(row.y - 12) < 0.001));

  const xdv = fixture + '\nPost scriptum:\nMagnification:2\nX Offset:0bp\nY Offset:0.5in';
  const updated = buildLineMap(xdv, file, root);
  assert.ok(updated.every(row => Math.abs(row.y - 56) < 0.001));
});

test('published gzip maps resolve duplicate source basenames by project-relative path and refresh on sidecar changes', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'corelatex-synctex-map-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const published = path.join(root, '.build', 'published', '23');
  const pdf = path.join(published, 'document.pdf');
  const sidecar = path.join(published, 'document.synctex.gz');
  const first = path.join(root, '章节 A', 'intro.tex');
  const second = path.join(root, '章节 B', 'intro.tex');
  const content = [
    'SyncTeX Version:1', 'Input:1:./章节 A/intro.tex', 'Unit:1',
    'Content:', '{1', 'x1,11:0,657818', '}1', 'Input:2:章节 B/intro.tex',
    '{2', 'x2,29:0,1315636', '}2', 'Postamble:', 'Count:2',
  ].join('\n');
  await fs.mkdir(published, { recursive: true });
  await fs.writeFile(pdf, 'pdf');
  assert.deepEqual(await synctexLineMap(pdf, first, root), { lines: [] });
  await fs.writeFile(sidecar, gzipSync(content));
  const [a, b] = await Promise.all([synctexLineMap(pdf, first, root), synctexLineMap(pdf, second, root)]);
  assert.deepEqual(a.lines.map(({ line, page }) => [line, page]), [[11, 1]]);
  assert.deepEqual(b.lines.map(({ line, page }) => [line, page]), [[29, 2]]);
  assert.deepEqual(await synctexLineMap(pdf, path.join(root, 'intro.tex'), root), { lines: [] });
  await fs.writeFile(sidecar, gzipSync(content.replace('x1,11:0,657818', 'x1,111:0,657818')));
  const refreshed = await synctexLineMap(pdf, first, root);
  assert.equal(refreshed.lines[0].line, 111);
});
