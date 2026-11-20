import dns from 'node:dns';
import net from 'node:net';
import https from 'node:https';
import { createHash } from 'node:crypto';
import { HttpError } from '../util.js';
import { getTexMirrorConfig } from './texMirrors.js';

const MAX_FONT_BYTES = 30 * 1024 * 1024;
const MAX_REDIRECTS = 4;
const blockedV4 = new net.BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blockedV4.addSubnet(address, prefix, 'ipv4');
const globalV6 = new net.BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
const blockedV6 = new net.BlockList();
for (const [address, prefix] of [['2001:db8::', 32], ['2001::', 23], ['2002::', 16]]) {
  blockedV6.addSubnet(address, prefix, 'ipv6');
}

// Restrict downloads to routable addresses, including embedded IPv4 forms.
// The result is also pinned to the actual socket lookup, preventing rebinding.
export function isPublicFontAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return !blockedV4.check(address, 'ipv4');
  if (family !== 6) return false;
  const canonical = new URL('http://[' + address + ']').hostname.slice(1, -1);
  const mapped = canonical.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mapped) {
    const a = parseInt(mapped[1], 16), b = parseInt(mapped[2], 16);
    return isPublicFontAddress([a >> 8, a & 255, b >> 8, b & 255].join('.'));
  }
  return globalV6.check(address, 'ipv6') && !blockedV6.check(address, 'ipv6');
}

function fontUrl(raw) {
  let url;
  try { url = new URL(String(raw || '')); } catch { throw new HttpError(400, '字体下载地址无效'); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || (url.port && url.port !== '443')) {
    throw new HttpError(400, '字体下载仅支持不带凭据的标准 HTTPS 地址');
  }
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || /\.(?:localhost|local|internal)$/.test(host)) {
    throw new HttpError(400, '字体下载不允许访问内网地址');
  }
  url.hash = '';
  return url;
}

function abortable(promise, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || new DOMException('下载已取消', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

async function resolveFontHost(url, lookup, signal) {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const family = net.isIP(host);
  const addresses = family ? [{ address: host, family }] : await abortable(
    lookup(host, { all: true, verbatim: true }), signal,
  ).catch(error => {
    signal.throwIfAborted();
    throw new HttpError(400, '字体下载域名解析失败');
  });
  if (!Array.isArray(addresses) || !addresses.length || addresses.some(item =>
    !item || net.isIP(item.address) !== item.family || !isPublicFontAddress(item.address))) {
    throw new HttpError(400, '字体下载不允许访问内网或保留地址');
  }
  return addresses;
}

async function getResponse(url, addresses, request, signal) {
  return new Promise((resolve, reject) => {
    const pinnedLookup = (_hostname, options, callback) => {
      if (options?.all) callback(null, addresses);
      else callback(null, addresses[0].address, addresses[0].family);
    };
    const req = request(url, { lookup: pinnedLookup, signal, agent: false, headers: {
      'User-Agent': 'CoreLatex/1.0 font downloader', Accept: 'font/*,application/octet-stream;q=0.9,*/*;q=0.1',
      'Accept-Encoding': 'identity',
    } }, resolve);
    req.on('error', reject);
    req.end();
  });
}

// Configured TeX mirrors whose path is the standard CTAN tlnet root can also
// serve the equivalent CTAN fonts tree. Never rewrite other vendors' URLs.
// Each generated address is still subject to the same per-hop SSRF guard.
export function fontDownloadCandidates(rawUrl) {
  const source = fontUrl(rawUrl);
  const current = getTexMirrorConfig().current;
  const roots = current.map(value => {
    try {
      const base = new URL(value);
      if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash ||
          !base.pathname.endsWith('/systems/texlive/tlnet')) return null;
      base.pathname = base.pathname.slice(0, -'/systems/texlive/tlnet'.length).replace(/\/+$/, '');
      return base.href.replace(/\/+$/, '');
    } catch { return null; }
  }).filter(Boolean);
  let suffix = '';
  if (!source.search) {
    const standardHosts = new Set(['ctan.org', 'www.ctan.org', 'mirrors.ctan.org', 'mirror.ctan.org', 'tug.ctan.org']);
    if (standardHosts.has(source.hostname.toLowerCase())) {
      const match = source.pathname.match(/^\/(?:tex-archive\/)?fonts\/(.+)$/);
      if (match) suffix = '/fonts/' + match[1];
    }
    if (!suffix) {
      const root = roots.find(value => source.href.startsWith(value + '/fonts/'));
      if (root) suffix = source.href.slice(root.length);
    }
  }
  return [...new Set([...(suffix ? roots.map(root => root + suffix) : []), source.href])];
}
function displayUrl(url) {
  const clean = new URL(url);
  clean.search = ''; clean.hash = '';
  return clean.href;
}

async function downloadFrom(initial, { lookup, request, signal, sha256 }) {
  let current = initial;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    signal.throwIfAborted();
    const url = fontUrl(current);
    const addresses = await resolveFontHost(url, lookup, signal);
    const response = await getResponse(url, addresses, request, signal);
    if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
      const location = response.headers.location;
      response.resume();
      if (!location) throw new HttpError(422, '字体下载重定向缺少目标');
      if (hop === MAX_REDIRECTS) throw new HttpError(422, '字体下载重定向次数过多');
      current = new URL(location, url).href;
      continue;
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      response.resume();
      throw new HttpError(422, '字体下载失败：HTTP ' + response.statusCode);
    }
    if (Number(response.headers['content-length']) > MAX_FONT_BYTES) {
      response.destroy();
      throw new HttpError(400, '字体文件超过 30 MB 限制');
    }
    let total = 0;
    const chunks = [];
    for await (const chunk of response) {
      signal.throwIfAborted();
      total += chunk.length;
      if (total > MAX_FONT_BYTES) {
        response.destroy();
        throw new HttpError(400, '字体文件超过 30 MB 限制');
      }
      chunks.push(Buffer.from(chunk));
    }
    signal.throwIfAborted();
    const buffer = Buffer.concat(chunks, total);
    const signature = buffer.subarray(0, 4).toString('hex');
    const extension = ({ '00010000': '.ttf', '74727565': '.ttf', '4f54544f': '.otf', '74746366': '.ttc' })[signature];
    if (buffer.length < 12 || !extension) throw new HttpError(400, '下载内容不是有效的 TTF、OTF 或 TTC 字体文件');
    const digest = createHash('sha256').update(buffer).digest('hex');
    if (sha256 && digest !== sha256.toLowerCase()) throw new HttpError(422, '下载字体的 SHA-256 不匹配');
    return { originalname: 'downloaded' + extension, buffer, sha256: digest, sourceUrl: displayUrl(url) };
  }
}

// A total deadline covers DNS, redirects and the entire response body. A
// bounded per-mirror deadline leaves time to try remaining configured mirrors.
export async function downloadFontFile(rawUrl, { signal, sha256, _network } = {}) {
  if (sha256 && !/^[0-9a-f]{64}$/i.test(sha256)) throw new HttpError(400, '字体 SHA-256 格式无效');
  const requested = fontUrl(rawUrl), candidates = fontDownloadCandidates(requested.href);
  const deadline = AbortSignal.timeout(120000);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const lookup = _network?.lookup || dns.promises.lookup.bind(dns.promises);
  const request = _network?.request || https.request.bind(https);
  const failures = [];
  for (const candidate of candidates) {
    const perMirror = AbortSignal.timeout(45000);
    try {
      const file = await downloadFrom(candidate, { lookup, request, sha256, signal: AbortSignal.any([combined, perMirror]) });
      return { ...file, requestedUrl: displayUrl(requested) };
    } catch (error) {
      signal?.throwIfAborted();
      if (deadline.aborted) throw new HttpError(408, '字体下载超时');
      failures.push(perMirror.aborted ? new Error('镜像连接或下载超时') : error);
    }
  }
  if (failures.length === 1) throw failures[0];
  throw new HttpError(422, '字体下载失败，所有配置镜像均不可用：' + failures.map(error => String(error.message || error)).join('；').slice(-1200));
}
