import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'corelatex-compile-inputs-test-'));
process.env.CORELATEX_DATA_DIR = path.join(temp, 'data');
const { captureCompilationInputs, verifyCompilationInputs, compilationInputBoundary } = await import('../src/services/compileInputs.js');
let serial = 0;
function write(filename, bytes = 'content') { fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, bytes); return filename; }
function fixture() {
  const root = path.join(temp, 'project-' + ++serial), build = path.join(root, '.build');
  fs.mkdirSync(build, { recursive: true });
  const main = write(path.join(root, 'main.tex'), '\\documentclass{article}\n% _workspace/ and /usr/share are comments\n\\begin{document}Hello\\end{document}');
  return { root, build, main, recorder: path.join(build, 'main.fls') };
}
function recorder(f, inputs, outputs = []) {
  write(f.recorder, ['PWD ' + f.root, ...inputs.map(file => 'INPUT ' + file), ...outputs.map(file => 'OUTPUT ' + file)].join('\n') + '\n');
}
const capture = (f, more = {}) => captureCompilationInputs({ recorderPath: f.recorder, compileRoot: f.root, engine: 'pdflatex', ...more });
after(() => { assert.ok(temp.startsWith(path.join(os.tmpdir(), 'corelatex-compile-inputs-test-'))); fs.rmSync(temp, { recursive: true, force: true }); });

test('actual project, workspace and external inputs remain current after read-only/generated-output changes', async () => {
  const f = fixture();
  const font = write(path.join(f.root, '_workspace', 'fonts', 'font.otf'), 'font');
  const external = write(path.join(temp, 'external-' + serial, 'style.sty'), '\\relax');
  const aux = write(path.join(f.build, 'main.aux'), 'generated');
  recorder(f, ['main.tex', '_workspace/fonts/font.otf', external, aux], [aux, '.build/main.pdf']);
  const manifest = await capture(f);
  assert.equal(manifest.complete, true, manifest.reason);
  assert.deepEqual(manifest.inputs.map(input => input.scope).sort(), ['external', 'project', 'workspace']);
  assert.equal(await verifyCompilationInputs(manifest), 'current');
  fs.readFileSync(f.main); write(aux, 'new generated aux'); write(path.join(f.build, 'read-log.txt'), 'notes');
  assert.equal(await verifyCompilationInputs(manifest), 'current');
  write(font, 'other font');
  assert.equal(await verifyCompilationInputs(manifest), 'changed');
});

test('external byte changes invalidate even when size and mtime are restored', async () => {
  const f = fixture(), external = write(path.join(temp, 'external-' + serial, 'input.tex'), 'before');
  recorder(f, [f.main, external]);
  const manifest = await capture(f), stat = fs.statSync(external);
  assert.equal(manifest.complete, true, manifest.reason);
  write(external, 'after!'); fs.utimesSync(external, stat.atime, stat.mtime);
  assert.equal(await verifyCompilationInputs(manifest), 'changed');
});

test('preview records map workspace and unstaged inputs back while staged bytes are delegated to the draft snapshot', async () => {
  const original = fixture(), shadow = { root: path.join(original.root, '.preview') };
  shadow.build = path.join(shadow.root, '.build'); shadow.recorder = path.join(shadow.build, 'main.fls');
  write(path.join(original.root, '_workspace', 'font.otf'), 'project font');
  write(path.join(shadow.root, 'main.tex'), 'compiled staged text');
  write(path.join(shadow.root, '_workspace', 'font.otf'), 'project font');
  recorder(shadow, ['main.tex', '_workspace/font.otf']);
  const manifest = await capture(shadow, { sourceRoot: original.root, stagedPaths: ['main.tex'] });
  assert.equal(manifest.complete, true, manifest.reason);
  const main = manifest.inputs.find(input => input.relativePath === 'main.tex');
  assert.equal(main.path, original.main); assert.equal(main.delegated, true);
  assert.equal(await verifyCompilationInputs(manifest), 'current');
  fs.rmSync(shadow.root, { recursive: true, force: true });
  assert.equal(await verifyCompilationInputs(manifest), 'current', 'proof must outlive cleanup of the preview tree');
  write(path.join(original.root, '_workspace', 'font.otf'), 'replaced font');
  assert.equal(await verifyCompilationInputs(manifest), 'changed');
});

test('a changed logical symlink target cannot inherit proof from the old canonical dependency', async () => {
  const f = fixture(), a = write(path.join(temp, 'external-' + serial, 'a.tex'), 'same bytes');
  const b = write(path.join(temp, 'external-' + serial, 'b.tex'), 'same bytes'), link = path.join(temp, 'external-' + serial, 'linked.tex');
  fs.symlinkSync(a, link); recorder(f, [f.main, link]);
  const manifest = await capture(f); assert.equal(manifest.complete, true, manifest.reason);
  fs.unlinkSync(link); fs.symlinkSync(b, link);
  assert.equal(await verifyCompilationInputs(manifest), 'changed');
});

test('a symlink retargeted before the first capture cannot bind a stale compilation', async () => {
  const f = fixture(), a = write(path.join(temp, 'alias-' + serial, 'a.tex'), 'before');
  const b = write(path.join(temp, 'alias-' + serial, 'b.tex'), 'different older file');
  const link = path.join(f.root, '_workspace', 'linked.tex');
  fs.mkdirSync(path.dirname(link)); fs.symlinkSync(a, link);
  const startedAt = await compilationInputBoundary(f.build);
  assert.ok(startedAt > 0);
  fs.unlinkSync(link); fs.symlinkSync(b, link);
  recorder(f, [f.main, link]);
  assert.equal((await capture(f, { startedAt })).reason, 'unstable');
});

test('missing recorder, excessive inputs and unsupported Lua IO never claim complete verification', async () => {
  const f = fixture();
  assert.deepEqual((await capture(f)).recorded, false);
  const huge = write(path.join(f.root, 'huge.bin')); fs.truncateSync(huge, 129 * 1024 * 1024);
  recorder(f, [f.main, huge]);
  assert.equal((await capture(f)).reason, 'limit');
  recorder(f, [f.main]);
  assert.equal((await capture(f, { engine: 'lualatex' })).complete, false);
  write(f.main, '\\directlua{io.open("external") }');
  assert.equal((await capture(f, { engine: undefined })).reason, 'unrecorded-io');
  assert.equal(await verifyCompilationInputs({ version: 1, complete: false }), 'unverifiable');
});

test('recorder cannot reuse a different working directory or an old run', async () => {
  const f = fixture(); recorder(f, [f.main]);
  const startedAt = Date.now() + 1000;
  assert.equal((await capture(f, { startedAt })).reason, 'recorder-stale');
  write(f.recorder, 'PWD ' + temp + '\nINPUT ' + f.main + '\n');
  assert.equal((await capture(f)).reason, 'recorder-context-mismatch');
});

test('external dependencies modified during compilation are unstable rather than presumed current', async () => {
  const f = fixture(), external = write(path.join(temp, 'external-' + serial, 'input.tex'), 'written during compile');
  recorder(f, [f.main, external]);
  const result = await capture(f, { startedAt: Date.now() - 1000 });
  assert.equal(result.complete, false); assert.equal(result.reason, 'unstable');
});

test('workspace inputs modified after TeX read them cannot become a new successful baseline', async () => {
  const f = fixture(), input = write(path.join(f.root, '_workspace', 'data.tex'), 'A that TeX read');
  const startedAt = await compilationInputBoundary(f.build);
  assert.ok(startedAt > 0);
  await new Promise(resolve => setTimeout(resolve, 5));
  write(input, 'B after engine read A');
  recorder(f, [f.main, input]);
  const captured = await capture(f, { startedAt });
  assert.equal(captured.complete, false); assert.equal(captured.reason, 'unstable');
  const stableStart = await compilationInputBoundary(f.build);
  await new Promise(resolve => setTimeout(resolve, 5));
  recorder(f, [f.main, input]);
  const stable = await capture(f, { startedAt: stableStart });
  assert.equal(stable.complete, true, stable.reason);
  assert.equal(await verifyCompilationInputs(stable), 'current');
});

test('input mutation during hashing is detected, including unchanged metadata on an earlier read', async () => {
  const f = fixture(), large = write(path.join(f.root, 'large.bin'), Buffer.alloc(4 * 1024 * 1024, 1));
  recorder(f, [f.main, large]);
  const original = fs.createReadStream;
  fs.createReadStream = (...args) => {
    const stream = original(...args);
    if (fs.fstatSync(args[1].fd).size > 1024 * 1024) stream.once('data', () => write(f.main, 'changed while another input was read'));
    return stream;
  };
  try { const result = await capture(f); assert.equal(result.reason, 'unstable'); }
  finally { fs.createReadStream = original; }
});

test('bibliography and style dependencies use actual Bibtex cwd/search roots, including external files', async () => {
  const f = fixture(), bib = write(path.join(temp, 'external-' + serial, 'refs.bib'), '@article{key,title={Actual source}}');
  const bst = write(path.join(temp, 'external-' + serial, 'plain.bst'), 'bibliography style');
  const bin = path.join(temp, 'bin-' + serial); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'kpsewhich'), '#!/usr/bin/env node\nconsole.log(' + JSON.stringify({ 'refs.bib': bib, 'plain.bst': bst }) + '[process.argv.at(-1)] || "");\n', { mode: 0o755 });
  const blg = write(path.join(f.build, 'main.blg'), 'The style file: plain.bst\nDatabase file #1: refs.bib\n');
  const bbl = write(path.join(f.build, 'main.bbl'), 'generated bibliography');
  recorder(f, [f.main, bbl]);
  const manifest = await capture(f, { bibtexRan: true, bibliographyLogPath: blg, runtime: { binDir: bin, env: process.env } });
  assert.equal(manifest.complete, true, manifest.reason);
  assert.ok(manifest.inputs.some(input => input.path === bib)); assert.ok(manifest.inputs.some(input => input.path === bst));
  assert.ok(!manifest.inputs.some(input => input.path === bbl), 'Bibtex-owned bbl is generated, its actual sources are tracked');
  assert.equal(await verifyCompilationInputs(manifest), 'current');
  write(bib, '@article{key,title={Updated source}}');
  assert.equal(await verifyCompilationInputs(manifest), 'changed');
  const missing = await capture(f, { bibtexRan: true, bibliographyLogPath: path.join(f.build, 'missing.blg'), runtime: { binDir: bin, env: process.env } });
  assert.equal(missing.complete, false);
});

test('cancellation is propagated rather than converted into successful or unknown evidence', async () => {
  const f = fixture(); recorder(f, [f.main]);
  const controller = new AbortController(); controller.abort(new Error('stop dependency capture'));
  await assert.rejects(capture(f, { signal: controller.signal }), /stop dependency capture/);
  await assert.rejects(verifyCompilationInputs({ version: 1, complete: true, recorded: true, inputs: [{ path: f.main, sha256: '0'.repeat(64) }] },
    { signal: controller.signal }), /stop dependency capture/);
});

test('negative external and workspace conditional lookups invalidate when a formerly missing file is created', async () => {
  for (const destination of ['../late-' + serial + '.tex', '_workspace/late.tex', '../no-extension-' + serial]) {
    const f = fixture();
    write(f.main, '\\documentclass{article}\n\\InputIf% comment joins the control sequence\nFileExists{' + destination + '}{}{}');
    recorder(f, [f.main]);
    const manifest = await capture(f); assert.equal(manifest.complete, true, manifest.reason);
    const target = path.resolve(f.root, destination + (path.extname(destination) ? '' : '.tex'));
    assert.ok(manifest.inputs.some(input => input.path === target && input.missing === true));
    assert.equal(await verifyCompilationInputs(manifest), 'current');
    write(target, '\\relax');
    assert.equal(await verifyCompilationInputs(manifest), 'changed');
  }
});

test('positive conditional files are hashed while unresolvable project lookups remain unverifiable', async () => {
  const f = fixture(), existing = write(path.join(f.root, '_workspace', 'conditional.tex'), '\\relax');
  write(f.main, '\\IfFileExists{_workspace/conditional.tex}{}{}'); recorder(f, [f.main]);
  const manifest = await capture(f); assert.equal(manifest.complete, true, manifest.reason);
  assert.ok(manifest.inputs.some(input => input.path === existing && input.sha256));
  write(existing, '\\changed'); assert.equal(await verifyCompilationInputs(manifest), 'changed');
  write(f.main, '\\IfFileExists{../\\computedName}{}{}');
  assert.equal((await capture(f)).reason, 'conditional-lookup-unrecorded');
  write(f.main, '\\IfFontExistsTF{Unknown family}{}{}');
  assert.equal((await capture(f)).reason, 'font-lookup-unrecorded');
});

test('a preview with parent-relative inputs never verifies a different path as the future formal document', async () => {
  const original = fixture(), shadow = { root: path.join(original.root, '.preview') };
  shadow.build = path.join(shadow.root, '.build'); shadow.recorder = path.join(shadow.build, 'main.fls');
  const source = write(path.join(shadow.root, 'main.tex'), '\\input{../outside.tex}');
  const input = write(path.join(original.root, 'outside.tex'), 'actual preview target');
  recorder(shadow, [source, input]);
  const result = await capture(shadow, { sourceRoot: original.root, stagedPaths: ['main.tex'] });
  assert.equal(result.complete, false); assert.equal(result.reason, 'preview-relative-external');
  write(source, '% ../outside.tex only occurs in a comment\n\\relax');
  recorder(shadow, [source]);
  assert.equal((await capture(shadow, { sourceRoot: original.root, stagedPaths: ['main.tex'] })).complete, true);
});

test('literal fontspec files absent from XeTeX recorder are explicit dependencies and font-byte edits invalidate', async () => {
  const f = fixture(), font = write(path.join(f.root, '_workspace', 'fonts', 'proof-font.ttf'), 'actual font bytes');
  write(f.main, '\\usepackage{fontspec}\n\\setmainfont[Path={_workspace/fonts/},Ligatures=TeX]{proof-font.ttf}');
  recorder(f, [f.main]); // Real XeTeX can omit the font from its FLS.
  const manifest = await capture(f, { engine: 'xelatex' });
  assert.equal(manifest.complete, true, manifest.reason);
  assert.ok(manifest.inputs.some(input => input.path === font && input.scope === 'workspace' && input.sha256));
  assert.equal(await verifyCompilationInputs(manifest), 'current');
  fs.appendFileSync(font, 'modified');
  assert.equal(await verifyCompilationInputs(manifest), 'changed');
});

test('preview literal font dependencies map to original workspace while the staged source remains delegated', async () => {
  const original = fixture(), shadow = { root: path.join(original.root, '.preview') };
  shadow.build = path.join(shadow.root, '.build'); shadow.recorder = path.join(shadow.build, 'main.fls');
  const source = '\\setmainfont{proof.otf}[Path=_workspace/fonts/]';
  write(path.join(shadow.root, 'main.tex'), source);
  const font = write(path.join(original.root, '_workspace', 'fonts', 'proof.otf'), 'font file');
  write(path.join(shadow.root, '_workspace', 'fonts', 'proof.otf'), 'font file');
  recorder(shadow, ['main.tex']);
  const manifest = await capture(shadow, { sourceRoot: original.root, stagedPaths: ['main.tex'], engine: 'xelatex' });
  assert.equal(manifest.complete, true, manifest.reason);
  assert.ok(manifest.inputs.some(input => input.path === font && !input.delegated));
  assert.equal(await verifyCompilationInputs(manifest), 'current');
  write(font, 'another font');
  assert.equal(await verifyCompilationInputs(manifest), 'changed');
});

test('a missing explicit font path remains a negative dependency rather than an untracked lookup', async () => {
  const f = fixture(), font = path.join(f.root, '_workspace', 'fonts', 'optional.ttf');
  write(f.main, '\\iffalse\\setmonofont[Path=_workspace/fonts/]{optional.ttf}\\fi');
  recorder(f, [f.main]);
  const manifest = await capture(f, { engine: 'xelatex' });
  assert.equal(manifest.complete, true, manifest.reason);
  assert.ok(manifest.inputs.some(input => input.path === font && input.missing));
  write(font, 'now available');
  assert.equal(await verifyCompilationInputs(manifest), 'changed');
});

test('unresolved font families, TEXMF filename search, CJK/custom families and complex style selectors never claim complete input coverage', async () => {
  for (const source of [
    '\\setmainfont{Latin Modern Roman}',
    '\\setmainfont{texgyretermes-regular.otf}',
    '\\setCJKmainfont{Noto Serif CJK SC}',
    '\\newfontfamily\\headingfont[Path=_workspace/fonts/]{proof.otf}',
    '\\setmainfont[Path=_workspace/fonts/,BoldFont=other.ttf]{proof.ttf}',
    '\\setmainfont[Path=_workspace/fonts/,Extension=.otf]{proof}',
    '\\setmainfont[Path=\\computedDirectory]{proof.ttf}',
  ]) {
    const f = fixture(); write(f.main, source); recorder(f, [f.main]);
    const result = await capture(f, { engine: 'xelatex' });
    assert.equal(result.complete, false, source); assert.equal(result.reason, 'unrecorded-font', source);
  }
});

test('custom external classes cannot hide unresolved conditional lookups or font families', async () => {
  const f = fixture(), external = write(path.join(temp, 'class-' + serial, 'journal.cls'), '\\setmainfont{Latin Modern Roman}');
  recorder(f, [f.main, external]);
  assert.equal((await capture(f, { engine: 'xelatex' })).reason, 'unrecorded-font');
  write(external, '\\IfFileExists{\\calculatedPath}{}{}');
  assert.equal((await capture(f, { engine: 'xelatex' })).reason, 'conditional-lookup-unrecorded');
});

test('standalone comments about catcodes in an included class leave recorder proof available', async () => {
  const f = fixture();
  write(f.main, '\\documentclass{journal}');
  for (const [index, newline] of ['\n', '\r\n', '\r'].entries()) {
    const optional = `_workspace/optional${index}.tex`;
    const cls = write(path.join(f.root, 'journal.cls'), [
      '\\LoadClass{article}',
      '% Older versions used \\catcode`\\&=12 here.',
      '  % The class no longer uses \\scantokens either.',
      `\\IfFileExists{${optional}}{}{}`,
    ].join(newline));
    recorder(f, [f.main, cls]);
    const manifest = await capture(f);
    assert.equal(manifest.complete, true, manifest.reason);
    assert.equal(await verifyCompilationInputs(manifest), 'current');
    write(path.join(f.root, optional), '\\relax');
    assert.equal(await verifyCompilationInputs(manifest), 'changed');
    write(cls, '% Comment' + newline + '\\openin0=unrecorded.tex');
    assert.equal((await capture(f)).reason, 'conditional-lookup-unrecorded');
  }
});

test('executable tokenization changes still prevent complete recorder proof', async () => {
  const f = fixture();
  recorder(f, [f.main]);
  for (const code of ['\\catcode`\\&=12', '\\% \\catcode`\\&=12', '\\verb|%| \\catcode`\\&=12', '\\scantokens{\\relax}']) {
    write(f.main, '% Older syntax: \\catcode`\\&=12\n' + code);
    assert.equal((await capture(f)).reason, 'conditional-lookup-unrecorded', code);
  }
});

test('a primitive probe for a missing input cannot produce complete recorder evidence', async () => {
  const f = fixture();
  write(f.main, String.raw`\openin0=_workspace/optional.tex \ifeof0 Missing\else Present\fi\closein0`);
  recorder(f, [f.main]); // A missing file never appears as a successful read.
  const result = await capture(f);
  assert.equal(result.complete, false);
  assert.equal(result.reason, 'conditional-lookup-unrecorded');
});
