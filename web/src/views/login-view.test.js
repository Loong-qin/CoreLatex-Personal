// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, nextTick } from 'vue';
import LoginView from './LoginView.vue';

vi.mock('../stores/auth.js', () => ({ useAuthStore: () => ({ login: vi.fn(), register: vi.fn(), token: '' }) }));
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));

let app, host;
const flush = async () => { for (let i = 0; i < 4; i++) { await Promise.resolve(); await nextTick(); } };

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  document.documentElement.className = 'light';
});
afterEach(() => {
  app?.unmount(); app = null; host?.remove();
  vi.clearAllTimers(); vi.useRealTimers();
  localStorage.clear();
  document.documentElement.className = 'light';
});
async function mount() {
  host = document.createElement('div'); document.body.append(host);
  app = createApp(LoginView);
  app.mount(host);
  await flush();
}

describe('登录页演示与外观', () => {
  it('演示窗无缝循环：打字完成后进入已编译状态', async () => {
    await mount();
    expect(host.querySelector('.product-demo')).toBeTruthy();
    expect(host.querySelector('.typing-text').textContent).toBe('');
    vi.advanceTimersByTime(1400);
    await flush();
    expect(host.querySelector('.typing-text').textContent).toBe('Introduction');
    expect(host.querySelector('.compile-status').textContent).toContain('编译中');
    vi.advanceTimersByTime(600);
    await flush();
    expect(host.querySelector('.compile-status').textContent).toContain('PDF 已更新');
    expect(host.querySelector('.demo-saved').textContent).toContain('已保存');
    expect(host.querySelector('.paper-equation').textContent).toBe('eⁱπ + 1 = 0');
    // 循环推进到第二组后仍回到第一组（无缝）
    vi.advanceTimersByTime(9000);
    await flush();
    expect(['Introduction', 'Method', 'Results']).toContain(host.querySelector('.typing-text').textContent);
  });

  it('右上角快捷切换明暗并持久化', async () => {
    await mount();
    const toggle = host.querySelector('.mode-toggle');
    toggle.click();
    await flush();
    expect(localStorage.getItem('corelatex.theme')).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    toggle.click();
    await flush();
    expect(document.documentElement.classList.contains('light')).toBe(true);
  });
});
