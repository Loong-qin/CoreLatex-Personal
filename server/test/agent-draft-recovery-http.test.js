import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, api, registerAndLogin } from './helpers.js';

let srv, db, owner, member, project, otherProject, ownerChat, memberChat, draftId;
const files = [
  { path: 'main.tex', before: '原始正文\n', after: '完整旧稿\n'.repeat(5000) + 'UNTRUNCATED_TAIL', encoding: 'utf8' },
  { path: 'figure.png', before: null, after: Buffer.from([0, 255, 8, 128]).toString('base64'), encoding: 'base64' },
];
const url = (id = draftId, chat = ownerChat, pid = project.publicId) => `/api/projects/${pid}/agent/drafts/${id}?chatId=${chat}`;
const get = (path, token = owner.token, raw = false) => api(srv.baseUrl, 'GET', path, { token, raw });
const insertDraft = (chatId, userId, state = 'conflicted') => Number(db.prepare(`INSERT INTO agent_drafts
  (project_id,chat_id,user_id,version,published_version,files_json,state) VALUES(?,?,?,3,2,?,?)`)
  .run(project.id, chatId, userId, JSON.stringify(files), state).lastInsertRowid);

before(async () => {
  srv = await startTestServer();
  ({ getDb: db } = await import('../src/db.js')); db = db();
  owner = await registerAndLogin(srv.baseUrl, 'recovery-owner');
  member = await registerAndLogin(srv.baseUrl, 'recovery-member');
  db.prepare("UPDATE users SET status='active' WHERE id=?").run(member.user.id);
  project = (await api(srv.baseUrl, 'POST', '/api/projects', { token: owner.token, body: { name: 'recovery' } })).data.project;
  otherProject = (await api(srv.baseUrl, 'POST', '/api/projects', { token: owner.token, body: { name: 'other' } })).data.project;
  project.id = db.prepare('SELECT id FROM projects WHERE public_id=?').get(project.publicId).id;
  db.prepare("INSERT INTO project_members(project_id,user_id,role) VALUES(?,?,'editor')").run(project.id, member.user.id);
  ownerChat = (await get(`/api/projects/${project.publicId}/chat`)).data.chatId;
  memberChat = (await get(`/api/projects/${project.publicId}/chat`, member.token)).data.chatId;
  draftId = insertDraft(ownerChat, owner.user.id);
});
after(async () => { srv.server.closeAllConnections(); await srv.close(); });

test('authenticated owner downloads complete immutable text and binary checkpoint bytes', async () => {
  const before = db.prepare('SELECT * FROM agent_drafts WHERE id=?').get(draftId);
  const response = await get(url(), owner.token, true);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('content-disposition'), `attachment; filename="corelatex-draft-${draftId}-v3.json"`);
  const body = await response.json();
  assert.deepEqual(body.files, files);
  assert.equal(body.draftId, draftId); assert.equal(body.version, 3); assert.equal(body.publishedVersion, 2);
  assert.equal(body.projectId, project.publicId); assert.equal(body.chatId, ownerChat); assert.equal(body.state, 'conflicted');
  assert.equal(body.format, 'corelatex-agent-draft');
  assert.deepEqual(db.prepare('SELECT * FROM agent_drafts WHERE id=?').get(draftId), before);
});

test('shared project membership cannot read another account or conversation checkpoint', async () => {
  assert.equal((await get(url(), member.token)).status, 404);
  assert.equal((await get(url(draftId, memberChat), member.token)).status, 404);
  assert.equal((await get(url(draftId, memberChat))).status, 404);
  assert.equal((await get(url(draftId, ownerChat, otherProject.publicId))).status, 404);
  assert.equal((await get(url(), '')).status, 401);
});

test('download rejects invalid identities and non-recovery drafts', async () => {
  assert.equal((await get(`/api/projects/${project.publicId}/agent/drafts/${draftId}`)).status, 400);
  assert.equal((await get(url('not-a-number'))).status, 400);
  assert.equal((await get(url(draftId, '1.1'))).status, 400);
  for (const state of ['active', 'closed']) {
    const id = insertDraft(ownerChat, owner.user.id, state);
    assert.equal((await get(url(id))).status, 404);
  }
});

test('current conversation and current project permission are rechecked for every download', async () => {
  const ownDraft = insertDraft(memberChat, member.user.id);
  assert.equal((await get(url(ownDraft, memberChat), member.token)).status, 200);
  db.prepare('DELETE FROM project_members WHERE project_id=? AND user_id=?').run(project.id, member.user.id);
  assert.equal((await get(url(ownDraft, memberChat), member.token)).status, 403);
  const freshChat = Number(db.prepare('INSERT INTO chats(project_id,user_id) VALUES(?,?)').run(project.id, owner.user.id).lastInsertRowid);
  assert.equal((await get(url())).status, 404);
  assert.equal((await get(url(draftId, freshChat))).status, 404);
  assert.equal(db.prepare('SELECT files_json FROM agent_drafts WHERE id=?').get(draftId).files_json, JSON.stringify(files));
});
