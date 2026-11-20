import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { safeJoin, toPosix } from '../../util.js';
import { flushProjectRooms } from '../../collab.js';

export const fileHash = value => value == null ? null : createHash('sha256').update(String(value)).digest('hex');

// Content, not mtime, defines identity. Flush Yjs before observing the project.
export function fileState(ctx, relative) {
  if (ctx.project?.id != null) flushProjectRooms(ctx.project.id, { strict: true });
  const abs = safeJoin(ctx.projectDir, String(relative || ''));
  const rel = toPosix(path.relative(ctx.projectDir, abs));
  const draft = ctx.changesetBuffer?.find(file => file.path === rel);
  const encoding = draft?.encoding || 'utf8';
  const bytes = fs.existsSync(abs) ? fs.readFileSync(abs) : null;
  const project = bytes == null ? null : bytes.toString(encoding);
  const effective = draft ? draft.after : project;
  const baseline = ctx.fileBaselines?.has(rel) ? ctx.fileBaselines.get(rel) : draft?.before;
  return { rel, abs, draft, project, effective, projectText: bytes != null && isUtf8(bytes) && !bytes.includes(0),
    projectHash: fileHash(project), effectiveHash: fileHash(effective),
    conflict: !!draft && project !== baseline };
}

export function draftConflict(state) {
  if (!state.conflict) return null;
  return { code: 'DRAFT_BASE_CHANGED', error: `${state.rel} 的正式文件在草稿建立后已被修改或删除；旧草稿不能继续作为当前文件编辑。` +
    '请分别 read_file 默认草稿与 view="project" 的正式版本，保留用户修改后用 write_file 的 rebase 核对两个哈希更新草稿；无法确定合并意图时向用户说明冲突。',
    projectHash: state.projectHash, draftHash: state.effectiveHash };
}

function mergeRanges(ranges) {
  const merged = [];
  for (const range of ranges.sort((a, b) => a[0] - b[0])) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }
  return merged;
}

export function rememberRead(ctx, state, view, start, end) {
  ctx.fileReads ||= new Map();
  ctx.fileObservations ||= new Map();
  if (view === 'effective') ctx.fileObservations.set(state.rel, state.projectHash);
  const key = `${view}:${state.rel}`, text = view === 'project' ? state.project : state.effective;
  const hash = fileHash(text), old = ctx.fileReads.get(key);
  const ranges = mergeRanges([...(old?.hash === hash ? old.ranges : []), [start, end]]);
  ctx.fileReads.set(key, { hash, projectHash: state.projectHash, ranges, size: text?.length || 0 });
}

export function readCovers(ctx, rel, text, { view = 'effective', start = 0, end = text.length } = {}) {
  const read = ctx.fileReads?.get(`${view}:${rel}`);
  return !!read && read.hash === fileHash(text) && read.ranges.some(([a, b]) => a <= start && b >= end);
}

// Locally authored changes are known bytes, but must not turn an unseen region
// into a full read. Preserve and shift the actually observed windows.
export function advanceRead(ctx, rel, before, after, offset = 0, removed = before.length, inserted = after.length) {
  const read = ctx.fileReads?.get(`effective:${rel}`);
  if (!read || read.hash !== fileHash(before)) return;
  const delta = inserted - removed, boundary = offset + removed;
  const shift = p => p <= offset ? p : p >= boundary ? p + delta : offset + inserted;
  ctx.fileReads.set(`effective:${rel}`, { ...read, hash: fileHash(after), size: after.length,
    ranges: read.ranges.map(([a, b]) => [shift(a), shift(b)]) });
}

export function scanFileChanges(ctx) {
  const paths = new Set([...(ctx.reads?.keys() || []), ...(ctx.fileObservations?.keys() || []), ...(ctx.changesetBuffer || []).map(file => file.path)]);
  const changes = [];
  for (const rel of paths) {
    try {
      const state = fileState(ctx, rel), read = ctx.fileReads?.get(`effective:${rel}`);
      // Private draft changes are authored by this run (including atomic
      // worker merges). They may require a new read before editing, but are not
      // evidence of an external project change.
      const observed = ctx.fileObservations?.has(rel) ? ctx.fileObservations.get(rel) : read?.projectHash;
      if (state.conflict || observed !== undefined && observed !== state.projectHash) {
        ctx.readEvidence?.delete(rel);
        changes.push({ path: rel, conflict: state.conflict, projectHash: state.projectHash, draftHash: state.effectiveHash });
      }
    } catch { changes.push({ path: rel, unavailable: true }); ctx.readEvidence?.delete(rel); }
  }
  return changes;
}
