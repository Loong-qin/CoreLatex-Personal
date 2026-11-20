import fs from 'node:fs';
import path from 'node:path';
process.env.CORELATEX_DATA_DIR = process.argv[2];
const { getDb, resetDb } = await import('../../src/db.js');
const db = getDb();
if (process.argv[3] === 'recover') {
  const { openAgentDraft } = await import('../../src/services/agent/draftPersistence.js');
  const { getChangeset } = await import('../../src/services/agent/changesets.js');
  const user = db.prepare('SELECT * FROM users LIMIT 1').get(), project = db.prepare('SELECT * FROM projects LIMIT 1').get(), chat = db.prepare('SELECT * FROM chats LIMIT 1').get();
  const ctx = { db, user, project, chatId: chat.id, projectDir: path.join(process.argv[2], 'projects', String(project.id)), changesetBuffer: [] };
  const beforeChangesets = db.prepare('SELECT COUNT(*) n FROM changesets').get().n, draft = openAgentDraft(ctx), published = draft.publish();
  console.log(JSON.stringify({ state: db.prepare('SELECT state FROM agent_runs').get().state, content: ctx.changesetBuffer[0].after,
    disk: fs.readFileSync(path.join(ctx.projectDir, 'notes.txt'), 'utf8'), beforeChangesets, resumed: draft.resumed,
    published: published.changed, applied: getChangeset(published.id).applied }));
  resetDb();
} else {
  const { runAgent } = await import('../../src/services/agent/agentLoop.js');
  const { createRun, startRun } = await import('../../src/services/agent/runs.js');
  const uid = Number(db.prepare("INSERT INTO users(username,password_hash,role) VALUES('crash','unused','admin')").run().lastInsertRowid);
  db.prepare('INSERT INTO settings(user_id,agent_config) VALUES(?,?)').run(uid, JSON.stringify({ confirmBeforeApply: true }));
  const pid = Number(db.prepare("INSERT INTO projects(name,owner_id,public_id) VALUES('crash',?,'crash')").run(uid).lastInsertRowid);
  const cid = Number(db.prepare('INSERT INTO chats(project_id,user_id) VALUES(?,?)').run(pid, uid).lastInsertRowid);
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(uid), project = db.prepare('SELECT * FROM projects WHERE id=?').get(pid), chat = db.prepare('SELECT * FROM chats WHERE id=?').get(cid);
  const dir = path.join(process.argv[2], 'projects', String(pid)); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'notes.txt'), 'original');
  const run = createRun({ projectId: pid, chatId: cid, userId: uid });
  await startRun(run, () => runAgent({ user, project, chat, messages: [{ role: 'user', content: '重写 notes.txt 然后继续检查，留待审核。' }],
    modelConfig: { provider: 'openai', model: 'crash-fixture', apiKey: 'synthetic', baseUrl: process.argv[3], maxTokens: 64000, contextLength: 256000 },
    emit: run.emit, signal: run.controller.signal, runControl: run.control }));
}
