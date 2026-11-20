// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, inject, KeepAlive, nextTick, provide, ref } from 'vue';
import StatsPanel from './StatsPanel.vue';

const services = vi.hoisted(() => ({
  api: { get: vi.fn() },
  auth: { isAdmin: false, user: { id: 1, username: 'researcher' } },
  ui: { error: vi.fn() },
}));
vi.mock('../api.js', () => ({ api: services.api, fmtBytes: value => `${value} B`, fmtSeconds: value => `${value} s` }));
vi.mock('../stores/auth.js', () => ({ useAuthStore: () => services.auth }));
vi.mock('../stores/ui.js', () => ({ useUiStore: () => services.ui }));
vi.mock('./UsageChart.vue', async () => {
  const { h } = await import('vue');
  return { default: {
    props: ['option', 'height'],
    render() { return h('div', { class: 'usage-chart-stub', ref: element => {
      if (element) { element.chartOption = this.option; element.chartHeight = this.height; }
    } }); },
  } };
});

const toolNames = [
  'list_files', 'read_file', 'read_workspace', 'view_image', 'write_file',
  'edit_file', 'copy_to_project', 'run_in_workspace', 'get_document_context',
  'read_skill', 'run_skill_script', 'compile_and_preview', 'web_search',
  'web_fetch', 'prepare_env', 'ask_user',
];
function stats(askCount = 1) {
  return {
    scope: 'user', target: { id: 1, username: 'researcher' },
    totals: { projectCount: 1, storageBytes: 100, compileCount: 0, compileSeconds: 0, aiInputTokens: 0, aiOutputTokens: 0 },
    daily: [], models: [], toolDaily: [], skillDaily: [], skills: [],
    tools: toolNames.map((name, index) => ({ name, count: name === 'ask_user' ? askCount : 160 - index * 10 })),
  };
}

it('shows the selected range total and nests the two cache counts under input', async () => {
  const result = stats();
  result.totals.aiTotalTokens = 90_000_000;
  result.rangeTotals = { aiTotalTokens: 60_203_584, aiInputTokens: 59_203_584, aiOutputTokens: 1_000_000, aiRequests: 250,
    aiCacheReadTokens: 40_100_000, aiUncachedInputTokens: 19_103_584,
    aiUnknownUsageRequests: 2, aiPartialUsageRequests: 1 };
  services.api.get.mockResolvedValue(result);
  await mount();
  const card = selectedAiCard();
  expect(card.querySelector('.stat-token-total dt').textContent).toBe('总 Token');
  expect(card.querySelector('.stat-token-total dd').textContent).toBe('60,203,584');
  expect(card.textContent).toContain('250 次模型请求');
  expect(card.textContent).not.toContain('90,000,000');
  expect(displayedMetrics(card)).toEqual({
    '输入 Token': '59,203,584', 缓存命中: '40,100,000', 缓存未命中: '19,103,584', '输出 Token': '1,000,000',
  });
  expect(displayedMetrics(card.querySelector('.token-input .token-children'))).toEqual({
    缓存命中: '40,100,000', 缓存未命中: '19,103,584',
  });
  expect(card.querySelector('.token-input + .token-metric dt').textContent).toBe('输出 Token');
  expect(host.querySelector('.usage-note').textContent).toContain('2 次请求未返回用量');
  expect(host.querySelector('.usage-note').textContent).toContain('1 次请求仅记录已确认的用量');
});

it('stacks only the three token categories and formats the axis and the tooltip with full counts', async () => {
  services.api.get.mockResolvedValue({
    ...stats(),
    daily: [
      { day: '2026-10-30', aiInputTokens: 60_000_000, aiCacheReadTokens: 40_000_000,
        aiUncachedInputTokens: 20_000_000, aiOutputTokens: 203_584, aiTotalTokens: 60_203_584, aiRequests: 2 },
      { day: '2026-10-31', aiRequests: 1, aiUnknownUsageRequests: 1 },
    ],
  });
  await mount();
  expect(selectedAiCard().querySelector('.stat-value').textContent).toBe('60,203,584');
  expect(selectedAiCard().querySelector('.stat-sub').textContent).toBe('3 次模型请求');
  const option = host.querySelector('.usage-chart-stub').chartOption;
  expect(option.series).toEqual([
    expect.objectContaining({ name: '缓存命中', type: 'bar', stack: 'tokens', data: [40_000_000, 0] }),
    expect.objectContaining({ name: '缓存未命中', type: 'bar', stack: 'tokens', data: [20_000_000, 0] }),
    expect.objectContaining({ name: '输出', type: 'bar', stack: 'tokens', data: [203_584, 0] }),
    expect.objectContaining({ name: '请求数', type: 'line', yAxisIndex: 1, data: [2, 1] }),
  ]);
  expect(option.yAxis[0].axisLabel.formatter(60_203_584)).toBe('60,203,584');
  const tip = option.tooltip.formatter([{ dataIndex: 0 }]);
  for (const text of ['2026-10-30（北京时间）', '总 Token：60,203,584', '输入 Token：60,000,000',
    '缓存命中：40,000,000', '缓存未命中：20,000,000', '输出 Token：203,584', '请求数：2 次']) {
    expect(tip).toContain(text);
  }
});

it('shows zero tokens and no model entries after the usage reset', async () => {
  services.api.get.mockResolvedValue({
    ...stats(),
    daily: [{ day: '2026-11-16' }],
    rangeTotals: { aiTotalTokens: 0, aiInputTokens: 0, aiCacheReadTokens: 0,
      aiUncachedInputTokens: 0, aiOutputTokens: 0, aiRequests: 0 },
  });
  await mount();
  expect(selectedAiCard().querySelector('.stat-value').textContent).toBe('0');
  expect(selectedAiCard().querySelector('.stat-sub').textContent).toBe('0 次模型请求');
  expect(displayedMetrics(selectedAiCard())).toEqual({
    '输入 Token': '0', 缓存命中: '0', 缓存未命中: '0', '输出 Token': '0',
  });
  expect(host.querySelector('.usage-chart-stub').chartOption.series.map(series => series.data)).toEqual([[0], [0], [0], [0]]);
  expect(host.querySelector('.usage-note')).toBeNull();
  expect(host.querySelector('.model-legend')).toBeNull();
  expect(host.textContent).toContain('所选范围内暂无模型调用');
});
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = async () => {
  for (let i = 0; i < 5; i++) { await Promise.resolve(); await nextTick(); }
};
let app, host, requests;
const radioContext = Symbol('stats-radio-group');

async function mount({ keepAlive = false } = {}) {
  host = document.createElement('div');
  document.body.append(host);
  const visible = ref(true);
  const Root = keepAlive ? defineComponent({
    setup: () => () => h(KeepAlive, null, { default: () => visible.value ? h(StatsPanel) : h('div', '其他视图') }),
  }) : StatsPanel;
  app = createApp(Root);
  app.directive('loading', {});
  app.component('el-card', {
    render() { return h('section', [this.$slots.header?.(), this.$slots.default?.()]); },
  });
  app.component('el-button', {
    props: ['disabled', 'loading'],
    render() { return h('button', { type: 'button', disabled: this.disabled || this.loading }, this.$slots.default?.()); },
  });
  app.component('el-radio-group', {
    props: ['modelValue'], emits: ['update:modelValue'],
    setup(props, { emit, slots }) {
      provide(radioContext, { selected: () => props.modelValue, select: value => emit('update:modelValue', value) });
      return () => h('div', { role: 'radiogroup' }, slots.default?.());
    },
  });
  app.component('el-radio-button', {
    props: ['value'],
    setup(props, { slots }) {
      const group = inject(radioContext);
      return () => h('button', {
        type: 'button', role: 'radio', 'aria-checked': String(group.selected() === props.value),
        onClick: () => group.select(props.value),
      }, slots.default?.());
    },
  });
  for (const name of ['el-select', 'el-option', 'el-table', 'el-table-column', 'el-tag']) {
    app.component(name, { render: () => null });
  }
  app.mount(host);
  await flush();
  return visible;
}
function button(label) {
  const found = [...host.querySelectorAll('button')].find(element => element.textContent.trim() === label);
  expect(found, `应存在「${label}」按钮`).toBeTruthy();
  return found;
}
function selectedAiCard() {
  return host.querySelector('.stat-token-total').closest('.stat-card');
}
function displayedMetrics(container) {
  return Object.fromEntries([...container.querySelectorAll('.token-metric')].map(metric =>
    [metric.querySelector('dt').textContent.trim(), metric.querySelector('dd').textContent.trim()]));
}
function chartOption(title) {
  const card = [...host.querySelectorAll('.chart-card')].find(element =>
    element.querySelector('.chart-title')?.textContent.trim() === title);
  const chart = card?.querySelector('.usage-chart-stub');
  expect(chart, `「${title}」应使用 UsageChart`).toBeTruthy();
  return chart.chartOption;
}

it('lays out six direct chart cards in reading order with flexible chart heights', async () => {
  const day = '2026-11-16';
  const rows = (name, length) => Array.from({ length }, (_, index) => ({ name: `${name}-${index}`, count: 180 - index }));
  services.api.get.mockResolvedValue({ ...stats(), daily: [{ day, compiles: 2, compileSeconds: 9 }],
    toolDaily: [{ day, count: 2 }], skillDaily: [{ day, count: 1 }], tools: rows('tool', 25), skills: rows('skill', 11),
    models: [{ model: 'qwen4', requests: 1 }],
  });
  await mount();

  const grid = host.querySelector('.stat-charts');
  const cards = [...grid.querySelectorAll(':scope > .chart-card')];
  expect(cards.map(card => card.querySelector('.chart-title').textContent.trim())).toEqual([
    'AI 用量趋势', '编译趋势', '模型请求分布',
    '工具 / Skill 调用趋势', '工具调用分布', 'Skill 调用分布',
  ]);
  expect(cards.map(card => card.querySelector('.usage-chart-stub').chartHeight)).toEqual(Array(6).fill('100%'));
  expect(cards[2].classList.contains('model-chart-card')).toBe(true);
  expect(cards[2].querySelector('.model-request-chart').nextElementSibling.querySelector('.model-legend')).toBeTruthy();
  for (const card of cards.slice(4)) {
    const { xAxis, media } = card.querySelector('.usage-chart-stub').chartOption;
    expect(xAxis).toMatchObject({ splitNumber: 3, axisLabel: { hideOverlap: true, showMinLabel: true, showMaxLabel: true } });
    expect(media[0]).toMatchObject({ query: { maxWidth: 320 }, option: { yAxis: { axisLabel: { width: 70 } } } });
  }
  expect(cards[4].querySelector('.usage-chart-stub').chartOption.dataZoom.map(item => item.type)).toEqual(['slider', 'inside']);
  expect(cards[4].querySelector('.distribution-help').textContent).toContain('滚动或拖动');
  expect(cards[5].querySelector('.usage-chart-stub').chartOption.yAxis.data).toHaveLength(11);
});

function toolChart() {
  return chartOption('工具调用分布');
}
function toolCount(name) {
  const option = toolChart();
  const index = option.yAxis.data.indexOf(name);
  expect(index, `图表原始类别应保留 ${name}`).toBeGreaterThanOrEqual(0);
  const datum = option.series[0].data[index];
  return typeof datum === 'object' ? datum.value : datum;
}
const askUserCount = () => toolCount('ask_user');
const tooltip = (name, value) => toolChart().tooltip.formatter([{ name, axisValue: name, value }]);
function tooltipElement(name, value) {
  const element = document.createElement('div');
  element.innerHTML = tooltip(name, value);
  return element;
}

beforeEach(() => {
  vi.clearAllMocks();
  requests = [];
  services.api.get.mockImplementation(url => {
    const pending = deferred();
    requests.push({ url, ...pending });
    return pending.promise;
  });
});
afterEach(async () => {
  app?.unmount(); app = null;
  for (const request of requests) request.resolve(stats());
  await flush();
  host?.remove(); host = null;
});

describe('stats complete tool distribution', () => {
  it('charts all 16 tools with Chinese category labels, truthful counts and the low-frequency ask_user tooltip', async () => {
    await mount();
    expect(requests).toHaveLength(1);
    requests[0].resolve(stats()); await flush();
    const option = toolChart();
    expect(option.xAxis.type).toBe('value');
    expect(option.yAxis.type).toBe('category');
    expect(option.yAxis.data).toHaveLength(16);
    expect(option.series[0].type).toBe('bar');
    expect(option.series[0].data).toHaveLength(16);
    expect(host.querySelector('.tool-dist-header').textContent).toMatch(/全部\s*16\s*种/);
    expect(option.yAxis.data.at(-1)).toBe('ask_user');
    expect(option.yAxis.inverse).toBe(true);
    expect(option.yAxis.axisLabel.interval).toBe(0);
    expect(option.yAxis.axisLabel.formatter('ask_user')).toBe('询问用户');
    expect(askUserCount()).toBe(1);
    expect(option.dataZoom || []).toHaveLength(0);
    expect(option.series[0].label).toMatchObject({ show: true, position: 'right' });
    const tip = tooltipElement('ask_user', 1).textContent;
    expect(tip).toContain('询问用户'); expect(tip).toContain('ask_user');
    expect(tip).toMatch(/1\s*次/);
    expect(tip).toContain('等待用户回答');
    expect(host.querySelector('.tool-distribution').getAttribute('aria-label')).toContain('询问用户');
  });

  it('retains every category and count beyond 20 tools, with vertical slider and wheel browsing', async () => {
    await mount();
    const tools = Array.from({ length: 25 }, (_, index) => ({ name: `custom_${index}`, count: 50 - index }));
    tools.push({ name: 'ask_user', count: 1 });
    requests[0].resolve({ ...stats(), tools }); await flush();
    const option = toolChart();
    expect(option.yAxis.data).toHaveLength(26);
    expect(option.series[0].data).toHaveLength(26);
    expect(new Set(option.yAxis.data)).toEqual(new Set(tools.map(tool => tool.name)));
    for (const tool of tools) expect(toolCount(tool.name)).toBe(tool.count);
    const slider = option.dataZoom.find(zoom => zoom.type === 'slider');
    const inside = option.dataZoom.find(zoom => zoom.type === 'inside');
    expect(slider.zoomLock).toBe(true);
    expect(inside).toMatchObject({ zoomLock: false, zoomOnMouseWheel: false, moveOnMouseWheel: true });
    for (const zoom of [slider, inside]) {
      expect(zoom).toMatchObject({ yAxisIndex: 0, startValue: 0, endValue: 19, minValueSpan: 19, maxValueSpan: 19 });
    }
    expect(host.textContent).toMatch(/滚动或拖动查看全部/);
    expect(askUserCount()).toBe(1);
    expect(tooltipElement('ask_user', 1).textContent).toContain('询问用户');
  });

  it('sorts numerically, preserves distinct unknown/MCP identities and escapes every tooltip field', async () => {
    await mount();
    const unknown = '<img src=x onerror="alert(1)">';
    const mcp = 'mcp__remote__<script>alert("x")</script>&';
    const tools = [
      { name: unknown, count: 2 }, { name: 'custom_beta', count: 11 },
      { name: mcp, count: 9 }, { name: 'mcp__other__query', count: 2 },
      { name: 'custom_alpha', count: 11 }, { name: 'ask_user', count: 1 },
    ];
    requests[0].resolve({ ...stats(), tools }); await flush();
    const option = toolChart();
    expect(option.yAxis.data).toHaveLength(tools.length);
    expect(new Set(option.yAxis.data).size).toBe(tools.length);
    expect(option.series[0].data).toEqual([11, 11, 9, 2, 2, 1]);
    expect(option.yAxis.data.slice(0, 2)).toEqual(['custom_alpha', 'custom_beta']);
    expect(option.yAxis.axisLabel.formatter('custom_alpha')).toContain('其他工具');
    expect(option.yAxis.axisLabel.formatter('custom_beta')).toContain('其他工具');
    expect(option.yAxis.axisLabel.formatter(mcp)).toContain('外部工具');
    expect(option.yAxis.axisLabel.formatter('mcp__other__query')).toContain('外部工具');
    expect(option.series[0].label).toMatchObject({ show: true, position: 'right' });
    for (const tool of tools) {
      expect(toolCount(tool.name)).toBe(tool.count);
      const element = tooltipElement(tool.name, tool.count);
      expect(element.textContent).toContain(tool.name);
      expect(element.textContent).toMatch(new RegExp(`${tool.count}\\s*次`));
      expect(element.querySelectorAll('img, script, iframe, [onerror]')).toHaveLength(0);
    }
    expect(tooltip(unknown, 2)).toContain('&lt;img');
    expect(tooltip(mcp, 9)).toContain('&lt;script&gt;');
    const fallback = tooltipElement('<svg onload="alert(1)">', '<b>spoof count</b>');
    expect(fallback.querySelectorAll('svg, b, [onload]')).toHaveLength(0);
  });

  it('fetches current counts when the user clicks refresh without reopening the panel', async () => {
    await mount(); requests[0].resolve(stats(1)); await flush();
    expect(askUserCount()).toBe(1);
    button('刷新统计').click(); await flush();
    expect(requests).toHaveLength(2);
    expect(requests[1].url).toBe(requests[0].url);
    requests[1].resolve(stats(41)); await flush();
    expect(askUserCount()).toBe(41);
    expect(button('刷新统计').disabled).toBe(false);
  });

  it.each([1, 3])('uses hourly points in only the three trend charts for days=%s', async range => {
    await mount();
    const times = range === 1
      ? ['2026-10-31 00:00', '2026-10-31 01:00']
      : ['2026-10-30 23:00', '2026-10-31 00:00'];
    const expectedAxis = times.map(time => range === 1
      ? time.slice(11, 16)
      : `${time.slice(5, 10)} ${time.slice(11, 16)}`);
    const hourly = times.map((time, index) => ({
      time,
      aiInputTokens: (index + 1) * 100,
      aiCacheReadTokens: (index + 1) * 60,
      aiUncachedInputTokens: (index + 1) * 40,
      aiOutputTokens: (index + 1) * 10,
      aiTotalTokens: (index + 1) * 110,
      aiRequests: index + 1,
      compiles: index + 1,
      compileSeconds: (index + 1) * 5,
    }));
    requests[0].resolve({
      ...stats(), days: range, granularity: 'hour', hourly, timeZone: 'Asia/Shanghai', utcOffset: '+08:00',
      range: { start: times[0].slice(0, 10), end: times.at(-1).slice(0, 10) },
      toolHourly: times.map((time, index) => ({ time, name: 'read_file', count: index + 2 })),
      skillHourly: [{ time: times[0], name: 'writing', count: 1 }],
    });
    await flush();
    const ai = chartOption('AI 用量趋势');
    const compile = chartOption('编译趋势');
    const calls = chartOption('工具 / Skill 调用趋势');
    expect(host.querySelectorAll('.usage-chart-stub')).toHaveLength(4);
    expect(ai.xAxis.data).toEqual(expectedAxis);
    expect(Object.fromEntries(ai.series.map(series => [series.name, series.data]))).toEqual({
      缓存命中: [60, 120], 缓存未命中: [40, 80], 输出: [10, 20], 请求数: [1, 2],
    });
    expect(compile.xAxis.data).toEqual(expectedAxis);
    expect(compile.series[0].data).toEqual([1, 2]);
    expect(calls.xAxis.data).toEqual(expectedAxis);
    expect(calls.series[0].data).toEqual([2, 3]);
    expect(calls.series[1].data).toEqual([1, 0]);
    expect(toolChart().yAxis.data).toHaveLength(16);
    expect(host.textContent).toContain('北京时间（UTC+8）');
    expect(host.textContent).toContain(`${times[0].slice(0, 10)} — ${times.at(-1).slice(0, 10)}`);
    for (const chart of [ai, compile, calls]) {
      const title = chart.tooltip.formatter([{ dataIndex: 1, axisValue: expectedAxis[1], seriesName: '请求数', value: 2 }]);
      expect(title).toContain(`${times[1]}（北京时间）`);
    }
  });

  it('offers today and three-day ranges and requests their exact values', async () => {
    await mount();
    expect(requests[0].url).toContain('days=30');
    button('当天').click(); await flush();
    expect(requests).toHaveLength(2);
    expect(requests[1].url).toContain('days=1');
    button('近 3 天').click(); await flush();
    expect(requests).toHaveLength(3);
    expect(requests[2].url).toContain('days=3');
    requests[2].resolve(stats()); await flush();
    expect(services.ui.error).not.toHaveBeenCalled();
  });

  it('keeps the latest selected date range when an older request finishes later', async () => {
    await mount();
    expect(requests[0].url).toContain('days=30');
    button('近 7 天').click(); await flush();
    expect(requests).toHaveLength(2);
    expect(requests[1].url).toContain('days=7');
    const recentUsage = { aiTotalTokens: 1_111, aiInputTokens: 1_101, aiOutputTokens: 10,
      aiCacheReadTokens: 800, aiUncachedInputTokens: 301 };
    requests[1].resolve({ ...stats(7), rangeTotals: recentUsage }); await flush();
    expect(askUserCount()).toBe(7);
    expect(selectedAiCard().querySelector('.stat-value').textContent).toBe('1,111');
    requests[0].resolve({ ...stats(30), rangeTotals: { ...recentUsage, aiTotalTokens: 2_111,
      aiInputTokens: 2_101, aiCacheReadTokens: 1_800 } }); await flush();
    expect(askUserCount()).toBe(7);
    expect(selectedAiCard().querySelector('.stat-value').textContent).toBe('1,111');
    expect(button('近 7 天').getAttribute('aria-checked')).toBe('true');
    expect(services.ui.error).not.toHaveBeenCalled();
  });

  it('ignores an obsolete request error while the current filter is still loading', async () => {
    await mount(); button('近 7 天').click(); await flush();
    requests[0].reject(new Error('过期的30天请求失败')); await flush();
    expect(services.ui.error).not.toHaveBeenCalled();
    expect(button('刷新统计').disabled).toBe(true);
    requests[1].resolve(stats(9)); await flush();
    expect(askUserCount()).toBe(9);
    expect(button('刷新统计').disabled).toBe(false);
  });

  it('refreshes once when a KeepAlive panel is revisited and displays the new count', async () => {
    const visible = await mount({ keepAlive: true });
    expect(requests).toHaveLength(1);
    requests[0].resolve(stats(1)); await flush();
    visible.value = false; await flush();
    expect(host.querySelector('.stats-panel')).toBeNull();
    expect(requests).toHaveLength(1);
    visible.value = true; await flush();
    expect(requests).toHaveLength(2);
    requests[1].resolve(stats(3)); await flush();
    expect(askUserCount()).toBe(3);
  });
});

describe('stats model request distribution', () => {
  it('merges exact model names across providers in both the list and request chart', async () => {
    const model = 'qwen4-max';
    const providerName = 'Research & <em>模型服务</em>';
    const models = [
      { model, provider: 'openai', providerId: 'p_alpha', providerName,
        requests: 12, inputTokens: 190, outputTokens: 10, cacheReadTokens: 150, uncachedInputTokens: 40, totalTokens: 200 },
      { model, provider: 'openai', requests: 2, inputTokens: 3100, outputTokens: 100,
        cacheReadTokens: 3000, uncachedInputTokens: 100, totalTokens: 3200 },
      { model, provider: 'openai', providerId: 'p_beta', providerName: '校内模型服务',
        requests: 7, inputTokens: 200, outputTokens: 30, cacheReadTokens: 90, uncachedInputTokens: 110, totalTokens: 230 },
      { model: '<i>other-model</i>', provider: 'anthropic', requests: 3,
        inputTokens: 100, outputTokens: 0, cacheReadTokens: 50, uncachedInputTokens: 50, totalTokens: 100 },
      { model: 'Qwen4-max', requests: 2, inputTokens: 10, outputTokens: 1, uncachedInputTokens: 10, totalTokens: 11 },
    ];
    services.api.get.mockResolvedValue({ ...stats(), models });
    await mount();

    const distribution = host.querySelector('.model-distribution');
    const chart = distribution.querySelector('.usage-chart-stub');
    const legend = distribution.querySelector('.model-legend');
    const rows = [...legend.querySelectorAll('li')];
    const slices = chart.chartOption.series[0].data;
    expect(distribution.closest('.chart-card').querySelector('.chart-title').textContent).toBe('模型请求分布');
    expect(chart.closest('.model-request-chart').nextElementSibling).toBe(legend.parentElement);
    expect(chart.chartOption.legend).toBeUndefined();
    expect(slices.map(({ name, value }) => [name, value])).toEqual([[model, 21], ['<i>other-model</i>', 3], ['Qwen4-max', 2]]);
    expect(distribution.querySelector('.model-request-total dd').textContent).toBe('26');
    expect(rows.map(row => row.querySelector('.model-legend-name').textContent)).toEqual(slices.map(slice => slice.name));
    expect(distribution.closest('.chart-card').querySelector('.model-count').textContent).toContain('共 3 个模型');
    const firstSummary = rows[0].querySelector('summary');
    expect(firstSummary.textContent).toContain('21 次');
    expect(firstSummary.textContent).toContain('总 Token 3,630');
    expect(firstSummary.textContent).not.toContain('供应商');
    firstSummary.click();
    expect(rows[0].querySelector('details').open).toBe(true);
    expect(rows[0].querySelector('.model-usage').textContent).toContain(`已知供应商：${providerName}、校内模型服务`);
    expect(displayedMetrics(rows[0])).toEqual({
      '输入 Token': '3,490', 缓存命中: '3,240', 缓存未命中: '250', '输出 Token': '140',
    });
    expect(displayedMetrics(rows[0].querySelector('.token-input .token-children'))).toEqual({ 缓存命中: '3,240', 缓存未命中: '250' });
    expect(distribution.textContent).not.toMatch(/供应商未知|p_alpha|p_beta|openai|anthropic/);
    expect(distribution.querySelector('em, i')).toBeNull();

    const tooltip = document.createElement('div');
    tooltip.innerHTML = chart.chartOption.tooltip.formatter({ dataIndex: 0 });
    expect(tooltip.querySelector('strong').textContent).toBe(model);
    expect([...tooltip.querySelectorAll('.model-request-tooltip-values span')].map(value => value.textContent)).toEqual(['21 次', '80.8%']);
    expect(tooltip.textContent).not.toMatch(/供应商|Token/);
    tooltip.innerHTML = chart.chartOption.tooltip.formatter({ dataIndex: 1 });
    expect(tooltip.querySelector('strong').textContent).toBe('<i>other-model</i>');
    expect(tooltip.querySelector('i')).toBeNull();
  });

  it('paginates whole model rows while keeping every recorded request in the chart', async () => {
    const models = Array.from({ length: 8 }, (_, index) => ({
      model: `model-${index + 1}`, requests: index === 0 ? 2000 : 8 - index, inputTokens: 10, uncachedInputTokens: 10, totalTokens: 10,
    }));
    services.api.get.mockResolvedValue({ ...stats(), models });
    await mount();

    const distribution = host.querySelector('.model-distribution');
    const names = () => [...distribution.querySelectorAll('.model-legend-name')].map(node => node.textContent);
    const pager = distribution.querySelector('nav[aria-label="模型列表分页"]');
    const legend = distribution.querySelector('.model-legend');
    const previous = pager.querySelector('[aria-label="上一页"]');
    const next = pager.querySelector('[aria-label="下一页"]');
    const pageStatus = () => pager.querySelector('[role="status"]').textContent;
    expect(legend.tabIndex).toBe(0);
    expect(legend.nextElementSibling).toBe(pager);
    expect(names()).toEqual(['model-1', 'model-2', 'model-3']);
    expect(pageStatus()).toContain('1 / 3');
    expect(previous.disabled).toBe(true);
    legend.querySelector('summary').click();
    legend.scrollTop = 64;
    next.click(); await flush();
    expect(names()).toEqual(['model-4', 'model-5', 'model-6']);
    expect(pageStatus()).toContain('2 / 3');
    expect(legend.scrollTop).toBe(0);
    next.click(); await flush();
    expect(names()).toEqual(['model-7', 'model-8']);
    expect(pageStatus()).toContain('3 / 3');
    expect(next.disabled).toBe(true);
    const option = distribution.querySelector('.usage-chart-stub').chartOption;
    expect(option.series[0].data).toHaveLength(8);
    expect(distribution.querySelector('.model-request-total dd').textContent).toBe('2,028');
    expect(option.tooltip.formatter({ dataIndex: 7 })).toContain('&lt;0.1%');
    previous.click(); await flush();
    expect(names()).toEqual(['model-4', 'model-5', 'model-6']);
    button('近 7 天').click(); await flush();
    expect(names()).toEqual(['model-1', 'model-2', 'model-3']);
  });

  it('counts model requests with missing usage without adding any tokens', async () => {
    const models = [{ model: 'usage-unavailable', requests: 1, unknownUsageRequests: 1 }];
    services.api.get.mockResolvedValue({ ...stats(), models });
    await mount();

    const distribution = host.querySelector('.model-distribution');
    expect(distribution.querySelector('.usage-chart-stub').chartOption.series[0].data[0]).toMatchObject({ name: 'usage-unavailable', value: 1 });
    expect(distribution.textContent).toContain('总 Token 0');
    expect(distribution.textContent).toContain('1 次请求未返回用量');
    expect(displayedMetrics(distribution)).toEqual({
      '输入 Token': '0', 缓存命中: '0', 缓存未命中: '0', '输出 Token': '0',
    });
    expect(distribution.querySelector('.model-pagination')).toBeNull();
  });
});
