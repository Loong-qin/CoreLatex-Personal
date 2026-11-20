import fs from 'node:fs';
import path from 'node:path';
import archiver from 'archiver';
import * as unzipper from 'unzipper';
import { diffLines, createTwoFilesPatch } from 'diff';
import { getDb } from '../db.js';
import { projectDir } from '../config.js';
import { requireProjectAccess } from '../access.js';
import { HttpError, isTextFile } from '../util.js';
import { flushProjectRooms, reloadProjectRooms } from '../collab.js';

/** Capture visible file buffers and directory names, excluding dot entries and generated state. */
function readWorkingTree(dir) {
  const out = new Map();
  const directories = new Set();
  const walk = (abs, rel) => {
    const entries = fs.readdirSync(abs, { withFileTypes: true });
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const eAbs = path.join(abs, e.name);
      const eRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        directories.add(eRel);
        walk(eAbs, eRel);
      } else if (e.isFile()) {
        out.set(eRel, fs.readFileSync(eAbs));
      }
    }
  };
  walk(dir, '');
  return { files: out, directories };
}

/** 从 zip 快照读全部文件到内存 Map<posixPath, Buffer>（跳过非法路径） */
async function readZipFiles(zipPath) {
  const zip = await unzipper.Open.file(zipPath);
  const out = new Map();
  for (const f of zip.files) {
    if (f.type !== 'File') continue;
    const norm = path.normalize(f.path).replace(/^[/\\]+/, '').split(path.sep).join('/');
    if (!norm || norm === '.' || norm.startsWith('..')) continue;
    out.set(norm, await f.buffer());
  }
  return out;
}

/** Archive the captured buffers, never reread the live working directory. */
function writeZip(tree, dest) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(dest);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);
    for (const directory of tree.directories) {
      archive.append(Buffer.alloc(0), { name: directory + '/', type: 'directory' });
    }
    for (const [name, contents] of tree.files) archive.append(contents, { name });
    archive.finalize().catch(reject);
  });
}

function countLines(text) {
  if (!text) return 0;
  const n = text.split('\n').length;
  return text.endsWith('\n') ? n - 1 : n;
}

/** 对比新旧两个文件 Map，产出逐文件行级统计与全项目汇总 */
function diffMaps(oldMap, newMap) {
  const files = [];
  let adds = 0;
  let dels = 0;
  const paths = [...new Set([...oldMap.keys(), ...newMap.keys()])].sort();
  for (const p of paths) {
    const o = oldMap.get(p);
    const n = newMap.get(p);
    if (o !== undefined && n !== undefined && o.equals(n)) continue;
    const change = o === undefined ? 'added' : n === undefined ? 'removed' : 'modified';
    if (!isTextFile(p)) {
      files.push({ path: p, adds: 0, dels: 0, binary: true, change });
      continue;
    }
    const oldText = o ? o.toString('utf8') : '';
    const newText = n ? n.toString('utf8') : '';
    let a = 0;
    let d = 0;
    if (change === 'added') {
      a = countLines(newText);
    } else if (change === 'removed') {
      d = countLines(oldText);
    } else {
      for (const part of diffLines(oldText, newText)) {
        if (part.added) a += part.count;
        else if (part.removed) d += part.count;
      }
      if (a === 0 && d === 0) continue; // 无实质行变更
    }
    adds += a;
    dels += d;
    files.push({ path: p, adds: a, dels: d, change });
  }
  return { files, adds, dels };
}

/** Overleaf 风格的自动变更描述 */
function autoMessage(files) {
  if (!files.length) return '无变更';
  if (files.length === 1) {
    const f = files[0];
    const verb = f.change === 'added' ? '已添加' : f.change === 'removed' ? '已移除' : '已更改';
    return `${verb} ${f.path}`;
  }
  const count = { modified: 0, added: 0, removed: 0 };
  for (const f of files) count[f.change] += 1;
  const parts = [];
  if (count.modified) parts.push(`已更改 ${count.modified} 个文件`);
  if (count.added) parts.push(`已添加 ${count.added} 个文件`);
  if (count.removed) parts.push(`已移除 ${count.removed} 个文件`);
  return parts.join('，');
}

function serializeVersion(row) {
  let files = [];
  try { files = JSON.parse(row.files || '[]'); } catch {}
  return {
    id: row.id,
    seq: row.seq || row.id,
    message: row.message,
    adds: row.adds,
    dels: row.dels,
    files,
    createdAt: row.created_at,
    userName: row.dname || row.uname || '',
  };
}

const VERSION_SELECT = `
  SELECT v.*, u.username AS uname, u.display_name AS dname
  FROM versions v LEFT JOIN users u ON u.id = v.user_id`;

/**
 * 创建项目快照：与上一版本对比行级 diff 统计，项目目录打 zip 存 .versions/v<id>.zip。
 * 版本号 seq 按项目独立编号（界面展示 v<seq>），与全局自增 id 解耦。
 * skipIfUnchanged=true 且与上一版本无差异时返回 null（不落库、不打 zip）。
 */
const versionQueues = new Map();

function queueVersionOperation(projectId, operation) {
  const previous = versionQueues.get(projectId) || Promise.resolve();
  const next = previous.catch(() => {}).then(operation);
  versionQueues.set(projectId, next);
  const done = () => { if (versionQueues.get(projectId) === next) versionQueues.delete(projectId); };
  next.then(done, done);
  return next;
}

export function createSnapshot(options) {
  return queueVersionOperation(options.project.id, () => {
    flushProjectRooms(options.project.id);
    return createSnapshotFromTree(options, readWorkingTree(projectDir(options.project.id)));
  });
}

async function createSnapshotFromTree({ project, user, message, skipIfUnchanged = false }, current) {
  const db = getDb();
  const dir = projectDir(project.id);
  const last = db
    .prepare('SELECT * FROM versions WHERE project_id = ? ORDER BY id DESC LIMIT 1')
    .get(project.id);
  let previous = new Map();
  if (last && last.snapshot_path && fs.existsSync(last.snapshot_path)) {
    try { previous = await readZipFiles(last.snapshot_path); } catch { previous = new Map(); }
  }
  const { files, adds, dels } = diffMaps(previous, current.files);
  if (skipIfUnchanged && files.length === 0) return null;
  const msg = String(message || '').trim() || autoMessage(files);
  const seq = (db
    .prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM versions WHERE project_id = ?')
    .get(project.id).m || 0) + 1;
  const info = db
    .prepare("INSERT INTO versions (project_id, user_id, message, adds, dels, files, seq, snapshot_path) VALUES (?,?,?,?,?,?,?,'')")
    .run(project.id, user ? user.id : null, msg, adds, dels, JSON.stringify(files), seq);
  const id = info.lastInsertRowid;
  fs.mkdirSync(path.join(dir, '.versions'), { recursive: true });
  const zipPath = path.join(dir, '.versions', `v${id}.zip`);
  try {
    await writeZip(current, zipPath);
  } catch (err) {
    db.prepare('DELETE FROM versions WHERE id = ?').run(id);
    fs.rmSync(zipPath, { force: true });
    throw new HttpError(500, `快照写入失败: ${err.message}`);
  }
  db.prepare('UPDATE versions SET snapshot_path = ? WHERE id = ?').run(zipPath, id);
  return serializeVersion(getDb().prepare(`${VERSION_SELECT} WHERE v.id = ?`).get(id));
}

export function listVersions(projectId) {
  const rows = getDb()
    .prepare(`${VERSION_SELECT} WHERE v.project_id = ? ORDER BY v.id DESC`)
    .all(projectId);
  return rows.map(serializeVersion);
}

function getVersionChecked(projectId, versionId) {
  const row = getDb()
    .prepare(`${VERSION_SELECT} WHERE v.id = ? AND v.project_id = ?`)
    .get(Number(versionId), projectId);
  if (!row) throw new HttpError(404, '版本不存在');
  return row;
}

/** 某版本相对其前一版本的 unified diff 明细 */
export async function getVersionDiff(projectId, versionId) {
  const db = getDb();
  const version = getVersionChecked(projectId, versionId);
  if (!version.snapshot_path || !fs.existsSync(version.snapshot_path)) {
    throw new HttpError(404, '快照文件已丢失');
  }
  const prev = db
    .prepare('SELECT * FROM versions WHERE project_id = ? AND id < ? ORDER BY id DESC LIMIT 1')
    .get(projectId, version.id);
  const newMap = await readZipFiles(version.snapshot_path);
  let oldMap = new Map();
  if (prev && prev.snapshot_path && fs.existsSync(prev.snapshot_path)) {
    try { oldMap = await readZipFiles(prev.snapshot_path); } catch { oldMap = new Map(); }
  }
  const diffs = [];
  const paths = [...new Set([...oldMap.keys(), ...newMap.keys()])].sort();
  for (const p of paths) {
    const o = oldMap.get(p);
    const n = newMap.get(p);
    if (o !== undefined && n !== undefined && o.equals(n)) continue;
    if (!isTextFile(p)) {
      diffs.push({ path: p, binary: true });
      continue;
    }
    const oldText = o ? o.toString('utf8') : '';
    const newText = n ? n.toString('utf8') : '';
    diffs.push({ path: p, patch: createTwoFilesPatch(`a/${p}`, `b/${p}`, oldText, newText) });
  }
  return { version: serializeVersion(version), diffs };
}

function sameWorkingTree(left, right) {
  if (left.files.size !== right.files.size || left.directories.size !== right.directories.size) return false;
  for (const [name, contents] of left.files) {
    if (!right.files.has(name) || !contents.equals(right.files.get(name))) return false;
  }
  for (const name of left.directories) if (!right.directories.has(name)) return false;
  return true;
}

// Decode every entry before touching the working directory; corrupt content or
// paths must not leave a half-restored project or overwrite snapshot metadata.
async function readRestoreTree(zipPath) {
  const zip = await unzipper.Open.file(zipPath);
  const files = new Map();
  const directories = new Set();
  for (const entry of zip.files) {
    const raw = String(entry.path).replaceAll(String.fromCharCode(92), '/');
    const name = path.posix.normalize(raw).replace(/[/]$/, '');
    if (!name || name === '.' || raw.includes(String.fromCharCode(0)) || raw.startsWith('/') ||
        /^[A-Za-z]:/.test(raw) || raw.split('/').includes('..') ||
        name.split('/').some((part) => part.startsWith('.'))) {
      throw new HttpError(400, `快照包含非法路径: ${entry.path}`);
    }
    const parts = name.split('/');
    for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join('/'));
    if (entry.type === 'Directory') directories.add(name);
    else if (entry.type === 'File') files.set(name, await entry.buffer());
    else throw new HttpError(400, `快照包含不支持的条目: ${entry.path}`);
  }
  for (const name of files.keys()) {
    if (directories.has(name)) throw new HttpError(400, `快照包含冲突路径: ${name}`);
  }
  return { files, directories };
}

// Files excluded from snapshots must survive restoration too, including nested
// dotfiles. Keep their parent directories if they cannot be removed as empty.
function clearWorkingTree(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      clearWorkingTree(target);
      try { fs.rmdirSync(target); } catch (error) {
        if (error.code !== 'ENOTEMPTY') throw error;
      }
    } else fs.rmSync(target, { force: true });
  }
}

function writeWorkingTree(dir, tree) {
  clearWorkingTree(dir);
  for (const name of tree.directories) fs.mkdirSync(path.join(dir, name), { recursive: true });
  for (const [name, contents] of tree.files) {
    const target = path.join(dir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }
}

function requireRestoreAccess(projectId, user) {
  const db = getDb();
  const currentUser = user?.id != null ? db.prepare('SELECT * FROM users WHERE id = ?').get(user.id) : null;
  if (!currentUser || currentUser.status !== 'active') throw new HttpError(403, '恢复期间账号权限已失效');
  const currentProject = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  if (!currentProject) throw new HttpError(404, '项目不存在');
  return requireProjectAccess(currentUser, currentProject.public_id, { write: true }).project;
}

/** Restore with a recoverable pre-restore snapshot and no asynchronous write window. */
export function restoreVersion(projectId, versionId, { user } = {}) {
  return queueVersionOperation(projectId, async () => {
    requireRestoreAccess(projectId, user);
    const version = getVersionChecked(projectId, versionId);
    if (!version.snapshot_path || !fs.existsSync(version.snapshot_path)) {
      throw new HttpError(404, '快照文件已丢失');
    }
    const dir = projectDir(projectId);
    flushProjectRooms(projectId, { strict: true });
    const before = readWorkingTree(dir);
    const target = await readRestoreTree(version.snapshot_path);
    const checkUnchanged = () => {
      // Archive reading and safety-backup creation yield to permission changes.
      // Check fresh identity and access again before any destructive restore.
      requireRestoreAccess(projectId, user);
      flushProjectRooms(projectId, { strict: true });
      if (!sameWorkingTree(before, readWorkingTree(dir))) {
        throw new HttpError(409, '恢复期间项目有新的编辑，已保留当前内容；请检查后重试恢复');
      }
    };
    checkUnchanged();
    const project = getDb().prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
    if (!project) throw new HttpError(404, '项目不存在');
    await createSnapshotFromTree({
      project, user, message: `恢复前自动保存（恢复到 v${version.seq || version.id}）`,
    }, before);
    checkUnchanged();
    try {
      // All buffers are loaded; no await permits edits between deletion and reload.
      writeWorkingTree(dir, target);
    } catch (error) {
      try { writeWorkingTree(dir, before); } catch (rollbackError) {
        console.error('[versions] restore rollback failed:', rollbackError.message);
      }
      throw new HttpError(500, `恢复失败，恢复前内容已保存为版本: ${error.message}`);
    }
    reloadProjectRooms(projectId);
    return { ok: true };
  });
}
