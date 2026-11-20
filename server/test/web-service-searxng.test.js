import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import dns from 'node:dns';

let importId = 0;
const originalFetch = globalThis.fetch;
const bingHtml = '<li class="b_algo"><h2><a href="https://example.org/bing">Bing result</a></h2><p>Fallback snippet</p></li>';
const resultBody = (title = 'Search result', query = '') => JSON.stringify({ results: [
  { title, url: 'https://example.org/source', content: 'Source excerpt ' + query },
  { title: 'Second source', url: 'https://example.org/second', content: 'Second excerpt ' + query },
] });
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

async function setup(t, handle = (req, res) => res.end(resultBody('Search result', new URL(req.url, 'http://fixture').searchParams.get('q')))) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(new URL(req.url, 'http://localhost'));
    res.setHeader('Content-Type', 'application/json');
    handle(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const previousEndpoint = process.env.CORELATEX_SEARXNG_URL;
  process.env.CORELATEX_SEARXNG_URL = `${base}/searx`;
  t.after(() => {
    if (previousEndpoint === undefined) delete process.env.CORELATEX_SEARXNG_URL;
    else process.env.CORELATEX_SEARXNG_URL = previousEndpoint;
  });

  // Keep the real SSRF implementation; only public Bing DNS/HTTP are fixtures.
  // Local SearXNG requests exercise the actual fetch implementation and HTTP server.
  const originalLookup = dns.lookup;
  dns.lookup = function (hostname, ...args) {
    if (hostname !== 'www.bing.com') return originalLookup.call(this, hostname, ...args);
    const callback = args.at(-1);
    queueMicrotask(() => callback(null, '8.8.8.8', 4));
  };
  let service;
  try { service = await import(`../src/services/webService.js?searxng-test=${++importId}`); }
  finally { dns.lookup = originalLookup; }
  const fallbackRequests = [];
  t.mock.method(globalThis, 'fetch', (input, options) => {
    const url = new URL(String(input));
    if (url.hostname === 'www.bing.com') {
      fallbackRequests.push(url);
      return Promise.resolve(new Response(bingHtml.replace('Fallback snippet', String(url.searchParams.get('q')).replace(/&/g, '&amp;').replace(/</g, '&lt;') + ' fallback snippet'), { headers: { 'Content-Type': 'text/html' } }));
    }
    assert.equal(url.origin, base, 'test must never contact an external or different backend');
    return originalFetch(input, options);
  });
  return { ...service, base, requests, fallbackRequests };
}

test('configured private SearXNG is usable while query text cannot change its origin, base path or format', async (t) => {
  const { webSearch, requests, fallbackRequests } = await setup(t);
  const query = '../admin?format=html&language=xx# https://other.example/admin';
  const answer = await webSearch(query, { maxResults: 1 });
  assert.equal(answer.engine, 'searxng');
  assert.equal(answer.results.length, 1);
  assert.equal(answer.fallbackReason, undefined);
  assert.equal(fallbackRequests.length, 0);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].pathname, '/searx/search');
  assert.deepEqual([...requests[0].searchParams], [['q', query], ['format', 'json'], ['language', 'en']]);
});

test('SearXNG never follows a redirect to another local path', async (t) => {
  const { webSearch, requests, fallbackRequests } = await setup(t, (_req, res) => {
    res.writeHead(302, { Location: '/admin?token=secret-value' });
    res.end();
  });
  const answer = await webSearch('redirect');
  assert.equal(answer.engine, 'bing');
  assert.equal(answer.fallbackReason, 'searxng_redirect_blocked');
  assert.deepEqual(requests.map((r) => r.pathname), ['/searx/search']);
  assert.equal(fallbackRequests.length, 1);
  assert.ok(!JSON.stringify(answer).includes('secret-value'));
});

test('invalid configured credentials, protocols, query and ambiguous path fail closed before backend HTTP', async (t) => {
  const { webSearch, base, requests } = await setup(t);
  for (const endpoint of [
    base.replace('http://', 'http://user:private-secret@'),
    `${base}/searx?url=/admin`, `${base}/searx#admin`,
    `${base}/searx/%2e%2e/admin`, `${base}/searx/../admin`, `${base}/searx%2fadmin`, 'file:///etc/passwd',
  ]) {
    process.env.CORELATEX_SEARXNG_URL = endpoint;
    const answer = await webSearch('invalid endpoint');
    assert.equal(answer.engine, 'bing');
    assert.equal(answer.fallbackReason, 'searxng_invalid_endpoint');
    assert.ok(!JSON.stringify(answer).includes('private-secret'));
  }
  assert.equal(requests.length, 0);
});

test('trusted search exception never permits model web_fetch to reach loopback or private hosts', async (t) => {
  const { webSearch, fetchPageText, base, requests } = await setup(t);
  assert.equal((await webSearch('trusted backend')).engine, 'searxng');
  for (const url of [`${base}/admin`, 'http://localhost/admin', 'http://172.18.0.3/admin', 'http://10.0.0.1/']) {
    await assert.rejects(fetchPageText(url), /禁止访问内网/);
  }
  assert.equal(requests.length, 1);
});

test('cancellation closes a live request without Bing fallback or caching its result', async (t) => {
  const entered = deferred();
  const { webSearch, requests, fallbackRequests } = await setup(t, (_req, res) => {
    if (requests.length === 1) entered.resolve();
    else res.end(resultBody('Fresh response', 'cancel then retry'));
  });
  const controller = new AbortController();
  const pending = webSearch('cancel then retry', { signal: controller.signal });
  await entered.promise;
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(fallbackRequests.length, 0);
  assert.equal((await webSearch('cancel then retry')).results[0].title, 'Fresh response');
  assert.equal(requests.length, 2);
});

test('SearXNG deadline also bounds a body that never finishes', async (t) => {
  const entered = deferred();
  const { webSearch, fallbackRequests } = await setup(t, (_req, res) => {
    res.write('{"results":[');
    entered.resolve();
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = webSearch('stalled body');
  await entered.promise;
  t.mock.timers.tick(10_000);
  const answer = await pending;
  assert.equal(answer.engine, 'bing');
  assert.equal(answer.fallbackReason, 'searxng_timeout');
  assert.equal(fallbackRequests.length, 1);
});

test('over 2 MiB is rejected both with Content-Length and with a streamed response', async (t) => {
  const { webSearch, requests } = await setup(t, (_req, res) => {
    if (requests.length === 1) {
      res.setHeader('Content-Length', String(2 * 1024 * 1024 + 1));
      res.end(' '.repeat(2 * 1024 * 1024 + 1));
    } else if (requests.length === 2) {
      res.write(' '.repeat(1024 * 1024));
      res.end(' '.repeat(1024 * 1024 + 1));
    } else res.end(resultBody('Search result', 'exactly at limit').padEnd(2 * 1024 * 1024));
  });
  for (const query of ['oversized declared', 'oversized chunked']) {
    const answer = await webSearch(query);
    assert.equal(answer.engine, 'bing');
    assert.equal(answer.fallbackReason, 'searxng_response_too_large');
  }
  assert.equal((await webSearch('exactly at limit')).engine, 'searxng');
});

test('cache isolates copies and language/limit/backend keys, honors abort and expires completed results', async (t) => {
  const { webSearch, base, requests } = await setup(t);
  const first = await webSearch('图编排');
  first.results[0].title = 'modified by caller';
  const cached = await webSearch('图编排');
  assert.equal(cached.results[0].title, 'Search result');
  assert.notEqual(first.results, cached.results);
  const aborted = AbortSignal.abort();
  await assert.rejects(webSearch('图编排', { signal: aborted }), { name: 'AbortError' });
  assert.equal(requests.length, 1);
  await webSearch('图编排', { language: 'en' });
  await webSearch('paper search');
  await webSearch('paper search', { language: 'zh-CN', maxResults: 1 });
  await webSearch('paper search', { language: 'zh-CN', maxResults: 2 });
  assert.deepEqual(requests.map((r) => r.searchParams.get('language')), ['zh-CN', 'en', 'en', 'zh-CN', 'zh-CN']);
  process.env.CORELATEX_SEARXNG_URL = `${base}/other-prefix`;
  await webSearch('图编排');
  assert.equal(requests.at(-1).pathname, '/other-prefix/search');
  const now = Date.now();
  t.mock.method(Date, 'now', () => now + 30_001);
  await webSearch('图编排');
  assert.equal(requests.length, 7);
});

test('concurrent same-query callers do not share cancellation of a live request', async (t) => {
  const firstEntered = deferred();
  const entered = deferred();
  let responseToKeep;
  const { webSearch, requests, fallbackRequests } = await setup(t, (_req, res) => {
    if (requests.length === 1) firstEntered.resolve();
    if (requests.length === 2) { responseToKeep = res; entered.resolve(); }
  });
  const controller = new AbortController();
  const cancelled = webSearch('concurrent', { signal: controller.signal });
  await firstEntered.promise;
  const surviving = webSearch('concurrent');
  await entered.promise;
  controller.abort();
  await assert.rejects(cancelled, { name: 'AbortError' });
  responseToKeep.end(resultBody('Surviving request', 'concurrent'));
  assert.equal((await surviving).results[0].title, 'Surviving request');
  assert.equal(fallbackRequests.length, 0);
  assert.equal(requests.length, 2);
});

test('fallback reports actual Bing provider and bounded reasons for missing, HTTP, empty and malformed backends', async (t) => {
  const { webSearch, base, fallbackRequests } = await setup(t, (req, res) => {
    const query = new URL(req.url, base).searchParams.get('q');
    if (query === 'http failure') { res.statusCode = 503; res.end('secret internal error'); }
    else if (query === 'empty') res.end('{"results":[]}');
    else res.end('{invalid-private-details');
  });
  delete process.env.CORELATEX_SEARXNG_URL;
  assert.equal((await webSearch('not configured')).fallbackReason, 'searxng_not_configured');
  process.env.CORELATEX_SEARXNG_URL = base;
  for (const [query, reason] of [['http failure', 'searxng_http_503'], ['empty', 'searxng_no_results'], ['invalid', 'searxng_invalid_response']]) {
    const answer = await webSearch(query);
    assert.equal(answer.engine, 'bing');
    assert.equal(answer.fallbackReason, reason);
    assert.equal(answer.results[0].title, 'Bing result');
    assert.ok(!JSON.stringify(answer).includes('private-details'));
  }
  assert.equal(fallbackRequests.length, 4);
  assert.equal(fallbackRequests[0].searchParams.get('setmkt'), 'en-US');
});
