<template>
  <div ref="retainedScrollEl" class="review-panel">
    <div class="panel-head">
      <el-icon class="head-glyph" aria-hidden="true"><ChatDotSquare /></el-icon>
      <span class="title">审阅（{{ openReviews.length }}）</span>
      <span class="grow"></span>
      <el-button
        v-if="myDoneCount"
        text
        type="danger"
        size="small"
        title="删除我的全部已完成批注（未完成的保留）"
        @click="removeMineDone"
      >清空已完成</el-button>
      <el-button text size="small" title="刷新" @click="store.loadReviews()">↻</el-button>
    </div>

    <div v-if="!store.reviewMode" class="hint muted">
      在编辑器工具栏开启「审阅」模式后，选中正文即可添加批注
    </div>

    <el-empty v-if="!openReviews.length && !doneReviews.length" description="还没有审阅意见" :image-size="50" />

    <div
      v-for="r in openReviews"
      :key="r.id"
      class="review-item"
      @click="locate(r)"
    >
      <div class="r-line1">
        <span class="r-file mono" :title="r.filePath">{{ basename(r.filePath) }}</span>
        <span class="grow"></span>
        <span class="muted">{{ timeAgo(r.createdAt) }}</span>
      </div>
      <div v-if="r.quotedText" class="r-quote" :title="r.quotedText">「{{ r.quotedText }}」</div>
      <div class="r-text">{{ r.content }}</div>
      <div v-if="(r.replies || []).length" class="r-replies">
        <div v-for="rep in r.replies" :key="rep.id" class="r-reply">
          <span class="r-reply-author">{{ rep.authorName || '匿名' }}</span>
          <span class="r-reply-text">{{ rep.content }}</span>
        </div>
      </div>
      <div class="r-reply-row" @click.stop>
        <input
          v-model="replyDrafts[r.id]"
          class="r-reply-input"
          placeholder="回复后才能标记完成…"
          @keyup.enter="sendReply(r)"
        />
        <button class="mini" title="回复该批注" @click.stop="sendReply(r)">回复</button>
      </div>
      <div class="r-line2">
        <span class="muted">{{ r.authorName || '匿名' }}</span>
        <span class="grow"></span>
        <button
          class="mini ai"
          title="提交给智能体按批注意见整改（仅改对应内容，需经变更审查）"
          :disabled="agent.streaming"
          @click.stop="aiFixReview(r)"
        >AI 修改</button>
        <button
          class="mini"
          :disabled="!(r.replies || []).length"
          :title="(r.replies || []).length ? '标记为已完成' : '需先回复该批注后才能标记完成'"
          @click.stop="resolve(r)"
        >完成</button>
        <template v-if="!store.readOnly && isMine(r)">
          <button class="mini danger" title="删除该批注" @click.stop="remove(r)">删除</button>
        </template>
      </div>
    </div>
    <template v-if="doneReviews.length">
      <div class="done-title muted">已完成（{{ doneReviews.length }}）</div>
      <div
        v-for="r in doneReviews"
        :key="'d' + r.id"
        class="review-item done"
        title="点击跳转到批注位置"
        @click="locate(r)"
      >
        <div class="r-line1">
          <span class="done-badge">✓</span>
          <span class="r-file mono" :title="r.filePath">{{ basename(r.filePath) }}</span>
          <span class="grow"></span>
          <span class="muted">{{ timeAgo(r.resolvedAt || r.createdAt) }}</span>
        </div>
        <div v-if="r.quotedText" class="r-quote" :title="r.quotedText">「{{ r.quotedText }}」</div>
        <div class="r-text">{{ r.content }}</div>
        <div v-if="(r.replies || []).length" class="r-replies">
          <div v-for="rep in r.replies" :key="rep.id" class="r-reply">
            <span class="r-reply-author">{{ rep.authorName || '匿名' }}</span>
            <span class="r-reply-text">{{ rep.content }}</span>
          </div>
        </div>
        <div class="r-line2">
          <span class="muted">{{ r.authorName || '匿名' }}</span>
          <span class="grow"></span>
          <template v-if="!store.readOnly && isMine(r)">
            <button class="mini danger" title="删除该批注" @click.stop="remove(r)">删除</button>
          </template>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup>
import { useRetainedScroll } from '../../lib/retainedScroll.js';
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { api, timeAgo } from '../../api.js';
import { useEditorStore } from '../../stores/editor.js';
import { useUiStore } from '../../stores/ui.js';
import { useAuthStore } from '../../stores/auth.js';
import { useAgentStore } from '../../stores/agent.js';
import { useEditorRuntime } from '../../lib/editorRuntime.js';
import { editorManuscriptFocus } from '../../lib/agentUtils.js';
import { createEditorNavigator } from '../../lib/editorNavigation.js';

const props = defineProps({ active: { type: Boolean, default: true } });
const store = useEditorStore();
const retainedScrollEl = ref(null);
useRetainedScroll(retainedScrollEl, { scope: store, key: () => 'review-scroll', active: () => props.active });
const editorRuntime = useEditorRuntime();
const ui = useUiStore();
const navigator = createEditorNavigator(store, editorRuntime, { active: () => props.active, onError: message => ui.error(message) });
onBeforeUnmount(() => navigator.cancel());
const auth = useAuthStore();
const agent = useAgentStore();

const openReviews = computed(() =>
  (store.reviews || []).filter((r) => r.status === 'open')
);
// 已完成的批注置底展示（不删除）：按文章先后顺序排序（文件 → 位置），点击仍可跳转
const doneReviews = computed(() =>
  (store.reviews || [])
    .filter((r) => r.status && r.status !== 'open')
    .slice()
    .sort(
      (a, b) =>
        (a.filePath || '').localeCompare(b.filePath || '') || (a.start ?? 0) - (b.start ?? 0)
    )
);
// 仅批注作者可删除自己的批注
const isMine = (r) => r.authorId != null && r.authorId === auth.user?.id;
// 一键删除 = 只删自己「已完成」的批注（未完成的保留）
const myDoneCount = computed(
  () => doneReviews.value.filter((r) => isMine(r)).length
);
async function removeMineDone() {
  if (!myDoneCount.value) return;
  const ok = await ui.confirm(
    `确定删除你已完成的 ${myDoneCount.value} 条批注吗？（未完成的批注不受影响）`,
    '清空已完成批注'
  );
  if (!ok) return;
  try {
    const r = await api.del(`/api/projects/${store.projectId}/reviews/mine`);
    await store.loadReviews();
    ui.toast(`已删除 ${r.deleted} 条已完成批注`);
  } catch (e) {
    ui.error(e.message || '删除失败');
  }
}

function basename(p) {
  return String(p || '').split('/').pop();
}

/** 点击批注：打开文件并跳到批注位置（字符偏移 → 0 基行号） */
function locate(r) {
  return navigator.open(r.filePath, { offset: r.start ?? 0 });
}

const replyDrafts = ref({});
async function sendReply(r) {
  const text = String(replyDrafts.value[r.id] || '').trim();
  if (!text) return;
  try {
    await api.post(`/api/projects/${store.projectId}/reviews/${r.id}/replies`, { content: text });
    replyDrafts.value[r.id] = '';
    await store.loadReviews();
  } catch (e) {
    ui.error(e.message || '回复失败');
  }
}
async function resolve(r) {
  if (!(r.replies || []).length) {
    ui.error('批注需先回复后才能标记完成');
    return;
  }
  try {
    await store.resolveReview(r.id);
    ui.toast('批注已完成');
  } catch (e) {
    ui.error(e.message || '操作失败');
  }
}

async function remove(r) {
  if (!(await ui.confirm('确定删除这条批注吗？', '删除批注'))) return;
  try {
    await store.deleteReview(r.id);
    ui.toast('批注已删除');
  } catch (e) {
    ui.error(e.message || '删除失败');
  }
}

// 把批注意见提交给智能体，按意见整改对应内容（约束收紧：只改批注针对的内容）
async function aiFixReview(r) {
  if (agent.streaming) {
    ui.error('智能体正在处理中，请等当前任务完成');
    return;
  }
  const msg = `请结合批注 #${r.id} 的意见和讨论，仅修订 ${r.filePath} 中对应内容，并拟一条可供作者采用的回复。`;
  const view = editorRuntime.view;
  const anchored = view && editorRuntime.projectId === store.projectId && editorRuntime.filePath === r.filePath &&
    r.start >= 0 && r.end > r.start && r.end <= view.state.doc.length && view.state.sliceDoc(r.start, r.end) === r.quotedText;
  const manuscriptFocus = anchored ? editorManuscriptFocus(view, { from: r.start, to: r.end }) : null;
  store.sidebar = 'agent';
  await agent.sendMessage(store.projectId, msg, { currentFile: r.filePath, reviewId: r.id, manuscriptFocus }).catch(() => {});
}

// Cached panels keep reply drafts; refresh shared comments only when visible.
watch(() => props.active, (active) => {
  if (active && store.projectId) store.loadReviews().catch((error) => ui.error(error.message || '加载批注失败'));
}, { immediate: true });
</script>

<style scoped>
.review-panel { padding: 8px; flex: 1; min-height: 0; overflow: auto; }
.panel-head {
  display: flex;
  align-items: center;
  margin-bottom: 8px;
}
.title { font-size: 13px; font-weight: 600; }
.grow { flex: 1; }
.hint {
  font-size: 12px;
  line-height: 1.6;
  padding: 7px 8px;
  margin-bottom: 8px;
  background: var(--bg3);
  border: 1px solid var(--border);
  border-radius: 8px;
}
.review-item {
  background: var(--bg3);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 7px 8px;
  margin-bottom: 6px;
  cursor: pointer;
}
.review-item:hover { border-color: var(--accent); }
.r-line1 {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11.5px;
  color: var(--fg-dim);
}
.r-file { color: var(--blue); }
.r-quote {
  margin-top: 4px;
  padding-left: 7px;
  border-left: 2px solid var(--green, #26a269);
  color: var(--fg-dim);
  font-size: 12px;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  line-clamp: 2;
}
.r-text { font-size: 13px; margin: 4px 0 3px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
.r-line2 {
  display: flex;
  gap: 6px;
  font-size: 11.5px;
  align-items: center;
}
/* 批注回复：回复列表 + 回复输入行 */
.r-replies {
  margin-top: 5px;
  padding: 4px 6px;
  background: var(--bg2);
  border-radius: 6px;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.r-reply { font-size: 12px; line-height: 1.45; color: var(--fg); white-space: pre-wrap; word-break: break-word; }
.r-reply-author { color: var(--accent); font-size: 11px; margin-right: 5px; }
.r-reply-row { display: flex; gap: 4px; margin-top: 5px; }
.r-reply-input {
  flex: 1;
  min-width: 0;
  font-size: 11.5px;
  padding: 3px 6px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--bg);
  color: var(--fg);
}
.r-reply-input:focus { outline: none; border-color: var(--accent); }
.mini {
  font-size: 11px;
  padding: 2px 8px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--bg2);
  color: var(--fg);
  cursor: pointer;
}
.mini:hover { background: var(--bg-hover); }
.mini.danger { color: var(--danger, #e5534b); }
.mini.ai { color: var(--accent); border-color: var(--accent); }
.mini.ai:hover:not(:disabled) { background: var(--accent); color: var(--on-accent); }
.mini.ai:disabled { opacity: 0.5; cursor: default; }
/* 已完成置底区：弱化展示，不做高亮 */
.done-title {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin: 12px 0 6px;
}
.review-item.done { opacity: 0.6; }
.review-item.done .r-quote { border-left-color: var(--border); }
.review-item.done:hover { border-color: var(--border); opacity: 0.9; }
.done-badge { color: var(--accent); font-size: 11px; flex: none; }

/* ---- visual refinement layer (presentation only) ---- */
.review-panel { scrollbar-width: thin; scrollbar-color: color-mix(in srgb, var(--fg-muted) 38%, transparent) transparent; }
.panel-head { gap: 7px; }
.head-glyph { flex: none; font-size: 14px; color: var(--accent); opacity: .9; }
.title { font-weight: 650; letter-spacing: .01em; }
.hint { background: var(--surface-muted); border-color: color-mix(in srgb, var(--border) 80%, var(--bg2)); border-radius: var(--radius-sm); color: var(--fg-dim); }
.review-item { background: var(--glass-g1-bg); border-color: color-mix(in srgb, var(--border) 85%, var(--bg2)); border-radius: var(--radius-md); box-shadow: var(--glass-highlight); transition: border-color var(--motion-hover) var(--ease-standard), box-shadow var(--motion-hover) var(--ease-standard); }
.review-item:hover { border-color: color-mix(in srgb, var(--accent) 55%, var(--border)); box-shadow: var(--glass-highlight), var(--shadow-sm); }
.r-file { color: var(--accent-hover); font-weight: 600; }
.r-quote { border-left-color: color-mix(in srgb, var(--accent) 50%, transparent); }
.r-replies { background: color-mix(in srgb, var(--bg2) 75%, var(--surface-muted)); border: 1px solid color-mix(in srgb, var(--border) 55%, transparent); }
.r-reply-author { font-weight: 650; }
.r-reply-input { border-radius: 6px; transition: border-color var(--motion-hover) var(--ease-standard), box-shadow var(--motion-hover) var(--ease-standard); }
.r-reply-input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--focus-ring); }
.mini { border-radius: 6px; font-weight: 550; transition: background-color var(--motion-hover) var(--ease-standard), border-color var(--motion-hover) var(--ease-standard), color var(--motion-hover) var(--ease-standard); }
.mini.ai { border-color: color-mix(in srgb, var(--accent) 55%, var(--border)); background: var(--accent-soft); }
.mini.ai:hover:not(:disabled) { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
.mini.danger:hover:not(:disabled) { background: var(--danger-soft); border-color: color-mix(in srgb, var(--danger) 40%, var(--border)); }
.done-title { letter-spacing: .06em; font-weight: 650; color: var(--fg-muted); }
.review-item.done { background: transparent; box-shadow: none; }
.review-item.done:hover { border-color: color-mix(in srgb, var(--border) 85%, var(--bg2)); }
.done-badge { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; border-radius: 50%; background: var(--success-soft); color: var(--success); font-weight: 700; }
@media (prefers-reduced-motion: reduce) {
  .review-item, .r-reply-input, .mini { transition: none; }
}
@media (forced-colors: active) {
  .head-glyph { color: CanvasText; }
  .review-item { box-shadow: none; }
}
</style>
