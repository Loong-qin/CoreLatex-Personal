import { toolLabel, toolKind } from './toolMetadata.js';

// The presentation layer never renders tool payloads directly: history can contain
// credentials, image bytes, truncated JSON, or provider-specific result shapes.
const KINDS = new Set(['compile', 'image', 'read', 'edit', 'files', 'search', 'web', 'command', 'skill', 'context', 'question', 'progress', 'generic']);
const SECRET = /^(?:authorization|proxy.authorization|cookie|set.cookie|password|passwd|(?:client[_-]?)?secret|credentials?|(?:api|access|refresh|auth)[_-]?(?:key|token)|token)$/i;
const IMAGE_KEY = /^(?:imageBase64|base64|image_data|dataUrl)$/i;

export function sanitizeToolText(value, limit = 24000) {
  return String(value ?? '')
    .replace(/("type"\s*:\s*"image"[^{}]*?"data"\s*:\s*")(?:[^"\\]|\\.)*(?:"|$)/gi, '$1[图像数据已隐藏]"')
    .replace(/(["']?(?:imageBase64|base64|image_data|dataUrl)["']?\s*:\s*)(?:"(?:[^"\\]|\\.)*(?:"|$)|'[^']*(?:'|$)|[^,}\s]+)/gi, '$1"[图像数据已隐藏]"')
    .replace(/data:image\/[^;\s]+;base64,[a-z\d+/=\r\n]*/gi, '[图像数据已隐藏]')
    .replace(/(["']?(?:authorization|proxy.authorization|cookie|set.cookie|password|passwd|(?:client[_-]?)?secret|credentials?|(?:api|access|refresh|auth)[_-]?(?:key|token)|token)["']?\s*[:=]\s*)(?:"(?:[^"\\]|\\.)*(?:"|$)|'[^']*(?:'|$)|[^\s,}&]+)/gi, '$1[已隐藏]')
    .replace(/\bBearer\s+[a-z\d._~+/=-]+/gi, 'Bearer [已隐藏]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[已隐藏]@')
    .slice(0, limit);
}

export function safeToolLink(value) {
  try {
    const url = new URL(String(value || ''));
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return '';
    for (const key of [...url.searchParams.keys()]) if (SECRET.test(key)) url.searchParams.delete(key);
    return url.href;
  } catch { return ''; }
}

export function safeArtifactUrl(value) {
  const url = String(value || '');
  return /^\/api\/projects\/[a-z\d_-]+\/agent\/artifacts\/[a-z\d_.-]+$/i.test(url) ? url : '';
}

function object(value) {
  if (value && typeof value === 'object') return value;
  try { const v = JSON.parse(String(value)); return v && typeof v === 'object' ? v : null; } catch { return null; }
}

export function technicalToolText(value) {
  function clean(v, depth = 0) {
    if (depth > 8) return '[深层内容已省略]';
    if (typeof v === 'string') return sanitizeToolText(v);
    if (Array.isArray(v)) return v.slice(0, 100).map(x => clean(x, depth + 1));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).slice(0, 100).map(([k, x]) => [k, SECRET.test(k) ? '[已隐藏]' : IMAGE_KEY.test(k) || (v.type === 'image' && k === 'data') ? '[图像数据已隐藏]' : clean(x, depth + 1)]));
    return v;
  }
  const parsed = object(value);
  if (parsed) return sanitizeToolText(JSON.stringify(clean(parsed), null, 2));
  return sanitizeToolText(value);
}

const text = (v, max) => typeof v === 'string' || typeof v === 'number' ? sanitizeToolText(v, max) : '';
function normalize(display, fallbackKind) {
  return {
    version: 1, kind: KINDS.has(display.kind) ? display.kind : fallbackKind,
    outcome: ['staged', 'applied', 'no-change', 'restored'].includes(display.outcome) ? display.outcome : '',
    startLine: Number.isSafeInteger(display.startLine) && display.startLine > 0 ? display.startLine : undefined,
    title: text(display.title, 160), summary: text(display.summary, 500),
    fields: (Array.isArray(display.fields) ? display.fields : []).slice(0, 20).map(f => ({ label: text(f?.label, 100), value: SECRET.test(f?.label || '') ? '[已隐藏]' : text(f?.value, 1200) })).filter(f => f.label && f.value),
    text: text(display.text), language: text(display.language, 32),
    ...(display.before != null ? { before: text(display.before) } : {}),
    ...(display.after != null ? { after: text(display.after) } : {}),
    items: (Array.isArray(display.items) ? display.items : []).slice(0, 100).map(i => ({ label: text(i?.label, 300), detail: text(i?.detail, 1600), path: text(i?.path, 600), url: safeToolLink(i?.url) })).filter(i => i.label || i.path),
    images: (Array.isArray(display.images) ? display.images : []).slice(0, 20).map((i, index) => ({ id: text(i?.id, 160) || String(index), url: safeArtifactUrl(i?.url), label: text(i?.label, 160) || `图像 ${index + 1}`, ...(Number.isFinite(i?.page) ? { page: i.page } : {}), mimeType: text(i?.mimeType, 64) })),
    notice: text(display.notice, 1600), truncated: display.truncated === true,
  };
}

// Old records have no artifact reference. Their bytes are deliberately not
// reconstructed from potentially cut-off logs and never replaced with live files.
export function toolPresentation({ name = '', input, result, display, state = 'ok' } = {}) {
  const kind = toolKind(name);
  if (display?.version === 1) {
    const shown = normalize(display, kind);
    // Stored titles may predate localization or come from an external provider.
    // The tool identity is stable; its current Chinese label is authoritative.
    if (name) shown.title = sanitizeToolText(toolLabel(name), 500);
    const structured = shown.kind === 'generic' && object(shown.text);
    if (structured) {
      const readable = toolPresentation({ name, input, result: structured, state });
      shown.text = readable.text;
      shown.fields.push(...readable.fields);
      if (!shown.items.length) shown.items = readable.items;
      if (!shown.text && !shown.items.length && !readable.fields.length) shown.notice ||= '工具返回了结构化内容，可在技术详情中核对。';
    }
    return shown;
  }
  const data = object(result);
  const args = object(input) || {};
  const fields = [];
  const add = (label, value) => { if (text(value)) fields.push({ label, value: text(value, 1200) }); };
  const path = data?.path || args.path || args.file || args.targetPath || args.workspacePath;
  add('文件', path);
  if (args.startLine || data?.startLine) add('行范围', `${args.startLine || data.startLine}${args.endLine || data?.endLine ? `–${args.endLine || data.endLine}` : ' 起'}`);
  const d = { version: 1, kind, fields, text: '', items: [], images: [] };
  if (state === 'running') { d.summary = '工具正在执行，完成后将在这里显示实际结果。'; return normalize(d, kind); }
  if (state === 'cancelled') { d.summary = '操作已取消'; d.notice = '此次操作没有完整返回结果。'; }
  let resultText = typeof result === 'string' ? sanitizeToolText(result) : '';
  if (data) {
    d.text = text(data.text || data.content || data.stdout || data.message || data.error);
    if (Array.isArray(data.content)) d.text = data.content.filter(x => x?.type === 'text').map(x => text(x.text)).join('\n\n');
    const items = Array.isArray(data) ? data : data.results || data.files || data.entries || data.items || [];
    if (Array.isArray(items)) d.items = items.filter(i => i != null).map(i => typeof i !== 'object' ? { label: String(i), path: kind === 'files' ? String(i) : undefined } : ({ label: i.title || i.name || i.path || i.url || '结果', detail: i.snippet || i.description || i.summary, path: i.path, url: i.url || i.link }));
    if (kind === 'command') {
      add('命令', args.command || args.script || data.command); add('退出码', data.exitCode);
      if (data.stderr) d.text += `\n\n标准错误输出\n${text(data.stderr)}`;
    }
    if (kind === 'edit') {
      d.summary = data.changed === false ? '未产生文件修改' : data.staged === true ? '执行时已暂存文件修改' : data.applied === true ? '执行时已写入工作区' : '历史记录未保存可核对的修改状态';
      if (state !== 'error' && typeof data.before === 'string' && typeof data.after === 'string') { d.before = data.before; d.after = data.after; }
      else if (state !== 'error') d.notice = '此历史记录未保存修改前后内容。';
    }
    if (!d.text && !d.items.length && kind === 'generic') {
      for (const [key, value] of Object.entries(data).slice(0, 16)) if (!SECRET.test(key) && !IMAGE_KEY.test(key) && !(data.type === 'image' && key === 'data') && ['string', 'number', 'boolean'].includes(typeof value)) add(key, String(value));
      if (data.type === 'image') d.notice = '此历史记录未保存可预览的图像快照。';
    }
  } else if (resultText.trim().startsWith('{')) {
    const match = resultText.match(/"(?:text|content|message|error)"\s*:\s*("(?:[^"\\]|\\.)*")/);
    if (match) { try { d.text = JSON.parse(match[1]); } catch {} }
    d.notice = '此历史记录不完整；可恢复的结果显示在上方。';
  } else d.text = resultText;
  if (['compile', 'image'].includes(kind)) d.notice = '此历史记录未保存可预览的图像快照，无法还原智能体当时看到的图片。';
  if (kind === 'context') d.notice = '这是此次请求获取的文档上下文记录。';
  if (kind === 'search') add('搜索内容', args.query);
  if (kind === 'web') { const url = safeToolLink(data?.url || args.url); if (url) d.items.push({ label: data?.title || url, url }); }
  if (kind === 'skill') add('技能', args.name || args.skill);
  if (kind === 'command' && !fields.some(f => f.label === '命令')) add('命令', args.command || args.script);
  if (kind === 'question') { d.text ||= text(args.question); d.summary ||= '智能体请求补充信息'; }
  if (state === 'error') { d.summary = '工具执行失败'; d.before = undefined; d.after = undefined; }
  if (!d.text && !d.items.length && !d.summary) d.summary = '此记录未包含可展示的结果内容。';
  return normalize(d, kind);
}
