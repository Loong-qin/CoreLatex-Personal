import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'corelatex-tool-images-'));
process.env.CORELATEX_DATA_DIR = temp;
let db, resetDb, executeTool, getPiTools, makePiTool, getArtifactForUser;
let serial = 0;
before(async () => {
  const database = await import('../src/db.js');
  db = database.getDb(); resetDb = database.resetDb;
  ({ executeTool, getPiTools, makePiTool } = await import('../src/services/agent/tools.js'));
  ({ getArtifactForUser } = await import('../src/services/agent/artifacts.js'));
});
after(() => { resetDb(); fs.rmSync(temp, { recursive: true, force: true }); });

function fixture() {
  const userId = Number(db.prepare("INSERT INTO users(username,password_hash,role) VALUES (?,'unused','admin')").run('images-' + (++serial)).lastInsertRowid);
  const projectId = Number(db.prepare('INSERT INTO projects(name,owner_id,public_id) VALUES (?,?,?)').run('images',userId,'images-' + serial).lastInsertRowid);
  const projectDir = path.join(temp, 'projects', String(projectId));
  const workspaceDir = path.join(projectDir, '_workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });
  return { user: db.prepare('SELECT * FROM users WHERE id=?').get(userId),
    project: db.prepare('SELECT * FROM projects WHERE id=?').get(projectId),
    projectDir, workspaceDir, changesetBuffer: [], reads: new Map(), agentConfig: { confirmBeforeApply: true } };
}
const oldImage = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const newImage = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z/D/PwAH/QL+heR3AAAAAElFTkSuQmCC', 'base64');
const hasPoppler = spawnSync('pdftoppm', ['-v']).status === 0;

function figurePdf(pageSizes) {
  const pages = pageSizes.map(([width, height], index) =>
    (index + 3) + ' 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + width + ' ' + height + '] >> endobj\n');
  const kids = pages.map((_page, index) => (index + 3) + ' 0 R').join(' ');
  return Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n' +
    '2 0 obj << /Type /Pages /Kids [' + kids + '] /Count ' + pages.length + ' >> endobj\n' +
    pages.join('') + 'trailer << /Root 1 0 R >>\n%%EOF\n');
}

function pngDimensions(bytes) {
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

test('view_image uses a staged replacement while keeping the original disk bytes', async () => {
  const ctx = fixture();
  fs.writeFileSync(path.join(ctx.projectDir, 'figure.png'), oldImage);
  fs.writeFileSync(path.join(ctx.workspaceDir, 'next.png'), newImage);
  assert.equal((await executeTool('copy_to_project', { workspacePath: 'next.png', targetPath: 'figure.png' }, ctx)).error, undefined);
  const result = await executeTool('view_image', { path: 'figure.png' }, ctx);
  assert.equal(result.error, undefined);
  assert.deepEqual(Buffer.from(result.images[0].imageBase64, 'base64'), newImage);
  assert.deepEqual(fs.readFileSync(path.join(ctx.projectDir, 'figure.png')), oldImage);
});

test('view_image can inspect a newly staged image before its project path exists', async () => {
  const ctx = fixture();
  fs.writeFileSync(path.join(ctx.workspaceDir, 'next.png'), newImage);
  await executeTool('copy_to_project', { workspacePath: 'next.png', targetPath: 'new.png' }, ctx);
  const result = await executeTool('view_image', { path: 'new.png' }, ctx);
  assert.equal(result.error, undefined);
  assert.deepEqual(Buffer.from(result.images[0].imageBase64, 'base64'), newImage);
  assert.equal(fs.existsSync(path.join(ctx.projectDir, 'new.png')), false);
});

test('ordinary view_image emits one native image and no duplicate base64 text', async () => {
  const ctx = fixture();
  fs.writeFileSync(path.join(ctx.projectDir, 'figure.png'), oldImage);
  const result = await getPiTools(ctx).find(t => t.name === 'view_image').execute('view', { path: 'figure.png' });
  const images = result.content.filter(c => c.type === 'image');
  assert.equal(images.length, 1);
  assert.equal(images[0].data, oldImage.toString('base64'));
  const textOnly = result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
  assert.match(textOnly, /figure\.png/);
  assert.equal(textOnly.includes(oldImage.toString('base64')), false);
  assert.equal(result.details.text.includes(oldImage.toString('base64')), false);
});

test('staged image sizes are checked against the same 5 MiB limit', async () => {
  const ctx = fixture();
  ctx.changesetBuffer.push({ path: 'large.png', before: null, after: Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64'), encoding: 'base64' });
  const result = await executeTool('view_image', { path: 'large.png' }, ctx);
  assert.match(result.error, /5MB/);
});

test('view_image renders the chosen page of a workspace or staged PDF and stores the rendered result', { skip: !hasPoppler }, async () => {
  const ctx = fixture();
  ctx.chatId = Number(db.prepare('INSERT INTO chats (project_id, user_id) VALUES (?, ?)').run(ctx.project.id, ctx.user.id).lastInsertRowid);
  const projectFigure = path.join(ctx.projectDir, 'figure.pdf');
  const workspaceFigure = path.join(ctx.workspaceDir, 'iteration.pdf');
  const original = figurePdf([[300, 150]]);
  const iteration = figurePdf([[100, 200], [200, 100]]);
  fs.writeFileSync(projectFigure, original);
  fs.writeFileSync(workspaceFigure, iteration);

  const workspace = await executeTool('view_image', { path: '_workspace/iteration.pdf' }, ctx);
  assert.equal(workspace.error, undefined);
  assert.equal(workspace.images[0].page, 1);
  assert.deepEqual(pngDimensions(Buffer.from(workspace.images[0].imageBase64, 'base64')), [600, 1200]);

  const copy = await executeTool('copy_to_project', { workspacePath: 'iteration.pdf', targetPath: 'figure.pdf' }, ctx);
  assert.equal(copy.error, undefined);
  const result = await getPiTools(ctx).find(tool => tool.name === 'view_image').execute('pdf-preview', { path: 'figure.pdf', page: 2 });
  const image = result.content.find(item => item.type === 'image');
  assert.equal(image.mimeType, 'image/png');
  assert.deepEqual(pngDimensions(Buffer.from(image.data, 'base64')), [1200, 600]);
  assert.match(result.content[0].text, /figure\.pdf.+第 2 页.+暂存/);
  assert.ok(!result.content[0].text.includes(image.data));
  const [snapshot] = result.details.display.images;
  assert.equal(snapshot.page, 2);
  const artifact = getArtifactForUser(snapshot.id, ctx.project.id, ctx.user.id, db);
  assert.deepEqual(fs.readFileSync(artifact.file), Buffer.from(image.data, 'base64'));
  assert.deepEqual(fs.readFileSync(projectFigure), original);
  assert.deepEqual(fs.readFileSync(workspaceFigure), iteration);

  const unavailablePage = await executeTool('view_image', { path: 'figure.pdf', page: 3 }, ctx);
  assert.match(unavailablePage.error, /第 3 页/);
  assert.equal(unavailablePage.images, undefined);
});

test('view_image rejects invalid page values and oversized PDF files before rendering', async () => {
  const ctx = fixture();
  const projectFigure = path.join(ctx.projectDir, 'figure.pdf');
  fs.writeFileSync(projectFigure, figurePdf([[100, 200]]));
  for (const page of [0, -1, 1.5, '1', 2147483648]) {
    const result = await executeTool('view_image', { path: 'figure.pdf', page }, ctx);
    assert.match(result.error, /页码必须为正整数/);
  }
  fs.truncateSync(projectFigure, 20 * 1024 * 1024 + 1);
  const oversized = await executeTool('view_image', { path: 'figure.pdf' }, ctx);
  assert.match(oversized.error, /20MB/);
});

for (const count of [1, 3]) test(`compile preview adapter retains ${count} native page images without serializing their data into text`, async () => {
  const images = Array.from({ length: count }, (_, i) => ({ mediaType: 'image/jpeg', imageBase64: Buffer.from('unique-page-image-' + i).toString('base64'), page: i + 1 }));
  const output = { text: 'Compiled preview', images, pages: images.map(i => i.page) };
  const before = structuredClone(output);
  const tool = makePiTool({ name: 'compile_and_preview', parameters: { type: 'object' }, run: async () => output }, {});
  const result = await tool.execute('preview', {});
  assert.equal(result.content.filter(c => c.type === 'image').length, count);
  const textOnly = result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
  assert.match(textOnly, /Compiled preview/);
  assert.deepEqual(JSON.parse(textOnly).pages, images.map(i => i.page));
  for (const image of images) {
    assert.ok(result.content.some(c => c.type === 'image' && c.data === image.imageBase64 && c.mimeType === image.mediaType));
    assert.equal(textOnly.includes(image.imageBase64), false);
    assert.equal(result.details.text.includes(image.imageBase64), false);
  }
  assert.deepEqual(output, before, 'adapting output must not mutate the tool result');
});
