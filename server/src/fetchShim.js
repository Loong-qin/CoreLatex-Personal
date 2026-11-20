import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';

/**
 * fetch 端口兜底:Node 的 fetch(undici) 拒绝访问「受限端口」(6665-6668 等 IRC 保留段,
 * 报错 cause: bad port)——自建模型网关恰好可能跑在这些端口上(如 llama.cpp 的 6667),
 * 而模型调用必须用 fetch。此垫片在原生 fetch 因受限端口失败时,降级用 http.request
 * 完成同一请求;其余请求原样走原生 fetch。
 */

const nativeFetch = globalThis.fetch;

function httpFetch(url, init = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const headers = { ...(init.headers || {}) };
    if (init.body != null && !headers['Content-Type'] && !headers['content-type']) {
      headers['Content-Type'] = 'application/json';
    }
    const req = mod.request(u, { method: init.method || 'GET', headers }, (res) => {
      const response = new Response(Readable.toWeb(res), {
        status: res.statusCode,
        statusText: res.statusMessage,
        headers: res.headers,
      });
      resolve(response);
    });
    req.on('error', reject);
    if (init.body != null) req.write(init.body);
    req.end();
  });
}

export function installFetchShim() {
  globalThis.fetch = async (url, init) => {
    try {
      return await nativeFetch(url, init);
    } catch (err) {
      const cause = String(err?.cause?.message || err?.cause?.code || '').toLowerCase();
      if (cause.includes('bad port')) return httpFetch(String(url), init);
      throw err;
    }
  };
}
