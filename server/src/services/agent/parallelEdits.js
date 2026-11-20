import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { diffLines } from 'diff';
import { flushProjectRooms } from '../../collab.js';
import { isReservedName, isTextFile } from '../../util.js';

const clone = value => structuredClone(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const sessions = new WeakSet();
function fail(code, message) {
  const error = new Error(message);
  error.code = 'parallel_edit_' + code;
  throw error;
}
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function editPath(value) {
  if (typeof value !== 'string' || !value || value !== value.trim() || /[\\:\x00-\x1f\x7f]/.test(value) ||
    value.split('/').some(part => !part || part === '.' || part === '..') ||
    value.split('/')[0] === '_workspace' || isReservedName(value.split('/')[0])) {
    fail('scope', '并行编辑必须使用明确、安全的项目相对文件路径，不能写工作区或系统目录。');
  }
  return value;
}

/** Scope line numbers are inclusive, one-based coordinates in the frozen draft. */
export function parseParallelEditTasks(tasks) {
  if (!Array.isArray(tasks) || !tasks.length) fail('scope', '并行编辑需要明确的任务和文件边界。');
  const ids = new Set();
  return tasks.map(task => {
    if (!task || typeof task.id !== 'string' || !task.id.trim() || task.id !== task.id.trim() || ids.has(task.id)) {
      fail('scope', '并行编辑任务必须有唯一、非空的 id。');
    }
    ids.add(task.id);
    if (typeof task.task !== 'string' || !task.task.trim() || !Array.isArray(task.scope) || !task.scope.length) {
      fail('scope', '每个编辑任务必须说明任务内容和允许修改的文件范围。');
    }
    const paths = new Set();
    const scope = task.scope.map(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item) ||
        Object.keys(item).some(key => !['path', 'startLine', 'endLine'].includes(key))) fail('scope', '编辑范围格式无效。');
      const file = editPath(item.path);
      if (paths.has(file)) fail('scope', '同一编辑任务中每个文件只能声明一个范围；多个不连续范围请拆分任务。');
      paths.add(file);
      const ranged = own(item, 'startLine') || own(item, 'endLine');
      if (ranged && (!Number.isSafeInteger(item.startLine) || !Number.isSafeInteger(item.endLine) ||
        item.startLine < 1 || item.endLine < item.startLine)) fail('scope', '行范围必须同时包含有效的 startLine 和 endLine。');
      return ranged ? { path: file, startLine: item.startLine, endLine: item.endLine } : { path: file };
    });
    return { ...clone(task), role: 'editor', scope };
  });
}

// Read-only path inspection. Reject every symlink component, including links
// within the project, so an editor cannot change the meaning of its boundary.
function diskSnapshot(root, file) {
  const parts = file.split('/');
  let absolute = root;
  for (let index = 0; index < parts.length; index++) {
    absolute = path.join(absolute, parts[index]);
    let stat;
    try { stat = fs.lstatSync(absolute); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (stat.isSymbolicLink()) fail('path', '并行编辑范围不能经过符号链接：' + file);
    if (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile()) fail('path', '编辑范围必须指向普通文件：' + file);
  }
  if (!isTextFile(absolute)) fail('encoding', '并行编辑只支持项目文本文件：' + file);
  const bytes = fs.readFileSync(absolute);
  const content = bytes.toString('utf8');
  if (content.includes('\0') || !Buffer.from(content, 'utf8').equals(bytes)) fail('encoding', '并行编辑需要有效的 UTF-8 文本：' + file);
  return content;
}
function rootFor(ctx) {
  if (!ctx || typeof ctx.projectDir !== 'string') fail('context', '缺少项目草稿上下文。');
  const root = fs.realpathSync(ctx.projectDir);
  if (!fs.statSync(root).isDirectory()) fail('context', '项目目录不可用。');
  return root;
}
function bufferFor(ctx) {
  if (!Array.isArray(ctx.changesetBuffer)) fail('context', '缺少父智能体草稿缓冲区。');
  const paths = new Set();
  for (const item of ctx.changesetBuffer) {
    if (!item || typeof item.path !== 'string' || paths.has(item.path)) fail('context', '父草稿包含无效或重复的文件。');
    paths.add(item.path);
  }
  return ctx.changesetBuffer;
}
function lineRange(content, scope) {
  if (!own(scope, 'startLine')) return { start: 0, end: content?.length || 0, full: true };
  if (content === null) fail('scope', '新文件只能使用完整文件范围：' + scope.path);
  const starts = [0];
  for (let index = 0; index < content.length; index++) if (content[index] === '\n') starts.push(index + 1);
  if (scope.endLine > starts.length) fail('scope', '行范围超出冻结草稿：' + scope.path);
  return { start: starts[scope.startLine - 1], end: starts[scope.endLine] ?? content.length,
    full: false, ownsEof: scope.endLine === starts.length };
}
function taskFor(session, taskId) {
  assertParallelEditSession(session);
  const task = session?.tasks?.find(item => item.id === taskId);
  if (!task) fail('scope', '未找到已冻结的编辑任务。');
  return task;
}
/** Only coordinator-created sessions can grant editor permissions. */
export function assertParallelEditSession(session, ctx) {
  if (!sessions.has(session)) fail('context', '并行编辑需要由主智能体创建的真实冻结会话。');
  if (ctx && (rootFor(ctx) !== session.root || ctx.project?.id !== session.projectId)) {
    fail('context', '编辑会话与当前项目不匹配。');
  }
  return true;
}
function fileFor(session, file) {
  const entry = session.files.find(item => item.path === file);
  if (!entry) fail('scope', '文件不属于本次冻结编辑范围：' + file);
  return entry;
}

/** Synchronize accepted collaborative edits, then freeze disk and parent draft.
 * No editor changes are written to disk by this module. */
export function createParallelEditSession({ tasks, ctx, revision }) {
  const parsed = parseParallelEditTasks(tasks);
  if (ctx?.project?.id != null) flushProjectRooms(ctx.project.id, { strict: true });
  const root = rootFor(ctx), parentBuffer = clone(bufferFor(ctx));
  const files = [...new Set(parsed.flatMap(task => task.scope.map(item => item.path)))].map(file => {
    const disk = diskSnapshot(root, file);
    if (!isTextFile(file)) fail('encoding', '并行编辑只支持项目文本文件：' + file);
    const staged = parentBuffer.find(item => item.path === file);
    if (staged && disk !== staged.before) fail('conflict', '正式文件已偏离草稿基线，请先核对用户修改再分派：' + file);
    if (staged && ((staged.encoding || 'utf8') !== 'utf8' || typeof staged.after !== 'string')) fail('encoding', '冻结草稿不是可编辑文本：' + file);
    const draft = staged ? staged.after : disk;
    if (draft !== null && draft.includes('\0')) fail('encoding', '冻结草稿不是可编辑文本：' + file);
    return { path: file, disk, draft };
  });
  const ranges = [];
  for (const task of parsed) for (const scope of task.scope) {
    const file = files.find(item => item.path === scope.path);
    const range = { taskId: task.id, path: scope.path, ...lineRange(file.draft, scope) };
    for (const prior of ranges.filter(item => item.path === scope.path)) {
      // Inclusive line ownership also rejects two zero-width EOF scopes.
      const previousScope = parsed.find(item => item.id === prior.taskId).scope.find(item => item.path === scope.path);
      if (range.full || prior.full || (scope.startLine <= previousScope.endLine && previousScope.startLine <= scope.endLine)) {
        fail('overlap', '并行任务的文件或行范围重叠：' + scope.path);
      }
    }
    ranges.push(range);
  }
  const readOverlay = new Map();
  for (const entry of parentBuffer) if (typeof entry.after === 'string') {
    readOverlay.set(entry.path, { path: entry.path, before: entry.after, after: entry.after, encoding: entry.encoding || 'utf8' });
  }
  for (const file of files) if (file.draft !== null) {
    readOverlay.set(file.path, { path: file.path, before: file.draft, after: file.draft, encoding: 'utf8' });
  }
  const session = freeze({ tasks: parsed, revision: clone(revision), projectId: ctx.project?.id,
    root, parentBuffer, parentFingerprint: hash(parentBuffer), files, ranges, readOverlay: [...readOverlay.values()] });
  sessions.add(session);
  return session;
}

/** Each worker gets private before===after sentinels for existing scope files.
 * This keeps ordinary read_file/edit_file on the frozen draft, not live disk. */
export function createEditorDraft(session, taskId) {
  taskFor(session, taskId);
  return clone(session.readOverlay);
}

/** stageChange removes a proposal reverted to its base. Restore that sentinel
 * after every tool so subsequent reads cannot fall through to changed disk. */
export function restoreEditorDraft({ session, taskId, changesetBuffer }) {
  if (!Array.isArray(changesetBuffer)) fail('proposal', '子智能体草稿缓冲区无效。');
  for (const entry of createEditorDraft(session, taskId)) {
    if (!changesetBuffer.some(item => item.path === entry.path)) changesetBuffer.push(entry);
  }
  return changesetBuffer;
}

function textChanges(before, after) {
  let offset = 0, pending = null;
  const changes = [];
  for (const part of diffLines(before, after)) {
    if (!part.added && !part.removed) {
      if (pending) { changes.push(pending); pending = null; }
      offset += part.value.length;
    } else {
      pending ||= { start: offset, end: offset, text: '' };
      if (part.removed) { offset += part.value.length; pending.end = offset; }
      else pending.text += part.value;
    }
  }
  if (pending) changes.push(pending);
  return changes;
}
function allowedChange(change, range, length) {
  if (range.full) return true;
  if (change.start !== change.end) return change.start >= range.start && change.end <= range.end;
  // A boundary insertion belongs to the range on its right. EOF belongs to
  // the last range, but only when its final line is explicitly in scope.
  return change.start >= range.start && (change.start < range.end || (change.start === length && range.ownsEof));
}
function validatedChanges({ session, taskId, changesetBuffer }) {
  const task = taskFor(session, taskId);
  if (!Array.isArray(changesetBuffer)) fail('proposal', '子智能体未返回有效草稿。');
  const paths = new Set(), output = [];
  for (const entry of changesetBuffer) {
    const filePath = editPath(entry?.path);
    if (paths.has(filePath)) fail('scope', '子智能体修改了范围外或重复文件：' + filePath);
    paths.add(filePath);
    if (!task.scope.some(item => item.path === filePath)) {
      const readonly = session.readOverlay.find(item => item.path === filePath);
      if (readonly && entry.before === readonly.before && entry.after === readonly.after &&
        (entry.encoding || 'utf8') === readonly.encoding) continue;
      fail('scope', '子智能体修改了范围外或重复文件：' + filePath);
    }
    const file = fileFor(session, filePath);
    if ((entry.encoding || 'utf8') !== 'utf8' || typeof entry.after !== 'string' || entry.after.includes('\0') ||
      Buffer.from(entry.after, 'utf8').toString('utf8') !== entry.after || entry.before !== file.draft) {
      fail('proposal', '子智能体草稿基线、编码或内容无效：' + filePath);
    }
    if (entry.after === file.draft) continue;
    const range = session.ranges.find(item => item.taskId === taskId && item.path === filePath);
    const edits = file.draft === null ? [{ start: 0, end: 0, text: entry.after }] : textChanges(file.draft, entry.after);
    if (edits.some(edit => !allowedChange(edit, range, file.draft?.length || 0))) fail('scope', '子智能体改动超出冻结行范围：' + filePath);
    output.push({ path: filePath, before: file.draft, after: entry.after, encoding: 'utf8', edits });
  }
  return output;
}

export function validateEditorChanges(options) {
  return validatedChanges(options).map(({ edits, ...entry }) => entry);
}

/** Run before the ordinary file tool, so an out-of-scope write is never even
 * staged. Validation uses the complete cumulative delta from the frozen base. */
export function validateEditorTool({ session, taskId, toolName, input, changesetBuffer }) {
  const task = taskFor(session, taskId);
  if (toolName === 'read_file') {
    const scoped = task.scope.some(item => item.path === input?.path);
    if (scoped) {
      diskSnapshot(session.root, input.path); // reject a newly introduced symlink
      if (fileFor(session, input.path).draft === null && !changesetBuffer.some(item => item.path === input.path)) {
        fail('proposal', '冻结草稿中该文件尚不存在，请先用 write_file 暂存新文件。');
      }
    }
    return true; // other read-only paths retain the normal tool's access rules
  }
  if (!['edit_file', 'write_file'].includes(toolName)) fail('tool', '并行编辑器只能通过受范围约束的文件工具修改草稿。');
  const filePath = editPath(input?.path);
  if (!task.scope.some(item => item.path === filePath)) fail('scope', '编辑目标超出分派范围：' + filePath);
  diskSnapshot(session.root, filePath);
  validatedChanges({ session, taskId, changesetBuffer });
  const file = fileFor(session, filePath);
  const current = changesetBuffer.find(item => item.path === filePath)?.after ?? file.draft;
  let after;
  if (toolName === 'write_file') after = String(input.content ?? '');
  else {
    const search = String(input.search ?? '');
    if (current === null || !search || current.split(search).length !== 2) fail('proposal', 'edit_file 的 search 必须唯一匹配当前私有草稿。');
    after = current.replace(search, String(input.replace ?? ''));
  }
  const candidate = changesetBuffer.filter(item => item.path !== filePath);
  candidate.push({ path: filePath, before: file.draft, after, encoding: 'utf8' });
  validatedChanges({ session, taskId, changesetBuffer: candidate });
  return true;
}

/** Validate every result and every parent snapshot before returning one new
 * buffer. Caller must install it synchronously, without awaiting after return.
 * This function never mutates the parent, worker buffers, or project files. */
export function mergeParallelEdits({ session, results, ctx, revision }) {
  assertParallelEditSession(session, ctx);
  if (ctx?.project?.id != null) flushProjectRooms(ctx.project.id, { strict: true });
  if (!Object.is(revision, session.revision) || rootFor(ctx) !== session.root || ctx.project?.id !== session.projectId ||
    hash(bufferFor(ctx)) !== session.parentFingerprint) fail('stale', '父草稿或项目版本已变化，并行修改尚未合并。');
  for (const file of session.files) if (diskSnapshot(session.root, file.path) !== file.disk) fail('stale', '用户文件已变化，并行修改尚未合并：' + file.path);
  if (!Array.isArray(results) || results.length !== session.tasks.length) fail('proposal', '并行编辑结果不完整，未合并任何修改。');
  const ids = new Set(), grouped = new Map();
  for (const result of results) {
    taskFor(session, result?.id);
    if (ids.has(result.id)) fail('proposal', '并行编辑返回了重复任务。');
    ids.add(result.id);
    for (const entry of validatedChanges({ session, taskId: result.id, changesetBuffer: result.proposedChanges })) {
      const list = grouped.get(entry.path) || [];
      for (const edit of entry.edits) list.push({ ...edit, taskId: result.id });
      grouped.set(entry.path, list);
    }
  }
  const merged = clone(session.parentBuffer);
  for (const [filePath, edits] of grouped) {
    edits.sort((a, b) => a.start - b.start || a.end - b.end);
    for (let index = 1; index < edits.length; index++) {
      const previous = edits[index - 1], current = edits[index];
      if (current.start < previous.end || (current.start === previous.start && (current.start === current.end || previous.start === previous.end))) {
        fail('overlap', '子智能体改动存在重叠，未合并任何修改：' + filePath);
      }
    }
    const file = fileFor(session, filePath);
    let after = file.draft ?? '';
    for (const edit of edits.reverse()) after = after.slice(0, edit.start) + edit.text + after.slice(edit.end);
    const index = merged.findIndex(item => item.path === filePath);
    const before = index < 0 ? file.disk : merged[index].before;
    if (before === after) { if (index >= 0) merged.splice(index, 1); }
    else {
      const entry = { path: filePath, before, after, encoding: 'utf8' };
      if (index >= 0) merged[index] = entry;
      else merged.push(entry);
    }
  }
  return merged;
}
