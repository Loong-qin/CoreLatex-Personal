import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorkflowGraph } from '../src/services/agent/workflowGraph.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'corelatex-search-quality-'));
const previousDataDir = process.env.CORELATEX_DATA_DIR;
process.env.CORELATEX_DATA_DIR = dataDir;
const query = 'WaNet backdoor attack default poisoning rate 10% training samples';
const unrelated = Array.from({ length: 8 }, (_, index) => ({
  title: `Unrelated holiday shopping ${index + 1}`,
  url: `https://unrelated.example/offers/${index + 1}`,
  snippet: 'Get 10% off sample products and sports training. Default rates apply.',
}));
const relevant = (name = 'WaNet') => ({
  title: `${name} backdoor attack: poisoning training samples`,
  url: `https://source.example/${name.toLowerCase()}`,
  snippet: `${name} backdoor attack poisoning rate and training samples are described in this method. Read the original source to verify the specific claim.`,
});
const textOf = result => result.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const bingHtml = rows => rows.map(row => `<li class="b_algo"><h2><a href="${xml(row.url)}">${xml(row.title)}</a></h2><p>${xml(row.snippet)}</p></li>`).join('');
const duckHtml = rows => rows.map(row => `<div class="result results_links results_links_deep web-result"><div class="result__body"><h2 class="result__title"><a class="result__a" href="${xml(row.url)}">${xml(row.title)}</a></h2><a class="result__snippet">${xml(row.snippet)}</a></div></div>`).join('');
let getPiTools, fixtureId = 0;

before(async () => {
  // webService captures the lookup function during import. Keep its actual
  // public-address guard, with deterministic DNS and HTTP rather than live web.
  const originalLookup = dns.lookup;
  dns.lookup = (hostname, ...args) => {
    const callback = args.at(-1);
    const allowed = ['www.bing.com', 'bing.com', 'html.duckduckgo.com', 'lite.duckduckgo.com', 'duckduckgo.com', 'source.example'];
    queueMicrotask(() => allowed.includes(hostname) ? callback(null, '8.8.8.8', 4) : callback(new Error(`Unexpected test DNS: ${hostname}`)));
  };
  try { ({ getPiTools } = await import('../src/services/agent/tools.js')); }
  finally { dns.lookup = originalLookup; }
});
after(() => {
  if (previousDataDir === undefined) delete process.env.CORELATEX_DATA_DIR;
  else process.env.CORELATEX_DATA_DIR = previousDataDir;
  assert.equal(path.dirname(dataDir), os.tmpdir());
  assert.ok(path.basename(dataDir).startsWith('corelatex-search-quality-'));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function setup(t, providers = {}) {
  const previousEndpoint = process.env.CORELATEX_SEARXNG_URL;
  process.env.CORELATEX_SEARXNG_URL = `https://search-fixture.example/case-${++fixtureId}`;
  t.after(() => {
    if (previousEndpoint === undefined) delete process.env.CORELATEX_SEARXNG_URL;
    else process.env.CORELATEX_SEARXNG_URL = previousEndpoint;
  });
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (input, options = {}) => {
    const url = new URL(String(input));
    if (url.hostname === 'source.example') return new Response('<html><title>WaNet original source</title><body><article>WaNet backdoor attack source body describes its poisoning rate and experiment setup.</article></body></html>', { headers: { 'Content-Type': 'text/html' } });
    const engine = url.hostname === 'search-fixture.example' ? 'searxng'
      : ['www.bing.com', 'bing.com'].includes(url.hostname) ? 'bing'
        : url.hostname.endsWith('duckduckgo.com') ? 'duckduckgo' : null;
    assert.ok(engine, `unexpected network target ${url.hostname}`);
    const originalQuery = url.searchParams.get('q') || new URLSearchParams(String(options.body || '')).get('q');
    requests.push({ engine, query: originalQuery, url });
    const value = typeof providers[engine] === 'function' ? providers[engine](originalQuery) : providers[engine];
    if (typeof value === 'number') return new Response('synthetic backend unavailable', { status: value });
    const rows = Array.isArray(value) ? value : value?.rows || [relevant(), ...unrelated];
    if (engine === 'searxng') return new Response(JSON.stringify({ ...(value?.query ? { query: value.query } : {}), results: rows.map(row => ({ ...row, content: row.snippet })) }), { headers: { 'Content-Type': 'application/json' } });
    const body = engine === 'bing' ? bingHtml(rows) : duckHtml(rows);
    return new Response(body, { headers: { 'Content-Type': 'text/html' } });
  });
  const ctx = { agentConfig: { allowWebAccess: true }, toolDisplays: new Map() };
  const tools = getPiTools(ctx);
  const run = (id, name, args) => tools.find(tool => tool.name === name).execute(id, args);
  return { ctx, requests, run };
}

test('unrelated provider results fail as a tool error without displaying eight successful sources', async t => {
  const { ctx, requests, run } = setup(t, { searxng: unrelated, bing: unrelated, duckduckgo: unrelated });
  let failure;
  await assert.rejects(run('irrelevant', 'web_search', { query }), error => {
    failure = error; return /相关|匹配/.test(error.message);
  });
  const display = ctx.toolDisplays.get('irrelevant');
  assert.equal(display.summary, '执行失败'); assert.match(display.notice, /相关|匹配/);
  assert.equal(display.items, undefined); assert.doesNotMatch(display.notice, /Unrelated holiday/);
  assert.ok(display.fields.some(field => field.label === '搜索词' && field.value === query));
  assert.ok(display.fields.some(field => field.label === '来源' && /bing/.test(field.value)));
  assert.ok(requests.some(request => request.engine === 'bing'));
  assert.ok(requests.every(request => request.query === query), 'fallback must not silently broaden or replace the user query');
  const workflow = createWorkflowGraph(); workflow.plan({ scenario: 'research', summary: '核对论文原始证据' });
  workflow.toolStart('web_search'); workflow.toolEnd('web_search', { succeeded: false, input: { query }, error: failure.message });
  assert.equal(workflow.snapshot().nodes.find(node => node.id === 'research').status, 'failed');
  assert.equal(workflow.prepareCompletion().ready, false);
});

test('filtered candidates share the same model and display result and still require the original source body', async t => {
  const { run } = setup(t);
  const result = await run('mixed', 'web_search', { query });
  const text = textOf(result), display = result.details.display;
  assert.equal(display.items.length, 1); assert.equal(display.items[0].label, relevant().title);
  assert.match(display.summary, /1 条候选结果/); assert.match(display.notice, /已过滤 \d+ 条/);
  assert.ok(text.includes(display.notice)); assert.ok(text.includes(display.items[0].label)); assert.ok(text.includes(display.items[0].url));
  assert.doesNotMatch(text, /Unrelated holiday/); assert.match(text, /候选线索/); assert.match(text, /web_fetch/);
  const workflow = createWorkflowGraph(); workflow.plan({ scenario: 'research', summary: '核对论文原始证据' });
  workflow.toolStart('web_search'); workflow.toolEnd('web_search', { succeeded: true, input: { query }, resultText: text });
  assert.equal(workflow.snapshot().nodes.find(node => node.id === 'research').status, 'running');
  assert.equal(workflow.prepareCompletion().ready, false, 'keyword-filtered snippets are not verified source evidence');
  const source = await run('body', 'web_fetch', { url: relevant().url });
  workflow.toolStart('web_fetch'); workflow.toolEnd('web_fetch', { succeeded: true, input: { url: relevant().url }, resultText: textOf(source) });
  assert.equal(workflow.prepareCompletion().ready, true);
});

for (const [label, backend, notice] of [
  ['backend failure', 503, /之前的搜索来源暂不可用.*Bing/],
  ['query mismatch', { query: 'a different query', rows: [relevant()] }, /不同检索词.*Bing/],
  ['irrelevant results', unrelated, /未返回与查询匹配的条目.*Bing/],
]) test(label + ' exposes the actual fallback provider and reason in model text and notice', async t => {
  const { requests, run } = setup(t, { searxng: backend, bing: [relevant(), ...unrelated] });
  const result = await run('fallback', 'web_search', { query });
  assert.ok(result.details.display.fields.some(field => field.label === '来源' && field.value === 'bing'));
  assert.match(result.details.display.notice, notice);
  assert.ok(textOf(result).includes(result.details.display.notice));
  assert.equal(result.details.display.items.length, 1);
  assert.deepEqual([...new Set(requests.map(request => request.engine))], ['searxng', 'bing']);
  assert.ok(requests.every(request => request.query === query));
});

test('query-specific tool displays and cached search copies cannot overwrite another invocation', async t => {
  const { requests, run } = setup(t, { searxng: value => [relevant(value.includes('BadNets') ? 'BadNets' : 'WaNet')] });
  const otherQuery = query.replace('WaNet', 'BadNets');
  const [first, other] = await Promise.all([
    run('first', 'web_search', { query }), run('other', 'web_search', { query: otherQuery }),
  ]);
  assert.equal(first.details.display.items[0].label, relevant().title);
  assert.equal(other.details.display.items[0].label, relevant('BadNets').title);
  assert.ok(first.details.display.fields.some(field => field.label === '搜索词' && field.value === query));
  assert.ok(other.details.display.fields.some(field => field.label === '搜索词' && field.value === otherQuery));
  first.details.display.items[0].label = 'Caller modified its rendered copy';
  const repeated = await run('repeated', 'web_search', { query });
  assert.equal(repeated.details.display.items[0].label, relevant().title);
  assert.equal(requests.length, 2, 'same-query completed search may be cached but a different query remains separate');
  assert.doesNotMatch(textOf(repeated), /Caller modified|BadNets/);
});
