<template>
  <div class="code-editor">
    <!-- 打开文件标签栏 -->
    <div class="tabs" v-if="store.openFiles.length">
      <div
        v-for="f in store.openFiles"
        :key="f"
        class="tab"
        :class="{ active: f === store.activeFile }"
        :title="f"
        @click="store.activeFile = f"
      >
        <span class="tab-name">{{ basename(f) }}</span>
        <span class="tab-close" title="关闭" @click.stop="store.closeFile(f)">×</span>
      </div>
    </div>

    <div v-if="recoveryDrafts.length" class="recovery-banner" role="status">
      <span>{{ recoveryStorageError ? '恢复稿暂存于内存，请及时下载。' : '有尚未确认保存的本地草稿，可下载核对。' }}</span>
      <select v-model="recoveryDraftId" aria-label="选择恢复稿">
        <option v-for="draft in recoveryDrafts" :key="draft.id" :value="draft.id">{{ new Date(draft.capturedAt).toLocaleString() }}</option>
      </select>
      <button type="button" @click="downloadRecoveryDraft">下载恢复稿</button>
      <button type="button" @click="clearRecoveryDraft">已恢复，清除</button>
    </div>
    <div class="editor-body">
      <div
        ref="hostEl"
        class="cm-host"
        v-show="store.activeFile && isTextFile && loadState !== 'loading' && loadState !== 'error'"
        :style="{ fontSize: store.editorFontSize + 'px' }"
        @wheel="onEditorWheel"
      ></div>
      <div v-if="!store.activeFile" class="placeholder">
        <div class="placeholder-icon">📝</div>
        <div>从左侧文件树选择文件开始编辑</div>
      </div>
      <FilePreview v-else-if="!isTextFile" :project-id="store.projectId" :path="store.activeFile" />
      <div v-else-if="loadState === 'loading'" class="placeholder">
        <div class="placeholder-icon">⌛</div>
        <div>正在加载 {{ basename(store.activeFile) }}…</div>
      </div>
      <div v-else-if="loadState === 'error'" class="placeholder error-placeholder">
        <div class="placeholder-icon">!</div>
        <strong>文件无法打开</strong>
        <div>{{ loadError }}</div>
        <button type="button" @click="showActive(store.activeFile)">重新加载</button>
      </div>
      <div v-else-if="loadState === 'offline' || loadState === 'connecting'" class="offline-banner">{{ connectionError || (loadState === 'connecting' ? '正在连接协同服务，内容已加载…' : '协同服务暂时不可用，当前内容为只读快照') }}</div>
    </div>
    <!-- 审阅模式：选中内容后浮出的「添加批注」入口 -->
    <div
      v-if="selBubble"
      class="sel-bubble"
      :style="{ left: selBubble.left + 'px', top: selBubble.top + 'px' }"
      @mousedown.prevent
    >
      <button class="sel-bubble-btn" title="针对选中内容添加批注" @click="addReviewFromBubble">添加批注</button>
    </div>
  </div>
</template>

<script setup>
import { ref, watch, nextTick, onMounted, onBeforeUnmount, onActivated, onDeactivated } from 'vue';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, Decoration } from '@codemirror/view';
import { EditorState, Compartment, Transaction } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { StreamLanguage, syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { tags } from '@lezer/highlight';
import { yCollab } from 'y-codemirror.next';
import { useEditorStore } from '../../stores/editor.js';
import { useUiStore } from '../../stores/ui.js';
import { api } from '../../api.js';
import FilePreview from './FilePreview.vue';
import { isTextFilePath } from '../../lib/fileKind.js';
import { attachCollab, detachCollab } from '../../lib/collabClient.js';
import { useEditorRuntime } from '../../lib/editorRuntime.js';
import { useProjectContext } from '../../lib/projectContext.js';
import { parseLatexOutline } from '../../lib/outline.js';
import { reviewDecorationsExtension } from '../../lib/reviewDecorations.js';
import { setDiffDeco, diffDecoField, reviewHunksFor, diagDecoField, setDiagDeco, buildDiagDeco, searchHlField, setSearchHl, buildSearchHlDeco } from '../../lib/diffDecorations.js';

const emit = defineEmits(['context-menu', 'save-compile', 'add-review']);
const store = useEditorStore();
const editorRuntime = useEditorRuntime();
const ui = useUiStore();

const hostEl = ref(null);
const isTextFile = ref(false);
const loadState = ref('idle'); // idle | loading | ready | offline | error
const loadError = ref('');
const connectionError = ref('');
const recoveryDrafts = ref([]);
const recoveryDraftId = ref('');
const recoveryStorageError = ref(false);
function refreshRecovery(entry) {
  if (entry?.path !== store.activeFile || entry.projectId !== store.projectId) return;
  recoveryDrafts.value = [...(entry.session.recoveryDrafts || [])];
  recoveryStorageError.value = !!entry.session.recoveryStorageError;
  if (!recoveryDrafts.value.some(draft => draft.id === recoveryDraftId.value)) recoveryDraftId.value = recoveryDrafts.value.at(-1)?.id || '';
}
function downloadRecoveryDraft() {
  const entry = views.get(store.activeFile);
  const draft = entry?.session.recoveryDrafts?.find(item => item.id === recoveryDraftId.value);
  if (!draft) return;
  const url = URL.createObjectURL(new Blob([draft.text], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url; link.download = `recovery-${draft.capturedAt}-${basename(entry.path)}`;
  const revoke = URL.revokeObjectURL.bind(URL);
  link.click(); setTimeout(() => revoke(url), 1000);
}
function clearRecoveryDraft() {
  views.get(store.activeFile)?.session.clearRecoveryDraft?.(recoveryDraftId.value);
}

const views = new Map(); // path -> { view, session, container, readOnlyConf, outlineTimer }
let activeLoad = 0;
let activeSnapshotController = null;
let deferredActiveLoad = false;
const projectContext = useProjectContext();
let viewActive = true;
let viewportObserver;
function measurable(entry) {
  return !entry.destroyed && entry.view.dom.isConnected &&
    entry.view.scrollDOM.clientHeight > 0 && entry.view.scrollDOM.clientWidth > 0;
}
function visible(entry) { return viewActive && (projectContext?.active.value ?? true) && entry.path === store.activeFile && measurable(entry); }
function captureViewport(entry) {
  // Capture before KeepAlive moves the DOM; detached/hidden scroll events cannot
  // replace the last real position with the browser's clamped zero.
  if (!entry || entry.restoringViewport || !measurable(entry)) return;
  entry.viewport = { top: entry.view.scrollDOM.scrollTop, left: entry.view.scrollDOM.scrollLeft };
}
function restoreViewport(entry) {
  if (!entry || !visible(entry)) return;
  if (entry.pendingAnchor != null) { applyPendingAnchor(entry); return; }
  if (!entry.restoringViewport || !entry.viewport) { entry.view.requestMeasure(); return; }
  entry.view.requestMeasure({
    key: entry,
    read: () => visible(entry),
    write: (ready) => {
      if (!ready || !visible(entry) || !entry.restoringViewport) return;
      const { top, left } = entry.viewport;
      entry.view.scrollDOM.scrollTop = top;
      entry.view.scrollDOM.scrollLeft = left;
      entry.restoringViewport = false;
    },
  });
}
function suspendViewport() {
  if (activeSnapshotController) {
    deferredActiveLoad = true;
    activeLoad++;
    activeSnapshotController.abort();
    activeSnapshotController = null;
  }
  const entry = views.get(store.activeFile);
  captureViewport(entry);
  if (entry?.viewport) entry.restoringViewport = true;
  viewActive = false;
  window.removeEventListener('resize', remeasureAll);
}
function resumeViewport() {
  viewActive = true;
  window.addEventListener('resize', remeasureAll);
  nextTick(() => {
    if (!viewActive || !(projectContext?.active.value ?? true)) return;
    if (deferredActiveLoad) { deferredActiveLoad = false; showActive(store.activeFile); }
    else restoreViewport(views.get(store.activeFile));
  });
}
// A sync watcher runs before the cached subtree is moved into storage. The
// deactivated hook alone runs after that move and may already see zero heights.
if (projectContext) watch(() => projectContext.active.value, (active) => {
  if (active) resumeViewport(); else suspendViewport();
}, { flush: 'sync' });

// 审阅模式：选中内容后自动浮出「添加批注」入口（无需右键）
const selBubble = ref(null);
function updateSelBubble(entry) {
  const { from, to } = entry.view.state.selection.main;
  // 审阅模式下编辑器本就只读（editingLocked 恒真），只看审阅开关与选区是否非空
  const show = store.reviewMode && entry.path === store.activeFile && to > from;
  if (!show) {
    selBubble.value = null;
    return;
  }
  const end = entry.view.coordsAtPos(to);
  const host = hostEl.value?.closest('.editor-host');
  if (!end || !host) {
    selBubble.value = null;
    return;
  }
  const hostR = host.getBoundingClientRect();
  selBubble.value = {
    projectId: entry.projectId,
    filePath: entry.path,
    from,
    to,
    text: entry.view.state.sliceDoc(from, to),
    left: Math.max(0, Math.round(end.left - hostR.left - 2)),
    top: Math.max(0, Math.round(end.bottom - hostR.top + 6)),
  };
}
function addReviewFromBubble() {
  const b = selBubble.value;
  selBubble.value = null;
  if (b) {
    const { projectId, filePath, from, to, text } = b;
    emit('add-review', { projectId, filePath, from, to, text });
  }
}

// Ctrl+滚轮调整编辑器字号（存在 store 里，Visual 视图按同一比例同步缩放）
function onEditorWheel(e) {
  if (!(e.ctrlKey || e.metaKey)) return;
  e.preventDefault();
  store.setEditorFontSize(store.editorFontSize + (e.deltaY < 0 ? 1 : -1));
}

// 字号只改 CSS 继承、不改容器尺寸，CodeMirror 的 ResizeObserver 不会触发重新度量，
// 行号 gutter 会沿用旧字号的行块几何而逐渐错位（点击编辑区触发度量后才恢复）。
// 因此字号或窗口尺寸变化后，主动对所有已挂载视图请求一次度量。
function remeasureAll() {
  for (const entry of views.values()) {
    if (visible(entry)) restoreViewport(entry);
  }
}
watch(() => store.editorFontSize, remeasureAll, { flush: 'post' }); // post：等内联字号写入 DOM 后再量

const darkTheme = EditorView.theme({
  '&': { backgroundColor: 'var(--bg)', color: 'var(--fg)', height: '100%' },
  '.cm-content': { fontFamily: 'var(--mono)', caretColor: 'var(--fg)', padding: '8px 0 40vh' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--fg)' },
  '.cm-gutters': {
    backgroundColor: 'var(--bg2)', color: 'var(--fg-dim)',
    border: 'none', borderRight: '1px solid var(--border)',
  },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 12px' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--fg) 4%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'color-mix(in srgb, var(--fg) 6%, transparent)', color: 'var(--fg)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 26%, transparent)',
  },
  '.cm-selectionMatch': { backgroundColor: 'color-mix(in srgb, var(--success) 22%, transparent)' },
  '.cm-searchMatch': { backgroundColor: 'color-mix(in srgb, var(--warn) 30%, transparent)' },
  '.cm-panels': { backgroundColor: 'var(--bg2)', color: 'var(--fg)' },
  '.cm-panels input, .cm-panels button': { color: 'var(--fg)' },
  '.cm-tooltip': { backgroundColor: 'var(--bg3)', color: 'var(--fg)', border: '1px solid var(--border)' },
}, { dark: true });

const latexHighlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.controlKeyword, tags.definitionKeyword, tags.modifier], color: 'var(--syntax-keyword)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--syntax-string)' },
  { tag: [tags.comment, tags.blockComment], color: 'var(--syntax-comment)', fontStyle: 'italic' },
  { tag: [tags.number, tags.integer, tags.float], color: 'var(--syntax-number)' },
  { tag: [tags.function(tags.variableName), tags.labelName], color: 'var(--syntax-function)' },
  { tag: [tags.typeName, tags.className, tags.tagName], color: 'var(--syntax-type)' },
  { tag: [tags.atom, tags.bool], color: 'var(--syntax-atom)' },
]);

function basename(p) {
  return p.split('/').pop();
}

function findTreeNode(path) {
  const stack = [...(store.tree || [])];
  while (stack.length) {
    const n = stack.pop();
    if (n.path === path) return n;
    if (n.children) stack.push(...n.children);
  }
  return null;
}

function isTextPath(path) {
  return isTextFilePath(path, findTreeNode(path));
}

function scheduleOutline(entry, immediate = false) {
  clearTimeout(entry.outlineTimer);
  const run = () => {
    if (entry.path !== store.activeFile) return;
    store.outline = parseLatexOutline(entry.view.state.doc.toString());
  };
  if (immediate) run();
  else entry.outlineTimer = setTimeout(run, 300);
}

function updateCursor(entry) {
  const pos = entry.view.state.selection.main.head;
  const line = entry.view.state.doc.lineAt(pos);
  store.cursorLine = line.number - 1;
  store.cursorCol = pos - line.from;
}

// 选中片段同步到 store：智能体面板据此把选中内容附加为请求对象
function updateSelection(entry) {
  if (entry.path !== store.activeFile) return;
  const { from, to } = entry.view.state.selection.main;
  if (from === to) {
    store.selection = null;
    return;
  }
  store.selection = {
    file: entry.path,
    from,
    to,
    startLine: entry.view.state.doc.lineAt(from).number,
    endLine: entry.view.state.doc.lineAt(to).number,
    text: entry.view.state.sliceDoc(from, to),
  };
}

function readOnlyExtension(ro) {
  return ro ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : [];
}

// ---------- 变更集审阅（编辑区内联 diff） ----------
// 在真实文档上叠加装饰：新增/改动行绿底，删除的旧内容以红底组件插在原位（Git 行内风格）。
// 文档本身不变：协同保持绑定、不存在会被过滤器拒绝的替换事务；审阅期间整篇只读，
// 退出时移除装饰即可，无需任何恢复动作。

const diffConf = new Compartment();

function queueReviewRefresh(entry) {
  const dr = store.diffReview;
  if (!dr || dr.filePath !== entry.path || entry.destroyed || entry.reviewRefreshTimer) return;
  // A short bounded retry covers the HTTP/WebSocket delivery race without polling forever.
  if ((entry.reviewSyncAttempts || 0) >= 3) return;
  entry.reviewRefreshTimer = setTimeout(() => {
    entry.reviewRefreshTimer = null;
    if (entry.destroyed || store.diffReview !== dr || dr.busy) return;
    entry.reviewSyncAttempts = (entry.reviewSyncAttempts || 0) + 1;
    store.refreshDiffReview({ quiet: true });
  }, 120);
}

function drawReviewSnapshot(entry, dr) {
  if (!entry.diffing || store.diffReview !== dr) return;
  let text = entry.view.state.doc.toString();
  if (text !== dr.current && entry.offline && !entry.session.provider.synced && !dr.stale && !dr.refreshing) {
    // This view has no Yjs binding. Display the server snapshot without publishing it back.
    entry.applyingReviewSnapshot = true;
    try {
      entry.view.dispatch({ changes: { from: 0, to: text.length, insert: dr.current }, annotations: Transaction.addToHistory.of(false) });
    } finally { entry.applyingReviewSnapshot = false; }
    text = entry.view.state.doc.toString();
  }
  if (dr.stale || dr.refreshing || text !== dr.current) {
    entry.view.dispatch({ effects: setDiffDeco.of(Decoration.none) });
    if (text !== dr.current && !dr.refreshing && !dr.busy) {
      if (!dr.stale) store.invalidateDiffReview(entry.path);
      queueReviewRefresh(entry);
    }
    return;
  }
  entry.reviewSyncAttempts = 0;
  const hunks = reviewHunksFor(dr.base, dr.current);
  entry.view.dispatch({ effects: setDiffDeco.of(Decoration.set(hunks.flatMap((h) => h.ranges), true)) });
  if (dr.keepPos || dr.resume || dr.noJump) {
    dr.keepPos = false;
    dr.resume = false;
    dr.noJump = false;
    return;
  }
  const hunk = hunks[dr.hunkIdx];
  if (hunk) entry.view.dispatch({ effects: EditorView.scrollIntoView(hunk.from, { y: 'center', yMargin: 0 }) });
}

function enterDiffReview(entry, dr) {
  if (store.diffReview !== dr || entry.destroyed) return;
  const resume = entry.diffing;
  const scrollTop = entry.view.scrollDOM.scrollTop;
  if (entry.offline && entry.session.provider.synced) entry.onSync(true);
  entry.diffing = true;
  entry.view.dispatch({ effects: [diffConf.reconfigure([diffDecoField]), entry.readOnlyConf.reconfigure(readOnlyExtension(true))] });
  if (resume) dr.resume = true;
  drawReviewSnapshot(entry, dr);
  if (resume) requestAnimationFrame(() => { if (!entry.destroyed) entry.view.scrollDOM.scrollTop = scrollTop; });
}

// Snapshot metadata and rendered content always come from the same server revision.
watch(() => store.diffReview?.signal, () => {
  const dr = store.diffReview;
  const entry = dr && views.get(dr.filePath);
  if (entry && entry.diffing) drawReviewSnapshot(entry, dr);
});

// 编译诊断（错误/警告）→ 当前文件对应行加标识：淡底 + 波浪下划线。
// 编译完成 / 切换文件 / 重新打开文件时刷新；诊断清空后自动移除。
function applyDiag() {
  const entry = views.get(store.activeFile);
  if (!entry || entry.destroyed) return;
  const deco = buildDiagDeco(store.compile.errors, store.compile.warnings, entry.view.state.doc);
  entry.view.dispatch({ effects: setDiagDeco.of(deco) });
}
watch(
  () => [store.compile.status, store.compile.errors, store.compile.warnings, store.activeFile],
  () => applyDiag()
);

// 搜索命中高亮：搜索面板的当前文件命中整批标黄，与概览条的搜索标记联动
function applySearchHl() {
  const entry = views.get(store.activeFile);
  if (!entry || entry.destroyed) return;
  const sm = store.searchMatches;
  const deco = sm && sm.file === store.activeFile
    ? buildSearchHlDeco(sm.items, entry.view.state.doc)
    : Decoration.none;
  entry.view.dispatch({ effects: setSearchHl.of(deco) });
}
watch(() => [store.searchMatches, store.activeFile], () => applySearchHl());

// 退出审阅：移除装饰、恢复可编辑（真实文档从未被改动，无需恢复内容或位置）
function exitDiffReview(entry) {
  if (!entry.diffing) return;
  entry.diffing = false;
  entry.view.dispatch({
    effects: [
      diffConf.reconfigure([]),
      entry.readOnlyConf.reconfigure(readOnlyExtension(store.editingLocked || entry.offline)),
    ],
  });
  clearTimeout(entry.reviewRefreshTimer);
  entry.reviewRefreshTimer = null;
  // Rebind to the authoritative room; never replay an old offline review snapshot into Yjs.
  if (entry.offline) entry.onSync(entry.session.provider.synced);
}

// 等目标文件打开且协同就绪（切标签/首次打开是异步的）
// 协同离线（或未连接）时，agent 应用修改只写磁盘、房间替换无从送达：
// 变更集更新后自动从磁盘刷新当前文件的编辑器内容，避免"提示已修改但编辑区还是旧的"。
// 编辑器聚焦（用户可能正在输入）时跳过，不打断输入。
watch(() => store.pendingChangesets, async () => {
  const entry = views.get(store.activeFile);
  if (!entry || entry.diffing || !entry.offline || entry.view.hasFocus) return;
  const request = ++entry.snapshotRequest;
  const projectId = store.projectId;
  const document = entry.view.state.doc;
  try {
    const fresh = await loadTextSnapshot(entry.path, projectId);
    // A room handshake, file/project switch, newer fetch, review or edit may
    // have happened while HTTP was in flight. Never publish its old snapshot
    // through a now-live Yjs binding.
    if (entry.destroyed || views.get(entry.path) !== entry || request !== entry.snapshotRequest ||
        store.projectId !== projectId || store.activeFile !== entry.path ||
        entry.diffing || !entry.offline || entry.view.hasFocus || entry.view.state.doc !== document) return;
    if (fresh !== entry.view.state.doc.toString()) {
      entry.view.dispatch({ changes: { from: 0, to: entry.view.state.doc.length, insert: fresh }, annotations: Transaction.addToHistory.of(false) });
    }
  } catch { /* 快照拉取失败：等下次触发 */ }
}, { deep: true });

// 等目标文件打开且内容就绪（HTTP 快照已载入即可审阅，无需等协同同步完成）
function waitForEntry(path, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = () => {
      const entry = views.get(path);
      const loaded = entry && !entry.destroyed &&
        loadState.value !== 'loading' && loadState.value !== 'error';
      if (entry && loaded && entry.path === store.activeFile) return resolve(entry);
      if (Date.now() > deadline) return resolve(null);
      setTimeout(tick, 60);
    };
    tick();
  });
}

async function enterReviewFor(dr) {
  // 审阅在代码编辑器中进行：Visual 下编辑器未挂载，先回代码视图
  if (store.viewMode !== 'code') store.viewMode = 'code';
  if (dr.filePath !== store.activeFile) store.openFile(dr.filePath);
  const entry = await waitForEntry(dr.filePath);
  if (store.diffReview !== dr) return;
  if (!entry) {
    store.closeDiffReview();
    ui.error('该文件尚未就绪，无法进入审阅');
    return;
  }
  for (const e of views.values()) {
    if (e !== entry && e.diffing) exitDiffReview(e);
  }
  if (store.diffReview !== dr) return;
  enterDiffReview(entry, dr);
}

watch(() => store.diffReview, (dr) => {
  if (!dr) {
    for (const e of [...views.values()]) if (e.diffing) exitDiffReview(e);
    return;
  }
  enterReviewFor(dr);
});

async function loadTextSnapshot(path, projectId = store.projectId, signal) {
  const response = await api.raw(`/api/projects/${projectId}/file?path=${encodeURIComponent(path)}`, signal ? { signal } : undefined);
  return response.text();
}

function createView(path, fallbackText) {
  const session = attachCollab(store.projectId, path);
  const readOnlyConf = new Compartment();
  const collabConf = new Compartment();
  const entry = { projectId: store.projectId,
    path, session, readOnlyConf, collabConf, diffConf, outlineTimer: null,
    view: null, container: null, offline: true, destroyed: false, diffing: false, snapshotRequest: 0,
    viewport: null, restoringViewport: false, pendingAnchor: null, initialAnchor: null, anchorTimer: null,
  };
  const initialText = session.ytext.toString() || fallbackText || '';

  const state = EditorState.create({
    // Start from the authenticated HTTP snapshot. Yjs is attached only after
    // its handshake completes, so a disconnected socket can never blank a file.
    doc: initialText,
    extensions: [
      // Keep CR characters in CRLF/mixed files. Yjs positions and review
      // snapshots use the original text; automatic newline normalization
      // would make both their content and offsets diverge from CodeMirror.
      EditorState.lineSeparator.of('\n'),
      lineNumbers(),
      highlightActiveLineGutter(),
      history(),
      drawSelection(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      keymap.of([
        { key: 'Mod-s', run: () => { emit('save-compile'); return true; }, preventDefault: true },
        ...defaultKeymap, ...historyKeymap, ...searchKeymap,
      ]),
      StreamLanguage.define(stex),
      EditorView.lineWrapping,
      darkTheme,
      syntaxHighlighting(latexHighlight),
      readOnlyConf.of(readOnlyExtension(true)),
      collabConf.of([]),
      diffConf.of([]),
      diagDecoField,
      searchHlField,
      reviewDecorationsExtension({ store, filePath: path }),
      EditorView.updateListener.of((u) => {
        if (u.docChanged && entry.diffing && !entry.applyingReviewSnapshot) {
          entry.reviewSyncAttempts = 0;
          store.invalidateDiffReview(entry.path);
          queueReviewRefresh(entry);
        }
        if (entry.path !== store.activeFile) return;
        if (u.docChanged) scheduleOutline(entry);
        if (u.selectionSet) { entry.initialAnchor = null; entry.pendingAnchor = null; }
        if (u.selectionSet || u.docChanged) {
          updateCursor(entry);
          updateSelection(entry);
          updateSelBubble(entry);
        }
      }),
      EditorView.domEventHandlers({
        contextmenu(e, view) {
          const { from, to } = view.state.selection.main;
          if (from === to) return;
          e.preventDefault();
          emit('context-menu', {
            x: e.clientX, y: e.clientY, from, to,
            projectId: entry.projectId, filePath: entry.path, text: view.state.sliceDoc(from, to),
          });
        },
      }),
    ],
  });

  const container = document.createElement('div');
  container.className = 'cm-file';
  entry.container = container;
  entry.view = new EditorView({ state, parent: container });
  // 编辑器滚动时隐藏「添加批注」浮层（避免浮层停留在过期的选区位置）
  entry.view.scrollDOM.addEventListener('scroll', () => { selBubble.value = null; }, { passive: true });
  // A user navigation wins over the initial saved reading ratio, including when
  // the collaboration handshake has not arrived yet.
  const cancelInitialAnchor = () => { entry.initialAnchor = null; entry.pendingAnchor = null; };
  for (const name of ['wheel', 'pointerdown', 'keydown']) entry.view.scrollDOM.addEventListener(name, cancelInitialAnchor, { passive: true });
  // 阅读进度记录(防抖):首个可见行占比存入本地,刷新/重进项目后恢复到上次浏览的位置
  entry.view.scrollDOM.addEventListener('scroll', () => {
    if (!visible(entry) || entry.restoringViewport) return;
    captureViewport(entry);
    clearTimeout(entry.anchorTimer);
    entry.anchorTimer = setTimeout(() => {
      if (!visible(entry) || entry.restoringViewport || !entry.view.state.doc.lines) return;
      const st = entry.view.state;
      const block = entry.view.lineBlockAtHeight(entry.view.scrollDOM.scrollTop);
      const line = st.doc.lineAt(block.from).number;
      store.setViewAnchor(entry.path, st.doc.lines > 1 ? (line - 1) / (st.doc.lines - 1) : 0);
    }, 400);
  }, { passive: true });

  entry.onSync = (synced) => {
    if (entry.destroyed || !synced || !entry.offline) return;
    ++entry.snapshotRequest;
    const source = session.ytext.toString();
    // 先临时放开只读：readOnly facet 会过滤掉换内容的事务，
    // 导致服务端重载后的内容替换静默失败（编辑器与 ytext 漂移）
    entry.view.dispatch({ effects: [
      collabConf.reconfigure([]),
      readOnlyConf.reconfigure(readOnlyExtension(false)),
    ] });
    // Replace the read-only snapshot before installing the Yjs plugin. This
    // transaction must never be propagated back into the shared document.
    captureViewport(entry);
    if (source !== entry.view.state.doc.toString()) {
      entry.view.dispatch({ changes: { from: 0, to: entry.view.state.doc.length, insert: source }, annotations: Transaction.addToHistory.of(false) });
      if (entry.viewport) entry.restoringViewport = true;
    }
    entry.offline = false;
    if (entry.initialAnchor != null) {
      entry.pendingAnchor = entry.initialAnchor;
      entry.initialAnchor = null;
    }
    entry.view.dispatch({ effects: [
      collabConf.reconfigure(yCollab(session.ytext, session.provider.awareness)),
      readOnlyConf.reconfigure(readOnlyExtension(store.editingLocked || entry.diffing)),
    ] });
    if (entry.path === store.activeFile) {
      loadState.value = 'ready';
      connectionError.value = '';
      refreshRecovery(entry);
      scheduleOutline(entry, true);
      nextTick(() => restoreViewport(entry));
    }
  };
  // 服务端重启/断线后会话被重建（全新 Y.Doc）：卸载旧绑定，内容等下次 sync 整体替换
  entry.onReset = () => {
    if (entry.destroyed) return;
    ++entry.snapshotRequest;
    entry.offline = true;
    session.provider.on('sync', entry.onSync);
    session.provider.on('status', entry.onStatus);
    try { session.provider.awareness.on('update', entry.onAwareness); } catch {}
    entry.view.dispatch({ effects: [
      collabConf.reconfigure([]),
      readOnlyConf.reconfigure(readOnlyExtension(true)),
    ] });
    if (entry.path === store.activeFile) loadState.value = 'connecting';
  };
  entry.onStatus = ({ status }) => {
    if (entry.destroyed) return;
    if (status === 'disconnected') {
      ++entry.snapshotRequest;
      entry.offline = true;
      entry.view.dispatch({ effects: [collabConf.reconfigure([]), readOnlyConf.reconfigure(readOnlyExtension(true))] });
    }
    if (entry.offline && entry.path === store.activeFile) {
      connectionError.value = session.connectionError || '';
      loadState.value = status === 'disconnected' ? 'offline' : 'connecting';
      refreshRecovery(entry);
    }
  };
  entry.onRecovery = () => refreshRecovery(entry);
  session.recoveryCbs?.add(entry.onRecovery);
  // 远程光标昵称标签「动则显、静则隐」：协作者光标/选区变化后闪显几秒（悬停仍可查看）。
  // 不能常显：标签绝对定位在光标上方，折行长行上会长期压住相邻行文字，
  // 多人光标聚到同一位置时标签互相叠印成乱码（2026-10-19 多人编辑反馈）。
  entry.nameFlashTimers = new Map(); // 规范化颜色 -> 隐藏定时器
  entry.lastCursorSig = new Map(); // clientID -> 光标/选区签名（区分真实移动与心跳空更新）
  entry.onAwareness = ({ added, updated }, origin) => {
    if (entry.destroyed || origin === 'local' || !entry.view?.dom) return;
    const states = session.provider.awareness.getStates();
    const colors = new Set();
    const consider = (id) => {
      const st = states.get(id);
      const c = st?.user?.color;
      if (!c) return;
      // 心跳/无关字段更新（时钟推进但光标未动）不触发闪显
      const sig = JSON.stringify([st.cursor, st.selection]);
      if (entry.lastCursorSig.get(id) === sig) return;
      entry.lastCursorSig.set(id, sig);
      colors.add(normalizeColor(c));
    };
    for (const id of added) { entry.lastCursorSig.delete(id); consider(id); }
    for (const id of updated) consider(id);
    if (!colors.size) return;
    // 延后一拍等本视图的 yCollab 装饰按新光标位置重建（本监听先于库内监听注册，
    // 同步执行时拿到的还是旧 DOM；setTimeout 不受 IAB 帧冻结影响）
    setTimeout(() => {
      if (entry.destroyed || !entry.view?.dom) return;
      for (const caret of entry.view.dom.querySelectorAll('span.cm-ySelectionCaret')) {
        const color = normalizeColor(caret.style.backgroundColor);
        if (!colors.has(color)) continue;
        caret.classList.add('name-flash');
        clearTimeout(entry.nameFlashTimers.get(color));
        entry.nameFlashTimers.set(color, setTimeout(() => {
          entry.nameFlashTimers.delete(color);
          // caret 可能已被装饰重建替换，remove 打在游离节点上无副作用
          caret.classList.remove('name-flash');
        }, 4000));
      }
    }, 0);
  };
  session.provider.on('sync', entry.onSync);
  session.provider.on('status', entry.onStatus);
  try { session.provider.awareness.on('update', entry.onAwareness); } catch { /* awareness 未就绪 */ }
  session.resetCbs.add(entry.onReset);
  entry.onSync(session.provider.synced);
  return entry;
}

// 颜色字符串经 CSSOM 规范化后比较：awareness 里是 hsl(...) 原文，
// 而元素的 style.backgroundColor 读出的是浏览器规范化形式
const colorProbe = typeof document !== 'undefined' ? document.createElement('span') : null;
function normalizeColor(c) {
  if (!c || !colorProbe) return c || '';
  colorProbe.style.backgroundColor = '';
  colorProbe.style.backgroundColor = c;
  return colorProbe.style.backgroundColor || c;
}

function destroyEntry(entry) {
  entry.destroyed = true;
  ++entry.snapshotRequest;
  entry.session.recoveryCbs?.delete(entry.onRecovery);
  entry.session.provider.off('sync', entry.onSync);
  entry.session.provider.off('status', entry.onStatus);
  try { entry.session.provider.awareness?.off('update', entry.onAwareness); } catch {}
  for (const t of entry.nameFlashTimers.values()) clearTimeout(t);
  entry.nameFlashTimers.clear();
  entry.lastCursorSig.clear();
  entry.session.resetCbs.delete(entry.onReset);
  clearTimeout(entry.outlineTimer);
  clearTimeout(entry.anchorTimer);
  clearTimeout(entry.reviewRefreshTimer);
  entry.view.destroy();
  entry.container.remove();
  views.delete(entry.path);
  detachCollab(entry.projectId, entry.path, entry.session);
}

async function showActive(path) {
  const loadId = ++activeLoad;
  activeSnapshotController?.abort();
  activeSnapshotController = null;
  if (!viewActive || !(projectContext?.active.value ?? true)) { deferredActiveLoad = true; return; }
  deferredActiveLoad = false;
  const projectId = store.projectId;
  if (!hostEl.value) return;
  const previous = [...views.values()].find((item) => item.container.parentNode === hostEl.value);
  captureViewport(previous);
  if (previous?.viewport) previous.restoringViewport = true;
  hostEl.value.replaceChildren();
  // Loading another file must not leave toolbar/agent actions bound to the
  // previous detached editor while its HTTP request is in flight.
  editorRuntime.register(null);
  store.selection = null;
  loadError.value = '';
  connectionError.value = '';
  recoveryDrafts.value = [];
  if (!path || !isTextPath(path)) {
    isTextFile.value = false;
    loadState.value = path ? 'ready' : 'idle';
    editorRuntime.register(null);
    return;
  }
  isTextFile.value = true;
  let entry = views.get(path);
  if (!entry) {
    loadState.value = 'loading';
    let snapshot;
    const controller = new AbortController();
    activeSnapshotController = controller;
    try {
      snapshot = await loadTextSnapshot(path, projectId, controller.signal);
    } catch (err) {
      if (loadId !== activeLoad || projectId !== store.projectId) return;
      loadState.value = 'error';
      loadError.value = err?.message || '文件内容读取失败';
      return;
    } finally {
      if (activeSnapshotController === controller) activeSnapshotController = null;
    }
    if (loadId !== activeLoad || path !== store.activeFile || projectId !== store.projectId) return;
    entry = createView(path, snapshot);
    views.set(path, entry);
  }
  if (loadId !== activeLoad || path !== store.activeFile) return;
  hostEl.value.appendChild(entry.container);
  refreshRecovery(entry);
  connectionError.value = entry.session.connectionError || '';
  loadState.value = entry.offline ? 'connecting' : 'ready';
  editorRuntime.register(entry.view, { projectId, filePath: path });
  scheduleOutline(entry, true);
  updateCursor(entry);
  updateSelection(entry);
  applyDiag(); // 打开文件即标出已有的编译错误/警告
  // 从 Visual 切回：按文档进度锚点定位到对应代码段（一次性消费）
  if (store.pendingViewAnchor != null) {
    const ratio = store.pendingViewAnchor;
    store.pendingViewAnchor = null;
    applyAnchorRatio(entry, ratio);
  } else if (store.restoredAnchors?.[path] != null) {
    // 重进项目恢复的阅读进度：每个恢复的文件首次激活时消费自己的锚点
    const ratio = store.restoredAnchors[path];
    delete store.restoredAnchors[path];
    applyAnchorRatio(entry, ratio);
  }
  nextTick(() => restoreViewport(entry));
}
// Initial/reopened-file anchors run once after real layout. Replaying delayed
// scrollIntoView calls for six seconds could override a later project switch or
// a user's cursor/scroll. A late collaboration handshake restores the viewport
// explicitly instead of replaying an old anchor.
function applyAnchorRatio(entry, ratio) {
  entry.pendingAnchor = ratio;
  if (entry.offline) entry.initialAnchor = ratio;
  nextTick(() => applyPendingAnchor(entry));
}
function applyPendingAnchor(entry) {
  if (entry.pendingAnchor == null || !visible(entry)) return;
  const ratio = entry.pendingAnchor;
  entry.pendingAnchor = null;
  entry.restoringViewport = false;
  const st = entry.view.state;
  const line = Math.min(st.doc.lines, Math.max(1, Math.round(ratio * (st.doc.lines - 1)) + 1));
  entry.view.dispatch({ effects: EditorView.scrollIntoView(st.doc.line(line).from, { y: 'start', yMargin: 0 }) });
}
// 重进项目后 EditorView 写入 restoredAnchors 时，当前已激活文件（init 默认打开的主文件）
// 不会再触发 showActive——在这里补一次定位，保证主文件的阅读进度同样恢复
watch(() => store.restoredAnchors, () => {
  const path = store.activeFile;
  if (!path || store.restoredAnchors?.[path] == null) return;
  const entry = views.get(path);
  if (!entry) return; // 视图尚未就绪:不消费,交给 showActive 的就绪路径处理
  const ratio = store.restoredAnchors[path];
  delete store.restoredAnchors[path];
  applyAnchorRatio(entry, ratio);
});
watch(() => store.activeFile, showActive);

// 标签关闭 → 销毁对应 EditorView 并释放协同引用
watch(() => [...store.openFiles], (files) => {
  for (const entry of [...views.values()]) {
    if (!files.includes(entry.path)) destroyEntry(entry);
  }
});

// 只读状态切换（项目只读或审阅模式）→ 重配置所有已开视图；diff 审阅中的视图保持只读
watch(() => store.editingLocked, (ro) => {
  for (const entry of views.values()) {
    entry.view.dispatch({ effects: entry.readOnlyConf.reconfigure(readOnlyExtension(ro || entry.offline || entry.diffing)) });
  }
});

function saveBeforeUnload() { store.saveViewState(); }
onActivated(resumeViewport);
onDeactivated(suspendViewport);
onMounted(() => {
  showActive(store.activeFile);
  if (typeof ResizeObserver !== 'undefined') {
    viewportObserver = new ResizeObserver(() => restoreViewport(views.get(store.activeFile)));
    viewportObserver.observe(hostEl.value);
  }
  // 浏览器整页缩放（Ctrl+= 等）同样会让度量失准，resize 后补一次度量兜底
  window.addEventListener('resize', remeasureAll);
  // 刷新/关闭页面前把当前阅读位置与打开标签落盘,重进项目后恢复
  window.addEventListener('beforeunload', saveBeforeUnload);
});

onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', saveBeforeUnload);
  viewportObserver?.disconnect();
  // 离开代码视图（切 Visual 或离开页面）前记录文档进度：首个可见行占比
  const v = editorRuntime.view;
  if (v && v.state.doc.lines) {
    const retained = views.get(store.activeFile)?.viewport;
    const block = v.lineBlockAtHeight(viewActive ? v.scrollDOM.scrollTop : (retained?.top ?? v.scrollDOM.scrollTop));
    const line = v.state.doc.lineAt(block.from).number;
    store.pendingViewAnchor = v.state.doc.lines > 1 ? (line - 1) / (v.state.doc.lines - 1) : 0;
  }
  window.removeEventListener('resize', remeasureAll);
  activeLoad++;
  activeSnapshotController?.abort();
  activeSnapshotController = null;
  for (const entry of [...views.values()]) destroyEntry(entry);
  editorRuntime.register(null);
  store.selection = null; // 切到 Visual 等无代码视图时选区失效
});
</script>

<style scoped>
.recovery-banner { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 8px 12px; background: var(--bg2); color: var(--fg); font-size: 12px; border-bottom: 1px solid var(--border); }
.recovery-banner select { max-width: 180px; }
.recovery-banner button { cursor: pointer; }
.code-editor {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
  background: var(--bg);
}
.tabs {
  display: flex;
  overflow-x: auto;
  background: var(--bg2);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  min-height: 36px;
  font-size: 12.5px;
  color: var(--fg-dim);
  cursor: pointer;
  border-right: 1px solid transparent;
  border-bottom: 2px solid transparent;
  white-space: nowrap;
  user-select: none;
}
.tab:hover { background: var(--bg-hover); }
.tab.active {
  color: var(--accent);
  background: var(--accent-soft);
  border-bottom-color: var(--accent);
}
.tab-close {
  border-radius: 4px;
  padding: 0 4px;
  line-height: 1.2;
  color: var(--fg-dim);
  opacity: 0;
}
.tab:hover .tab-close, .tab.active .tab-close, .tab:focus-within .tab-close { opacity: 1; }
@media (hover: none) { .tab-close { opacity: 1; } }
.tab-close:hover { background: var(--bg3); color: var(--fg); }
.editor-body { flex: 1; min-height: 0; position: relative; }
.cm-host { height: 100%; }
.cm-host :deep(.cm-file) { height: 100%; }
.cm-host :deep(.cm-editor) { height: 100%; }
.cm-host :deep(.cm-scroller) { overflow: auto; }
.placeholder {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--fg-dim);
  font-size: 13px;
}
.placeholder-icon { font-size: 34px; opacity: 0.6; }
.error-placeholder { color: var(--danger, #ef6b73); }
.error-placeholder strong { color: var(--fg); }
.error-placeholder button { border: 1px solid var(--border); background: var(--bg3); color: var(--fg); border-radius: 5px; padding: 6px 12px; cursor: pointer; }
.offline-banner { position: absolute; left: 12px; bottom: 12px; z-index: 2; padding: 6px 10px; border: 1px solid var(--border); border-radius: 5px; background: var(--bg2); color: var(--fg-dim); font-size: 11px; }
/* 变更集审阅：编辑器内的行内 diff 装饰 */
.cm-host :deep(.cm-line.cm-diff-add) {
  background: rgba(38, 162, 105, 0.16);
  color: #8ee2b0;
}
.cm-host :deep(.cm-diff-del-widget) {
  background: rgba(229, 83, 75, 0.10);
  border-left: 2px solid var(--danger);
  margin: 2px 0;
}
.cm-host :deep(.cm-diff-del-widget .cm-diff-del) {
  color: #f0a49e;
  text-decoration: line-through;
  text-decoration-color: rgba(240, 164, 158, 0.5);
  padding: 0 8px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
/* 字词级标注：行内具体发生变动的字符段在整行红绿底色上再加深一层 */
.cm-host :deep(.cm-diff-add .cm-diff-add-mark) {
  background: rgba(38, 162, 105, 0.6);
  color: #eafff3;
  border-radius: 2px;
}
.cm-host :deep(.cm-diff-del .cm-diff-del-mark) {
  background: rgba(229, 83, 75, 0.34);
  color: #ffe3e0;
  border-radius: 2px;
  text-decoration: line-through;
  text-decoration-color: rgba(255, 227, 224, 0.85);
}
/* 编译诊断：错误/警告行淡底 + 波浪下划线 */
.cm-host :deep(.cm-diag-error-line) { background: rgba(229, 83, 75, 0.07); }
.cm-host :deep(.cm-diag-error-mark) {
  text-decoration: underline wavy var(--danger) 1px;
  text-underline-offset: 4px;
}
.cm-host :deep(.cm-diag-warning-line) { background: rgba(217, 166, 54, 0.07); }
.cm-host :deep(.cm-diag-warning-mark) {
  text-decoration: underline wavy var(--warn) 1px;
  text-underline-offset: 4px;
}
/* 搜索命中高亮（白天/夜间都醒目的琥珀黄） */
.cm-host :deep(.cm-search-hl) {
  background: rgba(255, 193, 7, 0.4);
  outline: 1px solid rgba(230, 145, 0, 0.6);
  border-radius: 2px;
}
/* 审阅模式选区浮层：添加批注入口 */
.sel-bubble {
  position: absolute;
  z-index: 30;
}
.sel-bubble-btn {
  background: var(--accent);
  color: var(--on-accent);
  border: none;
  border-radius: 6px;
  padding: 4px 10px;
  font-size: 12px;
  cursor: pointer;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.3);
}
.sel-bubble-btn:hover { filter: brightness(1.08); }

/* ---- visual refinement layer (presentation only; CodeMirror decorations untouched) ---- */
.tabs { border-bottom-color: color-mix(in srgb, var(--border) 78%, var(--bg2)); scrollbar-width: thin; scrollbar-color: color-mix(in srgb, var(--fg-muted) 38%, transparent) transparent; }
.tab { transition: background-color var(--motion-hover) var(--ease-standard), color var(--motion-hover) var(--ease-standard); }
.tab.active { font-weight: 600; }
.tab-close { transition: opacity var(--motion-hover) var(--ease-standard), background-color var(--motion-hover) var(--ease-standard), color var(--motion-hover) var(--ease-standard); }
.recovery-banner { background: var(--warn-soft); border-bottom: 1px solid color-mix(in srgb, var(--warn) 26%, transparent); }
.recovery-banner select { border-radius: 6px; }
.recovery-banner button { border-radius: 6px; font-weight: 550; }
.placeholder { letter-spacing: .01em; }
.placeholder-icon { opacity: .5; }
.error-placeholder button { border-radius: var(--radius-sm); font-weight: 550; transition: border-color var(--motion-hover) var(--ease-standard), color var(--motion-hover) var(--ease-standard); }
.error-placeholder button:hover { border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); color: var(--accent-hover); }
.offline-banner { display: flex; align-items: center; gap: 7px; border-radius: var(--radius-sm); border-color: var(--glass-edge); background: var(--glass-g2-bg); -webkit-backdrop-filter: var(--glass-g2-filter); backdrop-filter: var(--glass-g2-filter); box-shadow: var(--glass-highlight), var(--shadow-sm); }
.offline-banner::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: var(--warn); box-shadow: 0 0 0 3px var(--warn-soft); flex: none; }
.sel-bubble-btn { background-image: var(--accent-gradient); color: var(--on-accent); border-radius: 8px; font-weight: 600; letter-spacing: .01em; box-shadow: 0 4px 14px color-mix(in srgb, var(--accent) 30%, transparent); }
.sel-bubble-btn:hover { background-image: var(--accent-gradient-hover); filter: none; }
@media (prefers-reduced-motion: reduce) {
  .tab, .tab-close, .error-placeholder button { transition: none; }
}
@media (forced-colors: active) {
  .offline-banner { background: Canvas; -webkit-backdrop-filter: none; backdrop-filter: none; box-shadow: none; }
  .offline-banner::before { background: CanvasText; box-shadow: none; }
  .sel-bubble-btn, .sel-bubble-btn:hover { background-image: none; }
}
</style>
