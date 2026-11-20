<template>
  <div class="settings-page" :class="{ embedded: props.embedded }">
    <header class="settings-header">
      <el-button v-if="!props.embedded" text type="button" @click="router.back()">← 返回</el-button>
      <div>
        <h1>设置</h1>
        <p>配置 CoreAgent、外部工具与个人账户。</p>
      </div>
    </header>

    <div class="settings-layout" :style="{ '--settings-nav-width': navWidth + 'px' }">
      <nav class="settings-nav" aria-label="设置分类">
        <button v-for="item in tabs" :key="item.id" type="button" :aria-current="tab === item.id ? 'page' : undefined" :class="{ active: tab === item.id }" @click="tab = item.id">
          <span class="nav-icon" aria-hidden="true"><el-icon><component :is="item.icon" /></el-icon></span>{{ item.label }}
        </button>
      </nav>
      <div class="layout-resizer" role="separator" tabindex="0" aria-label="调整设置导航宽度" aria-orientation="vertical" :aria-valuenow="navWidth" :aria-valuemin="150" :aria-valuemax="320" title="拖动或按方向键调整面板宽度" @pointerdown="startNavDrag" @keydown="resizeNavByKey"></div>

      <main class="settings-main">
        <div v-if="loading" class="loading-state" v-loading="true">正在读取设置…</div>

        <template v-else-if="tab === 'ai'">
          <section class="section-heading">
            <h2>模型设置</h2>
            <p>可配置多个模型，在智能体面板中随时切换。密钥只保存在服务端，页面只显示掩码。</p>
          </section>

          <ModelProviderSettings :providers="form.providers" :active-model-id="form.activeModelId" @saved="loadForm" />
        </template>

        <template v-else-if="tab === 'agent'">
          <section class="section-heading">
            <h2>智能体设置</h2>
            <p>设置自动保存。</p>
          </section>
          <div class="switch-row graph-orchestration-row">
            <span><strong>多智能体协作</strong></span>
            <el-tooltip content="开启后允许按需分派独立子任务；标准工作流程始终启用。" placement="top" :trigger="['hover', 'focus']" :show-after="200" :hide-after="0">
              <el-switch :model-value="form.agentConfig.graphOrchestration" aria-label="多智能体协作"
                @update:model-value="Object.assign(form.agentConfig, { graphOrchestration: $event, collaborationTier: $event ? 'full' : 'off' })" />
            </el-tooltip>
          </div>
          <SubagentSettings v-if="form.agentConfig.graphOrchestration"
            :providers="form.providers" :active-model-id="form.activeModelId"
            :model-id="form.agentConfig.subagentModelId" :reasoning-effort="form.agentConfig.subagentReasoningEffort"
            :tier="form.agentConfig.collaborationTier" :max-concurrency="form.agentConfig.maxModelConcurrency"
            @change="Object.assign(form.agentConfig, $event)" />
          <div class="switch-row">
            <span><strong>任务提醒声音</strong><small>任务需要你回答问题或成功完成时播放一次轻柔铃声。同一问题、历史记录和重连回放不会重复提醒。</small></span>
            <div class="sound-controls"><el-button size="small" type="button" @click="previewSound">试听</el-button><el-switch v-model="form.agentConfig.completionSound" aria-label="任务提醒声音" /></div>
          </div>
          <div class="switch-row">
            <span><strong>中文注释支持</strong><small>添加忠实对应英文正文的完整中文译注，保留数字、条件、否定、引用和公式；修改正文时同步更新译注。</small></span>
            <el-switch v-model="form.chineseSupport" aria-label="中文注释支持" />
          </div>
          <div class="switch-row">
            <span><strong>允许运行工作区脚本</strong><small>关闭后，Agent 无法调用 run_in_workspace。</small></span>
            <el-switch v-model="form.agentConfig.allowRunScripts" />
          </div>
          <div class="switch-row">
            <span><strong>允许联网</strong><small>关闭后，Agent 无法使用 web_search / web_fetch 联网查询资料。</small></span>
            <el-switch v-model="form.agentConfig.allowWebAccess" />
          </div>
          <div class="switch-row">
            <span><strong>修改需确认后应用</strong><small>开启后，Agent 的文件修改先作为待确认变更集，手动「应用」后才写入磁盘。</small></span>
            <el-switch v-model="form.agentConfig.confirmBeforeApply" />
          </div>
        </template>

        <template v-else-if="tab === 'appearance'">
          <section class="section-heading">
            <h2>外观</h2>
            <p>选择界面模式与配色，偏好保存在当前浏览器。每套配色都适配浅色与深色，切换模式时自动同步。</p>
          </section>
          <div class="appearance-block">
            <h3>界面模式</h3>
            <div class="mode-segment" role="radiogroup" aria-label="界面模式">
              <button v-for="m in modeOptions" :key="m.id" type="button" role="radio" :aria-checked="appearance.pref === m.id" :class="{ active: appearance.pref === m.id }" @click="chooseMode(m.id)">
                <el-icon :size="14"><component :is="m.icon" /></el-icon>{{ m.label }}
              </button>
            </div>
          </div>
          <div class="appearance-block">
            <h3>配色</h3>
            <div class="palette-grid">
              <button v-for="p in palettes" :key="p.id" type="button" class="palette-card" :class="{ active: appearance.palette === p.id }" :aria-pressed="appearance.palette === p.id" @click="choosePalette(p.id)">
                <span class="palette-preview" :style="previewStyle(p)" aria-hidden="true">
                  <span class="pp-bar"><i class="pp-dot"></i><i class="pp-dot"></i><i class="pp-dot"></i></span>
                  <span class="pp-body">
                    <span class="pp-line pp-accent"></span>
                    <span class="pp-line"></span>
                    <span class="pp-line short"></span>
                    <span class="pp-chip"></span>
                  </span>
                </span>
                <span class="palette-meta"><strong>{{ p.name }}</strong><small>{{ p.hint }}</small></span>
                <span class="palette-modes" aria-hidden="true"><i :style="{ background: p.swatch.light.accent }" title="浅色"></i><i :style="{ background: p.swatch.dark.accent }" title="深色"></i></span>
                <span v-if="appearance.palette === p.id" class="palette-check" aria-hidden="true">✓</span>
              </button>
            </div>
            <p class="appearance-note">当前：{{ modeLabels[appearance.pref] }}（{{ appearance.mode === 'dark' ? '深色' : '浅色' }}）· {{ currentPaletteName }}。预览随当前模式实时变化。</p>
          </div>
        </template>

        <template v-else-if="tab === 'mcp'">
          <section class="section-heading">
            <h2>MCP 服务器</h2>
            <p>使用 stdio 服务器扩展 Agent 工具。命令与环境变量只保存在当前账户。</p>
          </section>
          <el-empty v-if="!mcpServers.length" description="尚未配置 MCP 服务器。" :image-size="60" />
          <el-card v-for="(server, index) in mcpServers" :key="server.id" class="mcp-card" shadow="never">
            <div class="mcp-card-header">
              <strong>{{ server.name || '未命名服务器' }}</strong>
              <el-button text type="danger" size="small" @click="removeMcp(index)">删除</el-button>
            </div>
            <el-form label-position="top" class="form-grid compact" @submit.prevent>
              <el-form-item label="名称"><el-input v-model.trim="server.name" placeholder="filesystem" /></el-form-item>
              <el-form-item label="启动命令"><el-input v-model.trim="server.command" placeholder="npx" /></el-form-item>
              <el-form-item label="参数（每行一个）" class="span-2">
                <el-input v-model="server.argsText" type="textarea" :rows="3" placeholder="-y&#10;@modelcontextprotocol/server-filesystem" />
              </el-form-item>
              <el-form-item label="环境变量（KEY=VALUE，每行一个）" class="span-2">
                <el-input v-model="server.envText" type="textarea" :rows="3" placeholder="ROOT=/workspace" />
              </el-form-item>
            </el-form>
          </el-card>
          <div class="inline-actions">
            <el-button @click="addMcp">添加服务器</el-button>
            <el-button :loading="mcpTesting" :disabled="dirty" @click="testMcp">{{ dirty ? '先保存设置' : (mcpTesting ? '连接中…' : '测试 MCP 连接') }}</el-button>
            <span v-if="mcpResult" :class="['test-result', mcpResult.ok ? 'ok' : 'error']">{{ mcpResult.message }}</span>
          </div>
          <div v-if="agent.mcpTools?.length" class="tool-list">
            <strong>发现工具 {{ agent.mcpTools.length }} 个</strong>
            <el-tag v-for="tool in agent.mcpTools" :key="`${tool.server}:${tool.name}`" size="small" type="info" effect="plain">
              {{ tool.server }} / {{ tool.name }}
            </el-tag>
          </div>
        </template>

        <template v-else-if="tab === 'skills'">
          <section class="section-heading">
            <h2>Skills</h2>
            <p>导入包含 SKILL.md 的 ZIP 或本地目录，自动识别任意层级嵌套下的技能；停用的技能不会出现在 Agent 的可用技能清单中。</p>
          </section>
          <div class="import-row">
            <input ref="skillFile" type="file" accept=".zip,application/zip" hidden @change="importZip">
            <el-button :loading="skillImporting" @click="skillFile?.click()">{{ skillImporting ? '导入中…' : '导入 ZIP' }}</el-button>
            <input ref="skillDirInput" type="file" webkitdirectory directory hidden multiple @change="importDirFiles">
            <el-button :loading="skillDirImporting" @click="skillDirInput?.click()">{{ skillDirImporting ? '导入中…' : '导入目录' }}</el-button>
            <div class="grow"></div>
          </div>
          <div v-if="skillSelection.length" class="inline-actions">
            <span class="muted" style="font-size: 12px">已选 {{ skillSelection.length }} 个</span>
            <el-button size="small" @click="batchSkillAction('enable')">批量启用</el-button>
            <el-button size="small" @click="batchSkillAction('disable')">批量停用</el-button>
            <el-button size="small" type="danger" plain @click="batchSkillAction('delete')">批量删除</el-button>
          </div>
          <el-table
            :data="pagedSkills"
            class="skill-table"
            empty-text="尚未安装 Skill。"
            @selection-change="(rows) => (skillSelection = rows)"
          >
            <el-table-column type="selection" width="42" />
            <el-table-column prop="name" label="名称" min-width="140">
              <template #default="{ row }"><strong>{{ row.name }}</strong></template>
            </el-table-column>
            <el-table-column label="描述" min-width="200">
              <template #default="{ row }"><span class="muted">{{ row.description || '无描述' }}</span></template>
            </el-table-column>
            <el-table-column label="启用" width="90">
              <template #default="{ row }">
                <el-switch :model-value="row.enabled" @change="(v) => setSkillEnabled(row, v)" />
              </template>
            </el-table-column>
            <el-table-column label="操作" width="120" align="right">
              <template #default="{ row }">
                <el-button text size="small" @click="viewSkill(row)">查看</el-button>
                <el-button text type="danger" size="small" @click="deleteSkill(row.name)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
          <el-pagination
            v-if="agent.skills.length > skillPageSize"
            v-model:current-page="skillPage"
            :page-size="skillPageSize"
            layout="prev, pager, next, total"
            :total="agent.skills.length"
            class="skill-pagination"
          />

          <!-- 查看技能内容弹窗 -->
          <el-dialog v-model="skillContentVisible" :title="`查看技能：${skillContentName}`" width="640px">
            <el-input
              v-model="skillContent"
              type="textarea"
              :rows="18"
              readonly
              class="mono"
            />
            <template #footer>
              <el-button text @click="skillContentVisible = false">关闭</el-button>
            </template>
          </el-dialog>
        </template>

        <template v-else-if="tab === 'account'">
          <section class="section-heading"><h2>账号与安全</h2><p>{{ auth.user?.username || '当前账户' }} · 本地部署账户</p></section>

          <el-form label-position="top" class="form-grid compact" @submit.prevent>
            <el-form-item label="用户名">
              <el-input :model-value="auth.user?.username || ''" disabled />
            </el-form-item>
            <el-form-item label="昵称">
              <div class="readonly-field">
                <span>{{ auth.user?.displayName || '未设置' }}</span>
                <el-button text type="primary" size="small" @click="openProfileDialog">修改</el-button>
              </div>
            </el-form-item>
          </el-form>

          <el-form label-position="top" class="form-grid compact" @submit.prevent>
            <el-form-item label="密码">
              <div class="readonly-field">
                <span class="muted">········</span>
                <el-button text type="primary" size="small" @click="openPasswordDialog">修改密码</el-button>
              </div>
            </el-form-item>
          </el-form>

          <div class="account-actions" style="margin-top: 28px">
            <el-button v-if="auth.isAdmin" @click="embedded ? $emit('navigate', 'admin') : router.push('/admin')">用户管理</el-button>
            <el-button type="danger" @click="logout">退出登录</el-button>
          </div>

          <!-- 修改昵称弹窗 -->
          <el-dialog v-model="profileDialogVisible" title="修改昵称" width="420px">
            <el-form label-position="top" @submit.prevent>
              <el-form-item label="昵称">
                <el-input v-model.trim="profileForm.displayName" maxlength="120" placeholder="显示名称" />
              </el-form-item>
            </el-form>
            <template #footer>
              <el-button type="primary" :loading="savingProfile" @click="saveProfile">保存</el-button>
              <el-button text @click="profileDialogVisible = false">取消</el-button>
            </template>
          </el-dialog>

          <!-- 修改密码弹窗 -->
          <el-dialog v-model="passwordDialogVisible" title="修改密码" width="420px">
            <el-form label-position="top" @submit.prevent>
              <el-form-item label="原密码">
                <el-input v-model="pwForm.oldPassword" type="password" show-password autocomplete="current-password" />
              </el-form-item>
              <el-form-item label="新密码">
                <el-input v-model="pwForm.newPassword" type="password" show-password autocomplete="new-password" placeholder="至少 4 位" />
              </el-form-item>
              <el-form-item label="确认新密码">
                <el-input v-model="pwForm.confirm" type="password" show-password autocomplete="new-password" />
              </el-form-item>
            </el-form>
            <template #footer>
              <el-button type="primary" :loading="changingPw" @click="changePassword">保存</el-button>
              <el-button text @click="passwordDialogVisible = false">取消</el-button>
            </template>
          </el-dialog>
        </template>

        <RuntimeSettings v-else-if="tab === 'runtime' && auth.isAdmin" />

        <template v-else-if="tab === 'system' && auth.isAdmin">
          <section class="section-heading">
            <h2>系统设置</h2>
            <p>注册开关与新用户默认配额为全局策略。修改默认配额会同步应用到所有未单独定制配额的用户；已在「用户管理 → 编辑配额」中单独设置过的用户不受影响。</p>
          </section>
          <el-form label-position="top" @submit.prevent>
            <template v-if="auth.isAdmin">
              <el-form-item label="允许新用户注册">
                <el-switch v-model="sysForm.allowRegistration" />
              </el-form-item>
              <el-form-item label="新用户默认空间（MB）">
                <el-input-number v-model="sysForm.defaultStorageMb" :min="0" :step="50" />
              </el-form-item>
              <el-form-item label="新用户默认编译时长（秒/天）">
                <el-input-number v-model="sysForm.defaultCompileSeconds" :min="0" :step="30" />
              </el-form-item>
              <div class="inline-actions">
                <el-button type="primary" :loading="sysSaving" @click="saveSystemSettings">保存系统设置</el-button>
              </div>
            </template>
          </el-form>
        </template>
      </main>
    </div>
  </div>
</template>

<script setup>
import ModelProviderSettings from '../components/ModelProviderSettings.vue';
import RuntimeSettings from '../components/RuntimeSettings.vue';
import { previewCompletionSound, setCompletionSoundEnabled } from '../lib/agentCompletionSound.js';
import { computed, onMounted, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth.js';
import { setCollabUser } from '../lib/collabClient.js';
import { useAgentStore } from '../stores/agent.js';
import { useUiStore } from '../stores/ui.js';
import { api } from '../api.js';
import SubagentSettings from '../components/SubagentSettings.vue';
import { MagicStick, ChatDotSquare, Connection, Collection, User, Setting, Monitor, Brush, Sunny, Moon } from '@element-plus/icons-vue';
import { DEFAULT_CONTEXT_LENGTH, DEFAULT_PROVIDER_URLS, buildSettingsPatch, normalizeSettings, parseArgsText, parseEnvText, createSettingsId } from '../lib/settings.js';
import { PALETTES, MODE_LABELS, appearanceState, setThemePref, setPalettePref, subscribeAppearance, paletteById } from '../lib/theme.js';

const router = useRouter();
const auth = useAuthStore();
const agent = useAgentStore();
const ui = useUiStore();
const settingsSessionToken = auth.token;
const isSettingsSessionCurrent = () => auth.token === settingsSessionToken;

// 嵌入模式（项目页主区渲染）：隐藏「返回」按钮，管理面板切换改为向父级发事件
const props = defineProps({ embedded: Boolean });
const emit = defineEmits(['navigate']);

// 账号与安全：资料编辑 + 修改密码（均通过弹窗修改）
const profileForm = ref({ displayName: '' });
const pwForm = ref({ oldPassword: '', newPassword: '', confirm: '' });
const savingProfile = ref(false);
const changingPw = ref(false);
const profileDialogVisible = ref(false);
const passwordDialogVisible = ref(false);

function openProfileDialog() {
  profileForm.value.displayName = auth.user?.displayName || '';
  profileDialogVisible.value = true;
}
function openPasswordDialog() {
  pwForm.value = { oldPassword: '', newPassword: '', confirm: '' };
  passwordDialogVisible.value = true;
}

// ---------- 管理员系统设置：注册开关与默认配额 ----------
const sysForm = ref({ allowRegistration: true, defaultStorageMb: 100, defaultCompileSeconds: 300 });
const sysSaving = ref(false);

async function loadSystemSettings() {
  if (!auth.isAdmin) return;
  try {
    const s = await api.get('/api/admin/system-settings');
    sysForm.value = {
      allowRegistration: !!s.allowRegistration,
      defaultStorageMb: s.defaultStorageMb,
      defaultCompileSeconds: s.defaultCompileSeconds,
    };
  } catch { /* 非管理员或加载失败时保持默认展示 */ }
}
async function saveSystemSettings() {
  sysSaving.value = true;
  try {
    await api.put('/api/admin/system-settings', {
      allowRegistration: sysForm.value.allowRegistration,
      defaultStorageMb: sysForm.value.defaultStorageMb,
      defaultCompileSeconds: sysForm.value.defaultCompileSeconds,
    });
    ui.toast('系统设置已保存');
  } catch (e) {
    ui.error(e.message || '保存失败');
  } finally {
    sysSaving.value = false;
  }
}

async function saveProfile() {
  savingProfile.value = true;
  try {
    await api.put('/api/users/me/profile', { displayName: profileForm.value.displayName });
    await auth.fetchMe();
    setCollabUser(auth.user?.displayName || auth.user?.username);
    profileDialogVisible.value = false;
    ui.toast('资料已保存');
  } catch (e) {
    ui.error(e.message || '保存失败');
  } finally {
    savingProfile.value = false;
  }
}

async function changePassword() {
  const { oldPassword, newPassword, confirm } = pwForm.value;
  if (!oldPassword || !newPassword) return ui.error('请填写原密码和新密码');
  if (newPassword.length < 4) return ui.error('新密码至少 4 位');
  if (newPassword !== confirm) return ui.error('两次输入的新密码不一致');
  changingPw.value = true;
  try {
    await api.put('/api/users/me/password', { oldPassword, newPassword });
    pwForm.value = { oldPassword: '', newPassword: '', confirm: '' };
    passwordDialogVisible.value = false;
    ui.toast('密码已修改');
  } catch (e) {
    ui.error(e.message || '修改失败');
  } finally {
    changingPw.value = false;
  }
}
const tabs = computed(() => [
  { id: 'ai', label: '模型设置', icon: MagicStick },
  { id: 'agent', label: '智能体设置', icon: ChatDotSquare },
  { id: 'appearance', label: '外观', icon: Brush },
  { id: 'mcp', label: 'MCP 服务器', icon: Connection },
  { id: 'skills', label: 'Skills', icon: Collection },
  { id: 'account', label: '账号与安全', icon: User },
  ...(auth.isAdmin ? [
    { id: 'system', label: '系统设置', icon: Setting },
    { id: 'runtime', label: '运行环境', icon: Monitor },
  ] : []),
]);
const tab = ref('ai');
const loading = ref(true);
const saving = ref(false);
const testingId = ref('');
const mcpTesting = ref(false);
const skillImporting = ref(false);
const skillFile = ref(null);
const testResults = ref({});
const mcpResult = ref(null);
const mcpServers = ref([]);
const baseline = ref('');
const form = reactive({ provider: 'openai', baseUrl: '', model: '', apiKey: '', hasKey: false, models: [], activeModelId: '', chineseSupport: true, agentConfig: { temperature: 0.7, maxTokens: 4096, allowRunScripts: true, confirmBeforeApply: false, allowWebAccess: true, graphOrchestration: false, completionSound: true, subagentModelId: '', subagentReasoningEffort: '' } });

watch(() => form.agentConfig.completionSound, value => { if (!loading.value) setCompletionSoundEnabled(value !== false); });
async function previewSound() {
  if (!await previewCompletionSound()) ui.error('暂时无法播放提示音，请检查浏览器声音权限后重试。');
}
const dirty = computed(() => baseline.value !== JSON.stringify(snapshot()));
function snapshot() { return { ...form, agentConfig: { ...form.agentConfig }, mcpServers: mcpServers.value }; }
function notify(message) { ui.toast(message); }
function loadForm(settings) {
  const normalized = normalizeSettings(settings);
  Object.assign(form, normalized);
  mcpServers.value = normalized.mcpServers.map((s) => ({ ...s, id: createSettingsId('mcp'), argsText: s.args.join('\n'), envText: Object.entries(s.env).map(([k, v]) => `${k}=${v}`).join('\n') }));
  baseline.value = JSON.stringify(snapshot());
}
// 修改即自动保存（防抖 800ms），无需手动点击保存
let autoSaveTimer = null;
let settingsDisposed = false;
function scheduleSave() {
  clearTimeout(autoSaveTimer);
  if (!dirty.value || loading.value || saving.value || !isSettingsSessionCurrent()) return;
  if (settingsDisposed) { void save(true); return; }
  autoSaveTimer = setTimeout(() => save(true), 800);
}
watch(() => JSON.stringify(snapshot()), scheduleSave);
onBeforeUnmount(() => {
  settingsDisposed = true;
  clearTimeout(autoSaveTimer);
  if (dirty.value && !loading.value && !saving.value && isSettingsSessionCurrent()) void save(true);
});

async function save(silent = false) {
  if (loading.value || saving.value || !dirty.value || !isSettingsSessionCurrent()) return;
  clearTimeout(autoSaveTimer);
  const submitted = JSON.stringify(snapshot());
  let saved = false;
  saving.value = true;
  try {
    const patch = buildSettingsPatch(form, { includeProviders: false, mcpServers: mcpServers.value.map((s) => ({ name: s.name, command: s.command, args: parseArgsText(s.argsText), env: parseEnvText(s.envText) })) });
    const settings = await agent.saveSettings(patch);
    if (!isSettingsSessionCurrent()) return;
    // A newer toggle wins over a slow save response. Persist it next without
    // briefly restoring the older value in the UI or the sound player.
    if (JSON.stringify(snapshot()) === submitted) loadForm(settings);
    else baseline.value = submitted;
    saved = true;
    if (!silent) notify('设置已保存');
  } catch (error) { if (!settingsDisposed && isSettingsSessionCurrent()) ui.error(error.message || '保存失败'); }
  finally { saving.value = false; if (saved && dirty.value) scheduleSave(); }
}
function addMcp() { mcpServers.value.push({ id: createSettingsId('mcp'), name: '', command: '', argsText: '', envText: '' }); }
function removeMcp(index) { mcpServers.value.splice(index, 1); }
async function testMcp() {
  mcpTesting.value = true; mcpResult.value = null;
  try { const tools = await agent.testMcp(); mcpResult.value = { ok: true, message: `连接成功，发现 ${tools.length} 个工具` }; }
  catch (error) { mcpResult.value = { ok: false, message: error.message || '连接失败' }; }
  finally { mcpTesting.value = false; }
}
async function importZip(event) { const file = event.target.files?.[0]; if (!file) return; skillImporting.value = true; try { const names = await agent.importSkillZip(file); notify(`已导入 ${names.length} 个 Skill`); } catch (error) { ui.error(error.message || '导入失败'); } finally { skillImporting.value = false; event.target.value = ''; } }

// 从用户电脑选择目录（webkitdirectory）上传导入；不再支持服务器本地路径
const skillDirInput = ref(null);
const skillDirImporting = ref(false);
const skillSelection = ref([]);
const skillPage = ref(1);
const skillPageSize = 5;
const skillBusy = ref(false);
const skillContentVisible = ref(false);
const skillContentName = ref('');
const skillContent = ref('');
// 模型弹窗「更多设置」展开状态
const moreSettingsOpen = ref(false);
const pagedSkills = computed(() => agent.skills.slice((skillPage.value - 1) * skillPageSize, skillPage.value * skillPageSize));

async function importDirFiles(event) {
  const files = Array.from(event.target.files || []);
  if (!files.length) return;
  skillDirImporting.value = true;
  try {
    const fd = new FormData();
    const paths = [];
    for (const f of files) {
      fd.append('files', f, f.name);
      paths.push(f.webkitRelativePath || f.name);
    }
    fd.append('paths', JSON.stringify(paths));
    const r = await agent.importSkillFiles(fd);
    notify(`已导入 ${r.length} 个 Skill`);
  } catch (error) {
    ui.error(error.message || '导入失败');
  } finally {
    skillDirImporting.value = false;
    event.target.value = '';
  }
}

async function setSkillEnabled(row, enabled) {
  try {
    await agent.setSkillEnabled(row.name, enabled);
    row.enabled = enabled;
    notify(enabled ? `已启用 ${row.name}` : `已停用 ${row.name}`);
  } catch (e) {
    ui.error(e.message || '操作失败');
  }
}

async function batchSkillAction(action) {
  const names = skillSelection.value.map((s) => s.name);
  if (!names.length) return ui.error('请先勾选技能');
  const label = { enable: '批量启用', disable: '批量停用', delete: '批量删除' }[action];
  const ok = await ui.confirm(`将对 ${names.length} 个技能执行「${label}」，确定继续吗？`, '批量操作', { confirmText: '确定' });
  if (!ok) return;
  try {
    const r = await agent.batchSkills(names, action);
    notify(`${label}完成（${r.updated} 个）`);
    skillSelection.value = [];
  } catch (e) {
    ui.error(e.message || '批量操作失败');
  }
}

async function viewSkill(row) {
  skillContentName.value = row.name;
  skillContentVisible.value = true;
  try {
    skillContent.value = await agent.readSkillContent(row.name);
  } catch (e) {
    ui.error(e.message || '读取失败');
  }
}

async function deleteSkill(name) { try { await agent.deleteSkill(name); notify(`已删除 ${name}`); } catch (error) { ui.error(error.message || '删除失败'); } }

// 设置面板宽度：拖动分类栏与内容之间的分隔条调整（150–320px），持久化记忆
const navWidth = ref(Math.min(320, Math.max(150, Number(localStorage.getItem('corelatex.settingsNavWidth')) || 190)));
let stopNavDrag = () => {};
onBeforeUnmount(() => stopNavDrag());
function startNavDrag(e) {
  stopNavDrag();
  e.preventDefault();
  const startX = e.clientX;
  const startW = navWidth.value;
  const onMove = (ev) => {
    navWidth.value = Math.min(320, Math.max(150, startW + ev.clientX - startX));
  };
  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    localStorage.setItem('corelatex.settingsNavWidth', String(navWidth.value));
  };
  stopNavDrag = onUp;
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
}
function resizeNavByKey(e) {
  if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(e.key)) return;
  e.preventDefault();
  navWidth.value = e.key === 'Home' ? 190 : Math.min(320, Math.max(150, navWidth.value + (e.key === 'ArrowRight' ? 10 : -10)));
  localStorage.setItem('corelatex.settingsNavWidth', String(navWidth.value));
}
function logout() { auth.logout(); router.push('/login'); }

// ---------- 外观：模式 + 配色，实时生效并持久化 ----------
const palettes = PALETTES;
const modeLabels = MODE_LABELS;
const modeOptions = [
  { id: 'light', label: '浅色', icon: Sunny },
  { id: 'dark', label: '深色', icon: Moon },
  { id: 'system', label: '跟随系统', icon: Monitor },
];
const appearance = ref(appearanceState());
let unsubscribeAppearance = null;
const currentPaletteName = computed(() => paletteById(appearance.value.palette).name);
function chooseMode(id) { appearance.value = setThemePref(id); }
function choosePalette(id) { appearance.value = setPalettePref(id); }
function previewStyle(p) {
  const s = p.swatch[appearance.value.mode];
  return { background: s.surface, borderColor: `color-mix(in srgb, ${s.fg} 14%, transparent)`, '--pp-fg': s.fg, '--pp-accent': s.accent, '--pp-bg': s.bg };
}

onMounted(async () => {
  unsubscribeAppearance = subscribeAppearance(s => { appearance.value = s; });
  try { const settings = await agent.loadSettings(); loadForm(settings); await agent.loadSkills(); }
  catch (error) { ui.error(error.message || '读取设置失败'); }
  finally { loading.value = false; }
  loadSystemSettings();
});
onBeforeUnmount(() => unsubscribeAppearance?.());
</script>

<style scoped>
.sound-controls { display: flex; align-items: center; gap: 12px; flex: none; }
@container(max-width:440px) { .sound-controls { gap: 7px; } }

.settings-page{min-height:100%;padding:34px clamp(20px,4vw,56px);background:transparent;color:var(--fg);container-type:inline-size}.settings-page.embedded{padding:0}.settings-header{max-width:1280px;margin:0 auto 30px;display:flex;align-items:center;gap:16px}.settings-header h1{font-size:27px;letter-spacing:-.6px;font-weight:650;margin:0}.settings-header p{margin:8px 0 0;color:var(--fg-dim);font-size:12px;line-height:1.7}.settings-layout{max-width:1280px;width:100%;margin:auto;display:grid;grid-template-columns:var(--settings-nav-width,190px) 5px minmax(0,1fr);gap:15px}.settings-nav{display:flex;flex-direction:column;align-self:start;gap:5px;padding:8px 0}.settings-nav button{display:flex;align-items:center;text-align:left;padding:11px 14px;border:1px solid transparent;border-radius:9px;background:transparent;color:var(--fg-dim);font-size:12px;cursor:pointer}.settings-nav button:hover{background:var(--bg-hover);color:var(--fg)}.settings-nav button.active{background:var(--accent-soft);border-color:color-mix(in srgb,var(--accent) 16%,transparent);color:var(--accent);font-weight:600}.settings-nav button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}.nav-icon{display:inline-flex;align-items:center;justify-content:center;width:18px;margin-right:9px;color:var(--accent);opacity:.8}.settings-main{background:var(--surface-raised,var(--bg2));border:1px solid var(--border);border-radius:var(--radius-lg,14px);padding:28px;min-height:560px;min-width:0;box-shadow:var(--shadow-sm)}.section-heading{border-bottom:1px solid var(--border);padding-bottom:20px;margin-bottom:24px}.section-heading h2{font-size:17px;font-weight:600;margin:0 0 9px;letter-spacing:-.3px}.section-heading p{color:var(--fg-dim);font-size:12px;line-height:1.85;margin:0;overflow-wrap:anywhere}.form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 18px}.form-grid.compact{gap:0 14px}.form-grid :deep(.el-form-item){min-width:0;margin-bottom:18px}.form-grid.compact :deep(.el-form-item){margin-bottom:14px}.span-2{grid-column:1/-1}.full{width:100%}.field-hint{display:block;color:var(--fg-dim);font-size:11px;line-height:1.7;margin-top:5px}.inline-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:14px}.inline-actions .el-button{margin-left:0}.test-result{font-size:12px;overflow-wrap:anywhere}.test-result.ok{color:var(--accent)}.test-result.error{color:var(--danger)}.switch-row{display:flex;align-items:center;justify-content:space-between;gap:24px;border-bottom:1px solid var(--border);padding:21px 0;color:var(--fg)}.switch-row:last-child{border-bottom:0}.switch-row strong{display:block;font-size:13px;font-weight:550;margin-bottom:6px}.switch-row small{display:block;color:var(--fg-dim);font-size:12px;line-height:1.8;margin:0;overflow-wrap:anywhere}.switch-row .el-switch{flex:none}.mcp-card{margin-bottom:16px;border-radius:10px;background:var(--surface-muted,var(--bg))}.mcp-card-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:18px;font-size:13px;gap:12px}.tool-list{display:flex;flex-wrap:wrap;gap:7px;margin-top:22px}.tool-list strong{width:100%;color:var(--fg);font-size:12px;margin-bottom:5px}.import-row{display:flex;flex-wrap:wrap;gap:10px;margin:12px 0 20px}.import-row .el-button{margin-left:0}.skill-table{--el-table-border-color:var(--border);--el-table-header-text-color:var(--fg-dim);--el-table-row-hover-bg-color:var(--bg-hover)}.skill-pagination{margin-top:18px;justify-content:flex-end}.account-actions{display:flex;flex-wrap:wrap;gap:10px}.account-actions .el-button{margin-left:0}.readonly-field{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;min-height:34px;padding:0 12px;border:1px solid var(--border);border-radius:8px;background:var(--surface-muted,var(--bg));font-size:12px}.loading-state{padding:60px 0;text-align:center;color:var(--fg-dim);font-size:13px}.grow{flex:1}.layout-resizer{cursor:col-resize;background:transparent;border-radius:5px;touch-action:none}.layout-resizer:hover,.layout-resizer:focus-visible{background:var(--accent)}
@container(max-width:1050px){.settings-layout{grid-template-columns:1fr;gap:18px}.layout-resizer{display:none}.settings-nav{flex-direction:row;overflow:auto;gap:5px;padding:0 0 5px}.settings-nav button{white-space:nowrap;flex:none;padding:9px 12px}.settings-main{padding:24px}}
@container(max-width:600px){.settings-main{padding:18px;min-height:440px}.section-heading{padding-bottom:17px;margin-bottom:18px}.section-heading h2{font-size:16px}.form-grid{grid-template-columns:1fr}.span-2{grid-column:auto}.settings-header{margin-bottom:22px}.settings-header h1{font-size:23px}.switch-row{gap:16px}.import-row{gap:8px}.skill-pagination{justify-content:flex-start;overflow:auto}}
@media(max-width:760px){.settings-page:not(.embedded){padding:24px 16px}.settings-header{align-items:flex-start}.settings-layout{grid-template-columns:1fr;gap:16px}.layout-resizer{display:none}.settings-nav{flex-direction:row;overflow:auto;padding:0 0 5px}.settings-nav button{white-space:nowrap;flex:none;padding:9px 12px}.settings-main{padding:18px}.form-grid{grid-template-columns:1fr}.span-2{grid-column:auto}}

/* Settings use a quiet navigation rail and readable, well-separated sections. */
.settings-page { padding-top: clamp(28px, 3vw, 42px); }
.settings-header { padding-bottom: 24px; margin-bottom: 26px; border-bottom: 1px solid var(--border); }
.settings-header h1 { font-size: clamp(25px, 2.2vw, 30px); letter-spacing: -.035em; }
.settings-nav { padding: 4px 0; }
.settings-nav button { position: relative; font-weight: 500; transition: transform var(--motion-menu) var(--ease-standard), opacity var(--motion-menu) var(--ease-standard); }
.settings-nav button:hover { transform: translateX(2px); }
.settings-nav button.active { font-weight: 650; }
.settings-main { background: color-mix(in srgb, var(--surface-raised) 88%, transparent); border-color: var(--glass-edge); border-radius: 14px; box-shadow: var(--shadow-sm); }
.settings-nav button.active { background: var(--accent-soft); border-color: color-mix(in srgb, var(--accent) 10%, transparent); color: var(--accent-hover); }
.settings-nav button.active .nav-icon { color: var(--accent); opacity: 1; }
.nav-icon { color: var(--fg-dim); }
.section-heading { padding-bottom: 22px; margin-bottom: 26px; border-bottom-color: color-mix(in srgb, var(--border) 80%, transparent); }
.section-heading h2 { font-size: 19px; letter-spacing: -.025em; }
.section-heading p { max-width: 72ch; font-size: 13px; line-height: 1.75; }
.settings-main :deep(.el-divider) { border-color: var(--border); }
.settings-main :deep(.el-form-item__label) { line-height: 1.5; }
.switch-row { border-radius: 10px; }
@container(max-width:1050px) {
  .settings-nav { padding: 0 0 8px; border-bottom: 1px solid var(--border); }
}
@container(max-width:600px) {
  .settings-header { padding-bottom: 18px; margin-bottom: 20px; }
  .section-heading { padding-bottom: 18px; margin-bottom: 20px; }
  .section-heading h2 { font-size: 18px; }
}

/* Visual refinement: vector nav icons, tactile switch rows, calmer cards. */
.nav-icon { width: 20px; height: 20px; margin-right: 10px; border-radius: 6px; font-size: 15px; opacity: 1; color: var(--fg-muted); transition: color var(--motion-menu) var(--ease-standard), background-color var(--motion-menu) var(--ease-standard); }
.nav-icon .el-icon { font-size: 15px; }
.settings-nav button:hover .nav-icon { color: var(--fg); }
.settings-nav button.active .nav-icon { color: var(--accent); background: color-mix(in srgb, var(--accent) 10%, transparent); }
.settings-nav button { gap: 0; }
.switch-row { padding-inline: 12px; margin-inline: -12px; transition: background-color var(--motion-hover) var(--ease-standard); }
.switch-row:hover { background: var(--glass-inset); }
.section-heading h2 { display: flex; align-items: center; gap: 9px; }
.section-heading h2::before { content: ''; width: 4px; height: 16px; border-radius: 2px; background: linear-gradient(180deg, var(--accent), color-mix(in srgb, var(--accent) 45%, var(--bg2))); flex: none; }
.mcp-card { border-radius: 12px; }
.mcp-card-header strong { display: inline-flex; align-items: center; gap: 8px; }
.mcp-card-header strong::before { content: ''; width: 7px; height: 7px; border-radius: 50%; background: var(--accent); opacity: .55; flex: none; }
.readonly-field { border-radius: 9px; transition: border-color var(--motion-hover) var(--ease-standard); }
.readonly-field:hover { border-color: color-mix(in srgb, var(--fg-muted) 45%, var(--border)); }
.tool-list .el-tag { font-family: var(--mono); font-size: 11px; font-weight: 500; }
.settings-main { border-radius: 15px; }
@media (prefers-reduced-motion: reduce) {
  .switch-row, .nav-icon, .readonly-field { transition: none; }
}

/* ---------- 外观分区 ---------- */
.appearance-block { margin-bottom: 26px; }
.appearance-block h3 { margin: 0 0 12px; font-size: 13px; font-weight: 650; letter-spacing: -.01em; }
.mode-segment { display: inline-flex; gap: 3px; padding: 3px; border: 1px solid var(--border); border-radius: 11px; background: var(--glass-inset); }
.mode-segment button { display: inline-flex; align-items: center; gap: 7px; padding: 8px 16px; border: 0; border-radius: 8px; background: transparent; color: var(--fg-dim); font-size: 12px; font-weight: 550; }
.mode-segment button:hover { background: var(--bg-hover); color: var(--fg); }
.mode-segment button.active { background: var(--surface-raised); color: var(--accent-hover); font-weight: 650; box-shadow: var(--shadow-sm); }
.palette-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.palette-card { position: relative; display: flex; flex-direction: column; gap: 10px; padding: 10px; border: 1px solid var(--border); border-radius: 12px; background: var(--glass-inset); text-align: left; transition: border-color var(--motion-hover) var(--ease-standard), box-shadow var(--motion-hover) var(--ease-standard), transform var(--motion-hover) var(--ease-standard); }
.palette-card:hover { border-color: color-mix(in srgb, var(--accent) 34%, var(--border)); transform: translateY(-1px); }
.palette-card.active { border-color: var(--accent); box-shadow: 0 0 0 3px var(--focus-ring); }
.palette-preview { display: block; overflow: hidden; border: 1px solid; border-radius: 8px; }
.pp-bar { display: flex; gap: 3px; align-items: center; height: 16px; padding: 0 7px; background: var(--pp-bg); border-bottom: 1px solid color-mix(in srgb, var(--pp-fg) 10%, transparent); }
.pp-dot { width: 4px; height: 4px; border-radius: 50%; background: color-mix(in srgb, var(--pp-fg) 26%, transparent); }
.pp-dot:first-child { background: var(--pp-accent); }
.pp-body { display: block; padding: 8px 9px 10px; }
.pp-line { display: block; height: 3px; width: 88%; margin-bottom: 4px; border-radius: 2px; background: color-mix(in srgb, var(--pp-fg) 16%, transparent); }
.pp-line.pp-accent { width: 52%; height: 4px; background: var(--pp-accent); }
.pp-line.short { width: 60%; }
.pp-chip { display: block; width: 34px; height: 10px; margin-top: 7px; border-radius: 4px; background: color-mix(in srgb, var(--pp-accent) 18%, transparent); }
.palette-meta { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; padding-inline: 2px; }
.palette-meta strong { font-size: 12px; font-weight: 650; color: var(--fg); }
.palette-meta small { font-size: 10px; color: var(--fg-dim); }
.palette-modes { position: absolute; top: 16px; right: 16px; display: flex; gap: 4px; }
.palette-modes i { width: 9px; height: 9px; border-radius: 50%; border: 1px solid color-mix(in srgb, var(--fg) 18%, transparent); }
.palette-check { position: absolute; top: -7px; right: -7px; display: grid; place-items: center; width: 20px; height: 20px; border-radius: 50%; background: var(--accent); color: var(--on-accent); font-size: 11px; font-weight: 700; box-shadow: var(--shadow-sm); }
.appearance-note { margin: 14px 0 0; color: var(--fg-dim); font-size: 12px; line-height: 1.8; }
@container(max-width:600px) { .palette-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .mode-segment button { padding: 8px 12px; } }
@media (prefers-reduced-motion: reduce) { .palette-card, .palette-card:hover { transition: none; transform: none; } }

</style>
