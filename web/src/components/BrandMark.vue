<script setup>
// CoreLatex 品牌标志「排版者的星芒」：
// Computer Modern（TeX 标准字体）风格的衬线 C —— 高对比月牙 + 托架衬线，
// 开口处嵌入四芒星芒（AI），下方错位基线刻度致敬 TeX 的降字母排版。
// 取色全部来自外观 token：随配色与明暗模式同步（见 theme.css / lib/brandIcon.js）。
import { useId } from 'vue';

defineProps({
  size: { type: [Number, String], default: 40 },
  tile: { type: Boolean, default: true },
});
const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
const ink = `bm-ink-${uid}`;
const spark = `bm-spark-${uid}`;
const tileGrad = `bm-tile-${uid}`;
</script>

<template>
  <svg :width="size" :height="size" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" focusable="false">
    <defs>
      <linearGradient :id="ink" x1="14" y1="12" x2="34" y2="38" gradientUnits="userSpaceOnUse">
        <stop style="stop-color: var(--accent-hover)" />
        <stop offset="1" style="stop-color: var(--accent)" />
      </linearGradient>
      <linearGradient :id="spark" x1="31" y1="20" x2="39" y2="29" gradientUnits="userSpaceOnUse">
        <stop style="stop-color: color-mix(in srgb, var(--accent-warm) 72%, var(--surface-raised))" />
        <stop offset="1" style="stop-color: var(--accent-warm)" />
      </linearGradient>
      <linearGradient :id="tileGrad" x1="6" y1="2" x2="42" y2="46" gradientUnits="userSpaceOnUse">
        <stop style="stop-color: var(--surface-raised)" />
        <stop offset="1" style="stop-color: color-mix(in srgb, var(--accent) 8%, var(--surface-raised))" />
      </linearGradient>
    </defs>

    <template v-if="tile">
      <rect x="1" y="1" width="46" height="46" rx="12.5" :fill="`url(#${tileGrad})`" stroke="var(--accent)" stroke-opacity="0.28" />
      <path d="M14.5 2.5h19" stroke="var(--mark-hi)" stroke-width="1.4" stroke-linecap="round" />
    </template>

    <!-- 衬线 C：高对比月牙，外弧微 flare 长出衬线暗示（单路径，无接缝） -->
    <path
      d="M33.19 15.31 A13 13 0 1 0 33.19 33.69 L31.91 29.98 A8.9 8.9 0 1 1 31.91 19.02 Z"
      :fill="`url(#${ink})`"
    />

    <!-- AI 四芒星芒，嵌在 C 的开口中 -->
    <path
      d="M34.8 19.7 C35.35 22.6 36.4 23.65 39.4 24.5 C36.4 25.35 35.35 26.4 34.8 29.3 C34.25 26.4 33.2 25.35 30.2 24.5 C33.2 23.65 34.25 22.6 34.8 19.7 Z"
      :fill="`url(#${spark})`"
    />

    <!-- 错位基线刻度：TeX 降字母排版的致意 -->
    <rect x="32.9" y="35.5" width="4.4" height="1.7" rx="0.85" fill="var(--accent)" fill-opacity="0.45" />
  </svg>
</template>
