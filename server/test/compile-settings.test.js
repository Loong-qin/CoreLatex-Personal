import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { api, registerAndLogin } from './helpers.js';

let root, db, resetDb, server, base, owner, editor, viewer, configureTexRuntime;
before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'corelatex-compile-settings-'));
  process.env.CORELATEX_DATA_DIR = root;
  ({ getDb: db, resetDb } = await import('../src/db.js')); db = db();
  ({ configureTexRuntime } = await import('../src/services/texRuntimes.js'));
  for (const version of ['2024', '2026']) {
    const bin = path.join(root, 'bins', version); fs.mkdirSync(bin, { recursive: true });
    const body = `#!${process.execPath}\nconst fs=require('node:fs'); const path=require('node:path');
if(process.argv.includes('--version')) { console.log('pdfTeX (TeX Live ${version})'); process.exit(0); }
const out=process.argv.find(arg=>arg.startsWith('-output-directory=')).slice('-output-directory='.length);
fs.mkdirSync(out,{recursive:true}); fs.writeFileSync(path.join(out,'started'),'1');
setTimeout(()=> { fs.writeFileSync(path.join(out,'main.pdf'),'%PDF-1.0'); fs.writeFileSync(path.join(out,'main.log'),'Output written on main.pdf'); },180);
`;
    for (const engine of ['xelatex', 'pdflatex', 'lualatex']) fs.writeFileSync(path.join(bin, engine), body, { mode: 0o755 });
    configureTexRuntime(version, { enabled: true, binDir: bin });
  }
  const express = (await import('express')).default;
  const { requireAuth } = await import('../src/auth.js');
  const { HttpError } = await import('../src/util.js');
  const app = express(); app.use(express.json());
  app.use('/api/auth', (await import('../src/routes/auth.js')).default);
  app.use('/api/projects', requireAuth, (await import('../src/routes/projects.js')).default);
  app.use('/api/projects', requireAuth, (await import('../src/routes/compile.js')).default);
  app.use((err, _req, res, _next) => res.status(err instanceof HttpError ? err.status : 500).json({ error: err.message }));
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.on('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  owner = await registerAndLogin(base, 'owner'); editor = await registerAndLogin(base, 'editor'); viewer = await registerAndLogin(base, 'viewer');
});
after(async () => { await new Promise(resolve => server.close(resolve)); resetDb(); fs.rmSync(root, { recursive: true, force: true }); });

async function project() {
  const r = await api(base, 'POST', '/api/projects', { token: owner.token, body: { name: 'Compiler preferences' } });
  assert.equal(r.status, 201); return r.data.project;
}
test('engine and runtime selection persists without compiling, and invalid combined settings are atomic', async () => {
  const p = await project(), endpoint = `/api/projects/${p.publicId}/compile/settings`;
  let r = await api(base, 'PATCH', endpoint, { token: owner.token, body: { engine: 'xelatex', texVersion: '2026' } });
  assert.equal(r.status, 200); assert.deepEqual(r.data, { engine: 'xelatex', texVersion: '2026' });
  assert.equal(db.prepare('SELECT count(*) AS n FROM compile_jobs WHERE project_id=?').get(p.id).n, 0);
  r = await api(base, 'GET', `/api/projects/${p.publicId}`, { token: owner.token });
  assert.equal(r.data.project.compileEngine, 'xelatex'); assert.equal(r.data.project.texVersion, '2026');
  r = await api(base, 'PATCH', endpoint, { token: owner.token, body: { engine: 'lualatex', texVersion: 'not-a-version' } });
  assert.equal(r.status, 400); assert.equal(db.prepare('SELECT compile_engine FROM projects WHERE id=?').get(p.id).compile_engine, 'xelatex');
  r = await api(base, 'PATCH', endpoint, { token: owner.token, body: { engine: 'bash' } }); assert.equal(r.status, 400);
});
test('selection permits project editors but denies viewers and outsiders', async () => {
  const p = await project(), endpoint = `/api/projects/${p.publicId}/compile/settings`;
  assert.equal((await api(base, 'PATCH', endpoint, { token: editor.token, body: { engine: 'xelatex' } })).status, 403);
  db.prepare('INSERT INTO project_members(project_id,user_id,role) VALUES(?,?,?)').run(p.id, editor.user.id, 'editor');
  db.prepare('INSERT INTO project_members(project_id,user_id,role) VALUES(?,?,?)').run(p.id, viewer.user.id, 'viewer');
  assert.equal((await api(base, 'PATCH', endpoint, { token: editor.token, body: { engine: 'lualatex' } })).status, 200);
  assert.equal((await api(base, 'PATCH', endpoint, { token: viewer.token, body: { engine: 'pdflatex' } })).status, 403);
});
test('finishing an older compile does not overwrite the next selected engine and runtime', async () => {
  const p = await project();
  const compilation = api(base, 'POST', `/api/projects/${p.publicId}/compile`, { token: owner.token, body: { engine: 'pdflatex', texVersion: '2024', persistSelection: false } });
  const marker = path.join(root, 'projects', String(p.id), '.build', 'work', 'started');
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(marker) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(fs.existsSync(marker));
  const save = await api(base, 'PATCH', `/api/projects/${p.publicId}/compile/settings`, { token: owner.token, body: { engine: 'lualatex', texVersion: '2026' } });
  assert.equal(save.status, 200);
  const r = await compilation; assert.equal(r.status, 200); assert.equal(r.data.status, 'success'); assert.equal(r.data.texVersion, '2024');
  const saved = await api(base, 'GET', `/api/projects/${p.publicId}`, { token: owner.token });
  assert.equal(saved.data.project.compileEngine, 'lualatex'); assert.equal(saved.data.project.texVersion, '2026');
});
