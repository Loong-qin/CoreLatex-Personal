import { getDb } from '../db.js';
import { HttpError } from '../util.js';

export const SUPPORTED_TEX_VERSIONS = Object.freeze(['2022', '2023', '2024', '2025', '2026']);
export const DEFAULT_TEX_MIRRORS = Object.freeze({
  current: Object.freeze([
    'https://mirrors.tuna.tsinghua.edu.cn/CTAN/systems/texlive/tlnet',
    'https://mirrors.ustc.edu.cn/CTAN/systems/texlive/tlnet',
    'https://mirror.ctan.org/systems/texlive/tlnet',
  ]),
  historic: Object.freeze([
    'https://mirror.nju.edu.cn/tex-historic/systems/texlive/{year}/tlnet-final',
    'https://ftp.math.utah.edu/pub/tex/historic/systems/texlive/{year}/tlnet-final',
  ]),
});
const key = 'tex_mirrors';

function normalizeMirrors(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, '镜像配置无效');
  const result = {};
  for (const kind of ['current', 'historic']) {
    if (!Array.isArray(value[kind]) || value[kind].length < 1 || value[kind].length > 5) {
      throw new HttpError(400, '当前版和历史版镜像各需填写 1–5 个地址');
    }
    result[kind] = value[kind].map(input => {
      if (typeof input !== 'string') throw new HttpError(400, '镜像地址必须是 HTTPS URL');
      const address = input.trim().replace(/\/+$/, '');
      const placeholders = address.match(/\{year\}/g) || [];
      if (kind === 'historic' && (placeholders.length !== 1 || !/\/\{year\}(?:\/|$)/.test(address))) {
        throw new HttpError(400, '历史镜像地址需要一个独立的 {year} 路径段');
      }
      if (kind === 'current' && placeholders.length) throw new HttpError(400, '当前镜像地址不能包含 {year}');
      let url;
      try { url = new URL(address.replace('{year}', '2024')); } catch { throw new HttpError(400, '镜像地址必须是 HTTPS URL'); }
      if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash ||
          /[\s{}]/.test(address.replace('{year}', '2024'))) {
        throw new HttpError(400, '镜像地址必须使用 HTTPS，不能包含凭据、查询、片段或空格');
      }
      return address;
    });
    if (new Set(result[kind]).size !== result[kind].length) throw new HttpError(400, '镜像地址不能重复');
  }
  return result;
}

export function getTexMirrorConfig() {
  const raw = getDb().prepare('SELECT value FROM system_settings WHERE key = ?').get(key)?.value;
  if (raw) {
    try { return normalizeMirrors(JSON.parse(raw)); } catch { /* use safe defaults for invalid older settings */ }
  }
  return { current: [...DEFAULT_TEX_MIRRORS.current], historic: [...DEFAULT_TEX_MIRRORS.historic] };
}

export function saveTexMirrorConfig(config) {
  const value = normalizeMirrors(config);
  getDb().prepare('INSERT INTO system_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
  return value;
}

// Historic releases must never silently use the current-year repository. The
// current release also has a historic fallback for when the year is archived.
export function texRepositories(version) {
  if (!SUPPORTED_TEX_VERSIONS.includes(String(version))) throw new HttpError(400, '不支持的 TeX Live 版本');
  const config = getTexMirrorConfig();
  const historic = config.historic.map(url => url.replace('{year}', String(version)));
  return [...new Set(String(version) === '2026' ? [...config.current, ...historic] : historic)];
}

// The archive markers are absent from some official historic snapshots. The
// release field in the first tlpdb record is authoritative for each mirror.
export async function verifyTexRepository(version, repository, { signal } = {}) {
  if (!SUPPORTED_TEX_VERSIONS.includes(String(version))) throw new HttpError(400, '不支持的 TeX Live 版本');
  const timeout = AbortSignal.timeout(30000);
  const response = await fetch(repository + '/tlpkg/texlive.tlpdb', {
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    headers: { Range: 'bytes=0-65535' },
  });
  if (!response.ok || !response.body) throw new Error('镜像数据库读取失败（HTTP ' + response.status + '）');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '', size = 0;
  try {
    while (size < 65536) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      text += decoder.decode(part.value, { stream: true });
      if (/\r?\n\r?\n/.test(text)) break;
    }
  } finally { await reader.cancel().catch(() => {}); }
  const first = text.split(/\r?\n\r?\n/, 1)[0];
  const release = first.match(/^depend release\/(\d{4})\s*$/m)?.[1];
  if (!/^name 00texlive\.config\s*$/m.test(first) || release !== String(version)) {
    throw new Error('镜像 TeX Live 版本不匹配（期望 ' + version + '，实际 ' + (release || '未知') + '）');
  }
  return repository;
}