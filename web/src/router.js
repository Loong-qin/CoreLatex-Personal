import { createRouter, createWebHistory } from 'vue-router';
import { getToken } from './api.js';

const routes = [
  { path: '/login', name: 'login', component: () => import('./views/LoginView.vue'), meta: { public: true } },
  { path: '/', name: 'projects', component: () => import('./views/ProjectsView.vue') },
  { path: '/project/:id', name: 'editor', component: () => import('./views/EditorView.vue') },
  { path: '/admin', name: 'admin', component: () => import('./views/AdminView.vue') },
  { path: '/settings', name: 'settings', component: () => import('./views/SettingsView.vue') },
  { path: '/:pathMatch(.*)*', redirect: '/' },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
});

router.beforeEach((to) => {
  if (!to.meta.public && !getToken()) return { name: 'login' };
  if (to.name === 'login' && getToken()) return { name: 'projects' };
  return true;
});

// 发布新版本后，旧页面懒加载已删除的 chunk 会失败：自动整页刷新一次加载新版本
router.onError((error) => {
  const msg = String(error?.message || '');
  if (/Failed to fetch dynamically imported module|Importing a module script was aborted/.test(msg)) {
    if (!sessionStorage.getItem('corelatex.chunkReloaded')) {
      sessionStorage.setItem('corelatex.chunkReloaded', '1');
      location.reload();
    }
  }
});
