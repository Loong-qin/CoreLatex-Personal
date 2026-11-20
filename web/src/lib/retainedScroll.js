import { nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, watch } from 'vue';
import { useProjectContext } from './projectContext.js';

export function hasScrollLayout(el) { return !!(el && el.isConnected !== false && el.clientWidth > 0 && el.clientHeight > 0); }
export function createRetainedScrollController() {
  let snapshot = null;
  return {
    get snapshot() { return snapshot; },
    set snapshot(value) { snapshot = value ? { top: value.top || 0, left: value.left || 0 } : null; },
    capture(el) {
      if (!hasScrollLayout(el)) return false;
      snapshot = { top: el.scrollTop, left: el.scrollLeft };
      return true;
    },
    restore(el) {
      if (!snapshot || !hasScrollLayout(el)) return false;
      const maxTop = Math.max(0, el.scrollHeight - el.clientHeight);
      const maxLeft = Math.max(0, el.scrollWidth - el.clientWidth);
      el.scrollTop = Math.min(snapshot.top, maxTop);
      el.scrollLeft = Math.min(snapshot.left, maxLeft);
      return maxTop >= snapshot.top && maxLeft >= snapshot.left;
    },
  };
}
const memories = new WeakMap();
export function useRetainedScroll(element, options = {}) {
  const context = useProjectContext();
  let lifecycleActive = true, mounted = false, disposed = false, pending = false, resizeObserver, boundElement, contentObserver, observingContent = false;
  const local = new Map();
  const memory = options.scope ? (memories.get(options.scope) || (memories.set(options.scope, new Map()), memories.get(options.scope))) : local;
  const getKey = () => options.key?.() ?? 'scroll';
  const getController = key => { if (!memory.has(key)) memory.set(key, createRetainedScrollController()); return memory.get(key); };
  let controller = getController(getKey());
  const active = () => lifecycleActive && (context?.active.value ?? true) && (options.active?.() ?? true);
  function capture() { return active() && !disposed && !pending ? controller.capture(element.value) : false; }
  function restore() {
    if (!mounted || disposed || !active() || !pending) return false;
    if (controller.restore(element.value)) pending = false;
    syncContentObservation();
    return !pending;
  }
  function syncContentObservation() {
    const observe = pending && mounted && !disposed && active() && !!boundElement;
    if (!observe) { contentObserver?.disconnect(); observingContent = false; return; }
    if (!observingContent && typeof MutationObserver !== 'undefined') {
      contentObserver ||= new MutationObserver(() => { if (pending) nextTick(restore); });
      contentObserver.observe(boundElement, { childList: true, subtree: true, characterData: true });
      observingContent = true;
    }
  }
  function resume() { pending = !!controller.snapshot; syncContentObservation(); nextTick(restore); }
  function suspend() { if (!pending) controller.capture(element.value); pending = !!controller.snapshot; syncContentObservation(); }
  function onScroll() { capture(); }
  function onIntent() { pending = false; syncContentObservation(); }
  watch(() => (context?.active.value ?? true) && (options.active?.() ?? true), value => {
    // This synchronous capture precedes v-show and KeepAlive DOM removal.
    if (value) resume(); else suspend();
  }, { flush: 'sync' });
  watch(getKey, (key, previous) => {
    if (key === previous) return;
    if (!pending && active()) controller.capture(element.value);
    controller = getController(key);
    if (!controller.snapshot) controller.snapshot = { top: 0, left: 0 };
    resume();
  }, { flush: 'sync' });
  function bindElement(el) {
    if (el === boundElement) return;
    resizeObserver?.disconnect(); contentObserver?.disconnect(); observingContent = false;
    boundElement?.removeEventListener('scroll', onScroll); boundElement?.removeEventListener('wheel', onIntent);
    boundElement?.removeEventListener('pointerdown', onIntent); boundElement?.removeEventListener('keydown', onIntent);
    boundElement = el;
    el?.addEventListener('scroll', onScroll, { passive: true });
    el?.addEventListener('wheel', onIntent, { passive: true });
    el?.addEventListener('pointerdown', onIntent, { passive: true });
    el?.addEventListener('keydown', onIntent);
    if (typeof ResizeObserver !== 'undefined' && el) { resizeObserver = new ResizeObserver(restore); resizeObserver.observe(el); }
    if (controller.snapshot) resume(); else capture();
  }
  watch(element, el => { if (mounted && !disposed) bindElement(el); }, { flush: 'post' });
  onMounted(() => { mounted = true; bindElement(element.value); });
  onActivated(() => { lifecycleActive = true; resume(); });
  onDeactivated(() => { suspend(); lifecycleActive = false; });
  onBeforeUnmount(() => {
    suspend(); disposed = true; resizeObserver?.disconnect(); contentObserver?.disconnect();
    bindElement(null);
  });
  return { capture, restore };
}
