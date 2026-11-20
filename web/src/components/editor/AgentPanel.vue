<script setup>
import { ref, reactive, computed, unref, watch, nextTick, onMounted, onActivated, onDeactivated, onBeforeUnmount, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import { useEditorStore } from '../../stores/editor.js';
import { useAgentStore } from '../../stores/agent.js';
import { useUiStore } from '../../stores/ui.js';
import { useAuthStore } from '../../stores/auth.js';
import { composerDrafts, composerDraftScope } from '../../lib/agentComposerDrafts.js';
import { useEditorRuntime } from '../../lib/editorRuntime.js';
import { useProjectContext } from '../../lib/projectContext.js';
import {
  truncateContext, buildTimeline, durationBetween,
  annotateMessageWithSelection, mentionsSelectionHint, selectionPayload, editorManuscriptFocus,
} from '../../lib/agentUtils.js';
import { renderMarkdownToHtml, CHAT_MD_CSS, CHAT_CURSOR_CSS } from '../../lib/markdown2html.js';
import { getToken } from '../../api.js';
import AgentContextUsage from './AgentContextUsage.vue';
import AgentTimeline from './AgentTimeline.vue';
import { isRunInput, orderRunInputs, unansweredMessage } from '../../lib/agentRunInputs.js';
import AgentQuestionCard from './AgentQuestionCard.vue';
import { workflowForSteps } from '../../lib/agentWorkflow.js';

const emit = defineEmits(['close']);
const chatCss = CHAT_MD_CSS + CHAT_CURSOR_CSS;
const router = useRouter();
const store = useEditorStore();
const agent = useAgentStore();
const ui = useUiStore();
const editorRuntime = useEditorRuntime();
const projectContext = useProjectContext();
const retainedActive = ref(true);
const panelActive = computed(() => retainedActive.value && unref(projectContext?.active) !== false);

const auth = useAuthStore();
let panelDisposed = false;
const transientComposer = reactive({ text: '', attachments: [] });
const composerKey = computed(() => composerDraftScope(auth.user?.id, store.projectId));
const composer = computed(() => composerDrafts.get(composerKey.value) || transientComposer);
const draft = computed({ get: () => composer.value.text, set: (text) => { composer.value.text = text; } });
const attachments = computed({ get: () => composer.value.attachments, set: (items) => { composer.value.attachments = items; } });
watch(() => [composer.value.text, composer.value.attachments], () => composerDrafts.persist(composerKey.value), { deep: true, flush: 'sync' });
watch(() => auth.user?.id, (id, previous) => {
  if (previous != null && previous !== id) composerDrafts.clearAccount(previous);
  if (id == null) { transientComposer.text = ''; transientComposer.attachments = []; }
  // After a reload the saved model can become known after chat history has loaded.
  if (id != null && previous == null) {
    agent.syncProjectPreferences();
    if (agent.messages.length && !agent.currentContextUsage) agent.refreshContextUsage().catch(() => {});
  }
}, { flush: 'sync' });
watch(() => store.projectId, () => {
  if (!composerKey.value) { transientComposer.text = ''; transientComposer.attachments = []; }
}, { flush: 'sync' });
onBeforeUnmount(() => {
  panelDisposed = true;
  composerDrafts.persist(composerKey.value);
});
const scrollEl = ref(null);
const messageListEl = ref(null);
const chatAtBottom = ref(true);
const ta = ref(null);
const settingsState = ref('loading'); // 'loading' | 'ok' | 'error'
const fileInput = ref(null);
// UI-only snapshots survive the live node becoming its persisted message. Keep
// them local to this panel; no DOM, Pinia state or browser storage is retained.
const thinkingReadings = new Map();
let liveThinkingReadings = new Map();
let previousMessageIds = new Set();
function messageThinkingReadings(id) {
  if (!thinkingReadings.has(id)) thinkingReadings.set(id, new Map());
  return thinkingReadings.get(id);
}
watch(() => agent.streaming, (active, wasActive) => {
  if (active) {
    liveThinkingReadings = new Map();
    previousMessageIds = new Set(agent.messages.map((message) => message.id));
  } else if (wasActive) {
    const message = agent.messages.at(-1);
    if (message?.role === 'assistant' && !previousMessageIds.has(message.id)) {
      thinkingReadings.set(message.id, liveThinkingReadings);
    }
  }
}, { immediate: true, flush: 'sync' });
watch(() => [store.projectId, agent.activeChatId, agent.resetting], () => {
  thinkingReadings.clear();
  liveThinkingReadings = new Map();
  previousMessageIds = new Set(agent.messages.map((message) => message.id));
}, { flush: 'sync' });

const IMAGE_MIME_RE = /^image\/(png|jpeg|jpg|webp|gif)$/i;
const loadingAttachments = computed(() => attachments.value.some((a) => a.pending));
const canSend = computed(() => (!!draft.value.trim() || attachments.value.length > 0) &&
  !agent.resetting && !agent.cancelling && !agent.sendingInput && !agent.compacting && !loadingAttachments.value &&
  (!agent.streaming || (!!agent.activeRunId && !attachments.value.length)));
const runStatus = computed(() => agent.cancelling ? '正在停止，等待任务确认…'
  : agent.connectionLost ? '连接已中断，任务状态待确认'
  : agent.pendingQuestion ? '等待你的回答'
  : agent.reconnecting ? `正在重连 ${agent.reconnectAttempt}/5…`
  : agent.reconnectAttempt ? `已恢复连接 · 重连 ${agent.reconnectAttempt}/5`
  : '');

function onPickFiles(e) {
  const picked = Array.from(e.target.files || []);
  e.target.value = '';
  addFiles(picked);
}

/** 选文件与拖放松开共用的入口：校验大小/数量后读取为 base64 附件 */
function addFiles(files) {
  if (agent.streaming || agent.resetting) {
    ui.error('任务运行或清空会话时不能添加附件；可先发送文字补充指令');
    return;
  }
  for (const f of files) {
    if (!f.type && !f.size) continue;
    const isImg = IMAGE_MIME_RE.test(f.type);
    const cap = isImg ? 5 * 1024 * 1024 : 20 * 1024 * 1024;
    if (f.size > cap) { ui.error(`${f.name} 超过 ${isImg ? 5 : 20}MB 上限`); continue; }
    const kind = isImg ? 'image' : 'file';
    if (attachments.value.length >= 12 || attachments.value.filter((a) => a.kind === kind).length >= (isImg ? 8 : 10)) {
      ui.error('一次最多 12 个附件，其中图片最多 8 张、文件最多 10 个');
      continue;
    }
    if (attachments.value.reduce((sum, a) => sum + a.size, 0) + f.size > 40 * 1024 * 1024) {
      ui.error('附件总大小不能超过 40MB');
      continue;
    }
    // Reserve the slot synchronously so concurrent FileReaders cannot bypass limits.
    const item = { attachmentId: Symbol('attachment'), kind, name: f.name, mime: f.type || 'application/octet-stream', size: f.size, dataUrl: '', base64: '', pending: true };
    attachments.value.push(item);
    // Readers keep their original project array even if the panel switches projects.
    const targetAttachments = attachments.value;
    const targetScope = composerKey.value;
    const reader = new FileReader();
    reader.onload = () => {
      const current = targetAttachments.find((a) => a.attachmentId === item.attachmentId);
      if (!current) return;
      const dataUrl = String(reader.result || '');
      current.dataUrl = isImg ? dataUrl : '';
      current.base64 = dataUrl.slice(dataUrl.indexOf('base64,') + 7);
      current.pending = false;
    };
    reader.onerror = () => {
      const index = targetAttachments.findIndex((a) => a.attachmentId === item.attachmentId);
      if (index >= 0) targetAttachments.splice(index, 1);
      if (!panelDisposed && composerKey.value === targetScope) ui.error(`读取 ${f.name} 失败，请重新添加`);
    };
    reader.readAsDataURL(f);
  }
}

// 粘贴上传：截图或复制的文件直接进附件区，与选择/拖放共用同一条校验通道；
// 无文件时放行，保持普通文本粘贴不受影响
function onPaste(e) {
  const files = Array.from(e.clipboardData?.files || []);
  if (!files.length) return;
  e.preventDefault();
  addFiles(files);
}

// 拖拽上传：整个面板都是放置区，拖入时高亮提示
const dragOver = ref(false);
let dragDepth = 0;
function onDragEnter(e) {
  const types = Array.from(e.dataTransfer?.types || []);
  if (!types.includes('Files')) return;
  dragDepth += 1;
  dragOver.value = true;
}
function onDragOver(e) {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
}
function onDragLeave() {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) dragOver.value = false;
}
function onDrop(e) {
  e.preventDefault();
  dragDepth = 0;
  dragOver.value = false;
  addFiles(Array.from(e.dataTransfer?.files || []));
}

const needSetup = computed(() => settingsState.value === 'error' || !agent.modelReady);

// 模型跟随当前项目，切换后从下一轮对话开始使用。
const pickedModel = computed({
  get: () => agent.activeModelId,
  set: (v) => {
    if (v && v !== agent.activeModelId) {
      agent.setActiveModel(v).catch((e) => ui.error(e.message || '切换模型失败'));
    }
  },
});

const pickedReasoning = computed({
  get: () => agent.activeReasoningEffort,
  set: (value) => {
    try { agent.setReasoningEffort(value); }
    catch (error) { ui.error(error.message || '切换思考强度失败'); }
  },
});

onMounted(async () => {
  try {
    await agent.loadSettings();
    if (panelDisposed) return;
    settingsState.value = 'ok';
  } catch {
    if (panelDisposed) return;
    settingsState.value = 'error';
  }
  if (store.projectId) agent.loadChat(store.projectId).catch(() => {});
});

watch(
  () => store.projectId,
  (id) => {
    if (id) agent.loadChat(id).catch(() => {});
  }
);

// 消息正文的 Markdown：按 messages 缓存，流式 token 不会重排历史消息。
// 助手消息走时间线：rows = 过程步骤，html = 最终回答；用时取自上一轮用户消息的时间戳。
const orderedMessages = computed(() => orderRunInputs(agent.messages));
const rendered = computed(() =>
  orderedMessages.value.map((m, i) => {
    if (m.role !== 'assistant') {
      return { m, input: isRunInput(m), html: renderMarkdownToHtml(isRunInput(m) && typeof m.inputText === 'string' ? m.inputText : m.content, { breaks: true, resolveImage: projectFileUrl }) };
    }
    const tl = buildTimeline({ steps: m.steps, toolCalls: m.toolCalls, content: m.content });
    const prev = orderedMessages.value[i - 1];
    return {
      m,
      rows: tl.rows,
      graph: workflowForSteps(m.steps, m.runState),
      runNotice: { failed: '本轮执行失败，尚未完成。可检查已保存的过程后继续。', interrupted: '本轮执行已中断，尚未完成。可检查已保存的过程后继续。', cancelled: '本轮已停止。可检查已保存的过程，或输入「继续」接续任务。' }[m.runState] || '',
      html: renderMarkdownToHtml(tl.answer, { breaks: true, resolveImage: projectFileUrl }),
      durationMs: prev && prev.role === 'user'
        ? (m.durationMs > 0 ? m.durationMs : durationBetween(prev.createdAt, m.createdAt))
        : null,
    };
  })
);

// 本轮（进行中）：同一条时间线，答案区跟着流式输出走
const liveTimeline = computed(() => buildTimeline({ steps: agent.liveSteps }));
const liveGraph = computed(() => workflowForSteps(agent.liveSteps, agent.runState));
// Local detail popovers close when their timeline is hidden or deactivated.
const timelineActive = computed(() => panelActive.value && (!store.sidebar || store.sidebar === 'agent'));
watch(timelineActive, (active) => {
  if (active && settingsState.value === 'ok' && !agent.streaming) agent.loadSettings({ syncSound: false }).catch(() => {});
});

const liveAnswerHtml = computed(() =>
  renderMarkdownToHtml(liveTimeline.value.answer, { breaks: true, resolveImage: projectFileUrl })
);

// 进行中的用时：从本轮开始计到当前，每秒刷新（immediate：面板中途挂载也能跟上）
const now = ref(Date.now());
let ticker = null;
watch(
  () => [agent.streaming, panelActive.value],
  ([on, active]) => {
    clearInterval(ticker);
    ticker = null;
    if (!on || !active) return;
    now.value = Date.now();
    ticker = setInterval(() => {
      now.value = Date.now();
    }, 1000);
  },
  { immediate: true }
);
onUnmounted(() => clearInterval(ticker));
const liveDurationMs = computed(() => {
  // 重算触发源(两者都要):now 每秒 tick 驱动真实浏览器里静默期(工具执行/思考)的计时走动;
  // 流式事件依赖是内置浏览器节流 setInterval 时的兜底(事件到达触发重算)。
  // 取值用 Date.now()(非 now.value):节流环境下 now 可能冻结在旧时刻,取它会算出负值/0
  void agent.streamText;
  void agent.liveSteps.length;
  void now.value;
  return agent.streamStartedAt ? Math.max(0, Date.now() - agent.streamStartedAt) : null;
});

function projectFileUrl(p) {
  return `/api/projects/${store.projectId}/file?path=${encodeURIComponent(p)}&token=${getToken()}`;
}

// A retained DOM node can lose scrollTop while detached or hidden. Save only
// visible layout and restore the exact reading position before following output.
let chatScrollTop = 0;
let chatHasPosition = false;
let chatNeedsRestore = false;
let chatRestoring = false;
let chatScrollTarget = null;
let chatLayoutVersion = 0;
let chatResizeObserver;
const resumedThoughtReadings = new WeakSet();
const CHAT_BOTTOM_TOLERANCE = 8;
function updateChatBottom(el = scrollEl.value) {
  if (hasChatLayout(el)) chatAtBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight <= CHAT_BOTTOM_TOLERANCE;
}
function readingLiveThought() {
  return [...liveThinkingReadings.values()].some((state) => state.expanded && state.followLatest === false && !resumedThoughtReadings.has(state));
}
function followChatBottom() {
  const el = scrollEl.value;
  if (!panelActive.value || chatNeedsRestore || chatRestoring || !hasChatLayout(el)) return;
  el.scrollTop = el.scrollHeight;
  chatScrollTarget = el.scrollTop;
  chatScrollTop = el.scrollTop;
  chatHasPosition = true;
  updateChatBottom(el);
}
function jumpToLatest() {
  // Invalidate an earlier queued follow, then keep following subsequent output.
  chatLayoutVersion++;
  // Explicitly returning to the latest output overrides existing thought-reading
  // pauses; a fresh inner scroll emits a new snapshot and pauses it again.
  for (const state of liveThinkingReadings.values()) resumedThoughtReadings.add(state);
  followChatBottom();
}
function pauseChatFollow(event) {
  if (event.target?.closest?.('.thinking-content') || !hasChatLayout() || chatNeedsRestore || chatRestoring) return;
  if (event.type === 'wheel' ? event.deltaY >= 0 : event.target !== event.currentTarget || !['ArrowUp', 'PageUp', 'Home'].includes(event.key)) return;
  if (scrollEl.value.scrollHeight <= scrollEl.value.clientHeight) return;
  chatLayoutVersion++;
  chatAtBottom.value = false;
}
function hasChatLayout(el = scrollEl.value) {
  return !!el && el.isConnected && el.clientHeight > 0;
}
function rememberChatPosition() {
  const el = scrollEl.value;
  if (hasChatLayout(el) && !chatRestoring) {
    chatScrollTop = el.scrollTop;
    chatHasPosition = true;
  }
}
function onMessagesScroll() {
  const el = scrollEl.value;
  if (!panelActive.value || chatNeedsRestore || chatRestoring || !hasChatLayout(el)) return;
  if (chatScrollTarget != null && Math.abs(el.scrollTop - chatScrollTarget) < 1) {
    chatScrollTarget = null;
    updateChatBottom(el);
    return;
  }
  chatScrollTarget = null;
  chatLayoutVersion++;
  rememberChatPosition();
  updateChatBottom(el);
}
function suspendChatPosition() {
  rememberChatPosition();
  chatNeedsRestore = chatHasPosition;
  chatScrollTarget = null;
  chatLayoutVersion++;
}
async function restoreChatPosition() {
  if (!chatNeedsRestore || !panelActive.value) return;
  const version = ++chatLayoutVersion;
  chatRestoring = true;
  await nextTick();
  const el = scrollEl.value;
  if (version !== chatLayoutVersion) return;
  if (!panelActive.value || !hasChatLayout(el)) { chatRestoring = false; return; }
  el.scrollTop = chatScrollTop;
  chatScrollTarget = el.scrollTop;
  chatScrollTop = el.scrollTop;
  chatNeedsRestore = false;
  updateChatBottom(el);
  await nextTick();
  if (version === chatLayoutVersion) chatRestoring = false;
}
watch(panelActive, (active) => {
  if (active) restoreChatPosition();
  else suspendChatPosition();
}, { flush: 'sync' });
watch(() => store.sidebar, (name, previous) => {
  if (previous === 'agent' && name !== 'agent') suspendChatPosition();
  else if (name === 'agent') restoreChatPosition();
}, { flush: 'sync' });
onDeactivated(() => {
  suspendChatPosition();
  retainedActive.value = false;
});
onActivated(() => {
  retainedActive.value = true;
  restoreChatPosition();
});
watch([scrollEl, messageListEl], ([el, content]) => {
  chatResizeObserver?.disconnect();
  if (el && typeof ResizeObserver !== 'undefined') {
    chatResizeObserver = new ResizeObserver(() => {
      if (!hasChatLayout(el)) {
        chatNeedsRestore = chatHasPosition;
        chatLayoutVersion++;
      } else if (chatNeedsRestore) restoreChatPosition();
      else if (panelActive.value && !chatRestoring) {
        if (chatAtBottom.value && !readingLiveThought()) followChatBottom();
        else updateChatBottom(el);
      }
    });
    chatResizeObserver.observe(el);
    if (content) chatResizeObserver.observe(content);
  }
  if (el && chatNeedsRestore) restoreChatPosition();
}, { flush: 'post' });
onBeforeUnmount(() => { chatLayoutVersion++; chatResizeObserver?.disconnect(); });

// Capture following intent before Vue renders new content. Checking the new
// scrollHeight here loses the bottom when one streamed update is taller than
// the old threshold. Manual scrolling and restored positions update the intent.
watch(
  () => [agent.messages.length, agent.streamText, agent.liveSteps.length,
    agent.lastError, agent.resetting, ...agent.liveSteps.map((step) => step.text)],
  async () => {
    const el = scrollEl.value;
    if (!panelActive.value || chatNeedsRestore || chatRestoring || !hasChatLayout(el)) return;
    const version = chatLayoutVersion;
    const follow = chatAtBottom.value && !readingLiveThought();
    await nextTick();
    if (version === chatLayoutVersion && panelActive.value && !chatNeedsRestore && !chatRestoring && follow && hasChatLayout(scrollEl.value)) {
      followChatBottom();
    } else if (version === chatLayoutVersion && panelActive.value && !chatNeedsRestore && !chatRestoring) {
      updateChatBottom();
    }
  }
);

// 清空会话：清空当前对话记录并重新开始。删除不可恢复，先弹确认；流式进行中不允许
async function refreshChat() {
  if (agent.streaming || agent.compacting) return;
  const ok = await ui.confirm(
    '将清空当前项目的智能体会话记录并重新开始，此操作不可恢复。',
    '清空会话',
    { confirmText: '清空', type: 'warning' }
  );
  if (ok) agent.resetChat();
}

// Only unanswered requests (including unconsumed steering) need recovery. A
// question answer is associated with its existing run by durable metadata.
const orphanRound = computed(() => agent.streaming || agent.resetting ? null : unansweredMessage(orderedMessages.value));
const orphanText = computed(() => orphanRound.value?.inputKind === 'steering'
  ? '本轮结束前未处理这条补充要求。可重新发送，或输入「继续」接续任务。'
  : '上一轮未获得回复（可能已中断或失败）。可重新发送该请求，或输入「继续」接续任务。');
function runInputLabel(message) {
  if (message.inputKind === 'answer') return '回答智能体 · 已接收';
  return message.consumed ? '补充要求 · 已纳入本轮' : agent.streaming && message.runId === agent.activeRunId ? '补充要求 · 等待处理' : '补充要求 · 未处理';
}

// 选中内容附加：编辑器里有选区时，请求默认针对选中片段（消息开头附加引用块）。
// 附加是一次性的——发送后转为「不附带」，直到用户重新框选；点提示条可手动切换。
const attachSelection = ref(true);
watch(() => store.selection, () => {
  attachSelection.value = true;
});
const selectionPreview = computed(() => {
  const s = store.selection;
  if (!s) return '';
  return s.text.replace(/\s+/g, ' ').trim().slice(0, 42) + (s.text.length > 42 ? '…' : '');
});
const selectionRange = computed(() => {
  const s = store.selection;
  if (!s) return '';
  return s.startLine === s.endLine ? `第 ${s.startLine} 行` : `第 ${s.startLine}–${s.endLine} 行`;
});

function basename(p) {
  return String(p || '').split('/').pop();
}

function onKey(e) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send();
  }
}

// 编辑器实时选区（发送时刻的唯一事实来源；store.selection 仅驱动提示条展示）
function liveSelection() {
  const v = editorRuntime.view;
  if (!v || !store.activeFile || editorRuntime.filePath !== store.activeFile || editorRuntime.projectId !== store.projectId) return null;
  const { from, to } = v.state.selection.main;
  if (from === to) return null;
  return {
    file: store.activeFile,
    from,
    to,
    startLine: v.state.doc.lineAt(from).number,
    endLine: v.state.doc.lineAt(to).number,
    text: v.state.sliceDoc(from, to),
  };
}

async function send() {
  const text = draft.value.trim();
  const atts = attachments.value;
  if (!canSend.value) return;
  if (agent.streaming) {
    const targetComposer = composer.value;
    const targetScope = composerKey.value;
    const accepted = agent.pendingQuestion ? await agent.answerQuestion(text) : await agent.sendInput(text);
    if (accepted && targetComposer.text.trim() === text) targetComposer.text = '';
    composerDrafts.persist(targetScope);
    return;
  }
  const targetProject = store.projectId;
  const ticket = composerDrafts.begin(composerKey.value, composer.value);
  const sel = attachSelection.value ? liveSelection() : null;
  if (!sel && mentionsSelectionHint(text)) {
    ui.toast('未检测到编辑器选中内容；如需针对某段操作，请先在编辑器中选中后再发送');
  }
  // 选中内容：消息里只留一行引用，完整原文经 selection 字段单独传给后端注入模型上下文
  const message = annotateMessageWithSelection(text, sel);
  attachSelection.value = false;
  const sameEditor = editorRuntime.filePath === store.activeFile && editorRuntime.projectId === targetProject;
  const payload = {
    currentFile: store.activeFile,
    currentContent: editorRuntime.view && !sameEditor ? undefined : truncateContext(editorRuntime.getDocText(), 12000),
    manuscriptFocus: sameEditor ? editorManuscriptFocus(editorRuntime.view, sel) : null,
    selection: selectionPayload(sel),
  };
  if (atts.length) {
    // 图片随消息以 base64 发给模型（视觉模型可用）；文件存入工作区供智能体读取
    payload.attachments = {
      images: atts.filter((a) => a.kind === 'image').map((a) => ({ name: a.name, mime: a.mime, data: a.base64 })),
      files: atts.filter((a) => a.kind !== 'image').map((a) => ({ name: a.name, mime: a.mime, data: a.base64 })),
    };
  }
  try {
    const success = await agent.sendMessage(targetProject, message, payload);
    composerDrafts.finish(ticket, success === true);
  } catch {
    composerDrafts.finish(ticket, false);
  }
}
</script>

<template>
  <div
    class="agent-panel"
    :class="{ 'drag-over': dragOver }"
    @dragenter="onDragEnter"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <component :is="'style'">{{ chatCss }}</component>
    <div class="agent-heading">
      <svg class="agent-mark" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4l1.7 4.9L18.6 10.6l-4.9 1.7L12 17.2l-1.7-4.9L5.4 10.6l4.9-1.7z" /><path d="M18.6 15.6l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z" /></svg>
      <strong>CoreAgent</strong>
      <span class="agent-presence" :class="{ busy: agent.streaming || agent.compacting }" role="status">{{ agent.compacting ? '压缩中' : agent.streaming ? '进行中' : '就绪' }}</span>
      <button
        type="button"
        class="agent-header-action reset-chat"
        aria-label="清空会话"
        :title="agent.resetting ? '正在清空会话…' : '清空当前对话记录并重新开始'"
        :disabled="agent.streaming || agent.resetting || agent.compacting"
        @click="refreshChat"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7M14 10v7" /></svg>
      </button>
      <button type="button" class="agent-header-action agent-close" aria-label="关闭左侧面板" title="关闭左侧面板" @click="emit('close')">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
      </button>
    </div>
    <div class="panel-head">
      <el-select
        v-model="pickedModel"
        size="small"
        class="model-select"
        title="选择当前任务使用的模型"
        placeholder="选择模型"
        :disabled="agent.streaming || agent.resetting || agent.compacting"
        aria-label="选择模型"
      >
        <el-option v-for="m in agent.modelOptions" :key="m.id" :value="m.id" :label="m.label" />
      </el-select>
      <el-select
        v-if="agent.reasoningOptions.length"
        v-model="pickedReasoning"
        size="small"
        class="reasoning-select"
        aria-label="思考强度"
        title="思考强度"
        :disabled="agent.streaming || agent.resetting || agent.compacting"
      >
        <el-option v-for="level in agent.reasoningOptions" :key="level.value" :value="level.value" :label="level.label" />
      </el-select>
    </div>


    <!-- 未配置模型时的引导卡片 -->
    <div v-if="settingsState !== 'loading' && needSetup" class="guide-wrap">
      <div class="card guide">
        <svg class="guide-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4l1.7 4.9L18.6 10.6l-4.9 1.7L12 17.2l-1.7-4.9L5.4 10.6l4.9-1.7z" /><path d="M18.6 15.6l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z" /></svg>
        <div class="guide-title">开始协作</div>
        <p class="muted">请先在 设置 → AI 中配置模型，再开始与智能体对话。</p>
        <el-button type="primary" @click="router.push('/settings')">前往设置</el-button>
      </div>
    </div>

    <template v-else-if="settingsState === 'ok'">
      <div class="messages-viewport">
      <div ref="scrollEl" class="messages" tabindex="0" aria-label="聊天记录" @scroll.passive="onMessagesScroll" @wheel.passive="pauseChatFollow" @keydown="pauseChatFollow">
        <div ref="messageListEl" class="message-list">
        <!-- 清空中：列表整体替换为占位，完成后展示全新会话 -->
        <div v-if="agent.resetting" class="empty muted">正在清空会话…</div>

        <template v-else>
          <div v-if="!agent.messages.length && !agent.streaming" class="empty muted">
            <svg class="empty-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3H9.5L5 20.5V17a3 3 0 0 1-1-2.2z" /><path d="M8.5 9h7M8.5 12h4.5" /></svg>
            向 CoreAgent 提问，或让它帮你修改 LaTeX 文档。
          </div>

          <div v-for="item in rendered" :key="item.m.id" class="msg-wrap" :class="item.m.role">
            <!-- 助手：思考、正文与工具按发生顺序展示 -->
            <template v-if="item.m.role === 'assistant'">
            <AgentTimeline
              :key="`${store.projectId}:${agent.activeChatId}:${item.m.id}`"
              :rows="item.rows"
              :project-id="store.projectId"
              :chat-id="agent.activeChatId"
              :graph="item.graph"
              :active="timelineActive"
              :answer-html="item.html"
              :duration-ms="item.durationMs"
              :thinking-readings="messageThinkingReadings(item.m.id)"
              :resolve-image="projectFileUrl"
            />
            <p v-if="item.runNotice" class="run-outcome-notice" role="status">{{ item.runNotice }}</p>
            </template>
            <div v-else-if="item.html" class="bubble" :data-input-kind="item.input ? item.m.inputKind : undefined">
              <div v-if="item.input" class="run-input-label">{{ runInputLabel(item.m) }}</div>
              <details v-if="item.input && item.m.question" class="run-input-question"><summary>查看对应问题</summary><p>{{ item.m.question }}</p></details>
              <!-- eslint-disable-next-line vue/no-v-html -->
              <div class="md-chat" v-html="item.html"></div>
            </div>
          </div>

          <div v-if="orphanRound" class="orphan-bar">{{ orphanText }}</div>

          <!-- 进行中的一轮：按序展示，正在跑的一步转圈 -->
          <div v-if="agent.streaming" class="msg-wrap assistant">
            <AgentTimeline
              :key="`${store.projectId}:${agent.activeChatId}:live`"
              :rows="liveTimeline.rows"
              :project-id="store.projectId"
              :chat-id="agent.activeChatId"
              :graph="liveGraph"
              :active="timelineActive"
              :answer-html="liveAnswerHtml"
              :duration-ms="liveDurationMs"
              :thinking-readings="liveThinkingReadings"
              live
              :resolve-image="projectFileUrl"
            />
          </div>

          <div v-if="agent.lastError" class="err-bar">{{ agent.lastError }}</div>
        </template>
        </div>
      </div>
      <button v-if="!chatAtBottom" type="button" class="jump-to-latest" aria-label="回到最新消息" title="回到最新消息并自动跟随" @click="jumpToLatest">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v16m-6-6 6 6 6-6" /></svg>
      </button>
      </div>

      <div v-if="agent.streaming && runStatus" class="run-status" role="status">
        <span>{{ runStatus }}</span>
        <el-button v-if="agent.connectionLost" size="small" @click="agent.reconnectRun()">重新连接</el-button>
      </div>
      <AgentQuestionCard v-if="agent.pendingQuestion" :question="agent.pendingQuestion"
        :disabled="agent.sendingInput || agent.cancelling" @answer="(answer) => agent.answerQuestion(answer)" />

      <!-- 选中内容附加提示：编辑器里有选区时，请求默认针对选中片段；点按切换是否附带 -->
      <div
        v-if="store.selection"
        class="sel-chip"
        role="button"
        tabindex="0"
        :aria-pressed="attachSelection"
        @keydown.enter.prevent="attachSelection = !attachSelection"
        @keydown.space.prevent="attachSelection = !attachSelection"
        :class="{ off: !attachSelection }"
        :title="attachSelection ? '发送时将附带选中内容作为请求对象，点击改为不附带' : '当前不附带选中内容，点击恢复附带'"
        @click="attachSelection = !attachSelection"
      >
        <span class="sel-icon">📎</span>
        <span class="sel-meta">{{ basename(store.selection.file) }} · {{ selectionRange }}</span>
        <span class="sel-preview">{{ selectionPreview }}</span>
        <span class="sel-state">{{ attachSelection ? '已附带' : '不附带' }}</span>
      </div>

      <div v-if="attachments.length" class="attach-chips">
        <span v-for="(a, i) in attachments" :key="i" class="attach-chip" :title="a.name">
          <img v-if="a.kind === 'image'" :src="a.dataUrl" alt="" class="chip-thumb" />
          <svg v-else viewBox="0 0 24 24" class="chip-icon"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>
          <span class="chip-name">{{ a.name }}{{ a.pending ? '（读取中…）' : '' }}</span>
          <button class="chip-x" :aria-label="`移除附件 ${a.name}`" title="移除" @click="attachments.splice(i, 1)">×</button>
        </span>
      </div>

      <div class="input-area">
        <div class="composer">
          <el-input
            ref="ta"
            v-model="draft"
            type="textarea"
            :autosize="{ minRows: agent.pendingQuestion ? 1 : 2, maxRows: agent.pendingQuestion ? 3 : 8 }"
            :disabled="agent.resetting || agent.cancelling"
            :placeholder="agent.pendingQuestion ? '输入你的回答…' : agent.streaming ? '补充要求或调整方向…' : '描述问题，或一起完善这篇文档…'"
            aria-label="发送给 CoreAgent 的消息"
            @keydown="onKey"
            @paste="onPaste"
          />
          <div class="composer-actions">
            <button
              class="attach-btn"
              title="添加图片或文件"
              aria-label="添加图片或文件"
              :disabled="agent.streaming || agent.resetting"
              @click="fileInput?.click()"
            >
              <svg viewBox="0 0 24 24"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
            </button>
            <input ref="fileInput" type="file" multiple hidden @change="onPickFiles" />
            <span class="composer-hint" title="Enter 发送，Shift + Enter 换行">Enter 发送</span>
            <div class="composer-submit">
              <AgentContextUsage :usage="agent.currentContextUsage" :active="timelineActive"
                :disabled="!agent.canCompactContext || store.readOnly" :compacting="agent.compacting" @compact="agent.compactContext()" />
              <el-button type="primary" class="send" :disabled="!canSend" :loading="agent.sendingInput" @click="send">{{ agent.pendingQuestion ? '回答' : agent.streaming ? '补充' : '发送' }}</el-button>
              <el-button v-if="agent.streaming" type="danger" plain class="send" :disabled="agent.cancelling || !agent.activeRunId" @click="agent.cancelStream()">{{ agent.cancelling ? '停止中' : '停止' }}</el-button>
            </div>
          </div>
        </div>
      </div>
    </template>

    <div v-else class="empty muted" style="padding: 24px">加载中…</div>
  </div>
</template>

<style scoped>
.agent-panel { position: relative; display: flex; flex-direction: column; height: 100%; min-height: 0; min-width: 0; overflow: hidden; container: agent-panel / size; background: var(--bg2); }
.agent-panel.drag-over::after { content: '松开鼠标，将图片 / 文件添加到消息'; position: absolute; inset: 0; z-index: 6; display: flex; align-items: center; justify-content: center; padding: 24px; text-align: center; font-size: 14px; color: var(--accent); background: color-mix(in srgb, var(--bg2) 82%, transparent); border: 2px dashed var(--accent); border-radius: 8px; pointer-events: none; }
.agent-panel.drag-over .composer { border-color: var(--accent); box-shadow: 0 0 0 3px var(--focus-ring); }
.agent-heading { flex: none; display: flex; align-items: center; gap: 5px; min-height: 42px; padding: 6px 10px 6px 16px; }
.agent-heading strong { min-width: 0; font-size: 13px; font-weight: 600; letter-spacing: .1px; }
.agent-presence { margin-left: auto; margin-right: 5px; color: var(--fg-muted); font-size: 10px; display: flex; gap: 5px; align-items: center; white-space: nowrap; }
.agent-presence::before { content: ''; width: 5px; height: 5px; border-radius: 50%; background: var(--fg-muted); opacity: .65; }
.agent-presence.busy { color: var(--accent); }
.agent-presence.busy::before { background: var(--accent); opacity: 1; }
.agent-header-action { flex: none; display: grid; place-items: center; width: 28px; height: 28px; padding: 6px; border: 0; border-radius: 6px; background: transparent; color: var(--fg-dim); cursor: pointer; }
.agent-header-action svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
.agent-header-action:hover:not(:disabled) { background: var(--bg-hover); color: var(--fg); }
.agent-header-action:disabled { opacity: .35; cursor: not-allowed; }
.agent-header-action:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.panel-head { flex: none; display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 0 12px 10px; border-bottom: 1px solid var(--border); }
.model-select { flex: 1 1 120px; min-width: 0; }
.reasoning-select { flex: 0 1 90px; min-width: 76px; }
.panel-head :deep(.el-select__wrapper) { min-height: 28px; background: transparent; box-shadow: none; border-radius: 6px; padding-inline: 8px; }
.panel-head :deep(.el-select__wrapper:hover) { background: var(--bg-hover); }
.panel-head :deep(.el-select__wrapper.is-focused) { box-shadow: 0 0 0 1px var(--accent) inset; }
.panel-head :deep(.el-select__wrapper.is-disabled) { background: transparent; }
.panel-head :deep(.el-select__placeholder) { color: var(--fg-dim); font-size: 11px; }
.guide-wrap { flex: 1; display: flex; align-items: center; justify-content: center; padding: 16px; }
.guide { text-align: center; max-width: 260px; }
.guide-title { font-weight: 700; margin-bottom: 8px; }
.guide p { font-size: 13px; line-height: 1.6; }
.messages-viewport { position: relative; flex: 1; min-height: 0; display: flex; overflow: hidden; }
.messages { flex: 1; min-height: 0; min-width: 0; overflow-y: auto; overflow-x: clip; padding: 18px 16px; scroll-padding-block: 18px; }
.message-list { display: flex; flex-direction: column; gap: 22px; min-width: 0; }
.jump-to-latest { position: absolute; bottom: 12px; left: 50%; transform: translateX(-50%); z-index: 2; display: grid; place-items: center; width: 34px; height: 34px; padding: 7px; border: 1px solid var(--border); border-radius: 50%; background: var(--bg2); color: var(--fg); box-shadow: var(--shadow-sm); cursor: pointer; }
.jump-to-latest:hover { border-color: var(--accent); color: var(--accent); background: var(--accent-soft); }
.jump-to-latest:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.jump-to-latest svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.empty { text-align: center; padding: 40px 12px; font-size: 13px; line-height: 1.8; }
.msg-wrap { display: flex; flex-direction: column; width: 100%; min-width: 0; }
.msg-wrap.user { align-items: flex-end; }
.msg-wrap.assistant { align-items: stretch; }
.bubble { max-width: 90%; padding: 9px 12px; border-radius: 12px; font-size: 13px; line-height: 1.65; word-break: break-word; min-width: 0; }
.msg-wrap.user .bubble { background: var(--surface-muted); border: 1px solid transparent; border-bottom-right-radius: 4px; }
.msg-wrap.user :deep(.md-chat code), .msg-wrap.user :deep(.md-chat pre) { background: var(--bg); }
.run-input-label { font-size: 10px; color: var(--fg-muted); margin-bottom: 4px; }
.run-outcome-notice { margin: 6px 0 0; padding: 7px 9px; border-left: 2px solid var(--warn); color: var(--warn); font-size: 12px; line-height: 1.65; }
.run-input-question { font-size: 11px; color: var(--fg-dim); margin-bottom: 6px; }
.run-input-question summary { cursor: pointer; }
.run-input-question p { max-height: 180px; overflow-y: auto; white-space: pre-wrap; margin: 6px 0; }

.err-bar, .orphan-bar { border-radius: 8px; padding: 8px 10px; font-size: 12px; line-height: 1.65; overflow-wrap: anywhere; }
.err-bar { background: color-mix(in srgb, var(--danger) 9%, transparent); border: 1px solid color-mix(in srgb, var(--danger) 45%, transparent); color: var(--danger); }
.orphan-bar { background: color-mix(in srgb, var(--warn) 10%, transparent); border: 1px solid color-mix(in srgb, var(--warn) 45%, transparent); color: var(--warn); }
.run-status { flex: none; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 12px; font-size: 12px; color: var(--fg-dim); border-top: 1px solid var(--border); }
.sel-chip { flex: none; display: flex; align-items: center; gap: 6px; margin: 0 12px 6px; padding: 7px 9px; border: 1px solid var(--accent); border-radius: 8px; background: var(--accent-soft); cursor: pointer; font-size: 11px; min-width: 0; user-select: none; }
.sel-chip:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.sel-chip.off { border-color: var(--border); background: var(--surface-muted); opacity: .75; }
.sel-icon, .sel-state { flex: none; }
.sel-meta { flex: 0 1 auto; min-width: 0; max-width: 48%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg); }
.sel-preview { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg-dim); }
.sel-state { color: var(--accent); }
.sel-chip.off .sel-state { color: var(--fg-dim); }
.input-area { padding: 10px 12px 12px; flex: none; }
.composer { min-width: 0; padding: 5px; background: var(--bg2); border: 1px solid var(--border); border-radius: 10px; box-shadow: none; transition: border-color .16s, box-shadow .16s; }
.composer:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px var(--focus-ring); }
.composer-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; padding: 3px; }
.composer-submit { display: flex; align-items: center; gap: 6px; margin-inline-start: auto; }
.composer-actions .el-button { margin-left: 0; height: 30px; padding: 0 11px; }
.composer-hint { font-size: 10px; color: var(--fg-muted); white-space: nowrap; }
.attach-btn { background: transparent; border: 1px solid transparent; border-radius: 7px; width: 30px; height: 30px; display: inline-flex; align-items: center; justify-content: center; color: var(--fg-dim); cursor: pointer; flex-shrink: 0; padding: 0; }
.attach-btn:hover:not(:disabled) { background: var(--bg-hover); color: var(--fg); }
.attach-btn:disabled { opacity: .45; cursor: not-allowed; }
.attach-btn svg { width: 16px; height: 16px; min-width: 16px; min-height: 16px; flex: 0 0 auto; display: block; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
.attach-chips { flex: none; max-height: 84px; overflow-y: auto; display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 12px 0; }
.attach-chip { display: inline-flex; align-items: center; gap: 6px; background: var(--bg3); border: 1px solid var(--border); border-radius: 8px; padding: 4px 7px; font-size: 12px; max-width: 100%; }
.chip-thumb { width: 26px; height: 26px; object-fit: cover; border-radius: 4px; }
.chip-icon { width: 14px; height: 14px; min-width: 14px; flex: 0 0 auto; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
.chip-name { max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chip-x { cursor: pointer; color: var(--fg-dim); padding: 2px; border: 0; background: transparent; font-size: 14px; line-height: 1; }
.chip-x:hover { color: var(--danger); }
.input-area .el-textarea { width: 100%; min-width: 0; }
.input-area :deep(.el-textarea__inner) { line-height: 1.65; padding: 8px; resize: none; background: transparent; box-shadow: none; font-size: 13px; }
.send { flex-shrink: 0; }

@container agent-panel (max-width: 270px) {
  .composer-hint { display: none; }
}
@container agent-panel (max-height: 520px) {
  .agent-heading { min-height: 34px; padding: 3px 6px 3px 10px; }
  .panel-head { padding: 0 8px 5px; gap: 6px; }
  .messages { padding: 6px 8px; }
  .message-list { gap: 10px; }
  .run-status { padding: 4px 8px; font-size: 11px; }
  .run-status > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .input-area { padding: 6px 8px 8px; }
  .input-area :deep(.el-textarea__inner) { min-height: 30px !important; max-height: min(22cqh, 90px) !important; overflow-y: auto; padding: 5px 7px; }
  .composer-hint { display: none; }
  .sel-chip { margin: 0 8px 4px; padding: 4px 6px; }
  .attach-chips { max-height: 40px; padding: 4px 8px 0; }
}
@container agent-panel (max-height: 300px) {
  .panel-head { padding-block: 4px; }
  .messages { padding-block: 2px; }
  .input-area { padding-block: 4px; }
  .input-area :deep(.el-textarea__inner) { max-height: 34px !important; }
}


/* AI assistance reads as a focused writing companion, not a separate chat app. */
.agent-panel { background: transparent; border-left: 1px solid var(--border); }
.agent-heading { background: var(--glass-inset); border-bottom: 1px solid var(--border); }
.agent-heading strong { font-weight: 650; }
.panel-head { padding-top: 10px; background: transparent; }
.messages { padding: 20px 16px; }
.message-list { gap: 24px; }
.bubble { line-height: 1.7; }
.msg-wrap.user .bubble { background: var(--bg3); border-color: color-mix(in srgb, var(--border) 76%, transparent); border-radius: 12px 12px 4px 12px; }
.err-bar, .orphan-bar { border-radius: 9px; }
.input-area { background: var(--glass-inset); border-top: 1px solid var(--border); }
.composer { border-radius: 14px; background: var(--glass-strong); box-shadow: var(--glass-highlight); }
.composer:focus-within { background: var(--surface-raised); }
.attach-chip { border-radius: 7px; }

.agent-heading, .input-area { background: transparent; }
.msg-wrap.user .bubble { background: var(--glass-inset); border-color: var(--border); }
.composer { background: var(--surface-raised); box-shadow: none; border-radius: 10px; }
.sel-chip { border-color: var(--border); background: var(--glass-inset); }

/* Visual refinement layer: sage identity marks, semantic soft bars, token motion.
   Presentation only; compact container-query sizing above stays in charge. */
.agent-mark { width: 16px; height: 16px; flex: none; fill: none; stroke: var(--accent); stroke-width: 1.5; stroke-linejoin: round; }
.agent-heading strong { letter-spacing: .02em; }
.agent-presence.busy::before { animation: presence-pulse 1.8s var(--ease-standard) infinite; }
@keyframes presence-pulse {
  0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 35%, transparent); }
  70% { box-shadow: 0 0 0 5px transparent; }
  100% { box-shadow: 0 0 0 0 transparent; }
}
.agent-header-action { border-radius: var(--radius-sm); transition: background-color var(--motion-hover) var(--ease-standard), color var(--motion-hover) var(--ease-standard); }
.panel-head :deep(.el-select__wrapper) { border-radius: var(--radius-sm); transition: background-color var(--motion-hover) var(--ease-standard), box-shadow var(--motion-hover) var(--ease-standard); }
.empty-icon { display: block; width: 26px; height: 26px; margin: 0 auto 10px; fill: none; stroke: var(--accent-secondary); stroke-width: 1.4; stroke-linecap: round; stroke-linejoin: round; opacity: .8; }
.guide-icon { width: 22px; height: 22px; margin-bottom: 8px; fill: none; stroke: var(--accent); stroke-width: 1.5; stroke-linejoin: round; }
.guide-title { font-size: 15px; letter-spacing: -.01em; }
.msg-wrap.user .bubble { border-color: color-mix(in srgb, var(--border) 80%, var(--bg2)); box-shadow: var(--glass-highlight); }
.run-input-label { font-weight: 600; letter-spacing: .03em; color: var(--accent-secondary); }
.run-outcome-notice { background: var(--warn-soft); border-radius: 0 var(--radius-sm) var(--radius-sm) 0; }
.err-bar { background: var(--danger-soft); border-color: color-mix(in srgb, var(--danger) 30%, transparent); }
.orphan-bar { background: var(--warn-soft); border-color: color-mix(in srgb, var(--warn) 30%, transparent); }
.run-status { font-variant-numeric: tabular-nums; }
.sel-chip {
  border-radius: var(--radius-md);
  transition: border-color var(--motion-hover) var(--ease-standard), background-color var(--motion-hover) var(--ease-standard), opacity var(--motion-hover) var(--ease-standard);
}
.sel-chip:hover { border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); }
.attach-chip { border-radius: 999px; padding: 4px 8px; background: var(--glass-inset); }
.chip-thumb { border-radius: 50%; }
.chip-x {
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  transition: color var(--motion-hover) var(--ease-standard), background-color var(--motion-hover) var(--ease-standard);
}
.chip-x:hover { background: var(--danger-soft); }
.attach-btn { border-radius: var(--radius-sm); transition: background-color var(--motion-hover) var(--ease-standard), color var(--motion-hover) var(--ease-standard); }
.composer {
  border-radius: 12px;
  transition: border-color var(--motion-menu) var(--ease-standard), box-shadow var(--motion-menu) var(--ease-standard), background-color var(--motion-menu) var(--ease-standard);
}
.composer:hover:not(:focus-within) { border-color: color-mix(in srgb, var(--fg-muted) 40%, var(--border)); }
.jump-to-latest {
  background: var(--glass-g2-bg);
  border-color: var(--glass-edge);
  -webkit-backdrop-filter: var(--glass-g2-filter);
  backdrop-filter: var(--glass-g2-filter);
  box-shadow: var(--glass-highlight), var(--shadow-md);
  animation: jump-in var(--motion-surface) var(--ease-standard);
}
@keyframes jump-in {
  from { opacity: 0; transform: translateX(-50%) translateY(4px); }
  to { opacity: 1; transform: translateX(-50%) translateY(0); }
}
@media (prefers-reduced-motion: reduce) {
  .agent-presence.busy::before { animation: none; }
  .jump-to-latest { animation: none; }
  .agent-header-action, .sel-chip, .chip-x, .attach-btn, .composer { transition: none; }
}
@media (forced-colors: active) {
  .agent-presence.busy::before { animation: none; }
  .jump-to-latest { animation: none; background: Canvas; -webkit-backdrop-filter: none; backdrop-filter: none; }
  .msg-wrap.user .bubble { box-shadow: none; }
}

</style>
