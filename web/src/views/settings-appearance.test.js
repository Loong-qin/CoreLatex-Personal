// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, nextTick } from 'vue';
import SettingsView from '../views/SettingsView.vue';

const services = vi.hoisted(() => ({
  agent: { loadSettings: vi.fn(), saveSettings: vi.fn(), loadSkills: vi.fn(), skills: [] },
  auth: { token: 'account-a', user: { id: 1 }, isAdmin: false },
  ui: { error: vi.fn(), toast: vi.fn() },
}));
vi.mock('../stores/agent.js', () => ({ useAgentStore: () => services.agent }));
vi.mock('../stores/auth.js', () => ({ useAuthStore: () => services.auth }));
vi.mock('../stores/ui.js', () => ({ useUiStore: () => services.ui }));
vi.mock('../lib/agentCompletionSound.js', () => ({ previewCompletionSound: vi.fn(), setCompletionSoundEnabled: vi.fn() }));
vi.mock('../lib/collabClient.js', () => ({ setCollabUser: vi.fn() }));
vi.mock('../api.js', () => ({ api: { get: vi.fn(), put: vi.fn() } }));
vi.mock('../components/ModelProviderSettings.vue', () => ({ default: { render: () => null } }));
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn(), back: vi.fn() }) }));

let app, host;
const flush = async () => { for (let i = 0; i < 6; i++) { await Promise.resolve(); await nextTick(); } };
const navButton = label => [...host.querySelectorAll('.settings-nav button')].find(b => b.textContent.includes(label));

beforeEach(() => {
  localStorage.clear();
  document.documentElement.className = 'light';
  services.agent.loadSettings.mockResolvedValue({ providers: [], models: [], activeModelId: '' });
  services.agent.loadSkills.mockResolvedValue([]);
});
afterEach(() => {
  app?.unmount(); app = null; host?.remove();
  localStorage.clear();
  document.documentElement.className = 'light';
  delete document.documentElement.dataset.palette;
});
async function mount() {
  host = document.createElement('div'); document.body.append(host);
  app = createApp(SettingsView, { embedded: true });
  app.directive('loading', {});
  app.mount(host);
  await flush();
}

describe('设置 · 外观分区', () => {
  it('展示模式切换与六套配色，选择即时生效并持久化', async () => {
    await mount();
    navButton('外观').click();
    await flush();
    const cards = [...host.querySelectorAll('.palette-card')];
    expect(cards.length).toBe(6);
    expect(cards.map(c => c.querySelector('.palette-meta strong').textContent)).toEqual(['松烟', '黛蓝', '藕荷', '杏陶', '竹青', '月白']);
    expect(host.querySelector('.palette-card.active .palette-meta strong').textContent).toBe('松烟');

    cards.find(c => c.textContent.includes('黛蓝')).click();
    await flush();
    expect(localStorage.getItem('corelatex.palette')).toBe('mist');
    expect(document.documentElement.dataset.palette).toBe('mist');
    expect(host.querySelector('.palette-card.active .palette-meta strong').textContent).toBe('黛蓝');

    const modeButtons = [...host.querySelectorAll('.mode-segment button')];
    modeButtons.find(b => b.textContent.includes('深色')).click();
    await flush();
    expect(localStorage.getItem('corelatex.theme')).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    // 预览切到深色变体
    expect(host.querySelector('.palette-card .palette-preview').style.background).toBe('rgb(32, 39, 34)');

    modeButtons.find(b => b.textContent.includes('跟随系统')).click();
    await flush();
    expect(localStorage.getItem('corelatex.theme')).toBe('system');
    expect(host.querySelector('.appearance-note').textContent).toContain('跟随系统');

    modeButtons.find(b => b.textContent.includes('浅色')).click();
    await flush();
    expect(document.documentElement.classList.contains('light')).toBe(true);
    expect(host.querySelector('.palette-card .palette-preview').style.background).toBe('rgb(255, 254, 250)');
  });
});
