const PREFIX = 'corelatex.workspaces.';
const VERSION = 1;
const MAX_PROJECTS = 100;
const MAX_STORED_LENGTH = 512 * 1024;
const emptySession = () => ({ projects: [], activeProjectId: null });

function storageKey(userId) {
  if (typeof userId !== 'string' && typeof userId !== 'number') return null;
  if (typeof userId === 'number' && !Number.isFinite(userId)) return null;
  const id = String(userId);
  if (!id.trim() || id.length > 256) return null;
  return PREFIX + encodeURIComponent(id);
}

function validProjectId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 256
    && id.trim() === id && !/[/\\?#\u0000-\u001f\u007f-\u009f]/u.test(id);
}

function normalizeSession(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return emptySession();
  const projects = [];
  const ids = new Set();
  if (Array.isArray(snapshot.projects)) {
    for (const project of snapshot.projects) {
      if (!project || typeof project !== 'object' || Array.isArray(project)) continue;
      const id = project.publicId;
      if (!validProjectId(id) || ids.has(id)) continue;
      ids.add(id);
      const entry = { publicId: id, name: typeof project.name === 'string' ? project.name.slice(0, 200) : '' };
      if (project.unreadCompletion === true) entry.unreadCompletion = true;
      if (typeof project.trackedRunId === 'string' && /^[\w-]{1,128}$/.test(project.trackedRunId)) {
        entry.trackedRunId = project.trackedRunId;
      }
      projects.push(entry);
      if (projects.length === MAX_PROJECTS) break;
    }
  }
  return { projects, activeProjectId: ids.has(snapshot.activeProjectId) ? snapshot.activeProjectId : null };
}

// Tab-local navigation and notification metadata. The server still owns review
// decisions, chat history and the exact outcome of a tracked run.
export function readWorkspaceSession(userId, storage) {
  try {
    const key = storageKey(userId);
    if (!key) return emptySession();
    const raw = (storage === undefined ? globalThis.sessionStorage : storage)?.getItem(key);
    if (typeof raw !== 'string' || raw.length > MAX_STORED_LENGTH) return emptySession();
    const snapshot = JSON.parse(raw);
    if (!snapshot || snapshot.version !== VERSION) return emptySession();
    return normalizeSession(snapshot);
  } catch { return emptySession(); }
}

export function saveWorkspaceSession(userId, snapshot, storage) {
  try {
    const key = storageKey(userId);
    if (!key) return;
    const normalized = normalizeSession(snapshot);
    (storage === undefined ? globalThis.sessionStorage : storage)?.setItem(key, JSON.stringify({ version: VERSION, ...normalized }));
  } catch { /* Navigation remains usable when tab storage is blocked or full. */ }
}

export function clearWorkspaceSession(userId, storage) {
  try {
    const key = storageKey(userId);
    if (key) (storage === undefined ? globalThis.sessionStorage : storage)?.removeItem(key);
  } catch { /* Storage availability must not prevent logout or navigation. */ }
}
