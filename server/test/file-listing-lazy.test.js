import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTestServer, api, registerAndLogin } from './helpers.js';

let srv, user, pid, root;
before(async () => {
  srv = await startTestServer();
  user = await registerAndLogin(srv.baseUrl, 'lazyowner');
  const created = await api(srv.baseUrl, 'POST', '/api/projects', { token: user.token, body: { name: 'Lazy workspace' } });
  assert.equal(created.status, 201);
  pid = created.data.project.publicId;
  root = path.join(srv.dataDir, 'projects', String(created.data.project.id));
});
after(async () => { await srv.close(); });
const get = (route, token = user.token) => api(srv.baseUrl, 'GET', `/api/projects/${pid}${route}`, { token });
const list = (relative, params = '') => get(`/workspace/children?path=${encodeURIComponent(relative)}${params}`);

// Ensure a large, deeply nested workspace is never scanned to open the project.
test('summary detail avoids size traversal and the formal tree excludes workspace without reading it', async () => {
  fs.mkdirSync(path.join(root, '_workspace', 'deep', 'large'), { recursive: true });
  fs.writeFileSync(path.join(root, '_workspace', 'deep', 'large', 'hidden-from-formal-tree.txt'), 'workspace-content');
  fs.mkdirSync(path.join(root, 'section'), { recursive: true });
  fs.writeFileSync(path.join(root, 'section', 'paper.tex'), 'formal-content');
  const readDir = fs.readdirSync, openDir = fs.promises.opendir;
  let projectReads = 0;
  fs.readdirSync = function(dir, ...args) {
    if (String(dir) === root || String(dir).startsWith(root + path.sep)) projectReads++;
    return readDir.call(this, dir, ...args);
  };
  fs.promises.opendir = function(dir, ...args) {
    if (String(dir) === root || String(dir).startsWith(root + path.sep)) projectReads++;
    return openDir.call(this, dir, ...args);
  };
  try {
    const brief = await get('?summary=1');
    assert.equal(brief.status, 200);
    assert.equal(brief.data.project.mainFile, 'main.tex');
    assert.equal(Object.hasOwn(brief.data.project, 'sizeBytes'), false);
    assert.equal(projectReads, 0, 'summary detail must not walk any project files');
    const full = await get('');
    assert.equal(full.status, 200); assert.ok(full.data.project.sizeBytes > 0);
    assert.ok(projectReads > 0, 'legacy detail still provides size');
  } finally { fs.readdirSync = readDir; fs.promises.opendir = openDir; }

  const promises = fs.promises, read = promises.readdir;
  const visited = [];
  promises.readdir = async function(dir, options) {
    visited.push(String(dir)); return read.call(this, dir, options);
  };
  try {
    const tree = await get('/tree?excludeWorkspace=1');
    assert.equal(tree.status, 200);
    assert.ok(tree.data.tree.some(node => node.path === 'main.tex'));
    assert.equal(tree.data.tree.some(node => node.path === '_workspace'), false);
    assert.equal(tree.data.tree.find(node => node.path === 'section').children[0].path, 'section/paper.tex');
    assert.equal(visited.some(dir => dir.includes(path.join('_workspace', 'deep')) || dir.endsWith(path.sep + '_workspace')), false);
  } finally { promises.readdir = read; }
  const legacy = await get('/tree');
  assert.ok(legacy.data.tree.find(node => node.path === '_workspace').children.some(node => node.name === 'deep'));
});

test('identity summary skips storage scanning; asynchronous identity and usage preserve exact totals', async () => {
  fs.writeFileSync(path.join(root, '_workspace', '.hidden-size'), 'hidden counts toward storage');
  fs.mkdirSync(path.join(root, '_workspace', '.build'), { recursive: true });
  fs.writeFileSync(path.join(root, '_workspace', '.build', 'not-counted.bin'), 'temporary');
  const { projectStorageBytes } = await import('../src/util.js');
  const expected = projectStorageBytes(root);
  const promises = fs.promises, openDir = promises.opendir;
  let scans = 0;
  promises.opendir = function(dir, ...args) {
    if (String(dir) === root || String(dir).startsWith(root + path.sep)) scans++;
    return openDir.call(this, dir, ...args);
  };
  try {
    const summary = await api(srv.baseUrl, 'GET', '/api/auth/me?summary=1', { token: user.token });
    assert.equal(summary.status, 200);
    assert.equal(summary.data.user.id, user.user.id);
    assert.equal(summary.data.usage.storageUsed, null);
    assert.equal(typeof summary.data.usage.storageQuota, 'number');
    assert.equal(scans, 0, 'identity summary must not scan project directories');
    const full = await api(srv.baseUrl, 'GET', '/api/auth/me', { token: user.token });
    const usage = await api(srv.baseUrl, 'GET', '/api/users/me/usage', { token: user.token });
    assert.equal(full.status, 200); assert.equal(usage.status, 200);
    assert.equal(full.data.usage.storageUsed, expected);
    assert.equal(usage.data.storageUsed, expected);
    assert.ok(scans > 0, 'full usage reads the project tree asynchronously');
  } finally { promises.opendir = openDir; }
});

test('background size and usage requests do not block project open and stop scanning on disconnect', async () => {
  for (const route of ['/api/projects?view=all', '/api/users/me/usage', '/api/auth/me', `/api/projects/${pid}`]) {
    const promises = fs.promises, openDir = promises.opendir;
    let entered, release, closed, finishedOpen;
    const started = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const responseClosed = new Promise(resolve => { closed = resolve; });
    const firstOpenFinished = new Promise(resolve => { finishedOpen = resolve; });
    const opened = [];
    let paused = false;
    const onRequest = (request, response) => { if (request.url === route) response.once('close', closed); };
    srv.server.prependListener('request', onRequest);
    promises.opendir = async function(dir, ...args) {
      opened.push(String(dir));
      if (String(dir) === root && !paused) { paused = true; entered(); await gate; }
      const result = await openDir.call(this, dir, ...args);
      if (String(dir) === root) finishedOpen();
      return result;
    };
    const controller = new AbortController();
    const pending = fetch(`${srv.baseUrl}${route}`, {
      headers: { Authorization: `Bearer ${user.token}` }, signal: controller.signal,
    }).catch(error => error);
    try {
      await started;
      // An unfinished size scan must not prevent the main editor's detail request.
      assert.equal((await get('?summary=1')).status, 200);
      controller.abort(); assert.equal((await pending).name, 'AbortError');
      await responseClosed;
      release(); await firstOpenFinished;
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(opened, [root], route + ' continued scanning after disconnect');
    } finally { release(); promises.opendir = openDir; srv.server.off('request', onRequest); }
  }
});

test('write storage quotas still use current actual bytes rather than read-side summaries', async () => {
  const limited = await registerAndLogin(srv.baseUrl, 'lazy-limited');
  const created = await api(srv.baseUrl, 'POST', '/api/projects', { token: limited.token, body: { name: 'Quota' } });
  assert.equal(created.status, 201);
  const { getDb } = await import('../src/db.js');
  const { storageUsedBytes } = await import('../src/quotas.js');
  const used = storageUsedBytes(limited.user.id);
  getDb().prepare('UPDATE users SET storage_quota_bytes = ? WHERE id = ?').run(used + 3, limited.user.id);
  const id = created.data.project.publicId;
  const write = (file, content) => api(srv.baseUrl, 'POST', `/api/projects/${id}/files`, {
    token: limited.token, body: { path: file, content },
  });
  assert.equal((await write('allowed.txt', 'abc')).status, 200);
  assert.equal((await write('denied.txt', 'd')).status, 403);
});

test('formal tree enumeration yields while project metadata is requested', async () => {
  const promises = fs.promises, read = promises.readdir;
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let paused = false;
  promises.readdir = async function(dir, options) {
    if (String(dir) === root && !paused) { paused = true; entered(); await gate; }
    return read.call(this, dir, options);
  };
  try {
    const treePromise = get('/tree?excludeWorkspace=1');
    await started;
    const detail = await get('?summary=1');
    assert.equal(detail.status, 200); // The deliberately blocked listing has not yet been released.
    release();
    assert.equal((await treePromise).status, 200);
  } finally { release(); promises.readdir = read; }
});

test('aborting a tree request stops walking further project directories', async () => {
  const promises = fs.promises, read = promises.readdir;
  let entered, release, closed, finishedRead;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const responseClosed = new Promise(resolve => { closed = resolve; });
  const rootReadFinished = new Promise(resolve => { finishedRead = resolve; });
  const reads = [];
  const onRequest = (request, response) => {
    if (request.url.includes('/tree?excludeWorkspace=1')) response.once('close', closed);
  };
  srv.server.prependListener('request', onRequest);
  promises.readdir = async function(dir, options) {
    reads.push(String(dir));
    if (String(dir) === root) { entered(); await gate; }
    const value = await read.call(this, dir, options);
    if (String(dir) === root) finishedRead();
    return value;
  };
  const controller = new AbortController();
  const pending = fetch(`${srv.baseUrl}/api/projects/${pid}/tree?excludeWorkspace=1`, {
    headers: { Authorization: `Bearer ${user.token}` }, signal: controller.signal,
  }).catch(error => error);
  try {
    await started;
    controller.abort();
    assert.equal((await pending).name, 'AbortError');
    await responseClosed;
    release(); await rootReadFinished;
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(reads, [root]);
  } finally { release(); promises.readdir = read; srv.server.off('request', onRequest); }
});

test('workspace listing is paginated and reads metadata only for the requested directory and page', async () => {
  const workspace = path.join(root, '_workspace');
  fs.mkdirSync(path.join(workspace, 'aa-folder', 'nested'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'aa-folder', 'nested', 'secret.txt'), 'must not be read while listing');
  for (let i = 0; i < 8; i++) fs.writeFileSync(path.join(workspace, `b${i}.txt`), `contents-${i}`);
  fs.writeFileSync(path.join(workspace, '.hidden'), 'not listed');
  const promises = fs.promises, open = promises.opendir, stat = promises.stat, readFile = promises.readFile;
  const reads = [], stats = [], fileReads = [];
  promises.opendir = async function(dir, options) { reads.push(String(dir)); return open.call(this, dir, options); };
  promises.stat = async function(file, options) { stats.push(String(file)); return stat.call(this, file, options); };
  promises.readFile = async function(file, options) { if (String(file).startsWith(workspace + path.sep)) fileReads.push(String(file)); return readFile.call(this, file, options); };
  try {
    let result = await list('_workspace', '&limit=3');
    assert.equal(result.status, 200);
    assert.equal(result.data.path, '_workspace');
    assert.equal(result.data.entries.length, 3); assert.ok(result.data.nextCursor);
    assert.deepEqual(result.data.entries.map(item => item.name), ['aa-folder', 'deep', 'b0.txt']);
    assert.equal(result.data.entries[0].children, undefined);
    assert.equal(result.data.entries[2].size, 10);
    assert.equal(result.data.entries[2].text, true);
    assert.deepEqual(reads, [workspace]);
    assert.deepEqual(stats, [path.join(workspace, 'b0.txt')]);
    assert.deepEqual(fileReads, []);
    // Add an entry before the cursor: keyset pagination must neither repeat nor skip following entries.
    fs.mkdirSync(path.join(workspace, 'ab-new'));
    const names = [...result.data.entries.map(entry => entry.name)];
    while (result.data.nextCursor) {
      result = await list('_workspace', '&limit=3&cursor=' + encodeURIComponent(result.data.nextCursor));
      assert.equal(result.status, 200);
      names.push(...result.data.entries.map(entry => entry.name));
    }
    assert.deepEqual(names, ['aa-folder', 'deep', ...Array.from({length: 8}, (_, i) => `b${i}.txt`)]);
    const nested = await list('_workspace/aa-folder', '&limit=10');
    assert.deepEqual(nested.data.entries.map(entry => entry.path), ['_workspace/aa-folder/nested']);
  } finally { promises.opendir = open; promises.stat = stat; promises.readFile = readFile; }
});

test('pagination accepts a valid cursor for a deeply nested workspace path', async () => {
  const relative = '_workspace/' + Array.from({ length: 10 }, () => 'x'.repeat(180)).join('/');
  const dir = path.join(root, ...relative.split('/'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a'); fs.writeFileSync(path.join(dir, 'b.txt'), 'b');
  const first = await list(relative, '&limit=1');
  assert.equal(first.status, 200); assert.ok(first.data.nextCursor.length > 2048);
  const second = await list(relative, '&limit=1&cursor=' + encodeURIComponent(first.data.nextCursor));
  assert.equal(second.status, 200); assert.equal(second.data.entries[0].name, 'b.txt');
});

test('workspace directory API enforces access, scoped paths, valid cursors and symlink boundaries', async () => {
  for (const bad of ['..', '/tmp', '_workspace/../main.tex', '_workspace/.build', '_workspace//bad', 'section']) {
    const result = await list(bad);
    assert.ok([400, 403].includes(result.status), `${bad}: ${result.status}`);
  }
  const outsider = await registerAndLogin(srv.baseUrl, 'lazyoutsider');
  assert.equal((await get('/workspace/children?path=_workspace', outsider.token)).status, 403);
  assert.equal((await api(srv.baseUrl, 'GET', `/api/projects/${pid}/workspace/children?path=_workspace`)).status, 401);
  assert.equal((await list('_workspace/missing')).status, 404);
  assert.equal((await list('_workspace', '&limit=201')).status, 400);
  assert.equal((await list('_workspace', '&cursor=invalid')).status, 400);
  fs.symlinkSync(path.join(root, 'section'), path.join(root, '_workspace', 'alias'));
  assert.equal((await list('_workspace/alias')).status, 403);
  assert.equal((await list('_workspace')).data.entries.some(node => node.name === 'alias'), false);
});

test('workspace missing root is returned as an empty listing, not an error', async () => {
  const created = await api(srv.baseUrl, 'POST', '/api/projects', { token: user.token, body: { name: 'Empty workspace' } });
  const id = created.data.project.publicId;
  const response = await api(srv.baseUrl, 'GET', `/api/projects/${id}/workspace/children?path=_workspace`, { token: user.token });
  assert.equal(response.status, 200);
  assert.deepEqual(response.data, { path: '_workspace', entries: [], nextCursor: null });
});

test('single-file reads preserve access to hidden files while rejecting reserved paths', async () => {
  fs.writeFileSync(path.join(root, '.latexmkrc'), 'custom latexmk settings');
  const hidden = await api(srv.baseUrl, 'GET', `/api/projects/${pid}/file?path=.latexmkrc`, { token: user.token, raw: true });
  assert.equal(hidden.status, 200); assert.equal(await hidden.text(), 'custom latexmk settings');
  for (const reserved of ['.build', '.versions', '.git', '.preview']) {
    const response = await get('/file?path=' + encodeURIComponent(reserved + '/secret.txt'));
    assert.equal(response.status, 403, reserved);
  }
});

test('single-file requests support byte ranges and explicit downloads without loading the whole file', async () => {
  fs.writeFileSync(path.join(root, '_workspace', 'bytes.bin'), '0123456789');
  const url = `${srv.baseUrl}/api/projects/${pid}/file?path=${encodeURIComponent('_workspace/bytes.bin')}`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${user.token}`, Range: 'bytes=4-7' } });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), 'bytes 4-7/10');
  assert.equal(response.headers.get('accept-ranges'), 'bytes');
  assert.equal(await response.text(), '4567');
  const head = await fetch(url, { method: 'HEAD', headers: { Authorization: `Bearer ${user.token}` } });
  assert.equal(head.status, 200); assert.equal(head.headers.get('content-length'), '10');
  const invalid = await fetch(url, { headers: { Authorization: `Bearer ${user.token}`, Range: 'bytes=50-60' } });
  assert.equal(invalid.status, 416);
  assert.equal(invalid.headers.get('content-range'), 'bytes */10');
  const download = await fetch(url + '&download=1', { headers: { Authorization: `Bearer ${user.token}` } });
  assert.match(download.headers.get('content-disposition'), /^attachment/);
  assert.equal(await download.text(), '0123456789');
});

test('file streams close when the client abandons a large download', async () => {
  const target = path.join(root, '_workspace', 'large.bin');
  fs.writeFileSync(target, Buffer.alloc(2 * 1024 * 1024, 1));
  const open = fs.createReadStream;
  let stream, closed;
  const streamClosed = new Promise(resolve => { closed = resolve; });
  fs.createReadStream = function(file, options) {
    const current = open.call(this, file, options);
    if (String(file) === target) {
      stream = current;
      current.once('data', () => current.pause());
      current.once('close', closed);
    }
    return current;
  };
  const controller = new AbortController();
  let timer;
  try {
    const response = await fetch(`${srv.baseUrl}/api/projects/${pid}/file?path=${encodeURIComponent('_workspace/large.bin')}`, {
      headers: { Authorization: `Bearer ${user.token}` }, signal: controller.signal,
    });
    assert.equal(response.status, 200);
    const first = await response.body.getReader().read();
    assert.ok(first.value?.length);
    controller.abort();
    await Promise.race([streamClosed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('download stream did not close')), 2500); })]);
    assert.equal(stream.destroyed, true);
    assert.equal((await get('?summary=1')).status, 200);
  } finally { clearTimeout(timer); controller.abort(); stream?.destroy(); fs.createReadStream = open; }
});

test('figure extension resolution uses LaTeX priority and validates paths', async () => {
  const dir = path.join(root, 'fig'); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'plot.png'), 'PNG');
  fs.writeFileSync(path.join(dir, 'plot.jpg'), 'JPG');
  const base = `/figure?path=${encodeURIComponent('fig/plot')}`;
  assert.equal((await get(base)).status, 404);
  let response = await api(srv.baseUrl, 'GET', `/api/projects/${pid}${base}&resolve=1`, { token: user.token, raw: true });
  assert.equal(response.status, 200); assert.equal(await response.text(), 'PNG');
  response = await api(srv.baseUrl, 'GET', `/api/projects/${pid}/figure?path=fig%2Fplot.jpg&resolve=1`, { token: user.token, raw: true });
  assert.equal(await response.text(), 'JPG');
  assert.equal((await get('/figure?path=..%2Foutside&resolve=1')).status, 400);
  assert.equal((await get('/figure?path=.build%2Fsecret&resolve=1')).status, 403);

  // Verify PDF takes priority using a controlled fake converter and no network.
  const fakeBin = path.join(srv.dataDir, 'fake-fig-bin'); fs.mkdirSync(fakeBin);
  fs.writeFileSync(path.join(fakeBin, 'pdftoppm'), '#!/usr/bin/env node\nrequire("fs").writeFileSync(process.argv.at(-1)+".png", "PDF-PRIORITY")\n', { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'plot.pdf'), '%PDF-fake');
  const previousPath = process.env.PATH;
  process.env.PATH = fakeBin + path.delimiter + previousPath;
  try {
    response = await api(srv.baseUrl, 'GET', `/api/projects/${pid}${base}&resolve=1`, { token: user.token, raw: true });
    assert.equal(response.status, 200); assert.equal(await response.text(), 'PDF-PRIORITY');
  } finally { process.env.PATH = previousPath; }
});
