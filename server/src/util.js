import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** 项目对外唯一哈希(12 位 url-safe,72bit):替代自增数字编号的对外暴露,防枚举 */
export function newPublicId() {
  return randomBytes(9).toString('base64url');
}

export const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

// A background read is cancelled when its client leaves, never on the normal
// completion of the GET request itself (req can close before res is finished).
export async function sendCancellableJson(res, getResult) {
  const controller = new AbortController();
  const onClose = () => { if (!res.writableFinished) controller.abort(); };
  res.once('close', onClose);
  try {
    if (res.destroyed) return;
    const result = await getResult(controller.signal);
    if (!controller.signal.aborted && !res.destroyed) res.json(result);
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally { res.off('close', onClose); }
}

/** 点开头保留目录名（不可通过 API 访问） */
const RESERVED = new Set(['.build', '.versions', '.git', '.preview']);
const TEXT_EXTS = new Set([
  '.tex', '.bib', '.sty', '.cls', '.txt', '.md', '.bibtex', '.bst', '.cfg',
  '.def', '.clo', '.json', '.xml', '.csv', '.tsv', '.py', '.m', '.r',
  '.sh', '.c', '.cpp', '.h', '.hpp', '.java', '.js', '.ts', '.html', '.css',
  '.log', '.aux', '.bbl', '.blg', '.toc', '.out', '.gls', '.ist', '.latexmkrc',
]);

export function isReservedName(name) {
  return RESERVED.has(name);
}

/**
 * 将用户给出的相对路径安全地解析到 root 之下。
 * 拒绝：绝对路径、.. 穿越、NUL、保留目录作为首段。
 * 返回绝对路径。
 */
export function safeJoin(root, rel) {
  if (typeof rel !== 'string' || rel.length === 0) throw new HttpError(400, '路径不能为空');
  if (rel.includes('\0')) throw new HttpError(400, '非法路径');
  const norm = path.normalize(rel).replace(/^[/\\]+/, '');
  if (norm.startsWith('..') || path.isAbsolute(rel)) throw new HttpError(400, '非法路径');
  const abs = path.join(root, norm);
  const resolved = path.resolve(abs);
  if (resolved !== path.resolve(root) && !resolved.startsWith(path.resolve(root) + path.sep)) {
    throw new HttpError(400, '非法路径');
  }
  const firstSeg = norm.split(path.sep)[0];
  if (isReservedName(firstSeg)) throw new HttpError(403, `路径 ${firstSeg} 为系统保留`);
  return resolved;
}

export function toPosix(p) {
  return p.split(path.sep).join('/');
}

export function isTextFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (TEXT_EXTS.has(ext)) return true;
  const base = path.basename(filePath);
  return !base.includes('.'); // Makefile 等无扩展名文件按文本处理
}

export function dirSizeBytes(dir) {
  let total = 0;
  if (!fs.existsSync(dir)) return 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) {
        if (isReservedName(e.name)) continue; // 不计构建与快照
        stack.push(p);
      } else if (e.isFile()) {
        try { total += fs.statSync(p).size; } catch {}
      }
    }
  }
  return total;
}

/** 递归生成项目文件树（排除保留目录） */
export function buildTree(dir, rel = '') {
  const abs = path.join(dir, rel);
  let entries = [];
  try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return []; }
  const nodes = [];
  for (const e of entries) {
    if (e.name.startsWith('.') || isReservedName(e.name)) continue;
    const nodeRel = rel ? toPosix(path.join(rel, e.name)) : e.name;
    if (e.isDirectory()) {
      nodes.push({ name: e.name, path: nodeRel, type: 'dir', children: buildTree(dir, nodeRel) });
    } else if (e.isFile()) {
      let size = 0;
      try { size = fs.statSync(path.join(abs, e.name)).size; } catch {}
      nodes.push({ name: e.name, path: nodeRel, type: 'file', size, text: isTextFile(e.name) });
    }
  }
  nodes.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  return nodes;
}

export function projectStorageBytes(dir) {
  return dirSizeBytes(dir);
}

/** Read-only storage totals without blocking the main event loop. Unlike write
 * quota enforcement, these totals may yield between batches and are cancellable. */
export async function projectStorageBytesAsync(root, { signal } = {}) {
  let total = 0;
  const stack = [root];
  while (stack.length) {
    signal?.throwIfAborted();
    const current = stack.pop();
    let batch = [];
    const flush = async () => {
      if (!batch.length) return;
      const pending = batch; batch = [];
      const sizes = await Promise.all(pending);
      signal?.throwIfAborted();
      for (const size of sizes) total += size;
    };
    try {
      const directory = await fs.promises.opendir(current, { bufferSize: 64 });
      for await (const entry of directory) {
        signal?.throwIfAborted();
        const file = path.join(current, entry.name);
        if (entry.isDirectory()) {
          if (!isReservedName(entry.name)) stack.push(file);
        } else if (entry.isFile()) {
          // Match dirSizeBytes: unreadable/disappearing entries contribute 0.
          batch.push(fs.promises.stat(file).then(stat => stat.size, () => 0));
          if (batch.length >= 24) await flush();
        }
      }
    } catch (error) { if (signal?.aborted) throw error; }
    await flush();
  }
  signal?.throwIfAborted();
  return total;
}
