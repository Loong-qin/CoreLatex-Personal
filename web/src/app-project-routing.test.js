// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { createApp, nextTick, onMounted, onBeforeUnmount, h } from 'vue';
import { createPinia } from 'pinia';
import { createRouter, createMemoryHistory } from 'vue-router';
import App from './App.vue';
vi.mock('./components/ContextMenu.vue', () => ({ default: { template: '<span />' } }));
describe('project route lifetime', () => {
  it('keeps A and B mounted across same-page project and query navigation', async () => {
    const mounts = [], unmounts = [];
    const Editor = { props: ['id'], setup(props) { const id = props.id; onMounted(() => mounts.push(id)); onBeforeUnmount(() => unmounts.push(id)); return () => h('div', props.id); } };
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/project/:id', name: 'editor', component: Editor, props: true }] });
    await router.push('/project/A'); await router.isReady();
    const host = document.createElement('div'); document.body.appendChild(host);
    const app = createApp(App); app.use(createPinia()); app.use(router); app.component('el-icon', { render: () => h('span') }); app.mount(host);
    try {
      await nextTick(); expect(mounts).toEqual(['A']);
      expect(host.querySelector('.workspace-shell > .workspace-project-tabs')).toBeNull();
      await router.push('/project/A?panel=pdf'); await nextTick();
      expect(mounts).toEqual(['A']); expect(unmounts).toEqual([]);
      await router.push('/project/B'); await nextTick();
      expect(mounts).toEqual(['A', 'B']); expect(unmounts).toEqual([]);
      expect(host.querySelector('.workspace-content').textContent).toBe('B');
      await router.push('/project/A'); await nextTick();
      expect(mounts).toEqual(['A', 'B']); expect(unmounts).toEqual([]);
      expect(host.querySelector('.workspace-content').textContent).toBe('A');
    } finally { app.unmount(); host.remove(); }
  });
});
