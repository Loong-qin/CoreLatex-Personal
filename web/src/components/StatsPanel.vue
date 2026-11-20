<script setup>
// 数据统计面板：嵌入项目页主区（左侧导航「数据统计」视图）。
// 普通用户查看自己的用量；管理员可切换 全局 / 自己 / 指定用户。
// 图表复用 ECharts（UsageChart 封装）：AI 用量（缓存命中、未命中与输出堆叠柱 + 请求折线）、编译趋势（次数柱 + 时长折线）。
import { ref, computed, watch, onMounted, onActivated, onDeactivated, onBeforeUnmount } from 'vue';
import { api, fmtBytes, fmtSeconds } from '../api.js';
import { INPUT_TOKEN_METRICS, OUTPUT_TOKEN_METRIC } from '../lib/aiUsage.js';
import { formatTokens } from '../lib/projectUtils.js';
import { useAuthStore } from '../stores/auth.js';
import { useUiStore } from '../stores/ui.js';
import TokenUsageBreakdown from './TokenUsageBreakdown.vue';
import UsageChart from './UsageChart.vue';
import { toolLabel, toolDescription } from '../lib/toolMetadata.js';

const auth = useAuthStore();
const ui = useUiStore();

const mode = ref(auth.isAdmin ? 'global' : 'self'); // global | self | user
const selectedUserId = ref(null);
const days = ref(30);
const loading = ref(false);
const summary = ref(null); // GET /api/users/stats 结果
const perUser = ref([]); // 管理员：全局按用户聚合（排行表 + 指定用户下拉）

// 低饱和暖色图表与浅色工作区协调，同时保留足够的数据辨识度。
const SOFT = {
  blue: '#7f9eb5', green: '#7fa78f', gold: '#bea071', purple: '#998dac',
  palette: ['#7f9eb5', '#7fa78f', '#bea071', '#998dac', '#c28f9d', '#78a6ac', '#b5ad79', '#98a49b'],
};
const AXIS_LABEL = { fontSize: 10, color: '#758078' };
const AXIS_LINE = { lineStyle: { color: '#d7dfd7' } };
const SPLIT_LINE = { lineStyle: { color: 'rgba(104, 124, 111, 0.12)' } };
const TOKEN_METRICS = [...INPUT_TOKEN_METRICS, OUTPUT_TOKEN_METRIC];
const THEMED_TOOLTIP = {
  confine: true,
  backgroundColor: 'var(--surface-raised)',
  borderColor: 'var(--border)',
  textStyle: { color: 'var(--fg)', fontSize: 12 },
  extraCssText: 'max-width:min(280px, calc(100% - 12px));box-sizing:border-box;white-space:normal;overflow-wrap:anywhere;',
};

function readAiUsage(source, prefixed = false) {
  const read = name => source[prefixed ? `ai${name[0].toUpperCase()}${name.slice(1)}` : name];
  return {
    totalTokens: read('totalTokens') ?? 0,
    inputTokens: read('inputTokens') ?? 0,
    cacheReadTokens: read('cacheReadTokens') ?? 0,
    uncachedInputTokens: read('uncachedInputTokens') ?? 0,
    outputTokens: read('outputTokens') ?? 0,
    requests: read('requests') ?? 0,
    unknownUsageRequests: read('unknownUsageRequests') ?? 0,
    partialUsageRequests: read('partialUsageRequests') ?? 0,
  };
}
function sumUsage(total, usage) {
  for (const key of Object.keys(usage)) total[key] += usage[key];
  return total;
}
function tokenTooltipLines(usage) {
  return [
    `<strong>总 Token：${formatTokens(usage.totalTokens)}</strong>`,
    `输入 Token：${formatTokens(usage.inputTokens)}`,
    ...INPUT_TOKEN_METRICS.map(metric => `<span style="padding-inline-start:12px">${metric.label}：${formatTokens(usage[metric.key])}</span>`),
    `${OUTPUT_TOKEN_METRIC.label} Token：${formatTokens(usage.outputTokens)}`,
  ];
}
function usageCoverageNote(usage) {
  const parts = [];
  if (usage.unknownUsageRequests) parts.push(`${usage.unknownUsageRequests} 次请求未返回用量。`);
  if (usage.partialUsageRequests) parts.push(`${usage.partialUsageRequests} 次请求仅记录已确认的用量。`);
  return parts.join(' ');
}
const rangeAi = computed(() => {
  const stats = summary.value;
  if (stats?.rangeTotals) return readAiUsage(stats.rangeTotals, true);
  const rows = stats?.daily?.length ? stats.daily : stats?.hourly || [];
  return rows.reduce((total, row) => sumUsage(total, readAiUsage(row, true)), readAiUsage({}));
});
const usageNote = computed(() => usageCoverageNote(rangeAi.value));

const users = computed(() => perUser.value);
const targetName = computed(() => {
  if (mode.value === 'global') return '全部用户合计';
  const t = summary.value?.target;
  if (mode.value === 'self') return `${auth.user?.displayName || auth.user?.username || ''}（我）`;
  return t ? (t.displayName || t.username) : '';
});

const overviewMetrics = computed(() => {
  const t = summary.value?.totals;
  if (!t) return [];
  const metrics = [
    { label: '项目数', value: t.projectCount, color: SOFT.blue },
    { label: '存储空间', value: fmtBytes(t.storageBytes), color: SOFT.green },
    { label: '编译', value: `${t.compileCount} 次`, sub: `总时长 ${fmtSeconds(t.compileSeconds)}`, color: SOFT.gold },
  ];
  if (summary.value.scope === 'global') metrics.unshift({ label: '用户数', value: t.userCount, color: SOFT.purple });
  return metrics;
});

// Only the three trend charts switch to hourly points for short ranges.
const isHourly = computed(() => summary.value?.granularity === 'hour');
const trendRows = computed(() => isHourly.value ? (summary.value?.hourly || []) : (summary.value?.daily || []));
// The API returns Beijing calendar labels, not instants to convert again.
const trendAxis = computed(() => trendRows.value.map(row => {
  if (!isHourly.value) return row.day.slice(5);
  const time = String(row.time || '');
  return summary.value?.days === 1 ? time.slice(11, 16) : `${time.slice(5, 10)} ${time.slice(11, 16)}`;
}));
const rangeLabel = computed(() => summary.value?.range
  ? `${summary.value.range.start} — ${summary.value.range.end}` : '');
function trendTooltipTitle(point) {
  const row = trendRows.value[point?.dataIndex];
  const label = row ? (isHourly.value ? row.time : row.day) : point?.axisValue || '';
  return `${escapeTooltip(label)}（北京时间）`;
}
function trendTooltip(points, suffix = '') {
  const items = Array.isArray(points) ? points : [points];
  return [trendTooltipTitle(items[0]), ...items.filter(Boolean).map(point =>
    `${point.marker || ''}${escapeTooltip(point.seriesName)}：${escapeTooltip(point.value)}${suffix}`)].join('<br/>');
}

// AI 用量趋势：拆分输入后的 token 堆叠柱 + 请求数折线（右轴）
const aiChartOption = computed(() => {
  const rows = trendRows.value.map(row => readAiUsage(row, true));
  return {
    tooltip: {
      ...THEMED_TOOLTIP, trigger: 'axis', axisPointer: { type: 'shadow' },
      formatter: points => {
        const point = Array.isArray(points) ? points[0] : points;
        const usage = rows[point?.dataIndex];
        if (!usage) return '';
        return [trendTooltipTitle(point), ...tokenTooltipLines(usage), `请求数：${escapeTooltip(usage.requests)} 次`].join('<br/>');
      },
    },
    legend: {
      type: 'scroll', top: 0, left: 0, right: 0, itemWidth: 11, itemHeight: 8, itemGap: 9,
      textStyle: { fontSize: 11, color: '#758078' },
      pageIconSize: 10, pageIconColor: '#758078', pageIconInactiveColor: '#9aa49d',
      pageTextStyle: { fontSize: 10, color: '#758078' },
    },
    grid: { left: 8, right: 8, top: 32, bottom: 8, containLabel: true },
    xAxis: {
      type: 'category',
      data: trendAxis.value,
      axisLabel: AXIS_LABEL,
      axisLine: AXIS_LINE,
      axisTick: { show: false },
    },
    yAxis: [
      { type: 'value', minInterval: 1, axisLabel: { ...AXIS_LABEL, formatter: formatTokens }, splitLine: SPLIT_LINE },
      { type: 'value', minInterval: 1, axisLabel: AXIS_LABEL, splitLine: { show: false } },
    ],
    series: [
      ...TOKEN_METRICS.map(metric => ({ name: metric.label, type: 'bar', stack: 'tokens',
        data: rows.map(row => row[metric.key]), barMaxWidth: 16, itemStyle: { color: metric.color } })),
      { name: '请求数', type: 'line', yAxisIndex: 1, data: rows.map(row => row.requests), smooth: true, symbol: 'none',
        itemStyle: { color: SOFT.gold }, lineStyle: { width: 1.5 } },
    ],
  };
});

// 编译趋势：次数柱 + 时长折线（右轴）
const compileChartOption = computed(() => {
  const daily = trendRows.value;
  return {
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, confine: true, formatter: points => trendTooltip(points) },
    legend: { top: 0, itemWidth: 12, itemHeight: 8, textStyle: { fontSize: 11, color: '#758078' } },
    grid: { left: 8, right: 8, top: 32, bottom: 8, containLabel: true },
    xAxis: {
      type: 'category',
      data: trendAxis.value,
      axisLabel: AXIS_LABEL,
      axisLine: AXIS_LINE,
      axisTick: { show: false },
    },
    yAxis: [
      { type: 'value', axisLabel: { fontSize: 10, color: '#758078' }, minInterval: 1, splitLine: { show: false } },
      { type: 'value', axisLabel: { fontSize: 10, color: '#758078' }, splitLine: SPLIT_LINE },
    ],
    series: [
      { name: '编译次数', type: 'bar', data: daily.map((d) => d.compiles), barMaxWidth: 16, itemStyle: { color: SOFT.purple } },
      { name: '编译时长(秒)', type: 'line', yAxisIndex: 1, data: daily.map((d) => d.compileSeconds), smooth: true, symbol: 'none', lineStyle: { width: 1.5, color: SOFT.gold } },
    ],
  };
});

// 所有工具都可查看；中文名称与执行过程共用，英文标识用于核对。
const toolRows = computed(() => [...(summary.value?.tools || [])]
  .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
  .map(row => ({ ...row, label: toolLabel(row.name), description: toolDescription(row.name) })));
const DISTRIBUTION_PAGE_SIZE = 20;
const toolDistributionLabel = computed(() => `工具调用分布，共 ${toolRows.value.length} 种，按调用次数从高到低排列。${toolRows.value.map(row => `${row.label}：${row.count} 次`).join('；')}`);
const skillRows = computed(() => summary.value?.skills || []);
const skillDistributionLabel = computed(() => `Skill 调用分布，共 ${skillRows.value.length} 种。${skillRows.value.map(row => `技能 ${row.name}：${row.count} 次`).join('；')}`);

// API 按供应商和模型分组，模型分布按原始模型名合计。
const MODEL_PAGE_SIZE = 3;
const MODEL_PIE_RADIUS = 0.94;
const MODEL_PIE_HOVER_SIZE = 4;
const MODEL_STACKED_PIE = { height: 158, top: 54 };
const MODEL_REQUEST_PERCENT = new Intl.NumberFormat('zh-CN', { style: 'percent', maximumFractionDigits: 1 });
const modelPage = ref(1);
const modelLegend = ref(null);
const modelRows = computed(() => {
  const grouped = new Map();
  for (const source of summary.value?.models || []) {
    const key = source.model || null;
    if (!grouped.has(key)) grouped.set(key, {
      ...readAiUsage({}), id: key === null ? 'unknown' : `model:${key}`, model: key ?? '未知模型',
      providers: new Set(), hasUnattributedUsage: false,
    });
    const row = grouped.get(key);
    sumUsage(row, readAiUsage(source));
    const provider = typeof source.providerName === 'string' ? source.providerName.trim() : '';
    if (provider) row.providers.add(provider);
    else row.hasUnattributedUsage = true;
  }
  return Array.from(grouped.values())
    .sort((a, b) => b.requests - a.requests || b.totalTokens - a.totalTokens || a.model.localeCompare(b.model))
    .map((row, index) => ({
      ...row,
      providerLine: row.providers.size
        ? `${row.hasUnattributedUsage ? '已知供应商' : '供应商'}：${Array.from(row.providers).sort().join('、')}`
        : '',
      coverageNote: usageCoverageNote(row),
      color: SOFT.palette[index % SOFT.palette.length],
    }));
});
const modelPageCount = computed(() => Math.max(1, Math.ceil(modelRows.value.length / MODEL_PAGE_SIZE)));
const visibleModels = computed(() => {
  const start = (modelPage.value - 1) * MODEL_PAGE_SIZE;
  return modelRows.value.slice(start, start + MODEL_PAGE_SIZE);
});
watch(modelPageCount, count => { modelPage.value = Math.min(modelPage.value, count); });
watch(modelPage, () => { if (modelLegend.value) modelLegend.value.scrollTop = 0; }, { flush: 'post' });
const modelRequestRows = computed(() => modelRows.value.filter(row => row.requests > 0));
const modelRequestTotal = computed(() => modelRequestRows.value.reduce((total, row) => total + row.requests, 0));
const modelChartOption = computed(() => {
  const models = modelRequestRows.value;
  const total = modelRequestTotal.value;
  return {
    tooltip: {
      ...THEMED_TOOLTIP,
      trigger: 'item',
      className: 'model-request-tooltip',
      padding: [4, 7],
      transitionDuration: 0,
      position: (_point, _item, _element, _rect, { viewSize: [width, height], contentSize: [tipWidth, tipHeight] }) => {
        const top = height <= MODEL_STACKED_PIE.height ? MODEL_STACKED_PIE.top : 0;
        const plotHeight = height - top;
        const diameter = Math.min(width, plotHeight) * MODEL_PIE_RADIUS;
        const ringTop = top + (plotHeight - diameter) / 2 - MODEL_PIE_HOVER_SIZE;
        return [(width - tipWidth) / 2, Math.max(2, ringTop - tipHeight - 8)];
      },
      formatter: ({ dataIndex }) => {
        const row = models[dataIndex];
        if (!row) return '';
        const share = row.requests / total;
        const percent = share < 0.001 ? '<0.1%' : MODEL_REQUEST_PERCENT.format(share);
        return `<strong dir="auto">${escapeTooltip(row.model)}</strong>`
          + `<div class="model-request-tooltip-values"><span>${formatTokens(row.requests)} 次</span><span>${escapeTooltip(percent)}</span></div>`;
      },
    },
    series: [
      {
        type: 'pie',
        radius: ['63%', `${MODEL_PIE_RADIUS * 100}%`],
        emphasis: { scaleSize: MODEL_PIE_HOVER_SIZE },
        itemStyle: { borderRadius: 4, borderWidth: 2, borderColor: 'transparent' },
        label: { show: false },
        data: models.map(row => ({ id: row.id, name: row.model, value: row.requests, itemStyle: { color: row.color } })),
      },
    ],
    media: [
      { query: { maxHeight: MODEL_STACKED_PIE.height }, option: { series: [{ top: MODEL_STACKED_PIE.top }] } },
      { option: { series: [{ top: 0 }] } },
    ],
  };
});

// 工具 / Skill 调用趋势：短范围按小时、其他范围按天，不按名称细分
const callTrendOption = computed(() => {
  const daily = trendRows.value;
  const timeKey = isHourly.value ? 'time' : 'day';
  const sumBy = (rows) => {
    const m = new Map();
    for (const r of rows || []) m.set(r[timeKey], (m.get(r[timeKey]) || 0) + r.count);
    return m;
  };
  const tMap = sumBy(isHourly.value ? summary.value?.toolHourly : summary.value?.toolDaily);
  const sMap = sumBy(isHourly.value ? summary.value?.skillHourly : summary.value?.skillDaily);
  const toolCounts = daily.map((d) => tMap.get(d[timeKey]) || 0);
  const skillCounts = daily.map((d) => sMap.get(d[timeKey]) || 0);
  return {
    tooltip: {
      trigger: 'axis',
      confine: true,
      axisPointer: { type: 'shadow' },
      formatter: points => trendTooltip(points, ' 次'),
    },
    legend: { top: 0, textStyle: { fontSize: 10, color: '#758078' }, itemWidth: 10, itemHeight: 8 },
    grid: { left: 8, right: 8, top: 32, bottom: 8, containLabel: true },
    xAxis: { type: 'category', data: trendAxis.value, axisLabel: AXIS_LABEL, axisLine: AXIS_LINE, axisTick: { show: false } },
    yAxis: [
      // 工具调用用左轴、Skill 调用用右轴：两者量级悬殊时各自独立刻度，均清晰可读
      { type: 'value', name: '工具 · 次', nameTextStyle: { fontSize: 10, color: '#758078' }, axisLabel: AXIS_LABEL, minInterval: 1, splitLine: SPLIT_LINE },
      { type: 'value', name: 'Skill · 次', nameTextStyle: { fontSize: 10, color: '#758078' }, axisLabel: AXIS_LABEL, minInterval: 1, splitLine: { show: false } },
    ],
    series: [
      { name: '工具调用', type: 'bar', yAxisIndex: 0, data: toolCounts, barMaxWidth: 14, itemStyle: { color: SOFT.blue, borderRadius: [3, 3, 0, 0] } },
      { name: 'Skill 调用', type: 'bar', yAxisIndex: 1, data: skillCounts, barMaxWidth: 14, itemStyle: { color: SOFT.green, borderRadius: [3, 3, 0, 0] } },
    ],
  };
});
const hasCalls = computed(() => isHourly.value
  ? (summary.value?.toolHourly || []).length > 0 || (summary.value?.skillHourly || []).length > 0
  : (summary.value?.toolDaily || []).length > 0 || (summary.value?.skillDaily || []).length > 0
);

// ECharts HTML 提示必须转义动态名称、标识与用途；轴标签由 canvas 按纯文本绘制。
function escapeTooltip(value) {
  const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(value ?? '').replace(/[&<>"']/g, character => entities[character]);
}

// 工具与 Skill 共用横向排序柱图。category 保留原始唯一标识，
// 中文显示名只用于 axisLabel，避免同名标签令 tooltip 指向另一条记录。
function hBarOption(rows, { nameOf, color, tipOf }) {
  const sorted = [...rows].sort((a, b) => b.count - a.count || String(a.name).localeCompare(String(b.name)));
  const rawByName = new Map(sorted.map(row => [String(row.name), row]));
  const scrollable = sorted.length > DISTRIBUTION_PAGE_SIZE;
  const countWidth = Math.max(40, ...sorted.map(row => String(row.count).length * 6 + 14));
  const categoryLabelWidth = 112;
  const valueSpan = DISTRIBUTION_PAGE_SIZE - 1;
  const windowRange = {
    yAxisIndex: 0, startValue: 0, endValue: valueSpan, minValueSpan: valueSpan, maxValueSpan: valueSpan, filterMode: 'filter',
  };
  return {
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      confine: true,
      formatter: params => {
        const point = Array.isArray(params) ? params[0] : params;
        const name = String(point?.name ?? point?.axisValue ?? '');
        const row = rawByName.get(name);
        const content = row ? tipOf(row) : `${escapeTooltip(name)}：${escapeTooltip(point?.value)} 次`;
        return `<div style="max-width:280px;white-space:normal;overflow-wrap:anywhere">${content}</div>`;
      },
    },
    grid: { left: 8, right: countWidth + (scrollable ? 24 : 0), top: 10, bottom: 10, containLabel: true },
    xAxis: {
      type: 'value', minInterval: 1, splitNumber: 3, splitLine: SPLIT_LINE,
      axisLabel: { ...AXIS_LABEL, hideOverlap: true, showMinLabel: true, showMaxLabel: true },
    },
    yAxis: {
      type: 'category', inverse: true, data: sorted.map(row => String(row.name)),
      axisLabel: { ...AXIS_LABEL, interval: 0, width: categoryLabelWidth, overflow: 'truncate', ellipsis: '…',
        formatter: name => nameOf(rawByName.get(String(name)) || { name }) },
      axisTick: { show: false }, axisLine: AXIS_LINE,
    },
    dataZoom: scrollable ? [
      { ...windowRange, type: 'slider', zoomLock: true, orient: 'vertical', right: 0, top: 10, bottom: 28, width: 10,
        showDetail: false, brushSelect: false, borderColor: 'transparent',
        backgroundColor: 'rgba(140,150,160,0.08)', fillerColor: 'rgba(140,150,160,0.22)', handleSize: 12 },
      // The inside controller needs its wheel listener even though the value span stays fixed.
      { ...windowRange, type: 'inside', zoomLock: false, zoomOnMouseWheel: false, moveOnMouseWheel: true, moveOnMouseMove: true },
    ] : [],
    series: [{ name: '调用次数', type: 'bar', data: sorted.map(row => row.count), barMaxWidth: 14,
      label: { show: true, position: 'right', distance: 5, color: '#758078', fontSize: 10, formatter: point => String(point.value) },
      itemStyle: { color, borderRadius: [0, 4, 4, 0] } }],
    media: [
      { query: { maxWidth: 320 }, option: { yAxis: { axisLabel: { width: 70 } } } },
      { option: { yAxis: { axisLabel: { width: categoryLabelWidth } } } },
    ],
  };
}
const toolDistOption = computed(() => hBarOption(toolRows.value, {
  nameOf: row => row.label || toolLabel(row.name),
  color: SOFT.blue,
  tipOf: row => `<strong>${escapeTooltip(row.label)}</strong><br/><span style="color:#758078">${escapeTooltip(row.name)}</span><br/>${escapeTooltip(row.description)}<br/>调用 ${escapeTooltip(row.count)} 次`,
}));
const skillDistOption = computed(() => hBarOption(skillRows.value, {
  nameOf: row => `技能 ${row.name}`,
  color: SOFT.green,
  tipOf: row => `技能 ${escapeTooltip(row.name)}<br/>调用 ${escapeTooltip(row.count)} 次`,
}));

let loadRevision = 0;
let wasDeactivated = false;

async function load() {
  const revision = ++loadRevision;
  loading.value = true;
  try {
    const p = new URLSearchParams({
      scope: mode.value === 'global' ? 'global' : 'user',
      days: String(days.value),
    });
    if (mode.value === 'user' && selectedUserId.value) p.set('userId', String(selectedUserId.value));
    const result = await api.get(`/api/users/stats?${p.toString()}`);
    if (revision === loadRevision) summary.value = result;
  } catch (e) {
    if (revision === loadRevision) ui.error(e.message || '加载统计数据失败');
  } finally {
    if (revision === loadRevision) loading.value = false;
  }
}

async function loadAdmin() {
  if (!auth.isAdmin) return;
  try {
    const r = await api.get('/api/admin/stats');
    perUser.value = r.perUser || [];
    if (!selectedUserId.value) {
      const me = perUser.value.find((u) => u.userId === auth.user?.id);
      selectedUserId.value = (me || perUser.value[0])?.userId ?? null;
    }
  } catch { /* 排行表加载失败不阻塞面板 */ }
}

function labelOf(u) {
  const name = u.displayName || u.username;
  return u.userId === auth.user?.id ? `${name}（我）` : name;
}

watch([mode, selectedUserId, days], () => {
  modelPage.value = 1;
  load();
});
onDeactivated(() => { wasDeactivated = true; });
onActivated(() => { if (wasDeactivated) { wasDeactivated = false; load(); } });
onBeforeUnmount(() => { loadRevision++; });
onMounted(() => {
  loadAdmin();
  load();
});
</script>

<template>
  <div class="stats-panel">
    <header class="stats-head">
      <div class="head-left">
        <h2 class="stats-title"><svg class="stats-title-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 20v-8M12 20V5M19 20v-5" /><path d="M3.5 20h17" /></svg>数据统计</h2>
        <span v-if="targetName" class="muted scope-name">{{ targetName }}</span>
        <span class="muted stats-timezone">北京时间（UTC+8）<span v-if="rangeLabel"> · {{ rangeLabel }}</span></span>
      </div>
      <div class="head-controls">
        <template v-if="auth.isAdmin">
          <el-radio-group v-model="mode" size="small">
            <el-radio-button value="global">全局</el-radio-button>
            <el-radio-button value="self">我的</el-radio-button>
            <el-radio-button value="user">用户</el-radio-button>
          </el-radio-group>
        </template>
        <el-radio-group v-model="days" size="small" aria-label="统计时间范围">
          <el-radio-button :value="1">当天</el-radio-button>
          <el-radio-button :value="3">近 3 天</el-radio-button>
          <el-radio-button :value="7">近 7 天</el-radio-button>
          <el-radio-button :value="30">近 30 天</el-radio-button>
          <el-radio-button :value="90">近 90 天</el-radio-button>
        </el-radio-group>
        <el-button size="small" :loading="loading" @click="load">刷新统计</el-button>
      </div>
    </header>

    <div v-loading="loading" class="stats-body">
      <!-- 用户筛选（用户模式下显示在内容区） -->
      <div v-if="mode === 'user'" class="user-filter">
        <span class="muted filter-label">统计用户</span>
        <el-select
          v-model="selectedUserId"
          filterable
          size="small"
          placeholder="选择用户"
          class="user-select"
        >
          <el-option v-for="u in users" :key="u.userId" :value="u.userId" :label="labelOf(u)" />
        </el-select>
      </div>

      <!-- 概览卡片 -->
      <section v-if="overviewMetrics.length" class="stat-cards" :class="{ 'is-global': summary.scope === 'global' }">
        <div class="stat-metrics">
          <el-card v-for="metric in overviewMetrics" :key="metric.label" class="stat-card" shadow="never">
            <dl class="stat-metric">
              <dt class="stat-label">
                <span class="stat-dot" :style="{ backgroundColor: metric.color }" aria-hidden="true" />{{ metric.label }}
              </dt>
              <dd class="stat-value">{{ metric.value }}</dd>
              <dd v-if="metric.sub" class="stat-sub muted">{{ metric.sub }}</dd>
            </dl>
          </el-card>
        </div>
        <el-card class="stat-card stat-ai-card" shadow="never">
          <h3 class="stat-label stat-ai-label">
            <span class="stat-dot stat-ai-dot" aria-hidden="true" />所选时段 AI 用量
          </h3>
          <div class="stat-ai-overview">
            <div class="stat-ai-summary">
              <dl class="stat-token-total">
                <dt class="muted">总 Token</dt>
                <dd class="stat-value">{{ formatTokens(rangeAi.totalTokens) }}</dd>
              </dl>
              <p class="stat-sub muted">{{ rangeAi.requests }} 次模型请求</p>
            </div>
            <TokenUsageBreakdown :usage="rangeAi" variant="overview" class="overview-breakdown" aria-label="所选时段 Token 明细" />
          </div>
        </el-card>
      </section>

      <p v-if="usageNote" class="muted usage-note">{{ usageNote }}</p>

      <section class="stat-charts">
        <el-card class="chart-card" shadow="never">
          <template #header><span class="chart-title"><svg class="title-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 20v-8M12 20V5M19 20v-5" /></svg>AI 用量趋势</span></template>
          <UsageChart class="chart-fill" :option="aiChartOption" height="100%" />
        </el-card>
        <el-card class="chart-card" shadow="never">
          <template #header><span class="chart-title"><svg class="title-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 17l5-5 3.5 3.5L20 8" /><path d="M15 8h5v5" /></svg>编译趋势</span></template>
          <UsageChart class="chart-fill" :option="compileChartOption" height="100%" />
        </el-card>
        <el-card class="chart-card model-chart-card" shadow="never">
          <template #header>
            <div class="distribution-header">
              <span class="chart-title"><svg class="title-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5" /><path d="M12 3.5V12l6.2 5.8" /></svg>模型请求分布</span>
              <span v-if="modelRows.length" class="muted model-count">共 {{ modelRows.length }} 个模型</span>
            </div>
          </template>
          <div v-if="modelRows.length" class="model-distribution"
            :style="{ '--model-stacked-chart-height': `${MODEL_STACKED_PIE.height}px`, '--model-stacked-pie-top': `${MODEL_STACKED_PIE.top}px` }">
            <div class="model-request-chart">
              <template v-if="modelRequestTotal">
                <UsageChart :option="modelChartOption" height="100%" aria-hidden="true" />
                <dl class="model-request-total">
                  <dt class="muted">总请求</dt>
                  <dd>{{ formatTokens(modelRequestTotal) }}</dd>
                </dl>
              </template>
              <div v-else class="chart-empty muted">暂无可统计的请求次数</div>
            </div>
            <div class="model-legend-column">
              <ul ref="modelLegend" class="model-legend" tabindex="0" role="list" aria-label="各模型用量">
                <li v-for="row in visibleModels" :key="row.id" class="model-legend-row">
                  <details>
                    <summary class="model-legend-summary">
                      <span class="model-legend-dot" :style="{ '--model-dot-color': row.requests > 0 ? row.color : undefined }" aria-hidden="true" />
                      <span class="model-legend-name" dir="auto">{{ row.model }}</span>
                      <span class="model-legend-values">
                        <span>{{ row.requests }} 次</span>
                        <span class="muted">总 Token {{ formatTokens(row.totalTokens) }}</span>
                      </span>
                      <svg class="model-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
                    </summary>
                    <div class="model-usage">
                      <p v-if="row.providerLine" class="muted" dir="auto">{{ row.providerLine }}</p>
                      <TokenUsageBreakdown :usage="row" aria-label="模型 Token 明细" />
                      <p v-if="row.coverageNote" class="muted model-coverage-note">{{ row.coverageNote }}</p>
                    </div>
                  </details>
                </li>
              </ul>
              <nav v-if="modelPageCount > 1" class="model-pagination" aria-label="模型列表分页">
                <button type="button" aria-label="上一页" :disabled="modelPage === 1" @click="modelPage--">
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 6-6 6 6 6" /></svg>
                </button>
                <span role="status" class="muted"><span class="page-status-label">模型列表，第 </span>{{ modelPage }} / {{ modelPageCount }}<span class="page-status-label"> 页</span></span>
                <button type="button" aria-label="下一页" :disabled="modelPage === modelPageCount" @click="modelPage++">
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
                </button>
              </nav>
            </div>
          </div>
          <div v-else class="chart-empty muted"><svg class="empty-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5" /><path d="M12 3.5V12l6.2 5.8" /></svg>所选范围内暂无模型调用</div>
        </el-card>
        <el-card class="chart-card" shadow="never">
          <template #header><span class="chart-title"><svg class="title-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12h4l3-7 4 14 3-7h4" /></svg>工具 / Skill 调用趋势</span></template>
          <UsageChart v-if="hasCalls" class="chart-fill" :option="callTrendOption" height="100%" />
          <div v-else class="chart-empty muted"><svg class="empty-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12h4l3-7 4 14 3-7h4" /></svg>所选范围内暂无工具或 Skill 调用</div>
        </el-card>
        <el-card class="chart-card" shadow="never">
          <template #header>
            <div class="tool-dist-header distribution-header"><span class="chart-title"><svg class="title-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h12M4 12h16M4 18h8" /></svg>工具调用分布</span><span class="muted tool-count">全部 {{ toolRows.length }} 种</span></div>
          </template>
          <div v-if="toolRows.length" class="tool-distribution" role="img" :aria-label="toolDistributionLabel">
            <UsageChart class="chart-fill" :option="toolDistOption" height="100%" />
            <p v-if="toolRows.length > DISTRIBUTION_PAGE_SIZE" class="distribution-help muted">滚动或拖动查看全部</p>
          </div>
          <div v-else class="chart-empty muted"><svg class="empty-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h12M4 12h16M4 18h8" /></svg>所选范围内暂无工具调用</div>
        </el-card>
        <el-card class="chart-card" shadow="never">
          <template #header><span class="chart-title"><svg class="title-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4l2 4.6 5 .7-3.6 3.5.9 5-4.3-2.4-4.3 2.4.9-5L5 9.3l5-.7z" /></svg>Skill 调用分布</span></template>
          <div v-if="skillRows.length" class="skill-distribution" role="img" :aria-label="skillDistributionLabel">
            <UsageChart class="chart-fill" :option="skillDistOption" height="100%" />
            <p v-if="skillRows.length > DISTRIBUTION_PAGE_SIZE" class="distribution-help muted">滚动或拖动查看全部</p>
          </div>
          <div v-else class="chart-empty muted"><svg class="empty-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4l2 4.6 5 .7-3.6 3.5.9 5-4.3-2.4-4.3 2.4.9-5L5 9.3l5-.7z" /></svg>所选范围内暂无 Skill 调用</div>
        </el-card>
      </section>

      <!-- 管理员：用户统计排行 -->
      <section v-if="auth.isAdmin && mode === 'global'" class="stat-table">
        <el-card shadow="never">
          <template #header><span class="chart-title"><svg class="title-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 21h8M12 17v4" /><path d="M7 4h10v5a5 5 0 0 1-10 0z" /><path d="M7 6H4.5A2.5 2.5 0 0 0 7 10M17 6h2.5A2.5 2.5 0 0 1 17 10" /></svg>用户统计排行</span></template>
          <el-table :data="perUser" size="small" :default-sort="{ prop: 'aiRequests', order: 'descending' }">
            <el-table-column label="用户" min-width="140">
              <template #default="{ row }">
                {{ row.displayName || row.username }}
                <el-tag v-if="row.role === 'admin'" size="small" type="warning" class="role-tag">管理员</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="projectCount" label="项目数" width="90" sortable />
            <el-table-column label="存储空间" width="110" sortable prop="storageBytes">
              <template #default="{ row }">{{ fmtBytes(row.storageBytes) }}</template>
            </el-table-column>
            <el-table-column prop="compileCount" label="编译次数" width="100" sortable />
            <el-table-column label="编译时长" width="110" sortable prop="compileSecondsUsed">
              <template #default="{ row }">{{ fmtSeconds(row.compileSecondsUsed) }}</template>
            </el-table-column>
            <el-table-column label="AI 输入" width="110" sortable prop="aiInputTokens">
              <template #default="{ row }"><span class="rank-token-count">{{ formatTokens(row.aiInputTokens) }}</span></template>
            </el-table-column>
            <el-table-column label="AI 输出" width="110" sortable prop="aiOutputTokens">
              <template #default="{ row }"><span class="rank-token-count">{{ formatTokens(row.aiOutputTokens) }}</span></template>
            </el-table-column>
            <el-table-column prop="aiRequests" label="AI 请求" width="100" sortable />
          </el-table>
        </el-card>
      </section>
    </div>
  </div>
</template>

<style scoped>
.distribution-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; width: 100%; }
.tool-count, .model-count { font-size: 12px; font-weight: 400; white-space: nowrap; }
.tool-distribution, .skill-distribution, .model-distribution {
  flex: 1;
  min-width: 0;
  min-height: 0;
}
.tool-distribution, .skill-distribution { display: flex; flex-direction: column; }
.chart-fill { flex: 1; min-height: 0; }
.distribution-help { margin: 4px 0 0; font-size: 11px; text-align: right; }
.usage-note { margin: 0; font-size: 12px; line-height: 1.5; }
.rank-token-count { font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.model-chart-card { container: model-chart / inline-size; }
.model-distribution {
  display: grid;
  grid-template-columns: minmax(0, 2fr) minmax(0, 3fr);
  grid-template-rows: minmax(0, 1fr);
  gap: 8px 12px;
}
.model-request-chart {
  position: relative;
  display: grid;
  grid-template-rows: minmax(0, 1fr);
  justify-self: center;
  width: 100%;
  max-width: 224px;
  min-width: 0;
  min-height: 0;
  text-align: center;
  container-type: inline-size;
}
.model-request-total {
  position: absolute;
  inset: var(--model-pie-top, 0px) 0 0;
  display: grid;
  align-content: center;
  justify-items: center;
  gap: 2px;
  margin: 0;
  pointer-events: none;
}
.model-request-total dt { font-size: 11px; line-height: 1.2; }
.model-request-total dd {
  grid-row: 1;
  max-width: 60%;
  margin: 0;
  font-size: clamp(16px, 15.5cqw, 28px);
  font-weight: 650;
  font-variant-numeric: tabular-nums;
  line-height: 1.1;
  overflow-wrap: anywhere;
}
.model-request-chart :deep(.model-request-tooltip) { text-align: start; }
.model-request-chart :deep(.model-request-tooltip > strong),
.model-request-chart :deep(.model-request-tooltip-values > span:first-child) {
  display: block;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.model-request-chart :deep(.model-request-tooltip > strong) { line-height: 1.35; }
.model-request-chart :deep(.model-request-tooltip-values) {
  display: flex;
  justify-content: space-between;
  gap: 6px;
  color: var(--fg-dim);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  line-height: 1.35;
  white-space: nowrap;
}
.model-legend-column {
  display: flex;
  flex-direction: column;
  align-self: center;
  min-width: 0;
  min-height: 0;
  max-height: 100%;
}
.model-legend {
  min-width: 0;
  min-height: 0;
  padding: 0;
  margin: 0;
  list-style: none;
  overflow-y: auto;
  overscroll-behavior-y: contain;
  scrollbar-gutter: stable;
}
.model-legend-row + .model-legend-row { border-top: 1px solid var(--border); }
.model-legend-summary {
  box-sizing: border-box;
  display: grid;
  grid-template-columns: 8px minmax(0, 1fr) 12px;
  grid-template-areas: 'dot name chevron' '. values values';
  gap: 3px 6px;
  align-items: center;
  align-content: center;
  min-height: 52px;
  padding: 8px 4px;
  color: var(--fg);
  font-size: 12px;
  line-height: 1.4;
  list-style: none;
  cursor: pointer;
}
.model-legend-summary::-webkit-details-marker { display: none; }
.model-legend-summary:hover { background: var(--glass-inset); }
.model-legend:focus-visible, .model-legend-summary:focus-visible, .model-pagination button:focus-visible {
  outline: 1px solid var(--accent);
  outline-offset: -1px;
  border-radius: 4px;
}
.model-legend-dot {
  grid-area: dot;
  box-sizing: border-box;
  width: 8px;
  height: 8px;
  border: 1px solid var(--model-dot-color, var(--fg-dim));
  border-radius: 50%;
  background-color: var(--model-dot-color, transparent);
}
.model-legend-name, .model-legend-values { min-width: 0; overflow-wrap: anywhere; }
.model-legend-name { grid-area: name; font-weight: 600; }
.model-legend-values {
  grid-area: values;
  display: flex;
  flex-wrap: wrap;
  gap: 1px 8px;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.model-legend-values > span { min-width: 0; }
.model-chevron, .model-pagination svg { width: 12px; height: 12px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.model-chevron { grid-area: chevron; color: var(--fg-dim); }
.model-legend-row details[open] .model-chevron { transform: rotate(90deg); }
.model-usage { padding: 0 4px 10px 18px; }
.model-usage p { margin: 0 0 3px; font-size: 11px; line-height: 1.5; overflow-wrap: anywhere; }
.model-usage .model-coverage-note { margin: 5px 0 0; }
.model-pagination {
  display: flex;
  flex: none;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
  padding-top: 8px;
  border-top: 1px solid var(--border);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.model-pagination button {
  display: grid;
  place-items: center;
  width: 28px;
  height: 26px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: transparent;
  color: var(--fg);
  cursor: pointer;
}
.model-pagination button:not(:disabled):hover { background: var(--bg-hover); }
.model-pagination button:disabled { color: var(--fg-dim); opacity: .48; cursor: default; }
.page-status-label {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
@container model-chart (max-width: 295px) {
  .model-distribution {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: var(--model-stacked-chart-height) minmax(0, 1fr);
  }
  .model-request-chart { --model-pie-top: var(--model-stacked-pie-top); }
  .model-request-total dd {
    max-width: calc((var(--model-stacked-chart-height) - var(--model-stacked-pie-top)) * .6);
    font-size: 18px;
  }
  .model-legend-column {
    align-self: stretch;
    border-block-start: 1px solid var(--border);
  }
}

.stats-panel {
  display: flex;
  flex-direction: column;
  gap: 16px;
  width: 100%;
  container: stats-overview / inline-size;
}
.stats-head {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
}
.head-left {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 10px;
}
.stats-title {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
}
.stats-timezone { font-size: 12px; }
.scope-name {
  font-size: 12px;
  padding: 3px 12px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--bg-hover, rgba(255, 255, 255, 0.04));
}
.head-controls {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.user-select {
  width: 180px;
}
.user-filter {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-hover, rgba(255, 255, 255, 0.03));
}
.filter-label {
  font-size: 12px;
}
.chart-empty {
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  min-height: 0;
  font-size: 12px;
}
.stats-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.stat-cards {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 12px;
}
.stat-metrics {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}
.stat-cards.is-global .stat-metrics {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}
.stat-card {
  min-width: 0;
  border-radius: var(--radius-lg);
  container-type: inline-size;
}
.stat-card :deep(.el-card__body) {
  padding: 14px clamp(8px, 9cqi, 16px);
}
.stat-metrics .stat-card {
  display: grid;
}
.stat-metrics :deep(.el-card__body) {
  display: grid;
  align-content: center;
}
.stat-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}
.stat-label {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 0 6px;
  font-size: 12px;
  font-weight: 550;
  line-height: 1.4;
  color: var(--fg-dim);
}
.stat-metric, .stat-token-total { margin: 0; }
.stat-value {
  margin: 0;
  font-size: clamp(16px, 16cqi, 22px);
  font-weight: 650;
  line-height: 1.2;
  letter-spacing: -.2px;
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}
.stat-sub {
  margin: 4px 0 0;
  font-variant-numeric: tabular-nums;
  font-size: 11px;
  line-height: 1.4;
  overflow-wrap: anywhere;
}
.stat-ai-card { container-name: stats-ai; }
.stat-ai-card :deep(.el-card__body) { padding: 14px clamp(12px, 3cqi, 18px); }
.stat-ai-label { margin-bottom: 10px; color: var(--fg); font-size: 13px; font-weight: 650; }
.stat-ai-dot { background: var(--accent); }
.stat-ai-overview { display: grid; grid-template-columns: minmax(0, 1fr); gap: 10px; }
.stat-ai-summary {
  display: flex;
  flex-wrap: wrap;
  align-items: end;
  justify-content: space-between;
  gap: 0 12px;
  min-width: 0;
}
.stat-token-total { min-width: 0; }
.stat-token-total dt { font-size: 12px; line-height: 1.5; }
.stat-token-total .stat-value { margin-top: 1px; font-size: clamp(22px, 5cqi, 28px); }
.overview-breakdown { border-block-start: 1px solid var(--border); padding-block-start: 9px; }

@container stats-overview (max-width: 270px) {
  .stat-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .stat-cards:not(.is-global) .stat-metrics > :last-child { grid-column: 1 / -1; }
}
@container stats-overview (min-width: 500px) {
  .stat-cards.is-global .stat-metrics { grid-template-columns: repeat(4, minmax(0, 1fr)); }
}
@container stats-overview (min-width: 860px) {
  .stat-cards:not(.is-global) { grid-template-columns: minmax(0, 2fr) minmax(0, 3fr); }
  .stat-metric { display: grid; grid-template-rows: auto auto minmax(20px, auto); }
}
@container stats-overview (min-width: 940px) {
  .stat-cards.is-global { grid-template-columns: minmax(0, 9fr) minmax(0, 11fr); }
}
@container stats-ai (min-width: 460px) {
  .stat-ai-overview { grid-template-columns: minmax(0, 5fr) minmax(0, 9fr); gap: 16px; }
  .stat-ai-summary { display: block; }
  .overview-breakdown {
    border-block-start: 0;
    padding-block-start: 0;
    border-inline-start: 1px solid var(--border);
    padding-inline-start: 16px;
  }
}
.stat-charts {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  grid-auto-rows: 400px;
  gap: 14px;
}
@container stats-overview (min-width: 860px) {
  .stat-charts {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}
.chart-card {
  display: grid;
  grid-template-rows: 44px minmax(0, 1fr);
  min-width: 0;
  min-height: 0;
  border-radius: var(--radius-lg);
}
.chart-card :deep(.el-card__header) {
  display: flex;
  align-items: center;
  min-width: 0;
  padding: 0 16px;
}
.chart-card :deep(.el-card__body) {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  padding: 12px 14px;
}
.chart-title {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
}
.chart-title::before {
  content: '';
  width: 3px;
  height: 14px;
  border-radius: 2px;
  background: var(--accent, #4c8dff);
}
.role-tag {
  margin-left: 6px;
}
.muted {
  color: var(--fg-dim);
}

/* Visual refinement layer: iconified titles, tabular numerals, token motion. */
.stats-title { display: flex; align-items: center; gap: 8px; letter-spacing: -.02em; }
.stats-title-icon { width: 18px; height: 18px; flex: none; fill: none; stroke: var(--accent); stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
.title-icon { width: 14px; height: 14px; flex: none; fill: none; stroke: var(--accent); stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
.chart-title::before { content: none; display: none; }
.chart-title { letter-spacing: -.01em; }
.scope-name {
  border-color: color-mix(in srgb, var(--accent) 24%, transparent);
  background: var(--accent-soft);
  color: var(--accent-hover);
  font-weight: 550;
}
.user-filter {
  border-color: color-mix(in srgb, var(--border) 80%, var(--bg2));
  border-radius: var(--radius-md);
  background: var(--glass-inset);
}
.chart-empty { flex-direction: column; gap: 9px; }
.empty-icon { width: 22px; height: 22px; flex: none; fill: none; stroke: var(--accent-secondary); stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; opacity: .8; }
.distribution-help { font-variant-numeric: tabular-nums; }
@media (forced-colors: active) {
  .scope-name, .user-filter { background: Canvas; }
}
</style>
