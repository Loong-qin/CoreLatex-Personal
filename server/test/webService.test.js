// 联网服务纯逻辑单元测试：SSRF 判定 / HTML 抽取 / 跳转链接解析 / Bing 结果解析（不打网络）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { isPrivateIp, guardUrl, htmlToText, decodeRedirectHref, parseBingResults, parseDuckDuckGoResults, filterRelevantResults } from '../src/services/webService.js';

test('isPrivateIp：内网/环回/链路本地判定', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '172.16.0.1', '172.31.255.255', '169.254.1.1', '0.0.0.0', '::1', 'fe80::1', 'fd00::1', '::ffff:192.168.0.1']) {
    assert.equal(isPrivateIp(ip), true, `${ip} 应判定为内网`);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700::1111']) {
    assert.equal(isPrivateIp(ip), false, `${ip} 不应判定为内网`);
  }
});

test('htmlToText：去脚本样式标签并压缩空白', () => {
  const html = `<html><head><title>T</title><style>.a{color:red}</style></head>
    <body><script>var x = 1;</script><!-- comment -->
    <p>第一段 内容</p><div class="x">第二段</div><br><span>行内</span></body></html>`;
  const text = htmlToText(html);
  assert.ok(text.includes('第一段 内容'));
  assert.ok(text.includes('第二段'));
  assert.ok(text.includes('行内'));
  assert.ok(!text.includes('var x'));
  assert.ok(!text.includes('color:red'));
  assert.ok(!text.includes('comment'));
  assert.ok(!text.includes('<'));
});

test('decodeRedirectHref：还原跳转链接与普通链接', () => {
  const ddg = 'https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage&rut=abc';
  assert.equal(decodeRedirectHref(ddg), 'https://example.com/page');
  assert.equal(decodeRedirectHref('https://example.com/a?b=1'), 'https://example.com/a?b=1');
});

test('parseBingResults：从 Bing HTML 中解析标题/链接/摘要并去重', () => {
  const html = `<ol><li class="b_algo">
    <h2><a href="https://example.com/1" h="ID=SERP,1.1">结果 <b>一</b></a></h2>
    <div class="b_caption"><p>第一个摘要</p></div></li>
    <li class="b_algo">
    <h2><a href="https://example.com/1?from=ad" h="ID=SERP,1.2">重复链接</a></h2>
    <p>重复</p></li>
    <li class="b_algo">
    <h2><a href="https://example.com/2">结果二</a></h2><p>第二个摘要</p></li></ol>`;
  const results = parseBingResults(html, 8);
  assert.equal(results.length, 2);
  assert.equal(results[0].title, '结果 一');
  assert.equal(results[0].url, 'https://example.com/1');
  assert.equal(results[0].snippet, '第一个摘要');
  assert.equal(results[1].url, 'https://example.com/2');
});


test('search result links decode Bing base64 and HTML entities without rewriting ordinary source query parameters', () => {
  const source = 'https://arxiv.org/abs/2102.10369';
  const wrapper = 'https://www.bing.com/ck/a?x=1&amp;u=a1' + Buffer.from(source).toString('base64url');
  assert.equal(decodeRedirectHref(wrapper), source);
  assert.equal(decodeRedirectHref('https://example.org/?u=https%3A%2F%2Fother.example%2F'), 'https://example.org/?u=https%3A%2F%2Fother.example%2F');
  const parsed = parseBingResults(`<li data-x="1" class='b_algo b_top'><h2><a href='${wrapper}'>WaNet&#x2014;Warping&ensp;based</a></h2><p>Backdoor&#32;attack</p></li>`);
  assert.equal(parsed[0].url, source); assert.equal(parsed[0].title, 'WaNet—Warping based');
  assert.equal(parsed[0].snippet, 'Backdoor attack');
});

test('invalid/private/unresolved search links are omitted and meaningful URL query ids remain distinct', () => {
  const rows = ['javascript:alert(1)', 'http://127.0.0.1/admin', 'https://user:secret@example.org/',
    'https://www.bing.com/ck/a?u=invalid', 'https://example.org/paper?id=1', 'https://example.org/paper?id=2'];
  const results = parseBingResults(rows.map(url => `<li class="b_algo"><h2><a href="${url}">Document</a></h2></li>`).join(''));
  assert.deepEqual(results.map(row => row.url), ['https://example.org/paper?id=1', 'https://example.org/paper?id=2']);
});

test('relevance floor rejects unrelated results even when global HTML echoes the query and weak numeric terms match', () => {
  const query = 'WaNet backdoor attack default poisoning rate 10% training samples';
  const rows = [
    { title: '免费在线小游戏', url: 'https://example.org/games', snippet: '在线畅玩' },
    { title: 'Default training samples 10% rate', url: 'https://example.org/default', snippet: 'Generic training samples' },
    { title: 'Unrelated page', url: 'https://example.org/?q=' + encodeURIComponent(query), snippet: '' },
    { title: 'WaNet: Imperceptible Warping-based Backdoor Attack', url: 'https://arxiv.org/abs/2102.10369', snippet: 'Original paper' },
  ];
  const result = filterRelevantResults(query, rows);
  assert.equal(result.results.length, 1); assert.equal(result.quality.discardedCount, 3);
  assert.equal(result.results[0].url, 'https://arxiv.org/abs/2102.10369');
});

test('technical and Chinese searches retain actual topic matches without requiring every query word', () => {
  const rows = [
    { title: 'Biber manual', url: 'https://example.org/biber.pdf', snippet: 'The bibliography backend for biblatex' },
    { title: 'xeCJK 宏包', url: 'https://example.org/xecjk', snippet: 'LaTeX 中文字体文档' },
    { title: '中文排版指南', url: 'https://example.org/typeset', snippet: '中文字体与段落排版' },
  ];
  assert.equal(filterRelevantResults('biblatex biber backend documentation', rows).results.length, 1);
  assert.equal(filterRelevantResults('LaTeX 中文 字体 xeCJK 文档', rows).results.length, 1);
  assert.equal(filterRelevantResults('中文字体排版', rows).results.length, 2);
});

test('DuckDuckGo parses only organic titles and extracts actual destination and snippet', () => {
  const html = '<a class="header" href="https://example.org/no">WaNet query header</a>' +
    '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Farxiv.org%2Fabs%2F2102.10369&amp;rut=x">WaNet paper</a>' +
    '<a class="result__snippet" href="https://arxiv.org/abs/2102.10369">Warping&ensp;based backdoor attack</a>';
  const results = parseDuckDuckGoResults(html);
  assert.equal(results.length, 1); assert.equal(results[0].url, 'https://arxiv.org/abs/2102.10369');
  assert.equal(results[0].snippet, 'Warping based backdoor attack');
});


test('relevance admits corrections to venue premises and package pages without repeating every named term', () => {
  const paper = { title: 'WaNet -- Imperceptible Warping-based Backdoor Attack', url: 'https://arxiv.org/abs/2102.10369', snippet: 'ICLR 2021' };
  assert.equal(filterRelevantResults('CVPR 2021 WaNet backdoor attack PDF', [paper]).results.length, 1);
  const packagePage = { title: 'xeCJK package', url: 'https://ctan.org/pkg/xecjk', snippet: 'Chinese typesetting documentation' };
  assert.equal(filterRelevantResults('LaTeX 中文 字体 xeCJK 文档', [packagePage]).results.length, 1);
  assert.equal(filterRelevantResults('WaNet PDF HTML documentation', [{ title: 'PDF HTML documentation', url: 'https://example.org/doc', snippet: 'General documents' }]).results.length, 0);
});

test('number and mathematical queries can match source text literally without trusting query-string echoes', () => {
  const rows = [{ title: '2 + 2 = 4', url: 'https://example.org/math', snippet: 'Elementary arithmetic' },
    { title: 'Unrelated', url: 'https://example.org/?q=2%2B2', snippet: '' }];
  assert.equal(filterRelevantResults('2+2', rows).results.length, 1);
  assert.equal(filterRelevantResults('2024', [{ title: '2024 calendar', url: 'https://example.org/calendar', snippet: '' }]).results.length, 1);
});


test('search operators do not substitute for topic matches and short symbolic technical names are retained', () => {
  const unrelated = { title: 'Galactic rotation curves', url: 'https://arxiv.org/abs/1234', snippet: 'Astronomy and dark matter' };
  assert.equal(filterRelevantResults('site:arxiv.org 投毒比例', [unrelated]).results.length, 0);
  const compiler = { title: 'C++ compilation errors', url: 'https://gcc.gnu.org/onlinedocs/gcc/Warnings-and-Errors.html', snippet: 'Compiler error diagnostics' };
  assert.equal(filterRelevantResults('C++ 编译错误', [compiler]).results.length, 1);
});


test('canonical and expanded IPv4-mapped IPv6 retain the existing private-address boundary', async () => {
  for (const ip of ['::ffff:7f00:1', '::FFFF:C0A8:101', '0:0:0:0:0:ffff:a00:1']) assert.equal(isPrivateIp(ip), true, ip);
  assert.equal(isPrivateIp('::ffff:808:808'), false);
  for (const address of ['::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:c0a8:101']) {
    const target = `http://[${address}]/admin`;
    await assert.rejects(guardUrl(target), /禁止访问内网/);
    assert.deepEqual(parseBingResults(`<li class="b_algo"><h2><a href="${target}">Private address</a></h2></li>`), []);
  }
});


test('short technical words use word boundaries and title operators retain their topic value', () => {
  assert.equal(filterRelevantResults('AI', [{ title: 'Chair cushions', url: 'https://example.org/chairs', snippet: '' }]).results.length, 0);
  assert.equal(filterRelevantResults('AI', [{ title: 'AI research', url: 'https://example.org/research', snippet: '' }]).results.length, 1);
  assert.equal(filterRelevantResults('R', [{ title: 'The R Project for Statistical Computing', url: 'https://www.r-project.org/', snippet: '' }]).results.length, 1);
  assert.equal(filterRelevantResults('intitle:WaNet filetype:pdf', [{ title: 'WaNet -- Imperceptible Warping-based Backdoor Attack', url: 'https://arxiv.org/abs/2102.10369', snippet: '' }]).results.length, 1);
});


test('actual aggregated search responses prioritize the requested paper and technical documentation over polluted metadata', () => {
  const cases = JSON.parse(fs.readFileSync(new URL('./fixtures/search-quality-public-results.json', import.meta.url), 'utf8'));
  const [paper, bibliography, chinese] = cases.map(item => filterRelevantResults(item.query, item.results));
  assert.ok(paper.results.some(row => row.url === 'https://arxiv.org/pdf/2102.10369'));
  assert.equal(paper.results.some(row => row.title.startsWith('Under-confidence Backdoors')), false);
  assert.ok(bibliography.results.some(row => row.url.includes('/pkg/biblatex')));
  assert.equal(bibliography.results.some(row => /Metachromatic|Storks|Flagship Species|Freezing of Gait|Execution Envelopes/.test(row.title)), false);
  assert.ok(chinese.results.some(row => row.url.endsWith('/xeCJK.pdf')));
  assert.equal(chinese.results.some(row => /Rendering LaTeX in R|Reproducible Science|Compiling LATEX|KTBox/.test(row.title)), false);
  assert.ok(chinese.results.every(row => /xecjk/i.test([row.title, row.snippet, row.url].join(' '))));
});

test('a namesake network acronym plus generic attack does not satisfy the backdoor-poisoning topic', () => {
  const rows = [{ title: 'Black-hole attack detection in wireless ad hoc networks (WANET)', url: 'https://example.org/wireless', snippet: 'Routing and wireless networks' },
    { title: 'WaNet -- Imperceptible Warping-based Backdoor Attack', url: 'https://arxiv.org/abs/2102.10369', snippet: 'Backdoor attack using poisoned samples' }];
  const result = filterRelevantResults('WaNet backdoor attack default poisoning rate 10% training samples', rows);
  assert.equal(result.results.length, 1); assert.equal(result.results[0].url, 'https://arxiv.org/abs/2102.10369');
});


test('explicit arXiv identity rejects generic pages, other papers and query echoes, and ranks the primary source', () => {
  const rows = [
    { title: 'An introduction to arXiv', url: 'https://example.org/arxiv-guide', snippet: 'A general guide' },
    { title: 'arXiv 2302.101490', url: 'https://example.org/longer', snippet: '' },
    { title: 'A different arXiv paper', url: 'https://arxiv.org/abs/2302.10148', snippet: '' },
    { title: 'arXiv search', url: 'https://example.org/?q=arxiv+2302.10149', snippet: '' },
    { title: 'Paper mirror 2302.10149', url: 'https://example.org/paper/2302.10149', snippet: '' },
    { title: 'Poisoning Web-Scale Training Datasets is Practical', url: 'https://arxiv.org/abs/2302.10149', snippet: '' },
  ];
  for (const query of ['arxiv 2302.10149', '2302.10149', 'https://arxiv.org/abs/2302.10149', 'arXiv:2302.10149v2', 'doi:10.48550/arXiv.2302.10149']) {
    const result = filterRelevantResults(query, rows);
    assert.deepEqual(result.results.map(row => row.url), [rows[5].url, rows[4].url], query);
    assert.equal(result.quality.discardedCount, 4);
  }
});

test('DOI and legacy arXiv references match exact identity without requiring topic words or trusting query echoes', () => {
  const rows = [
    { title: 'Publisher article', url: 'https://example.org/10.1000%2FABC.123', snippet: '' },
    { title: 'Resolver', url: 'https://doi.org/10.1000/abc.123', snippet: '' },
    { title: 'DOI generic 10.1000', url: 'https://example.org/?doi=10.1000/abc.123', snippet: '' },
    { title: 'Different article', url: 'https://doi.org/10.1000/abc.1234', snippet: '' },
  ];
  assert.deepEqual(filterRelevantResults('find DOI:10.1000/ABC.123.', rows).results.map(row => row.url), [rows[1].url, rows[0].url]);
  const legacy = { title: 'An older paper', url: 'https://arxiv.org/pdf/hep-th/9901001v2', snippet: '' };
  assert.deepEqual(filterRelevantResults('arxiv hep-th/9901001', [legacy]).results, [legacy]);
  const parenthesized = { title: 'Publisher article', url: 'https://example.org/article', snippet: 'DOI 10.1000/abc(12)' };
  assert.deepEqual(filterRelevantResults('(doi:10.1000/ABC(12))', [parenthesized]).results, [parenthesized]);
});

test('multiple explicit paper identities retain sources for either paper without admitting generic pages', () => {
  const rows = [
    { title: 'Paper one', url: 'https://arxiv.org/abs/2302.10149', snippet: '' },
    { title: 'Paper two', url: 'https://arxiv.org/abs/2102.10369', snippet: '' },
    { title: 'arXiv comparison', url: 'https://example.org/compare', snippet: '' },
  ];
  assert.deepEqual(filterRelevantResults('compare arxiv 2302.10149 and 2102.10369', rows).results, rows.slice(0, 2));
});
