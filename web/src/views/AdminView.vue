<script setup>
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { api, fmtBytes, fmtSeconds } from '../api.js';
import { useUiStore } from '../stores/ui.js';
import { formatTokens } from '../lib/projectUtils.js';
import { Plus, UserFilled, Checked } from '@element-plus/icons-vue';

const router = useRouter();
const ui = useUiStore();

// 嵌入模式（项目页主区渲染）：隐藏「返回」按钮
defineProps({ embedded: Boolean });

const users = ref([]);
const loading = ref(false);

// 弹窗：'create' | 'quota' | 'resetPw' | null
const modal = ref(null);
const active = ref(null);
const busy = ref(false);

// 批量选择与批量操作
const selected = ref([]);
const batchQuotaVisible = ref(false);
const batchQuotaForm = ref({ projectQuota: -1, compileSecondsQuota: -1, storageQuotaBytes: -1 });

const createForm = ref({ username: '', password: '', displayName: '' });
const quotaForm = ref({ projectQuota: -1, compileSecondsQuota: -1, storageQuotaBytes: -1 });
const newPassword = ref('');

const createVisible = computed({
  get: () => modal.value === 'create',
  set: (v) => { modal.value = v ? 'create' : null; },
});
const quotaVisible = computed({
  get: () => modal.value === 'quota',
  set: (v) => { modal.value = v ? 'quota' : null; },
});
const resetPwVisible = computed({
  get: () => modal.value === 'resetPw',
  set: (v) => { modal.value = v ? 'resetPw' : null; },
});

async function load() {
  loading.value = true;
  try {
    const u = await api.get('/api/admin/users');
    users.value = u?.users || [];
    selected.value = [];
  } catch (e) {
    ui.error(e.message || '加载管理数据失败');
  } finally {
    loading.value = false;
  }
}

onMounted(load);

// ---------- 批量操作 ----------
async function runBatch(patch, successMsg, { confirmText } = {}) {
  const ids = selected.value.map((u) => u.id);
  if (!ids.length) return ui.error('请先勾选用户');
  if (confirmText) {
    const ok = await ui.confirm(`将对 ${ids.length} 个用户执行「${confirmText}」，确定继续吗？`, '批量操作', { confirmText: '确定', type: 'warning' });
    if (!ok) return;
  }
  busy.value = true;
  try {
    const r = await api.post('/api/admin/users/batch', { userIds: ids, patch });
    ui.toast(`${successMsg}（更新 ${r.updated} 个${r.skippedAdmins ? `，跳过管理员 ${r.skippedAdmins} 个` : ''}）`);
    await load();
  } catch (e) {
    ui.error(e.message || '批量操作失败');
  } finally {
    busy.value = false;
  }
}
function openBatchQuota() {
  if (!selected.value.length) return ui.error('请先勾选用户');
  batchQuotaForm.value = { projectQuota: -1, compileSecondsQuota: -1, storageQuotaBytes: -1 };
  batchQuotaVisible.value = true;
}
function submitBatchQuota() {
  const f = batchQuotaForm.value;
  // 存储以 MB 编辑,提交换算回字节;-1(不限)原样透传
  const mb = Number(f.storageQuotaBytes);
  runBatch(
    { projectQuota: Number(f.projectQuota), compileSecondsQuota: Number(f.compileSecondsQuota), storageQuotaBytes: mb >= 0 ? mb * 1048576 : -1 },
    '批量配额已更新'
  );
  batchQuotaVisible.value = false;
}
function batchStatus(status) {
  runBatch({ status }, status === 'active' ? '批量启用完成' : '批量禁用完成', {
    confirmText: status === 'active' ? '批量启用' : '批量禁用',
  });
}
function batchResetCompile() {
  runBatch({ resetCompile: true }, '已批量补充今日编译额度，已用时长保留', { confirmText: '为所选用户各追加一份基础日额度（仅今日有效，已用时长保留）' });
}

async function runAction(fn, successMsg) {
  busy.value = true;
  try {
    await fn();
    modal.value = null;
    if (successMsg) ui.toast(successMsg);
    await load();
  } catch (e) {
    ui.error(e.message || '操作失败');
  } finally {
    busy.value = false;
  }
}

// 新建用户
function openCreate() {
  createForm.value = { username: '', password: '', displayName: '' };
  modal.value = 'create';
}
function submitCreate() {
  const f = createForm.value;
  if (!f.username.trim() || !f.password) return ui.error('请输入用户名和密码');
  runAction(
    () => api.post('/api/admin/users', {
      username: f.username.trim(),
      password: f.password,
      displayName: f.displayName.trim() || f.username.trim(),
    }),
    '用户已创建'
  );
}

// 编辑配额
function openQuota(u) {
  active.value = u;
  quotaForm.value = {
    projectQuota: u.projectQuota ?? -1,
    compileSecondsQuota: u.compileSecondsBaseQuota ?? u.compileSecondsQuota ?? -1,
    // 存储配额以 MB 展示与编辑,提交时换算回字节;-1(不限)原样透传
    storageQuotaBytes: u.storageQuotaBytes >= 0 ? Math.round(u.storageQuotaBytes / 1048576) : -1,
  };
  modal.value = 'quota';
}
function submitQuota() {
  const u = active.value;
  const mb = Number(quotaForm.value.storageQuotaBytes);
  runAction(
    () => api.patch(`/api/admin/users/${u.id}`, {
      displayName: u.displayName,
      projectQuota: Number(quotaForm.value.projectQuota),
      compileSecondsQuota: Number(quotaForm.value.compileSecondsQuota),
      storageQuotaBytes: mb >= 0 ? mb * 1048576 : -1,
    }),
    '配额已更新'
  );
}

// 重置密码
function openResetPw(u) {
  active.value = u;
  newPassword.value = '';
  modal.value = 'resetPw';
}
function submitResetPw() {
  if (!newPassword.value) return ui.error('请输入新密码');
  const u = active.value;
  runAction(
    () => api.post(`/api/admin/users/${u.id}/reset-password`, { password: newPassword.value }),
    '密码已重置'
  );
}

// 兼容旧接口名：仅今天追加一份基础日额度，保留真实用量。
function resetCompile(u) {
  runAction(() => api.post(`/api/admin/users/${u.id}/reset-compile`), '今日编译额度已补充，已用时长保留');
}

// 禁用 / 启用
function toggleStatus(u) {
  const disabled = u.status === 'disabled';
  runAction(
    () => api.patch(`/api/admin/users/${u.id}`, { status: disabled ? 'active' : 'disabled' }),
    disabled ? '已启用' : '已禁用'
  );
}

// 删除
async function openDelete(u) {
  active.value = u;
  const ok = await ui.confirm(
    `用户「${u.username}」及其所有项目将被永久删除，无法恢复。确定继续吗？`,
    '删除用户',
    { confirmText: '永久删除', type: 'error' }
  );
  if (!ok) return;
  runAction(() => api.del(`/api/admin/users/${u.id}`), '用户已删除');
}
</script>

<template>
  <div class="admin-page">
    <div class="header">
      <el-button v-if="!embedded" text @click="router.push('/')">← 返回</el-button>
      <div class="header-title">
        <span class="page-eyebrow">ADMINISTRATION</span>
        <h2><el-icon class="header-icon" aria-hidden="true"><UserFilled /></el-icon>用户管理</h2>
      </div>
      <div class="grow"></div>
      <el-button type="primary" :icon="Plus" @click="openCreate">新建用户</el-button>
    </div>

    <!-- 批量操作栏 -->
    <div v-if="selected.length" class="batch-bar">
      <el-icon class="batch-icon" aria-hidden="true"><Checked /></el-icon>
      <span class="muted">已选 {{ selected.length }} 个用户</span>
      <el-button size="small" @click="openBatchQuota">批量设置配额</el-button>
      <el-button size="small" @click="batchStatus('active')">批量启用</el-button>
      <el-button size="small" type="warning" plain @click="batchStatus('disabled')">批量禁用</el-button>
      <el-button size="small" type="warning" plain @click="batchResetCompile">批量补充今日额度</el-button>
    </div>

    <!-- 用户表（支持多选批量操作） -->
    <el-table
      v-loading="loading"
      :data="users"
      class="user-table"
      row-key="id"
      @selection-change="(rows) => (selected = rows)"
    >
      <el-table-column type="selection" width="42" />
      <el-table-column prop="username" label="用户名" min-width="120">
        <template #default="{ row }">
          <span class="user-cell">
            <span class="user-cell-avatar" aria-hidden="true">{{ String(row.displayName || row.username || '?').slice(0, 1).toUpperCase() }}</span>
            <span class="mono">{{ row.username }}</span>
          </span>
        </template>
      </el-table-column>
      <el-table-column prop="displayName" label="昵称" min-width="120" />
      <el-table-column label="角色" width="90">
        <template #default="{ row }">
          <el-tag size="small" :type="row.role === 'admin' ? 'primary' : 'info'">
            {{ row.role === 'admin' ? '管理员' : '用户' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="80">
        <template #default="{ row }">
          <el-tag size="small" :type="row.status === 'disabled' ? 'danger' : 'success'">
            {{ row.status === 'disabled' ? '禁用' : '正常' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="项目数" width="80" align="right">
        <template #default="{ row }">{{ row.projectCount ?? 0 }}</template>
      </el-table-column>
      <el-table-column label="空间" width="110">
        <template #default="{ row }">
          <span class="muted">{{ fmtBytes(row.storageBytes ?? 0) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="今日编译（已用 / 总额）" width="180">
        <template #default="{ row }">
          <span class="muted">{{ fmtSeconds(row.compileSecondsUsed ?? 0) }} / {{ fmtSeconds(row.compileSecondsQuota ?? -1) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="AI 总 Token" width="130" align="right">
        <template #default="{ row }">
          <span class="muted account-token-count">{{ formatTokens(row.aiTotalTokens) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="AI 请求" width="90" align="right">
        <template #default="{ row }">{{ row.aiRequests ?? 0 }}</template>
      </el-table-column>
      <el-table-column label="操作" width="380">
        <template #default="{ row }">
          <el-button link type="primary" size="small" :disabled="busy" @click="openQuota(row)">编辑配额</el-button>
          <el-button link type="primary" size="small" :disabled="busy" @click="openResetPw(row)">重置密码</el-button>
          <el-button link type="primary" size="small" :disabled="busy" @click="resetCompile(row)">补充今日额度</el-button>
          <template v-if="row.role !== 'admin'">
            <el-button link type="warning" size="small" :disabled="busy" @click="toggleStatus(row)">
              {{ row.status === 'disabled' ? '启用' : '禁用' }}
            </el-button>
            <el-button link type="danger" size="small" :disabled="busy" @click="openDelete(row)">删除</el-button>
          </template>
        </template>
      </el-table-column>
      <template #empty>
        <div class="empty muted"><el-icon class="empty-icon" aria-hidden="true"><UserFilled /></el-icon>暂无用户</div>
      </template>
    </el-table>

    <!-- 新建用户弹窗 -->
    <el-dialog v-model="createVisible" title="新建用户" width="420px">
      <el-form label-position="top" @submit.prevent>
        <el-form-item label="用户名">
          <el-input v-model="createForm.username" placeholder="登录用户名" />
        </el-form-item>
        <el-form-item label="密码">
          <el-input v-model="createForm.password" type="password" show-password placeholder="初始密码" />
        </el-form-item>
        <el-form-item label="昵称">
          <el-input v-model="createForm.displayName" placeholder="显示名称（可选）" @keyup.enter="submitCreate" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button type="primary" :loading="busy" @click="submitCreate">创建</el-button>
        <el-button text @click="modal = null">取消</el-button>
      </template>
    </el-dialog>

    <!-- 编辑配额弹窗 -->
    <el-dialog v-model="quotaVisible" :title="`编辑配额：${active?.username}`" width="420px">
      <el-form label-position="top" @submit.prevent>
        <el-form-item label="项目上限（-1 表示不限）">
          <el-input-number v-model="quotaForm.projectQuota" :min="-1" class="quota-input" />
        </el-form-item>
        <el-form-item label="编译时长配额（秒，-1 表示不限）">
          <el-input-number v-model="quotaForm.compileSecondsQuota" :min="-1" class="quota-input" />
        </el-form-item>
        <el-form-item label="存储配额（MB，-1 表示不限）">
          <el-input-number v-model="quotaForm.storageQuotaBytes" :min="-1" :step="1" class="quota-input" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button type="primary" :loading="busy" @click="submitQuota">保存</el-button>
        <el-button text @click="modal = null">取消</el-button>
      </template>
    </el-dialog>

    <!-- 重置密码弹窗 -->
    <el-dialog v-model="resetPwVisible" :title="`重置密码：${active?.username}`" width="420px">
      <el-form label-position="top" @submit.prevent>
        <el-form-item label="新密码">
          <el-input v-model="newPassword" type="password" show-password placeholder="新密码" @keyup.enter="submitResetPw" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button type="primary" :loading="busy" @click="submitResetPw">重置</el-button>
        <el-button text @click="modal = null">取消</el-button>
      </template>
    </el-dialog>

    <!-- 批量设置配额弹窗 -->
    <el-dialog v-model="batchQuotaVisible" :title="`批量设置配额（${selected.length} 个用户）`" width="440px">
      <el-form label-position="top" @submit.prevent>
        <el-form-item label="项目上限（-1 表示不限）">
          <el-input-number v-model="batchQuotaForm.projectQuota" :min="-1" class="quota-input" />
        </el-form-item>
        <el-form-item label="编译时长配额（秒，-1 表示不限）">
          <el-input-number v-model="batchQuotaForm.compileSecondsQuota" :min="-1" class="quota-input" />
        </el-form-item>
        <el-form-item label="存储配额（MB，-1 表示不限）">
          <el-input-number v-model="batchQuotaForm.storageQuotaBytes" :min="-1" :step="1" class="quota-input" />
        </el-form-item>
        <p class="muted" style="font-size: 12px">管理员账号会自动跳过。</p>
      </el-form>
      <template #footer>
        <el-button type="primary" :loading="busy" @click="submitBatchQuota">应用</el-button>
        <el-button text @click="batchQuotaVisible = false">取消</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.account-token-count { font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.admin-page {
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 24px clamp(16px, 3vw, 40px);
  background: transparent;
  overflow: auto;
}
.header {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-bottom: 18px;
}
.header h2 {
  margin: 0;
  font-size: 18px;
}
.stat-grid {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 14px;
  margin-bottom: 20px;
}
.stat-card {
  text-align: center;
}
.stat-value {
  font-size: 20px;
  font-weight: 700;
  margin-bottom: 4px;
}
.chart-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
  margin-bottom: 20px;
}
.chart-title {
  font-weight: 600;
  font-size: 13px;
  margin-bottom: 8px;
  color: var(--fg-dim);
}
.user-table {
  flex: 1;
  --el-table-border-color: var(--border);
  --el-table-header-text-color: var(--fg-dim);
  --el-table-row-hover-bg-color: var(--bg-hover);
}
.empty {
  text-align: center;
  padding: 60px 0;
  font-size: 13px;
}
.quota-input {
  width: 100%;
}
.sys-card {
  margin-bottom: 14px;
}
.sys-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
  gap: 0 18px;
  align-items: start;
}
.sys-grid :deep(.el-form-item) {
  margin-bottom: 14px;
}
.batch-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg2);
  flex-wrap: wrap;
}
@media (max-width: 1100px) { .stat-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
@media (max-width: 680px) { .header { flex-wrap: wrap; gap: 8px; } .chart-grid { grid-template-columns: 1fr; } .stat-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; } .sys-grid { grid-template-columns: 1fr; } .stat-value { font-size: 22px; } }

/* Administrative data is grouped by rhythm and alignment, not extra decoration. */
.admin-page { padding-top: clamp(26px, 3vw, 40px); }
.header { padding-bottom: 20px; margin-bottom: 24px; border-bottom: 1px solid var(--border); }
.header h2 { font-size: 25px; line-height: 1.25; font-weight: 650; letter-spacing: -.035em; }
.stat-grid { gap: 12px; margin-bottom: 24px; }
.stat-card { text-align: left; border-color: var(--glass-edge); background: var(--glass-bg); box-shadow: var(--glass-shadow); }
.stat-card :deep(.el-card__body) { padding: 18px 20px; }
.stat-value { margin-bottom: 6px; font-size: 25px; line-height: 1.2; font-weight: 650; letter-spacing: -.035em; font-variant-numeric: tabular-nums; }
.chart-grid { gap: 16px; margin-bottom: 24px; }
.chart-title { margin-bottom: 10px; color: var(--fg); font-size: 13px; font-weight: 650; }
.user-table { border: 1px solid var(--border); border-radius: 14px; overflow: hidden; background: var(--surface-raised); -webkit-backdrop-filter: none; backdrop-filter: none; }
.sys-card, .batch-bar { background: var(--glass-bg); border-color: var(--glass-edge); box-shadow: var(--glass-shadow); }
.batch-bar { border-radius: 11px; }
@media(max-width:680px) {
  .header { padding-bottom: 16px; }
  .header h2 { font-size: 22px; }
  .stat-card :deep(.el-card__body) { padding: 15px 16px; }
  .stat-value { font-size: 22px; }
}

/* Visual refinement: page identity, tactile batch bar, identifiable user rows. */
.page-eyebrow { display: block; font-size: 10px; color: var(--accent); font-weight: 650; letter-spacing: .18em; margin-bottom: 6px; }
.header-title { min-width: 0; }
.header h2 { display: flex; align-items: center; gap: 10px; }
.header-icon { font-size: 22px; color: var(--accent); opacity: .85; }
.batch-bar { background: var(--accent-soft); border-color: color-mix(in srgb, var(--accent) 20%, transparent); animation: batch-in var(--motion-surface) var(--ease-standard); }
.batch-icon { font-size: 15px; color: var(--accent); flex: none; }
@keyframes batch-in { from { opacity: 0; transform: translateY(-3px); } to { opacity: 1; transform: translateY(0); } }
.user-cell { display: inline-flex; align-items: center; gap: 9px; min-width: 0; }
.user-cell-avatar { display: grid; place-items: center; flex: none; width: 26px; height: 26px; border-radius: 50%; background: var(--accent-soft); border: 1px solid color-mix(in srgb, var(--accent) 14%, var(--border)); color: var(--accent-hover); font-size: 11px; font-weight: 650; }
.user-table :deep(.el-table__row) { transition: background-color var(--motion-hover) var(--ease-standard); }
.empty { display: flex; flex-direction: column; align-items: center; gap: 2px; }
.empty-icon { font-size: 34px; margin-bottom: 12px; color: color-mix(in srgb, var(--accent) 38%, var(--border)); }
@media (prefers-reduced-motion: reduce) {
  .batch-bar { animation: none; }
}
</style>
