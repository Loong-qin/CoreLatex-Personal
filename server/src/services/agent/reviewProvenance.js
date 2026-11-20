import { diffArrays } from 'diff';

// Keep offsets in Unicode code points, so a manual edit cannot split a surrogate pair.
function changes(before, after) {
  const result = [];
  let oldOffset = 0, newOffset = 0, pending = null;
  for (const part of diffArrays(before, after)) {
    if (part.added || part.removed) {
      pending ||= { oldStart: oldOffset, oldEnd: oldOffset, newStart: newOffset, newEnd: newOffset };
      if (part.removed) oldOffset += part.value.length;
      else newOffset += part.value.length;
      pending.oldEnd = oldOffset;
      pending.newEnd = newOffset;
    } else {
      if (pending) result.push(pending);
      pending = null;
      oldOffset += part.value.length;
      newOffset += part.value.length;
    }
  }
  if (pending) result.push(pending);
  return result;
}

function touches(ai, manual) {
  const a = ai.newStart, b = ai.newEnd;
  const x = manual.oldStart, y = manual.oldEnd;
  if (a === b && x === y) return a === x;
  if (a === b) return x < a && a < y;
  if (x === y) return a < x && x < b;
  return a < y && x < b;
}

function baseOffset(position, side, aiChanges, owned) {
  let offset = 0;
  for (const change of aiChanges) {
    if (position < change.newStart) break;
    if (position === change.newStart && change.newStart === change.newEnd) {
      // A deletion occupies no characters in the head. Only an edit at the gap,
      // or spanning across it, owns that deletion; edits next to it do not.
      if (owned.has(change)) return side === 'start' ? change.oldStart : change.oldEnd;
      return side === 'start' ? change.oldEnd : change.oldStart;
    }
    if (position === change.newStart) return change.oldStart;
    if (position === change.newEnd) return change.oldEnd;
    if (position < change.newEnd) {
      throw new Error('Manual edit boundary must include its overlapping AI change');
    }
    offset = change.oldEnd - change.newEnd;
  }
  return position + offset;
}

/**
 * Advance the review baseline by the edits made between two observed heads.
 * Independent AI changes remain absent from the baseline. When a human edits
 * inside an AI replacement, the touched replacement is owned by the human in
 * full: undoing AI must never restore text over that human rewrite.
 *
 * These are snapshots, not operation IDs. Repeated text can have several valid
 * alignments; diff's positional alignment is used consistently, never replaceAll.
 */
export function transportManualChanges(base, previousHead, currentHead) {
  if (previousHead === currentHead) return base;
  if (base === previousHead) return currentHead;
  let baseline = Array.from(base);
  const previous = Array.from(previousHead);
  const current = Array.from(currentHead);
  const aiChanges = changes(baseline, previous);
  const manualChanges = changes(previous, current);
  const parents = Array.from({ length: aiChanges.length + manualChanges.length }, (_, i) => i);
  const root = (i) => {
    while (parents[i] !== i) {
      parents[i] = parents[parents[i]];
      i = parents[i];
    }
    return i;
  };
  const unite = (a, b) => { parents[root(a)] = root(b); };
  for (let m = 0; m < manualChanges.length; m++) {
    for (let a = 0; a < aiChanges.length; a++) {
      if (touches(aiChanges[a], manualChanges[m])) unite(a, aiChanges.length + m);
    }
  }
  const groups = new Map();
  for (let m = 0; m < manualChanges.length; m++) {
    const id = root(aiChanges.length + m);
    if (!groups.has(id)) groups.set(id, { manual: [], ai: [] });
    groups.get(id).manual.push(manualChanges[m]);
  }
  for (let a = 0; a < aiChanges.length; a++) {
    groups.get(root(a))?.ai.push(aiChanges[a]);
  }
  const edits = [];
  for (const group of groups.values()) {
    const start = Math.min(...group.manual.map(c => c.oldStart), ...group.ai.map(c => c.newStart));
    const end = Math.max(...group.manual.map(c => c.oldEnd), ...group.ai.map(c => c.newEnd));
    let replacement = previous.slice(start, end);
    for (const manual of [...group.manual].sort((a, b) => b.oldStart - a.oldStart)) {
      replacement = replacement.slice(0, manual.oldStart - start).concat(
        current.slice(manual.newStart, manual.newEnd), replacement.slice(manual.oldEnd - start));
    }
    const owned = new Set(group.ai);
    edits.push({
      start: baseOffset(start, 'start', aiChanges, owned),
      end: baseOffset(end, 'end', aiChanges, owned),
      headStart: start,
      headEnd: end,
      replacement,
    });
  }
  edits.sort((a, b) => b.start - a.start || b.headStart - a.headStart
    || b.end - a.end || b.headEnd - a.headEnd);
  for (const edit of edits) {
    baseline = baseline.slice(0, edit.start).concat(edit.replacement, baseline.slice(edit.end));
  }
  return baseline.join('');
}

function stillPending(candidate, previousPending, candidateBase, oldBase) {
  if (candidate.newStart === candidate.newEnd) {
    // For an AI deletion there is no current interval to intersect. A neighboring
    // manual edit may merge its old diff hunk with this deletion, so require the
    // deleted text within the old hunk at this gap rather than exact hunk bounds.
    const removed = candidateBase.slice(candidate.oldStart, candidate.oldEnd).join('');
    return previousPending.some(change => change.newStart <= candidate.newStart
      && change.newEnd >= candidate.newEnd
      && oldBase.slice(change.oldStart, change.oldEnd).join('').includes(removed));
  }
  let coveredUntil = candidate.newStart;
  for (const change of previousPending) {
    if (change.newEnd <= coveredUntil) continue;
    if (change.newStart > coveredUntil) return false;
    coveredUntil = change.newEnd;
    if (coveredUntil >= candidate.newEnd) return true;
  }
  return false;
}

/**
 * Repair a legacy baseline whose last observed head was not stored.
 * pendingSequence contains chronological { before, after } text snapshots for
 * only the AI changes that are still pending. Gaps between those snapshots are
 * manual/accepted work and are transported into the reconstructed baseline.
 *
 * Intersect with the old unresolved ranges so a previously accepted block never
 * reappears. If a partial acceptance splits an indivisible replacement, prefer
 * retaining human/accepted text over reviving uncertain historical AI changes.
 * No pending AI evidence means no remaining review difference.
 */
export function reconstructLegacyReviewBase(oldBase, currentHead, pendingSequence = []) {
  const sequence = pendingSequence.filter(entry =>
    typeof entry?.before === 'string' && typeof entry?.after === 'string');
  if (!sequence.length || oldBase === currentHead) return currentHead;
  let candidate = sequence[0].before;
  let previous = sequence[0].before;
  for (const entry of sequence) {
    candidate = transportManualChanges(candidate, previous, entry.before);
    previous = entry.after;
  }
  candidate = transportManualChanges(candidate, previous, currentHead);
  const candidateChars = Array.from(candidate);
  const currentChars = Array.from(currentHead);
  const oldChars = Array.from(oldBase);
  const remaining = changes(candidateChars, currentChars);
  const oldPending = changes(oldChars, currentChars);
  let result = [...currentChars];
  for (const change of [...remaining].reverse()) {
    if (stillPending(change, oldPending, candidateChars, oldChars)) {
      result = result.slice(0, change.newStart).concat(
        candidateChars.slice(change.oldStart, change.oldEnd), result.slice(change.newEnd));
    }
  }
  return result.join('');
}
