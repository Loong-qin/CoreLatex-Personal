// 审阅装饰（CodeMirror 6）：activeFile 中 status='open' 的审阅范围渲染为
// 柔和绿底 + 波浪下划线（Mark decoration）；文档变更时 decoration 随 changes 映射，
// 并以 500ms 去抖把新偏移 POST 回服务端 reanchor；store.reviews 引用变化时
// （loadReviews 之后）通过 pinia $subscribe 派发 refresh effect 全量重建。
import { StateField, StateEffect, Facet } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, hoverTooltip } from '@codemirror/view';
import { api } from '../api.js';
import { useEditorStore } from '../stores/editor.js';
import { useAuthStore } from '../stores/auth.js';

/** 触发 decoration 全量重建的 effect */
export const refreshReviewsEffect = StateEffect.define();
const reviewContext = Facet.define({ combine: (values) => values[0] || null });
function storeFor(state) { return state.facet(reviewContext)?.store || useEditorStore(); }
function fileFor(state) { return state.facet(reviewContext)?.filePath || storeFor(state).activeFile; }


/**
 * 纯逻辑：从 reviews 中筛出 filePath 匹配且 status='open' 的项，
 * 偏移裁剪到 [0, docLength]，start/end 颠倒时交换，空范围丢弃，按 start 升序返回。
 * 返回 [{ id, start, end, review }]。
 */
export function buildReviewRanges(reviews, filePath, docLength) {
  const ranges = [];
  if (!Array.isArray(reviews)) return ranges;
  const len = Math.max(0, docLength ?? 0);
  for (const r of reviews) {
    if (!r || r.status !== 'open' || r.filePath !== filePath) continue;
    let start = Math.min(Math.max(0, r.start ?? 0), len);
    let end = Math.min(Math.max(0, r.end ?? 0), len);
    if (end < start) [start, end] = [end, start];
    if (end === start) continue;
    ranges.push({ id: r.id, start, end, review: r });
  }
  ranges.sort((a, b) => a.start - b.start || a.end - b.end);
  return ranges;
}

const reviewMark = Decoration.mark({
  class: 'cm-review-open',
  attributes: {
    style: [
      'background-color: rgba(38, 162, 105, 0.18)',
      'text-decoration: underline wavy rgba(38, 162, 105, 0.55)',
      'text-decoration-skip-ink: none',
      'text-underline-offset: 2px',
    ].join('; '),
  },
});

function buildDecoSet(state) {
  const store = storeFor(state);
  return Decoration.set(
    buildReviewRanges(store.reviews, fileFor(state), state.doc.length).map((r) =>
      reviewMark.range(r.start, r.end)
    )
  );
}

export const reviewDecoField = StateField.define({
  create: (state) => buildDecoSet(state),
  update(deco, tr) {
    for (const e of tr.effects) {
      if (e.is(refreshReviewsEffect)) return buildDecoSet(tr.state);
    }
    return deco.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

// 文档变更时跟踪每条 open 审阅的最新偏移，去抖回写服务端；
// 同时订阅 store.reviews / activeFile 变化，推送重建 decoration。
const reanchorPlugin = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.view = view;
      const store = storeFor(this.view.state);
      this.lastReviews = store.reviews;
      this.lastFile = fileFor(this.view.state);
      this.anchors = this.buildAnchors();
      this.pending = new Map();
      this.timer = null;
      this.unsub = store.$subscribe(() => this.onStoreChange());
    }

    buildAnchors() {
      const store = storeFor(this.view.state);
      const anchors = new Map();
      for (const r of buildReviewRanges(store.reviews, fileFor(this.view.state), this.view.state.doc.length)) {
        anchors.set(r.id, { start: r.start, end: r.end });
      }
      return anchors;
    }

    onStoreChange() {
      const store = storeFor(this.view.state);
      if (store.reviews === this.lastReviews && fileFor(this.view.state) === this.lastFile) return;
      this.lastReviews = store.reviews;
      this.lastFile = fileFor(this.view.state);
      this.anchors = this.buildAnchors();
      this.pending.clear();
      this.view.dispatch({ effects: refreshReviewsEffect.of(null) });
    }

    update(update) {
      if (!update.docChanged) return;
      for (const [id, a] of this.anchors) {
        const start = update.changes.mapPos(a.start, 1);
        const end = update.changes.mapPos(a.end, -1);
        if (end > start) {
          this.anchors.set(id, { start, end });
          this.queueReanchor(id, start, end);
        } else {
          this.anchors.delete(id); // 范围被完整删除，不再跟踪
        }
      }
    }

    queueReanchor(id, start, end) {
      const store = storeFor(this.view.state);
      const orig = (store.reviews || []).find((r) => r.id === id);
      if (orig && orig.start === start && orig.end === end) this.pending.delete(id);
      else this.pending.set(id, { id, start, end });
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.flush(), 500);
    }

    async flush() {
      const updates = [...this.pending.values()];
      this.pending.clear();
      const store = storeFor(this.view.state);
      if (!updates.length || !store.projectId) return;
      try {
        await api.post(`/api/projects/${store.projectId}/reviews/reanchor`, { updates });
        // 本地同步偏移，避免下一轮相对旧值重复上报
        for (const u of updates) {
          const r = (store.reviews || []).find((x) => x.id === u.id);
          if (r) {
            r.start = u.start;
            r.end = u.end;
          }
        }
      } catch {
        /* 网络失败：下轮编辑会以最新 anchors 重试 */
      }
    }

    destroy() {
      clearTimeout(this.timer);
      this.unsub?.();
    }
  }
);

function trunc(s, n) {
  const one = String(s || '').replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n) + '…' : one;
}

function miniBtn(label, onClick, { danger = false, disabled = false, title = '' } = {}) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  // 颜色走主题变量：白天/夜间模式自动适配
  b.style.cssText =
    'font-size:11px;padding:2px 8px;border:1px solid var(--border);border-radius:5px;' +
    'background:var(--bg3);color:var(--fg);cursor:pointer;';
  if (danger) b.style.color = 'var(--danger)';
  if (disabled) {
    b.disabled = true;
    b.style.opacity = '0.5';
    b.style.cursor = 'default';
    if (title) b.title = title;
  }
  b.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (disabled) return;
    onClick();
  });
  return b;
}

function tooltipDom(review, state) {
  const store = storeFor(state);
  const auth = state.facet(reviewContext)?.auth || useAuthStore();
  // 仅批注作者可删除自己的批注
  const canDelete = review.authorId != null && review.authorId === auth.user?.id;
  const root = document.createElement('div');
  root.style.cssText =
    'max-width:340px;display:flex;flex-direction:column;gap:6px;font-size:12px;color:var(--fg);';
  if (review.quotedText) {
    const q = document.createElement('div');
    q.style.cssText =
      'color:var(--fg-dim);border-left:2px solid var(--accent);padding-left:8px;white-space:pre-wrap;word-break:break-word;';
    q.textContent = trunc(review.quotedText, 120);
    root.appendChild(q);
  }
  const c = document.createElement('div');
  c.style.cssText = 'white-space:pre-wrap;word-break:break-word;';
  c.textContent = review.content || '';
  root.appendChild(c);
  const meta = document.createElement('div');
  meta.style.cssText = 'color:var(--fg-dim);font-size:11px;';
  meta.textContent = review.authorName || '匿名';
  root.appendChild(meta);
  // 回复列表：批注需至少一条回复后才能标记完成
  const replies = review.replies || [];
  if (replies.length) {
    const list = document.createElement('div');
    list.style.cssText =
      'display:flex;flex-direction:column;gap:4px;padding:5px 7px;background:var(--bg3);border-radius:6px;';
    for (const rep of replies) {
      const row = document.createElement('div');
      row.style.cssText = 'font-size:11.5px;line-height:1.45;white-space:pre-wrap;word-break:break-word;';
      const who = document.createElement('span');
      who.style.cssText = 'color:var(--accent);font-size:11px;margin-right:5px;';
      who.textContent = rep.authorName || '匿名';
      row.appendChild(who);
      row.appendChild(document.createTextNode(rep.content));
      list.appendChild(row);
    }
    root.appendChild(list);
  }
  if (!store.readOnly) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:6px;margin-top:2px;';
    const reload = async () => {
      await store.loadReviews();
    };
    row.appendChild(
      miniBtn('完成', async () => {
        try {
          await api.post(`/api/projects/${store.projectId}/reviews/${review.id}/resolve`);
          await reload();
        } catch { /* 忽略，tooltip 关闭后状态不变 */ }
      }, { disabled: !replies.length, title: replies.length ? '标记为已完成' : '需先回复该批注后才能标记完成' })
    );
    // 仅批注作者可删除自己的批注
    if (canDelete) {
      row.appendChild(
        miniBtn('删除', async () => {
          try {
            await api.del(`/api/projects/${store.projectId}/reviews/${review.id}`);
            await reload();
          } catch { /* 同上 */ }
        }, { danger: true })
      );
    }
    root.appendChild(row);
  }
  return root;
}

const reviewHover = hoverTooltip((view, pos) => {
  const store = storeFor(view.state);
  const hit = buildReviewRanges(store.reviews, fileFor(view.state), view.state.doc.length).find(
    (r) => pos >= r.start && pos <= r.end
  );
  if (!hit) return null;
  return {
    pos: hit.start,
    end: hit.end,
    above: true,
    create: () => ({ dom: tooltipDom(hit.review, view.state) }),
  };
});

// tooltip 容器配色走主题变量（覆盖 CM 默认浅色），白天/夜间自动适配
const reviewTooltipTheme = EditorView.baseTheme({
  '.cm-tooltip': {
    backgroundColor: 'var(--bg2)',
    color: 'var(--fg)',
    border: '1px solid var(--border)',
    borderRadius: '8px',
    padding: '10px 12px',
    boxShadow: '0 6px 20px rgba(0, 0, 0, 0.25)',
  },
});

/** 审阅装饰扩展：高亮 Mark + reanchor 回写 + 悬停 tooltip */
export function reviewDecorationsExtension({ store, auth, filePath } = {}) {
  return [reviewContext.of({ store: store || useEditorStore(), auth, filePath }), reviewDecoField, reanchorPlugin, reviewHover, reviewTooltipTheme];
}
