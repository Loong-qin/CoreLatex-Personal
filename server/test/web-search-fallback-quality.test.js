import { test } from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns';

let importId = 0;
const query = 'WaNet backdoor attack default poisoning rate 10% training samples';
const escaped = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const bing = (title = 'WaNet -- Imperceptible Warping-based Backdoor Attack', echo = query) => `<input id="sb_form_q" name="q" value="${escaped(echo)}"><li class="b_algo"><h2><a href="https://arxiv.org/abs/2102.10369">${title}</a></h2><p>Original paper</p></li>`;
const ddg = (title = 'WaNet original paper') => `<a class="result__a" href="https://arxiv.org/abs/2102.10369">${title}</a><a class="result__snippet" href="https://arxiv.org/abs/2102.10369">Warping backdoor attack</a>`;

async function setup(t, handler, { stalledDns = false } = {}) {
  const previous = process.env.CORELATEX_SEARXNG_URL;
  delete process.env.CORELATEX_SEARXNG_URL;
  t.after(() => previous === undefined ? delete process.env.CORELATEX_SEARXNG_URL : process.env.CORELATEX_SEARXNG_URL = previous);
  const lookup = dns.lookup;
  dns.lookup = (_host, ...args) => { if (!stalledDns) queueMicrotask(() => args.at(-1)(null, '8.8.8.8', 4)); };
  let service;
  try { service = await import(`../src/services/webService.js?quality=${++importId}`); }
  finally { dns.lookup = lookup; }
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const url = new URL(input); calls.push({ url, options });
    return handler(url, options, calls.length);
  });
  return { ...service, calls };
}
const html = body => new Response(body, { headers: { 'Content-Type': 'text/html' } });

test('Bing unrelated results use an independent provider with the identical original query and diagnostic trail', async t => {
  const { webSearch, calls } = await setup(t, url => html(url.hostname === 'www.bing.com' ? bing('免费小游戏') : ddg()));
  const result = await webSearch(query);
  assert.equal(result.engine, 'duckduckgo'); assert.equal(result.fallbackReason, 'bing_irrelevant_results');
  assert.equal(result.query, query); assert.equal(result.effectiveQuery, query);
  assert.deepEqual(calls.map(call => call.url.searchParams.get('q')), [query, query]);
  assert.ok(result.attempts.some(attempt => attempt.engine === 'bing' && attempt.discardedCount === 1));
  assert.equal(result.results.length, 1);
});

test('a provider query mismatch is rejected even if its result contains matching keywords', async t => {
  const { webSearch } = await setup(t, url => html(url.hostname === 'www.bing.com' ? bing(undefined, 'different query') : ddg()));
  const result = await webSearch(query);
  assert.equal(result.engine, 'duckduckgo'); assert.equal(result.fallbackReason, 'bing_query_mismatch');
});

test('all irrelevant providers fail honestly and are not cached as successful results', async t => {
  let repaired = false;
  const { webSearch, calls } = await setup(t, url => html(repaired ? bing() : url.hostname === 'www.bing.com' ? bing('小游戏') : ddg('无关中文结果')));
  await assert.rejects(webSearch(query), error => error.searchReason === 'search_no_relevant_results' && error.searchDiagnostics.attempts.length === 3);
  repaired = true;
  const result = await webSearch(query);
  assert.equal(result.engine, 'bing'); assert.equal(calls.length, 3);
});

test('public provider DNS stalls are bounded and never start a late HTTP request', async t => {
  const { webSearch, calls } = await setup(t, () => { throw new Error('HTTP must not start'); }, { stalledDns: true });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const result = webSearch(query).catch(error => error);
  t.mock.timers.tick(5_000);
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(5_000);
  const error = await result;
  assert.equal(error.searchReason, 'search_no_relevant_results');
  assert.match(error.message, /Bing：请求超时/); assert.match(error.message, /DuckDuckGo：请求超时/);
  assert.deepEqual(error.searchDiagnostics.attempts.slice(1).map(attempt => attempt.reason), ['bing_timeout', 'duckduckgo_timeout']);
  assert.equal(calls.length, 0);
});

test('user cancellation during public DNS lookup stops immediately without another provider', async t => {
  const { webSearch, calls } = await setup(t, () => { throw new Error('HTTP must not start'); }, { stalledDns: true });
  const controller = new AbortController();
  const result = webSearch(query, { signal: controller.signal });
  controller.abort();
  await assert.rejects(result, { name: 'AbortError' }); assert.equal(calls.length, 0);
});
