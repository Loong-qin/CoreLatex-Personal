// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, nextTick } from 'vue';
import RuntimeSettings from './RuntimeSettings.vue';
const services = vi.hoisted(() => ({ auth: { token: 'admin', isAdmin: true }, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), postForm: vi.fn() } }));
vi.mock('../api.js', () => ({ api: services.api }));
vi.mock('../stores/auth.js', () => ({ useAuthStore: () => services.auth }));
let app, host, runtimes, resources, mirrors;
const flush = async () => { for (let i = 0; i < 6; i++) { await Promise.resolve(); await nextTick(); } };
const button = text => [...host.querySelectorAll('button')].find(el => el.textContent.trim() === text);
beforeEach(() => {
  vi.useFakeTimers(); vi.resetAllMocks(); services.auth.token = 'admin'; services.auth.isAdmin = true;
  runtimes = { defaultVersion: '2024', versions: [
    { version: '2024', label: 'TeX Live 2024', enabled: true, available: true, installed: true, managed: true },
    { version: '2025', label: 'TeX Live 2025', enabled: false, available: true, installed: true, managed: true },
    { version: '2026', label: 'TeX Live 2026', enabled: false, available: false, installed: false },
  ] };
  resources = { fonts: [{ family: 'Example Sans', file: '/private/font.ttf' }], jobs: [] };
  mirrors = { current: ['https://mirror.example/tex/tlnet'], historic: ['https://mirror.example/tex/{year}/tlnet-final'] };
  services.api.get.mockImplementation(async path => structuredClone(path.includes('/tex/runtimes') ? runtimes : path.endsWith('/tex-mirrors') ? mirrors : resources));
  services.api.put.mockImplementation(async (_path, config) => { mirrors = structuredClone(config); return structuredClone(mirrors); });
  services.api.post.mockResolvedValue({ job: { id: 'job' } }); services.api.patch.mockResolvedValue({}); services.api.postForm.mockResolvedValue({ job: { id: 'font-job' } });
});
afterEach(() => { app?.unmount(); host?.remove(); app = null; vi.clearAllTimers(); vi.useRealTimers(); });
async function mount() { host = document.createElement('div'); document.body.append(host); app = createApp(RuntimeSettings); app.mount(host); await flush(); }
describe('runtime administration', () => {
  it('loads availability and fonts without rendering server file paths', async () => {
    await mount(); expect(host.textContent).toContain('TeX Live 2024'); expect(host.textContent).toContain('未安装');
    expect(host.textContent).toContain('Example Sans'); expect(host.textContent).not.toContain('/private/');
    expect(host.querySelector('[aria-label="宏包目标版本"]').value).toBe('2024');
    expect([...host.querySelector('[aria-label="宏包目标版本"]').options].map(o => o.value)).toEqual(['2024']);
  });
  it('enables an installed version and submits a missing version installation', async () => {
    await mount(); button('启用').click(); await flush();
    expect(services.api.patch).toHaveBeenCalledWith('/api/admin/tex/runtimes/2025', { enabled: true });
    button('安装').click(); await flush();
    expect(services.api.post).toHaveBeenCalledWith('/api/admin/runtime-resources/tex-versions', { version: '2026' });
    expect(host.textContent).toContain('已提交安装任务');
  });
  it('submits package names as data for the selected installed version', async () => {
    await mount(); const input = host.querySelector('[aria-label="宏包名称"]'); input.value = 'booktabs, siunitx booktabs'; input.dispatchEvent(new Event('input')); await flush();
    host.querySelector('.package-form').dispatchEvent(new Event('submit', { cancelable: true })); await flush();
    expect(services.api.post).toHaveBeenCalledWith('/api/admin/runtime-resources/tex-packages', { version: '2024', packages: ['booktabs', 'siunitx'] });
    input.value = 'foo; rm'; input.dispatchEvent(new Event('input')); await flush();
    host.querySelector('.package-form').dispatchEvent(new Event('submit', { cancelable: true })); await flush();
    expect(services.api.post).toHaveBeenCalledTimes(1); expect(host.querySelector('[role="alert"]').textContent).toContain('宏包名称');
  });
  it('uploads fonts and reports queued status rather than claiming installation is already complete', async () => {
    await mount(); const input = host.querySelector('input[type="file"]');
    Object.defineProperty(input, 'files', { configurable: true, value: [new File(['font'], 'sample.ttf')] });
    input.dispatchEvent(new Event('change')); await flush();
    expect(services.api.postForm.mock.calls[0][0]).toBe('/api/admin/runtime-resources/fonts');
    expect(services.api.postForm.mock.calls[0][1].getAll('files')[0].name).toBe('sample.ttf');
    expect(host.querySelector('[role="status"]').textContent).toContain('已提交');
    Object.defineProperty(input, 'files', { configurable: true, value: [new File(['bad'], 'payload.sh')] });
    input.dispatchEvent(new Event('change')); await flush();
    expect(services.api.postForm).toHaveBeenCalledTimes(1); expect(host.querySelector('[role="alert"]').textContent).toContain('TTF');
  });
  it('refreshes queued jobs until completion and stops polling when unmounted', async () => {
    resources.jobs = [{ id: '1', type: 'tex-version', version: '2026', status: 'running' }];
    await mount(); expect(button('安装中…').disabled).toBe(true);
    resources.jobs[0].status = 'failed'; resources.jobs[0].error = '下载失败，请重试';
    await vi.advanceTimersByTimeAsync(2000); await flush();
    expect(host.textContent).toContain('下载失败，请重试');
    const calls = services.api.get.mock.calls.length; await vi.advanceTimersByTimeAsync(5000); expect(services.api.get).toHaveBeenCalledTimes(calls);
    resources.jobs[0].status = 'running'; button('刷新').click(); await flush(); app.unmount(); app = null;
    const stopped = services.api.get.mock.calls.length; await vi.advanceTimersByTimeAsync(5000); expect(services.api.get).toHaveBeenCalledTimes(stopped);
  });
  it('shows uncertain legacy jobs for inspection without blocking retry or polling indefinitely', async () => {
    resources.jobs = [{ id: 'old', type: 'tex-version', version: '2026', status: 'unknown', message: '旧版安装任务状态无法自动确认，请管理员检查后重试' }];
    await mount();
    expect(host.textContent).toContain('需检查');
    expect(host.textContent).toContain('无法自动确认');
    expect(button('安装').disabled).toBe(false);
    const calls = services.api.get.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000); expect(services.api.get).toHaveBeenCalledTimes(calls);
    button('安装').click(); await flush();
    expect(services.api.post).toHaveBeenCalledWith('/api/admin/runtime-resources/tex-versions', { version: '2026' });
  });
  it('does not fetch or mutate resources for a non-admin user', async () => {
    services.auth.isAdmin = false; await mount(); expect(host.textContent).toBe(''); expect(services.api.get).not.toHaveBeenCalled();
  });
  it('shows the real installation error and allows retry', async () => {
    services.api.post.mockRejectedValueOnce(new Error('该版本正在使用，稍后重试')); await mount();
    button('安装').click(); await flush(); expect(host.querySelector('[role="alert"]').textContent).toContain('正在使用');
    expect(button('安装').disabled).toBe(false);
  });
});


describe('runtime administration availability and font families', () => {
  it('excludes non-managed system installations from package targets and explains the empty state', async () => {
    runtimes.versions = [{ version: 'system', label: '系统 TeX Live 2023', available: true, installed: true, enabled: true, managed: false }];
    await mount();
    const select = host.querySelector('[aria-label="宏包目标版本"]');
    expect(select.options).toHaveLength(0); expect(select.disabled).toBe(true);
    expect(host.textContent).toContain('请先安装并启用受管 TeX Live 版本');
    const input = host.querySelector('[aria-label="宏包名称"]'); input.value = 'booktabs'; input.dispatchEvent(new Event('input')); await flush();
    host.querySelector('.package-form').dispatchEvent(new Event('submit', { cancelable: true })); await flush();
    expect(services.api.post).not.toHaveBeenCalled(); expect(button('安装宏包').disabled).toBe(true);
  });
  it('shows one font family per name while retaining searches for source styles', async () => {
    resources.fonts = [{ family: 'Example Sans', style: 'Regular' }, { family: 'Example Sans', style: 'Bold' }, { family: 'Example Serif', style: 'Italic' }];
    await mount(); expect(host.querySelector('.font-search').textContent).toContain('2 个字体家族');
    expect([...host.querySelectorAll('.font-list > span')].map(span => span.textContent)).toEqual(['Example Sans', 'Example Serif']);
    const query = host.querySelector('[aria-label="搜索已安装字体"]'); query.value = 'Bold'; query.dispatchEvent(new Event('input')); await flush();
    expect([...host.querySelectorAll('.font-list > span')].map(span => span.textContent)).toEqual(['Example Sans']);
  });
  it('treats a not-yet-installed runtime as a normal state and retains genuine mismatch diagnostics', async () => {
    runtimes.versions[2].error = '编译器不存在、不可执行或无法启动';
    await mount(); expect(host.textContent).toContain('未安装'); expect(host.textContent).not.toContain('编译器不存在');
    expect(host.textContent).toContain('持久化数据卷');
    runtimes.versions[2].detectedVersion = '2023'; runtimes.versions[2].error = '目录实际是 TeX Live 2023，与所选版本不符';
    button('刷新').click(); await flush(); expect(host.textContent).toContain('与所选版本不符');
  });
});


describe('existing mounted TeX Live installations', () => {
  it('checks and enables an existing absolute compiler directory', async () => {
    await mount();
    const input = host.querySelector('#tex-bin-2024'); input.value = '/mounted/texlive/2024/bin/x86_64-linux'; input.dispatchEvent(new Event('input')); await flush();
    input.closest('form').dispatchEvent(new Event('submit', { cancelable: true })); await flush();
    expect(services.api.patch).toHaveBeenCalledWith('/api/admin/tex/runtimes/2024', { binDir: '/mounted/texlive/2024/bin/x86_64-linux', enabled: true });
    expect(host.querySelector('[role="status"]').textContent).toContain('检测通过');
    expect(host.textContent).toContain('持久化挂载'); expect(button('安装')).toBeTruthy();
  });
  it('rejects a relative directory and keeps server validation errors visible for retry', async () => {
    await mount(); const input = host.querySelector('#tex-bin-2024');
    input.value = 'relative/bin'; input.dispatchEvent(new Event('input')); await flush();
    input.closest('form').dispatchEvent(new Event('submit', { cancelable: true })); await flush();
    expect(services.api.patch).not.toHaveBeenCalled(); expect(host.querySelector('[role="alert"]').textContent).toContain('绝对路径');
    services.api.patch.mockRejectedValueOnce(new Error('目录实际是 TeX Live 2023，与所选版本不符'));
    input.value = '/mounted/wrong/bin'; input.dispatchEvent(new Event('input')); await flush();
    input.closest('form').dispatchEvent(new Event('submit', { cancelable: true })); await flush();
    expect(host.querySelector('[role="alert"]').textContent).toContain('与所选版本不符');
    expect(input.value).toBe('/mounted/wrong/bin'); expect(input.disabled).toBe(false);
  });
});

describe('ordered TeX mirror settings', () => {
  it('loads both lists and saves multiple mirrors in order without losing pending edits during polling', async () => {
    resources.jobs = [{ id: 'one', type: 'tex-version', version: '2026', status: 'running' }];
    await mount();
    const current = host.querySelector('#tex-mirrors-current'), historic = host.querySelector('#tex-mirrors-historic');
    expect(current.value).toBe('https://mirror.example/tex/tlnet');
    expect(historic.value).toContain('/{year}/');
    current.value = 'https://first.example/tlnet\nhttps://second.example/tlnet';
    current.dispatchEvent(new Event('input')); await flush();
    mirrors.current = ['https://remote.example/tlnet'];
    await vi.advanceTimersByTimeAsync(2000); await flush();
    expect(current.value).toContain('https://first.example');
    expect(current.value).toContain('https://second.example');
    historic.value = 'https://archive.example/tex/{year}/tlnet-final';
    historic.dispatchEvent(new Event('input')); await flush();
    host.querySelector('.mirror-form').dispatchEvent(new Event('submit', { cancelable: true })); await flush();
    expect(services.api.put).toHaveBeenCalledWith('/api/admin/runtime-resources/tex-mirrors', {
      current: ['https://first.example/tlnet', 'https://second.example/tlnet'],
      historic: ['https://archive.example/tex/{year}/tlnet-final'],
    });
    expect(host.querySelector('[role="status"]').textContent).toContain('已保存');
    expect(button('保存镜像配置').disabled).toBe(true);
    button('刷新').click(); await flush();
    expect(current.value).toContain('https://first.example');
    current.value = ''; current.dispatchEvent(new Event('input')); await flush();
    host.querySelector('.mirror-form').dispatchEvent(new Event('submit', { cancelable: true })); await flush();
    expect(host.textContent).toContain('各需填写 1 至 5 个');
    expect(host.querySelector('[role="status"]')).toBeNull();
  });
  it('rejects empty lists and preserves input when the server rejects an invalid URL', async () => {
    await mount();
    const current = host.querySelector('#tex-mirrors-current'), historic = host.querySelector('#tex-mirrors-historic');
    current.value = ''; current.dispatchEvent(new Event('input')); await flush();
    host.querySelector('.mirror-form').dispatchEvent(new Event('submit', { cancelable: true })); await flush();
    expect(services.api.put).not.toHaveBeenCalled(); expect(host.textContent).toContain('各需填写 1 至 5 个');
    current.value = 'http://bad.example/tlnet'; current.dispatchEvent(new Event('input')); await flush();
    services.api.put.mockRejectedValueOnce(new Error('镜像地址必须使用 HTTPS'));
    host.querySelector('.mirror-form').dispatchEvent(new Event('submit', { cancelable: true })); await flush();
    expect(host.querySelector('[role="alert"]').textContent).toContain('必须使用 HTTPS');
    expect(current.value).toBe('http://bad.example/tlnet'); expect(historic.value).toContain('{year}');
    expect(button('保存镜像配置').disabled).toBe(false);
  });
  it('keeps version management usable if mirror settings cannot be loaded', async () => {
    services.api.get.mockImplementation(async path => {
      if (path.endsWith('/tex-mirrors')) throw new Error('无法读取');
      return structuredClone(path.includes('/tex/runtimes') ? runtimes : resources);
    });
    await mount();
    expect(host.textContent).toContain('镜像配置读取失败');
    expect(host.querySelector('#tex-mirrors-current').disabled).toBe(true);
    expect(button('安装').disabled).toBe(false);
    button('安装').click(); await flush();
    expect(services.api.post).toHaveBeenCalledWith('/api/admin/runtime-resources/tex-versions', { version: '2026' });
  });
  it('offers a 2022 installation and presents concise diagnostics while preserving details', async () => {
    runtimes.versions = [{ version: '2022', label: 'TeX Live 2022', enabled: false, available: false, installed: false }];
    resources.jobs = [{ id: 'failed-2022', type: 'tex-version', version: '2022', status: 'failed', error: 'install-tl: mkdir(/usr/local/texlive/) failed: Permission denied at profile' }];
    await mount();
    expect(host.textContent).toContain('安装目录没有写入权限');
    expect(host.querySelector('.job-details').textContent).toContain('Permission denied');
    button('安装').click(); await flush();
    expect(services.api.post).toHaveBeenCalledWith('/api/admin/runtime-resources/tex-versions', { version: '2022' });
  });
});
