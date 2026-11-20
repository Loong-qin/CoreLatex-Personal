import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { startTestServer, api, registerAndLogin } from './helpers.js';

let srv, owner, member, outsider, db, getPiTools, buildToolDisplay, safeToolDebug, persistToolImages, cleanupOrphanArtifacts;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
before(async () => {
  srv = await startTestServer();
  owner = await registerAndLogin(srv.baseUrl, 'display-owner');
  member = await registerAndLogin(srv.baseUrl, 'display-member');
  outsider = await registerAndLogin(srv.baseUrl, 'display-outsider');
  db = (await import('../src/db.js')).getDb();
  ({ getPiTools } = await import('../src/services/agent/tools.js'));
  ({ buildToolDisplay, safeToolDebug } = await import('../src/services/agent/toolDisplay.js'));
  ({ persistToolImages, cleanupOrphanArtifacts } = await import('../src/services/agent/artifacts.js'));
});
after(async () => { await srv.close(); });

async function fixture() {
  const created = await api(srv.baseUrl, 'POST', '/api/projects', { token: owner.token, body: { name: 'Tool display fixture' } });
  const project = db.prepare('SELECT * FROM projects WHERE public_id=?').get(created.data.project.publicId);
  const chatId = Number(db.prepare('INSERT INTO chats(project_id,user_id) VALUES(?,?)').run(project.id, owner.user.id).lastInsertRowid);
  const projectDir = path.join(srv.dataDir, 'projects', String(project.id));
  const workspaceDir = path.join(projectDir, '_workspace'); fs.mkdirSync(workspaceDir, { recursive: true });
  return { db, user: owner.user, project, chatId, projectDir, workspaceDir, changesetBuffer: [], reads: new Map(), agentConfig: { confirmBeforeApply: true } };
}
const run = (ctx, name, args) => getPiTools(ctx).find(t => t.name === name).execute(randomUUID(), args);

test('all built-in tools, progress, question and external tools have semantic presentation types', () => {
  const expected = { list_files: 'files', read_file: 'read', read_workspace: 'files', view_image: 'image', write_file: 'edit', edit_file: 'edit', copy_to_project: 'edit', run_in_workspace: 'command', get_document_context: 'context', read_skill: 'skill', run_skill_script: 'command', compile_and_preview: 'compile', web_search: 'search', web_fetch: 'web', report_progress: 'progress', ask_user: 'question', mcp_example: 'generic' };
  for (const [name, kind] of Object.entries(expected)) {
    const display = buildToolDisplay(name, {}, 'A real result');
    assert.equal(display.kind, kind, name); assert.equal(display.version, 1); assert.ok(display.summary);
    for (const status of ['start', 'error', 'cancelled']) {
      const d = buildToolDisplay(name, {}, 'diagnostic', { status });
      assert.equal(d.kind, kind); assert.doesNotMatch(d.summary, /成功|已读取|已写入|完成/);
    }
  }
});

test('read windows and edits show actual content, line numbers and unambiguous staging outcomes', async () => {
  const ctx = await fixture();
  fs.writeFileSync(path.join(ctx.projectDir, 'main.tex'), 'first\nsecond\nthird');
  const read = await run(ctx, 'read_file', { path: 'main.tex', offset: 2, limit: 1 });
  assert.equal(read.details.display.text, 'second'); assert.equal(read.details.display.startLine, 2);
  assert.ok(read.details.display.fields.some(f => f.label === '总行数' && f.value === '3'));
  assert.equal(read.content[0].text.includes('display'), false);
  const edited = await run(ctx, 'edit_file', { path: 'main.tex', search: 'second', replace: 'revised' });
  assert.equal(edited.details.display.before, 'second'); assert.equal(edited.details.display.after, 'revised');
  assert.equal(edited.details.display.outcome, 'staged');
  assert.equal(fs.readFileSync(path.join(ctx.projectDir, 'main.tex'), 'utf8'), 'first\nsecond\nthird');
  const restored = await run(ctx, 'edit_file', { path: 'main.tex', search: 'revised', replace: 'second' });
  assert.equal(restored.details.display.outcome, 'restored');
  const noop = await run(ctx, 'edit_file', { path: 'main.tex', search: 'second', replace: 'second' });
  assert.equal(noop.details.display.outcome, 'no-change');
  const draft = await run(ctx, 'write_file', { path: '_workspace/draft.tex', content: 'draft' });
  assert.equal(draft.details.display.outcome, 'applied'); assert.equal(draft.details.display.before, ''); assert.equal(draft.details.display.after, 'draft');
});

test('full-file writes locate a change beyond the opening 10000 characters and mark bounded excerpts', () => {
  const prefix = 'unchanged line\n'.repeat(2000);
  const display = buildToolDisplay('write_file', { path: 'main.tex' }, { changed: true, staged: true }, { meta: { edit: { before: prefix + 'old ending', after: prefix + 'new ending', scope: '文件全文' } } });
  assert.match(display.before, /old ending/); assert.match(display.after, /new ending/); assert.equal(display.truncated, true);
  assert.ok(display.fields.some(f => f.label === '截取位置'));
});

test('failed commands reject while retaining their actual output, exit code and cancellation state for UI', async () => {
  const ctx = await fixture(); ctx.agentConfig.confirmBeforeApply = false;
  const command = 'echo useful-output; echo actionable-error >&2; exit 7';
  await assert.rejects(getPiTools(ctx).find(t => t.name === 'run_in_workspace').execute('failed-command', { command }), /退出码 7/);
  const failed = ctx.toolDisplays.get('failed-command');
  assert.equal(failed.summary, '执行失败'); assert.match(failed.text, /useful-output/); assert.match(failed.text, /actionable-error/);
  assert.ok(failed.fields.some(f => f.label === '退出码' && f.value === '7'));
  const timeout = buildToolDisplay('run_in_workspace', { command: 'synthetic timeout' }, { error: '命令执行超时', stdout: 'partial output', timedOut: true, exitCode: 124 }, { status: 'error' });
  assert.match(timeout.notice, /超时/); assert.equal(timeout.text, 'partial output'); assert.ok(timeout.fields.some(f => f.label === '执行状态' && f.value === '已超时'));
  const controller = new AbortController();
  const work = getPiTools(ctx).find(t => t.name === 'run_in_workspace').execute('cancel-command', { command: 'sleep 10' }, controller.signal);
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(work); assert.match(ctx.toolDisplays.get('cancel-command').summary, /已停止/);
});

test('snapshots count against the chat owner quota and a save failure does not fail the model tool result', async () => {
  const ctx = await fixture(); const { storageUsedBytes } = await import('../src/quotas.js');
  const used = storageUsedBytes(ctx.user.id);
  persistToolImages(ctx, [{ mediaType: 'image/png', imageBase64: png.toString('base64') }]);
  assert.equal(storageUsedBytes(ctx.user.id), used + png.length);
  fs.writeFileSync(path.join(ctx.projectDir, 'figure.png'), png);
  ctx.user = { ...ctx.user, role: 'user', storage_quota_bytes: storageUsedBytes(ctx.user.id) };
  const count = db.prepare('SELECT COUNT(*) n FROM agent_artifacts').get().n;
  const result = await run(ctx, 'view_image', { path: 'figure.png' });
  assert.equal(result.content.find(c => c.type === 'image').data, png.toString('base64'));
  assert.equal(result.details.display.images, undefined); assert.match(result.details.display.notice, /存储空间不足/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM agent_artifacts').get().n, count);
});

test('image snapshot preserves exactly the model bytes across source edits and enforces user/chat/project authorization', async () => {
  const ctx = await fixture(); fs.writeFileSync(path.join(ctx.projectDir, 'figure.png'), png);
  const result = await run(ctx, 'view_image', { path: 'figure.png' });
  const image = result.details.display.images[0];
  assert.match(image.url, new RegExp(`/api/projects/${ctx.project.public_id}/agent/artifacts/`));
  assert.equal(JSON.stringify(result.details).includes(png.toString('base64')), false);
  assert.equal(JSON.stringify(result.content.filter(c => c.type === 'text')).includes(image.url), false, 'UI URL must not enter model context');
  const modelBytes = Buffer.from(result.content.find(c => c.type === 'image').data, 'base64');
  fs.writeFileSync(path.join(ctx.projectDir, 'figure.png'), 'later project version');
  let response = await api(srv.baseUrl, 'GET', image.url, { token: owner.token, raw: true });
  assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), modelBytes);
  assert.equal(response.headers.get('cache-control'), 'private, no-store'); assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await api(srv.baseUrl, 'GET', image.url, { raw: true })).status, 401);
  assert.equal((await api(srv.baseUrl, 'GET', image.url, { token: outsider.token, raw: true })).status, 403);
  await api(srv.baseUrl, 'POST', `/api/projects/${ctx.project.public_id}/members`, { token: owner.token, body: { username: 'display-member', role: 'viewer' } });
  assert.equal((await api(srv.baseUrl, 'GET', image.url, { token: member.token, raw: true })).status, 404, 'membership does not grant access to another user chat');
  const other = await fixture();
  assert.equal((await api(srv.baseUrl, 'GET', image.url.replace(ctx.project.public_id, other.project.public_id), { token: owner.token, raw: true })).status, 404);
  assert.equal((await api(srv.baseUrl, 'GET', image.url.replace(image.id, 'not-a-valid-uuid'), { token: owner.token, raw: true })).status, 404);
  const file = path.join(srv.dataDir, 'agent-artifacts', image.id); assert.ok(fs.existsSync(file));
  assert.equal((await api(srv.baseUrl, 'DELETE', `/api/projects/${ctx.project.public_id}/chat`, { token: owner.token })).status, 200);
  assert.equal(fs.existsSync(file), false); assert.equal(db.prepare('SELECT COUNT(*) n FROM agent_artifacts WHERE chat_id=?').get(ctx.chatId).n, 0);
});

test('staged image snapshot uses the same bytes as the agent, and purge removes it', async () => {
  const ctx = await fixture();
  ctx.changesetBuffer.push({ path: 'staged.png', before: null, after: png.toString('base64'), encoding: 'base64' });
  const result = await run(ctx, 'view_image', { path: 'staged.png' });
  assert.match(result.details.display.fields.find(f => f.label === '版本').value, /暂存/);
  const image = result.details.display.images[0]; const file = path.join(srv.dataDir, 'agent-artifacts', image.id);
  assert.deepEqual(fs.readFileSync(file), png); assert.equal(fs.existsSync(path.join(ctx.projectDir, 'staged.png')), false);
  await api(srv.baseUrl, 'POST', `/api/projects/${ctx.project.public_id}/delete`, { token: owner.token });
  assert.equal((await api(srv.baseUrl, 'POST', `/api/projects/${ctx.project.public_id}/purge`, { token: owner.token })).status, 200);
  assert.equal(fs.existsSync(file), false); assert.equal(db.prepare('SELECT COUNT(*) n FROM agent_artifacts WHERE project_id=?').get(ctx.project.id).n, 0);
});

test('orphan cleanup removes missing-chat snapshots and old unregistered files, preserving in-flight files', async () => {
  const ctx = await fixture(); const [image] = persistToolImages(ctx, [{ mediaType: 'image/png', imageBase64: png.toString('base64') }]);
  db.prepare('DELETE FROM chats WHERE id=?').run(ctx.chatId);
  const dir = path.join(srv.dataDir, 'agent-artifacts'), stale = path.join(dir, randomUUID()), recent = path.join(dir, randomUUID());
  fs.writeFileSync(stale, png); fs.writeFileSync(recent, png); fs.utimesSync(stale, new Date(0), new Date(0));
  cleanupOrphanArtifacts(db);
  assert.equal(fs.existsSync(path.join(dir, image.id)), false); assert.equal(fs.existsSync(stale), false); assert.equal(fs.existsSync(recent), true);
});

test('structured compile/search/command metadata stays bounded and debug data excludes secrets and image payloads', () => {
  const display = buildToolDisplay('compile_and_preview', {}, { text: 'model directions' }, { images: [{ id: 'id', url: '/api/projects/p/agent/artifacts/id', label: '第 15 页', page: 15, mimeType: 'image/jpeg' }], meta: { compile: { totalPages: 20, pages: [15], engine: 'xelatex', durationMs: 1331, dpi: 100, previewMode: true, warnings: [{ message: 'Font warning' }], droppedPages: [16] } } });
  assert.ok(display.fields.some(f => f.label === '文档页数' && f.value === '20'));
  assert.ok(display.fields.some(f => f.label === '已读取页面' && f.value === '15'));
  assert.match(display.notice, /16/); assert.equal(display.text, undefined);
  const search = buildToolDisplay('web_search', { query: 'paper' }, '', { meta: { search: { engine: 'local', results: [{ title: 'Paper', url: 'https://example.com/paper', snippet: 'Abstract' }, { title: 'Bad', url: 'javascript:alert(1)' }] } } });
  assert.equal(search.items[0].url, 'https://example.com/paper'); assert.equal(search.items[1].url, undefined);
  const dirty = { apiKey: 'synthetic-key', images: [{ imageBase64: png.toString('base64') }], nested: { type: 'image', data: png.toString('base64') }, message: 'Authorization: Bearer secret-value token=query-secret' };
  const debug = safeToolDebug(dirty); assert.doesNotMatch(debug, /synthetic-key|secret-value|query-secret/); assert.equal(debug.includes(png.toString('base64')), false);
  assert.ok(buildToolDisplay('run_in_workspace', {}, { stdout: 'x'.repeat(100_000), stderr: '', exitCode: 0 }).text.length <= 16_000);
});
