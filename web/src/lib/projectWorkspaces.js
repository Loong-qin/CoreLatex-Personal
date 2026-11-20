import { defineComponent, markRaw, onUnmounted, provide, ref, shallowReactive, shallowRef } from 'vue';
import { PROJECT_CONTEXT } from './projectContext.js';
import { createEditorRuntime } from './editorRuntime.js';
import { createProjectEditorStore, bindEditorContext, releaseEditorContext } from '../stores/editor.js';
import { createProjectAgentStore, bindAgentContext } from '../stores/agent.js';
import { useUiStore } from '../stores/ui.js';
import { detachProjectCollab } from './collabClient.js';

// All projects live in this page's Pinia, with separate ids and explicit dependencies.
// KeepAlive hides a workspace without clearing its stores or disconnecting its run.
export function createProjectWorkspaces(pinia) {
  const sessions = shallowReactive([]);
  let disposed = false;
  function dispose(session) {
    if (session.disposed) return;
    session.disposed = true;
    session.context.active.value = false;
    if (session.mounted) session.editor.saveViewState();
    session.agent.clearLocal(); // Detach this local stream; never cancel the server task.
    detachProjectCollab(session.publicId);
    releaseEditorContext(session.editor);
    session.context.runtime.register(null);
    session.editor.$dispose(); session.agent.$dispose();
    delete pinia.state.value[session.editor.$id];
    delete pinia.state.value[session.agent.$id];
  }
  function open(projectId, name = '', saved = null) {
    const id = String(projectId);
    let session = sessions.find((s) => s.publicId === id);
    if (session) {
      if (name) session.context.name.value = name;
      if (saved) {
        const current = session.completion.value;
        session.completion.value = {
          unreadCompletion: !session.context.active.value && (current.unreadCompletion || !!saved.unreadCompletion),
          trackedRunId: current.trackedRunId || saved.trackedRunId || null,
        };
      }
      return session;
    }
    if (disposed) return null;
    const editor = createProjectEditorStore(id, pinia);
    const agent = createProjectAgentStore(id, pinia);
    const runtime = createEditorRuntime();
    bindEditorContext(editor, { runtime, projectId: id });
    const context = markRaw({ projectId: id, editor, agent, runtime, active: ref(false), name: ref(name), error: ref('') });
    const completion = shallowRef({ unreadCompletion: !!saved?.unreadCompletion, trackedRunId: saved?.trackedRunId || null });
    session = markRaw({ publicId: id, editor, agent, context, completion, disposed: false, cacheName: `ProjectWorkspace_${id.replace(/[^a-zA-Z0-9_]/g, '_')}` });
    bindAgentContext(agent, {
      editor, ui: useUiStore(pinia),
      trackedRunId: () => completion.value.trackedRunId,
      trackRun(runId) {
        if (runId !== completion.value.trackedRunId) completion.value = { ...completion.value, trackedRunId: runId };
      },
      settleRun(runId, unreadResult) {
        const current = completion.value;
        if (runId !== current.trackedRunId) return;
        // Publish the cleared run identity and its unread state together.
        completion.value = {
          trackedRunId: null,
          unreadCompletion: current.unreadCompletion || (!context.active.value && unreadResult),
        };
      },
    });
    session.component = markRaw(defineComponent({
      name: session.cacheName,
      props: { view: { required: true } },
      setup(props) {
        session.mounted = true;
        provide(PROJECT_CONTEXT, context);
        onUnmounted(() => dispose(session));
        return () => props.view;
      },
    }));
    sessions.push(session);
    return session;
  }
  function activate(projectId) {
    for (const session of sessions) {
      const active = session.publicId === String(projectId);
      session.context.active.value = active;
      if (active && session.completion.value.unreadCompletion) {
        session.completion.value = { ...session.completion.value, unreadCompletion: false };
      }
    }
  }
  function remove(projectId) {
    const index = sessions.findIndex((s) => s.publicId === String(projectId));
    if (index < 0) return;
    const [session] = sessions.splice(index, 1);
    session.context.active.value = false;
    if (!session.mounted) dispose(session);
    // The KeepAlive include list unmounts the removed workspace, then disposes it.
  }
  function clear() {
    activate(null);
    const removed = sessions.splice(0);
    // Handles a session created before its wrapper ever mounted, too.
    for (const session of removed) if (!session.mounted) dispose(session);
  }
  return { sessions, open, activate, remove, clear, dispose: () => { disposed = true; clear(); } };
}
