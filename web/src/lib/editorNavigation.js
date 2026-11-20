import { nextTick, watch } from 'vue';

// Wait for the editor registered for this exact file, not a guessed load delay.
export function createEditorNavigator(store, runtime, { active = () => true, onError = () => {} } = {}) {
  let pending = null;
  function cancel() { pending?.finish(false); }
  function open(path, { line = 0, col = 0, offset } = {}) {
    cancel();
    if (!path || !active() || !store.projectId) return Promise.resolve(false);
    const projectId = store.projectId, projectVersion = store.projectVersion;
    store.viewMode = 'code';
    store.openFile(path);
    return new Promise(resolve => {
      let stop = () => {}, timer, applying = false;
      const token = { finish(result) {
        if (pending !== token) return;
        pending = null; stop(); clearTimeout(timer); resolve(result);
      } };
      pending = token;
      const current = () => pending === token && active() && store.projectId === projectId && store.projectVersion === projectVersion && store.activeFile === path && store.viewMode === 'code';
      const ready = () => runtime.view && runtime.projectId === projectId && runtime.filePath === path;
      async function check() {
        if (!current()) { token.finish(false); return; }
        if (!ready() || applying) return;
        applying = true;
        // Let the mounted editor finish restoring its previous viewport first.
        await nextTick();
        applying = false;
        if (!current()) { token.finish(false); return; }
        if (!ready()) return;
        try {
          runtime.jumpToLine(offset == null ? line : runtime.getLineForPos(offset), col);
          token.finish(true);
        } catch (error) { token.finish(false); onError(error.message || '定位失败'); }
      }
      stop = watch(() => [runtime.view, runtime.projectId, runtime.filePath, store.projectId, store.projectVersion, store.activeFile, store.viewMode, active()], check, { flush: 'post' });
      timer = setTimeout(() => { if (current()) onError('文件仍未加载完成，请加载后重新定位'); token.finish(false); }, 20000);
      check();
    });
  }
  return { open, cancel };
}
