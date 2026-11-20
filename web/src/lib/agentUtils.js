// CoreAgent 面板相关的纯函数工具（抽出以便单测）
import { toolPresentation, technicalToolText, sanitizeToolText } from './toolPresentation.js';
import { TOOL_METADATA, toolLabel } from './toolMetadata.js';

/** 截断上下文文本，超长时追加截断标记。 */
export function truncateContext(s, max = 12000) {
  const str = String(s ?? '');
  if (str.length <= max) return str;
  return `${str.slice(0, max)}\n…（已截断，原文共 ${str.length} 字符）`;
}

/** 结果预览长度：超过则折叠，用户可点「展开」看全文。 */
export const TOOL_TEXT_PREVIEW = 600;

/** 截断文本，超长时追加截断标记（工具参数/结果展示用）。 */
export function truncateText(s, max = TOOL_TEXT_PREVIEW) {
  const str = String(s ?? '');
  if (max <= 0 || str.length <= max) return str;
  return `${str.slice(0, max)}…（已截断，共 ${str.length} 字符）`;
}

/** 防御解析 toolCalls：可能是 JSON 字符串、数组或单个对象，统一返回数组。 */
export function parseToolCalls(raw) {
  if (raw == null || raw === '') return [];
  let v = raw;
  if (typeof raw === 'string') {
    try {
      v = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') return [v];
  return [];
}

/** 拆 `mcp__<server>__<tool>` → { server, tool }；非 MCP 工具名返回 null。 */
export function mcpToolParts(name) {
  const n = String(name ?? '');
  if (!n.startsWith('mcp__')) return null;
  const segs = n.slice(5).split('__').filter(Boolean);
  if (!segs.length) return { server: '', tool: n };
  return { server: segs.slice(0, -1).join('__'), tool: segs[segs.length - 1] };
}

/** 工具名 → 时间线步骤短语；统一中文名称，外部与未知工具保留完整标识。 */
export function toolPhrase(name) {
  const n = String(name ?? '');
  if (!n) return '已调用工具';
  const label = toolLabel(n);
  return Object.hasOwn(TOOL_METADATA, n) ? `已${label}` : `已调用${label}`;
}

// 步骤行图标：返回 Element Plus 图标组件名（文本字形在部分字体下会变豆腐块，故用 SVG 图标）
const TOOL_ICONS = {
  list_files: 'Files',
  read_file: 'Document',
  read_workspace: 'FolderOpened',
  view_image: 'View',
  write_file: 'DocumentAdd',
  edit_file: 'EditPen',
  copy_to_project: 'CopyDocument',
  run_in_workspace: 'Monitor',
  get_document_context: 'View',
  read_skill: 'Reading',
  run_skill_script: 'VideoPlay',
  compile_and_preview: 'DocumentChecked',
  web_search: 'Search',
  web_fetch: 'Link',
  prepare_env: 'Setting',
};

export function toolIcon(name) {
  const n = String(name ?? '');
  if (n.startsWith('mcp__')) return 'MagicStick';
  return TOOL_ICONS[n] || 'Operation';
}

// 参数摘要取值的字段优先级：越靠前信息量越大
const SUMMARY_KEYS = ['path', 'targetPath', 'workspacePath', 'file', 'command', 'name', 'query', 'url'];
const SUMMARY_MAX = 60;

function flat(v) {
  return String(v).replace(/\s+/g, ' ').trim();
}

/** 从工具入参里挑最有信息量的字段做摘要（如 main.tex、执行的命令），没有则返回 ''。 */
export function toolSummary(name, input) {
  if (!input || typeof input !== 'object') return '';
  const pick = (k) => {
    const v = input[k];
    if (typeof v !== 'string' && typeof v !== 'number') return '';
    return flat(v);
  };
  // 复制到项目：来源 → 目标，两个路径都要看到
  if (name === 'copy_to_project') {
    const src = pick('workspacePath');
    const dst = pick('targetPath');
    if (src || dst) return truncateText(`${src || '?'} → ${dst || '?'}`, SUMMARY_MAX);
  }
  for (const k of SUMMARY_KEYS) {
    const v = pick(k);
    if (v) return truncateText(v, SUMMARY_MAX);
  }
  return '';
}

/** 工具入参 → 可读 JSON 文本；空对象/空值返回 ''。 */
export function formatToolInput(input) {
  if (input == null) return '';
  if (typeof input === 'string') return input.trim();
  try {
    const s = JSON.stringify(input, null, 2);
    return s === '{}' || s === 'null' ? '' : s;
  } catch {
    return String(input);
  }
}

/**
 * 工具结果判成败：{error:…} 或 JSON 里的 "error" 字段、非零 exitCode 视为失败。
 * 返回 'ok' | 'error'。
 */
export function toolResultKind(result) {
  const s = typeof result === 'string' ? result.trim() : formatToolInput(result);
  if (!s) return 'ok';
  try {
    const v = JSON.parse(s);
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if (v.error || v.ok === false || v.success === false) return 'error';
      if (typeof v.exitCode === 'number' && v.exitCode !== 0) return 'error';
    }
    return 'ok';
  } catch {
    // 非 JSON：按文本里的 error 字段判断
  }
  return /"error"\s*:/.test(s) ? 'error' : 'ok';
}

const FILE_MUTATION_TOOLS = new Set(['edit_file', 'write_file', 'copy_to_project']);
function resultObject(result) {
  if (result && typeof result === 'object') return result;
  if (typeof result !== 'string') return null;
  try { const value = JSON.parse(result); return value && typeof value === 'object' ? value : null; } catch { return null; }
}

// An attempted tool invocation is not evidence that a file changed. The backend
// supplies explicit net-difference and persistence fields for mutation tools.
function toolOutcomeLabel(name, state, result) {
  const phrase = toolPhrase(name);
  const action = phrase.replace(/^已/, '');
  if (state === 'running') return phrase.startsWith('已') ? `正在${action}` : `${phrase}执行中`;
  if (state === 'error') return `${action}失败`;
  if (state === 'cancelled') return `已取消${action}`;
  if (!FILE_MUTATION_TOOLS.has(name)) return phrase;
  const outcome = resultObject(result);
  if (outcome?.changed === false) return '未产生文件修改';
  if (outcome?.changed === true && outcome.staged === true) return '已暂存文件修改';
  if (outcome?.changed === true && outcome.applied === true) {
    return outcome.scope === 'workspace' || String(outcome.path || '').startsWith('_workspace/') ? '已修改工作区文件' : phrase;
  }
  if (outcome?.scope === 'project' && outcome.changed === true && outcome.staged === false && outcome.applied === false) return '未留下待提交修改';
  return '编辑结果待核对';
}

// ---------- 选中内容附加到智能体消息 ----------

/** 选中原文随请求单独传给后端（不进对话消息）的长度上限 */
export const SELECTION_TEXT_MAX = 20_000;

export function editorManuscriptFocus(view, attachedSelection) {
  if (!view) return null;
  const { doc, selection } = view.state;
  if (!doc || (!attachedSelection && (selection.main.from !== selection.main.to || doc.length <= 2800))) return null;
  const { from, to } = attachedSelection || selection.main;
  return {
    line: doc.lineAt(from).number,
    before: view.state.sliceDoc(Math.max(0, from - 1400), from),
    after: view.state.sliceDoc(to, Math.min(doc.length, to + 1400)),
  };
}

/**
 * 选中片段 → 对话消息开头的一行引用（只标明文件与行号，不含原文——
 * 原文经 selectionPayload 单独传给后端注入模型上下文，避免刷屏）。
 * 无有效选中返回 ''。
 */
export function buildSelectionQuote(sel) {
  const text = String(sel?.text ?? '');
  if (!text.trim()) return '';
  const file = String(sel.file || '当前文件');
  const range = sel.startLine === sel.endLine
    ? `第 ${sel.startLine} 行`
    : `第 ${sel.startLine}–${sel.endLine} 行`;
  return `> 📎 **选中内容** · ${file}（${range}）`;
}

/** 选中片段 → 随请求发送的独立载荷；无有效选中返回 null */
export function selectionPayload(sel) {
  const text = String(sel?.text ?? '');
  if (!text.trim()) return null;
  return {
    file: String(sel.file || ''),
    startLine: sel.startLine ?? null,
    endLine: sel.endLine ?? null,
    text: text.slice(0, SELECTION_TEXT_MAX),
  };
}

/** 用户输入 + 选中片段 → 发送的消息；无有效选中时原样返回 */
export function annotateMessageWithSelection(text, sel) {
  const quote = buildSelectionQuote(sel);
  const body = String(text ?? '');
  return quote ? `${quote}\n\n${body}` : body;
}

// 明显指向"某段内容"的措辞：发送时若无附加选区，提醒用户先选中
const SELECTION_HINT_RE = /选中|这段|该段|此段|这句|此处|这部分/;

/** 消息是否在措辞上指向选中的某段内容（启发式，仅用于提示，不阻断发送） */
export function mentionsSelectionHint(text) {
  return SELECTION_HINT_RE.test(String(text ?? ''));
}

// ---------- 时间线（轮次步骤 / 用时） ----------

/** 毫秒 → 「3 分 36 秒」；无效输入返回 ''。 */
export function formatDuration(ms) {
  if (ms == null || ms === '') return '';
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return '';
  const total = Math.round(n / 1000);
  if (total < 1) return '不到 1 秒';
  if (total < 60) return `${total} 秒`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m < 60) return s ? `${m} 分 ${s} 秒` : `${m} 分`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h} 小时 ${rm} 分` : `${h} 小时`;
}

/** 解析时间戳（SQLite 的 'YYYY-MM-DD HH:MM:SS' 按 UTC 处理）→ 毫秒；无法解析返回 null。 */
export function parseTs(s) {
  const str = String(s ?? '').trim();
  if (!str) return null;
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(str) ? `${str.replace(' ', 'T')}Z` : str;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/** 本轮用时 = 上一轮用户消息与这条回答的时间戳之差（毫秒）；算不出返回 null。 */
export function durationBetween(start, end) {
  const a = parseTs(start);
  const b = parseTs(end);
  if (a == null || b == null) return null;
  return Math.max(0, b - a);
}

export const AGENT_METADATA_FIELDS = ['agentId', 'agentLabel', 'agentRole', 'agentExecutionId',
  'agentPhase', 'agentRevision', 'agentStartedAt', 'agentTask', 'agentStatus'];

// Keep execution attribution intact through live SSE, history and presentation.
export function pickAgentMetadata(value) {
  return Object.fromEntries(AGENT_METADATA_FIELDS.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]));
}

// Only server-issued local recovery identities cross the SSE/history boundary.
// URLs, filenames and arbitrary properties are never accepted as download targets.
export function pickDraftRecovery(value) {
  const r = value?.recovery;
  if (!r || !Number.isSafeInteger(r.draftId) || r.draftId <= 0 ||
      !Number.isSafeInteger(r.chatId) || r.chatId <= 0 ||
      !Number.isSafeInteger(r.version) || r.version < 0 ||
      typeof r.projectId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(r.projectId)) return {};
  return { recovery: { draftId: r.draftId, projectId: r.projectId, chatId: r.chatId, version: r.version } };
}

// 工具步骤行：历史 {name,input,result,ms} 与实时 {name,status,detail} 两种形状统一
function toolRow(call) {
  const name = String(call?.name || '');
  const running = call?.status === 'start';
  const raw = call?.result != null ? call.result : (call?.detail ?? '');
  const resultText = technicalToolText(raw);
  const preview = truncateText(resultText);
  const inputText = technicalToolText(call?.input);
  const mcp = mcpToolParts(name);
  // Display v1 carries the authoritative execution status. In older histories,
  // end only meant that transport completed: failed mutations/commands also used
  // it. Preserve their explicit error/exit result, but never classify successfully
  // read document contents by incidental error fields in that document.
  const contentTool = ['read_file', 'read_workspace', 'read_skill', 'get_document_context', 'web_fetch'].includes(name);
  const authoritativeEnd = call?.status === 'ok' || (call?.status === 'end' && (call?.display?.version === 1 || contentTool));
  const state = call?.status === 'error' ? 'error' : call?.status === 'cancelled' ? 'cancelled' : running ? 'running' : authoritativeEnd ? 'ok' : toolResultKind(resultText);
  const display = toolPresentation({ name, input: call?.input, result: raw, display: call?.display, state });
  const agentId = typeof call?.agentId === 'string' ? call.agentId : '';
  const agentLabel = agentId ? sanitizeToolText(call.agentLabel || `协作智能体（${agentId}）`, 160) : '';
  const ordinaryLabel = display.title || toolOutcomeLabel(name, state, raw);
  return {
    kind: 'tool',
    ...pickAgentMetadata(call),
    ...(call?.toolCallId ? { toolCallId: String(call.toolCallId) } : {}),
    display,
    name,
    label: agentLabel ? `${agentLabel} · ${ordinaryLabel}` : ordinaryLabel,
    ...(agentId ? { agentId, agentLabel, agentRole: String(call.agentRole || '') } : {}),
    // MCP 工具显示「server · tool」，其余优先用服务端给的摘要（运行中也有），回退到本地参数摘要
    summary: mcp
      ? [mcp.server, mcp.tool].filter(Boolean).join(' · ')
      : sanitizeToolText(String(call?.summary || '').trim() || toolSummary(name, call?.input), 160),
    mcp: !!mcp,
    state,
    ms: Number.isFinite(call?.ms) ? call.ms : null,
    inputText,
    resultText,
    preview,
    longResult: preview !== resultText,
    hasBody: !!(inputText || resultText || display),
  };
}

/**
 * 步骤数组（或老消息的 toolCalls）→ 时间线 { rows, answer }。
 * rows 是 {kind:'text',text} 与工具行按真实发生顺序交错的数组；
 * 末尾的 text 步骤就是这个回答（后端 content 是各轮叙述的拼接，不重复渲染）；
 * 末尾是思考或工具时，所有正文留在实际位置，不提升或重新排列，
 * 只有 content 缺失（实时流）或没有任何叙述步骤（老消息）才用 content 兜底，避免全部叙述糊成一段。
 */
export function buildTimeline({ steps, toolCalls, content } = {}) {
  const items = [];
  if (Array.isArray(steps) && steps.length) {
    for (const s of steps) {
      if (s?.type === 'text') {
        const text = String(s.text ?? '');
        if (text.trim()) items.push({ kind: 'text', text });
      } else if (s?.type === 'model_thinking') {
        if (typeof s.text === 'string' && s.text.trim()) items.push({
          kind: 'thinking', text: s.text, source: 'provider',
          ...(Number.isFinite(s.startedAt) && s.startedAt > 0 ? { startedAt: s.startedAt } : {}),
          ...(Number.isFinite(s.durationMs) && s.durationMs >= 0 ? { durationMs: s.durationMs } : {}),
        });
      } else if (s?.type === 'activity') {
        if (s.text) items.push({ kind: 'activity', ...pickAgentMetadata(s), ...pickDraftRecovery(s), text: String(s.text), phase: s.phase || 'working', ...(s.source ? { source: s.source === 'model' ? 'model' : 'system' } : {}) });
      } else if (s?.type === 'agent_report') {
        items.push({ kind: 'agent_report', ...pickAgentMetadata(s), report: s.report, usage: s.usage,
          toolCount: s.toolCount, status: s.status || s.agentStatus, startedAt: s.startedAt,
          finishedAt: s.finishedAt, durationMs: s.durationMs });
      } else if (s?.type === 'tool') {
        items.push(toolRow(s));
      }
    }
  } else {
    for (const c of Array.isArray(toolCalls) ? toolCalls : []) items.push(toolRow(c));
  }
  const text = String(content ?? '');
  const last = items[items.length - 1];
  if (!last) return { rows: [], answer: text };
  if (last.kind === 'text') return { rows: items.slice(0, -1), answer: last.text };
  // A middle narration must never be moved after later thinking/tools on reload.
  // content is an aggregate fallback only when no text steps survived.
  return { rows: items, answer: items.some((item) => item.kind === 'text') ? '' : text };
}
