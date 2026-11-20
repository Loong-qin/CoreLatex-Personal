// API 客户端：fetch 封装 + SSE 流读取
const TOKEN_KEY = 'corelatex_token';
const SSE_IDLE_TIMEOUT_MS = 60_000;

export function getToken() {
  return localStorage.getItem(TOKEN_KEY) || '';
}
export function setToken(t) {
  if (t) localStorage.setItem(TOKEN_KEY, t);
  else localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// 后端错误体约定为 {error: string}，但个别路径可能给出对象；统一取可读文案
function errorText(err) {
  if (!err) return '';
  if (typeof err === 'string') return err;
  return err.message || err.error || JSON.stringify(err);
}

async function request(method, path, { body, form, raw, cache, signal } = {}) {
  const headers = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (form) {
    payload = form;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(path, { method, headers, body: payload, ...(cache ? { cache } : {}), ...(signal ? { signal } : {}) });
  if (res.status === 401 && !path.startsWith('/api/auth/')) {
    setToken('');
    if (location.pathname !== '/login') location.href = '/login';
    throw new ApiError(401, '未登录');
  }
  if (raw) {
    if (!res.ok) {
      let msg = `请求失败 (${res.status})`;
      try { msg = errorText((await res.json()).error) || msg; } catch {}
      throw new ApiError(res.status, msg);
    }
    return res;
  }
  const data = await res.json().catch((error) => {
    if (signal?.aborted) throw error;
    return {};
  });
  if (!res.ok) throw new ApiError(res.status, errorText(data.error) || `请求失败 (${res.status})`);
  return data;
}

export const api = {
  get: (p, opts) => request('GET', p, opts),
  head: (p, opts) => request('HEAD', p, { ...opts, raw: true }),
  post: (p, body, opts) => request('POST', p, { ...opts, body }),
  put: (p, body) => request('PUT', p, { body }),
  patch: (p, body, opts) => request('PATCH', p, { ...opts, body }),
  del: (p) => request('DELETE', p),
  postForm: (p, form) => request('POST', p, { form }),
  raw: (p, opts) => request('GET', p, { ...opts, raw: true }),
};

/**
 * SSE POST：读取 `data: {json}\n\n` 事件流，逐事件回调 onEvent。
 * 返回 Promise，流结束 resolve。
 */
async function readSseResponse(res, onEvent, onActivity) {
  if (!res.ok || !res.body) {
    let msg = `请求失败 (${res.status})`;
    try { msg = errorText((await res.json()).error) || msg; } catch {}
    throw new ApiError(res.status, msg);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const dispatch = (chunk) => {
    const data = chunk.split('\n').filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart()).join('\n');
    if (!data) return;
    let ev;
    try { ev = JSON.parse(data); } catch { return; }
    onEvent(ev);
  };
  let idleTimer;
  let timedOut = false;
  try {
    for (;;) {
      // Server heartbeats also deliver bytes. Missing them closes only this
      // observer so the agent can replay from the last received event.
      idleTimer = setTimeout(() => {
        timedOut = true;
        void reader.cancel().catch(() => {});
      }, SSE_IDLE_TIMEOUT_MS);
      const { done, value } = await reader.read();
      clearTimeout(idleTimer);
      if (timedOut) throw new Error('等待智能体事件超时');
      if (!done) onActivity?.();
      buf += done ? decoder.decode() : decoder.decode(value, { stream: true });
      buf = buf.replace(/\r\n/g, '\n');
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        dispatch(buf.slice(0, idx));
        buf = buf.slice(idx + 2);
      }
      if (done) { if (buf.trim()) dispatch(buf); break; }
    }
  } finally { clearTimeout(idleTimer); reader.releaseLock(); }
}

export async function ssePost(path, body, onEvent, { signal } = {}) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
    body: JSON.stringify(body ?? {}), signal,
  });
  return readSseResponse(res, onEvent);
}

/** Reconnect only to a run's event log; never repeat the mutating chat POST. */
export async function sseGet(path, onEvent, { signal, onActivity } = {}) {
  const res = await fetch(path, { headers: { Authorization: `Bearer ${getToken()}` }, signal, cache: 'no-store' });
  return readSseResponse(res, onEvent, onActivity);
}

export function fmtBytes(n) {
  if (n == null || n < 0) return '不限';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function fmtSeconds(s) {
  if (s == null || s < 0) return '不限';
  s = Math.round(s);
  if (s < 60) return `${s} 秒`;
  if (s < 3600) return `${Math.floor(s / 60)} 分钟`;
  return `${(s / 3600).toFixed(1)} 小时`;
}

export function timeAgo(iso) {
  if (!iso) return '';
  const t = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
  const diff = Date.now() - t.getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return t.toLocaleDateString('zh-CN');
}
