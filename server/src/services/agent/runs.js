import { randomUUID } from 'node:crypto';
import { deleteChatArtifacts } from './artifacts.js';
import { getDb } from '../../db.js';
import { HttpError } from '../../util.js';
import { assertWorkAdmission, withWorkAdmission, afterWorkAdmissionCommit } from '../maintenance.js';

const ACTIVE = new Set(['running', 'waiting_for_user', 'cancelling']);
const liveRuns = new Map();
const clearingChats = new Set();

function shape(row) {
  if (!row) return null;
  return {
    id: row.id, runId: row.id, state: row.state, lastSeq: row.last_seq,
    messageId: row.message_id || null, error: row.error || null,
    question: row.question ? JSON.parse(row.question) : null,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export function getRun(runId) {
  return getDb().prepare('SELECT * FROM agent_runs WHERE id = ?').get(String(runId));
}
export function runSnapshot(runId) { return shape(getRun(runId)); }
export function activeRunForChat(chatId) {
  return getDb().prepare("SELECT * FROM agent_runs WHERE chat_id = ? AND state IN ('running','waiting_for_user','cancelling') ORDER BY created_at DESC LIMIT 1").get(chatId);
}
export function assertChatIdle(chatId) {
  assertWorkAdmission(getDb());
  if (clearingChats.has(chatId)) throw new HttpError(409, '会话正在清空，请稍后重试');
  if (activeRunForChat(chatId)) throw new HttpError(409, '本会话已有运行中的任务，请追加指令或先停止当前任务');
}

function publish(run, event) {
  const db = getDb();
  const value = db.transaction(() => {
    const row = db.prepare('SELECT last_seq FROM agent_runs WHERE id = ?').get(run.id);
    if (!row) return null;
    const value = { ...event, runId: run.id, seq: row.last_seq + 1 };
    db.prepare("UPDATE agent_runs SET last_seq = ?, updated_at = datetime('now') WHERE id = ?").run(value.seq, run.id);
    db.prepare('INSERT INTO agent_run_events(run_id, seq, event) VALUES(?,?,?)').run(run.id, value.seq, JSON.stringify(value));
    return value;
  })();
  if (value) for (const listener of [...run.listeners]) {
    try { listener(value); } catch { run.listeners.delete(listener); }
  }
  return value;
}

function setState(run, state, extra = {}) {
  getDb().prepare("UPDATE agent_runs SET state = ?, updated_at = datetime('now') WHERE id = ?").run(state, run.id);
  return publish(run, { type: 'run', state, ...extra });
}

export function createRun({ projectId, chatId, userId, runId }) {
  const id = runId || randomUUID();
  const db = getDb();
  try {
    withWorkAdmission(db, () => {
      assertChatIdle(chatId);
      db.prepare("INSERT INTO agent_runs(id,project_id,chat_id,user_id,state,last_seq) VALUES(?,?,?,?,'running',1)").run(id, projectId, chatId, userId);
      db.prepare('INSERT INTO agent_run_events(run_id,seq,event) VALUES(?,1,?)').run(id, JSON.stringify({ type: 'run', state: 'running', runId: id, seq: 1 }));
    });
  } catch (err) {
    if (err.code?.startsWith('SQLITE_CONSTRAINT')) throw new HttpError(409, '本会话已有运行中的任务');
    throw err;
  }
  let finish;
  const run = { id, chatId, userId, projectId, controller: new AbortController(), listeners: new Set(), question: null,
    finished: new Promise((resolve) => { finish = resolve; }), finish, done: null, acceptingInputs: true };
  afterWorkAdmissionCommit(db, () => liveRuns.set(id, run));
  run.emit = (event) => {
    if (event.type === 'done') {
      run.done = event;
      if (event.messageId) getDb().prepare('UPDATE agent_runs SET message_id = ? WHERE id = ?').run(event.messageId, id);
      return;
    }
    publish(run, event);
  };
  run.control = {
    id,
    setMessageId(messageId) {
      const value = Number(messageId);
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Invalid assistant message ID');
      getDb().prepare('UPDATE agent_runs SET message_id = ? WHERE id = ?').run(value, id);
      publish(run, { type: 'run', state: getRun(id).state, messageId: value });
    },
    sealInputs() {
      const count = getDb().prepare('SELECT COUNT(*) AS n FROM agent_run_inputs WHERE run_id = ? AND consumed = 0').get(id).n;
      if (count) return false;
      run.acceptingInputs = false;
      return true;
    },
    async takeInputs() {
      if (run.controller.signal.aborted) return [];
      const rows = getDb().transaction(() => {
        const rows = getDb().prepare('SELECT id, content, timestamp FROM agent_run_inputs WHERE run_id = ? AND consumed = 0 ORDER BY id').all(id);
        if (rows.length) getDb().prepare('UPDATE agent_run_inputs SET consumed = 1 WHERE run_id = ? AND consumed = 0').run(id);
        return rows;
      })();
      if (rows.length) publish(run, { type: 'input_consumed', inputIds: rows.map((r) => r.id) });
      return rows.map((r) => ({ role: 'user', content: r.content, timestamp: r.timestamp }));
    },
    async askUser({ question, options }) {
      if (run.controller.signal.aborted) throw run.controller.signal.reason;
      if (run.question) throw new HttpError(409, '当前已有问题等待回答');
      const text = String(question || '').trim();
      if (!text) throw new HttpError(400, '问题不能为空');
      const prompt = { questionId: randomUUID(), question: text.slice(0, 8000) };
      if (Array.isArray(options) && options.length) prompt.options = options.slice(0, 10).map((o) => String(o).slice(0, 500));
      return new Promise((resolve, reject) => {
        const abort = () => {
          run.question = null;
          getDb().prepare("UPDATE agent_runs SET question = '' WHERE id = ?").run(id);
          reject(run.controller.signal.reason || new Error('执行已停止'));
        };
        run.question = { ...prompt, resolve, reject, abort };
        run.controller.signal.addEventListener('abort', abort, { once: true });
        getDb().prepare('UPDATE agent_runs SET question = ? WHERE id = ?').run(JSON.stringify(prompt), id);
        setState(run, 'waiting_for_user', { question: prompt });
        publish(run, { type: 'question', ...prompt });
      });
    },
  };
  return run;
}

// The task belongs to the run, not any one HTTP response. A disconnected observer
// is free to reconnect; only an explicit cancellation aborts the task.
export function startRun(run, task) {
  void (async () => {
    let failure = null;
    let outcome = null;
    try {
      const result = await task(run);
      outcome = result?.status;
      if (outcome === 'failed') {
        failure = '智能体执行未完成，请查看本轮记录';
        getDb().prepare('UPDATE agent_runs SET error = ? WHERE id = ?').run(failure, run.id);
      }
      if (result?.messageId) getDb().prepare('UPDATE agent_runs SET message_id = ? WHERE id = ?').run(result.messageId, run.id);
    } catch (err) {
      if (!run.controller.signal.aborted) {
        failure = err.message || '智能体运行失败';
        getDb().prepare('UPDATE agent_runs SET error = ? WHERE id = ?').run(failure, run.id);
        publish(run, { type: 'error', message: failure });
      }
    } finally {
      const state = run.controller.signal.aborted || outcome === 'cancelled' ? 'cancelled' : failure ? 'failed' : 'completed';
      if (run.question) {
        run.controller.signal.removeEventListener('abort', run.question.abort);
        run.question.reject(new Error('本轮已经结束'));
        run.question = null;
      }
      getDb().prepare("UPDATE agent_runs SET question = '' WHERE id = ?").run(run.id);
      setState(run, state);
      const snapshot = runSnapshot(run.id);
      publish(run, { ...run.done, type: 'done', messageId: snapshot?.messageId, state });
      liveRuns.delete(run.id);
      run.finish(snapshot);
    }
  })();
  return run.finished;
}

export function observeRun(runId, after, listener) {
  const row = getRun(runId);
  if (!row) throw new HttpError(404, '运行不存在');
  for (const event of getDb().prepare('SELECT event FROM agent_run_events WHERE run_id = ? AND seq > ? ORDER BY seq').all(runId, after)) {
    listener(JSON.parse(event.event));
  }
  const live = liveRuns.get(runId);
  if (live && ACTIVE.has(row.state)) {
    live.listeners.add(listener);
    return () => live.listeners.delete(listener);
  }
  return () => {};
}

export async function cancelRun(runId, { reason = '用户已停止执行' } = {}) {
  const row = getRun(runId);
  if (!row) throw new HttpError(404, '运行不存在');
  const live = liveRuns.get(runId);
  if (!live || !ACTIVE.has(row.state)) return shape(row);
  if (!live.controller.signal.aborted) {
    setState(live, 'cancelling');
    live.controller.abort(new DOMException(reason, 'AbortError'));
  }
  await live.finished;
  return runSnapshot(runId);
}

// Call after revoking write access, so no new affected run can start while the
// existing tasks stop. Await finalization before reporting the change complete.
export async function cancelProjectRuns(projectId, { userId } = {}) {
  const rows = getDb().prepare("SELECT id,user_id FROM agent_runs WHERE project_id = ? AND state IN ('running','waiting_for_user','cancelling')").all(projectId);
  await Promise.all(rows.filter((row) => userId === undefined || row.user_id === userId)
    .map((row) => cancelRun(row.id, { reason: '项目状态或编辑权限已变化，已停止执行' })));
}

export function queueRunInput(runId, message) {
  const row = getRun(runId);
  const run = liveRuns.get(runId);
  if (!row || !run || !run.acceptingInputs || !['running', 'waiting_for_user'].includes(row.state)) throw new HttpError(409, '本轮已结束或正在停止，请开始新一轮');
  const content = String(message || '').trim();
  if (!content || content.length > 100000) throw new HttpError(400, '追加指令不能为空且不得超过 100000 字符');
  const pending = getDb().prepare('SELECT COUNT(*) AS n FROM agent_run_inputs WHERE run_id = ? AND consumed = 0').get(runId).n;
  if (pending >= 20) throw new HttpError(429, '待处理指令过多，请等待智能体处理');
  getDb().transaction(() => {
    const inputId = Number(getDb().prepare('INSERT INTO agent_run_inputs(run_id,content,timestamp) VALUES(?,?,?)').run(runId, content, Date.now()).lastInsertRowid);
    const chatMessageId = Number(getDb().prepare("INSERT INTO chat_messages(chat_id,role,content) VALUES(?,'user',?)").run(row.chat_id, content).lastInsertRowid);
    publish(run, { type: 'input', message: content, inputText: content, queued: true, inputId, chatMessageId,
      inputKind: 'steering', parentMessageId: row.message_id || null, consumed: false });
  })();
  return runSnapshot(runId);
}

export function lastQueuedRunInput(runId) {
  const item = getDb().prepare("SELECT event FROM agent_run_events WHERE run_id=? AND json_extract(event,'$.type')='input' ORDER BY seq DESC LIMIT 1").get(runId);
  return item ? JSON.parse(item.event) : null;
}

export function acceptedRunAnswer(runId, questionId) {
  const item = getDb().prepare(`SELECT event FROM agent_run_events WHERE run_id=?
    AND json_extract(event,'$.type')='answer' AND json_extract(event,'$.questionId')=? ORDER BY seq LIMIT 1`).get(runId, questionId);
  if (!item) return null;
  const event = JSON.parse(item.event);
  const run = getRun(runId);
  const prompt = getDb().prepare("SELECT event FROM agent_run_events WHERE run_id=? AND json_extract(event,'$.type')='question' AND json_extract(event,'$.questionId')=? ORDER BY seq LIMIT 1").get(runId, questionId);
  return { ...event, runId, inputKind: 'answer', parentMessageId: run?.message_id || null, consumed: true,
    inputText: event.answer, question: event.question || (prompt ? JSON.parse(prompt.event).question : '') };
}

export function answerRunQuestion(runId, questionId, answer) {
  const run = liveRuns.get(runId);
  const row = getRun(runId);
  const content = String(answer ?? '').trim();
  if (!content || content.length > 20000) throw new HttpError(400, '回答不能为空且不得超过 20000 字符');
  // A lost HTTP acknowledgement may be retried after the same run has finished.
  // Re-acknowledge exactly the accepted answer; never resolve twice or start work.
  const accepted = row && acceptedRunAnswer(runId, questionId);
  if (accepted) {
    if (accepted.answer !== content) throw new HttpError(409, '该问题已收到不同回答，不能重复提交');
    return runSnapshot(runId);
  }
  if (!run || row?.state !== 'waiting_for_user' || !run.question || run.question.questionId !== questionId) throw new HttpError(409, '该问题已回答、已取消或不属于当前运行');
  const question = run.question;
  getDb().transaction(() => {
    const chatMessageId = Number(getDb().prepare("INSERT INTO chat_messages(chat_id,role,content) VALUES(?,'user',?)").run(row.chat_id, `[回答] ${question.question}\n${content}`).lastInsertRowid);
    getDb().prepare("UPDATE agent_runs SET question = '' WHERE id = ?").run(runId);
    publish(run, { type: 'answer', questionId, question: question.question, answer: content, inputText: content,
      chatMessageId, inputKind: 'answer', parentMessageId: row.message_id || null, consumed: true });
    setState(run, 'running');
  })();
  run.controller.signal.removeEventListener('abort', question.abort);
  run.question = null;
  question.resolve(content);
  return runSnapshot(runId);
}

export async function clearChatAfterCancellation(chatId) {
  if (clearingChats.has(chatId)) throw new HttpError(409, '会话正在清空');
  clearingChats.add(chatId);
  try {
    const active = activeRunForChat(chatId);
    if (active) await cancelRun(active.id);
    deleteChatArtifacts(chatId);
    getDb().transaction(() => {
      getDb().prepare('DELETE FROM agent_runs WHERE chat_id = ?').run(chatId);
      getDb().prepare('DELETE FROM chat_messages WHERE chat_id = ?').run(chatId);
      getDb().prepare("UPDATE chats SET summary = '', summary_msg_id = 0, context_model_key = '', context_usage = '' WHERE id = ?").run(chatId);
    })();
  } finally { clearingChats.delete(chatId); }
}
