// A restrained glass chime, synthesized locally. No media download or task data
// leaves the browser. Account preferences are persisted by the settings API.
const SEEN_KEY = 'corelatex.agent-completion-sound.seen.v1';
const LAST_CHIME_KEY = 'corelatex.agent-completion-sound.last-chime.v1';
const LOCK_KEY = 'corelatex-agent-completion-sound';
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SEEN = 128;
// Remain silent until the signed-in account's preference has loaded.
let soundEnabled = false;
let preferenceRevision = 0;
let context;
let resuming;
let lastChimeAt = -Infinity;
const seen = new Map();

export function setCompletionSoundEnabled(enabled) {
  soundEnabled = enabled !== false;
  preferenceRevision++;
}

export function getCompletionSoundRevision() { return preferenceRevision; }

// GET responses are only snapshots. An older request must not undo a manual
// switch, a logout, or a newer account preference applied while it was pending.
export function syncCompletionSoundPreference(enabled, expectedRevision) {
  if (expectedRevision !== preferenceRevision) return false;
  setCompletionSoundEnabled(enabled);
  return true;
}

function audioContext() {
  if (context && context.state !== 'closed') return context;
  const AudioContext = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AudioContext) return null;
  try { context = new AudioContext(); } catch { return null; }
  return context;
}

// Call from a real user gesture. Completion handlers never resume a locked
// context, and never queue a chime to surprise the user on their next click.
export async function unlockCompletionSound() {
  const audio = audioContext();
  if (!audio) return false;
  try {
    if (audio.state !== 'running') {
      resuming ||= Promise.resolve(audio.resume()).finally(() => { resuming = null; });
      await resuming;
    }
    return audio.state === 'running';
  } catch { return false; }
}

export function installCompletionSoundUnlock(target = globalThis.window) {
  if (!target?.addEventListener) return () => {};
  const unlock = () => { void unlockCompletionSound(); };
  const events = ['pointerdown', 'keydown', 'touchend'];
  const options = { capture: true, passive: true };
  events.forEach(name => target.addEventListener(name, unlock, options));
  return () => events.forEach(name => target.removeEventListener(name, unlock, options));
}

function playChime({ preview = false } = {}) {
  const audio = context;
  if (!audio || audio.state !== 'running') return false;
  const now = Date.now();
  // Concurrent projects can finish together; let one gentle chime cover the
  // burst instead of stacking several loud tones.
  if (!preview && now - lastChimeAt < 700) return false;
  const nodes = [];
  try {
    const start = audio.currentTime + 0.015;
    const master = audio.createGain();
    nodes.push(master);
    master.gain.setValueAtTime(0.55, start);
    master.connect(audio.destination);
    let remaining = 6;
    for (const [frequency, offset] of [[587.33, 0], [880, 0.16]]) {
      for (const [ratio, strength, decay] of [[1, 0.14, 0.84], [2.01, 0.032, 0.48], [3.98, 0.006, 0.24]]) {
        const oscillator = audio.createOscillator();
        const envelope = audio.createGain();
        nodes.push(oscillator, envelope);
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(frequency * ratio, start + offset);
        envelope.gain.setValueAtTime(0, start + offset);
        envelope.gain.linearRampToValueAtTime(strength, start + offset + 0.008);
        envelope.gain.exponentialRampToValueAtTime(0.0001, start + offset + decay);
        envelope.gain.linearRampToValueAtTime(0, start + offset + decay + 0.025);
        oscillator.connect(envelope);
        envelope.connect(master);
        oscillator.onended = () => {
          oscillator.disconnect();
          envelope.disconnect();
          if (--remaining === 0) master.disconnect();
        };
        oscillator.start(start + offset);
        oscillator.stop(start + offset + decay + 0.04);
      }
    }
    lastChimeAt = now;
    return true;
  } catch {
    nodes.forEach(node => { try { node.disconnect(); } catch { /* audio is optional */ } });
    return false;
  }
}

export async function previewCompletionSound() {
  if (!await unlockCompletionSound()) return false;
  return playChime({ preview: true });
}

function trimEntries(entries, now) {
  return [...entries].reverse().filter(([, time]) => now - time < RETENTION_MS)
    .sort((a, b) => b[1] - a[1]).slice(0, MAX_SEEN);
}

function consumeLocally(key) {
  const now = Date.now();
  for (const [id, time] of seen) if (now - time >= RETENTION_MS) seen.delete(id);
  if (seen.has(key)) return false;
  seen.set(key, now);
  const rows = trimEntries(seen, now);
  seen.clear();
  rows.forEach(([id, time]) => seen.set(id, time));
  return true;
}

function notifyAcrossTabs(key) {
  const now = Date.now();
  let storage;
  let sharedLastChime = -Infinity;
  const shared = new Map();
  try {
    storage = globalThis.localStorage;
    const rows = JSON.parse(storage?.getItem(SEEN_KEY) || '[]');
    if (Array.isArray(rows)) {
      for (const row of rows) {
        if (Array.isArray(row) && typeof row[0] === 'string' && Number.isFinite(row[1]) && now - row[1] < RETENTION_MS) {
          shared.set(row[0], row[1]);
        }
      }
    }
    const timestamp = Number(storage?.getItem(LAST_CHIME_KEY));
    if (Number.isFinite(timestamp) && timestamp > 0) sharedLastChime = timestamp;
  } catch { /* Private browsing/storage failures still allow in-page dedupe. */ }
  if (shared.has(key)) return false;
  const coalesced = now - Math.max(sharedLastChime, lastChimeAt) < 700;
  const played = !coalesced && playChime();
  // A tab that cannot actually play must not take the notification away from
  // another ready tab. Bursts are consumed because a recent chime covers them.
  if (!played && !coalesced) return false;
  shared.set(key, now);
  try {
    storage?.setItem(SEEN_KEY, JSON.stringify(trimEntries(shared, now)));
    if (played) storage?.setItem(LAST_CHIME_KEY, String(now));
  } catch { /* Optional storage. */ }
  return played;
}

// `live` is intentionally opt-in: restoring finished history is never a new
// completion. Callers arm streams they started or restored while still active.
export async function notifyAgentCompletion({ runId, projectId = '', state, live = false, enabled } = {}) {
  if (live !== true || state !== 'completed' || !runId) return false;
  return notifyAgentEvent(JSON.stringify([String(projectId), String(runId)]), enabled);
}

// A question is distinct from completion and from other questions in the same run.
// The caller excludes restored history; storage also deduplicates reconnects/tabs.
export async function notifyAgentQuestion({ runId, projectId = '', questionId, live = false, enabled } = {}) {
  if (live !== true || !runId || !questionId) return false;
  return notifyAgentEvent(JSON.stringify([String(projectId), String(runId), 'question', String(questionId)]), enabled);
}

async function notifyAgentEvent(key, enabled) {
  // Muted or not-yet-unlocked pages consume only their own event; a ready page
  // can still claim the same completion. They never replay it after enabling.
  if (!consumeLocally(key)) return false;
  const notify = () => {
    if ((enabled ?? soundEnabled) === false || context?.state !== 'running') return false;
    return notifyAcrossTabs(key);
  };
  try {
    const locks = globalThis.navigator?.locks;
    if (locks?.request) return await locks.request(LOCK_KEY, notify);
    return notify();
  } catch {
    // Web Locks may be unavailable in restricted contexts. Storage and memory
    // still deduplicate; sound failures must never affect the completed run.
    try { return notify(); } catch { return false; }
  }
}
