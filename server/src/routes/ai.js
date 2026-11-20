import fs from 'node:fs';
import { getArtifactForUser } from '../services/agent/artifacts.js';
import { readChatRunHistory, messageRunMetadata } from '../services/agent/chatRunHistory.js';
import { createHash, randomUUID } from 'node:crypto';
import { normalizeFocus, selectionFocus } from '../services/agent/manuscriptContext.js';
import { flushProjectRooms } from '../collab.js';
import { createRun, startRun, assertChatIdle, activeRunForChat, getRun, runSnapshot, observeRun, cancelRun, queueRunInput, answerRunQuestion, acceptedRunAnswer, lastQueuedRunInput, clearChatAfterCancellation } from '../services/agent/runs.js';
import { Router } from 'express';
import multer from 'multer';
import { getDb } from '../db.js';
import { withWorkAdmission } from '../services/maintenance.js';
import { recordAiUsage } from '../quotas.js';
import { projectDir } from '../config.js';
import { requireProjectAccess } from '../access.js';
import { asyncHandler, HttpError, safeJoin } from '../util.js';
import { estimateCoordinatorFixedTokens, runAgent } from '../services/agent/agentLoop.js';
import { getChangeset, getFileDiff, acceptChangeset, revertChangeset, listChangesets, ensureReviewBase, getReviewBase, setReviewBase, deleteReviewBase, reviewBaseFallback, getReviewSnapshot, resolveReviewHunk, updateReviewBase, resolveReviewFiles } from '../services/agent/changesets.js';
import { listSkills, importSkillZip, importSkillFiles, deleteSkill, createSkill, batchSkills, readSkillContent, writeSkillContent } from '../services/agent/skills.js';
import { getMcpTools } from '../services/agent/mcp.js';
import { compressHistoryIfNeeded, contextModelKey } from '../services/agent/context.js';
import { estimateSavedContextUsage, readContextUsage, refreshSavedContextUsage } from '../services/agent/contextUsage.js';
import { createOrchestrationRuntime } from '../services/agent/orchestrationRuntime.js';
import { normalizeProviderUsage } from '../services/agent/modelUsage.js';
import { normalizeModelEntry, parseModelSettings, resolveModelConfig, validateProviders, migrateLegacyModels, normalizeReasoningLevels, validateSubagentConfig, stripRetiredAgentConfig } from '../services/agent/models.js';

/**
 * AI 路由。默认导出项目级路由（挂载方负责 /api/projects 前缀与 requireAuth）；
 * settingsRouter 挂 /api/settings（同样由挂载方加 requireAuth）。
 */

const router = Router();
router.get('/:id/agent/artifacts/:artifactId', asyncHandler(async (req, res) => {
  const { project } = requireProjectAccess(req.user, req.params.id);
  const artifact = getArtifactForUser(req.params.artifactId, project.id, req.user.id);
  res.setHeader('Content-Type', artifact.mime_type);
  res.setHeader('Content-Length', artifact.size_bytes);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.sendFile(artifact.file);
}));
// Archived draft bytes are private to the account and current conversation,
// even when other members can read every project file.
router.get('/:id/agent/drafts/:draftId', asyncHandler(async (req, res) => {
  const { project } = requireProjectAccess(req.user, req.params.id);
  const draftId = Number(req.params.draftId), chatId = Number(req.query.chatId);
  if (!Number.isSafeInteger(draftId) || draftId <= 0 || !Number.isSafeInteger(chatId) || chatId <= 0)
    throw new HttpError(400, '非法草稿或会话标识');
  const db = getDb();
  if (findChat(db, project.id, req.user.id)?.id !== chatId) throw new HttpError(404, '恢复草稿不存在');
  const draft = db.prepare(`SELECT d.* FROM agent_drafts d JOIN chats c ON c.id=d.chat_id
    WHERE d.id=? AND d.project_id=? AND d.user_id=? AND d.chat_id=? AND d.state='conflicted'
      AND c.project_id=d.project_id AND c.user_id=d.user_id`).get(draftId, project.id, req.user.id, chatId);
  if (!draft) throw new HttpError(404, '恢复草稿不存在');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `attachment; filename="corelatex-draft-${draft.id}-v${draft.version}.json"`);
  res.json({ format: 'corelatex-agent-draft', formatVersion: 1, draftId: draft.id,
    projectId: project.public_id, chatId: draft.chat_id, version: draft.version,
    publishedVersion: draft.published_version, changesetId: draft.changeset_id,
    state: draft.state, updatedAt: draft.updated_at, files: JSON.parse(draft.files_json) });
}));
export const settingsRouter = Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// 宽容的 multer 封装：任意字段名均可；multer 错误转成 400 提示而非 500
function multerUpload(options) {
  const mw = multer(options);
  return (req, res, next) => {
    mw.any()(req, res, (err) => {
      if (!err) return next();
      if (err.code === 'LIMIT_FILE_COUNT') return next(new HttpError(400, '所选目录文件数过多，请选择单个技能目录后重试'));
      if (err.code === 'LIMIT_FILE_SIZE') return next(new HttpError(400, '单个文件超过 50MB 上限'));
      next(new HttpError(400, `上传失败：${err.message}`));
    });
  };
}
const uploadSkillZip = multerUpload({ limits: { fileSize: 50 * 1024 * 1024, files: 2 } });
const uploadSkillFiles = multerUpload({ limits: { fileSize: 20 * 1024 * 1024, files: 2000 } });

// ---------- 会话（跟随项目：每用户在每个项目只有一个会话，进入项目自动加载/创建） ----------

function findChat(db, projectId, userId) {
  return db.prepare('SELECT * FROM chats WHERE project_id = ? AND user_id = ? ORDER BY id DESC LIMIT 1').get(projectId, userId);
}

function ensureChat(db, projectId, userId) {
  const existing = findChat(db, projectId, userId);
  if (existing) return existing;
  const info = db.prepare('INSERT INTO chats (project_id, user_id) VALUES (?,?)').run(projectId, userId);
  return db.prepare('SELECT * FROM chats WHERE id = ?').get(Number(info.lastInsertRowid));
}

function shapeMessages(rows) {
  return rows.map((r) => ({
    id: r.id,
    role: r.role,
    content: r.content,
    toolCalls: JSON.parse(r.tool_calls || '[]'),
    steps: JSON.parse(r.steps || '[]'),
    createdAt: r.created_at,
    durationMs: r.duration_ms || 0,
    ...messageRunMetadata(r),
  }));
}

function selectedContextUsage(db, chat, project, userId, requestedModelId) {
  if (!chat) return null;
  const settings = db.prepare('SELECT * FROM settings WHERE user_id=?').get(userId);
  const { models, activeId } = parseModelSettings(settings);
  const modelId = requestedModelId || activeId;
  const modelConfig = models.find(model => model.id === modelId && model.enabled);
  if (!modelConfig) return null;
  return readContextUsage(chat, modelConfig) ?? estimateSavedContextUsage({
    chat, modelConfig, messages: buildHistory(db, chat),
    estimateFixedTokens: () => estimateCoordinatorFixedTokens({ project, settings }),
  });
}

router.get('/:id/chat', asyncHandler(async (req, res) => {
  const { project } = requireProjectAccess(req.user, req.params.id);
  const db = getDb();
  const chat = ensureChat(db, project.id, req.user.id);
  const rows = readChatRunHistory(db, chat.id);
  const contextUsage = selectedContextUsage(db, chat, project, req.user.id, req.query.modelId);
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({ chatId: chat.id, messages: shapeMessages(rows), contextUsage });
}));

router.get('/:id/agent/context', asyncHandler(async (req, res) => {
  const { project } = requireProjectAccess(req.user, req.params.id);
  const db = getDb();
  const chat = findChat(db, project.id, req.user.id);
  const contextUsage = selectedContextUsage(db, chat, project, req.user.id, req.query.modelId);
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({ chatId: chat?.id ?? null, contextUsage });
}));

// 清空会话：删除全部消息并重置压缩摘要（会话行保留）
router.delete('/:id/chat', asyncHandler(async (req, res) => {
  const { project } = requireProjectAccess(req.user, req.params.id, { write: true });
  const db = getDb();
  const chat = ensureChat(db, project.id, req.user.id);
  await clearChatAfterCancellation(chat.id);
  res.json({ ok: true });
}));

router.post('/:id/agent/context/compact', asyncHandler(async (req, res) => {
  const { project } = requireProjectAccess(req.user, req.params.id, { write: true });
  const db = getDb();
  const prepared = withWorkAdmission(db, () => {
    const chat = ensureChat(db, project.id, req.user.id);
    assertChatIdle(chat.id);
    const settings = db.prepare('SELECT * FROM settings WHERE user_id=?').get(req.user.id);
    const modelConfig = resolveModelConfig(settings, req.body?.modelId, req.body?.reasoningEffort);
    const messages = buildHistory(db, chat);
    // Repeated clicks must not buy a new summary when no history can be cut.
    const hasPrefix = messages.findLastIndex(message => message.role === 'user') > 0;
    const needsHandoff = !!chat.summary && chat.context_model_key !== contextModelKey(modelConfig);
    if (!hasPrefix && !needsHandoff) return { chat, modelConfig, messages, settings };
    const run = createRun({ projectId: project.id, chatId: chat.id, userId: req.user.id });
    run.control.sealInputs();
    return { chat, modelConfig, messages, run, needsHandoff, settings };
  });
  const { chat, modelConfig, messages, run, settings } = prepared;
  const estimateFixedTokens = () => estimateCoordinatorFixedTokens({ project, settings });
  if (!run) return res.json({ compressed: false, contextUsage: readContextUsage(chat, modelConfig)
    ?? estimateSavedContextUsage({ chat, modelConfig, messages, estimateFixedTokens }) });
  let outcome, failure;
  const redact = text => modelConfig.apiKey ? String(text).split(modelConfig.apiKey).join('[密钥已隐藏]') : String(text);
  const checkAccess = () => {
    if (db.prepare('SELECT status FROM users WHERE id=?').get(req.user.id)?.status !== 'active') throw new HttpError(403, '账号已被禁用');
    requireProjectAccess(req.user, project.public_id, { write: true });
  };
  await startRun(run, async () => {
    try {
      const requestRuntime = createOrchestrationRuntime({ maxConcurrency: 1,
        onRequestSettled: ({ entry }) => recordAiUsage({ userId: req.user.id, projectId: project.id, chatId: chat.id, entry }),
      });
      const compressed = await compressHistoryIfNeeded({ db, chat, messages, modelConfig,
        maxTokens: modelConfig.maxTokens, signal: run.controller.signal, force: true, requestRuntime,
        resummarizeExistingSummary: prepared.needsHandoff, beforeRequest: checkAccess, beforePersist: checkAccess });
      run.controller.signal.throwIfAborted();
      db.prepare('UPDATE chats SET context_model_key=? WHERE id=?').run(contextModelKey(modelConfig), chat.id);
      const contextUsage = refreshSavedContextUsage({ db, chatId: chat.id, modelConfig,
        messages: compressed.messages, estimateFixedTokens, emit: run.emit });
      outcome = { compressed: compressed.compressed, contextUsage };
    } catch (error) {
      failure = new HttpError(run.controller.signal.aborted ? 409 : 502,
        run.controller.signal.aborted ? '上下文压缩已取消，历史记录未省略' : redact(error.message || '上下文压缩失败'));
      throw failure;
    }
  });
  if (failure) throw failure;
  res.json(outcome);
}));

// ---------- 智能体对话（SSE） ----------

function startSSE(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  return (ev) => {
    try { res.write(`${ev.seq ? `id: ${ev.seq}\n` : ''}data: ${JSON.stringify(ev)}\n\n`); } catch { /* 客户端已断开 */ }
  };
}

function buildHistory(db, chat) {
  // 只回放 user/assistant 文本（tool_calls 列仅供 UI 展示，不回放给模型，
  // 避免缺 tool 结果消息导致 OpenAI/Anthropic 报格式错误）。
  // assistant 行附带两个派生量（agentLoop 回放时使用）：
  //   toolCount（真实工具调用数）：追加系统标注，告知模型「历史里的工作报告背后
  //     有真实工具调用」——弱工具调用模型看到纯文本报告会模仿「写报告」而不发
  //     工具调用（多轮幻觉循环的诱因）；
  //   skillsLoaded（该轮 read_skill 加载过本体的技能名，不含 file= 片段读取）：
  //     技能路由提示据此区分「首次命中→先加载」与「近期已加载→沿用即可」，
  //     防止跟进型小改写每轮重复加载路由技能与级联片段（上下文膨胀实录）。
  // 已被压缩的旧消息（id ≤ summary_msg_id）不回放，以摘要形式注入系统提示词。
  const since = chat?.summary_msg_id || 0;
  const history = readChatRunHistory(db, chat.id, { since })
    .map((r) => {
      let toolCount = 0;
      const skillsLoaded = [];
      try {
        const tc = JSON.parse(r.tool_calls || '[]');
        if (Array.isArray(tc)) {
          toolCount = tc.length;
          for (const t of tc) {
            if (t && t.name === 'read_skill' && t.input?.name && !t.input.file) {
              skillsLoaded.push(String(t.input.name));
            }
          }
        }
      } catch { /* 解析失败按无工具处理，不影响回放 */ }
      return { id: r.id, role: r.role, content: r.content, toolCount, skillsLoaded };
    });
  return history;
}

function streamRun(req, res, runId, after = 0) {
  const emit = startSSE(res);
  let unsubscribe = () => {};
  let heartbeat;
  const cleanup = () => { unsubscribe(); clearInterval(heartbeat); };
  res.on('close', cleanup);
  unsubscribe = observeRun(runId, after, (event) => {
    if (res.destroyed || res.writableEnded) return;
    emit(event);
    if (event.type === 'done') { cleanup(); res.end(); }
  });
  const state = getRun(runId)?.state;
  if (!['running', 'waiting_for_user', 'cancelling'].includes(state) || res.writableEnded) {
    cleanup();
    if (!res.writableEnded) res.end();
    return;
  }
  heartbeat = setInterval(() => {
    try {
      requireProjectAccess(req.user, req.params.id);
      if (!res.destroyed && !res.writableEnded) res.write(': heartbeat\n\n');
    } catch { cleanup(); res.end(); }
  }, 15000);
  heartbeat.unref();
}

// The client knows this ID before receiving any SSE bytes. Repeating a request
// only observes its original run; it must not write attachments or messages again.
function replayRequestedRun(req, res, project, chat) {
  const value = req.body?.requestId;
  if (value == null) return false;
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new HttpError(400, 'requestId 必须是有效的 UUID v4');
  }
  req.agentRequestId = value.toLowerCase();
  const existing = getRun(req.agentRequestId);
  if (!existing) return false;
  if (existing.project_id !== project.id || existing.chat_id !== chat?.id || existing.user_id !== req.user.id) {
    throw new HttpError(409, '请求标识已被使用，请重新发起请求');
  }
  streamRun(req, res, existing.id);
  return true;
}

async function runAgentSSE(req, res, { project, chat, messages, modelConfig, currentFile, currentContent, manuscriptFocus, reviewThread, precreatedRun }) {
  const run = precreatedRun || createRun({ projectId: project.id, chatId: chat.id, userId: req.user.id, runId: req.agentRequestId });
  streamRun(req, res, run.id);
  await startRun(run, async () => {
    try {
      const result = await runAgent({
        user: req.user, project, chat, messages, modelConfig, currentFile, currentContent, manuscriptFocus, reviewThread,
        emit: run.emit, signal: run.controller.signal, runControl: run.control,
      });
      const db = getDb();
      const currentChat = db.prepare('SELECT * FROM chats WHERE id=?').get(chat.id);
      if (currentChat) refreshSavedContextUsage({ db, chatId: chat.id, modelConfig,
        messages: buildHistory(db, currentChat), emit: run.emit,
        estimateFixedTokens: () => estimateCoordinatorFixedTokens({ project,
          settings: db.prepare('SELECT * FROM settings WHERE user_id=?').get(req.user.id) }),
      });
      return result;
    } catch (err) {
      if (!run.controller.signal.aborted) {
        // Initialization can fail before runAgent creates its assistant row.
        const lastId = messages.reduce((max, m) => Math.max(max, Number(m.id) || 0), 0);
        const recorded = getDb().prepare("SELECT id FROM chat_messages WHERE chat_id = ? AND role = 'assistant' AND id > ? LIMIT 1").get(chat.id, lastId);
        if (!recorded) {
          const note = `⚠️ 本轮执行失败：${err.message || '未知错误'}`;
          getDb().prepare("INSERT INTO chat_messages(chat_id,role,content,tool_calls,steps) VALUES(?,'assistant',?,'[]',?)")
            .run(chat.id, note, JSON.stringify([{ type: 'text', text: note, system: true }]));
        }
      }
      throw err;
    }
  });
}

function requireOwnedRun(req, { write = false } = {}) {
  const { project } = requireProjectAccess(req.user, req.params.id, { write });
  const run = getRun(req.params.runId);
  if (!run || run.project_id !== project.id || run.user_id !== req.user.id) throw new HttpError(404, '运行不存在');
  return run;
}

router.get('/:id/agent/runs/active', asyncHandler(async (req, res) => {
  const { project } = requireProjectAccess(req.user, req.params.id);
  const chat = ensureChat(getDb(), project.id, req.user.id);
  const active = activeRunForChat(chat.id);
  res.json({ run: active ? runSnapshot(active.id) : null });
}));
router.get('/:id/agent/runs/:runId/events', asyncHandler(async (req, res) => {
  const run = requireOwnedRun(req);
  const after = Number(req.query.after ?? req.headers['last-event-id'] ?? 0);
  if (!Number.isSafeInteger(after) || after < 0) throw new HttpError(400, '非法事件序号');
  streamRun(req, res, run.id, after);
}));
router.get('/:id/agent/runs/:runId', asyncHandler(async (req, res) => {
  const run = requireOwnedRun(req);
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({ run: runSnapshot(run.id) });
}));
router.post('/:id/agent/runs/:runId/cancel', asyncHandler(async (req, res) => {
  const run = requireOwnedRun(req);
  res.json({ run: await cancelRun(run.id) });
}));
router.post('/:id/agent/runs/:runId/input', asyncHandler(async (req, res) => {
  const run = requireOwnedRun(req, { write: true });
  const snapshot = queueRunInput(run.id, req.body?.message);
  res.json({ run: snapshot, input: lastQueuedRunInput(run.id) });
}));
router.post('/:id/agent/runs/:runId/answer', asyncHandler(async (req, res) => {
  const run = requireOwnedRun(req, { write: true });
  const questionId = String(req.body?.questionId || '');
  const snapshot = answerRunQuestion(run.id, questionId, req.body?.answer);
  res.json({ run: snapshot, answer: acceptedRunAnswer(run.id, questionId) });
}));

// ---------- 智能体附件（图片/文件上传） ----------

const IMAGE_MIME_RE = /^image\/(png|jpeg|jpg|webp|gif)$/i;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;   // 单张图片解码后上限 5MB
const MAX_FILE_BYTES = 20 * 1024 * 1024;   // 单个文件解码后上限 20MB
const MAX_TOTAL_BYTES = 40 * 1024 * 1024;  // 单次请求附件总量上限 40MB

function safeUploadName(name) {
  const base = String(name || 'file').split(/[\\/]+/).pop().replace(/[\x00-\x1f]/g, '').trim();
  return (base || 'file').slice(0, 120);
}

function decodeAttachment(raw) {
  const s = String(raw || '');
  const b64 = s.includes('base64,') ? s.slice(s.indexOf('base64,') + 7) : s;
  return Buffer.from(b64, 'base64');
}

/**
 * 处理智能体附件：
 *   - 图片（body.images）与文件（body.files）均保存到项目工作区 _workspace/uploads/；
 *   - 图片额外生成多模态部件随本轮消息注入模型上下文（不落库，避免历史膨胀）；
 *   - 返回 { note, imageParts }：note 追加到用户消息文本，imageParts 为 OpenAI 风格部件。
 */
function saveAgentAttachments(body, project) {
  const images = Array.isArray(body?.images) ? body.images : [];
  const files = Array.isArray(body?.files) ? body.files : [];
  if (images.length > 8 || files.length > 10 || images.length + files.length > 12) {
    throw new HttpError(400, '附件最多 12 个，其中图片最多 8 张、文件最多 10 个');
  }
  if (!images.length && !files.length) return { note: '', imageParts: [] };
  let total = 0;
  // Validate every attachment before touching the filesystem; do not silently
  // truncate the user's selection or leave successful prefixes of invalid batches.
  const entries = [...images.map((entry) => ({ entry, kind: 'image' })), ...files.map((entry) => ({ entry, kind: 'file' }))].map(({ entry, kind }) => {
    const name = safeUploadName(entry?.name);
    const mime = String(entry?.mime || 'application/octet-stream');
    const buf = decodeAttachment(entry?.data);
    if (!buf.length) throw new HttpError(400, `附件 ${name} 内容为空`);
    total += buf.length;
    if (total > MAX_TOTAL_BYTES) throw new HttpError(400, '附件总大小超过 40MB 上限');
    if (kind === 'image') {
      if (!IMAGE_MIME_RE.test(mime)) throw new HttpError(400, `不支持的图片格式: ${mime}`);
      if (buf.length > MAX_IMAGE_BYTES) throw new HttpError(400, `图片 ${name} 超过 5MB 上限`);
    } else if (buf.length > MAX_FILE_BYTES) throw new HttpError(400, `文件 ${name} 超过 20MB 上限`);
    return { name, mime, buf, kind, rel: `_workspace/uploads/${Date.now()}-${randomUUID()}-${name}` };
  });
  const dir = safeJoin(projectDir(project.id), '_workspace/uploads');
  fs.mkdirSync(dir, { recursive: true });
  const written = [];
  try {
    for (const entry of entries) {
      const abs = safeJoin(projectDir(project.id), entry.rel);
      written.push(abs);
      fs.writeFileSync(abs, entry.buf, { flag: 'wx' });
    }
  } catch (err) {
    for (const abs of written) { try { fs.unlinkSync(abs); } catch {} }
    throw err;
  }
  const imageParts = entries.filter((s) => s.kind === 'image').map((s) => ({
    type: 'image', imageUrl: `data:${s.mime};base64,${s.buf.toString('base64')}`,
    imageBase64: s.buf.toString('base64'), mediaType: s.mime.toLowerCase(),
  }));
  const lines = entries.map((s) => s.kind === 'image'
    ? `- 图片 ${s.name} 已存入工作区: ${s.rel}（已随消息附给视觉模型，也可用 read_file 查看）`
    : `- 文件 ${s.name} 已存入工作区: ${s.rel}（可用 read_file 读取内容）`);
  return { note: `[用户上传了 ${entries.length} 个附件]\n${lines.join('\n')}`, imageParts,
    // Filesystem writes are not rolled back by SQLite. Only this batch's
    // generated paths may be removed when admission preparation later fails.
    rollback() { for (const abs of written) { try { fs.unlinkSync(abs); } catch {} } },
  };
}

router.post('/:id/agent/chat', asyncHandler(async (req, res) => {
  const { project } = requireProjectAccess(req.user, req.params.id, { write: true });
  const message = String(req.body?.message || '').trim();
  const hasAttachments = (Array.isArray(req.body?.images) && req.body.images.length)
    || (Array.isArray(req.body?.files) && req.body.files.length);
  if (!message && !hasAttachments) throw new HttpError(400, '消息不能为空');
  const db = getDb();
  // Retrying an existing run remains read-only and available during maintenance.
  if (replayRequestedRun(req, res, project, findChat(db, project.id, req.user.id))) return;
  let attachments;
  let prepared;
  try {
    prepared = withWorkAdmission(db, () => {
      const chat = ensureChat(db, project.id, req.user.id);
      assertChatIdle(chat.id);
      const settings = db.prepare('SELECT * FROM settings WHERE user_id = ?').get(req.user.id);
      const modelConfig = resolveModelConfig(settings, req.body?.modelId, req.body?.reasoningEffort);
      try { attachments = saveAgentAttachments(req.body, project); }
      catch (err) {
        if (err instanceof HttpError) throw err;
        throw new HttpError(400, `附件处理失败：${err.message}`);
      }
      const fullMessage = message || (attachments.note ? '请查看我刚上传的附件。' : '');
      const userText = fullMessage + (attachments.note ? `\n\n${attachments.note}` : '');
      const userEntry = db.prepare("INSERT INTO chat_messages (chat_id, role, content) VALUES (?, 'user', ?)").run(chat.id, userText);
      const messages = buildHistory(db, chat);
      // Keep the full selection and multimodal content in this run's context,
      // while persisted history contains only the original user message.
      const sel = req.body?.selection;
      if (sel && typeof sel.text === 'string' && sel.text.trim()) {
        const loc = [
          sel.file ? String(sel.file) : '',
          sel.startLine ? `第 ${sel.startLine}${sel.endLine && sel.endLine !== sel.startLine ? '–' + sel.endLine : ''} 行` : '',
        ].filter(Boolean).join(' · ');
        const lastUser = [...messages].reverse().find(m => m.role === 'user');
        if (lastUser) lastUser.content += `\n\n[用户选中的内容${loc ? `（${loc}）` : ''}]\n${sel.text.slice(0, 20_000)}\n[选中内容结束]`;
      }
      if (attachments.imageParts.length) {
        const lastUser = [...messages].reverse().find(m => m.role === 'user');
        if (lastUser) lastUser.content = [{ type: 'text', text: String(lastUser.content ?? '') }, ...attachments.imageParts];
      }
      if (req.body?.currentFile != null && typeof req.body.currentFile !== 'string') throw new HttpError(400, 'currentFile 必须是文本路径');
      let currentFile = req.body?.currentFile || undefined;
      let currentContent = typeof req.body?.currentContent === 'string' ? req.body.currentContent : undefined;
      let manuscriptFocus = normalizeFocus(req.body?.manuscriptFocus);
      let reviewThread;
      if (req.body?.reviewId != null) {
        if (!Number.isSafeInteger(req.body.reviewId) || req.body.reviewId < 1) throw new HttpError(400, '批注编号无效');
        const review = db.prepare('SELECT r.*, COALESCE(NULLIF(u.display_name, \'\'), u.username) AS author FROM reviews r LEFT JOIN users u ON u.id=r.author_id WHERE r.id=? AND r.project_id=?').get(req.body.reviewId, project.id);
        if (!review) throw new HttpError(404, '批注不存在');
        if (review.status !== 'open') throw new HttpError(409, '批注已完成，请刷新审阅面板');
        if (currentFile !== review.file_path) manuscriptFocus = null;
        currentFile = review.file_path;
        currentContent = undefined;
        const replies = db.prepare('SELECT rr.content, COALESCE(NULLIF(u.display_name, \'\'), u.username) AS author FROM review_replies rr LEFT JOIN users u ON u.id=rr.author_id WHERE rr.review_id=? ORDER BY rr.id DESC LIMIT 9').all(review.id);
        const excerpt = (value, limit) => value?.length > limit ? value.slice(0, limit) + '…（节选）' : value || '';
        reviewThread = { id: review.id, author: review.author, comment: excerpt(review.content, 3000), quote: excerpt(review.quoted_text, 1800),
          startOffset: review.start_offset, endOffset: review.end_offset, earlierRepliesOmitted: replies.length > 8,
          recentReplies: replies.slice(0, 8).reverse().map(reply => ({ author: reply.author, text: excerpt(reply.content, 900) })) };
        // Keep the reviewed discussion available for follow-up turns. Quote the
        // snapshot separately from the user's authority to edit the manuscript.
        const discussion = [{ author: review.author, text: reviewThread.comment }, ...reviewThread.recentReplies]
          .map(entry => (entry.author || '协作者') + '：' + entry.text).join('\n').replace(/^/gm, '> ');
        db.prepare('UPDATE chat_messages SET content=? WHERE id=?').run(userText + '\n\n当时的批注与讨论（节选）\n' + discussion, userEntry.lastInsertRowid);
      }
      // Keep creation last: a rejected gate or failed preparation cannot leave
      // a message or a half-created run behind.
      const precreatedRun = createRun({ projectId: project.id, chatId: chat.id, userId: req.user.id, runId: req.agentRequestId });
      return { project, chat, messages, modelConfig, currentFile, currentContent, manuscriptFocus, reviewThread, precreatedRun };
    });
  } catch (err) {
    attachments?.rollback?.();
    throw err;
  }
  // Opening SSE and executing asynchronous model work happen after commit.
  await runAgentSSE(req, res, prepared);
}));

const SELECTION_ACTIONS = {
  translate: {
    label: '翻译',
    instruction: (file, sel) =>
      `请把以下选区内容逐句精确翻译成中文（用于学术精读，不是大意转述），直接在回复中给出完整译文。质量红线：\n` +
      `1. 完整：原文每一句都必须译出，不得跳句、并句、删减或概括；选区再长也不得压缩篇幅；\n` +
      `2. 精确：忠实原文语义与逻辑关系（因果、转折、条件、让步、限定），数字、单位、专有名词不得改动或自行推断；原句表达模糊时按最贴近原意的直译处理，不做发挥；\n` +
      `3. 句对齐：按原文顺序逐句对应翻译，句序不调换、段落结构保持一致，便于中英对照阅读；\n` +
      `4. 术语：专业术语采用学界通行译名，首次出现写作「中文译名（英文原词）」，全文同一术语译法保持一致；\n` +
      `5. LaTeX：\\cite、\\ref、\\eqref 等引用命令与数学公式、环境命令原样保留在译文中的对应位置，公式不翻译、不解释。\n` +
      `只输出译文本身——不要复述原文，不要加逐句编号、对照表或翻译说明。\n` +
      `不要修改任何文件、不要调用编辑工具——译文只输出在回复里，由用户自行决定是否采用。\n原选区文本（来自文件 ${file}）：\n${sel}`,
  },
  explain: {
    label: '解释',
    instruction: (file, sel) =>
      `请解释以下 LaTeX 片段的含义与作用，直接在回复中说明即可，不要修改任何文件。\n片段（来自文件 ${file}）：\n${sel}`,
  },
  'add-comment': {
    label: '添加中文注释',
    instruction: (file, sel) =>
      `请为文件 ${file} 中以下选区的英文自然语言逐段添加完整中文对照译注，使用 edit_file 工具实际修改。` +
      `先读取选区附近内容，识别段落及已有对应译注；每个英文段落后紧跟以 % 中文： 开头的译文，可分多行，每行均以 % 开头。` +
      `必须逐句忠实翻译全部信息，不能只写摘要或大意，不设字数上限；完整保留事实、条件、例外、否定、比较关系及不确定性，` +
      `数字、符号、百分比、单位、模型和数据集名称一一对应，引用命令及 key、公式与变量原样保留在对应位置。` +
      `保持英文原文不变；若已有中文对照，应补全或替换同一条译注，不重复堆叠。search 使用从文件读取的精确原文，范围只覆盖选区及其对应译注，不改无关内容。` +
      `交付前逐句核对中英文是否完整对应。若选区仅含工程注释、宏定义、公式或表格数据，请说明不适用，不机械添加翻译。\n原选区文本：\n${sel}`,
  },
  simplify: {
    label: '精简',
    instruction: (file, sel) =>
      `请精简以下内容，删去赘述并保留限定条件、数值和引文。沿用相邻正文的术语与语气。使用 edit_file 工具将文件 ${file} 中的原选区文本替换为精简后的版本` +
      `（search 参数必须与原选区文本完全一致）。\n原选区文本：\n${sel}`,
  },
  expand: {
    label: '扩写',
    instruction: (file, sel) =>
      `请扩写以下内容，沿用本节的论证顺序，补足原文可支持的推理或过渡。新实验、数值和文献需要可核查的依据。使用 edit_file 工具将文件 ${file} 中的原选区文本替换为扩写后的版本` +
      `（search 参数必须与原选区文本完全一致）。\n原选区文本：\n${sel}`,
  },
  optimize: {
    label: '优化',
    instruction: (file, sel) =>
      `请优化改写以下 LaTeX 内容。先以邻段为样例对齐术语、人称、句式和论断力度；保留原意、数字、公式和交叉引用，只处理影响表达的地方。使用 edit_file 工具将文件 ${file} ` +
      `中的原选区文本替换为改写结果（search 参数必须与原选区文本完全一致）。\n原选区文本：\n${sel}`,
  },
};

router.post('/:id/agent/selection-action', asyncHandler(async (req, res) => {
  const { project } = requireProjectAccess(req.user, req.params.id, { write: true });
  const db = getDb();
  if (replayRequestedRun(req, res, project, findChat(db, project.id, req.user.id))) return;
  const prepared = withWorkAdmission(db, () => {
    const chat = ensureChat(db, project.id, req.user.id);
    const action = String(req.body?.action || '');
    const spec = SELECTION_ACTIONS[action];
    if (!spec) throw new HttpError(400, '不支持的操作（translate/add-comment/explain/simplify/expand/optimize）');
    const file = String(req.body?.file || '');
    const abs = safeJoin(projectDir(project.id), file);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new HttpError(404, '文件不存在');
    flushProjectRooms(project.id);
    const content = fs.readFileSync(abs, 'utf8');
    const start = Math.max(0, Number(req.body?.start) || 0);
    const end = Math.min(content.length, Number(req.body?.end) || 0);
    if (end <= start) throw new HttpError(400, '选区为空');
    const selected = content.slice(start, end);
    if (typeof req.body?.selectionText === 'string' && req.body.selectionText !== selected) throw new HttpError(409, '选区内容已变化，请重新选择后重试');
    if (req.body?.selectionHash && String(req.body.selectionHash) !== createHash('sha256').update(selected).digest('hex')) throw new HttpError(409, '选区内容已变化，请重新选择后重试');
    assertChatIdle(chat.id);
    const settings = db.prepare('SELECT * FROM settings WHERE user_id = ?').get(req.user.id);
    const modelConfig = resolveModelConfig(settings, req.body?.modelId, req.body?.reasoningEffort);
    const display = `[${spec.label}] ${file}：${selected.slice(0, 120)}${selected.length > 120 ? '…' : ''}`;
    db.prepare("INSERT INTO chat_messages (chat_id, role, content) VALUES (?, 'user', ?)").run(chat.id, display);
    const messages = buildHistory(db, chat);
    messages[messages.length - 1] = { ...messages.at(-1), content: spec.instruction(file, selected) };
    const precreatedRun = createRun({ projectId: project.id, chatId: chat.id, userId: req.user.id, runId: req.agentRequestId });
    return { project, chat, messages, modelConfig, currentFile: file, currentContent: content,
      manuscriptFocus: selectionFocus(content, start, end), precreatedRun };
  });
  await runAgentSSE(req, res, prepared);
}));

// ---------- 审阅基线（滚动 diff 的"上次确认"快照） ----------

router.get('/:id/review/base', asyncHandler(async (req, res) => {
  const { project } = requireProjectAccess(req.user, req.params.id);
  const file = String(req.query.file || '');
  if (!file) throw new HttpError(400, '缺少 file 参数');
  res.json(getReviewSnapshot(project.id, file));
}));

router.post('/:id/review/resolve', asyncHandler(async (req, res) => {
  const { project } = requireProjectAccess(req.user, req.params.id, { write: true });
  res.json(resolveReviewFiles(project.id, req.body || {}));
}));

router.post('/:id/review/hunk', asyncHandler(async (req, res) => {
  const { project } = requireProjectAccess(req.user, req.params.id, { write: true });
  const file = String(req.body?.file || '');
  if (!file) throw new HttpError(400, '缺少 file 参数');
  res.json(resolveReviewHunk(project.id, file, req.body || {}));
}));

router.put('/:id/review/base', asyncHandler(async (req, res) => {
  const { project } = requireProjectAccess(req.user, req.params.id, { write: true });
  const file = String(req.query.file || req.body?.file || '');
  if (!file) throw new HttpError(400, '缺少 file 参数');
  res.json(updateReviewBase(project.id, file, req.body || {}));
}));

router.delete('/:id/review/base', asyncHandler(async (req, res) => {
  const { project } = requireProjectAccess(req.user, req.params.id, { write: true });
  const file = String(req.query.file || '');
  if (!file) throw new HttpError(400, '缺少 file 参数');
  const snapshot = getReviewSnapshot(project.id, file);
  if (snapshot.pending) throw new HttpError(409, '仍有待审AI修改，请逐块保留或撤销后再清理');
  deleteReviewBase(project.id, file);
  res.json({ ok: true });
}));

// ---------- 变更集 ----------

function loadProjectChangeset(db, projectId, cid) {
  const cs = db.prepare('SELECT * FROM changesets WHERE id = ?').get(Number(cid));
  if (!cs || cs.project_id !== projectId) throw new HttpError(404, '变更集不存在');
  return cs;
}

router.get('/:id/changesets', asyncHandler(async (req, res) => {
  const { project } = requireProjectAccess(req.user, req.params.id);
  const status = String(req.query.status || 'pending');
  if (!['pending', 'accepted', 'reverted'].includes(status)) {
    throw new HttpError(400, '非法的 status（pending/accepted/reverted）');
  }
  res.json({ changesets: listChangesets(project.id, status) });
}));

router.get('/:id/changesets/:cid', asyncHandler(async (req, res) => {
  const { project } = requireProjectAccess(req.user, req.params.id);
  const db = getDb();
  loadProjectChangeset(db, project.id, req.params.cid);
  res.json({ changeset: getChangeset(Number(req.params.cid)) });
}));

router.post('/:id/changesets/:cid/accept', asyncHandler(async (req, res) => {
  const { project } = requireProjectAccess(req.user, req.params.id, { write: true });
  const db = getDb();
  loadProjectChangeset(db, project.id, req.params.cid);
  const filePath = req.body?.filePath ? String(req.body.filePath) : undefined;
  res.json({ changeset: acceptChangeset(Number(req.params.cid), filePath, req.body?.expectedRevision) });
}));

router.post('/:id/changesets/:cid/revert', asyncHandler(async (req, res) => {
  const { project } = requireProjectAccess(req.user, req.params.id, { write: true });
  const db = getDb();
  loadProjectChangeset(db, project.id, req.params.cid);
  const filePath = req.body?.filePath ? String(req.body.filePath) : undefined;
  res.json({ changeset: revertChangeset(Number(req.params.cid), filePath, req.body?.expectedRevision) });
}));

router.get('/:id/changesets/:cid/diff', asyncHandler(async (req, res) => {
  const { project } = requireProjectAccess(req.user, req.params.id);
  const db = getDb();
  loadProjectChangeset(db, project.id, req.params.cid);
  const file = String(req.query.file || '');
  if (!file) throw new HttpError(400, '缺少 file 参数');
  res.json(getFileDiff(Number(req.params.cid), file));
}));

// ---------- 设置（/api/settings 前缀） ----------

function maskKey(key) { return key ? (key.length > 4 ? `***${key.slice(-4)}` : '***') : ''; }
function settingsJson(value) { try { return JSON.parse(value || '{}'); } catch { return {}; } }

settingsRouter.get('/ai', asyncHandler(async (req, res) => {
  const s = getDb().prepare('SELECT * FROM settings WHERE user_id = ?').get(req.user.id);
  const { providers, models, activeId } = parseModelSettings(s);
  const active = models.find((m) => m.id === activeId);
  res.json({
    providers: providers.map((p) => ({ ...p, apiKey: maskKey(p.apiKey), hasKey: !!p.apiKey })),
    models: models.map((m) => ({ ...m, apiKey: maskKey(m.apiKey), hasKey: !!m.apiKey, contextModelKey: contextModelKey(m) })),
    activeModelId: activeId,
    provider: active?.provider || 'openai', baseUrl: active?.baseUrl || '', model: active?.model || '',
    apiKey: maskKey(active?.apiKey || ''), hasKey: !!active?.apiKey,
    chineseSupport: !!s?.chinese_support,
    agentConfig: stripRetiredAgentConfig(settingsJson(s?.agent_config)), mcpConfig: settingsJson(s?.mcp_config),
  });
}));

settingsRouter.put('/ai', asyncHandler(async (req, res) => {
  const db = getDb();
  const cur = db.prepare('SELECT * FROM settings WHERE user_id = ?').get(req.user.id);
  const b = req.body || {};
  if (b.provider !== undefined && !['openai', 'anthropic'].includes(b.provider)) throw new HttpError(400, '不支持的 API 格式');
  const previous = parseModelSettings(cur);
  let providers = previous.providers;
  if (b.providers !== undefined) {
    providers = validateProviders(b.providers, previous.providers);
  } else if (b.models !== undefined) {
    // Older clients can still send their flat model list. New clients send providers.
    if (!Array.isArray(b.models) || b.models.length > 500) throw new HttpError(400, 'models 需为数组且最多 500 个');
    const legacy = b.models.map((raw, i) => {
      normalizeReasoningLevels(raw?.reasoningLevels, { strict: true });
      const entry = normalizeModelEntry(raw, i);
      if (entry.apiKey.startsWith('***')) entry.apiKey = previous.models.find((m) => m.id === entry.id)?.apiKey || '';
      return entry;
    }).filter((m) => m.model);
    providers = validateProviders(migrateLegacyModels(legacy), previous.providers);
  } else if (['provider', 'baseUrl', 'apiKey', 'model'].some((k) => b[k] !== undefined)) {
    const active = previous.models.find((m) => m.id === previous.activeId);
    if (!active && b.model) {
      providers = migrateLegacyModels([{
        id: 'legacy', provider: b.provider, baseUrl: b.baseUrl, model: b.model,
        apiKey: String(b.apiKey || '').startsWith('***') ? '' : b.apiKey,
      }]);
    } else if (active) {
      providers = structuredClone(providers);
      const p = providers.find((p) => p.id === active.providerId);
      const m = p.models.find((m) => m.id === active.id);
      if (b.provider !== undefined) p.apiFormat = b.provider;
      if (b.baseUrl !== undefined) p.baseUrl = String(b.baseUrl);
      if (b.apiKey !== undefined && !String(b.apiKey).startsWith('***')) p.apiKey = String(b.apiKey);
      if (b.model !== undefined) m.model = String(b.model);
    }
    providers = validateProviders(providers, previous.providers);
  }
  const providersSql = JSON.stringify({ version: 2, providers });
  const parsed = parseModelSettings({ ai_providers: providersSql, ai_active: b.activeModelId ?? previous.activeId });
  if (b.activeModelId && !parsed.models.some((m) => m.id === String(b.activeModelId) && m.enabled)) {
    throw new HttpError(400, '默认模型不存在或已停用');
  }
  const active = parsed.models.find((m) => m.id === parsed.activeId);
  for (const key of ['agentConfig', 'mcpConfig']) {
    if (b[key] !== undefined && (!b[key] || typeof b[key] !== 'object' || Array.isArray(b[key]))) throw new HttpError(400, `${key} 需为对象`);
  }
  if (b.agentConfig) {
    for (const key of ['graphOrchestration', 'completionSound']) {
      if (b.agentConfig[key] !== undefined && typeof b.agentConfig[key] !== 'boolean') throw new HttpError(400, `${key} 需为布尔值`);
    }
  }
  const nextAgentConfig = { ...settingsJson(cur?.agent_config), ...b.agentConfig };
  if (b.agentConfig?.graphOrchestration !== undefined && b.agentConfig.collaborationTier === undefined && nextAgentConfig.collaborationTier !== undefined)
    nextAgentConfig.collaborationTier = b.agentConfig.graphOrchestration ? nextAgentConfig.collaborationTier === 'off' ? 'full' : nextAgentConfig.collaborationTier : 'off';
  const agentConfig = validateSubagentConfig(nextAgentConfig, parsed);
  db.prepare(`INSERT INTO settings
    (user_id,ai_provider,ai_base_url,ai_api_key,ai_model,chinese_support,agent_config,mcp_config,ai_models,ai_active,ai_providers)
    VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET
    ai_provider=excluded.ai_provider,ai_base_url=excluded.ai_base_url,ai_api_key=excluded.ai_api_key,ai_model=excluded.ai_model,
    chinese_support=excluded.chinese_support,agent_config=excluded.agent_config,mcp_config=excluded.mcp_config,
    ai_models=excluded.ai_models,ai_active=excluded.ai_active,ai_providers=excluded.ai_providers`)
    .run(req.user.id, active?.provider || 'openai', active?.baseUrl || '', active?.apiKey || '', active?.model || '',
      b.chineseSupport === undefined ? (cur?.chinese_support || 0) : Number(!!b.chineseSupport),
      JSON.stringify(agentConfig),
      b.mcpConfig === undefined ? (cur?.mcp_config || '{}') : JSON.stringify(b.mcpConfig),
      JSON.stringify(parsed.models), parsed.activeId, providersSql);
  res.json({ ok: true });
}));

settingsRouter.post('/ai/test', asyncHandler(async (req, res) => {
  const s = getDb().prepare('SELECT * FROM settings WHERE user_id = ?').get(req.user.id) || {};
  const b = req.body || {};
  const parsed = parseModelSettings(s);
  let entry;
  if (b.providerId) {
    const provider = parsed.providers.find((p) => p.id === String(b.providerId));
    if (!provider) throw new HttpError(400, '供应商不存在，请先保存配置');
    entry = parsed.models.find((m) => m.providerId === provider.id && (!b.modelId || m.id === String(b.modelId)));
    if (!entry) throw new HttpError(400, '请先为供应商添加并保存模型');
  } else if (b.modelId) {
    entry = parsed.models.find((m) => m.id === String(b.modelId));
    if (!entry) throw new HttpError(400, '模型不存在，请先保存配置');
  } else if (['provider', 'baseUrl', 'apiKey', 'model'].some((key) => b[key] !== undefined)) {
    const active = parsed.models.find((m) => m.id === parsed.activeId) || {};
    entry = normalizeModelEntry({ ...active, ...b,
      apiKey: String(b.apiKey || '').startsWith('***') ? active.apiKey : (b.apiKey ?? active.apiKey) });
  } else entry = parsed.models.find((m) => m.id === parsed.activeId);
  if (!entry?.model) throw new HttpError(400, '未配置模型');
  const base = (entry.baseUrl || (entry.provider === 'anthropic' ? 'https://api.anthropic.com/v1' : 'https://api.openai.com/v1')).replace(/\/+$/, '');
  const redact = (text) => {
    const value = String(text || '连接失败');
    return (entry.apiKey ? value.split(entry.apiKey).join('[已隐藏]') : value).slice(0, 300);
  };
  const usageEntry = withWorkAdmission(getDb(), () => ({ requestKey: randomUUID(), startedAt: Date.now(), provider: entry.provider,
    providerId: entry.providerId, model: entry.model, owner: 'settings', phase: 'connection_test', status: 'error', usage: null }));
  try {
    const anthropic = entry.provider === 'anthropic';
    const endpoint = anthropic ? `${base.replace(/\/v1$/, '')}/v1/messages` : `${base}/chat/completions`;
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: anthropic ? { 'Content-Type': 'application/json', 'x-api-key': entry.apiKey, 'anthropic-version': '2023-06-01' }
        : { 'Content-Type': 'application/json', Authorization: `Bearer ${entry.apiKey}` },
      body: JSON.stringify({ model: entry.model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
      signal: AbortSignal.timeout(15_000),
    });
    const raw = await r.text();
    let body;
    try { body = JSON.parse(raw); } catch { /* Some gateways omit response usage. */ }
    usageEntry.usage = normalizeProviderUsage(entry.provider, body?.usage);
    if (typeof body?.model === 'string' && (!entry.apiKey || !body.model.includes(entry.apiKey))) usageEntry.responseModel = body.model;
    if (!r.ok) {
      const error = redact(`HTTP ${r.status}: ${raw}`);
      return res.json({ ok: false, error, message: error });
    }
    usageEntry.status = 'stop';
    res.json({ ok: true, message: '连接成功' });
  } catch (err) {
    const error = redact(err.message);
    res.json({ ok: false, error, message: error });
  } finally {
    try { recordAiUsage({ userId: req.user.id, entry: usageEntry }); }
    catch (error) { console.error('[ai-test][accounting]', error?.code || error?.name || 'Error'); }
  }
}));


settingsRouter.get('/skills', asyncHandler(async (req, res) => {
  res.json({ skills: listSkills(req.user.id) });
}));

settingsRouter.post('/skills/import', uploadSkillZip, asyncHandler(async (req, res) => {
  const zipPart = (req.files || []).find((f) => f.fieldname === 'file');
  if (!zipPart) throw new HttpError(400, '请上传 zip 文件（字段 file）');
  const imported = await importSkillZip(req.user.id, zipPart.buffer);
  res.json({ ok: true, imported });
}));

// 从用户电脑选择的目录导入：前端以 webkitdirectory 读取目录内全部文件后上传
settingsRouter.post('/skills/import-files', uploadSkillFiles, asyncHandler(async (req, res) => {
  let paths = [];
  try { paths = JSON.parse(req.body?.paths || '[]'); } catch { paths = []; }
  const files = (req.files || []).filter((f) => f.fieldname === 'files');
  if (!files.length) throw new HttpError(400, '未选择目录或目录为空');
  const entries = files.map((f, i) => ({ relPath: paths[i] ?? f.originalname, buffer: f.buffer }));
  const imported = importSkillFiles(req.user.id, entries);
  res.json({ ok: true, imported });
}));

// 查看技能 SKILL.md 正文
settingsRouter.get('/skills/:name/content', asyncHandler(async (req, res) => {
  res.type('text/plain').send(readSkillContent(req.user.id, req.params.name));
}));

// 保存技能 SKILL.md 正文（编辑）
settingsRouter.put('/skills/:name/content', asyncHandler(async (req, res) => {
  writeSkillContent(req.user.id, req.params.name, String(req.body?.content ?? ''));
  res.json({ ok: true });
}));

// 新建空白技能
settingsRouter.post('/skills/create', asyncHandler(async (req, res) => {
  const name = createSkill(req.user.id, req.body?.name, req.body?.description);
  res.json({ ok: true, name });
}));

// 批量：enable | disable | delete
settingsRouter.post('/skills/batch', asyncHandler(async (req, res) => {
  const names = Array.isArray(req.body?.names) ? req.body.names.map(String) : [];
  if (!names.length) throw new HttpError(400, '请先选择技能');
  const r = batchSkills(req.user.id, names, String(req.body?.action || ''));
  res.json({ ok: true, ...r });
}));;

settingsRouter.delete('/skills/:name', asyncHandler(async (req, res) => {
  deleteSkill(req.user.id, req.params.name);
  res.json({ ok: true });
}));

settingsRouter.post('/mcp/test', asyncHandler(async (req, res) => {
  const tools = await getMcpTools(req.user.id);
  res.json({ ok: true, tools });
}));

export default router;
