import { defineStore } from 'pinia';
import { useProjectContext } from '../lib/projectContext.js';
import { api, ssePost, sseGet, getToken, ApiError } from '../api.js';
import { useEditorStore } from './editor.js';
import { useUiStore } from './ui.js';
import { useAuthStore } from './auth.js';
import { modelReasoningLevels, modelReasoningEffort, reasoningLevelLabel } from '../lib/settings.js';
import { legacyReasoningPreferences } from '../lib/agentReasoningPreferences.js';
import { agentProjectPreferenceKey, readProjectPreferences, saveProjectPreferences, validAgentAccount } from '../lib/agentProjectPreferences.js';
import { truncateContext, parseToolCalls, pickAgentMetadata, pickDraftRecovery } from '../lib/agentUtils.js';
import { orderRunInputs, isRunInput } from '../lib/agentRunInputs.js';
import { isWorkflowGraph } from '../lib/agentWorkflow.js';
import { pendingProjectEdits } from '../lib/collabClient.js';
import { notifyAgentCompletion, notifyAgentQuestion, getCompletionSoundRevision, syncCompletionSoundPreference } from '../lib/agentCompletionSound.js';

const CONTEXT_MAX = 12000;
const TERMINAL_RUN_STATES = new Set(['completed', 'cancelled', 'failed', 'interrupted']);
const MAX_RECONNECT_ATTEMPTS = 5;
const RUN_STATUS_TIMEOUT_MS = 10_000;
const ACCOUNT_CHANGED = '登录状态已变化，请刷新页面后再试';
function createRequestId() {
  if (globalThis.crypto.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function reconnectDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new DOMException('aborted', 'AbortError')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

function validContextUsage(usage) {
  return Number.isFinite(usage?.usedTokens) && usage.usedTokens >= 0 &&
    Number.isFinite(usage.maxTokens) && usage.maxTokens > 0 && typeof usage.modelId === 'string' &&
    Number.isFinite(usage.updatedAt) && typeof usage.estimated === 'boolean'
    ? usage : null;
}

function matchesContextModel(usage, model) {
  return !!usage && !!model && usage.modelId === model.id &&
    (!Number.isFinite(model.contextLength) || usage.maxTokens === model.contextLength) &&
    (!model.contextModelKey || usage.modelKey === model.contextModelKey);
}

function contextSelection(model) {
  return model ? JSON.stringify([model.id, model.contextLength, model.contextModelKey]) : '';
}

function contextUsagePriority(usage) {
  return usage.basis === 'history' ? 2 : usage.estimated ? 0 : 1;
}

// api.js 暂无 put 封装，而契约要求 PUT /settings/ai，这里用 fetch 直发
async function putJson(path, body) {
  const res = await fetch(path, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getToken()}`,
    },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || `请求失败 (${res.status})`);
  return data;
}

// 请求/流句柄按 store 实例隔离，不放进 Vue 响应式状态。
const runtimes = new WeakMap();
function runtime(store) {
  let state = runtimes.get(store);
  if (!state) {
    state = {
      stream: null, chatRequest: 0, chatLoads: new Map(), contextLoad: null, activeProbe: null, resetRequest: 0, projectVersion: 0,
      settingsRequest: 0, appliedSettingsRequest: 0, settingsAccount: null, runPreparation: null,
    };
    runtimes.set(store, state);
  }
  return state;
}

// Background events must keep the dependencies of the project that started them.
// A workspace can bind shared UI services while isolating the project editor.
export function bindAgentContext(store, context = {}) {
  runtime(store).context = context;
  return store;
}
function editorFor(store) {
  return runtime(store).context?.editor || useEditorStore(store._p);
}
function uiFor(store) {
  return runtime(store).context?.ui || useUiStore(store._p);
}
function trackRun(store, runId) {
  if (runId) runtime(store).context?.trackRun?.(String(runId));
}

function sessionFor(store) {
  const auth = useAuthStore(store._p);
  return { token: auth.token, userId: auth.user?.id ?? null };
}

function isCurrentSession(store, session) {
  const current = sessionFor(store);
  // The user record can finish loading after the first settings request.
  return current.token === session.token && session.token === getToken() &&
    (current.userId === session.userId || (session.token && session.userId == null));
}

function sameSession(first, second) {
  return first.token === second.token && first.userId === second.userId;
}

function preferenceKeyFor(store, session = sessionFor(store)) {
  return session.token && isCurrentSession(store, session) ? agentProjectPreferenceKey(session.userId, store.projectId) : '';
}

function saveSelections(store, selections) {
  const key = preferenceKeyFor(store);
  if (key) saveProjectPreferences(store._p, key, selections);
  else store.sessionSelections = selections;
}

function runSession(store) {
  const session = sessionFor(store);
  if (isCurrentSession(store, session)) return session;
  uiFor(store).error(ACCOUNT_CHANGED);
  return null;
}

function modelParameters(store) {
  store.syncProjectPreferences();
  const { activeModelId: modelId, activeReasoningEffort: reasoningEffort } = store;
  return { ...(modelId && { modelId }), ...(reasoningEffort && { reasoningEffort }) };
}

function prepareRunModel(store, projectId) {
  const session = runSession(store);
  if (!session) return null;
  store.setProject(projectId);
  const state = runtime(store);
  if (state.runPreparation) return null;
  const { projectVersion, resetRequest } = state;
  const preparation = {
    session,
    current: () => state.runPreparation === preparation && state.projectVersion === projectVersion &&
      state.resetRequest === resetRequest && isCurrentSession(store, session),
    release() {
      const current = preparation.current();
      if (state.runPreparation === preparation) state.runPreparation = null;
      return current;
    },
    takeModel() {
      if (!preparation.release() || store.streaming || store.resetting || store.compacting || preparation.failed) return null;
      if (session.token && !validAgentAccount(sessionFor(store).userId)) {
        uiFor(store).error('登录状态尚未恢复，请稍后再试');
        return null;
      }
      if (session.token && !store.modelReady) {
        uiFor(store).error('请先在设置中配置可用模型');
        return null;
      }
      return modelParameters(store);
    },
  };
  state.runPreparation = preparation;
  // Selection actions and review tools can start before the Agent panel loads.
  // Reserve this launch while restoring its account and validating its model.
  if (session.token && (!validAgentAccount(session.userId) || !store.accountSettings)) {
    preparation.loading = (async () => {
      if (!validAgentAccount(session.userId)) await useAuthStore(store._p).fetchMe();
      if (preparation.current() && !store.accountSettings) await store.loadSettings({ syncSound: false });
    })().catch(error => {
      preparation.failed = true;
      if (preparation.current()) uiFor(store).error(error.message || '智能体模型设置读取失败');
    });
  }
  return preparation;
}

function workspaceMutationFromTool(event, started) {
  if (!['end', 'error', 'cancelled'].includes(event.status)) return false;
  // A command may create or remove files even if it subsequently fails or is
  // interrupted, so all completed workspace scripts invalidate the listing.
  if (['run_in_workspace', 'run_skill_script'].includes(event.name)) return true;
  if (event.status !== 'end' || !['write_file', 'edit_file', 'copy_to_project'].includes(event.name)) return false;
  const raw = event.result ?? event.detail;
  let result = raw && typeof raw === 'object' ? raw : null;
  if (!result && typeof raw === 'string') { try { result = JSON.parse(raw); } catch {} }
  if (result?.error || result?.changed === false || result?.scope === 'project') return false;
  if (result?.scope === 'workspace') return result.applied !== false;
  const input = event.input || started?.input || {};
  const path = String(result?.path || (event.name === 'copy_to_project' ? input.targetPath : input.path) || '')
    .replaceAll('\\', '/').replace(/^(?:\.\/)+/, '');
  return path === '_workspace' || path.startsWith('_workspace/');
}
function notifyWorkspaceMutation(store, stream, callId) {
  if (stream.projectId == null) return;
  const editor = editorFor(store);
  if (editor.projectId == null || String(editor.projectId) !== String(stream.projectId) || typeof editor.markWorkspaceChanged !== 'function') return;
  stream.workspaceMutationIds ||= new Set();
  if (callId && stream.workspaceMutationIds.has(callId)) return;
  if (callId) stream.workspaceMutationIds.add(callId);
  editor.markWorkspaceChanged();
}

const agentOptions = {
  state: () => ({
    settings: null, // GET /settings/ai 结果（chineseSupport 已转为布尔；含 models 多模型列表）
    sessionSelections: { modelId: '', reasoning: {} },
    projectId: null, // 当前聊天绑定的项目；迟到响应不得跨项目写入
    activeChatId: null, // 当前项目里该用户的单会话 id（后端自动创建）
    messages: [],
    contextUsage: null,
    compacting: false,
    streaming: false,
    streamText: '',
    liveSteps: [], // 本轮时间线步骤，按事件顺序：{type:'text',text} / {type:'tool',name,status,detail}
    streamStartedAt: null, // 本轮开始计时（ms），面板据此显示「已工作 X」
    skills: [],
    mcpTools: null,
    lastError: '', // 面板内错误红条内容
    activeRunId: null,
    activeMessageId: null,
    runState: 'idle',
    pendingQuestion: null,
    reconnectAttempt: 0,
    reconnecting: false,
    connectionLost: false,
    sendingInput: false,
    cancelling: false,
    resetting: false, // 会话清空进行中（按钮防抖 + 反馈）
  }),
  getters: {
    accountSettings() {
      const account = runtime(this).settingsAccount;
      return this.settings && (!account || isCurrentSession(this, account)) ? this.settings : null;
    },
    availableModels() {
      const settings = this.accountSettings;
      if (!settings) return [];
      if (settings.models?.length) return settings.models.filter(model => model.enabled !== false && model.hasKey && model.model);
      return settings.model && settings.hasKey ? [{ id: settings.activeModelId || 'legacy', model: settings.model }] : [];
    },
    modelOptions() {
      return this.availableModels.map(model => ({ id: model.id, label: model.name || model.model }));
    },
    projectSelections() {
      const key = preferenceKeyFor(this);
      return key ? readProjectPreferences(this._p, key) : this.sessionSelections;
    },
    activeModelConfig() {
      if (!this.availableModels.length) return null;
      const preferred = this.projectSelections?.modelId;
      return this.availableModels.find(model => model.id === preferred) ||
        this.availableModels.find(model => model.id === this.accountSettings.activeModelId) ||
        this.availableModels[0];
    },
    modelReady() { return !!this.activeModelConfig; },
    activeModelId() { return this.activeModelConfig?.id || ''; },
    contextModel() { return this.activeModelConfig; },
    currentContextUsage() {
      return matchesContextModel(this.contextUsage, this.contextModel) ? this.contextUsage : null;
    },
    canCompactContext() {
      return this.activeChatId != null && this.messages.length > 0 && this.modelReady &&
        !this.compacting && !this.streaming && !this.resetting;
    },
    reasoningOptions() {
      return modelReasoningLevels(this.activeModelConfig).map(value => ({ value, label: reasoningLevelLabel(value) }));
    },
    activeReasoningEffort() {
      const model = this.activeModelConfig;
      if (!model) return '';
      const selected = this.projectSelections?.reasoning[model.id];
      return modelReasoningLevels(model).includes(selected) ? selected : modelReasoningEffort(model);
    },
  },
  actions: {
    // ---------- 设置 ----------
    async loadSettings({ syncSound = true } = {}) {
      const state = runtime(this);
      const session = sessionFor(this);
      if (!isCurrentSession(this, session)) throw new Error(ACCOUNT_CHANGED);
      const request = ++state.settingsRequest;
      const soundRevision = getCompletionSoundRevision();
      const r = await api.get('/api/settings/ai');
      if (!isCurrentSession(this, session) || request < state.appliedSettingsRequest) return this.accountSettings;
      state.appliedSettingsRequest = request;
      if (syncSound) syncCompletionSoundPreference(r.agentConfig?.completionSound !== false, soundRevision);
      if (state.settingsAccount && !isCurrentSession(this, state.settingsAccount)) this.sessionSelections = { modelId: '', reasoning: {} };
      state.settingsAccount = sessionFor(this);
      this.settings = { ...r, chineseSupport: !!r.chineseSupport };
      this.syncProjectPreferences();
      if (this.messages.length && !this.currentContextUsage) this.refreshContextUsage().catch(() => {});
      return this.settings;
    },
    async saveSettings(patch) {
      const session = sessionFor(this);
      if (!isCurrentSession(this, session)) throw new Error(ACCOUNT_CHANGED);
      const body = { ...patch };
      if (typeof body.chineseSupport === 'boolean') body.chineseSupport = body.chineseSupport ? 1 : 0;
      await putJson('/api/settings/ai', body);
      if (!isCurrentSession(this, session)) throw new Error(ACCOUNT_CHANGED);
      return this.loadSettings({ syncSound: false });
    },
    syncProjectPreferences() {
      const session = sessionFor(this);
      const key = preferenceKeyFor(this, session);
      if (!key || !this.accountSettings) return;
      const saved = readProjectPreferences(this._p, key);
      const modelId = this.activeModelId || saved?.modelId;
      if (!modelId) return;
      const choices = saved?.reasoning || legacyReasoningPreferences(session.userId);
      const reasoning = Object.fromEntries((this.accountSettings.models || [])
        .filter(model => Object.hasOwn(choices, model.id) && modelReasoningLevels(model).includes(choices[model.id]))
        .map(model => [model.id, choices[model.id]]));
      if (!saved || saved.modelId !== modelId || Object.keys(choices).length !== Object.keys(reasoning).length) {
        saveProjectPreferences(this._p, key, { modelId, reasoning });
      }
    },
    // 面板中的选择只影响当前项目的下一轮对话。
    async setActiveModel(modelId) {
      const session = sessionFor(this);
      if (!isCurrentSession(this, session)) throw new Error(ACCOUNT_CHANGED);
      if (!this.accountSettings || this.streaming || this.resetting || this.compacting) return false;
      if (!this.availableModels.some(model => model.id === modelId)) throw new Error('所选模型不可用，请重新选择');
      this.syncProjectPreferences();
      saveSelections(this, { modelId, reasoning: this.projectSelections?.reasoning || {} });
      await this.refreshContextUsage().catch(() => {});
      return true;
    },
    // Request-only preference: choosing a level never changes model identity,
    // rewrites server settings or clears the conversation.
    setReasoningEffort(level) {
      if (this.streaming || this.resetting || this.compacting) return false;
      const session = sessionFor(this);
      if (!isCurrentSession(this, session)) throw new Error(ACCOUNT_CHANGED);
      const model = this.activeModelConfig;
      if (!model || !modelReasoningLevels(model).includes(level)) throw new Error('当前模型不支持此思考强度');
      this.syncProjectPreferences();
      const selections = this.projectSelections;
      saveSelections(this, { modelId: selections?.modelId || '', reasoning: { ...selections?.reasoning, [model.id]: level } });
      return true;
    },
    async testConnection(overrides = {}) {
      const body = {};
      for (const k of ['provider', 'providerId', 'baseUrl', 'apiKey', 'model', 'modelId']) {
        if (overrides[k]) body[k] = overrides[k];
      }
      return api.post('/api/settings/ai/test', body);
    },
    async loadSkills() {
      const r = await api.get('/api/settings/skills');
      this.skills = r.skills || [];
      return this.skills;
    },
    async importSkillZip(file) {
      const fd = new FormData();
      fd.append('file', file);
      const r = await api.postForm('/api/settings/skills/import', fd);
      await this.loadSkills();
      return r.imported || [];
    },
    // 从用户电脑选择的目录导入：FormData 内为目录全部文件 + 相对路径表
    async importSkillFiles(formData) {
      const r = await api.postForm('/api/settings/skills/import-files', formData);
      await this.loadSkills();
      return r.imported || [];
    },
    async createSkill(payload) {
      const r = await api.post('/api/settings/skills/create', payload);
      await this.loadSkills();
      return r;
    },
    async setSkillEnabled(name, enabled) {
      await api.post('/api/settings/skills/batch', { names: [name], action: enabled ? 'enable' : 'disable' });
      await this.loadSkills();
    },
    async batchSkills(names, action) {
      const r = await api.post('/api/settings/skills/batch', { names, action });
      await this.loadSkills();
      return r;
    },
    async readSkillContent(name) {
      const res = await api.raw(`/api/settings/skills/${encodeURIComponent(name)}/content`);
      return res.text();
    },
    async updateSkillContent(name, content) {
      await api.put(`/api/settings/skills/${encodeURIComponent(name)}/content`, { content });
      await this.loadSkills();
    },
    async deleteSkill(name) {
      await api.del(`/api/settings/skills/${encodeURIComponent(name)}`);
      this.skills = this.skills.filter((s) => s.name !== name);
    },
    async testMcp() {
      const r = await api.post('/api/settings/mcp/test', {});
      this.mcpTools = r.tools || [];
      return this.mcpTools;
    },

    // ---------- 会话（跟随项目：每用户每项目一条，进入项目自动加载） ----------
    _shapeMessages(rows) {
      return orderRunInputs((rows || []).map((m) => ({
        ...m,
        toolCalls: parseToolCalls(m.toolCalls),
        steps: Array.isArray(m.steps) ? m.steps : [],
      })));
    },
    _recordContextUsage(usage) {
      const snapshot = validContextUsage(usage);
      if (!snapshot || (this.settings && !matchesContextModel(snapshot, this.contextModel))) return;
      const previous = this.contextUsage;
      if (previous && snapshot.modelId === previous.modelId && snapshot.modelKey === previous.modelKey &&
          snapshot.maxTokens === previous.maxTokens && (snapshot.updatedAt < previous.updatedAt ||
          (snapshot.updatedAt === previous.updatedAt && contextUsagePriority(snapshot) < contextUsagePriority(previous)))) return;
      this.contextUsage = snapshot;
    },
    async refreshContextUsage() {
      const { projectId, activeChatId: chatId, contextModel: model } = this;
      if (projectId == null || chatId == null || !model || this.streaming || this.resetting || this.compacting) return;
      const state = runtime(this);
      const selection = contextSelection(model);
      const session = sessionFor(this);
      if (!isCurrentSession(this, session)) return;
      const chatRequest = state.chatRequest;
      const usageAtRequest = this.contextUsage;
      const pending = state.contextLoad;
      if (pending && pending.selection === selection && pending.chatRequest === chatRequest && sameSession(pending.session, session)) {
        return pending.promise;
      }
      const load = { selection, chatRequest, session };
      state.contextLoad = load;
      load.promise = (async () => {
        const result = await api.get(`/api/projects/${projectId}/agent/context?modelId=${encodeURIComponent(model.id)}`, { cache: 'no-store' });
        if (state.contextLoad !== load || state.chatRequest !== chatRequest || !isCurrentSession(this, session) ||
            this.projectId !== projectId || this.activeChatId !== chatId || contextSelection(this.contextModel) !== selection ||
            String(result.chatId) !== String(chatId)) return;
        if (result.contextUsage === null && this.contextUsage === usageAtRequest) this.contextUsage = null;
        this._recordContextUsage(result.contextUsage);
      })().finally(() => { if (state.contextLoad === load) state.contextLoad = null; });
      return load.promise;
    },
    setProject(projectId) {
      const id = projectId == null ? null : String(projectId);
      if (this.projectId === id) return;
      this.clearLocal();
      this.projectId = id;
      this.syncProjectPreferences();
    },
    // Opening a project should not synchronously deserialize an idle chat's
    // complete history. Discover a live run first; only a real live run needs
    // the existing history + event replay path. The Agent panel still loads
    // history normally when opened.
    async restoreActiveRun(projectId, { strictRestore = false } = {}) {
      const session = sessionFor(this);
      if (!isCurrentSession(this, session)) {
        if (strictRestore) throw new Error(ACCOUNT_CHANGED);
        return this.messages;
      }
      this.setProject(projectId);
      if (!this.projectId || this.streaming || this.resetting || this.compacting) return this.messages;
      const state = runtime(this), id = this.projectId;
      let pending = state.activeProbe;
      if (!pending || pending.id !== id || pending.projectVersion !== state.projectVersion ||
          pending.chatRequest !== state.chatRequest || !sameSession(pending.session, session)) {
        pending = { id, projectVersion: state.projectVersion, chatRequest: state.chatRequest, session };
        state.activeProbe = pending;
        this.lastError = '';
        pending.promise = (async () => {
          try {
            const active = await api.get(`/api/projects/${id}/agent/runs/active`, { cache: 'no-store' });
            if (!active || !Object.hasOwn(active, 'run') || (active.run !== null &&
                (!active.run || typeof active.run !== 'object' || !(active.run.runId || active.run.id) || typeof active.run.state !== 'string'))) {
              throw new Error('智能体任务状态响应无效');
            }
            if (!isCurrentSession(this, session) || this.projectId !== id || state.projectVersion !== pending.projectVersion ||
                state.chatRequest !== pending.chatRequest || this.streaming || this.resetting || this.compacting) return {};
            const run = active.run;
            if (run && !TERMINAL_RUN_STATES.has(run.state)) trackRun(this, run.runId || run.id);
            if ((run && !TERMINAL_RUN_STATES.has(run.state)) || state.context?.trackedRunId?.()) {
              const loading = this.loadChat(id, { noStore: true, strictRestore: true });
              pending.chatRequest = state.chatRequest;
              await loading;
            }
            return {};
          } catch (restoreError) { return { restoreError }; }
        })().finally(() => { if (state.activeProbe === pending) state.activeProbe = null; });
      }
      const result = await pending.promise;
      if (result.restoreError && isCurrentSession(this, session) && this.projectId === id && state.projectVersion === pending.projectVersion &&
          state.chatRequest === pending.chatRequest) {
        if (strictRestore) throw result.restoreError;
        this.lastError = '智能体任务状态读取失败，请打开面板重试';
      }
      return this.messages;
    },
    async loadChat(projectId, { noStore = false, restoreRun = true, strictRestore = false } = {}) {
      const session = sessionFor(this);
      if (!isCurrentSession(this, session)) {
        if (strictRestore) throw new Error(ACCOUNT_CHANGED);
        return this.messages;
      }
      this.setProject(projectId);
      // 隐藏/重开面板时保留进行中的乐观消息和时间线。
      if (this.streaming || this.resetting || this.compacting) return this.messages;
      const state = runtime(this);
      const id = this.projectId;
      const key = restoreRun ? 'restore' : 'history';
      let pending = state.chatLoads.get(key);
      // The workspace restorer, editor and panel can request the same history at
      // once. Share their transport, but leave strict error handling per caller.
      if (!pending || pending.id !== id || pending.request !== state.chatRequest || !sameSession(pending.session, session)) {
        const request = ++state.chatRequest;
        pending = { id, request, session };
        state.chatLoads.set(key, pending);
        if (restoreRun) this.lastError = '';
        const model = this.contextModel;
        const selection = contextSelection(model);
        const query = model ? `?modelId=${encodeURIComponent(model.id)}` : '';
        const usageAtRequest = this.contextUsage;
        const isCurrent = () => request === state.chatRequest && this.projectId === id && isCurrentSession(this, session);
        pending.promise = (async () => {
          const r = await api.get(`/api/projects/${id}/chat${query}`, noStore ? { cache: 'no-store' } : undefined);
          if (!isCurrent()) return {};
          if (this.activeChatId != null && String(this.activeChatId) !== String(r.chatId)) this.contextUsage = null;
          this.activeChatId = r.chatId;
          this.messages = this._shapeMessages(r.messages);
          // An empty chat has no estimate. A missing snapshot with history can
          // occur after a run even when its stream already provided a reading.
          if (r.contextUsage === null && Array.isArray(r.messages) && !r.messages.length && this.contextUsage === usageAtRequest) {
            this.contextUsage = null;
          }
          this._recordContextUsage(r.contextUsage);
          if (this.messages.length && !this.currentContextUsage && contextSelection(this.contextModel) !== selection) {
            this.refreshContextUsage().catch(() => {});
          }
          if (restoreRun) {
            try {
              const active = await api.get(`/api/projects/${id}/agent/runs/active`, { cache: 'no-store' });
              if (!isCurrent() || this.streaming) return {};
              const run = active.run && !TERMINAL_RUN_STATES.has(active.run.state) ? active.run : null;
              const trackedRunId = state.context?.trackedRunId?.();
              if (run || trackedRunId) {
                if (run?.messageId) this.messages = this.messages.filter((m) => m.id !== run.messageId);
                const stream = this._beginStream({ session });
                if (run) this._adoptRun(run, stream);
                else {
                  // The active endpoint no longer returns a completed run.
                  // Replay only the exact run this tab previously tracked.
                  stream.runId = this.activeRunId = trackedRunId;
                  stream.recoveredById = true;
                  stream.questionNotificationAfterSeq = Infinity;
                }
                this._watchRun(stream).catch(() => {});
              }
            } catch (restoreError) {
              // Ordinary history remains readable while background restoration
              // can report that the task subscription was not recovered.
              return { restoreError };
            }
          }
          return {};
        })().finally(() => {
          if (state.chatLoads.get(key) === pending) state.chatLoads.delete(key);
        });
      }
      const result = await pending.promise;
      if (strictRestore && result.restoreError && pending.request === state.chatRequest && this.projectId === id && isCurrentSession(this, session)) {
        throw result.restoreError;
      }
      return this.messages;
    },
    async compactContext() {
      const id = this.projectId;
      if (!id || !this.canCompactContext || editorFor(this).readOnly) return false;
      const session = runSession(this);
      if (!session || (session.token && !validAgentAccount(session.userId))) return false;
      const model = modelParameters(this);
      const state = runtime(this);
      const version = state.projectVersion;
      const currentProject = () => this.projectId === id && state.projectVersion === version;
      ++state.chatRequest;
      this.compacting = true;
      try {
        const result = await api.post(`/api/projects/${id}/agent/context/compact`, model);
        if (!currentProject() || !isCurrentSession(this, session)) return false;
        this._recordContextUsage(result.contextUsage);
        if (result.compressed) uiFor(this).toast('上下文已压缩');
        else uiFor(this).toast('当前没有可压缩的较早对话', 'warn');
        return !!result.compressed;
      } catch (error) {
        if (currentProject() && isCurrentSession(this, session)) uiFor(this).error(error.message || '压缩上下文失败');
        return false;
      } finally {
        if (currentProject()) this.compacting = false;
      }
    },
    // 刷新按钮：清空当前项目的智能体会话（删除全部消息并重置压缩摘要），重新开始。
    // 会话行本身保留，下一轮对话仍在同一会话上下文中进行
    async resetChat() {
      const pid = editorFor(this).projectId;
      if (!pid || this.resetting || this.streaming || this.compacting) return;
      const session = runSession(this);
      if (!session) return;
      this.setProject(pid);
      const state = runtime(this);
      state.runPreparation = null;
      const request = ++state.resetRequest;
      ++state.chatRequest;
      this.resetting = true;
      try {
        await api.del(`/api/projects/${pid}/chat`);
        if (request !== state.resetRequest || this.projectId !== String(pid) || !isCurrentSession(this, session)) return;
        this.messages = [];
        this.contextUsage = null;
        this.liveSteps = [];
        this.streamText = '';
        this.lastError = '';
        uiFor(this).toast('会话已清空，可重新开始');
      } catch (e) {
        if (request === state.resetRequest && this.projectId === String(pid) && isCurrentSession(this, session)) {
          uiFor(this).error(e.message || '清空会话失败');
        }
      } finally {
        if (request === state.resetRequest) this.resetting = false;
      }
    },
    clearLocal() {
      const state = runtime(this);
      const stream = state.stream;
      state.stream = null;
      ++state.chatRequest;
      state.chatLoads.clear(); // Closing/reopening this project must start a fresh load.
      state.contextLoad = null;
      state.runPreparation = null;
      ++state.resetRequest;
      ++state.projectVersion;
      stream?.controller.abort();
      this.projectId = null;
      this.sessionSelections = { modelId: '', reasoning: {} };
      this.streaming = false;
      this.streamStartedAt = null;
      this.resetting = false;
      this.messages = [];
      this.contextUsage = null;
      this.compacting = false;
      this.liveSteps = [];
      this.streamText = '';
      this.lastError = '';
      this.activeChatId = null;
      this.activeRunId = null;
      this.activeMessageId = null;
      this.runState = 'idle';
      this.pendingQuestion = null;
      this.connectionLost = false;
      this.reconnectAttempt = 0;
      this.reconnecting = false;
      this.sendingInput = false;
      this.cancelling = false;
    },

    // ---------- 流式对话 ----------
    _beginStream({ requestId = null, session = null } = {}) {
      const state = runtime(this);
      state.stream?.controller.abort();
      ++state.chatRequest; // 发送前发出的历史加载不能覆盖本轮乐观消息
      const stream = {
        projectId: this.projectId,
        projectVersion: state.projectVersion,
        resetRequest: state.resetRequest,
        chatId: this.activeChatId,
        controller: new AbortController(),
        runId: null,
        requestId,
        session,
        notificationArmed: !!requestId,
        questionNotificationAfterSeq: 0,
        notifiedQuestions: new Set(),
        terminalState: null,
        runObserved: false,
        lastSeq: 0,
      };
      state.stream = stream;
      this.streaming = true;
      this.streamText = '';
      this.liveSteps = [];
      this.streamStartedAt = Date.now();
      this.lastError = '';
      this.activeRunId = null;
      this.activeMessageId = null;
      this.runState = 'running';
      this.pendingQuestion = null;
      this.connectionLost = false;
      this.reconnectAttempt = 0;
      this.reconnecting = false;
      this.cancelling = false;
      trackRun(this, requestId);
      return stream;
    },
    _isCurrentStream(stream) {
      return !!stream && runtime(this).stream === stream &&
        this.projectId === stream.projectId && this.streaming && (!stream.session || isCurrentSession(this, stream.session));
    },
    _adoptRun(run, stream) {
      if (!this._isCurrentStream(stream)) return;
      stream.runId = String(run.runId || run.id);
      stream.runObserved = true;
      trackRun(this, stream.runId);
      if (['running', 'waiting_for_user', 'cancelling'].includes(run.state)) stream.notificationArmed = true;
      this.activeRunId = stream.runId;
      if (Number.isSafeInteger(Number(run.messageId)) && Number(run.messageId) > 0) this.activeMessageId = stream.messageId = Number(run.messageId);
      this.runState = run.state || 'running';
      this.pendingQuestion = run.question || null;
      // Replayed events rebuild the UI but are not new requests for attention.
      if (!stream.requestId) stream.questionNotificationAfterSeq = Math.max(stream.questionNotificationAfterSeq, Number(run.lastSeq) || 0);
      if (run.question?.questionId) stream.notifiedQuestions.add(String(run.question.questionId));
      if (stream.cancelRequested) this._requestCancellation(stream);
    },
    async _discoverRun(stream) {
      const result = await api.get(`/api/projects/${stream.projectId}/agent/runs/active`, { cache: 'no-store' });
      if (!this._isCurrentStream(stream)) return false;
      if (result.run) this._adoptRun(result.run, stream);
      return !!stream.runId;
    },
    async _watchRun(stream, { initial = false } = {}) {
      if (!this._isCurrentStream(stream)) return;
      if (!stream.runId && stream.requestId) {
        // The original POST may have completed before its first event arrived.
        // Replay by its known identity, including terminal runs.
        stream.runId = stream.requestId;
        this.activeRunId = stream.runId;
      }
      if (!stream.runId) {
        try { await this._discoverRun(stream); } catch { /* Display original transport failure below. */ }
      }
      if (!this._isCurrentStream(stream)) return;
      if (!stream.runId) {
        stream.failed = true;
        this.lastError = '连接已中断，未找到活动任务。请重新打开面板核对已保存的结果。';
        await this._finishStream(stream.chatId, { stream });
        return;
      }
      // A normal POST→GET handoff after the run already finished is not a disconnect:
      // skip the reconnect loop so it neither delays delivery nor shows a false alarm.
      if (stream.terminal) return;
      for (let attempt = initial ? 1 : 0; attempt <= MAX_RECONNECT_ATTEMPTS; attempt++) {
        if (!this._isCurrentStream(stream)) return;
        try {
          if (attempt > 0) {
            this.reconnectAttempt = attempt;
            this.reconnecting = true;
            this.liveSteps.push({ type: 'activity', phase: 'retry', source: 'system', text: `连接中断，正在重连 ${attempt}/${MAX_RECONNECT_ATTEMPTS}（继续接收当前任务）` });
            await reconnectDelay(Math.min(500 * 2 ** (attempt - 1), 8000), stream.controller.signal);
            if (!this._isCurrentStream(stream)) return;
          }
          this.connectionLost = false;
          await sseGet(`/api/projects/${stream.projectId}/agent/runs/${encodeURIComponent(stream.runId)}/events?after=${stream.lastSeq}`, (ev) => this._onEvent(ev, stream), {
            signal: stream.controller.signal,
            onActivity: () => { if (this._isCurrentStream(stream)) this.reconnecting = false; },
          });
          if (!this._isCurrentStream(stream) || stream.terminal) return;
          throw new Error('事件流提前结束');
        } catch (e) {
          if (!this._isCurrentStream(stream) || e?.name === 'AbortError') return;
          if (stream.recoveredById && e?.status === 404) {
            await this._finishStream(stream.chatId, { reload: false, stream });
            return;
          }
          const requestNotRegistered = e?.status === 404 && stream.requestId && !stream.runObserved;
          if (attempt === MAX_RECONNECT_ATTEMPTS || ([401, 403, 404].includes(e?.status) && !requestNotRegistered)) {
            this.connectionLost = true;
            this.reconnecting = false;
            this.lastError = `连接未恢复（已重连 ${attempt} 次）。任务可能仍在运行，可重新连接或停止任务。`;
            await this.refreshRunStatus();
            return;
          }
        }
      }
    },
    refreshRunStatus() {
      const stream = runtime(this).stream;
      if (!this._isCurrentStream(stream) || !this.connectionLost || !stream.runId) return;
      if (stream.statusRequest) return stream.statusRequest;
      const runId = stream.runId;
      const current = () => this._isCurrentStream(stream) && this.connectionLost && stream.runId === runId;
      const controller = new AbortController();
      const abort = () => controller.abort();
      stream.controller.signal.addEventListener('abort', abort, { once: true });
      const deadline = setTimeout(abort, RUN_STATUS_TIMEOUT_MS);
      stream.statusRequest = (async () => {
        try {
          const result = await api.get(`/api/projects/${stream.projectId}/agent/runs/${encodeURIComponent(runId)}`, {
            cache: 'no-store', signal: controller.signal,
          });
          const run = result?.run;
          if (!current() || String(run?.runId || run?.id) !== runId) return;
          stream.runObserved = true;
          if (TERMINAL_RUN_STATES.has(run.state)) {
            this.lastError = '';
            this._onEvent({ ...run, type: 'run', runId }, stream);
          }
        } catch (error) {
          // A new POST can still be registering. Only retire a missing ID
          // after this client has already observed that run on the server.
          if (current() && stream.runObserved && error?.status === 404) {
            this.lastError = '';
            this._onEvent({ type: 'run', runId, state: 'interrupted', error: '任务记录已不可用，请核对已保存的结果。' }, stream);
          }
        } finally {
          clearTimeout(deadline);
          stream.controller.signal.removeEventListener('abort', abort);
        }
      })().finally(() => { stream.statusRequest = null; });
      return stream.statusRequest;
    },
    async reconnectRun() {
      const stream = runtime(this).stream;
      if (!stream || !this.connectionLost || this.reconnecting) return;
      this.reconnecting = true;
      await this.refreshRunStatus();
      if (!this._isCurrentStream(stream) || !this.connectionLost) return;
      this.lastError = '';
      this.connectionLost = false;
      return this._watchRun(stream);
    },
    _recordRunInput(event, stream) {
      // An acknowledged HTTP response can arrive after done/reload or after a
      // new round starts. Keep its original association without reviving it.
      if (!stream || (stream.session && !isCurrentSession(this, stream.session)) || this.projectId !== stream.projectId ||
          runtime(this).projectVersion !== stream.projectVersion || runtime(this).resetRequest !== stream.resetRequest) return false;
      const inputKind = event.inputKind || (event.type === 'answer' ? 'answer' : 'steering');
      const text = String(event.inputText ?? event.answer ?? event.message ?? '');
      const runId = String(event.runId || stream.runId);
      const id = event.chatMessageId ?? (inputKind === 'answer'
        ? `local-answer-${runId}-${event.questionId}` : event.localId || `local-input-${runId}-${Date.now()}`);
      const same = message => isRunInput(message) && String(message.runId) === runId && message.inputKind === inputKind && (
        String(message.id) === String(id) ||
        (inputKind === 'answer' && event.questionId && message.questionId === event.questionId) ||
        (event.inputId != null && message.inputId === event.inputId)
      );
      const previous = this.messages.find(same) || this.messages.find(message => String(message.id) === String(id));
      const consumed = previous?.consumed === true || event.consumed === true || inputKind === 'answer' || stream.consumedInputs?.has(event.inputId) || false;
      const message = {
        ...previous, id, role: 'user', content: text, inputText: text, runId,
        inputKind, parentMessageId: event.parentMessageId || stream.messageId || previous?.parentMessageId,
        ...(event.questionId ? { questionId: event.questionId } : {}),
        ...(event.question ? { question: event.question } : {}),
        ...(event.inputId != null ? { inputId: event.inputId } : {}),
        consumed, createdAt: previous?.createdAt || new Date().toISOString(),
      };
      if (previous) this.messages.splice(this.messages.indexOf(previous), 1, message);
      else this.messages.push(message);
      this.messages = orderRunInputs(this.messages);
      stream.receivedInputs ||= [];
      if (!stream.receivedInputs.some(input => String(input.chatMessageId) === String(event.chatMessageId) && event.chatMessageId != null)) {
        stream.receivedInputs.push({ ...event, inputKind, runId, inputText: text });
      }
      if (inputKind === 'answer' && this._isCurrentStream(stream) && this.pendingQuestion?.questionId === event.questionId) {
        this.pendingQuestion = null;
        if (this.runState === 'waiting_for_user') this.runState = 'running';
      }
      return true;
    },
    async sendInput(message) {
      const stream = runtime(this).stream;
      const text = String(message || '').trim();
      if (!text || !stream?.runId || !this._isCurrentStream(stream) || this.sendingInput || this.cancelling || this.pendingQuestion) return false;
      const afterSeq = stream.lastSeq;
      const acceptedEvent = () => stream.receivedInputs?.find(input => input.inputKind === 'steering' && input.inputText === text && input.seq > afterSeq);
      this.sendingInput = true;
      try {
        const response = await api.post(`/api/projects/${stream.projectId}/agent/runs/${encodeURIComponent(stream.runId)}/input`, { message: text });
        this._recordRunInput(response?.input || acceptedEvent() || { type: 'input', inputText: text, consumed: false }, stream);
        return true;
      } catch (e) {
        // The durable SSE acknowledgement wins over a lost HTTP response.
        if (acceptedEvent()) return true;
        if (this._isCurrentStream(stream)) { this.lastError = e.message || '补充指令发送失败'; uiFor(this).error(this.lastError); }
        return false;
      } finally { if (runtime(this).stream === stream) this.sendingInput = false; }
    },
    async answerQuestion(answer) {
      const stream = runtime(this).stream;
      const question = this.pendingQuestion;
      const text = String(answer || '').trim();
      if (!text || !stream?.runId || !this._isCurrentStream(stream) || !question || this.sendingInput || this.cancelling) return false;
      const acceptedEvent = () => stream.receivedInputs?.find(input => input.inputKind === 'answer' && input.questionId === question.questionId && input.inputText === text);
      this.sendingInput = true;
      try {
        const response = await api.post(`/api/projects/${stream.projectId}/agent/runs/${encodeURIComponent(stream.runId)}/answer`, { questionId: question.questionId, answer: text });
        this._recordRunInput(response?.answer || acceptedEvent() || { type: 'answer', questionId: question.questionId, question: question.question, inputText: text, consumed: true }, stream);
        return true;
      } catch (e) {
        if (acceptedEvent()) return true;
        if (this._isCurrentStream(stream)) { this.lastError = e.message || '回答发送失败'; uiFor(this).error(this.lastError); }
        return false;
      } finally { if (runtime(this).stream === stream) this.sendingInput = false; }
    },
    // 叙述文本按到达顺序并入时间线：新一段文本另起一行，工具事件插在中间
    _pushTextStep(text) {
      if (!text) return;
      const last = this.liveSteps[this.liveSteps.length - 1];
      if (last && last.type === 'text') last.text += text;
      else this.liveSteps.push({ type: 'text', text });
    },
    _putResponseBlock(stream, type, blockIndex, text, replace = false) {
      stream.responseBlocks ||= new Map();
      const key = `${type}:${blockIndex}`;
      let step = stream.responseBlocks.get(key);
      if (!step || !this.liveSteps.includes(step)) {
        if (!text) return null;
        const later = [...stream.responseBlocks.values()]
          .filter((item) => item.blockIndex > blockIndex && this.liveSteps.includes(item))
          .sort((a, b) => a.blockIndex - b.blockIndex)[0];
        const at = later ? this.liveSteps.indexOf(later) : this.liveSteps.length;
        this.liveSteps.splice(at, 0, { type, text, blockIndex, ...(type === 'model_thinking' ? { source: 'provider' } : {}) });
        step = this.liveSteps[at];
        stream.responseBlocks.set(key, step);
      } else if (replace) step.text = text;
      else step.text += text;
      return step;
    },
    _onEvent(ev, stream = runtime(this).stream) {
      if (!this._isCurrentStream(stream) || !ev || typeof ev !== 'object') return;
      if (ev.runId) {
        if (stream.runId && String(ev.runId) !== stream.runId) return;
        if (!stream.runId) trackRun(this, ev.runId);
        stream.runId = String(ev.runId);
        stream.runObserved = true;
        this.activeRunId = stream.runId;
        if (stream.cancelRequested && !TERMINAL_RUN_STATES.has(ev.state)) this._requestCancellation(stream);
      }
      if (Number.isFinite(ev.seq)) {
        if (ev.seq <= stream.lastSeq) return;
        stream.lastSeq = ev.seq;
      }
      this.connectionLost = false;
      this.reconnecting = false;
      if (['run', 'done'].includes(ev.type) && Number.isSafeInteger(Number(ev.messageId)) && Number(ev.messageId) > 0) this.activeMessageId = stream.messageId = Number(ev.messageId);
      switch (ev.type) {
        case 'response_start':
          stream.responseStep = this.liveSteps.length;
          stream.responseTextStart = this.streamText.length;
          stream.newResponse = true;
          stream.thinkingStep = null;
          stream.responseBlocks = new Map();
          break;
        case 'response_reset':
          if (stream.responseStep != null) {
            this.liveSteps = this.liveSteps.filter((s, i) => i < stream.responseStep || !['text', 'model_thinking'].includes(s.type));
            this.streamText = this.streamText.slice(0, stream.responseTextStart || 0);
          }
          stream.newResponse = true;
          stream.thinkingStep = null;
          stream.responseBlocks = new Map();
          break;
        case 'run':
          this.runState = ev.state || this.runState;
          if (ev.state && ev.state !== 'waiting_for_user') this.pendingQuestion = null;
          if (TERMINAL_RUN_STATES.has(ev.state)) {
            stream.terminal = true;
            stream.terminalState = ev.state;
            stream.failed = ev.state === 'failed' || ev.state === 'interrupted';
            stream.cancelled = ev.state === 'cancelled';
            if (stream.failed && !this.lastError) this.lastError = ev.error || (ev.state === 'interrupted' ? '任务被中断，请核对已保存的结果。' : '任务执行失败，请查看过程记录。');
            this._finishStream(stream.chatId, { stream }).catch(() => {});
          }
          break;
        case 'question':
          this.pendingQuestion = { questionId: ev.questionId, question: ev.question, options: ev.options || [] };
          this.runState = 'waiting_for_user';
          if (ev.questionId && !stream.notifiedQuestions.has(String(ev.questionId))) {
            stream.notifiedQuestions.add(String(ev.questionId));
            const fresh = !Number.isFinite(ev.seq) || ev.seq > stream.questionNotificationAfterSeq;
            if (fresh) void notifyAgentQuestion({ runId: stream.runId || stream.requestId, projectId: stream.projectId,
              questionId: ev.questionId, live: stream.notificationArmed }).catch(() => {});
          }
          break;
        case 'answer':
        case 'input':
          this._recordRunInput(ev, stream);
          break;
        case 'input_consumed': {
          stream.consumedInputs ||= new Set();
          for (const id of ev.inputIds || []) stream.consumedInputs.add(id);
          for (const message of this.messages) {
            if (message.runId === stream.runId && message.inputKind === 'steering' && stream.consumedInputs.has(message.inputId)) message.consumed = true;
          }
          this.messages = orderRunInputs(this.messages);
          break;
        }
        case 'workflow': {
          if (!isWorkflowGraph(ev.graph)) break;
          const existing = this.liveSteps.find(step => step.type === 'workflow');
          if (existing) existing.graph = ev.graph;
          else this.liveSteps.push({ type: 'workflow', graph: ev.graph });
          break;
        }
        case 'activity':
          // Execution summaries stay separate from provider-returned thinking text.
          if (ev.source !== 'model' && typeof ev.draftPath === 'string' && ev.draftPath.startsWith('_workspace/'))
            notifyWorkspaceMutation(this, stream, ev.draftPath);
          if (ev.text) this.liveSteps.push({ type: 'activity', ...pickAgentMetadata(ev), ...pickDraftRecovery(ev), text: ev.text, phase: ev.phase || 'working', source: ev.source === 'model' ? 'model' : 'system', attempt: ev.attempt, maxAttempts: ev.maxAttempts });
          break;
        case 'agent_report': {
          if (!ev.agentExecutionId && !ev.agentId) break;
          const existing = this.liveSteps.find(step => step.type === 'agent_report' &&
            (ev.agentExecutionId ? step.agentExecutionId === ev.agentExecutionId
              : !step.agentExecutionId && step.agentId === ev.agentId));
          const result = { type: 'agent_report', ...pickAgentMetadata(ev), report: ev.report, usage: ev.usage,
            toolCount: ev.toolCount, status: ev.status || ev.agentStatus, startedAt: ev.startedAt,
            finishedAt: ev.finishedAt, durationMs: ev.durationMs };
          if (existing) Object.assign(existing, result);
          else this.liveSteps.push(result);
          break;
        }
        case 'model_thinking': {
          // Only text explicitly returned by the provider enters this channel.
          if (typeof ev.text !== 'string') break;
          const indexed = Number.isSafeInteger(ev.blockIndex) && ev.blockIndex >= 0;
          let step;
          if (indexed) step = this._putResponseBlock(stream, 'model_thinking', ev.blockIndex, ev.text, ev.replace === true);
          else {
            step = stream.thinkingStep == null ? null : this.liveSteps[stream.thinkingStep];
            if (step?.type !== 'model_thinking') {
              if (!ev.text) break;
              stream.thinkingStep = this.liveSteps.length;
              this.liveSteps.push({ type: 'model_thinking', text: ev.text, source: 'provider' });
              step = this.liveSteps[stream.thinkingStep];
            } else if (ev.replace) step.text = ev.text;
            else step.text += ev.text;
          }
          if (step && Number.isFinite(ev.startedAt) && ev.startedAt > 0) step.startedAt = ev.startedAt;
          if (step && Number.isFinite(ev.durationMs) && ev.durationMs >= 0) step.durationMs = ev.durationMs;
          break;
        }
        case 'token': {
          if (Number.isSafeInteger(ev.blockIndex) && ev.blockIndex >= 0 && typeof ev.text === 'string') {
            this._putResponseBlock(stream, 'text', ev.blockIndex, ev.text, ev.replace === true);
            this.streamText = this.liveSteps.filter((s) => s.type === 'text' && !s.system).map((s) => s.text).join('');
            stream.newResponse = false;
          } else {
            this.streamText += ev.text || '';
            if (stream.newResponse && ev.text) { this.liveSteps.push({ type: 'text', text: ev.text }); stream.newResponse = false; }
            else this._pushTextStep(ev.text || '');
          }
          break;
        }
        case 'status':
          // 服务端过程提示（如「已自动压缩历史上下文」）：并入时间线显示
          if (ev.text) this.liveSteps.push({ type: 'text', text: ev.text, system: true });
          break;
        case 'context_usage': {
          if (ev.chatId != null) {
            if (this.activeChatId != null && String(ev.chatId) !== String(this.activeChatId)) break;
            stream.chatId = ev.chatId;
            this.activeChatId ??= ev.chatId;
          }
          this._recordContextUsage(ev.contextUsage);
          break;
        }
        case 'tool': {
          if (['end', 'error', 'cancelled'].includes(ev.status)) {
            const t = [...this.liveSteps]
              .reverse()
              .find((x) => x.type === 'tool' && (ev.toolCallId ? x.toolCallId === ev.toolCallId
                : x.name === ev.name && (x.agentExecutionId || '') === (ev.agentExecutionId || '') && (x.agentId || '') === (ev.agentId || '')) && x.status === 'start');
            if (workspaceMutationFromTool(ev, t)) notifyWorkspaceMutation(this, stream, ev.toolCallId);
            if (t) {
              t.status = ev.status;
              if (ev.detail != null) t.detail = ev.detail;
              if (ev.result != null) t.result = ev.result;
              if (ev.display != null) t.display = ev.display;
              if (ev.summary != null) t.summary = ev.summary;
              if (ev.input != null) t.input = ev.input;
              if (ev.ms != null) t.ms = ev.ms;
              Object.assign(t, pickAgentMetadata(ev));
              break;
            }
          }
          this.liveSteps.push({
            type: 'tool',
            name: ev.name || 'tool',
            toolCallId: ev.toolCallId,
            ...pickAgentMetadata(ev),
            status: ev.status || 'start',
            detail: ev.detail || '',
            ...(ev.result != null ? { result: ev.result } : {}),
            ...(ev.display ? { display: ev.display } : {}),
            // 新服务端会带上「操作对象」摘要与脱敏参数，运行中即可看到在动哪个文件
            summary: ev.summary || '',
            input: ev.input,
            ms: ev.ms,
          });
          break;
        }
        case 'changeset':
          if (ev.changeset) {
            // Emitting a reverted draft can also signal that its last
            // proposed change was withdrawn.
            stream.hasProjectChanges ||= ev.changeset.id != null && ev.changeset.status !== 'reverted';
            void editorFor(this).reconcileChangeset(ev.changeset).catch(() => {});
          }
          break;
        case 'error':
          stream.failed = true;
          this.lastError = ev.message || 'AI 服务出错';
          if (!stream.recoveredById) uiFor(this).error(this.lastError);
          break;
        case 'done':
          stream.terminal = true;
          if (TERMINAL_RUN_STATES.has(ev.state)) {
            stream.terminalState = ev.state;
            this.runState = ev.state;
            stream.failed = ev.state === 'failed' || ev.state === 'interrupted';
            stream.cancelled = ev.state === 'cancelled';
          }

          // 立即 finalize；流结束后的兜底调用会被幂等跳过
          this._finishStream(stream.chatId, { stream }).catch(() => {});
          break;
        default:
          break;
      }
    },
    async _finishStream(chatId, { reload = true, stream = runtime(this).stream } = {}) {
      if (!this._isCurrentStream(stream)) return;
      const text = this.streamText;
      const completed = stream.terminalState === 'completed' && !stream.failed && !stream.cancelled;
      const runId = stream.runId || stream.requestId;
      if (runId) runtime(this).context?.settleRun?.(runId, completed && !stream.hasProjectChanges);
      if (completed) {
        void notifyAgentCompletion({ runId, projectId: stream.projectId,
          state: stream.terminalState, live: stream.notificationArmed }).catch(() => {});
      }
      // 本地消息也带上步骤：重载失败或中断（不重载）时仍能显示这一轮的过程
      if (text || this.liveSteps.length) {
        if (stream.recoveredById) this.messages = this.messages.filter(m => m.role !== 'assistant' || m.runId !== runId);
        this.messages.push({
          id: this.activeMessageId || `local-a-${Date.now()}`,
          role: 'assistant',
          runId: stream.runId,
          runState: stream.terminalState || (stream.cancelled ? 'cancelled' : stream.failed ? 'failed' : 'completed'),
          content: text,
          steps: this.liveSteps.map((s) => s.type === 'tool' && s.status === 'start' ? { ...s, status: stream.cancelled ? 'cancelled' : stream.failed ? 'error' : 'end', detail: stream.cancelled ? '已停止' : stream.failed ? '任务中断，步骤未完成' : (s.detail || '本轮已结束') } : ({ ...s })),
          createdAt: new Date().toISOString(),
        });
      }
      this.messages = orderRunInputs(this.messages);
      this.streamText = '';
      this.liveSteps = [];
      this.streamStartedAt = null;
      this.streaming = false;
      stream.finished = true;
      this.pendingQuestion = null;
      this.activeRunId = null;
      this.cancelling = false;
      this.sendingInput = false;
      this.connectionLost = false;
      this.reconnectAttempt = 0;
      this.reconnecting = false;
      runtime(this).stream = null;
      if (reload && (!stream.failed || stream.terminal) && stream.projectId != null) {
        try {
          const finalError = this.lastError;
          const editor = editorFor(this);
          if (String(editor.projectId) === String(stream.projectId)) void editor.reconcileChangeset().catch(() => {});
          await this.loadChat(stream.projectId, { noStore: true, restoreRun: false }); // 只重载发起本轮的项目
          if (this.projectId === stream.projectId && !this.streaming && finalError) this.lastError = finalError;
        } catch { /* 保留本地消息 */ }
      }
    },
    async _requestCancellation(stream) {
      if (!this._isCurrentStream(stream) || stream.cancelRequest) return stream?.cancelRequest;
      const runId = stream.runId || stream.requestId;
      if (!runId) return; // Keep waiting for a legacy server's first event.
      const observedAtRequest = stream.runObserved;
      let retryAfterRegistration = false;
      stream.cancelRequest = (async () => {
        try {
          const result = await api.post(`/api/projects/${stream.projectId}/agent/runs/${encodeURIComponent(runId)}/cancel`, {});
          if (!this._isCurrentStream(stream)) return;
          if (result.run && TERMINAL_RUN_STATES.has(result.run.state)) this._onEvent({ type: 'run', runId, state: result.run.state }, stream);
          else if (this.connectionLost) this.reconnectRun();
        } catch (e) {
          if (!this._isCurrentStream(stream)) return;
          // A cancel request can arrive before the original POST is registered.
          // Never turn this 404 into a successful stop or abort its observer.
          if (e?.status === 404 && !observedAtRequest) {
            retryAfterRegistration = stream.runObserved;
            if (this.connectionLost) this.reconnectRun();
            return;
          }
          stream.cancelRequested = false;
          this.cancelling = false;
          this.lastError = e.message || '停止失败，请重试';
          uiFor(this).error(this.lastError);
        }
      })();
      try { await stream.cancelRequest; } finally {
        stream.cancelRequest = null;
        if (retryAfterRegistration && stream.cancelRequested) this._requestCancellation(stream);
      }
    },
    async cancelStream() {
      const stream = runtime(this).stream;
      if (!this._isCurrentStream(stream)) return;
      stream.cancelRequested = true;
      this.cancelling = true;
      this.runState = 'cancelling';
      return this._requestCancellation(stream);
    },
    async sendMessage(projectId, text, { currentFile, currentContent, manuscriptFocus, selection, attachments, reviewId } = {}) {
      const ui = uiFor(this);
      const msg = String(text ?? '').trim();
      const hasAtts = !!(attachments?.images?.length || attachments?.files?.length);
      if ((!msg && !hasAtts) || this.streaming || this.resetting || this.compacting) return false;
      const preparation = prepareRunModel(this, projectId);
      if (!preparation) return false;
      if (preparation.loading) await preparation.loading;
      const model = preparation.takeModel();
      if (!model) return false;
      let stream;
      try {
        const attNames = hasAtts
          ? [...(attachments.images || []).map((i) => i.name), ...(attachments.files || []).map((f) => f.name)]
          : [];
        this.messages.push({
          id: `local-u-${Date.now()}`,
          role: 'user',
          content: attNames.length ? `${msg}\n\n[附件：${attNames.join('、')}]` : msg,
          createdAt: new Date().toISOString(),
        });
        stream = this._beginStream({ requestId: createRequestId(), session: preparation.session });
        const body = { requestId: stream.requestId, message: msg || '请查看我刚上传的附件。', ...model };
        if (currentFile) body.currentFile = currentFile;
        if (reviewId != null) body.reviewId = reviewId;
        if (manuscriptFocus) body.manuscriptFocus = manuscriptFocus;
        if (currentContent != null) body.currentContent = truncateContext(currentContent, CONTEXT_MAX);
        if (selection && selection.text) body.selection = selection; // 选中原文：单独注入模型上下文，不进对话消息
        if (attachments?.images?.length) body.images = attachments.images; // 图片：多模态注入 + 存工作区
        if (attachments?.files?.length) body.files = attachments.files; // 文件：存入工作区供智能体读取
        await ssePost(`/api/projects/${projectId}/agent/chat`, body, (ev) => this._onEvent(ev, stream), {
          signal: stream.controller.signal,
        });
        if (this._isCurrentStream(stream) && (stream.runId || stream.requestId)) await this._watchRun(stream, { initial: true });
        else await this._finishStream(stream.chatId, { stream });
        return !!stream.finished && !stream.failed && !stream.cancelled && this.projectId === stream.projectId &&
          runtime(this).projectVersion === stream.projectVersion;
      } catch (e) {
        if (!this._isCurrentStream(stream)) return false;
        if (e?.name !== 'AbortError' && !e?.status) {
          await this._watchRun(stream, { initial: true });
          return !!stream.finished && !stream.failed && !stream.cancelled && this.projectId === stream.projectId &&
            runtime(this).projectVersion === stream.projectVersion;
        }
        if (e?.name !== 'AbortError') {
          this.lastError = e.message || '发送失败';
          ui.error(this.lastError);
        }
        await this._finishStream(stream.chatId, { reload: false, stream });
        return false;
      }
    },
    async runSelectionAction(projectId, action, { file, start, end, selectionText } = {}) {
      const ui = uiFor(this);
      if (this.streaming || this.resetting || this.compacting) return false;
      const preparation = prepareRunModel(this, projectId);
      if (!preparation) return false;
      if (preparation.loading) await preparation.loading;
      const saving = preparation.current() && !preparation.failed && file && pendingProjectEdits(projectId, undefined, file);
      if (saving) {
        try { await saving; }
        catch (error) {
          if (!preparation.release()) return false;
          this.lastError = error.message;
          ui.error(this.lastError);
          throw error;
        }
      }
      const model = preparation.takeModel();
      if (!model) return false;
      const stream = this._beginStream({ requestId: createRequestId(), session: preparation.session });
      try {
        const body = { requestId: stream.requestId, action, file, start, end, ...model };
        if (typeof selectionText === 'string') body.selectionText = selectionText;
        await ssePost(
          `/api/projects/${projectId}/agent/selection-action`,
          body,
          (ev) => this._onEvent(ev, stream),
          { signal: stream.controller.signal },
        );
        if (!this._isCurrentStream(stream) && !stream.finished) return false;
        if (this._isCurrentStream(stream) && (stream.runId || stream.requestId)) await this._watchRun(stream, { initial: true });
        else await this._finishStream(stream.chatId, { stream });
        return !!stream.finished && !stream.failed && !stream.cancelled && this.projectId === stream.projectId &&
          runtime(this).projectVersion === stream.projectVersion;
      } catch (e) {
        if (!this._isCurrentStream(stream)) return false;
        if (e?.name !== 'AbortError' && !e?.status) {
          await this._watchRun(stream, { initial: true });
          return !!stream.finished && !stream.failed && !stream.cancelled;
        }
        await this._finishStream(stream.chatId, { reload: false, stream });
        if (e?.name === 'AbortError') return false;
        this.lastError = e.message || 'AI 处理失败';
        ui.error(this.lastError);
        throw e; // 让调用方（右键菜单等）不要在失败时弹成功提示
      }
    },
  },
};

const useDefaultAgentStore = defineStore('agent', agentOptions);
const projectAgentDefinitions = new Map();
export function createProjectAgentStore(key, pinia) {
  const id = `agent.project.${String(key)}`;
  if (!projectAgentDefinitions.has(id)) projectAgentDefinitions.set(id, defineStore(id, agentOptions));
  const store = projectAgentDefinitions.get(id)(pinia);
  store.setProject(key);
  return store;
}
export function useAgentStore(pinia, hot) {
  const project = !pinia && !hot ? useProjectContext() : null;
  return project?.agent || useDefaultAgentStore(pinia, hot);
}
useAgentStore.$id = useDefaultAgentStore.$id;
