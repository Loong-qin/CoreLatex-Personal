import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'corelatex-mirrors-test-'));
process.env.CORELATEX_DATA_DIR = root;
let db, resetDb, getTexMirrorConfig, saveTexMirrorConfig, texRepositories, verifyTexRepository;
before(async () => {
  ({ getDb: db, resetDb } = await import('../src/db.js'));
  ({ getTexMirrorConfig, saveTexMirrorConfig, texRepositories, verifyTexRepository } = await import('../src/services/texMirrors.js'));
});
after(() => { resetDb(); fs.rmSync(root, { recursive: true, force: true }); });

test('default mirrors prioritize Chinese current and historic repositories and include 2022', () => {
  const defaults = getTexMirrorConfig();
  assert.match(defaults.current[0], /tsinghua/);
  assert.match(defaults.historic[0], /nju/);
  assert.match(texRepositories('2022')[0], /2022\/tlnet-final$/);
  assert.ok(texRepositories('2026').includes(defaults.current[0]));
  assert.ok(texRepositories('2026').some(url => url.includes('/2026/tlnet-final')));
  assert.throws(() => texRepositories('2021'), /不支持/);
});

test('administrator configuration is persisted and rejects unsafe or ambiguous URLs', () => {
  const config = {
    current: ['  https://mirror.example.org/ctan/tlnet/  '],
    historic: ['https://mirror.example.org/tex/{year}/tlnet-final/'],
  };
  assert.deepEqual(saveTexMirrorConfig(config), {
    current: ['https://mirror.example.org/ctan/tlnet'],
    historic: ['https://mirror.example.org/tex/{year}/tlnet-final'],
  });
  resetDb();
  assert.deepEqual(getTexMirrorConfig(), {
    current: ['https://mirror.example.org/ctan/tlnet'],
    historic: ['https://mirror.example.org/tex/{year}/tlnet-final'],
  });
  assert.throws(() => saveTexMirrorConfig({current: ['http://example.org'], historic: config.historic}), /HTTPS/);
  assert.throws(() => saveTexMirrorConfig({current: ['https://user:pass@example.org'], historic: config.historic}), /凭据/);
  assert.throws(() => saveTexMirrorConfig({current: ['https://example.org?q=1'], historic: config.historic}), /查询/);
  assert.throws(() => saveTexMirrorConfig({current: config.current, historic: ['https://example.org/2022/tlnet-final']}), /year/);
  assert.throws(() => saveTexMirrorConfig({current: config.current, historic: ['https://example.org/x{year}/tlnet-final']}), /year/);
  assert.throws(() => saveTexMirrorConfig({current: ['https://example.org', 'https://example.org/'], historic: config.historic}), /重复/);
  assert.equal(texRepositories('2022')[0], 'https://mirror.example.org/tex/2022/tlnet-final');
  db().prepare('DELETE FROM system_settings WHERE key = ?').run('tex_mirrors');
});

test('mirror verification reads the actual tlpdb release, not the URL or HTML', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, init) => {
      assert.equal(url, 'https://example.org/tlpkg/texlive.tlpdb');
      assert.equal(init.headers.Range, 'bytes=0-65535');
      return new Response('name 00texlive.config\ncategory TLCore\ndepend release/2022\n\nname example\n');
    };
    assert.equal(await verifyTexRepository('2022', 'https://example.org'), 'https://example.org');
    await assert.rejects(verifyTexRepository('2024', 'https://example.org'), /版本不匹配.*2022/);
    globalThis.fetch = async () => new Response('<html>not a repository</html>');
    await assert.rejects(verifyTexRepository('2024', 'https://example.org'), /版本不匹配/);
    globalThis.fetch = async () => new Response('offline', { status: 503 });
    await assert.rejects(verifyTexRepository('2024', 'https://example.org'), /HTTP 503/);
  } finally { globalThis.fetch = originalFetch; }
});