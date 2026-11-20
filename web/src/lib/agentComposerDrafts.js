import { reactive } from 'vue';

const PREFIX = 'corelatex.agentDraft.';
export function composerDraftScope(userId, projectId) {
  if (userId == null || !projectId) return null;
  return `${encodeURIComponent(String(userId))}:${encodeURIComponent(String(projectId))}`;
}

// Per browser page, with only text persisted in this tab's sessionStorage.
// Attachment data and readers never enter Pinia or browser storage.
export function createComposerDraftCache(storage = () => globalThis.sessionStorage) {
  const drafts = new Map();
  const submissions = new Map();
  const getStorage = () => typeof storage === 'function' ? storage() : storage;
  function get(scope) {
    if (!scope) return null;
    if (!drafts.has(scope)) {
      let text = '';
      try { text = getStorage()?.getItem(PREFIX + scope) || ''; } catch {}
      drafts.set(scope, reactive({ text, attachments: [] }));
    }
    return drafts.get(scope);
  }
  function persist(scope) {
    const draft = drafts.get(scope);
    if (!draft) return;
    const pending = submissions.get(scope);
    const text = draft.text || (draft.attachments.length ? '' : pending?.text) || '';
    try {
      if (text) getStorage()?.setItem(PREFIX + scope, text);
      else getStorage()?.removeItem(PREFIX + scope);
    } catch { /* Keep the in-memory draft if storage is disabled or full. */ }
  }
  function begin(scope, fallback) {
    const draft = get(scope) || fallback;
    if (!draft) return null;
    const ticket = { scope, draft, text: draft.text, attachments: draft.attachments };
    if (scope) submissions.set(scope, ticket);
    draft.text = '';
    draft.attachments = [];
    persist(scope);
    return ticket;
  }
  function finish(ticket, success) {
    if (!ticket) return;
    if (ticket.scope && submissions.get(ticket.scope) !== ticket) return;
    if (ticket.scope) submissions.delete(ticket.scope);
    if (!success && !ticket.draft.text && !ticket.draft.attachments.length) {
      ticket.draft.text = ticket.text;
      ticket.draft.attachments = ticket.attachments;
    }
    persist(ticket.scope);
  }
  function clearAccount(userId) {
    if (userId == null) return;
    const prefix = `${encodeURIComponent(String(userId))}:`;
    for (const scope of drafts.keys()) {
      if (!scope.startsWith(prefix)) continue;
      drafts.delete(scope);
      submissions.delete(scope);
    }
    try {
      const target = getStorage();
      for (let i = (target?.length || 0) - 1; i >= 0; i--) {
        const key = target.key(i);
        if (key?.startsWith(PREFIX + prefix)) target.removeItem(key);
      }
    } catch {}
  }
  return { get, persist, begin, finish, clearAccount };
}

export const composerDrafts = createComposerDraftCache();
