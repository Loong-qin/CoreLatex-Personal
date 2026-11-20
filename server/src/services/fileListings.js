import fs from 'node:fs';
import path from 'node:path';
import { HttpError, isReservedName, isTextFile, safeJoin, toPosix } from '../util.js';

const STAT_BATCH = 24;
const WORKSPACE = '_workspace';
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 200;

function visibleEntry(entry) {
  return !entry.name.startsWith('.') && !isReservedName(entry.name) && (entry.isDirectory() || entry.isFile());
}
function compareNodes(a, b) {
  const typeOrder = (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1);
  return typeOrder || a.name.localeCompare(b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

// Stat only a bounded batch at a time. The readdir/stat promises let the
// server continue serving the main editor while a large tree is enumerated.
async function populateFileSizes(dir, nodes, signal) {
  const files = nodes.filter(node => node.type === 'file');
  for (let i = 0; i < files.length; i += STAT_BATCH) {
    signal?.throwIfAborted();
    await Promise.all(files.slice(i, i + STAT_BATCH).map(async node => {
      try { node.size = (await fs.promises.stat(path.join(dir, node.name))).size; }
      catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') node.removed = true;
        else node.size = 0; // Same metadata fallback as the legacy tree.
      }
    }));
  }
  signal?.throwIfAborted();
  return nodes.filter(node => !node.removed);
}

/** Formal project tree without opening or statting the workspace. The legacy
 * recursive buildTree() remains unchanged for other callers and older clients. */
export async function buildProjectTreeWithoutWorkspace(root, { signal } = {}) {
  const result = [];
  const stack = [{ abs: root, rel: '', nodes: result }];
  while (stack.length) {
    signal?.throwIfAborted();
    const { abs, rel, nodes } = stack.pop();
    let entries;
    try { entries = await fs.promises.readdir(abs, { withFileTypes: true }); }
    catch (error) {
      // A directory may be deleted while another user is changing the tree.
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue;
      throw error;
    }
    signal?.throwIfAborted();
    const pending = [];
    for (const entry of entries) {
      if (!visibleEntry(entry) || (!rel && entry.name === WORKSPACE)) continue;
      const relative = rel ? toPosix(path.join(rel, entry.name)) : entry.name;
      if (entry.isDirectory()) pending.push({ name: entry.name, path: relative, type: 'dir', children: [] });
      else pending.push({ name: entry.name, path: relative, type: 'file', size: 0, text: isTextFile(entry.name) });
    }
    const present = await populateFileSizes(abs, pending, signal);
    present.sort(compareNodes);
    for (const node of present) nodes.push(node);
    for (let i = present.length - 1; i >= 0; i--) {
      const node = present[i];
      if (node.type === 'dir') stack.push({ abs: path.join(abs, node.name), rel: node.path, nodes: node.children });
    }
  }
  return result;
}

function workspacePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0'))
    throw new HttpError(400, '工作区路径无效');
  const segments = value.split('/');
  if (segments[0] !== WORKSPACE || segments.some(segment => !segment || segment === '.' || segment === '..' || segment.startsWith('.')))
    throw new HttpError(400, '只能查看工作区内的目录');
  return segments.join('/');
}

async function checkedWorkspaceDir(root, relative, signal) {
  // Never follow symlinks while walking a user-selected path: they could point
  // outside the project or into a reserved directory.
  let current = root;
  for (const segment of relative.split('/')) {
    signal?.throwIfAborted();
    current = path.join(current, segment);
    let stat;
    try { stat = await fs.promises.lstat(current); }
    catch (error) {
      if ((error.code === 'ENOENT' || error.code === 'ENOTDIR') && relative === WORKSPACE) return null;
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw new HttpError(404, '目录不存在');
      throw error;
    }
    if (stat.isSymbolicLink()) throw new HttpError(403, '不允许查看符号链接目录');
    if (!stat.isDirectory()) throw new HttpError(404, '目录不存在');
  }
  return current;
}

function readPageSize(value) {
  if (value === undefined || value === '') return DEFAULT_PAGE_SIZE;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new HttpError(400, '分页大小无效');
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) throw new HttpError(400, '分页大小无效');
  return limit;
}
function readCursor(value, relative) {
  if (value === undefined || value === '') return null;
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,8192}$/.test(value)) throw new HttpError(400, '分页游标无效');
  let cursor;
  try { cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); }
  catch { throw new HttpError(400, '分页游标无效'); }
  if (!cursor || cursor.path !== relative || !['dir', 'file'].includes(cursor.type) ||
      typeof cursor.name !== 'string' || !cursor.name || cursor.name.includes('/') || cursor.name.startsWith('.'))
    throw new HttpError(400, '分页游标无效');
  return cursor;
}
function makeCursor(relative, node) {
  return Buffer.from(JSON.stringify({ path: relative, type: node.type, name: node.name })).toString('base64url');
}

/** List one workspace directory only. A cursor carries the last sorted entry,
 * so adding/removing entries before it cannot shift the next page by offset. */
export async function listWorkspaceChildren(root, { path: requestedPath = WORKSPACE, limit: requestedLimit, cursor: requestedCursor, signal } = {}) {
  signal?.throwIfAborted();
  const relative = workspacePath(requestedPath);
  safeJoin(root, relative);
  const limit = readPageSize(requestedLimit);
  const cursor = readCursor(requestedCursor, relative);
  const abs = await checkedWorkspaceDir(root, relative, signal);
  if (!abs) return { path: relative, entries: [], nextCursor: null };
  // Stream names and retain only the smallest limit+1 entries after the
  // cursor. Even a huge directory does not allocate or synchronously sort all
  // of its entries, and the asynchronous iterator yields while scanning it.
  const candidates = [];
  try {
    const directory = await fs.promises.opendir(abs, { bufferSize: 64 });
    for await (const entry of directory) {
      signal?.throwIfAborted();
      if (!visibleEntry(entry)) continue;
      const node = { name: entry.name, path: `${relative}/${entry.name}`, type: entry.isDirectory() ? 'dir' : 'file',
        ...(entry.isFile() ? { size: 0, text: isTextFile(entry.name) } : {}) };
      if (cursor && compareNodes(node, cursor) <= 0) continue;
      let left = 0, right = candidates.length;
      while (left < right) {
        const middle = (left + right) >> 1;
        if (compareNodes(candidates[middle], node) <= 0) left = middle + 1;
        else right = middle;
      }
      if (left > limit) continue;
      candidates.splice(left, 0, node);
      if (candidates.length > limit + 1) candidates.pop();
    }
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw new HttpError(404, '目录不存在');
    throw error;
  }
  const page = candidates.slice(0, limit);
  const entries = await populateFileSizes(abs, page, signal);
  const nextCursor = candidates.length > limit ? makeCursor(relative, page[page.length - 1]) : null;
  return { path: relative, entries, nextCursor };
}
