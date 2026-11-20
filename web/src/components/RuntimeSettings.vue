<script setup>
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref } from 'vue';
import { api } from '../api.js';
import { useAuthStore } from '../stores/auth.js';

const auth = useAuthStore();
const token = auth.token;
const versions = ref([]);
const defaultVersion = ref('2024');
const fonts = ref([]);
const jobs = ref([]);
const loading = ref(false);
const error = ref('');
const message = ref('');
const busy = ref('');
const runtimePaths = ref({});
const currentMirrors = ref('');
const historicMirrors = ref('');
const mirrorLoaded = ref(false);
const mirrorDirty = ref(false);
const mirrorError = ref('');
const mirrorFetchError = ref('');
const packageVersion = ref('2024');
const packageText = ref('');
const fontQuery = ref('');
const fontInput = ref(null);
let disposed = false;
let active = true;
let requestId = 0;
let refreshTimer;
const current = () => !disposed && active && auth.isAdmin && auth.token === token;
const packageVersions = computed(() => versions.value.filter(version => version.available && version.enabled && version.managed));
const fontFamilies = computed(() => {
  const families = new Map();
  for (const font of fonts.value) {
    const name = fontName(font).trim();
    const key = name.toLocaleLowerCase();
    const family = families.get(key) || { name, search: [] };
    family.search.push(name, typeof font === 'object' ? font.style || '' : '');
    families.set(key, family);
  }
  return [...families.values()];
});
const filteredFonts = computed(() => {
  const query = fontQuery.value.trim().toLocaleLowerCase();
  return fontFamilies.value.filter(font => font.search.join(' ').toLocaleLowerCase().includes(query));
});
const pendingJobs = computed(() => jobs.value.some(job => ['queued', 'running'].includes(job.status)));
function fontName(font) { return typeof font === 'string' ? font : font.family || font.name || font.filename || '未命名字体'; }
function isInstalling(version) { return jobs.value.some(job => job.version === version.version && job.type === 'tex-version' && ['queued', 'running'].includes(job.status)); }
function statusText(version) {
  if (isInstalling(version)) return '安装中';
  if (!version.available) return version.installed ? '暂不可用' : '未安装';
  return version.enabled ? '已启用' : '已安装 · 未启用';
}
function jobName(job) {
  if (job.type === 'tex-packages') return `TeX Live ${job.version} · ${(job.packages || []).join(', ')}`;
  if (job.type === 'fonts') return '系统字体';
  return `TeX Live ${job.version || ''}`;
}
const jobStatus = status => ({ queued: '等待安装', running: '安装中', succeeded: '安装完成', success: '安装完成', failed: '安装失败', unknown: '需检查' }[status] || status);
function jobMessage(job) {
  if (job.status !== 'failed' || !job.error) return job.message || jobStatus(job.status);
  if (/permission denied|权限不足/i.test(job.error)) return '安装目录没有写入权限，请检查数据卷的权限。';
  if (/network|timed?\s*out|timeout|econn|enotfound|下载失败|HTTP [45]\d\d/i.test(job.error)) return '下载失败，请检查镜像地址和服务器网络后重试。';
  return job.error.length > 220 ? job.error.slice(0, 220) + '…' : job.error;
}
function updateMirrors(config) {
  currentMirrors.value = config.current.join('\n');
  historicMirrors.value = config.historic.join('\n');
  mirrorLoaded.value = true;
}
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  if (current() && pendingJobs.value) refreshTimer = setTimeout(() => load(false), 2000);
}
async function load(showLoading = true) {
  if (!current()) return;
  const id = ++requestId;
  if (showLoading) loading.value = true;
  try {
    const [runtime, resources, mirrorResult] = await Promise.all([
      api.get('/api/admin/tex/runtimes'), api.get('/api/admin/runtime-resources'),
      api.get('/api/admin/runtime-resources/tex-mirrors').then(value => ({ value }), error => ({ error })),
    ]);
    if (!current() || id !== requestId) return;
    versions.value = runtime.versions || [];
    for (const version of versions.value) {
      if (!(version.version in runtimePaths.value)) runtimePaths.value[version.version] = version.binDir || '';
    }
    defaultVersion.value = runtime.defaultVersion || '2024';
    fonts.value = resources.fonts || [];
    jobs.value = [...(runtime.jobs || []), ...(resources.jobs || [])];
    if (mirrorResult.error) {
      mirrorFetchError.value = '镜像配置读取失败：' + (mirrorResult.error.message || '请重试');
    } else if (Array.isArray(mirrorResult.value?.current) && Array.isArray(mirrorResult.value?.historic)) {
      mirrorFetchError.value = '';
      if (!mirrorDirty.value) updateMirrors(mirrorResult.value);
    } else {
      mirrorFetchError.value = '镜像配置读取失败：服务器返回的数据格式无效';
    }
    error.value = resources.fontError ? '字体列表读取失败：' + resources.fontError : '';
    if (!packageVersions.value.some(version => version.version === packageVersion.value)) packageVersion.value = packageVersions.value[0]?.version || '';
  } catch (e) {
    if (current() && id === requestId) error.value = e.message || '读取运行环境失败';
  } finally {
    if (current() && id === requestId) { loading.value = false; scheduleRefresh(); }
  }
}
async function perform(key, operation, success) {
  if (!current() || busy.value) return;
  busy.value = key; error.value = ''; message.value = '';
  try {
    await operation();
    if (!current()) return;
    message.value = success;
    await load(false);
  } catch (e) {
    if (current()) {
      if (key === 'mirrors') mirrorError.value = e.message || '保存镜像失败，请重试';
      else error.value = e.message || '操作失败，请重试';
    }
  } finally { if (!disposed) busy.value = ''; }
}
function saveMirrors() {
  message.value = '';
  const currentUrls = currentMirrors.value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const historicUrls = historicMirrors.value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (!currentUrls.length || currentUrls.length > 5 || !historicUrls.length || historicUrls.length > 5) {
    mirrorError.value = '当前年度和历史年度各需填写 1 至 5 个镜像地址。';
    return;
  }
  mirrorError.value = '';
  return perform('mirrors', async () => {
    const saved = await api.put('/api/admin/runtime-resources/tex-mirrors', { current: currentUrls, historic: historicUrls });
    if (!current()) return;
    updateMirrors(saved);
    mirrorDirty.value = false;
  }, '镜像配置已保存，之后开始的安装将按顺序尝试');
}
function toggleVersion(version) {
  return perform(version.version, () => api.patch(`/api/admin/tex/runtimes/${version.version}`, { enabled: !version.enabled }), version.enabled ? '已停用该版本' : '已启用该版本');
}
function saveRuntimePath(version) {
  const binDir = (runtimePaths.value[version.version] || '').trim();
  if (!binDir.startsWith('/') || /[\r\n\0]/.test(binDir)) {
    error.value = '请输入已有 TeX Live 编译器 bin 目录的绝对路径。';
    return;
  }
  return perform(version.version, () => api.patch(`/api/admin/tex/runtimes/${version.version}`, { binDir, enabled: true }), '已有安装检测通过，版本已启用');
}
function installVersion(version) {
  return perform(version.version, () => api.post('/api/admin/runtime-resources/tex-versions', { version: version.version }), '已提交安装任务，完成后即可使用');
}
function installPackages() {
  const packages = [...new Set(packageText.value.trim().split(/[\s,，]+/).filter(Boolean))];
  if (!packages.length || !packageVersions.value.some(version => version.version === packageVersion.value)) return;
  if (packages.length > 50) { error.value = '一次最多安装 50 个宏包。'; return; }
  if (packages.some(name => !/^[a-z0-9][a-z0-9+_.-]{0,99}$/.test(name))) { error.value = '请输入宏包名称，以空格或逗号分隔。'; return; }
  return perform('packages', () => api.post('/api/admin/runtime-resources/tex-packages', { version: packageVersion.value, packages }), '宏包安装任务已提交');
}
async function uploadFonts(event) {
  const files = [...(event.target.files || [])]; event.target.value = '';
  if (!files.length) return;
  if (files.length > 12) { error.value = '每次最多上传 12 个字体文件。'; return; }
  if (files.some(file => !/\.(ttf|otf|ttc)$/i.test(file.name))) { error.value = '请选择 TTF、OTF 或 TTC 字体文件。'; return; }
  if (files.some(file => file.size > 30 * 1024 * 1024)) { error.value = '单个字体文件不能超过 30 MB。'; return; }
  const form = new FormData(); files.forEach(file => form.append('files', file));
  await perform('fonts', () => api.postForm('/api/admin/runtime-resources/fonts', form), '字体安装任务已提交，完成后供 LaTeX 与 Python 使用');
}
onMounted(() => load());
onActivated(() => { if (!active) { active = true; load(); } });
onDeactivated(() => { active = false; ++requestId; clearTimeout(refreshTimer); });
onBeforeUnmount(() => { disposed = true; ++requestId; clearTimeout(refreshTimer); });
</script>

<template>
  <div v-if="auth.isAdmin" class="runtime-settings" aria-label="运行环境管理">
    <header class="heading"><div><h2>运行环境</h2><p>管理 TeX Live、宏包与共享字体。</p></div><button class="ghost" :disabled="loading || !!busy" @click="load()">{{ loading ? '读取中…' : '刷新' }}</button></header>
    <p class="hint persistence-note">通过此处安装的 TeX Live、宏包与字体保存在持久化数据卷中，服务重启或更新后仍会保留。</p>
    <p v-if="error" class="notice error" role="alert">{{ error }}</p>
    <p v-if="message" class="notice success" role="status">{{ message }}</p>
    <section class="runtime-section mirror-section">
      <h3><svg class="section-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v10m0 0l-4-4m4 4l4-4" /><path d="M5 19h14" /></svg>下载镜像</h3>
      <p class="hint">可配置国内镜像和备用源。每行填写一个 HTTPS 地址，前一个下载失败时按顺序尝试下一个；历史版本地址须包含独立的 <code>{year}</code> 路径段。修改仅影响之后开始的安装。</p>
      <p v-if="mirrorFetchError" class="notice error" role="alert">{{ mirrorFetchError }}</p>
      <p v-if="mirrorError" class="notice error" role="alert">{{ mirrorError }}</p>
      <form class="mirror-form" @submit.prevent="saveMirrors">
        <label for="tex-mirrors-current">当前年度镜像</label>
        <textarea id="tex-mirrors-current" v-model="currentMirrors" :disabled="!mirrorLoaded || !!busy" rows="3" spellcheck="false" @input="mirrorDirty = true"></textarea>
        <label for="tex-mirrors-historic">历史年度镜像</label>
        <textarea id="tex-mirrors-historic" v-model="historicMirrors" :disabled="!mirrorLoaded || !!busy" rows="3" spellcheck="false" @input="mirrorDirty = true"></textarea>
        <div><button class="secondary" :disabled="!mirrorLoaded || !!busy || !mirrorDirty">{{ busy === 'mirrors' ? '保存中…' : '保存镜像配置' }}</button></div>
      </form>
    </section>
    <section class="runtime-section">
      <h3><svg class="section-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l9 5-9 5-9-5z" /><path d="M3 13.5l9 5 9-5" /></svg>TeX Live 版本</h3><p class="hint">新项目默认使用 2024。安装并启用其他版本后，用户即可在 PDF 面板选择。</p>
      <div v-if="!versions.length && !loading" class="empty"><svg class="empty-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l9 5-9 5-9-5z" /><path d="M3 13.5l9 5 9-5" /></svg>暂未读取到 TeX Live 版本，请刷新重试。</div>
      <div v-for="version in versions" :key="version.version" class="version-row">
        <div class="version-info">
          <strong>{{ version.label || ('TeX Live ' + version.version) }}</strong><span v-if="version.version === defaultVersion" class="badge">默认</span>
          <small :class="{ available: version.available && version.enabled }">{{ statusText(version) }}</small>
          <small v-if="version.error && (version.installed || (version.detectedVersion && version.detectedVersion !== version.version && version.version !== 'system'))" class="error">{{ version.error }}</small>
          <details v-if="version.version !== 'system'" class="existing-install">
            <summary>已有安装</summary>
            <p class="hint">填入已有 TeX Live 的 bin 目录。该目录须位于持久化挂载中，更新服务后仍可访问。</p>
            <form class="runtime-path-form" @submit.prevent="saveRuntimePath(version)">
              <label :for="'tex-bin-' + version.version">TeX Live {{ version.version }} 编译器目录</label>
              <div><input :id="'tex-bin-' + version.version" v-model="runtimePaths[version.version]" :disabled="!!busy || isInstalling(version)" placeholder="/usr/local/texlive/2024/bin/x86_64-linux" autocomplete="off" spellcheck="false" /><button class="secondary" :disabled="!!busy || isInstalling(version)">{{ busy === version.version ? '检测中…' : '保存并检测' }}</button></div>
            </form>
          </details>
        </div>
        <button v-if="!version.available && version.version !== 'system'" class="secondary" :disabled="!!busy || isInstalling(version)" @click="installVersion(version)">{{ isInstalling(version) ? '安装中…' : '安装' }}</button>
        <button v-else-if="version.available" class="secondary" :disabled="!!busy" @click="toggleVersion(version)">{{ version.enabled ? '停用' : '启用' }}</button>
      </div>
    </section>
    <section class="runtime-section">
      <h3><svg class="section-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" /><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5" /></svg>安装 LaTeX 宏包</h3><p class="hint">选择已安装并启用的受管 TeX Live 版本，填写宏包名称。安装结果会显示在下方。</p>
      <p v-if="!packageVersions.length && !loading" class="hint package-empty">请先安装并启用受管 TeX Live 版本</p>
      <form class="package-form" @submit.prevent="installPackages">
        <select v-model="packageVersion" aria-label="宏包目标版本" :disabled="!!busy || !packageVersions.length"><option v-for="version in packageVersions" :key="version.version" :value="version.version">{{ version.label || ('TeX Live ' + version.version) }}</option></select>
        <input v-model="packageText" aria-label="宏包名称" placeholder="例如：booktabs, siunitx" :disabled="!!busy" />
        <button class="primary" :disabled="!!busy || !packageText.trim() || !packageVersion">{{ busy === 'packages' ? '提交中…' : '安装宏包' }}</button>
      </form>
    </section>
    <section class="runtime-section">
      <div class="section-title"><div><h3><svg class="section-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7V5h14v2" /><path d="M12 5v14" /><path d="M9 19h6" /></svg>系统字体</h3><p class="hint">安装的字体供 XeLaTeX、LuaLaTeX 与 Python 绘图共享。</p></div><button class="secondary" :disabled="!!busy" @click="fontInput?.click()">{{ busy === 'fonts' ? '安装中…' : '安装字体' }}</button></div>
      <input ref="fontInput" type="file" accept=".ttf,.otf,.ttc" multiple hidden @change="uploadFonts" />
      <div class="font-search"><input v-model="fontQuery" aria-label="搜索已安装字体" placeholder="搜索字体名称" /><span>{{ fontFamilies.length }} 个字体家族</span></div>
      <div class="font-list"><span v-for="font in filteredFonts" :key="font.name">{{ font.name }}</span><p v-if="!filteredFonts.length" class="empty">{{ fontQuery ? '没有匹配的字体' : '尚未读取到系统字体' }}</p></div>
      <p class="hint">支持 TTF、OTF、TTC，每批最多 12 个文件，每个不超过 30 MB。</p>
    </section>
    <section v-if="jobs.length" class="runtime-section">
      <h3><svg class="section-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M8.5 6h11M8.5 12h11M8.5 18h11" /><path d="M4.5 6h.01M4.5 12h.01M4.5 18h.01" /></svg>安装记录</h3>
      <div v-for="job in jobs" :key="job.id" class="job-row">
        <div class="job-info">
          <strong>{{ jobName(job) }}</strong>
          <small :class="{ error: ['failed', 'unknown'].includes(job.status) }">{{ jobMessage(job) }}</small>
          <details v-if="job.status === 'failed' && job.error && jobMessage(job) !== job.error" class="job-details">
            <summary>查看详细错误</summary>
            <small class="error">{{ job.error }}</small>
          </details>
        </div>
        <span class="badge">{{ jobStatus(job.status) }}</span>
      </div>
    </section>
  </div>
</template>

<style scoped>
.runtime-settings { max-width: 940px; color: var(--fg); }
.heading, .section-title { display: flex; justify-content: space-between; align-items: flex-start; gap: 20px; }
h2 { font-size: 23px; font-weight: 600; margin: 0 0 8px; letter-spacing: -.5px; }
h3 { font-size: 15px; font-weight: 600; margin: 0 0 8px; }
.heading p, .hint { color: var(--fg-muted, var(--fg-dim)); font-size: 12px; line-height: 1.65; margin: 0 0 16px; }
.runtime-section { padding: 25px 0; border-bottom: 1px solid var(--border); }
.runtime-section:last-child { border-bottom: 0; }
.version-row, .job-row { display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 12px 0; }
.version-info { flex: 1; min-width: 0; }
.existing-install { margin-top: 8px; max-width: 650px; }
.existing-install summary { font-size: 11px; color: var(--fg-dim); cursor: pointer; width: fit-content; }
.existing-install .hint { margin: 12px 0 9px; }
.runtime-path-form label { display: block; font-size: 11px; color: var(--fg-dim); margin-bottom: 6px; }
.runtime-path-form > div { display: flex; gap: 7px; flex-wrap: wrap; }
.runtime-path-form input { flex: 1; min-width: 140px; font-family: monospace; }
.version-row + .version-row, .job-row + .job-row { border-top: 1px solid var(--border); }
.version-row strong, .job-row strong { font-size: 13px; font-weight: 500; }
small { display: block; color: var(--fg-dim); margin-top: 5px; line-height: 1.6; overflow-wrap: anywhere; }
.available, .success { color: var(--accent); }
.error { color: var(--danger, #b83c40); }
.notice { padding: 12px 14px; background: var(--bg3); border-radius: 7px; font-size: 13px; overflow-wrap: anywhere; }
.badge { padding: 3px 7px; margin-left: 9px; font-size: 11px; border-radius: 5px; background: var(--bg3); color: var(--fg-dim); white-space: nowrap; }
.package-form { display: flex; gap: 8px; flex-wrap: wrap; }
.package-form input { flex: 1; min-width: 160px; }
input, select, textarea { background: var(--bg); border: 1px solid var(--border); border-radius: 6px; color: var(--fg); padding: 9px 11px; font: inherit; font-size: 12px; }
.mirror-form { display: grid; gap: 8px; max-width: 750px; }
.mirror-form label { margin-top: 4px; font-size: 12px; color: var(--fg-dim); }
.mirror-form textarea { width: 100%; resize: vertical; line-height: 1.6; font-family: monospace; }
.mirror-form button { margin-top: 4px; }
.job-info { flex: 1; min-width: 0; }
.job-details { margin-top: 8px; }
.job-details summary { color: var(--fg-dim); cursor: pointer; font-size: 11px; }
button { font-size: 12px; border-radius: 6px; padding: 8px 12px; flex: none; }
.secondary { background: var(--bg); border: 1px solid var(--border); color: var(--fg); }
.font-search { display: flex; align-items: center; gap: 12px; }
.font-search input { flex: 1; min-width: 0; }.font-search span { font-size: 11px; color: var(--fg-dim); white-space: nowrap; }
.font-list { display: flex; flex-wrap: wrap; align-content: start; gap: 7px; max-height: 190px; overflow: auto; padding: 15px 0; }
.font-list > span { font-size: 12px; padding: 5px 8px; border-radius: 4px; background: var(--bg3); overflow-wrap: anywhere; }
.empty { font-size: 12px; color: var(--fg-dim); margin: 10px 0; }
@media(max-width: 600px) { .package-form input { flex-basis: 100%; }.section-title { flex-wrap: wrap; gap: 0; }.font-search { margin-top: 12px; } }

/* Visual refinement layer: iconified sections, semantic notices, pill badges. */
.section-icon { width: 15px; height: 15px; flex: none; fill: none; stroke: var(--accent); stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
.runtime-section h3 { display: flex; align-items: center; gap: 7px; letter-spacing: -.01em; }
.heading h2 { letter-spacing: -.02em; }
.persistence-note {
  padding: 9px 12px;
  border-left: 2px solid color-mix(in srgb, var(--accent) 45%, var(--border));
  background: var(--accent-soft);
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
}
.available, .success { color: var(--success); }
.notice { border-radius: var(--radius-sm); border: 1px solid transparent; }
.notice.error { background: var(--danger-soft); border-color: color-mix(in srgb, var(--danger) 25%, transparent); }
.notice.success { background: var(--success-soft); border-color: color-mix(in srgb, var(--success) 25%, transparent); }
.badge {
  border-radius: 999px;
  padding: 3px 10px;
  background: var(--glass-inset);
  border: 1px solid var(--border);
  font-weight: 550;
}
.version-row, .job-row {
  padding-inline: 8px;
  margin-inline: -8px;
  border-radius: var(--radius-sm);
  transition: background-color var(--motion-hover) var(--ease-standard);
}
.version-row:hover, .job-row:hover { background: var(--surface-muted); }
input, select, textarea { border-radius: var(--radius-sm); }
.font-list > span {
  border-radius: 999px;
  padding: 5px 11px;
  background: var(--glass-inset);
  border: 1px solid var(--border);
  transition: border-color var(--motion-hover) var(--ease-standard);
}
.font-list > span:hover { border-color: color-mix(in srgb, var(--accent) 35%, var(--border)); }
.empty {
  padding: 14px 12px;
  border: 1px dashed color-mix(in srgb, var(--fg-muted) 40%, var(--border));
  border-radius: var(--radius-md);
  background: var(--surface-muted);
  text-align: center;
}
.font-list .empty { flex-basis: 100%; }
.empty-icon { display: block; width: 20px; height: 20px; margin: 0 auto 7px; fill: none; stroke: var(--accent-secondary); stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; opacity: .85; }
.job-info small, .version-info small { font-variant-numeric: tabular-nums; }
@media (prefers-reduced-motion: reduce) {
  .version-row, .job-row, .font-list > span { transition: none; }
}
@media (forced-colors: active) {
  .persistence-note, .notice.error, .notice.success, .empty { background: Canvas; }
  .badge, .font-list > span { background: Canvas; }
}
</style>
