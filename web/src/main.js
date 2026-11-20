import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { router } from './router.js';
import ElementPlus from 'element-plus';
import * as ElementPlusIconsVue from '@element-plus/icons-vue';
import 'element-plus/dist/index.css';
import 'element-plus/theme-chalk/dark/css-vars.css';
import './theme.css';
import { useAuthStore } from './stores/auth.js';
import { applyAppearance, watchSystemTheme } from './lib/theme.js';

applyAppearance();
watchSystemTheme();

const app = createApp(App);
app.use(createPinia());
app.use(router);
app.use(ElementPlus);
for (const [name, component] of Object.entries(ElementPlusIconsVue)) {
  app.component(name, component);
}
app.mount('#app');

// 有 token 时恢复登录用户信息（刷新后 auth.user 不再是空）
const auth = useAuthStore();
if (auth.token) auth.fetchMe().catch(() => {});
