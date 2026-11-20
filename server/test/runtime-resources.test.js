import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'corelatex-runtime-resources-test-'));
process.env.CORELATEX_DATA_DIR = path.join(temp, 'data');
let resources, environment, runProcess, executeTool, db, resetDb, server, base, adminToken, userToken, fontBytes, packageBin;
const python = process.env.CORELATEX_TEST_PYTHON || 'python3';
let pythonReady = false;
const realFetch = globalThis.fetch;
const mirrorReleaseOverride = new Map();
const mirrorChecks = [];
globalThis.fetch = (url, options) => {
  const text = String(url);
  if (text.endsWith('/tlpkg/texlive.tlpdb')) {
    mirrorChecks.push(text);
    const year = mirrorReleaseOverride.get(text) || text.match(/\/(202[2-6])\//)?.[1] || '2026';
    return Promise.resolve(new Response('name 00texlive.config\ndepend release/' + year + '\n\n', { status: 206 }));
  }
  return realFetch(url, options);
};
const writeBinary = (file, body) => fs.writeFileSync(file, '#!/usr/bin/env node\n' + body, { mode: 0o755 });

before(async () => {
  environment = await import('../src/services/runtimeEnvironment.js');
  resources = await import('../src/services/runtimeResources.js');
  ({ runProcess } = await import('../src/services/process.js'));
  ({ executeTool } = await import('../src/services/agent/tools.js'));
  const dbModule = await import('../src/db.js'); db = dbModule.getDb(); resetDb = dbModule.resetDb;
  const auth = await import('../src/auth.js');
  for (const role of ['admin', 'user']) {
    const id = db.prepare('INSERT INTO users(username,password_hash,role) VALUES(?,?,?)').run('runtime-' + role, 'unused', role).lastInsertRowid;
    const token = auth.signToken(db.prepare('SELECT * FROM users WHERE id=?').get(id));
    if (role === 'admin') adminToken = token; else userToken = token;
  }
  const { createApp } = await import('../src/index.js'); server = http.createServer(createApp());
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); base = 'http://127.0.0.1:' + server.address().port;
  const match = await runProcess('fc-match', ['--format', '%{file}', 'sans']); assert.equal(match.exitCode, 0);
  fontBytes = fs.readFileSync(match.stdout.trim());
  packageBin = path.join(environment.RUNTIME_DIR, 'texlive', '2024', 'bin', process.arch === 'arm64' ? 'aarch64-linux' : 'x86_64-linux');
  fs.mkdirSync(packageBin, { recursive: true });
  writeBinary(path.join(packageBin, 'pdflatex'), "console.log('pdfTeX (TeX Live 2024)');");
  writeBinary(path.join(packageBin, 'tlmgr'), String.raw`
const fs=require('node:fs'),path=require('node:path'),dir=path.dirname(process.argv[1]);
const state=path.join(dir,'packages.json'),log=path.join(dir,'calls.log');
let installed=fs.existsSync(state)?JSON.parse(fs.readFileSync(state,'utf8')):[];
const raw=process.argv.slice(2),args=raw[0]==='--repository'?raw.slice(2):raw;
const command=args[0]; fs.appendFileSync(log,JSON.stringify(raw)+'\n');
function install(names) {
 installed=[...new Set([...installed,...names])];fs.writeFileSync(state,JSON.stringify(installed));
 if(names.includes('partial-failure')){console.error('simulated failure after one installed package');process.exitCode=1;}
 else console.log('installed '+names.join(','));
}
if(command==='info') console.log(installed.filter(name=>args.slice(4).includes(name)).join('\n'));
else if(command==='install') {
 const names=args.slice(1);
 if(names.includes('paused-permission')) {
  fs.writeFileSync(path.join(dir,'permission-install-started'),'');
  setTimeout(()=>install(names),4000);
 } else install(names);
}`);
  const py = await runProcess(python, ['-c', 'import matplotlib, fontTools']); pythonReady = py.exitCode === 0;
});
after(async () => {
  server?.closeAllConnections(); if (server) await new Promise(resolve => server.close(resolve)); resetDb?.(); globalThis.fetch = realFetch;
  assert.ok(temp.startsWith(path.join(os.tmpdir(), 'corelatex-runtime-resources-test-'))); fs.rmSync(temp, { recursive: true, force: true });
});

function packageCalls() {
  return fs.readFileSync(path.join(packageBin, 'calls.log'), 'utf8').trim().split('\n').map(JSON.parse);
}

function runtimeAgentContext(publicId) {
  const user = db.prepare("SELECT * FROM users WHERE username='runtime-user'").get();
  const projectId = db.prepare("INSERT INTO projects(name,owner_id,public_id,tex_version) VALUES(?,?,?,'2024')")
    .run(publicId, user.id, publicId).lastInsertRowid;
  const project = db.prepare('SELECT * FROM projects WHERE id=?').get(projectId);
  return { user, project };
}

test('real font validation, persistent discovery and identical installation are idempotent', async () => {
  const before = environment.getRuntimeResourceRevision();
  const first = await resources.installFontFiles([{ originalname: 'Uploaded.ttf', buffer: fontBytes }]);
  assert.equal(first.changed, true); assert.notEqual(environment.getRuntimeResourceRevision(), before);
  const revision = environment.getRuntimeResourceRevision();
  assert.ok(first.fonts.some(font => font.managed && fs.existsSync(font.file)));
  const duplicate = await resources.installFontFiles([{ originalname: 'Same-Font.ttf', buffer: fontBytes }]);
  assert.equal(duplicate.changed, false); assert.equal(environment.getRuntimeResourceRevision(), revision);
  const script = `const {listRuntimeFonts}=await import(${JSON.stringify(new URL('../src/services/runtimeResources.js', import.meta.url).href)});console.log(JSON.stringify(await listRuntimeFonts()));`;
  const fresh = await runProcess(process.execPath, ['--input-type=module', '-e', script]);
  assert.equal(fresh.exitCode, 0, fresh.stderr);
  assert.ok(JSON.parse(fresh.stdout).some(font => font.managed && first.fonts.some(original => original.file === font.file)));
  await assert.rejects(resources.installFontFiles([{ originalname: 'fake.ttf', buffer: Buffer.from('not a font file at all') }]), /字体/);
  assert.equal(environment.getRuntimeResourceRevision(), revision, 'validation failure must not claim environment mutation');
});

test('font staging rechecks installation access before publishing validated files', async () => {
  const revision = environment.getRuntimeResourceRevision();
  const fonts = fs.readdirSync(environment.FONT_DIR).sort();
  const pending = { originalname: 'staged-before-revocation.ttf', buffer: Buffer.concat([fontBytes, Buffer.alloc(4, 44)]) };
  let checks = 0;
  await assert.rejects(resources.installFontFiles([pending], { beforeInstall() {
    if (++checks === 2) throw new Error('安装权限已失效');
  } }), /安装权限已失效/);
  assert.equal(checks, 2);
  assert.deepEqual(fs.readdirSync(environment.FONT_DIR).sort(), fonts);
  assert.equal(environment.getRuntimeResourceRevision(), revision);
});

test('a newly named uploaded font renders in fresh Matplotlib processes and real XeLaTeX', async t => {
  if (!pythonReady) return t.skip('matplotlib/fontTools unavailable; set CORELATEX_TEST_PYTHON to the test interpreter');
  const source = path.join(temp, 'source.ttf'), target = path.join(temp, 'unique.ttf'); fs.writeFileSync(source, fontBytes);
  const family = 'CoreLatex Persistent Font';
  const rename = await runProcess(python, ['-c', String.raw`
import sys
from fontTools.ttLib import TTFont
font=TTFont(sys.argv[1]); family=sys.argv[3]
for record in font['name'].names:
 if record.nameID in (1,4,6,16): record.string=(family.replace(' ','') if record.nameID==6 else family).encode(record.getEncoding(),errors='replace')
font.save(sys.argv[2])
`, source, target, family]); assert.equal(rename.exitCode, 0, rename.stderr);
  // Create a stale font-manager cache before adding the new font.
  const old = await runProcess(python, ['-c', 'from matplotlib import font_manager; print(len(font_manager.fontManager.ttflist))']); assert.equal(old.exitCode, 0, old.stderr);
  const result = await resources.installFontFiles([{ originalname: 'unique.ttf', buffer: fs.readFileSync(target) }]);
  assert.equal(result.changed, true); assert.ok(result.fonts.some(font => font.family.includes(family)));
  for (let attempt = 0; attempt < 2; attempt++) {
    const image = path.join(temp, 'render-' + attempt + '.png');
    const rendered = await runProcess(python, ['-c', String.raw`
import sys
import matplotlib; matplotlib.use('Agg')
from matplotlib import pyplot as plt,font_manager
font=font_manager.findfont(font_manager.FontProperties(family=sys.argv[1]),fallback_to_default=False)
print(font)
plt.rcParams['font.family']=sys.argv[1]
plt.plot([1,2,3],[2,1,3]);plt.title('Persistent font');plt.savefig(sys.argv[2])
`, family, image]);
    assert.equal(rendered.exitCode, 0, rendered.stderr);
    assert.ok(rendered.stdout.trim().startsWith(environment.FONT_DIR + path.sep), rendered.stdout);
    assert.ok(fs.statSync(image).size > 1000);
  }
  const document = path.join(temp, 'shared-font.tex');
  fs.writeFileSync(document, String.raw`\documentclass{article}
\usepackage{fontspec}
\setmainfont{CoreLatex Persistent Font}
\begin{document}One persistent font for LaTeX and Python.\end{document}`);
  const compiled = await runProcess('xelatex', ['-interaction=nonstopmode', '-halt-on-error', '-output-directory', temp, document], { cwd: temp });
  assert.equal(compiled.exitCode, 0, compiled.stdout + compiled.stderr);
  assert.ok(fs.statSync(path.join(temp, 'shared-font.pdf')).size > 1000);
});

test('managed package installation is verified and partial failures invalidate prior environment proof', async () => {
  const before = environment.getRuntimeResourceRevision();
  const bad = 'https://mirror.nju.edu.cn/tex-historic/systems/texlive/2024/tlnet-final/tlpkg/texlive.tlpdb';
  mirrorReleaseOverride.set(bad, '2023');
  const first = await resources.installTexPackages({ version: '2024', packages: ['amsmath', 'algorithms'] });
  mirrorReleaseOverride.delete(bad);
  assert.equal(first.changed, true); assert.notEqual(environment.getRuntimeResourceRevision(), before);
  assert.match(first.repository, /2024\/tlnet-final$/);
  assert.ok(!first.repository.includes('mirror.nju.edu.cn'), 'wrong release must be rejected before installation');
  assert.ok(mirrorChecks.includes(bad));
  const revision = environment.getRuntimeResourceRevision();
  const duplicate = await resources.installTexPackages({ version: '2024', packages: ['amsmath'] });
  assert.equal(duplicate.changed, false); assert.equal(environment.getRuntimeResourceRevision(), revision);
  const calls = packageCalls();
  const installs = calls.filter(call => call[0] === '--repository' && call[2] === 'install');
  assert.equal(installs.length, 1);
  assert.equal(installs[0][1], first.repository);
  assert.ok(calls.some(call => call[0] === 'option' && call[1] === 'repository' && call[2] === first.repository));
  await assert.rejects(resources.installTexPackages({ version: '2024', packages: ['amsmath; touch bad'] }), /名称|命令/);
  assert.equal(environment.getRuntimeResourceRevision(), revision);
  await assert.rejects(resources.installTexPackages({ version: '2024', packages: ['partial-failure'] }), /安装.*失败/);
  assert.notEqual(environment.getRuntimeResourceRevision(), revision);
  assert.ok(JSON.parse(fs.readFileSync(path.join(packageBin, 'packages.json'))).includes('partial-failure'));
});

test('an ordinary project owner can use the configured mirror without saving repository settings', async () => {
  const context = runtimeAgentContext('tex-agent-packages');
  const before = packageCalls().length;
  const result = await executeTool('install_tex_packages', { packages: ['amsthm'] }, context);
  assert.equal(context.user.role, 'user');
  assert.equal(result.error, undefined, result.error);
  assert.equal(result.changed, true);
  assert.equal(result.version, '2024');
  const calls = packageCalls().slice(before);
  assert.ok(calls.some(call => call[0] === '--repository' && call[1] === result.repository && call[2] === 'install' && call[3] === 'amsthm'));
  assert.ok(!calls.some(call => call[0] === 'option'));
});

test('TeX mirror validation cannot lead to installation after project access is withdrawn', async () => {
  const { user: owner, project } = runtimeAgentContext('tex-agent-revoke');
  const editor = db.prepare("SELECT * FROM users WHERE username='runtime-admin'").get();
  db.prepare("UPDATE users SET role='user' WHERE id=?").run(editor.id);
  db.prepare("INSERT INTO project_members(project_id,user_id,role) VALUES(?,?,'editor')").run(project.id, editor.id);
  const fetchBefore = globalThis.fetch;
  const before = packageCalls().length;
  const revision = environment.getRuntimeResourceRevision();
  let probes = 0;
  globalThis.fetch = (url, options) => {
    if (String(url).endsWith('/tlpkg/texlive.tlpdb')) {
      probes++;
      db.prepare('DELETE FROM project_members WHERE project_id=? AND user_id=?').run(project.id, editor.id);
    }
    return fetchBefore(url, options);
  };
  try {
    const result = await executeTool('install_tex_packages', { packages: ['xcolor'] }, { user: editor, project });
    assert.notEqual(project.owner_id, editor.id);
    assert.equal(project.owner_id, owner.id);
    assert.match(result.error, /无权访问该项目/);
    assert.equal(probes, 1, 'authorization loss prevents mirror retries');
    assert.ok(!packageCalls().slice(before).some(call => call.includes('install')));
    assert.equal(environment.getRuntimeResourceRevision(), revision);
  } finally {
    db.prepare("UPDATE users SET role='admin' WHERE id=?").run(editor.id);
    globalThis.fetch = fetchBefore;
  }
});

test('disabling the account interrupts an in-flight TeX installer before it can finish', async () => {
  const context = runtimeAgentContext('tex-agent-disabled');
  const marker = path.join(packageBin, 'permission-install-started');
  const pending = executeTool('install_tex_packages', { packages: ['paused-permission'] }, {
    ...context, signal: AbortSignal.timeout(7000),
  });
  try {
    const deadline = Date.now() + 3000;
    while (!fs.existsSync(marker) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(fs.existsSync(marker), 'the TeX installation command must have started');
    db.prepare("UPDATE users SET status='disabled' WHERE id=?").run(context.user.id);
    assert.match((await pending).error, /账号已被禁用/);
    const installed = JSON.parse(fs.readFileSync(path.join(packageBin, 'packages.json'), 'utf8'));
    assert.ok(!installed.includes('paused-permission'));
  } finally {
    db.prepare("UPDATE users SET status='active' WHERE id=?").run(context.user.id);
    await pending;
  }
});

test('runtime API requires current admin rights and reports actual asynchronous job completion', async () => {
  const url = base + '/api/admin/runtime-resources/tex-packages';
  const post = token => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify({ version: '2024', packages: ['geometry'] }) });
  assert.equal((await post()).status, 401); assert.equal((await post(userToken)).status, 403);
  const accepted = await post(adminToken); assert.equal(accepted.status, 202);
  const { job } = await accepted.json(); assert.equal(job.status, 'running');
  let finished; const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    finished = resources.listRuntimeJobs().find(item => item.id === job.id);
    if (finished.status !== 'running') break;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  assert.equal(finished.status, 'succeeded', finished.error); assert.equal(finished.result.changed, true);
  assert.ok(finished.finishedAt);
  db.prepare("UPDATE users SET role='user' WHERE username='runtime-admin'").run();
  assert.equal((await post(adminToken)).status, 403, 'old admin token must not survive database demotion');
});


test('retry repairs font caches after a failure that already persisted the font', async () => {
  const bin = path.join(temp, 'font-cache-failure'); fs.mkdirSync(bin);
  const marker = path.join(bin, 'calls');
  writeBinary(path.join(bin, 'fc-cache'), `const fs=require('node:fs'),cp=require('node:child_process');const marker=${JSON.stringify(marker)};const count=fs.existsSync(marker)?Number(fs.readFileSync(marker,'utf8')):0;fs.writeFileSync(marker,String(count+1));if(!count){console.error('simulated cache failure');process.exitCode=1;}else{const r=cp.spawnSync('/usr/bin/fc-cache',process.argv.slice(2),{env:process.env});process.exitCode=r.status;}`);
  const savedPath = process.env.PATH; process.env.PATH = bin + path.delimiter + savedPath;
  const file = { originalname: 'Retry.ttf', buffer: Buffer.concat([fontBytes, Buffer.from([0,0,0,0])]) };
  const revision = environment.getRuntimeResourceRevision();
  try {
    const mpl = environment.runtimeEnvironment().MPLCONFIGDIR;
    const oldCache = path.join(mpl, 'fontlist-v3.11.0.json'); fs.writeFileSync(oldCache, '{}');
    await assert.rejects(resources.installFontFiles([file]), /字体缓存失败/);
    assert.notEqual(environment.getRuntimeResourceRevision(), revision, 'partial persistent mutation invalidates proof');
    const retry = await resources.installFontFiles([file]);
    assert.equal(retry.changed, false, 'retry recognizes the already persisted bytes');
    assert.equal(fs.readFileSync(marker, 'utf8'), '2');
    assert.equal(fs.existsSync(oldCache), false, 'both old and new Matplotlib cache naming must be invalidated');
  } finally { process.env.PATH = savedPath; }
});


test('installation waits for admitted compilation and blocks new compile/maintenance admission', async () => {
  const maintenance = await import('../src/services/maintenance.js');
  const user = db.prepare("SELECT * FROM users WHERE username='runtime-user'").get();
  const pid = Number(db.prepare("INSERT INTO projects(name,owner_id,public_id) VALUES('runtime-coordination',?,'runtime-coordination')").run(user.id).lastInsertRowid);
  const lease = maintenance.createCompileLease(db, { projectId: pid, userId: user.id, kind: 'preview' });
  let mutated = false;
  const installing = environment.withRuntimeInstallLock(async () => { mutated = true; return 'installed'; });
  try {
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(mutated, false, 'existing compile lease retains a stable runtime');
    assert.throws(() => environment.assertRuntimeReady(), /正在安装/);
    assert.throws(() => maintenance.acquireMaintenance(db, { ownerToken: 'a'.repeat(64) }), /正在安装/);
    assert.throws(() => maintenance.createCompileLease(db, { projectId: pid, userId: user.id, kind: 'preview' }), /正在安装/);
  } finally { maintenance.finishCompileLease(db, lease); await installing; }
  assert.equal(mutated, true); assert.doesNotThrow(() => environment.assertRuntimeReady());
});

test('maintenance denies installation without mutation and releases its attempted install lock', async () => {
  const maintenance = await import('../src/services/maintenance.js');
  const ownerToken = 'b'.repeat(64);
  maintenance.acquireMaintenance(db, { ownerToken });
  let mutated = false;
  try {
    await assert.rejects(environment.withRuntimeInstallLock(async () => { mutated = true; }), /维护/);
    assert.equal(mutated, false);
    assert.equal(fs.existsSync(path.join(environment.RUNTIME_DIR, 'install.lock')), false);
  } finally { maintenance.releaseMaintenance(db, { ownerToken }); }
});
