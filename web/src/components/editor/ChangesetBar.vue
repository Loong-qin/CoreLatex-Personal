<script setup>
// 合并更改条：按文件聚合展示待确认修改（滚动基线模型）。
// 审查 = 在编辑区内显示 基线 vs 当前文档 的行内 diff；逐块 保存/撤销；
// 全部处理完自动接受变更集；新一轮 agent 修改自动并入同一条审阅。
import { ref, computed, watch, onBeforeUnmount } from 'vue';
import { useEditorStore } from '../../stores/editor.js';
import { useUiStore } from '../../stores/ui.js';
import { api, fmtBytes } from '../../api.js';
import { reviewHunksFor } from '../../lib/diffDecorations.js';
import { buildDiffRows } from '../../lib/diffRows.js';
import { groupPendingChangesetFiles } from '../../lib/changesetUtils.js';

const store = useEditorStore();
const ui = useUiStore();

const busy = ref(false);
const operationBusy = computed(() => busy.value || !!store.reviewBusy || !!store.diffReview?.busy);

// 按文件聚合所有未确认变更集的修改（同文件多轮修改合并为一个审阅条目）
const fileGroups = computed(() => groupPendingChangesetFiles(store.pendingChangesets));

async function run(fn, msg) {
  if (operationBusy.value) return false;
  const { projectId, projectVersion } = store;
  busy.value = true;
  try {
    if (await fn() === false) return false;
    if (!store.isCurrentProject(projectId, projectVersion)) return false;
    await store.loadPendingChangesets();
    if (!store.isCurrentProject(projectId, projectVersion)) return false;
    if (msg) ui.toast(msg);
    return true;
  } catch (e) {
    if (store.isCurrentProject(projectId, projectVersion)) {
      // Refresh once, quietly, so one failed action produces one error notice.
      await store.loadPendingChangesets();
      if (store.diffReview) await store.refreshDiffReview({ quiet: true });
      if (store.isCurrentProject(projectId, projectVersion)) ui.error((e.message || '操作失败') + (e.reviewPartial ? '（部分修改已处理，请核对刷新后仍待处理的内容。）' : ''));
    }
    return false;
  } finally {
    busy.value = false;
  }
}

// 已应用文本按文件聚合，以一次原子批量审阅处理各文件剩余的 AI 差异。
const keepAll = () => run(async () => {
  if (await store.resolvePendingChangesets('accept') === false) return false;
  store.closeDiffReview();
}, '已保留全部待审修改');
const discardAll = () => run(async () => {
  const ok = await ui.confirm('将撤销全部待审的 AI 修改，相关文件恢复到修改前内容。确定继续？', '撤销全部修改', { confirmText: '全部撤销', type: 'warning' });
  if (!ok) return false;
  if (await store.resolvePendingChangesets('revert') === false) return false;
  // 撤销后审阅与指向已删除文件的标签都不再有意义（如 AI 新建的文件被撤销删除）；
  // 审阅关闭会让离线编辑器重新走协同同步，如实显示回滚后的内容
  store.closeDiffReview();
  const paths = new Set();
  const walk = (nodes) => nodes.forEach((n) => {
    if (n.children) walk(n.children);
    else if (n.path) paths.add(n.path);
  });
  walk(store.tree || []);
  for (const f of [...store.openFiles]) {
    if (!f.startsWith('_workspace/') && !paths.has(f)) store.closeFile(f);
  }
}, '已撤销全部待审修改');

// 审查：在编辑区内直接展示行内 diff（仅非审阅态显示入口，审阅中靠 ‹ › 切换修改块）；
// 审阅态存在但修改块为空（如热更新后的残留状态）→ 点「全部保存」退出后可重新进入审阅。
async function openDiff(g) {
  if (g.binary || operationBusy.value) return;
  let ok;
  try {
    ok = await store.openDiffReview(g.appliedIds, g.filePath, true);
  } catch (e) {
    ui.error(e.message || '进入审阅失败');
    return;
  }
  if (ok === false) ui.toast('该文件没有待确认的修改');
}

const resolveBinary = (g, accept) => run(() => store.resolvePendingChangesets(accept ? 'accept' : 'revert', {
  filePath: g.filePath, appliedOnly: true,
}), accept ? '已保留文件' : '已撤销文件修改');

const reviewLocked = computed(() => !!(store.reviewBusy || store.diffReview?.busy || store.diffReview?.refreshing || store.diffReview?.stale || (store.diffReview?.hunkIdx ?? -1) < 0));

const reviewingFile = (g) => g.appliedIds.length > 0 && store.diffReview?.filePath === g.filePath;

// 未应用提案与当前文档不同：只读展示生成时 before→after，不能进入 live 文档的滚动审阅。
const proposalReview = ref({ visible: false, filePath: '', loading: false, items: [] });
let proposalRequest = 0;
function closeProposals() {
  ++proposalRequest;
  proposalReview.value = { visible: false, filePath: '', loading: false, items: [] };
}
watch(() => [store.projectId, store.projectVersion], closeProposals);
onBeforeUnmount(closeProposals);
async function openProposals(g) {
  const request = ++proposalRequest;
  const { projectId, projectVersion } = store;
  proposalReview.value = { visible: true, filePath: g.filePath, loading: true, items: [] };
  try {
    const items = await Promise.all(g.proposalIds.map(async (id) => {
      const diff = await api.get(`/api/projects/${projectId}/changesets/${id}/diff?file=${encodeURIComponent(g.filePath)}`, { cache: 'no-store' });
      const proposalRevision = diff.proposalRevision ?? 0;
      return diff.binary ? { id, proposalRevision, binary: true, beforeBytes: diff.beforeBytes, afterBytes: diff.afterBytes } : { id, proposalRevision, ...buildDiffRows(diff.before, diff.after) };
    }));
    if (request !== proposalRequest || !store.isCurrentProject(projectId, projectVersion)) return;
    proposalReview.value.items = items;
  } catch (e) {
    if (request === proposalRequest && store.isCurrentProject(projectId, projectVersion)) {
      ui.error(e.message || '加载提案失败');
      closeProposals();
    }
  } finally {
    if (request === proposalRequest) proposalReview.value.loading = false;
  }
}
async function resolveProposal(item, accept) {
  const request = proposalRequest;
  const filePath = proposalReview.value.filePath;
  const ok = await run(async () => {
    try {
      return await (accept
        ? store.acceptChangeset(item.id, filePath, item.proposalRevision)
        : store.revertChangeset(item.id, filePath, item.proposalRevision));
    } catch (error) {
      if (error?.status === 409 && request === proposalRequest) {
        // The old diff cannot authorize a continuation of this same id. Close
        // it explicitly; a list refresh must not silently replace what was seen.
        closeProposals();
        error.message = (error.message || '提案或文件内容已变化') + '；请重新打开“审查提案”查看最新内容后再处理。';
      }
      throw error;
    }
  }, accept ? '提案已应用' : '提案已放弃');
  if (!ok || request !== proposalRequest) return;
  proposalReview.value.items = proposalReview.value.items.filter((i) => i.id !== item.id);
  if (!proposalReview.value.items.length) closeProposals();
}

// 审阅中的计数 = 剩余未处理的修改块统计（保存/撤销都会实时扣减）
const reviewStats = computed(() => {
  const dr = store.diffReview;
  const adds = (dr?.hunks || []).reduce((a, h) => a + h.adds, 0);
  const dels = (dr?.hunks || []).reduce((a, h) => a + h.dels, 0);
  return { adds, dels };
});
const displayCounts = (g) => {
  if (g.applied && reviewingFile(g)) return reviewStats.value;
  // 优先用按审阅基线重算的真实数量（与进入审查后的口径一致）
  const real = g.applied && trueCounts.value[g.filePath];
  return real || { adds: g.adds, dels: g.dels };
};

// 按审阅基线重算每个文件的真实差异量：变更集创建时记录的统计与实际
// 行内 diff 口径可能不一致，以「基线 vs 当前文档」的重算结果为准
const trueCounts = ref({});
let statsSeq = 0;
watch([() => store.projectId, () => store.projectVersion, fileGroups], async ([projectId, projectVersion, groups]) => {
  const seq = ++statsSeq;
  trueCounts.value = {};
  for (const g of groups) {
    if (!g.applied || g.binary) continue; // 未应用提案的统计来自 before/after，不能以当前磁盘代替
    try {
      const baseResp = await api.get(`/api/projects/${projectId}/review/base?file=${encodeURIComponent(g.filePath)}`);
      if (seq !== statsSeq || !store.isCurrentProject(projectId, projectVersion)) return;
      const base = baseResp.base ?? '';
      const text = baseResp.current;
      if (typeof text !== 'string') continue;
      const hunks = reviewHunksFor(base, text);
      const stats = {
        adds: hunks.reduce((a, h) => a + h.adds, 0),
        dels: hunks.reduce((a, h) => a + h.dels, 0),
      };
      if (seq !== statsSeq || !store.isCurrentProject(projectId, projectVersion)) return;
      trueCounts.value = { ...trueCounts.value, [g.filePath]: stats };
    } catch { /* 单个文件重算失败时回退展示变更集统计 */ }
  }
}, { immediate: true });
onBeforeUnmount(() => { ++statsSeq; });

// 文件列表折叠态：默认展开但限高内部滚动，避免文件过多时无限撑高、压缩编辑区。
const collapsed = ref(false);
const totals = computed(() => fileGroups.value.reduce((acc, g) => {
  if (g.binary) return acc;
  const c = displayCounts(g);
  acc.adds += c.adds; acc.dels += c.dels;
  return acc;
}, { adds: 0, dels: 0 }));
// 进入某文件的行内审阅时自动展开，确保审阅导航与逐块确认按钮可见。
watch(() => store.diffReview?.filePath, (path) => { if (path) collapsed.value = false; });
</script>

<template>
  <div v-if="fileGroups.length" class="changeset-bar">
    <div class="cs-head">
      <button class="cs-toggle" type="button" :aria-expanded="!collapsed" aria-controls="cs-list" :title="collapsed ? '展开文件列表' : '折叠文件列表'" @click="collapsed = !collapsed">
        <svg class="cs-chevron" :class="{ collapsed }" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <span class="cs-title">合并更改</span>
      <span class="muted cs-mode">{{ fileGroups.some((g) => !g.applied) ? '含待应用提案' : '已应用，待审阅' }}</span>
      <span class="cs-summary muted">{{ fileGroups.length }} 个文件<template v-if="totals.adds || totals.dels"> · <span class="adds mono">+{{ totals.adds }}</span> <span class="dels mono">-{{ totals.dels }}</span></template></span>
      <span class="cs-actions">
        <el-button text type="danger" size="small" :disabled="operationBusy" @click="discardAll">全部撤销</el-button>
        <el-button type="primary" size="small" :disabled="operationBusy" @click="keepAll">全部保留</el-button>
      </span>
    </div>
    <div v-show="!collapsed" id="cs-list" class="cs-list">
    <div v-for="g in fileGroups" :key="g.filePath" class="cs-file" :class="{ reviewing: reviewingFile(g) }">
      <span class="file-icon">{}</span>
      <span class="file-path mono" :title="g.filePath">{{ g.filePath }}</span>
      <el-tag size="small" type="warning" effect="plain" class="badge">{{ g.applied ? '已应用' : g.appliedIds.length ? '部分待应用' : '待应用' }}</el-tag>
      <span v-if="g.binary" class="muted">二进制文件 · {{ fmtBytes(g.beforeBytes ?? 0) }} → {{ fmtBytes(g.afterBytes ?? 0) }}</span>
      <template v-else><span class="adds mono">+{{ displayCounts(g).adds }}</span><span class="dels mono">-{{ displayCounts(g).dels }}</span></template>
      <template v-if="g.binary && g.appliedIds.length">
        <el-button size="small" :disabled="operationBusy" @click="resolveBinary(g, false)">撤销文件</el-button>
        <el-button size="small" type="primary" :disabled="operationBusy" @click="resolveBinary(g, true)">保留文件</el-button>
      </template>
      <span v-if="reviewingFile(g) && store.diffReview?.stale" class="muted">{{ store.diffReview.refreshing ? '正在更新审阅…' : '文档已变化，等待同步' }}</span>
      <el-button v-if="reviewingFile(g) && store.diffReview?.stale" size="small" :disabled="operationBusy || store.diffReview.refreshing || store.diffReview.busy" @click="store.refreshDiffReview()">刷新审阅</el-button>
      <!-- 审阅中：修改块导航 + 逐条确认 -->
      <span v-if="reviewingFile(g) && store.diffReview?.hunks?.length" class="rev-nav">
        <button class="rev-btn" :disabled="operationBusy || store.diffReview.refreshing || store.diffReview.stale" title="上一处修改" @click="store.navDiffHunk(-1)">‹</button>
        <span class="rev-pos mono">{{ (store.diffReview.hunkIdx ?? -1) + 1 }}/{{ store.diffReview.hunks.length }}</span>
        <button class="rev-btn" :disabled="operationBusy || store.diffReview.refreshing || store.diffReview.stale" title="下一处修改" @click="store.navDiffHunk(1)">›</button>
      </span>
      <el-button
        v-if="reviewingFile(g) && store.diffReview?.applied && store.diffReview?.hunks?.length"
        size="small"
        type="primary"
        plain
        title="保留当前查看的这处修改（基线对齐到当前内容）"
        :disabled="operationBusy || reviewLocked"
        @click="store.saveCurrentHunk()"
      >保留此修改</el-button>
      <el-button
        v-if="reviewingFile(g) && store.diffReview?.applied && store.diffReview?.hunks?.length"
        size="small"
        type="warning"
        plain
        title="把当前查看的这处修改撤销回基线内容"
        :disabled="operationBusy || reviewLocked"
        @click="store.revertCurrentHunk()"
      >撤销此修改</el-button>
      <el-button v-if="!g.binary && g.appliedIds.length && !reviewingFile(g)" size="small" :disabled="operationBusy" @click="openDiff(g)">{{ g.proposalIds.length ? '审查已应用' : '审查' }}</el-button>
      <el-button v-if="g.proposalIds.length" size="small" :disabled="operationBusy" @click="openProposals(g)">审查提案</el-button>
    </div>
    </div>
  </div>
  <el-dialog v-model="proposalReview.visible" :title="'审查提案 · ' + proposalReview.filePath" width="min(1000px, 94vw)" @closed="closeProposals">
    <p class="muted proposal-note">提案尚未写入文件。以下对比生成时的原文与建议内容；应用前会检查当前文件是否发生冲突。</p>
    <p v-if="proposalReview.loading" class="muted">正在加载提案…</p>
    <section v-for="item in proposalReview.items" :key="item.id" class="proposal-item">
      <div class="proposal-head">
        <span>提案 #{{ item.id }}</span>
        <span v-if="item.binary" class="muted">二进制文件 · {{ fmtBytes(item.beforeBytes ?? 0) }} → {{ fmtBytes(item.afterBytes ?? 0) }}</span>
        <template v-else><span class="adds mono">+{{ item.adds }}</span><span class="dels mono">-{{ item.dels }}</span></template>
        <el-button size="small" :disabled="operationBusy" @click="resolveProposal(item, false)">放弃此提案</el-button>
        <el-button type="primary" size="small" :disabled="operationBusy" @click="resolveProposal(item, true)">应用此提案</el-button>
      </div>
      <p v-if="item.binary" class="muted">此文件按整体审查，可应用或放弃该提案。</p>
      <div v-else class="proposal-diff" aria-label="提案只读差异">
        <div v-for="(row, index) in item.rows" :key="index" class="proposal-row" :class="row.type">
          <span class="line-no">{{ row.oldNo ?? '' }}</span><span class="line-no">{{ row.newNo ?? '' }}</span>
          <span class="diff-sign">{{ row.type === 'add' ? '+' : row.type === 'del' ? '−' : ' ' }}</span><code>{{ row.text }}</code>
        </div>
      </div>
    </section>
    <template #footer><el-button @click="closeProposals">关闭</el-button></template>
  </el-dialog>
</template>

<style scoped>
.changeset-bar {
  background: var(--bg2);
  border-bottom: 1px solid var(--border);
  flex: none;
}
.cs-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px 4px;
}
.cs-head .el-button,
.cs-file .el-button {
  margin-left: 0;
}
.cs-title {
  font-weight: 600;
  font-size: 13px;
}
.cs-mode {
  font-size: 12px;
}
.cs-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  flex: none;
  padding: 0;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 6px;
  color: var(--fg-muted);
  cursor: pointer;
}
.cs-toggle:hover {
  background: var(--bg-hover);
  color: var(--fg);
}
.cs-chevron {
  transition: transform var(--motion-hover) var(--ease-standard);
}
.cs-chevron.collapsed {
  transform: rotate(-90deg);
}
.cs-summary {
  font-size: 12px;
  white-space: nowrap;
}
.cs-actions {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}
.cs-list {
  max-height: min(220px, 30vh);
  overflow-y: auto;
  padding: 2px 0 4px;
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--fg-muted) 38%, transparent) transparent;
}
.cs-list::-webkit-scrollbar {
  width: 8px;
}
.cs-list::-webkit-scrollbar-track {
  background: transparent;
}
.cs-list::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--fg-muted) 38%, transparent);
  border-radius: 4px;
}
.cs-list::-webkit-scrollbar-thumb:hover {
  background: color-mix(in srgb, var(--fg-muted) 60%, transparent);
}
.cs-file {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  column-gap: 8px;
  row-gap: 2px;
  padding: 4px 12px;
  border-radius: 6px;
  font-size: 12px;
}
.cs-file:hover {
  background: var(--bg-hover);
}
.cs-file.reviewing {
  background: rgba(76, 141, 255, 0.08);
}
.file-icon {
  color: var(--warn);
  font-family: var(--mono);
  font-size: 11px;
  flex: none;
}
.file-path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  /* 可伸缩：窄面板先压缩路径宽度，挤压到下限后按钮才换行，保证操作钮始终留在面板内 */
  flex: 1 1 120px;
  min-width: 0;
}
.badge {
  flex: none;
}
.adds {
  color: var(--accent);
  flex: none;
}
.dels {
  color: var(--danger);
  flex: none;
}
.rev-nav {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  flex: none;
}
.rev-btn {
  background: var(--bg3);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 2px 7px;
  font-size: 12px;
  color: var(--fg);
  cursor: pointer;
}
.rev-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.rev-pos {
  min-width: 34px;
  text-align: center;
  font-size: 11px;
  color: var(--fg-dim);
}
.proposal-note { margin-top: 0; }
.proposal-item + .proposal-item { margin-top: 18px; }
.proposal-head { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.proposal-head > span:first-child { margin-right: auto; }
.proposal-diff { max-height: 50vh; overflow: auto; border: 1px solid var(--border); border-radius: 6px; font-family: var(--mono); font-size: 12px; }
.proposal-row { display: flex; min-width: max-content; line-height: 1.65; }
.proposal-row.add { background: rgba(40, 167, 69, 0.13); }
.proposal-row.del { background: rgba(220, 53, 69, 0.13); }
.proposal-row .line-no { width: 42px; flex: none; color: var(--fg-dim); text-align: right; padding-right: 8px; user-select: none; }
.diff-sign { width: 20px; flex: none; text-align: center; user-select: none; }
.proposal-row code { white-space: pre; padding-right: 12px; }

/* ---- visual refinement layer (presentation only) ---- */
.changeset-bar { border-bottom-color: color-mix(in srgb, var(--border) 78%, var(--bg2)); background: color-mix(in srgb, var(--warn-soft) 30%, var(--bg2)); }
.cs-title { display: inline-flex; align-items: center; font-weight: 650; letter-spacing: .01em; }
.cs-title::before { content: ''; width: 7px; height: 7px; border-radius: 50%; background: var(--warn); box-shadow: 0 0 0 3px var(--warn-soft); margin-right: 8px; flex: none; }
.cs-mode { color: var(--fg-muted); }
.cs-file { border-radius: var(--radius-sm); transition: background-color var(--motion-hover) var(--ease-standard), box-shadow var(--motion-hover) var(--ease-standard); }
.cs-file.reviewing { background: var(--accent-soft); box-shadow: inset 2px 0 0 var(--accent); }
.file-icon { font-weight: 700; }
.adds { color: var(--success); font-weight: 650; font-variant-numeric: tabular-nums; }
.dels { color: var(--danger); font-weight: 650; font-variant-numeric: tabular-nums; }
.rev-btn { border-radius: 6px; transition: background-color var(--motion-hover) var(--ease-standard), border-color var(--motion-hover) var(--ease-standard), color var(--motion-hover) var(--ease-standard); }
.rev-btn:hover:not(:disabled) { background: var(--accent-soft); }
.rev-pos { font-variant-numeric: tabular-nums; }
.proposal-head { font-weight: 600; }
.proposal-head > span:first-child { letter-spacing: .01em; }
.proposal-diff { border-radius: var(--radius-sm); border-color: color-mix(in srgb, var(--border) 85%, var(--bg2)); scrollbar-width: thin; scrollbar-color: color-mix(in srgb, var(--fg-muted) 38%, transparent) transparent; }
.proposal-row.add { background: var(--success-soft); }
.proposal-row.del { background: var(--danger-soft); }
.proposal-row.add code { color: color-mix(in srgb, var(--success) 78%, var(--fg)); }
.proposal-row.del code { color: color-mix(in srgb, var(--danger) 82%, var(--fg)); }
.proposal-row .line-no { color: var(--fg-muted); font-variant-numeric: tabular-nums; }
.proposal-row .line-no + .line-no { border-right: 1px solid color-mix(in srgb, var(--border) 65%, transparent); margin-right: 6px; }
@media (prefers-reduced-motion: reduce) {
  .cs-file, .rev-btn, .cs-chevron, .cs-toggle { transition: none; }
}
@media (forced-colors: active) {
  .changeset-bar { background: Canvas; }
  .cs-title::before { background: CanvasText; box-shadow: none; }
  .cs-file.reviewing { box-shadow: none; }
}
</style>
