import { defineStore } from 'pinia';
import { api } from '../api.js';
import { useUiStore } from './ui.js';
import { detachProjectCollab, pendingProjectEdits, setPresenceListener, subscribeProjectPresence } from '../lib/collabClient.js';
import { editorRuntime } from '../lib/editorRuntime.js';
import { useProjectContext } from '../lib/projectContext.js';
import { computeInlineDiff } from '../lib/diffDecorations.js';
import { changesetFileApplied } from '../lib/changesetUtils.js';

const COMPILE_SETTINGS_TIMEOUT_MS = 30 * 1000;
const treeControllers = new WeakMap();
const projectStartupTimers = new WeakMap();
const reviewRefreshes = new WeakMap();
const reviewMutations = new WeakMap();
const reviewNotifications = new WeakMap();
function notificationsFor(store) {
  let state = reviewNotifications.get(store);
  if (!state || state.projectId !== store.projectId || state.projectVersion !== store.projectVersion) {
    state = { projectId: store.projectId, projectVersion: store.projectVersion, ids: new Set(), pending: false };
    reviewNotifications.set(store, state);
  }
  return state;
}
const editorContexts = new WeakMap();
export function bindEditorContext(store, { runtime, projectId }) {
  editorContexts.get(store)?.unsubscribe?.();
  const unsubscribe = subscribeProjectPresence(projectId, (users) => { store.onlineUsers = users; });
  editorContexts.set(store, { runtime, unsubscribe });
}
export function releaseEditorContext(store) {
  editorContexts.get(store)?.unsubscribe?.();
  editorContexts.delete(store);
}
function snapshotHunks(base, current) {
  return computeInlineDiff(base, current, { mergeGap: 0 }).hunks.map(({ ranges, ...hunk }) => hunk);
}

// 协同 awareness 聚合 → 项目在线协作者列表（模块级一次性注册）
setPresenceListener((users) => {
  try {
    useEditorStore().onlineUsers = users;
  } catch { /* store 未就绪 */ }
});

/**
 * 编辑器页核心状态。所有编辑器子组件以此为数据契约。
 */
const editorOptions = {
  state: () => ({
    projectId: null,
    projectVersion: 0, // reset 后使旧项目的异步响应失效
    reviewRequest: 0,
    pendingRequest: 0,
    project: null,
    myRole: null,
    readOnly: false,
    tree: [],
    treeLoading: false,
    treeLoaded: false,
    treeError: '',
    treeRequest: 0,
    openFiles: [], // [path]
    activeFile: '',
    sidebar: 'tree', // 'tree' | 'search' | 'review' | 'agent' | null
    // 右侧共用面板的当前标签：'pdf' | 'info' | 'versions' | 'log' | null（null = 面板收起）
    rightTab: localStorage.getItem('corelatex.pdfVisible') === '0' ? null : 'pdf',
    // 审阅模式：编辑器只读，选中内容可添加批注；持久化记忆
    reviewMode: localStorage.getItem('corelatex.reviewMode') === '1',
    outline: [],
    cursorLine: 0,
    cursorCol: 0,
    // 编辑器当前选中片段（CodeEditor 同步写入），供智能体面板把选中内容附加为请求对象
    selection: null, // { file, from, to, startLine, endLine, text } | null
    viewMode: 'code', // 'code' | 'visual'
    // Code/Visual 切换时的文档进度锚点（0-1：代码侧=首个可见行占比，Visual 侧=内容高度占比）。
    // 一侧卸载时写入，另一侧挂载后消费，实现"翻到哪段就看到对应渲染部分"
    pendingViewAnchor: null,
    // 重进项目时待恢复的各文件阅读进度（localStorage 快照,EditorView 恢复 openFiles 后写入;
    // 每个路径被其首次激活消费一次后移除）。顶层字段保证 init() 的 $reset 自动清理
    restoredAnchors: {},
    // 编辑器字号（Code 视图像素值；Visual 视图按 /13 的比例同步缩放），Ctrl+滚轮调整，持久化记忆
    editorFontSize: Number(localStorage.getItem('corelatex.editorFontSize')) || 13,
    // 变更集审阅态：非 null 时编辑区显示该文件的行内 diff（替代弹窗）
    reviewBusy: false,
    diffReview: null, // { changesetIds, filePath, base, hunks, ... }
    compileSettingsSaving: false,
    compile: {
      status: 'idle', // idle | running | success | failed
      errors: [],
      warnings: [],
      pdfUrl: '',
      pdfJobId: null,
      logUrl: '',
      jobId: null,
      durationMs: 0,
    },
    pdfStamp: 0,
    stats: null,
    versions: [],
    versionsStamp: 0, // 版本列表刷新信号（编译成功自动快照后递增）
    reviews: [],
    pendingChangesets: [],
    logContent: '',
    treeVersion: 0, // 树刷新信号
    workspaceVersion: 0, // 独立工作区目录的轻量失效信号
    // 搜索面板的当前文件命中（OverviewBar 标注 + CodeEditor 高亮用）
    searchMatches: null, // { file, items: [{ line, col, len }] } | null
    // 协作信息：项目在线协作者（awareness 聚合）与项目成员总数（含拥有者）
    onlineUsers: [], // [{ name, color }]
    memberCount: 0,
  }),
  getters: {
    // 编辑锁定：项目级只读（归档/viewer）或审阅模式开启时，编辑器不可改内容
    editingLocked: (s) => !!(s.readOnly || s.reviewMode),
  },
  actions: {
    isCurrentProject(projectId, version) {
      return this.projectId === projectId && this.projectVersion === version;
    },
    async loadMembers() {
      const { projectId, projectVersion } = this;
      if (!projectId) return;
      try {
        const r = await api.get(`/api/projects/${projectId}/members`);
        if (!this.isCurrentProject(projectId, projectVersion)) return;
        // 成员总数 = 拥有者 + 共享成员（拥有者不重复出现在 members 里）
        this.memberCount = 1 + (r.members?.length || 0);
      } catch {
        if (this.isCurrentProject(projectId, projectVersion)) this.memberCount = 0;
      }
    },
    async init(projectId) {
      const pendingChangesets = this.projectId === String(projectId) ? this.pendingChangesets : null;
      this.reset();
      // A restored background workspace can already have fetched its pending
      // reviews. Keep them visible until this editor refreshes the same list.
      if (pendingChangesets) this.pendingChangesets = pendingChangesets;
      // projectId 参数是项目唯一哈希 publicId(数字编号已不再解析):
      // 全部 API 路径与协同房间都携带该哈希,服务端按 public_id 解析
      const version = this.projectVersion;
      let response;
      try {
        response = await api.get(`/api/projects/${projectId}?summary=1`);
      } catch (error) {
        if (this.projectVersion !== version) return false;
        throw error;
      }
      if (this.projectVersion !== version) return false;
      const { project, myRole } = response;
      this.projectId = project.publicId || String(project.id);
      this.project = project;
      this.myRole = myRole;
      this.readOnly = project.archived || project.deleted || myRole === 'viewer';
      // 只读项目（归档）不提供审阅入口：强制退出审阅模式并清理本地记忆
      if (this.readOnly && this.reviewMode) this.setReviewMode(false);
      // The main document must not wait for a potentially large directory scan
      // or for comments; both are independent and may finish later.
      if (project.mainFile) this.openFile(project.mainFile);
      const currentProjectId = this.projectId;
      const timer = setTimeout(() => {
        if (projectStartupTimers.get(this) === timer) projectStartupTimers.delete(this);
        if (!this.isCurrentProject(currentProjectId, version)) return;
        this.loadMembers();
        this.loadTree().catch(() => {});
        this.loadReviews().catch(() => {});
        this.loadPublishedPdf();
      }, 0);
      projectStartupTimers.set(this, timer);
      return true;
    },
    reset() {
      const version = this.projectVersion + 1;
      clearTimeout(projectStartupTimers.get(this));
      projectStartupTimers.delete(this);
      treeControllers.get(this)?.abort();
      treeControllers.delete(this);
      if (this.projectId) detachProjectCollab(this.projectId);
      reviewMutations.delete(this);
      reviewRefreshes.delete(this);
      reviewNotifications.delete(this);
      this.$reset();
      this.projectVersion = version;
    },
    async loadTree() {
      const { projectId, projectVersion } = this;
      if (!projectId) return false;
      const request = ++this.treeRequest;
      treeControllers.get(this)?.abort();
      const controller = new AbortController();
      treeControllers.set(this, controller);
      this.treeLoading = true;
      this.treeError = '';
      try {
        // _workspace is listed separately, on demand, by WorkspacePanel.
        const { tree } = await api.get(`/api/projects/${projectId}/tree?excludeWorkspace=1`, { signal: controller.signal });
        if (!this.isCurrentProject(projectId, projectVersion) || request !== this.treeRequest) return false;
        if (!Array.isArray(tree)) throw new Error('文件列表格式无效');
        this.tree = tree;
        this.treeLoaded = true;
        this.treeVersion++;
        return true;
      } catch (error) {
        if (!this.isCurrentProject(projectId, projectVersion) || request !== this.treeRequest) return false;
        this.treeError = error?.message || '项目文件加载失败';
        throw error;
      } finally {
        if (treeControllers.get(this) === controller) treeControllers.delete(this);
        if (this.isCurrentProject(projectId, projectVersion) && request === this.treeRequest) this.treeLoading = false;
      }
    },
    markWorkspaceChanged() { this.workspaceVersion++; },
    openFile(path) {
      if (!this.openFiles.includes(path)) this.openFiles.push(path);
      this.activeFile = path;
    },
    closeFile(path) {
      const i = this.openFiles.indexOf(path);
      if (i >= 0) this.openFiles.splice(i, 1);
      if (this.activeFile === path) {
        this.activeFile = this.openFiles[Math.max(0, i - 1)] || '';
      }
    },
    async renamePath(path, newPath) {
      const { projectId, projectVersion } = this;
      const result = await api.patch(`/api/projects/${projectId}/files`, { path, newPath });
      if (!this.isCurrentProject(projectId, projectVersion)) return false;
      this.applyRenamedPath(result.path || path, result.newPath || newPath, result.mainFile);
      return true;
    },
    applyRenamedPath(path, newPath, mainFile) {
      const moved = (file) => typeof file !== 'string' ? file : file === path ? newPath : file.startsWith(path + '/') ? newPath + file.slice(path.length) : file;
      const remapAnchors = (anchors) => Object.fromEntries(Object.entries(anchors || {}).map(([file, value]) => [moved(file), value]));
      // Switching every tab releases old collaboration rooms and loads the new
      // paths from the server; never copy stale editor text into the new file.
      this.openFiles = [...new Set(this.openFiles.map(moved))];
      this.activeFile = moved(this.activeFile);
      if (this.project) this.project.mainFile = mainFile ?? moved(this.project.mainFile);
      this.restoredAnchors = remapAnchors(this.restoredAnchors);
      this.reviews = this.reviews.map(review => ({ ...review, filePath: moved(review.filePath) }));
      if (this.selection && moved(this.selection.file) !== this.selection.file) this.selection = null;
      if (this.searchMatches && moved(this.searchMatches.file) !== this.searchMatches.file) this.searchMatches = null;
      // Pending review-base requests must not reopen the old path after rename.
      ++this.reviewRequest;
      if (this.diffReview && moved(this.diffReview.filePath) !== this.diffReview.filePath) this.closeDiffReview();
      try {
        const key = `corelatex.view.${this.projectId}`;
        const saved = this.restoreViewState();
        saved.file = this.activeFile;
        saved.openFiles = [...this.openFiles];
        saved.anchors = remapAnchors(saved.anchors);
        localStorage.setItem(key, JSON.stringify(saved));
      } catch { /* Moving a file remains available when storage is unavailable. */ }
      this.loadPendingChangesets();
    },
    setSidebar(name) {
      this.sidebar = this.sidebar === name ? null : name;
    },
    setRightTab(name) {
      this.rightTab = this.rightTab === name ? null : name;
      if (this.rightTab === 'info') this.loadStats();
      if (this.rightTab === 'versions') this.loadVersions();
      if (this.rightTab === 'log') this.loadLog();
    },
    setReviewMode(on) {
      this.reviewMode = !!on;
      localStorage.setItem('corelatex.reviewMode', this.reviewMode ? '1' : '0');
    },
    setEditorFontSize(n) {
      const v = Math.min(28, Math.max(10, Math.round(Number(n) || 13)));
      this.editorFontSize = v;
      localStorage.setItem('corelatex.editorFontSize', String(v));
    },
    async openDiffReview(changesetIds, filePath, applied = true, auto = false) {
      if (this.reviewBusy) return false;
      const { projectId, projectVersion } = this;
      const request = ++this.reviewRequest;
      const snapshot = await api.get(`/api/projects/${projectId}/review/base?file=${encodeURIComponent(filePath)}`, { cache: 'no-store' });
      if (!this.isCurrentProject(projectId, projectVersion) || request !== this.reviewRequest) return false;
      if (!snapshot.pending || snapshot.deleted) {
        if (this.diffReview?.filePath === filePath) this.closeDiffReview();
        this.loadPendingChangesets();
        return false;
      }
      if (typeof snapshot.current !== 'string' || snapshot.revision == null) throw new Error('审阅快照不完整，请重新加载');
      const base = snapshot.base ?? '';
      const hunks = snapshotHunks(base, snapshot.current);
      this.diffReview = {
        changesetIds, filePath, applied, base, current: snapshot.current, revision: snapshot.revision,
        // -1 means no hunk has been selected; navigation starts at the first/last hunk.
        hunks, hunkIdx: -1, signal: 0,
        stale: false, refreshing: false, busy: false,
        resume: auto, noJump: auto,
      };
      return true;
    },
    _applyReviewSnapshot(dr, snapshot) {
      if (this.diffReview !== dr) return false;
      if (!snapshot.pending || snapshot.deleted) {
        this.closeDiffReview();
        return true;
      }
      if (typeof snapshot.current !== 'string' || snapshot.revision == null) throw new Error('审阅快照不完整，请重新加载');
      dr.base = snapshot.base ?? '';
      dr.current = snapshot.current;
      dr.revision = snapshot.revision;
      dr.hunks = snapshotHunks(dr.base, dr.current);
      dr.hunkIdx = dr.hunks.length ? Math.min(Math.max(dr.hunkIdx, -1), dr.hunks.length - 1) : -1;
      dr.stale = false;
      dr.keepPos = true;
      dr.signal++;
      return true;
    },
    refreshDiffReview({ quiet = false } = {}) {
      const dr = this.diffReview;
      if (!dr) return Promise.resolve(false);
      const existing = reviewRefreshes.get(this);
      if (existing?.review === dr && existing.request === this.reviewRequest) return existing.promise;
      const { projectId, projectVersion } = this;
      const request = ++this.reviewRequest;
      dr.stale = true;
      dr.refreshing = true;
      dr.signal++;
      let promise;
      promise = (async () => {
        try {
          const snapshot = await api.get(`/api/projects/${projectId}/review/base?file=${encodeURIComponent(dr.filePath)}`, { cache: 'no-store' });
          if (!this.isCurrentProject(projectId, projectVersion) || this.diffReview !== dr || request !== this.reviewRequest) return false;
          const applied = this._applyReviewSnapshot(dr, snapshot);
          if (applied && !snapshot.pending) this.loadPendingChangesets();
          return applied;
        } catch (error) {
          if (this.isCurrentProject(projectId, projectVersion) && this.diffReview === dr && !quiet) useUiStore().error(error.message || '刷新审阅失败');
          return false;
        } finally {
          if (reviewRefreshes.get(this)?.promise === promise) {
            if (this.diffReview === dr) { dr.refreshing = false; dr.signal++; }
            reviewRefreshes.delete(this);
          }
        }
      })();
      reviewRefreshes.set(this, { review: dr, request, promise });
      return promise;
    },
    invalidateDiffReview(filePath) {
      const dr = this.diffReview;
      if (!dr || dr.filePath !== filePath) return;
      dr.stale = true;
      dr.signal++;
    },
    // Empty local hunks are never authority to accept server changesets.
    setDiffReviewHunks(hunks, keepPos = false) {
      if (!this.diffReview) return;
      this.diffReview.hunks = hunks.map(({ ranges, ...hunk }) => hunk);
      this.diffReview.hunkIdx = hunks.length ? Math.min(Math.max(this.diffReview.hunkIdx, -1), hunks.length - 1) : -1;
      this.diffReview.keepPos = keepPos;
      this.diffReview.signal++;
    },
    navDiffHunk(dir) {
      const dr = this.diffReview;
      const n = dr?.hunks?.length || 0;
      if (!n || this.reviewBusy || dr.busy || dr.refreshing || dr.stale) return;
      dr.hunkIdx = dr.hunkIdx < 0
        ? (dir < 0 ? n - 1 : 0)
        : ((dr.hunkIdx + dir) % n + n) % n;
      dr.keepPos = dr.resume = dr.noJump = false;
      dr.signal++;
    },
    // 直接跳到指定修改块（状态条点击用）
    gotoDiffHunk(i) {
      const dr = this.diffReview;
      const n = dr?.hunks?.length || 0;
      if (!n || this.reviewBusy || dr.busy || dr.refreshing || dr.stale) return;
      dr.hunkIdx = Math.max(0, Math.min(n - 1, Number(i) || 0));
      dr.keepPos = dr.resume = dr.noJump = false;
      dr.signal++;
    },
    _invalidateReviewReads() {
      ++this.reviewRequest;
      ++this.pendingRequest;
    },
    _beginReviewMutation() {
      if (this.reviewBusy || this.diffReview?.busy) return null;
      const token = { projectId: this.projectId, projectVersion: this.projectVersion };
      reviewMutations.set(this, token);
      this.reviewBusy = true;
      this._invalidateReviewReads();
      // Reconcile after the write, including notifications received while it
      // was in flight. They are never discarded or applied as old snapshots.
      notificationsFor(this).pending = true;
      return token;
    },
    async _endReviewMutation(token) {
      if (reviewMutations.get(this) !== token) return;
      if (!this.isCurrentProject(token.projectId, token.projectVersion)) {
        reviewMutations.delete(this);
        return;
      }
      this._invalidateReviewReads();
      const notifications = notificationsFor(this);
      let refreshed = false;
      // Keep the operation locked until the server state after the write is
      // visible. A notification arriving during this read queues one more read.
      while (notifications.pending && reviewMutations.get(this) === token) {
        refreshed = await this.loadPendingChangesets({ mutation: token });
        if (!refreshed) break;
      }
      if (reviewMutations.get(this) !== token || !this.isCurrentProject(token.projectId, token.projectVersion)) return;
      reviewMutations.delete(this);
      this._invalidateReviewReads();
      this.reviewBusy = false;
      if (refreshed) this._autoReviewNotifications(notifications);
    },
    async resolveCurrentHunk(action) {
      const dr = this.diffReview;
      const view = (editorContexts.get(this)?.runtime || editorRuntime).view;
      if (!dr || !view || dr.busy || dr.refreshing || this.reviewBusy || dr.hunkIdx < 0) return false;
      const token = this._beginReviewMutation();
      if (!token) return false;
      const { projectId, projectVersion } = this;
      dr.busy = true;
      try {
        if (dr.stale || view.state.doc.toString() !== dr.current) {
          this.invalidateDiffReview(dr.filePath);
          useUiStore().error('文档已变化，正在刷新审阅。请核对最新修改后重试。');
          await this.refreshDiffReview({ quiet: true });
          return false;
        }
        const hunk = dr.hunks[dr.hunkIdx];
        if (!hunk || dr.revision == null) return false;
        const snapshot = await api.post(`/api/projects/${projectId}/review/hunk`, {
          file: dr.filePath, action, revision: dr.revision, current: dr.current,
          baseFrom: hunk.baseFrom, baseTo: hunk.baseTo, docFrom: hunk.docFrom, docTo: hunk.docTo,
        });
        if (!this.isCurrentProject(projectId, projectVersion) || this.diffReview !== dr) return false;
        this._invalidateReviewReads();
        if (Array.isArray(snapshot.changesets)) this.pendingChangesets = snapshot.changesets;
        // Keep the reading position without implicitly selecting a remaining hunk.
        dr.hunkIdx = -1;
        this._applyReviewSnapshot(dr, snapshot);
        this.loadPendingChangesets();
        return true;
      } catch (error) {
        if (this.isCurrentProject(projectId, projectVersion) && this.diffReview === dr) {
          useUiStore().error(error.message || '处理修改失败，未确认此次操作');
          if (error.status === 409) await this.refreshDiffReview({ quiet: true });
        }
        return false;
      } finally {
        if (this.diffReview === dr) dr.busy = false;
        await this._endReviewMutation(token);
      }
    },
    saveCurrentHunk() { return this.resolveCurrentHunk('accept'); },
    revertCurrentHunk() { return this.resolveCurrentHunk('revert'); },
    setDiffReviewFile(filePath) {
      if (this.diffReview) this.diffReview.filePath = filePath;
    },
    closeDiffReview() {
      ++this.reviewRequest;
      this.diffReview = null;
    },
    // —— 阅读进度记忆:刷新/重进项目后恢复到上次浏览的文件与位置 ——
    // anchors[path] = 首个可见行占比(0~1),由 CodeEditor 滚动防抖写入
    setViewAnchor(path, ratio) {
      if (!this.projectId || !path) return;
      try {
        const key = `corelatex.view.${this.projectId}`;
        const raw = JSON.parse(localStorage.getItem(key) || '{}');
        raw.anchors = raw.anchors || {};
        raw.anchors[path] = ratio;
        localStorage.setItem(key, JSON.stringify(raw));
      } catch { /* 存储不可用时忽略 */ }
    },
    saveViewState() {
      if (!this.projectId) return;
      try {
        const key = `corelatex.view.${this.projectId}`;
        const raw = this.restoreViewState();
        // An explicitly empty workspace is a preference, not missing data.
        raw.file = this.activeFile;
        raw.openFiles = [...this.openFiles];
        localStorage.setItem(key, JSON.stringify(raw));
      } catch { /* 存储不可用时忽略 */ }
    },
    restoreViewState() {
      if (!this.projectId) return {};
      try {
        const saved = JSON.parse(localStorage.getItem(`corelatex.view.${this.projectId}`) || '{}');
        return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
      } catch { return {}; }
    },
    async saveCompileSettings(settings) {
      const { projectId, projectVersion } = this;
      if (!projectId) return false;
      if (this.compileSettingsSaving) throw new Error('编译设置正在保存，请稍后重试。');
      this.compileSettingsSaving = true;
      const controller = new AbortController();
      const deadline = setTimeout(() => controller.abort(), COMPILE_SETTINGS_TIMEOUT_MS);
      try {
        const saved = await api.patch(`/api/projects/${projectId}/compile/settings`, settings, { signal: controller.signal });
        if (!this.isCurrentProject(projectId, projectVersion) || !this.project) return false;
        if ((settings.engine !== undefined && (typeof saved?.engine !== 'string' || !saved.engine))
          || (settings.texVersion !== undefined && (typeof saved?.texVersion !== 'string' || !saved.texVersion))) {
          throw new Error('编译设置保存结果无效，请刷新后确认。');
        }
        if (settings.engine !== undefined) this.project.compileEngine = saved.engine;
        if (settings.texVersion !== undefined) this.project.texVersion = saved.texVersion;
        return true;
      } catch (error) {
        if (controller.signal.aborted) throw new Error('保存编译设置超时，结果可能已生效，请刷新后确认。');
        throw error;
      } finally {
        clearTimeout(deadline);
        if (this.isCurrentProject(projectId, projectVersion)) this.compileSettingsSaving = false;
      }
    },
    async compileProject(engine, texVersion) {
      if (this.compile.status === 'running' || !this.projectId) return;
      if (this.compileSettingsSaving) throw new Error('编译设置正在保存，请稍后重试。');
      const { projectId, projectVersion } = this;
      const selectedEngine = engine || this.project?.compileEngine;
      const selectedVersion = texVersion || this.project?.texVersion;
      this.compile.status = 'running';
      this.compile.errors = [];
      this.compile.warnings = [];
      const controller = new AbortController();
      const deadline = setTimeout(() => controller.abort(), 10 * 60 * 1000);
      try {
        const saving = pendingProjectEdits(projectId, controller.signal);
        if (saving) await saving;
        if (!this.isCurrentProject(projectId, projectVersion)) return;
        const r = await api.post(`/api/projects/${projectId}/compile`, { ...(selectedEngine ? { engine: selectedEngine } : {}), ...(selectedVersion ? { texVersion: selectedVersion } : {}), persistSelection: false }, { signal: controller.signal });
        if (!this.isCurrentProject(projectId, projectVersion)) return;
        this.compile = {
          status: r.status,
          errors: r.errors || [],
          warnings: r.warnings || [],
          pdfUrl: r.status === 'success' ? r.pdfUrl || '' : this.compile.pdfUrl,
          pdfJobId: r.status === 'success' ? r.pdfJobId ?? null : this.compile.pdfJobId,
          logUrl: r.logUrl || '',
          jobId: r.jobId,
          durationMs: r.durationMs || 0,
          texVersion: r.texVersion || this.project?.texVersion || '2024',
        };
        if (r.status === 'success') {
          this.pdfStamp++;
          this.versionsStamp++;
        }
        this.loadStats();
        if (this.rightTab === 'log') this.loadLog();
      } catch (e) {
        if (!this.isCurrentProject(projectId, projectVersion)) return;
        const error = controller.signal.aborted
          ? new Error('等待编译结果超时，服务器可能仍在处理，请稍后查看日志。')
          : e;
        this.compile.status = 'failed';
        this.compile.errors = [{ source: 'request', file: '', line: 0, message: error?.message || '编译失败' }];
        throw error;
      } finally { clearTimeout(deadline); }
    },
    async loadPublishedPdf() {
      const { projectId, projectVersion, pdfStamp } = this;
      if (!projectId || this.compile.pdfUrl) return;
      try {
        const r = await api.get(`/api/projects/${projectId}/compile/output`);
        if (!this.isCurrentProject(projectId, projectVersion) || this.pdfStamp !== pdfStamp
            || this.compile.pdfUrl || !r?.pdfUrl) return;
        this.compile.pdfUrl = r.pdfUrl;
        this.compile.pdfJobId = r.pdfJobId ?? null;
        this.pdfStamp++;
      } catch { /* The project may have no successful build yet. */ }
    },
    async loadStats() {
      const { projectId, projectVersion } = this;
      if (!projectId) return;
      try {
        const stats = await api.get(`/api/projects/${projectId}/stats`);
        if (this.isCurrentProject(projectId, projectVersion)) this.stats = stats;
      } catch {}
    },
    async loadVersions() {
      const { projectId, projectVersion } = this;
      if (!projectId) return;
      const r = await api.get(`/api/projects/${projectId}/versions`);
      if (this.isCurrentProject(projectId, projectVersion)) this.versions = r.versions;
    },
    async loadLog() {
      const { projectId, projectVersion } = this;
      if (!projectId) return;
      try {
        const res = await api.raw(this.compile.logUrl || `/api/projects/${projectId}/log`);
        const text = await res.text();
        if (this.isCurrentProject(projectId, projectVersion)) this.logContent = text;
      } catch {
        if (this.isCurrentProject(projectId, projectVersion)) this.logContent = '';
      }
    },
    async loadReviews() {
      const { projectId, projectVersion } = this;
      if (!projectId) return;
      const r = await api.get(`/api/projects/${projectId}/reviews`);
      if (this.isCurrentProject(projectId, projectVersion)) this.reviews = r.reviews;
    },
    async addReview({ filePath, start, end, quotedText, content }) {
      const r = await api.post(`/api/projects/${this.projectId}/reviews`, {
        filePath, start, end, quotedText, content,
      });
      await this.loadReviews();
      return r.review;
    },
    async resolveReview(id) {
      await api.post(`/api/projects/${this.projectId}/reviews/${id}/resolve`);
      await this.loadReviews();
    },
    async deleteReview(id) {
      await api.del(`/api/projects/${this.projectId}/reviews/${id}`);
      await this.loadReviews();
    },
    // Persisted SSE bodies describe their creation time, not current review
    // state. Treat them as notifications and read the authoritative state.
    reconcileChangeset(cs) {
      if (cs?.id != null) notificationsFor(this).ids.add(String(cs.id));
      return this.loadPendingChangesets();
    },
    async loadPendingChangesets({ mutation = null } = {}) {
      const { projectId, projectVersion } = this;
      if (!projectId) return false;
      const notifications = notificationsFor(this);
      if (this.reviewBusy && (!mutation || reviewMutations.get(this) !== mutation)) { notifications.pending = true; return false; }
      notifications.pending = false;
      const request = ++this.pendingRequest;
      try {
        const r = await api.get(`/api/projects/${projectId}/changesets?status=pending`, { cache: 'no-store' });
        if (!this.isCurrentProject(projectId, projectVersion) || request !== this.pendingRequest) return false;
        this.pendingChangesets = r.changesets || [];
      } catch { return false; /* 刷新失败时保留现有审阅 */ }
      const dr = this.diffReview;
      if (dr) {
        const matching = this.pendingChangesets.filter((c) =>
          c.files?.some((f) => f.filePath === dr.filePath &&
            (!f.status || f.status === 'pending') && changesetFileApplied(c, f)));
        if (matching.length) dr.changesetIds = matching.map((c) => c.id);
        else this.closeDiffReview();
      }
      if (!this.reviewBusy) this._autoReviewNotifications(notifications);
      return true;
    },
    _autoReviewNotifications(notifications) {
      const notified = this.pendingChangesets.filter(cs => notifications.ids.has(String(cs.id)));
      notifications.ids.clear();
      for (const cs of notified) this._autoReviewChangeset(cs);
    },
    upsertChangeset(cs) {
      ++this.pendingRequest; // A successful write response supersedes earlier list reads.
      const i = this.pendingChangesets.findIndex((c) => c.id === cs.id);
      if (cs.status === 'pending') {
        if (i >= 0) this.pendingChangesets.splice(i, 1, cs);
        else this.pendingChangesets.push(cs);
      } else if (i >= 0) {
        this.pendingChangesets.splice(i, 1);
      }
      this._autoReviewChangeset(cs);
    },
    _autoReviewChangeset(cs) {
      // agent 新一轮修改完成 → 自动进入/刷新当前打开文件的审阅(高亮实时出现,无需手动点审查)。
      // 关联该文件的全部待确认变更集:审阅完成后一次性清理,不留僵尸记录。
      // 只出现高亮，不定位滚动；用户导航时才选中并跳到修改处。
      if (
        !this.reviewBusy && cs.status === 'pending' &&
        this.activeFile &&
        cs.files?.some((f) => f.filePath === this.activeFile &&
          (!f.status || f.status === 'pending') && changesetFileApplied(cs, f))
      ) {
        const ids = this.pendingChangesets
          .filter((c) => c.status === 'pending' && c.files?.some((f) =>
            f.filePath === this.activeFile && (!f.status || f.status === 'pending') && changesetFileApplied(c, f)))
          .map((c) => c.id);
        this.openDiffReview(ids.length ? ids : [cs.id], this.activeFile, true, true).catch(() => {});
      }
    },
    async _requestChangesetResolution(action, id, filePath, refreshTree = true, expectedRevision = 0) {
      const { projectId, projectVersion } = this;
      const r = await api.post(`/api/projects/${projectId}/changesets/${id}/${action}`, { ...(filePath ? { filePath } : {}), expectedRevision });
      if (!this.isCurrentProject(projectId, projectVersion)) return false;
      this._invalidateReviewReads();
      if (r.changeset) this.upsertChangeset(r.changeset);
      else await this.loadPendingChangesets();
      if (refreshTree) await this.loadTree();
      return true;
    },
    async _resolveSingleChangeset(action, id, filePath, expectedRevision) {
      // The dialog passes the revision of the diff it actually displayed.
      // Other actions bind once at their start, before any write or refresh.
      const revision = expectedRevision ?? this.pendingChangesets.find(cs => String(cs.id) === String(id))?.proposalRevision ?? 0;
      const token = this._beginReviewMutation();
      if (!token) return false;
      try { return await this._requestChangesetResolution(action, id, filePath, true, revision); }
      finally { await this._endReviewMutation(token); }
    },
    acceptChangeset(id, filePath, expectedRevision) { return this._resolveSingleChangeset('accept', id, filePath, expectedRevision); },
    revertChangeset(id, filePath, expectedRevision) { return this._resolveSingleChangeset('revert', id, filePath, expectedRevision); },
    async resolvePendingChangesets(action, { filePath = null, appliedOnly = false } = {}) {
      if (!['accept', 'revert'].includes(action)) throw new Error('未知审阅操作');
      const token = this._beginReviewMutation();
      if (!token) return false;
      const { projectId, projectVersion } = this;
      const current = () => this.isCurrentProject(projectId, projectVersion);
      let progressed = false;
      try {
        const appliedText = new Set(), legacy = [], seen = new Set();
        for (const cs of this.pendingChangesets || []) {
          for (const file of cs.files || []) {
            if ((file.status && file.status !== 'pending') || (filePath && file.filePath !== filePath)) continue;
            const applied = changesetFileApplied(cs, file);
            if (appliedOnly && !applied) continue;
            if (applied && !file.binary) appliedText.add(file.filePath);
            else {
              const key = `${cs.id}:${file.filePath}`;
              if (!seen.has(key)) { seen.add(key); legacy.push({ id: cs.id, filePath: file.filePath, expectedRevision: cs.proposalRevision ?? 0 }); }
            }
          }
        }
        const snapshots = await Promise.all([...appliedText].map(async path => {
          const snapshot = await api.get(`/api/projects/${projectId}/review/base?file=${encodeURIComponent(path)}`, { cache: 'no-store' });
          if (!snapshot.pending) return null;
          if (snapshot.revision == null || typeof snapshot.current !== 'string') throw new Error('审阅快照不完整，请刷新后重试');
          return { filePath: path, revision: snapshot.revision, current: snapshot.current };
        }));
        if (!current()) return false;
        const files = snapshots.filter(Boolean);
        if (files.length) {
          // One batch compares every current revision before applying any file.
          const result = await api.post(`/api/projects/${projectId}/review/resolve`, { action, files });
          if (!current()) return false;
          progressed = (result.results || []).some(item => item.resolved);
          this._invalidateReviewReads();
          if (Array.isArray(result.changesets)) this.pendingChangesets = result.changesets;
          if (this.diffReview && (result.results || []).some(item => item.filePath === this.diffReview.filePath && !item.pending)) this.closeDiffReview();
        }
        // Proposals and binaries retain their stricter historical whole-file checks.
        // Reverse undo order so a newer applied binary can roll back to its predecessor.
        for (const item of action === 'revert' ? legacy.reverse() : legacy) {
          if (!current()) return false;
          if (!await this._requestChangesetResolution(action, item.id, item.filePath, false, item.expectedRevision)) return false;
          progressed = true;
        }
        if (!current()) return false;
        await this.loadTree();
        return current();
      } catch (error) {
        if (progressed && error && typeof error === 'object') error.reviewPartial = true;
        throw error;
      } finally { await this._endReviewMutation(token); }
    },
  },
};
const useDefaultEditorStore = defineStore('editor', editorOptions);
export function createProjectEditorStore(key, pinia) {
  return defineStore(`editor.project.${key}`, editorOptions)(pinia);
}
export function useEditorStore(pinia) {
  if (!pinia) {
    const context = useProjectContext();
    if (context?.editor) return context.editor;
  }
  return useDefaultEditorStore(pinia);
}
useEditorStore.$id = 'editor';
