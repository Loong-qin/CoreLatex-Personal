// A run creates its assistant row before accepting answers/steering. Message IDs
// are insertion order, not conversation order. The durable event journal is the
// authority for input ownership (including records written by older versions).
export function readChatRunHistory(db, chatId, { since = 0 } = {}) {
  const rows = db.prepare('SELECT * FROM chat_messages WHERE chat_id = ? AND id > ? ORDER BY id').all(chatId, since);
  const byId = new Map(rows.map(row => [row.id, row]));
  const runs = db.prepare('SELECT id, state, message_id FROM agent_runs WHERE chat_id = ? ORDER BY created_at, id').all(chatId);
  const byRun = new Map(runs.map(run => [run.id, run]));
  for (const run of runs) {
    const assistant = byId.get(run.message_id);
    if (assistant?.role === 'assistant') Object.assign(assistant, { runId: run.id, runState: run.state });
  }
  const consumed = new Set(db.prepare('SELECT i.id FROM agent_run_inputs i JOIN agent_runs r ON r.id=i.run_id WHERE r.chat_id=? AND i.consumed=1').all(chatId).map(row => row.id));
  const events = db.prepare(`SELECT e.run_id, e.event FROM agent_run_events e
    JOIN agent_runs r ON r.id=e.run_id WHERE r.chat_id=?
    AND CASE WHEN json_valid(e.event) THEN json_extract(e.event,'$.type') END IN ('question','answer','input','input_consumed')
    ORDER BY r.created_at,r.id,e.seq`).all(chatId);
  const questions = new Map();
  const inputs = [];
  for (const item of events) {
    let event;
    try { event = JSON.parse(item.event); } catch { continue; }
    if (event.type === 'question') questions.set(`${item.run_id}:${event.questionId}`, event.question);
    if (event.type === 'input_consumed') for (const id of event.inputIds || []) consumed.add(id);
    if (event.type === 'answer' || event.type === 'input') inputs.push({ run: byRun.get(item.run_id), event });
  }
  const preceding = new Map();
  for (const { run, event } of inputs) {
    const row = byId.get(event.chatMessageId);
    if (!run || row?.role !== 'user') continue;
    const answer = event.type === 'answer';
    const isConsumed = answer || consumed.has(event.inputId);
    Object.assign(row, {
      runId: run.id, runState: run.state, parentMessageId: run.message_id || null,
      inputKind: answer ? 'answer' : 'steering', consumed: isConsumed,
      inputText: String((answer ? event.answer : event.message) ?? ''),
      ...(answer ? { questionId: event.questionId, question: event.question || questions.get(`${run.id}:${event.questionId}`) || '' } : { inputId: event.inputId }),
    });
    // Unconsumed steering is intentionally left after the assistant, so the UI
    // and a future model request cannot mistake it for work already handled.
    if (isConsumed && byId.get(run.message_id)?.role === 'assistant') {
      if (!preceding.has(run.message_id)) preceding.set(run.message_id, new Set());
      preceding.get(run.message_id).add(row.id);
    }
  }
  const moved = new Set([...preceding.values()].flatMap(ids => [...ids]));
  return rows.flatMap(row => moved.has(row.id) ? [] : [
    ...[...(preceding.get(row.id) || [])].sort((a,b) => a-b).map(id => byId.get(id)), row,
  ]);
}

export function messageRunMetadata(row) {
  const keys = ['runId','runState','parentMessageId','inputKind','consumed','inputText','questionId','question','inputId'];
  return Object.fromEntries(keys.filter(key => row[key] !== undefined).map(key => [key,row[key]]));
}

// Model replay keeps the report and an annotation, while tool payloads stay in the timeline.
export function replayedMessageContent({ role, content, toolCount }) {
  if (role !== 'assistant') return content;
  const text = String(content ?? '');
  return Number(toolCount) > 0
    ? text + `\n\n[系统标注：本条回复撰写时实际执行过 ${toolCount} 次工具调用（读取/编辑等），调用与结果未随历史回放。]`
    : text;
}

export const ROUND_NOTE =
  '【系统便签】历史文件快照仅供定位。使用文件作为依据前核对当前原文，edit_file 的 search 取自当前读取结果。' +
  '区分现稿已有内容和本轮行动，读取、修改及编译的完成声明须有本轮实际证据。';
