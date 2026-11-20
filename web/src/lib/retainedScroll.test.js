// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, h, nextTick, provide, ref } from 'vue';
import { createRetainedScrollController, useRetainedScroll } from './retainedScroll.js';
import { PROJECT_CONTEXT } from './projectContext.js';
let app, host;
const flush = async () => { await nextTick(); await nextTick(); };
afterEach(() => { app?.unmount(); host?.remove(); app = null; });
describe('retained scroll geometry', () => {
  it('never replaces a valid horizontal/vertical snapshot with collapsed geometry and waits for a usable viewport', () => {
    const memory = createRetainedScrollController();
    const el = { clientWidth: 300, clientHeight: 400, scrollWidth: 1200, scrollHeight: 2400, scrollTop: 1120, scrollLeft: 85 };
    expect(memory.capture(el)).toBe(true);
    el.isConnected = false; expect(memory.capture(el)).toBe(false); el.isConnected = true;
    el.clientWidth = 0; el.clientHeight = 0; el.scrollTop = 0; el.scrollLeft = 0;
    expect(memory.capture(el)).toBe(false); expect(memory.restore(el)).toBe(false);
    el.clientWidth = 300; el.clientHeight = 400;
    expect(memory.restore(el)).toBe(true); expect(el.scrollTop).toBe(1120); expect(el.scrollLeft).toBe(85);
  });
  it('captures on the synchronous active transition before DOM detachment and ignores hidden zero scroll events', async () => {
    const active = ref(true), scroll = ref(null);
    const Pane = { setup() { useRetainedScroll(scroll); return () => h('div', { ref: scroll }); } };
    app = createApp({ setup() { provide(PROJECT_CONTEXT, { active }); return () => h(Pane); } });
    host = document.createElement('div'); document.body.appendChild(host); app.mount(host); await flush();
    const el = scroll.value; let width = 300, height = 400;
    Object.defineProperties(el, { clientWidth: { get: () => width }, clientHeight: { get: () => height }, scrollWidth: { value: 800 }, scrollHeight: { value: 2400 } });
    // No prior scroll event: the sync active watcher must capture before the dimensions disappear.
    el.scrollTop = 900; el.scrollLeft = 45; active.value = false;
    width = 0; height = 0; el.scrollTop = 0; el.scrollLeft = 0; el.dispatchEvent(new Event('scroll')); await flush();
    width = 300; height = 400; active.value = true; await flush();
    expect(el.scrollTop).toBe(900); expect(el.scrollLeft).toBe(45);
  });
  it('finishes restoring when asynchronous content regains its height without a viewport resize', async () => {
    const active = ref(true), scroll = ref(null);
    const Pane = { setup() { useRetainedScroll(scroll); return () => h('div', { ref: scroll }); } };
    app = createApp({ setup() { provide(PROJECT_CONTEXT, { active }); return () => h(Pane); } });
    host = document.createElement('div'); document.body.appendChild(host); app.mount(host); await flush();
    const el = scroll.value; let contentHeight = 2400;
    Object.defineProperties(el, { clientWidth: { value: 300 }, clientHeight: { value: 400 }, scrollWidth: { value: 300 }, scrollHeight: { get: () => contentHeight } });
    el.scrollTop = 900; active.value = false; contentHeight = 500; el.scrollTop = 0;
    active.value = true; await flush(); expect(el.scrollTop).toBe(100);
    contentHeight = 2400; el.appendChild(document.createTextNode('late results')); await flush();
    expect(el.scrollTop).toBe(900);
  });

});
