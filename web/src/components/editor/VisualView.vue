<template>
  <div class="visual-view">
    <div class="visual-tip">Visual 为只读预览，编辑请切回 Code 视图</div>
    <div ref="scrollEl" class="visual-scroll" @wheel="onWheelZoom">
      <div v-if="!store.activeFile" class="placeholder muted">未打开文件</div>
      <!-- eslint-disable-next-line vue/no-v-html -->
      <div
        v-else
        ref="contentEl"
        :class="isMarkdown ? 'md-visual' : 'ltx-visual'"
        :style="{ fontSize: (store.editorFontSize / 13) + 'em' }"
        v-html="html"
      ></div>
    </div>
    <component :is="'style'">{{ visualCss }}</component>
  </div>
</template>

<script setup>
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount, onDeactivated } from 'vue';
import { useProjectContext } from '../../lib/projectContext.js';
import { useRetainedScroll, hasScrollLayout } from '../../lib/retainedScroll.js';
import { useEditorStore } from '../../stores/editor.js';
import { attachCollab, detachCollab } from '../../lib/collabClient.js';
import { renderLatexToHtml, VISUAL_CSS } from '../../lib/latex2html.js';
import { renderMarkdownToHtml, MD_CSS } from '../../lib/markdown2html.js';
import { getToken } from '../../api.js';
import 'katex/dist/katex.min.css';

const store = useEditorStore();
const text = ref('');
const scrollEl = ref(null);
const contentEl = ref(null);
const projectContext = useProjectContext();
const projectActive = computed(() => projectContext?.active.value ?? true);
useRetainedScroll(scrollEl, { scope: store, key: () => 'visual:' + store.activeFile });
let stopAnchorCorrection = () => {};
let visualDisposed = false;

const isMarkdown = computed(() => /\.(md|markdown)$/i.test(store.activeFile || ''));

const visualCss = computed(() => VISUAL_CSS + (isMarkdown.value ? MD_CSS : ''));

let session = null;
let sessionFile = '';
let observer = null;

function fileUrl(p) {
  return `/api/projects/${store.projectId}/file?path=${encodeURIComponent(p)}&token=${getToken()}`;
}

// Resolve extensionless figures on demand; hidden/unloaded directories never
// need to be scanned just to display a document's visible illustrations.
function figureUrl(p) {
  if (!/\.[a-zA-Z0-9]+$/.test(p) || /\.pdf$/i.test(p)) {
    return `/api/projects/${store.projectId}/figure?path=${encodeURIComponent(p)}&resolve=1&token=${getToken()}`;
  }
  return fileUrl(p);
}

const html = computed(() => {
  if (isMarkdown.value) {
    const file = store.activeFile || '';
    const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/') + 1) : '';
    return renderMarkdownToHtml(text.value, {
      resolveImage: (p) => fileUrl(dir + p),
    });
  }
  return renderLatexToHtml(text.value, { resolveImage: figureUrl });
});

function detach() {
  if (session && observer) session.ytext.unobserve(observer);
  observer = null;
  if (session) {
    session.resetCbs.delete(onSessionReset);
    detachCollab(session.projectId, sessionFile, session);
    session = null;
    sessionFile = '';
  }
}

// 会话断线重建后 ytext 换成新对象，重新挂观察器（内容随 sync 填充）
function onSessionReset() {
  if (!session) return;
  text.value = session.ytext.toString();
  observer = () => { text.value = session.ytext.toString(); };
  session.ytext.observe(observer);
}

function attach(path) {
  detach();
  if (!path) return;
  session = attachCollab(store.projectId, path);
  sessionFile = path;
  onSessionReset();
  session.resetCbs.add(onSessionReset);
}

watch(() => store.activeFile, attach, { immediate: true });

// Ctrl/Cmd + 滚轮缩放：与 Code 视图共用同一字号档位（字号/13 = 视觉缩放比），无修饰键不拦截
function onWheelZoom(e) {
  if (!(e.ctrlKey || e.metaKey)) return;
  e.preventDefault();
  store.setEditorFontSize(store.editorFontSize + (e.deltaY < 0 ? 1 : -1));
}

// Code → Visual 切换：按文档进度锚点恢复位置。内容可能异步到达（协同 sync、图片加载、
// KaTeX 排版），期间内容高度不断变化——用 ResizeObserver 反复按锚点校正，
// 直到高度稳定/超时/用户主动滚动为止，确保落点就是代码区所翻到的对应渲染部分。
onMounted(async () => {
  if (store.pendingViewAnchor == null) return;
  const ratio = store.pendingViewAnchor;
  store.pendingViewAnchor = null;
  await nextTick();
  if (visualDisposed) return;
  const el = scrollEl.value;
  const content = contentEl.value;
  if (!el) return;
  let stopped = false;
  const apply = () => {
    if (stopped || !projectActive.value || !hasScrollLayout(el)) return;
    const max = Math.max(0, el.scrollHeight - el.clientHeight);
    el.scrollTop = ratio * max;
  };
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => apply()) : null;
  if (content) ro?.observe(content);
  const stop = () => {
    stopped = true;
    ro?.disconnect();
    clearTimeout(timer);
    el.removeEventListener('wheel', stop);
    el.removeEventListener('pointerdown', stop);
  };
  const timer = setTimeout(stop, 5000);
  stopAnchorCorrection = stop;
  el.addEventListener('wheel', stop, { passive: true, once: true });
  el.addEventListener('pointerdown', stop, { once: true });
  apply();
});

watch(projectActive, active => { if (!active) stopAnchorCorrection(); }, { flush: 'sync' });
onDeactivated(() => stopAnchorCorrection());
onBeforeUnmount(() => {
  visualDisposed = true;
  stopAnchorCorrection();
  // 离开 Visual（切回 Code）前记录文档进度：内容高度占比
  const el = scrollEl.value;
  if (projectActive.value && hasScrollLayout(el)) {
    const max = Math.max(0, el.scrollHeight - el.clientHeight);
    store.pendingViewAnchor = max ? el.scrollTop / max : 0;
  }
  detach();
});
</script>

<style scoped>
.visual-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg);
}
.visual-tip {
  padding: 6px 14px;
  background: var(--bg2);
  border-bottom: 1px solid var(--border);
  color: var(--fg-dim);
  font-size: 12px;
  flex-shrink: 0;
}
.visual-scroll { flex: 1; overflow: auto; }
.placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
}

/* ---- visual refinement layer (presentation only) ---- */
.visual-tip {
  padding: 6px 14px 6px 17px;
  background: color-mix(in srgb, var(--accent-soft) 55%, var(--bg2));
  border-bottom: 1px solid color-mix(in srgb, var(--border) 72%, var(--bg2));
  box-shadow: inset 3px 0 0 color-mix(in srgb, var(--accent) 45%, transparent);
  letter-spacing: .01em;
}
.visual-scroll { scrollbar-width: thin; scrollbar-color: color-mix(in srgb, var(--fg-muted) 38%, transparent) transparent; }
.placeholder { color: var(--fg-muted); letter-spacing: .02em; }
@media (forced-colors: active) {
  .visual-tip { background: Canvas; box-shadow: none; }
}
</style>
