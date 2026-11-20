import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dns from 'node:dns';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'corelatex-font-download-test-'));
process.env.CORELATEX_DATA_DIR = path.join(temp, 'data');
let downloader, runtime, db, resetDb, executeTool, definitions, font, ctx;
const realLookup = dns.promises.lookup;
const realRequest = https.request;

// This mock still exercises the socket lookup callback: it captures the actual
// pinned public address that the downloader passes to node:https.
function network({ addresses = [{ address: '1.1.1.1', family: 4 }], pages = {} } = {}) {
  const calls = [], pins = [];
  return {
    calls, pins,
    lookup: async () => addresses,
    request(url, options, callback) {
      calls.push(url.href);
      const req = new EventEmitter();
      req.end = () => queueMicrotask(() => {
        options.lookup(url.hostname, { all: true }, (error, values) => {
          if (error) return req.emit('error', error);
          pins.push(values);
          const item = pages[url.href] || { status: 404 };
          const response = item.response || Readable.from(item.chunks || []);
          response.statusCode = item.status ?? 200;
          response.headers = item.headers || {};
          callback(response);
        });
      });
      return req;
    },
  };
}

before(async () => {
  downloader = await import('../src/services/fontDownloads.js');
  runtime = await import('../src/services/runtimeEnvironment.js');
  const { getDb, resetDb: reset } = await import('../src/db.js');
  db = getDb(); resetDb = reset;
  ({ executeTool, getToolDefinitions: definitions } = await import('../src/services/agent/tools.js'));
  const { runProcess } = await import('../src/services/process.js');
  const found = await runProcess('fc-match', ['--format', '%{file}', 'sans']);
  assert.equal(found.exitCode, 0);
  font = fs.readFileSync(found.stdout.trim());
  const createUser = db.prepare("INSERT INTO users(username,password_hash,role) VALUES(?,'x','user')");
  const owner = createUser.run('font-agent-owner').lastInsertRowid;
  const editor = createUser.run('font-agent-editor').lastInsertRowid;
  const projectId = db.prepare("INSERT INTO projects(name,owner_id,public_id) VALUES('font-agent',?,'font-agent')").run(owner).lastInsertRowid;
  db.prepare("INSERT INTO project_members(project_id,user_id,role) VALUES(?,?,'editor')").run(projectId, editor);
  ctx = { user: { id: editor, role: 'user' }, project: db.prepare('SELECT * FROM projects WHERE id=?').get(projectId) };
});
after(() => {
  dns.promises.lookup = realLookup; https.request = realRequest; resetDb?.();
  assert.ok(temp.startsWith(path.join(os.tmpdir(), 'corelatex-font-download-test-')));
  fs.rmSync(temp, { recursive: true, force: true });
});

test('download validates every address and pins DNS at the socket including redirects', async () => {
  const url = 'https://font.example/test.ttf', redirect = 'https://cdn.example/font.otf';
  const mock = network({ pages: {
    [url]: { status: 302, headers: { location: redirect } },
    [redirect]: { chunks: [font] },
  } });
  const file = await downloader.downloadFontFile(url, { _network: mock });
  assert.deepEqual(file.buffer, font);
  assert.equal(file.sha256, createHash('sha256').update(font).digest('hex'));
  assert.deepEqual(mock.calls, [url, redirect]);
  assert.deepEqual(mock.pins, [[{ address: '1.1.1.1', family: 4 }], [{ address: '1.1.1.1', family: 4 }]]);

  const mixed = network({ addresses: [{ address: '1.1.1.1', family: 4 }, { address: '10.0.0.1', family: 4 }] });
  await assert.rejects(downloader.downloadFontFile(url, { _network: mixed }), /内网|保留/);
  assert.equal(mixed.calls.length, 0);
  const toLocal = network({ pages: { [url]: { status: 302, headers: { location: 'https://127.0.0.1/secret' } } } });
  await assert.rejects(downloader.downloadFontFile(url, { _network: toLocal }), /内网|保留/);
  assert.equal(toLocal.calls.length, 1);
  for (const input of ['https://localhost/font.ttf', 'https://10.0.0.1/font.ttf', 'https://[::1]/font.ttf',
    'https://u:p@example.com/font.ttf', 'http://example.com/font.ttf', 'https://example.com:8080/font.ttf']) {
    await assert.rejects(downloader.downloadFontFile(input, { _network: mock }), /地址|HTTPS|内网|保留/);
  }
  for (const address of ['127.0.0.1', '100.64.0.1', '169.254.169.254', '192.168.1.1', '::1', 'fc00::1', '::ffff:127.0.0.1', '2001:db8::1']) {
    assert.equal(downloader.isPublicFontAddress(address), false, address);
  }
  assert.equal(downloader.isPublicFontAddress('1.1.1.1'), true);
  assert.equal(downloader.isPublicFontAddress('2606:4700:4700::1111'), true);
});

test('CTAN font downloads use configured mirror roots with fallback and report the actual source', async () => {
  const { getTexMirrorConfig, saveTexMirrorConfig } = await import('../src/services/texMirrors.js');
  const previous = getTexMirrorConfig();
  const original = 'https://mirrors.ctan.org/fonts/fandol/test.otf';
  const first = 'https://one.example/CTAN/fonts/fandol/test.otf';
  const second = 'https://two.example/myctan/fonts/fandol/test.otf';
  try {
    saveTexMirrorConfig({ ...previous, current: [
      'https://one.example/CTAN/systems/texlive/tlnet',
      'https://two.example/myctan/systems/texlive/tlnet',
    ] });
    const mock = network({ pages: { [first]: { status: 503 }, [second]: { chunks: [font] } } });
    const file = await downloader.downloadFontFile(original, { _network: mock });
    assert.deepEqual(mock.calls, [first, second]);
    assert.equal(file.requestedUrl, original);
    assert.equal(file.sourceUrl, second);
    assert.equal(file.sha256, createHash('sha256').update(font).digest('hex'));
    const other = 'https://example.com/font.otf?secret=not-logged';
    assert.deepEqual(downloader.fontDownloadCandidates(other), [other]);
    const direct = await downloader.downloadFontFile(other, { _network: network({ pages: { [other]: { chunks: [font] } } }) });
    assert.equal(direct.requestedUrl, 'https://example.com/font.otf');
    assert.equal(direct.sourceUrl, 'https://example.com/font.otf');
  } finally { saveTexMirrorConfig(previous); }
});

test('download rejects oversize, invalid formats, wrong hashes and obeys cancellation during DNS', async () => {
  const url = 'https://font.example/file';
  await assert.rejects(downloader.downloadFontFile(url, { _network: network({ pages: { [url]: { status: 200, headers: { 'content-length': String(31 * 1024 * 1024) } } } }) }), /30 MB/);
  await assert.rejects(downloader.downloadFontFile(url, { _network: network({ pages: { [url]: { chunks: [Buffer.alloc(31 * 1024 * 1024)] } } }) }), /30 MB/);
  await assert.rejects(downloader.downloadFontFile(url, { _network: network({ pages: { [url]: { chunks: [Buffer.from('not actually a font')] } } }) }), /不是有效/);
  await assert.rejects(downloader.downloadFontFile(url, { sha256: '0'.repeat(64), _network: network({ pages: { [url]: { chunks: [font] } } }) }), /SHA-256/);
  const controller = new AbortController();
  const pending = downloader.downloadFontFile(url, { signal: controller.signal, _network: { lookup: () => new Promise(() => {}), request: () => { throw new Error('must not request'); } } });
  controller.abort(new Error('download cancelled'));
  await assert.rejects(pending, /download cancelled/);
});

test('an ordinary project editor can install fonts from HTTPS and the workspace', async () => {
  const definition = definitions().find(item => item.function.name === 'install_font');
  assert.ok(definition.function.parameters.properties.url);
  const url = 'https://font.example/font.ttf';
  const mock = network({ pages: { [url]: { chunks: [font] } } });
  try {
    dns.promises.lookup = mock.lookup; https.request = mock.request;
    const before = runtime.getRuntimeResourceRevision();
    const result = await executeTool('install_font', { url }, ctx);
    assert.equal(result.error, undefined, result.error);
    assert.equal(result.changed, true);
    assert.notEqual(runtime.getRuntimeResourceRevision(), before);
    assert.equal(result.sha256, createHash('sha256').update(font).digest('hex'));
    assert.equal(result.requestedUrl, url);
    assert.equal(result.sourceUrl, url);
    assert.ok(result.fonts.some(item => item.managed && fs.existsSync(item.file)));
    const again = await executeTool('install_font', { url }, ctx);
    assert.equal(again.changed, false);
    assert.match((await executeTool('install_font', { path: 'a.ttf', url }, ctx)).error, /恰好/);
    const workspace = path.join(process.env.CORELATEX_DATA_DIR, 'projects', String(ctx.project.id), '_workspace');
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, 'local.ttf'), Buffer.concat([font, Buffer.alloc(4, 42)]));
    const local = await executeTool('install_font', { path: '_workspace/local.ttf' }, ctx);
    assert.equal(local.error, undefined, local.error);
    assert.equal(local.changed, true);
  } finally {
    dns.promises.lookup = realLookup; https.request = realRequest;
  }
});

test('font download requires an active editor and cannot commit after access is revoked', async () => {
  const url = 'https://font.example/font.ttf';
  const bytes = Buffer.concat([font, Buffer.alloc(4, 43)]);
  const mock = network({ pages: { [url]: { chunks: [bytes] } } });
  const membership = db.prepare('UPDATE project_members SET role=? WHERE project_id=? AND user_id=?');
  try {
    dns.promises.lookup = mock.lookup; https.request = mock.request;
    membership.run('viewer', ctx.project.id, ctx.user.id);
    assert.match((await executeTool('install_font', { url }, ctx)).error, /只读成员/);
    membership.run('editor', ctx.project.id, ctx.user.id);
    db.prepare("UPDATE users SET status='disabled' WHERE id=?").run(ctx.user.id);
    assert.match((await executeTool('install_font', { url }, ctx)).error, /账号已被禁用/);
    assert.equal(mock.calls.length, 0, 'permission denial must occur before network access');
    db.prepare("UPDATE users SET status='active' WHERE id=?").run(ctx.user.id);
    const response = Readable.from((async function* () {
      yield bytes.subarray(0, 20);
      membership.run('viewer', ctx.project.id, ctx.user.id);
      yield bytes.subarray(20);
    })());
    https.request = network({ pages: { [url]: { response } } }).request;
    const revision = runtime.getRuntimeResourceRevision();
    assert.match((await executeTool('install_font', { url }, ctx)).error, /只读成员/);
    assert.equal(runtime.getRuntimeResourceRevision(), revision);
  } finally {
    membership.run('editor', ctx.project.id, ctx.user.id);
    db.prepare("UPDATE users SET status='active' WHERE id=?").run(ctx.user.id);
    dns.promises.lookup = realLookup; https.request = realRequest;
  }
});
