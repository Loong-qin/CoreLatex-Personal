// 本地部署的联网服务：供 CoreAgent 的 web_search / web_fetch 工具使用。
// - webSearch: 优先自建 SearXNG，有限回退 Bing / DuckDuckGo；每个来源都核对查询相关性
// - fetchPageText: 抓取网页并抽取正文文本
// 网页安全：仅 http/https、解析 DNS 后拒绝内网/环回地址（防 SSRF）、重定向每跳复核。
// 预配置 SearXNG 是独立的可信后端路径：允许私网、禁止重定向，10s/2MiB 上限。
import net from 'node:net';
import dns from 'node:dns';
import { promisify } from 'node:util';

const dnsLookup = promisify(dns.lookup);

const FETCH_TIMEOUT_MS = 15_000;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 4;
const TEXT_CAP = 20_000;
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 CoreLatexAgent/1.0';
const SEARCH_TIMEOUT_MS = 10_000;
const SEARCH_TOTAL_TIMEOUT_MS = 20_000;
const PUBLIC_SEARCH_TIMEOUT_MS = 5_000;
const SEARCH_CACHE_TTL_MS = 30_000;
const SEARCH_CACHE_MAX = 64;
const searchCache = new Map();

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

/** 内网/环回地址判定（含 IPv4 私有段、IPv6 本地段的常用形态） */
export function isPrivateIp(ip) {
  let s = String(ip || '').toLowerCase();
  // URL canonicalization turns ::ffff:127.0.0.1 into ::ffff:7f00:1.
  // Normalize expanded IPv6 too before applying the existing private-IP rule.
  if (net.isIP(s) === 6) s = new URL(`http://[${s}]`).hostname.slice(1, -1);
  if (s === '::1' || s === '::' || s.startsWith('fc') || s.startsWith('fd') || s.startsWith('fe80')) return true;
  const m = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i); // IPv4-mapped IPv6
  const hex = s.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  const high = hex ? parseInt(hex[1], 16) : 0, low = hex ? parseInt(hex[2], 16) : 0;
  const v4 = m ? m[1] : hex ? [high >> 8, high & 255, low >> 8, low & 255].join('.') : s;
  const p = v4.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  if (p[0] === 10 || p[0] === 127 || p[0] === 0) return true;
  if (p[0] === 192 && p[1] === 168) return true;
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
  if (p[0] === 169 && p[1] === 254) return true;
  return false;
}

/** SSRF 防护：校验协议与主机，解析 DNS 并拒绝内网目标。返回 URL 对象 */
export async function guardUrl(urlStr) {
  let u;
  try {
    u = new URL(String(urlStr || ''));
  } catch {
    throw new Error('URL 非法');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('仅支持 http/https 协议');
  if (u.username || u.password) throw new Error('不允许携带凭据的 URL');
  const host = u.hostname.toLowerCase();
  if (!host) throw new Error('URL 缺少主机名');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('禁止访问内网主机');
  }
  const literal = host.replace(/^\[|\]$/g, '');
  if (net.isIP(literal)) {
    if (isPrivateIp(literal)) throw new Error('禁止访问内网地址');
    return u;
  }
  const resolved = await dnsLookup(literal).catch(() => null);
  if (!resolved) throw new Error(`域名解析失败：${host}`);
  if (isPrivateIp(resolved.address)) throw new Error('禁止访问内网地址');
  return u;
}

/** 带上限地读取响应体（超过 cap 截断并取消下载） */
async function readCapped(res, cap) {
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
    if (total >= cap) {
      try { await reader.cancel(); } catch { /* 已取消 */ }
      break;
    }
  }
  return Buffer.concat(chunks).subarray(0, cap);
}

/** 受保护抓取：校验 → 请求（手动重定向，每跳复核）→ 返回 {res, body, finalUrl} */
async function guardedFetch(urlStr, { method = 'GET', headers = {}, body, signal } = {}) {
  let current = urlStr;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    signal?.throwIfAborted();
    const u = await guardUrl(current);
    signal?.throwIfAborted();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(u, {
        method,
        headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8', ...headers },
        body,
        redirect: 'manual',
        signal: signal ? AbortSignal.any([signal, ctrl.signal]) : ctrl.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      signal?.throwIfAborted();
      throw new Error(e.name === 'AbortError' ? '请求超时（15s）' : `请求失败：${e.message}`);
    }
    if (REDIRECT_CODES.has(res.status)) {
      const loc = res.headers.get('location');
      clearTimeout(timer);
      try { await res.body?.cancel(); } catch { /* 释放连接 */ }
      if (!loc) throw new Error('重定向缺少 Location');
      current = new URL(loc, u).href;
      continue;
    }
    if (!res.ok) {
      clearTimeout(timer);
      throw new Error(`HTTP ${res.status}`);
    }
    const ctype = (res.headers.get('content-type') || '').toLowerCase();
    if (ctype && !/text\/|json|xml|xhtml/i.test(ctype)) {
      clearTimeout(timer);
      throw new Error(`不支持的内容类型：${ctype}`);
    }
    const buf = await readCapped(res, MAX_BYTES).catch((e) => {
      clearTimeout(timer);
      throw new Error(`读取响应失败：${e.message}`);
    });
    clearTimeout(timer);
    return { res, body: buf, finalUrl: u.href };
  }
  throw new Error('重定向次数过多');
}

function decodeEntities(s) {
  const named = { nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ', amp: '&', lt: '<', gt: '>',
    quot: '"', apos: "'", ndash: '–', mdash: '—', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”' };
  return String(s || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code) => {
    if (code[0] !== '#') return named[code.toLowerCase()] ?? entity;
    const value = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
    return value > 0 && value < 0x110000 && !(value >= 0xd800 && value <= 0xdfff) ? String.fromCodePoint(value) : entity;
  });
}

/** HTML → 可读文本：去掉脚本/样式/注释/标签，压缩空行 */
export function htmlToText(html) {
  return decodeEntities(String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
  )
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

/** 抓取网页并抽取正文文本 */
export async function fetchPageText(urlStr, { signal } = {}) {
  const { res, body, finalUrl } = await guardedFetch(urlStr, { signal });
  const ctype = (res.headers.get('content-type') || '').toLowerCase();
  let text;
  let title = '';
  if (/json/i.test(ctype)) {
    text = body.toString('utf8');
  } else {
    const html = body.toString('utf8');
    title = decodeEntities((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').trim();
    text = htmlToText(html);
  }
  if (!text.trim()) throw new Error('页面无可提取文本');
  return {
    url: finalUrl,
    title,
    text: text.length > TEXT_CAP ? text.slice(0, TEXT_CAP) + '\n…（内容过长已截断）' : text,
  };
}

/** Decode only known search-engine wrappers, never arbitrary source URL parameters. */
export function decodeRedirectHref(href) {
  const raw = decodeEntities(href);
  try {
    const u = new URL(raw, 'https://www.bing.com');
    let target;
    if (/(^|\.)duckduckgo\.com$/i.test(u.hostname)) target = u.searchParams.get('uddg');
    else if (/(^|\.)bing\.com$/i.test(u.hostname) && u.pathname === '/ck/a') {
      target = u.searchParams.get('u');
      if (target?.startsWith('a1')) target = Buffer.from(target.slice(2), 'base64url').toString('utf8');
    }
    if (target && /^https?:\/\//i.test(target)) return target;
  } catch { /* Invalid URLs are rejected by resultUrl below. */ }
  return raw;
}

function stripTags(s) {
  return decodeEntities(String(s || '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

function attribute(tag, name) {
  const value = String(tag).match(new RegExp('\\b' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i'));
  return value ? decodeEntities(value[1] ?? value[2] ?? value[3]) : '';
}

function resultUrl(value) {
  let url;
  try { url = new URL(decodeRedirectHref(value)); } catch { return null; }
  const host = url.hostname.toLowerCase(), literal = host.replace(/^\[|\]$/g, '');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
    host === 'localhost' || /\.(localhost|local|internal)$/.test(host) || net.isIP(literal) && isPrivateIp(literal) ||
    /(^|\.)bing\.com$/.test(host) && ['/ck/a', '/search'].includes(url.pathname) ||
    /(^|\.)duckduckgo\.com$/.test(host) && ['/l/', '/html/', '/lite/'].includes(url.pathname)) return null;
  url.hash = '';
  return url;
}

function uniqueResults(rows, limit) {
  const seen = new Set(), results = [];
  for (const row of rows) {
    const url = resultUrl(row.url), title = stripTags(row.title);
    if (!url || !title) continue;
    const key = new URL(url);
    for (const name of [...key.searchParams.keys()]) if (/^(utm_|fbclid$|msclkid$|from$|ref$)/i.test(name)) key.searchParams.delete(name);
    if (seen.has(key.href)) continue;
    seen.add(key.href);
    results.push({ title, url: url.href, snippet: stripTags(row.snippet).slice(0, 500) });
    if (results.length >= limit) break;
  }
  return results;
}

/** Parse organic result blocks only; promotional/global query text is never evidence. */
export function parseBingResults(html, maxResults = 8) {
  const rows = [];
  for (const block of String(html || '').match(/<li\b[^>]*>[\s\S]*?<\/li>/gi) || []) {
    if (!attribute(block.slice(0, block.indexOf('>') + 1), 'class').split(/\s+/).includes('b_algo')) continue;
    const heading = block.match(/<h2\b[^>]*>([\s\S]*?)<\/h2>/i)?.[1];
    const link = heading?.match(/<a\b([^>]*)>([\s\S]*?)<\/a>/i);
    if (!link) continue;
    rows.push({ url: attribute(link[1], 'href'), title: link[2], snippet: block.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i)?.[1] || '' });
  }
  return uniqueResults(rows, maxResults);
}

export function parseDuckDuckGoResults(html, maxResults = 8) {
  const rows = [], links = [...String(html || '').matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)];
  for (let index = 0; index < links.length; index++) {
    const link = links[index];
    if (!attribute(link[1], 'class').split(/\s+/).includes('result__a')) continue;
    const next = links.slice(index + 1).find(item => /(?:^|\s)result__(?:a|snippet)(?:\s|$)/.test(attribute(item[1], 'class')));
    rows.push({ url: attribute(link[1], 'href'), title: link[2],
      snippet: next && attribute(next[1], 'class').split(/\s+/).includes('result__snippet') ? next[2] : '' });
  }
  return uniqueResults(rows, maxResults);
}

const WEAK_QUERY_WORDS = new Set(('the a an how what why where when who which is are was were to of in on for with and or by at as be been it this that from can does do please find search default rate samples sample training train documentation document docs official using use example examples about latest pdf html xml json http https url www doi').split(' '));
const normalized = value => decodeEntities(value).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

/** Match paper identities before loose topic terms; URL query echoes are never evidence. */
function paperIdentifiers(value) {
  const ids = new Set();
  const text = normalized(value);
  const arxivId = /^(?:\d{2}(?:0[1-9]|1[0-2])\.\d{4,5}|[a-z][a-z.-]*\/\d{7})(?:v[1-9]\d*)?$/;
  const addArxiv = id => ids.add('arxiv:' + id.replace(/v[1-9]\d*$/, ''));
  const withoutDois = text.replace(/\b10\.\d{4,9}\/[-._;()/:a-z0-9]+/g, matched => {
    let doi = matched.replace(/[.,;:]+$/, '');
    // Sentence punctuation is not part of a DOI; balanced suffix parentheses can be.
    while (doi.endsWith(')') && (doi.match(/\)/g) || []).length > (doi.match(/\(/g) || []).length) doi = doi.slice(0, -1);
    const alias = doi.match(/^10\.48550\/arxiv\.(.+)$/)?.[1];
    if (alias && arxivId.test(alias)) addArxiv(alias);
    else ids.add('doi:' + doi);
    return ' ';
  });
  for (const match of withoutDois.matchAll(/\b\d{2}(?:0[1-9]|1[0-2])\.\d{4,5}(?:v[1-9]\d*)?(?![a-z0-9])/g)) addArxiv(match[0]);
  // Legacy arXiv categories, optionally followed by their subject class.
  const legacy = /\b(?:astro-ph|cond-mat|gr-qc|hep-ex|hep-lat|hep-ph|hep-th|math-ph|nlin|nucl-ex|nucl-th|physics|quant-ph|math|cs|q-bio|q-fin|stat|econ|eess)(?:\.[a-z-]+)?\/\d{7}(?:v[1-9]\d*)?(?![a-z0-9])/g;
  for (const match of withoutDois.matchAll(legacy)) addArxiv(match[0]);
  return ids;
}

/** A relevance floor, not a claim that a result proves the query's factual premise. */
export function filterRelevantResults(query, rows, limit = 8) {
  const queryText = String(query).replace(/\b(?:site|filetype):(?:"[^"]*"|\S+)/gi, ' ').replace(/\b(?:intitle|inurl):/gi, '');
  const identities = paperIdentifiers(queryText);
  const symbolNames = queryText.match(/\b[A-Za-z](?:\+\+|#)(?![A-Za-z0-9])/g) || [];
  const originalWords = queryText.match(/[A-Za-z][A-Za-z0-9_-]*/g) || [];
  const words = [...new Set([...symbolNames, ...originalWords].map(word => word.toLowerCase()).filter(word => (word.length >= 2 || word === 'r') && !WEAK_QUERY_WORDS.has(word)))];
  const distinctNames = originalWords.filter(word => !WEAK_QUERY_WORDS.has(word.toLowerCase()) && /[A-Z][a-z]+[A-Z]|[a-z][A-Z]{2}/.test(word));
  const named = [...new Set([...symbolNames, ...(distinctNames.length ? distinctNames : originalWords.filter(word =>
    !WEAK_QUERY_WORDS.has(word.toLowerCase()) && /^[A-Z]{2,}[A-Z0-9_-]*$/.test(word)))].map(word => word.toLowerCase()))];
  const han = [...queryText.matchAll(/[\p{Script=Han}]{2,}/gu)].flatMap(match =>
    match[0].length <= 3 ? [match[0]] : Array.from({ length: match[0].length - 1 }, (_, index) => match[0].slice(index, index + 2)))
    .filter(word => !['文档', '说明', '如何', '什么', '默认', '搜索'].includes(word));
  const core = words.length ? words : [...new Set(han)];
  const has = (text, word) => /[a-z]/i.test(word) ? new RegExp('(?:^|[^a-z0-9_])' + word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=$|[^a-z0-9_])', 'i').test(text) : text.includes(word);
  const docIntent = /\b(?:documentation|docs?|manual|guide|tutorial|reference|package)\b|文档|教程|手册|指南|宏包|用法/i.test(queryText);
  const docPattern = /\b(?:documentation|docs?|manual|guide|tutorial|reference|package|api)\b|文档|教程|手册|指南|宏包|用法|配置|设置/i;
  const cleanTitle = value => String(value || '').replace(/^\s*(?:\\usepackage\s*)?\[?\s*(?:[\w-]+\s*=\s*[^,\]]+\s*,\s*)*[\w-]+\s*=\s*[^\]]+\]\s*\{?[\w-]+\}?\s*/i, '');
  // Search metadata sometimes leaks a LaTeX preamble into an unrelated paper
  // title. It is not topical evidence; retain the original title for display.
  const matchingText = value => {
    const text = normalized(value);
    return text + ' ' + text.replace(/([a-z])[-\u00ad]\s*([a-z])/g, '$1$2');
  };
  const candidates = rows.map((row, index) => {
    const url = resultUrl(row.url);
    if (!url) return null;
    let pathname; try { pathname = decodeURIComponent(url.pathname); } catch { pathname = url.pathname; }
    const title = cleanTitle(row.title), snippet = stripTags(row.snippet);
    // Query-string echoes never count as source evidence.
    const text = matchingText([title, snippet, url.hostname, pathname].join(' '));
    const titleText = matchingText(title);
    const documentScore = (docPattern.test(title) ? 4 : 0) + (docPattern.test(pathname) ? 3 : 0) + (docPattern.test(snippet) ? 1 : 0);
    const evidenceIds = paperIdentifiers([title, snippet, pathname].join(' '));
    const identityMatches = [...identities].filter(id => evidenceIds.has(id));
    const pathIds = paperIdentifiers(pathname);
    const directIdentity = identityMatches.some(id => pathIds.has(id));
    const primaryIdentity = directIdentity && (/(^|\.)arxiv\.org$/i.test(url.hostname) && identityMatches.some(id => id.startsWith('arxiv:')) ||
      /^(?:dx\.)?doi\.org$/i.test(url.hostname) && identityMatches.some(id => id.startsWith('doi:')));
    return { row, index, text, titleText, documentScore, identityMatches, directIdentity, primaryIdentity,
      matches: core.filter(word => has(text, word)).length,
      titleMatches: core.filter(word => has(titleText, word)).length,
      names: named.filter(word => has(text, word)),
      hanMatches: han.filter(word => has(text, word)).length,
      literalText: normalized([title, snippet].join(' ')).replace(/\s/g, '') };
  }).filter(Boolean);
  // A broad ecosystem name must not replace a more specific queried package.
  // Choose distinctive names using this response's coverage, not a domain or
  // query-specific allowlist. Incorrect venue terms were excluded above when
  // the query contains a distinctive mixed-case identity such as a paper name.
  const frequencies = named.map(name => [name, candidates.filter(item => item.names.includes(name)).length]);
  const minimumFrequency = Math.min(...frequencies.map(([, count]) => count).filter(count => count > 0));
  const specificNames = frequencies.filter(([, count]) => count === minimumFrequency).map(([name]) => name);
  const requiredMatches = Math.max(1, Math.min(3, Math.ceil(core.length * 0.6)));
  const literalQuery = normalized(queryText).replace(/[\s"“”']/g, '');
  const relevant = candidates.filter(item => {
    // A multi-paper query may need several sources, each identifying one requested paper.
    // Loose words such as "arxiv" cannot stand in for an explicit requested identity.
    if (identities.size) return item.identityMatches.length > 0;
    if (!core.length) return literalQuery.length >= 2 && item.literalText.includes(literalQuery);
    if (named.length && !item.names.some(name => specificNames.includes(name))) return false;
    if (docIntent && !item.documentScore) return false;
    // A specific package manual is useful even if it omits the broader platform
    // name. Otherwise require multiple topic terms, not just "backend"/"latex".
    return item.matches >= requiredMatches || docIntent && item.names.length > 0 && item.documentScore > 0;
  });
  const score = item => (item.primaryIdentity ? 1000 : 0) + (item.directIdentity ? 100 : 0) + item.identityMatches.length * 50 + item.matches * 10 + item.titleMatches * 3 + item.names.length * 6 +
    item.hanMatches * 2 + (docIntent ? item.documentScore * 3 : 0);
  relevant.sort((a, b) => score(b) - score(a) || a.index - b.index);
  return { results: relevant.slice(0, limit).map(item => item.row),
    quality: { checked: true, relevantCount: relevant.length, discardedCount: rows.length - relevant.length } };
}

function checkQueryEcho(html, query, engine) {
  const input = (String(html).match(/<input\b[^>]*>/gi) || []).find(tag => attribute(tag, 'name') === 'q' || attribute(tag, 'id') === 'sb_form_q');
  if (input && normalized(attribute(input, 'value')) !== normalized(query)) throw searchFailure(`${engine}_query_mismatch`);
}

function withSearchAbort(promise, signal) {
  if (signal.aborted) {
    promise.catch(() => {});
    return Promise.reject(signal.reason || new DOMException('Aborted', 'AbortError'));
  }
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason || new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', aborted, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}

function searchFailure(reason) {
  return Object.assign(new Error(reason), { searchReason: reason });
}

// 只有运维预配置的搜索服务可以访问私网。该路径不可供 web_fetch 或模型指定 URL 使用。
function searxngEndpoint(configuredUrl) {
  let url;
  try { url = new URL(configuredUrl); } catch { throw searchFailure('searxng_invalid_endpoint'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) {
    throw searchFailure('searxng_invalid_endpoint');
  }
  // 拒绝有歧义的路径分隔符；普通反向代理 base path 可保留。
  if (/\\|%2f|%5c|%2e/i.test(configuredUrl) || /(?:^|\/)\.\.?(?:\/|$)/.test(configuredUrl)) {
    throw searchFailure('searxng_invalid_endpoint');
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/search`;
  return url;
}

async function fetchSearxng(configuredUrl, query, language, maxResults, signal) {
  const url = searxngEndpoint(configuredUrl);
  url.search = new URLSearchParams({ q: query, format: 'json', language }).toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  let reader;
  try {
    signal?.throwIfAborted();
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
    });
    if (!res.ok) {
      await res.body?.cancel();
      throw searchFailure(`searxng_http_${res.status}`);
    }
    if (Number(res.headers.get('content-length')) > MAX_BYTES) {
      await res.body?.cancel();
      throw searchFailure('searxng_response_too_large');
    }
    reader = res.body?.getReader();
    if (!reader) throw searchFailure('searxng_invalid_response');
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BYTES) {
        await reader.cancel();
        throw searchFailure('searxng_response_too_large');
      }
      chunks.push(value);
    }
    signal?.throwIfAborted();
    let data;
    try { data = JSON.parse(Buffer.concat(chunks, size).toString('utf8')); }
    catch { throw searchFailure('searxng_invalid_response'); }
    if (!Array.isArray(data?.results)) throw searchFailure('searxng_invalid_response');
    if (typeof data.query === 'string' && normalized(data.query) !== normalized(query)) throw searchFailure('searxng_query_mismatch');
    const results = data.results.filter((row) => row && typeof row === 'object').map((row) => {
      let resultUrl;
      try { resultUrl = new URL(String(row.url || '')); } catch { return null; }
      if (!['http:', 'https:'].includes(resultUrl.protocol) || resultUrl.username || resultUrl.password) return null;
      return { title: stripTags(row.title || ''), url: resultUrl.href, snippet: stripTags(row.content || '').slice(0, 500) };
    }).filter((row) => row?.title).slice(0, 40);
    if (!results.length) throw searchFailure('searxng_no_results');
    return { engine: 'searxng', results: uniqueResults(results, 40) };
  } catch (error) {
    signal?.throwIfAborted();
    if (controller.signal.aborted) throw searchFailure('searxng_timeout');
    if (error.searchReason) throw error;
    // 不将服务端地址、网络异常正文或鉴权信息送回模型/前端。
    const redirect = /redirect/i.test(String(error.cause?.message || error.message || ''));
    throw searchFailure(redirect ? 'searxng_redirect_blocked' : 'searxng_unavailable');
  } finally {
    clearTimeout(timer);
    try { reader?.releaseLock(); } catch { /* 请求已结束 */ }
  }
}

function searchLanguage(query, language) {
  const value = String(language || 'auto').trim();
  if (!value || value === 'auto') return /\p{Script=Han}/u.test(query) ? 'zh-CN' : 'en';
  if (!/^[a-z]{2,3}(?:-[a-z]{2,4})?$/i.test(value)) throw new Error('搜索语言非法');
  return value;
}

function searchReasonText(reason) {
  if (/_query_mismatch$/.test(reason)) return '查询回显不一致';
  if (/_irrelevant_results$/.test(reason)) return '结果无关';
  if (/_no_results$/.test(reason)) return '没有有效结果';
  if (/_timeout$/.test(reason)) return '请求超时';
  if (/_http_\d{3}$/.test(reason)) return '服务返回HTTP错误';
  return ({ searxng_not_configured: '未配置', searxng_invalid_endpoint: '配置无效',
    searxng_redirect_blocked: '服务重定向被拒绝', searxng_response_too_large: '响应过大',
    searxng_invalid_response: '响应格式无效' })[reason] || '服务暂不可用';
}

function cachedSearch(key) {
  const entry = searchCache.get(key);
  if (!entry) return null;
  searchCache.delete(key);
  if (entry.expires <= Date.now()) return null;
  searchCache.set(key, entry);
  return structuredClone(entry.value);
}

function rememberSearch(key, value) {
  for (const [cacheKey, entry] of searchCache) {
    if (entry.expires <= Date.now()) searchCache.delete(cacheKey);
  }
  searchCache.delete(key);
  searchCache.set(key, { expires: Date.now() + SEARCH_CACHE_TTL_MS, value: structuredClone(value) });
  while (searchCache.size > SEARCH_CACHE_MAX) searchCache.delete(searchCache.keys().next().value);
}

/**
 * 联网搜索。优先运维预配置的 SearXNG，失败回退 Bing，并报告真实 provider 与非敏感降级原因。
 * 仅缓存完成的结果，不共享进行中的请求，避免一个调用的取消影响另一个调用。
 */
export async function webSearch(query, { maxResults = 8, language = 'auto', signal } = {}) {
  signal?.throwIfAborted();
  const q = String(query || '').trim();
  if (!q) throw new Error('搜索词不能为空');
  const limit = Math.min(20, Math.max(1, Math.floor(Number(maxResults) || 8)));
  const locale = searchLanguage(q, language);
  const searxng = String(process.env.CORELATEX_SEARXNG_URL || '').trim();
  const cacheKey = JSON.stringify([searxng, q, limit, locale]);
  const cached = cachedSearch(cacheKey);
  if (cached) return cached;
  const deadline = new AbortController(), attempts = [];
  const timer = setTimeout(() => deadline.abort(), SEARCH_TOTAL_TIMEOUT_MS);
  const searchSignal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  let fallbackReason = searxng ? '' : 'searxng_not_configured';
  const accept = (engine, rows) => {
    const checked = filterRelevantResults(q, rows, limit);
    if (!checked.results.length) {
      const error = searchFailure(rows.length ? `${engine}_irrelevant_results` : `${engine}_no_results`);
      error.searchQuality = { rawCount: rows.length, discardedCount: checked.quality.discardedCount };
      throw error;
    }
    const result = { engine, query: q, effectiveQuery: q, ...checked, attempts: [...attempts,
      { engine, reason: 'accepted', rawCount: rows.length, discardedCount: checked.quality.discardedCount }],
      ...(fallbackReason ? { fallbackReason } : {}) };
    rememberSearch(cacheKey, result);
    return result;
  };
  const failed = (engine, error) => {
    signal?.throwIfAborted();
    fallbackReason = deadline.signal.aborted ? `${engine}_timeout` : error.searchReason || `${engine}_unavailable`;
    attempts.push({ engine, reason: fallbackReason, ...(error.searchQuality || {}) });
  };
  try {
    if (searxng) {
      try {
        const result = await fetchSearxng(searxng, q, locale, 40, searchSignal);
        signal?.throwIfAborted();
        return accept('searxng', result.results);
      } catch (error) { failed('searxng', error); }
    } else attempts.push({ engine: 'searxng', reason: fallbackReason });
    const market = locale === 'en' ? 'en-US' : locale === 'zh' ? 'zh-CN' : locale;
    const providers = [
      { engine: 'bing', url: 'https://www.bing.com/search?' + new URLSearchParams({ q, setmkt: market, mkt: market,
        setlang: locale, ...(locale.startsWith('en') ? { ensearch: '1' } : {}), count: String(Math.max(10, limit)) }), parse: parseBingResults },
      { engine: 'duckduckgo', url: 'https://html.duckduckgo.com/html/?' + new URLSearchParams({ q,
        kl: locale.startsWith('zh') ? 'cn-zh' : 'us-en' }), parse: parseDuckDuckGoResults },
    ];
    for (const provider of providers) {
      if (deadline.signal.aborted) break;
      const controller = new AbortController();
      const providerTimer = setTimeout(() => controller.abort(), PUBLIC_SEARCH_TIMEOUT_MS);
      try {
        const providerSignal = AbortSignal.any([searchSignal, controller.signal]);
        const { body } = await withSearchAbort(guardedFetch(provider.url, { headers: { Accept: 'text/html', 'Accept-Language': `${locale},en;q=0.8` },
          signal: providerSignal }), providerSignal);
        signal?.throwIfAborted();
        const html = body.toString('utf8');
        checkQueryEcho(html, q, provider.engine);
        return accept(provider.engine, provider.parse(html, 40));
      } catch (error) {
        failed(provider.engine, controller.signal.aborted ? searchFailure(`${provider.engine}_timeout`) : error);
      } finally { clearTimeout(providerTimer); }
    }
    const error = searchFailure('search_no_relevant_results');
    const names = { searxng: 'SearXNG', bing: 'Bing', duckduckgo: 'DuckDuckGo' };
    const reasons = attempts.map(attempt => `${names[attempt.engine] || '搜索服务'}：${searchReasonText(attempt.reason)}`).join('；');
    error.message = `搜索未取得与查询相关的有效条目（${reasons}）。不能把本次结果作为事实依据；可调整检索词、使用明确来源链接或检查搜索服务配置。`;
    error.searchDiagnostics = { query: q, attempts };
    throw error;
  } finally { clearTimeout(timer); }
}
