<script setup>
// ECharts 薄封装：按需引入核心模块（柱状/折线 + 提示/图例/网格），自动响应容器尺寸与主题变化。
// 用法：<UsageChart :option="chartOption" :height="180" />
import { ref, watch, onMounted, onBeforeUnmount } from 'vue';
import * as echarts from 'echarts/core';
import { BarChart, LineChart, PieChart } from 'echarts/charts';
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

echarts.use([BarChart, LineChart, PieChart, GridComponent, TooltipComponent, LegendComponent, DataZoomComponent, CanvasRenderer]);

const props = defineProps({
  option: { type: Object, required: true },
  height: { type: [Number, String], default: 180 },
});

const el = ref(null);
let chart = null;
let ro = null;

function render() {
  if (!chart) return;
  chart.setOption(props.option, true);
}

onMounted(() => {
  chart = echarts.init(el.value);
  render();
  ro = new ResizeObserver(() => chart?.resize());
  ro.observe(el.value);
});

onBeforeUnmount(() => {
  ro?.disconnect();
  chart?.dispose();
  chart = null;
});

watch(() => props.option, render, { deep: true });
</script>

<template>
  <div ref="el" class="usage-chart" :style="{ height: typeof height === 'number' ? `${height}px` : height }" />
</template>

<style scoped>
.usage-chart {
  width: 100%;
}
</style>
