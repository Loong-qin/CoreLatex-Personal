import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';

let tempRoot, binDir, db, resetDb, compileProject, previewCompileProject, findBuild, executeTool;
let serial = 0;
const savedEnv = {
  PATH: process.env.PATH,
  CORELATEX_DATA_DIR: process.env.CORELATEX_DATA_DIR,
  CORELATEX_FAKE_MARKERS: process.env.CORELATEX_FAKE_MARKERS,
};

function fakeBinary(name, body) {
  fs.writeFileSync(path.join(binDir, name), '#!/usr/bin/env node\n' + body, { mode: 0o755 });
}

before(async () => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'corelatex-compile-safety-'));
  binDir = path.join(tempRoot, 'bin');
  fs.mkdirSync(binDir);
  process.env.CORELATEX_DATA_DIR = path.join(tempRoot, 'data');
  process.env.PATH = [binDir, path.dirname(process.execPath), savedEnv.PATH].filter(Boolean).join(path.delimiter);
  const database = await import('../src/db.js');
  db = database.getDb();
  resetDb = database.resetDb;
  ({ compileProject, previewCompileProject } = await import('../src/services/compile.js'));
  ({ findBuild } = await import('../src/services/buildArtifacts.js'));
  ({ executeTool } = await import('../src/services/agent/tools.js'));

  fakeBinary('pdflatex', String.raw`
const fs = require('node:fs');
const path = require('node:path');
const main = process.argv.at(-1);
const base = path.basename(main).replace(/\.tex$/i, '');
const mode = fs.readFileSync('.fake-engine-mode', 'utf8').trim();
const out = process.argv.find(arg => arg.startsWith('-output-directory=')).slice('-output-directory='.length);
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, base + '.pdf'), '%PDF-1.4 fake\n' + fs.readFileSync(main, 'utf8'));
let log = 'Output written on ' + base + '.pdf';
if (mode === 'preview-write') {
  fs.writeFileSync('assets/resource.txt', 'modified by preview engine');
}
if (mode === 'bibliography' && !fs.existsSync(path.join(out, base + '.bbl'))) {
  log = "LaTeX Warning: Citation 'reference' undefined on input line 1.";
}
fs.writeFileSync(path.join(out, base + '.log'), log);
if (mode === 'hold') {
  fs.writeFileSync('engine-started', '');
  const deadline = Date.now() + 5000;
  const timer = setInterval(() => {
    if (fs.existsSync('release-engine')) { clearInterval(timer); process.exit(0); }
    if (Date.now() > deadline) { clearInterval(timer); process.exit(10); }
  }, 5);
} else process.exit(mode === 'nonzero' ? 7 : 0);
`);
  fakeBinary('bibtex', String.raw`
const fs = require('node:fs');
const path = require('node:path');
const markers = process.env.CORELATEX_FAKE_MARKERS;
fs.writeFileSync(path.join(markers, 'bibtex-running'), '');
setTimeout(() => {
  fs.writeFileSync(process.argv[2] + '.bbl', 'fake bibliography');
  fs.writeFileSync(path.join(markers, 'bibtex-done'), '');
}, 250);
`);
  fakeBinary('pdfinfo', String.raw`
const fs = require('node:fs');
const path = require('node:path');
const markers = process.env.CORELATEX_FAKE_MARKERS;
const pdf = process.argv[2];
fs.writeFileSync(path.join(markers, 'pdfinfo-pdf-path'), pdf);
fs.writeFileSync(path.join(markers, 'pdfinfo-running'), '');
const setting = (name, fallback) => {
  const file = path.join(markers, name);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : fallback;
};
setTimeout(() => {
  fs.readFileSync(pdf);
  fs.writeFileSync(path.join(markers, 'pdfinfo-done'), '');
  console.log('Pages: ' + setting('pdfinfo-pages', '1'));
}, Number(setting('pdfinfo-delay', '250')));
`);
  fakeBinary('pdftoppm', String.raw`
const fs = require('node:fs');
const path = require('node:path');
const markers = process.env.CORELATEX_FAKE_MARKERS;
const pdf = process.argv.at(-2);
fs.writeFileSync(path.join(markers, 'pdftoppm-pdf-path'), pdf);
fs.writeFileSync(path.join(markers, 'pdftoppm-running'), '');
const finish = () => {
  if (fs.existsSync(path.join(markers, 'render-error'))) {
    fs.writeFileSync(path.join(markers, 'pdftoppm-done'), '');
    process.exit(9);
  }
  // Read only when rendering finishes, after the test has recompiled the project.
  const contents = fs.readFileSync(pdf);
  fs.writeFileSync(process.argv.at(-1) + '-1.jpg', contents);
  fs.writeFileSync(path.join(markers, 'pdftoppm-done'), '');
};
if (fs.existsSync(path.join(markers, 'hold-render'))) {
  const deadline = Date.now() + 5000;
  const timer = setInterval(() => {
    if (fs.existsSync(path.join(markers, 'release-render'))) {
      clearInterval(timer);
      finish();
    } else if (Date.now() > deadline) {
      clearInterval(timer);
      process.exit(10);
    }
  }, 5);
} else {
  const setting = path.join(markers, 'pdftoppm-delay');
  setTimeout(finish, fs.existsSync(setting) ? Number(fs.readFileSync(setting, 'utf8')) : 250);
}
`);
});

after(() => {
  resetDb?.();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
});

function fixture(mode = 'success', quota = -1, existingUser = null) {
  const name = 'compileuser' + (++serial);
  const uid = existingUser?.id ?? db.prepare("INSERT INTO users (username, password_hash, role, compile_seconds_quota) VALUES (?, 'unused', 'user', ?)")
    .run(name, quota).lastInsertRowid;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
  const publicId = randomBytes(9).toString('base64url');
  const pid = db.prepare("INSERT INTO projects (name, owner_id, public_id, compile_engine) VALUES ('safe', ?, ?, 'pdflatex')")
    .run(uid, publicId).lastInsertRowid;
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(pid);
  const projectDir = path.join(process.env.CORELATEX_DATA_DIR, 'projects', String(pid));
  fs.mkdirSync(path.join(projectDir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'main.tex'), 'original main');
  fs.writeFileSync(path.join(projectDir, 'assets', 'resource.txt'), 'original resource');
  fs.writeFileSync(path.join(projectDir, '.fake-engine-mode'), mode);
  const markers = path.join(tempRoot, 'markers-' + serial);
  fs.mkdirSync(markers);
  process.env.CORELATEX_FAKE_MARKERS = markers;
  return { project, user, projectDir, markers };
}

async function observeResponsiveChildren(names, markers, operation) {
  const observed = new Set();
  const timer = setInterval(() => {
    for (const name of names) {
      if (fs.existsSync(path.join(markers, name + '-running')) &&
          !fs.existsSync(path.join(markers, name + '-done'))) observed.add(name);
    }
  }, 5);
  try {
    const result = await operation();
    for (const name of names) {
      assert.equal(observed.has(name), true, 'event loop must run while ' + name + ' is unfinished');
      assert.equal(fs.existsSync(path.join(markers, name + '-done')), true);
    }
    return result;
  } finally {
    clearInterval(timer);
  }
}

test('exhausted preview quota rejects before creating a shadow copy or invoking an engine', async () => {
  const f = fixture('preview-write', 0);
  await assert.rejects(
    previewCompileProject({ ...f, staged: [{ path: 'main.tex', after: 'staged' }] }),
    (error) => error.status === 403
  );
  assert.equal(fs.existsSync(path.join(f.projectDir, '.preview')), false);
  assert.equal(fs.existsSync(path.join(f.projectDir, '.build')), false);
  assert.equal(fs.readFileSync(path.join(f.projectDir, 'main.tex'), 'utf8'), 'original main');
});

test('preview resources have separate inodes and engine writes cannot mutate formal files', async () => {
  const f = fixture('preview-write');
  const result = await previewCompileProject({ ...f, staged: [{ path: 'main.tex', after: 'staged main' }] });
  assert.equal(result.ok, true);
  const original = path.join(f.projectDir, 'assets', 'resource.txt');
  const copied = path.join(f.projectDir, '.preview', 'assets', 'resource.txt');
  const originalStat = fs.statSync(original);
  const copiedStat = fs.statSync(copied);
  assert.notDeepEqual([copiedStat.dev, copiedStat.ino], [originalStat.dev, originalStat.ino]);
  assert.equal(fs.readFileSync(original, 'utf8'), 'original resource');
  assert.equal(fs.readFileSync(copied, 'utf8'), 'modified by preview engine');
  assert.equal(fs.readFileSync(path.join(f.projectDir, 'main.tex'), 'utf8'), 'original main');
  assert.equal(fs.readFileSync(path.join(f.projectDir, '.preview', 'main.tex'), 'utf8'), 'staged main');
  assert.equal(fs.existsSync(path.join(f.projectDir, '.build')), false);
});

test('a nonzero engine exit fails formal and preview compiles even if a PDF was generated', async () => {
  const f = fixture('nonzero');
  const formal = await compileProject(f);
  assert.equal(fs.existsSync(path.join(f.projectDir, '.build', 'work', 'main.pdf')), true);
  assert.equal(formal.status, 'failed');
  assert.throws(() => findBuild(f.project, String(formal.jobId)), { status: 404 });
  assert.ok(formal.errors.length > 0);
  assert.equal(db.prepare('SELECT status FROM compile_jobs WHERE id = ?').get(formal.jobId).status, 'failed');
  const preview = await previewCompileProject({ ...f, staged: [{ path: 'main.tex', after: 'staged' }] });
  assert.equal(fs.existsSync(preview.pdfPath), true);
  assert.equal(preview.ok, false);
  assert.ok(preview.errors.length > 0);
});

test('bibliography processing leaves the event loop responsive until its subprocess finishes', async () => {
  const f = fixture('bibliography');
  fs.writeFileSync(path.join(f.projectDir, 'references.bib'), '@article{reference, title={Fake}}');
  const result = await observeResponsiveChildren(['bibtex'], f.markers, () => compileProject(f));
  assert.equal(result.status, 'success');
  assert.equal(fs.existsSync(path.join(f.projectDir, '.build', 'work', 'main.bbl')), true);
});

test('PDF inspection and rendering leave the event loop responsive and return preview images', async () => {
  const f = fixture();
  const result = await observeResponsiveChildren(['pdfinfo', 'pdftoppm'], f.markers,
    () => executeTool('compile_and_preview', { pages: '1' }, { ...f, changesetBuffer: [] }));
  assert.equal(result.error, undefined);
  assert.equal(result.images.length, 1);
  assert.equal(result.images[0].mediaType, 'image/jpeg');
  assert.ok(result.images[0].imageBase64.length > 0);
});

async function waitForMarker(marker, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (!fs.existsSync(marker)) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for ' + marker);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function assertSnapshotRemoved(f, marker = 'pdfinfo-pdf-path') {
  const pdf = fs.readFileSync(path.join(f.markers, marker), 'utf8');
  const snapshotDir = path.dirname(pdf);
  assert.equal(path.dirname(snapshotDir), os.tmpdir());
  assert.ok(path.basename(snapshotDir).startsWith('corelatex-pdf-preview-'));
  assert.equal(fs.existsSync(snapshotDir), false, 'the owned PDF snapshot must be cleaned up');
}

function fastPdfTools(f, pages = 1) {
  fs.writeFileSync(path.join(f.markers, 'pdfinfo-delay'), '0');
  fs.writeFileSync(path.join(f.markers, 'pdftoppm-delay'), '0');
  fs.writeFileSync(path.join(f.markers, 'pdfinfo-pages'), String(pages));
}

test('formal and staged rendering keep the original PDF while the same project is recompiled', async () => {
  for (const staged of [false, true]) {
    const f = fixture();
    fastPdfTools(f);
    fs.writeFileSync(path.join(f.markers, 'hold-render'), '');
    const firstMain = staged ? 'first staged main' : 'original main';
    const pending = executeTool('compile_and_preview', { pages: '1' }, {
      ...f,
      changesetBuffer: staged ? [{ path: 'main.tex', before: 'original main', after: firstMain }] : [],
    });
    try {
      await waitForMarker(path.join(f.markers, 'pdftoppm-running'));
      const snapshotPdf = fs.readFileSync(path.join(f.markers, 'pdftoppm-pdf-path'), 'utf8');
      assert.ok(fs.existsSync(snapshotPdf));
      assert.equal(fs.readFileSync(snapshotPdf, 'utf8'), '%PDF-1.4 fake\n' + firstMain);
      let second;
      if (staged) {
        second = await previewCompileProject({
          ...f, staged: [{ path: 'main.tex', after: 'second staged main' }],
        });
        assert.equal(second.ok, true);
        assert.equal(fs.readFileSync(second.pdfPath, 'utf8'), '%PDF-1.4 fake\nsecond staged main');
      } else {
        fs.writeFileSync(path.join(f.projectDir, 'main.tex'), 'second formal main');
        second = await compileProject(f);
        assert.equal(second.status, 'success');
        assert.equal(fs.readFileSync(findBuild(f.project, String(second.jobId)).pdf, 'utf8'),
          '%PDF-1.4 fake\nsecond formal main');
      }
      fs.writeFileSync(path.join(f.markers, 'release-render'), '');
      const result = await pending;
      assert.equal(result.error, undefined);
      assert.equal(result.images.length, 1);
      assert.equal(Buffer.from(result.images[0].imageBase64, 'base64').toString(), '%PDF-1.4 fake\n' + firstMain);
      assertSnapshotRemoved(f, 'pdftoppm-pdf-path');
    } finally {
      fs.writeFileSync(path.join(f.markers, 'release-render'), '');
      await pending;
    }
  }
});

test('render failures clean up their PDF snapshot for both formal and staged previews', async () => {
  for (const staged of [false, true]) {
    const f = fixture();
    fastPdfTools(f);
    fs.writeFileSync(path.join(f.markers, 'render-error'), '');
    const result = await executeTool('compile_and_preview', { pages: '1' }, {
      ...f, changesetBuffer: staged ? [{ path: 'main.tex', before: 'original main', after: 'staged main' }] : [],
    });
    assert.equal(typeof result.error, 'string');
    assert.equal(result.images, undefined);
    assertSnapshotRemoved(f, 'pdftoppm-pdf-path');
  }
});

test('zero, unsafe integers and out-of-range pages are rejected without rendering and clean snapshots', async () => {
  for (const pages of ['0', '0-3', '9007199254740992', '1-9007199254740992', '101']) {
    const f = fixture();
    fastPdfTools(f, 100);
    const result = await executeTool('compile_and_preview', { pages }, { ...f, changesetBuffer: [] });
    assert.equal(typeof result.error, 'string', 'reject invalid pages: ' + pages);
    assert.equal(fs.existsSync(path.join(f.markers, 'pdftoppm-running')), false);
    assertSnapshotRemoved(f);
  }
});

test('an enormous valid page range renders at most eight pages and cleans its snapshot', { timeout: 5000 }, async () => {
  const f = fixture();
  fastPdfTools(f, 999999999);
  const result = await executeTool('compile_and_preview', { pages: '1-999999999' }, { ...f, changesetBuffer: [] });
  assert.equal(result.error, undefined);
  assert.deepEqual(result.images.map((image) => image.page), [1, 2, 3, 4, 5, 6, 7, 8]);
  assertSnapshotRemoved(f);
});

test('cancelled compilation terminates an engine group and starts no later pass', async () => {
  const f = fixture();
  const original = fs.readFileSync(path.join(binDir,'pdflatex'));
  fakeBinary('pdflatex', [
    "const fs=require('node:fs'); const cp=require('node:child_process');",
    "fs.writeFileSync('engine-started','');",
    "cp.spawn(process.execPath,['-e',\"setTimeout(()=>require('node:fs').writeFileSync('late-engine-write',''),500)\"],{stdio:'inherit'});",
    "setTimeout(()=>{},10000);",
  ].join('\n'));
  const ac=new AbortController();
  try {
    const pending=compileProject({...f,signal:ac.signal});
    await waitForMarker(path.join(f.projectDir,'engine-started'));
    ac.abort();
    await assert.rejects(pending,{name:'AbortError'});
    await new Promise(r=>setTimeout(r,650));
    assert.equal(fs.existsSync(path.join(f.projectDir,'late-engine-write')),false);
  } finally { fs.writeFileSync(path.join(binDir,'pdflatex'),original); }
});
test('the same owner compiles two projects concurrently with separate PDF, jobs and logs', { timeout: 10000 }, async () => {
  const a = fixture('hold');
  const b = fixture('hold', -1, a.user);
  fs.writeFileSync(path.join(a.projectDir, 'main.tex'), 'PROJECT_A_SOURCE');
  fs.writeFileSync(path.join(b.projectDir, 'main.tex'), 'PROJECT_B_SOURCE');
  const pendingA = compileProject(a);
  const pendingB = compileProject(b);
  try {
    // Both engines must start before either is released: no user-wide compile lock.
    await Promise.all([a, b].map((f) => waitForMarker(path.join(f.projectDir, 'engine-started'))));
    fs.writeFileSync(path.join(b.projectDir, 'release-engine'), '');
    const resultB = await pendingB;
    assert.equal(resultB.status, 'success');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM compile_jobs WHERE project_id = ?').get(a.project.id).n, 0);
    fs.writeFileSync(path.join(a.projectDir, 'release-engine'), '');
    const resultA = await pendingA;
    assert.equal(resultA.status, 'success');
    assert.notEqual(resultA.jobId, resultB.jobId);
    for (const [f, result, source] of [[a, resultA, 'PROJECT_A_SOURCE'], [b, resultB, 'PROJECT_B_SOURCE']]) {
      assert.equal(fs.readFileSync(findBuild(f.project, String(result.jobId)).pdf, 'utf8'), '%PDF-1.4 fake\n' + source);
      assert.equal(result.pdfUrl, `/api/projects/${f.project.public_id}/pdf?jobId=${result.jobId}`);
      const job = db.prepare('SELECT * FROM compile_jobs WHERE id = ?').get(result.jobId);
      assert.equal(job.project_id, f.project.id);
      assert.equal(job.user_id, a.user.id);
      assert.match(fs.readFileSync(path.join(f.projectDir, job.log_path), 'utf8'), /Output written/);
    }
  } finally {
    for (const f of [a, b]) fs.writeFileSync(path.join(f.projectDir, 'release-engine'), '');
    await Promise.allSettled([pendingA, pendingB]);
  }
});

test('cancelling one project compile leaves the same owner other project running', { timeout: 10000 }, async () => {
  const a = fixture('hold');
  const b = fixture('hold', -1, a.user);
  const controller = new AbortController();
  const pendingA = compileProject({ ...a, signal: controller.signal });
  // Observe rejection before aborting so cancellation cannot become unhandled.
  const cancelled = assert.rejects(pendingA, { name: 'AbortError' });
  const pendingB = compileProject(b);
  try {
    await Promise.all([a, b].map((f) => waitForMarker(path.join(f.projectDir, 'engine-started'))));
    controller.abort();
    await cancelled;
    assert.equal(fs.existsSync(path.join(b.projectDir, 'release-engine')), false);
    fs.writeFileSync(path.join(b.projectDir, 'release-engine'), '');
    const resultB = await pendingB;
    assert.equal(resultB.status, 'success');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM compile_jobs WHERE project_id = ?').get(a.project.id).n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM compile_jobs WHERE project_id = ?').get(b.project.id).n, 1);
    assert.equal(fs.readFileSync(findBuild(b.project, String(resultB.jobId)).pdf, 'utf8'), '%PDF-1.4 fake\noriginal main');
  } finally {
    controller.abort();
    fs.writeFileSync(path.join(b.projectDir, 'release-engine'), '');
    await Promise.allSettled([pendingA, pendingB]);
  }
});

test('preview compilation decodes staged binary bytes without altering the formal asset', async () => {
  const f=fixture();
  const bytes=Buffer.from([0,255,128,1]);
  const result=await previewCompileProject({...f,staged:[{path:'figure.png',after:bytes.toString('base64'),encoding:'base64'}]});
  assert.equal(result.ok,true);
  assert.deepEqual(fs.readFileSync(path.join(f.projectDir,'.preview','figure.png')),bytes);
  assert.equal(fs.existsSync(path.join(f.projectDir,'figure.png')),false);
});

test('cancelling actual formal and preview engines charges elapsed time once and retains a concurrent quota grant', async () => {
  const quotas = await import('../src/quotas.js');
  for (const preview of [false, true]) {
    const f = fixture('hold', 100);
    const controller = new AbortController();
    const operation = preview ? previewCompileProject : compileProject;
    const pending = operation({ ...f, signal: controller.signal });
    const rejected = assert.rejects(pending, { name: 'AbortError' });
    await waitForMarker(path.join(f.projectDir, ...(preview ? ['.preview'] : []), 'engine-started'));
    await new Promise(resolve => setTimeout(resolve, 100));
    quotas.grantDailyCompileQuota(db, f.user.id);
    controller.abort();
    await rejected;
    const deadline = Date.now() + 2000;
    let charged = 0;
    while (!charged && Date.now() < deadline) {
      charged = db.prepare('SELECT compile_seconds_used value FROM users WHERE id=?').get(f.user.id).value;
      if (!charged) await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.ok(charged >= 0.1, 'cancelled real execution is charged');
    assert.equal(quotas.usageForUser(f.user).compileSecondsQuota, 200);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM compile_jobs WHERE project_id=?').get(f.project.id).n, 0, 'cancellation is not recorded as a successful job');
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(db.prepare('SELECT compile_seconds_used value FROM users WHERE id=?').get(f.user.id).value, charged, 'only one settlement');
  }
});

test('cancelling a queued compile before its engine starts does not consume additional quota', async () => {
  const f = fixture('hold', 100), controller = new AbortController();
  const first = compileProject(f);
  await waitForMarker(path.join(f.projectDir, 'engine-started'));
  const second = compileProject({ ...f, signal: controller.signal });
  const rejected = assert.rejects(second, { name: 'AbortError' });
  controller.abort();
  await rejected;
  fs.writeFileSync(path.join(f.projectDir, 'release-engine'), '');
  const completed = await first;
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(db.prepare('SELECT compile_seconds_used value FROM users WHERE id=?').get(f.user.id).value, completed.durationMs / 1000);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM compile_jobs WHERE project_id=?').get(f.project.id).n, 1);
});


test('preview renderer and cached queue leases survive caller cancellation until real process and snapshot cleanup finish', async () => {
  const { createCompilationCache } = await import('../src/services/agent/tools.js');
  const { acquireMaintenance, maintenanceStatus, releaseMaintenance } = await import('../src/services/maintenance.js');
  const binary = path.join(binDir, 'pdftoppm'), previous = fs.readFileSync(binary);
  fakeBinary('pdftoppm', String.raw`
const fs=require('node:fs'),path=require('node:path'),markers=process.env.CORELATEX_FAKE_MARKERS;
fs.writeFileSync(path.join(markers,'pdftoppm-pdf-path'),process.argv.at(-2));
fs.writeFileSync(path.join(markers,'pdftoppm-running'),'');
fs.writeFileSync(path.join(markers,'renderer-pid'),String(process.pid));
setInterval(()=>{},10);
`);
  const controller = new AbortController(), cache = createCompilationCache({ signal: controller.signal });
  const f = fixture(), ctx = { ...f, changesetBuffer: [], compilationCache: cache, signal: controller.signal };
  try {
    const first = executeTool('compile_and_preview', { pages: '1' }, ctx);
    await waitForMarker(path.join(f.markers, 'pdftoppm-running'));
    const queued = executeTool('compile_and_preview', { pages: '2' }, ctx);
    assert.equal(maintenanceStatus(db).compiles.length, 2, 'renderer plus queued cached request are both protected');
    controller.abort();
    const cancelled = await Promise.all([first, queued]);
    for (const result of cancelled) assert.match(result.error, /abort|取消|关闭/i);
    assert.ok(maintenanceStatus(db).compiles.length > 0, 'caller returns before actual pending cleanup');
    const ownerToken = randomBytes(32).toString('hex');
    assert.throws(() => acquireMaintenance(db, { ownerToken }), error => error.status === 409 && error.work.compiles.length > 0);
    await cache.cleanup();
    const rendererPid = Number(fs.readFileSync(path.join(f.markers, 'renderer-pid'), 'utf8'));
    assert.throws(() => process.kill(rendererPid, 0), error => error.code === 'ESRCH');
    assertSnapshotRemoved(f, 'pdftoppm-pdf-path');
    assert.deepEqual(maintenanceStatus(db).compiles, []);
    acquireMaintenance(db, { ownerToken }); releaseMaintenance(db, { ownerToken });
  } finally {
    controller.abort(); await cache.cleanup(); fs.writeFileSync(binary, previous);
  }
});
