// 工具调用的「操作对象」摘要与脱敏参数：纯函数，供 agentLoop 与测试使用
import { sanitizeToolText } from './toolDisplay.js';
const DIGEST_MAX = 80;
const INPUT_STRING_MAX = 200;

// 步骤行的摘要：优先取路径类字段，其次命令首行；复制类工具给「来源 → 目标」
export function toolDigest(name, input) {
  const i = input || {};
  if (name === 'install_tex_packages') return clampDigest(Array.isArray(input?.packages) ? input.packages.join('、') : '');
  if (name === 'inspect_runtime_resources') return '字体与 TeX 版本';
  if (name === 'run_parallel_edits') {
    return Array.isArray(i.tasks) ? `${i.tasks.length} 个编辑任务` : '按范围并行编辑';
  }
  if (name === 'compile_and_preview') {
    return i.pages ? `页 ${i.pages}` : '全文档';
  }
  if (name === 'copy_to_project') {
    const from = i.workspacePath || '';
    const to = i.targetPath || '';
    return clampDigest(from && to ? `${from} → ${to}` : from || to);
  }
  for (const k of ['path', 'targetPath', 'workspacePath', 'file', 'name', 'query', 'url']) {
    if (typeof i[k] === 'string' && i[k].trim()) return clampDigest(i[k].trim());
  }
  if (typeof i.command === 'string' && i.command.trim()) {
    return clampDigest(i.command.trim().split('\n')[0]);
  }
  return '';
}

function clampDigest(s) {
  const t = sanitizeToolText(s);
  return t.length > DIGEST_MAX ? `${t.slice(0, DIGEST_MAX)}…` : t;
}

// 事件里只带摘要所需的小字段，避免把整份文件内容塞进 SSE
export function safeToolInput(input) {
  if (!input || typeof input !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (/(?:api[_-]?key|token|authorization|password|passwd|secret|credential|cookie|imageBase64)/i.test(k)) {
      out[k] = '[已隐藏]';
    } else if (typeof v === 'string' && v.length > INPUT_STRING_MAX) {
      out[k] = `…（省略 ${v.length} 字符）`;
    } else if (typeof v === 'object' && v !== null) {
      out[k] = Array.isArray(v) ? `…（${v.length} 项）` : '…';
    } else {
      out[k] = typeof v === 'string' ? sanitizeToolText(v, INPUT_STRING_MAX) : v;
    }
  }
  return out;
}
