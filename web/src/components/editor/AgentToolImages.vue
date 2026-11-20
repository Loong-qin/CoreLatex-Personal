<script setup>
import { ref, computed, watch, nextTick, onBeforeUnmount, onDeactivated, onActivated } from 'vue';
import { api } from '../../api.js';
import { safeArtifactUrl } from '../../lib/toolPresentation.js';

const props = defineProps({ images: { type: Array, default: () => [] }, active: { type: Boolean, default: true } });
const assets = ref([]);
const selected = ref(-1);
const zoom = ref(1);
const dialog = ref(null);
const fit = ref(true);
let generation = 0;
let deactivated = false;
let returnFocus = null;
const current = computed(() => assets.value[selected.value]);

function close() {
  const wasOpen = selected.value >= 0;
  selected.value = -1;
  if (wasOpen && returnFocus?.isConnected) returnFocus.focus();
  returnFocus = null;
}
function release() {
  generation++;
  close();
  for (const item of assets.value) if (item.src) URL.revokeObjectURL(item.src);
  assets.value = [];
}
async function load() {
  release();
  if (!props.active || deactivated) return;
  const ticket = generation;
  assets.value = props.images.map(image => ({ ...image, src: '', state: 'loading', error: '' }));
  await Promise.all(assets.value.map(async item => {
    try {
      const url = safeArtifactUrl(item.url);
      if (!url) throw new Error('此记录没有可用的图像快照');
      const response = await api.raw(url);
      const blob = await response.blob();
      if (!/^image\/(png|jpeg|webp|gif)$/i.test(blob.type)) throw new Error('快照格式无法预览');
      if (ticket !== generation) return;
      item.src = URL.createObjectURL(blob);
      item.state = 'ready';
    } catch (error) {
      if (ticket !== generation) return;
      item.state = 'error';
      item.error = error.status === 404 || error.status === 410 ? '图像快照已过期或不可用' : '图像暂时无法加载';
    }
  }));
}
watch([() => props.active, () => JSON.stringify(props.images)], load, { immediate: true });
onBeforeUnmount(release);
onDeactivated(() => { deactivated = true; release(); });
onActivated(() => { deactivated = false; if (props.active && !assets.value.length) load(); });
async function open(index) {
  if (!assets.value[index]?.src) return;
  returnFocus = document.activeElement;
  selected.value = index;
  zoom.value = 1;
  fit.value = true;
  await nextTick();
  dialog.value?.querySelector('[aria-label="关闭预览"]')?.focus();
}
function move(direction) {
  for (let index = selected.value + direction; index >= 0 && index < assets.value.length; index += direction) {
    if (assets.value[index]?.src) { selected.value = index; zoom.value = 1; fit.value = true; break; }
  }
}
function resize(delta) { fit.value = false; zoom.value = Math.max(0.25, Math.min(4, Math.round((zoom.value + delta) * 100) / 100)); }
function onKey(event) {
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
  if (event.key === 'ArrowLeft') { event.preventDefault(); move(-1); }
  if (event.key === 'ArrowRight') { event.preventDefault(); move(1); }
  if (event.key === 'Tab') {
    const buttons = [...dialog.value.querySelectorAll('button:not(:disabled)')];
    const index = buttons.indexOf(document.activeElement);
    if ((event.shiftKey && index <= 0) || (!event.shiftKey && index === buttons.length - 1)) {
      event.preventDefault(); buttons[event.shiftKey ? buttons.length - 1 : 0]?.focus();
    }
  }
}
</script>

<template>
  <div class="tool-images">
    <p class="tool-image-caption">智能体看到的图像 · 点击放大</p>
    <div class="tool-image-grid">
      <figure v-for="(image, i) in assets" :key="image.id" class="tool-image-tile">
        <button v-if="image.src" type="button" class="tool-image-button" :aria-label="`放大预览：${image.label}`" @click="open(i)">
          <img :src="image.src" :alt="image.label" loading="lazy" @error="image.state = 'error'; image.error = '图像内容无法解码'" />
          <span class="tool-image-expand" aria-hidden="true">放大 ↗</span>
        </button>
        <div v-else class="tool-image-placeholder" :role="image.state === 'error' ? 'status' : undefined">{{ image.state === 'loading' ? '正在加载图像…' : image.error }}</div>
        <figcaption>{{ image.page ? `第 ${image.page} 页` : image.label }}</figcaption>
        <span v-if="image.src && image.state === 'error'" class="tool-image-error">{{ image.error }}</span>
      </figure>
    </div>
    <button v-if="assets.some(a => a.state === 'error')" type="button" class="tool-image-retry" @click="load">重新加载图像</button>
    <Teleport to="body">
      <div v-if="current?.src" class="tool-image-overlay" @click.self="close" @keydown="onKey">
        <section ref="dialog" class="tool-image-dialog" role="dialog" aria-modal="true" aria-label="智能体图像预览" tabindex="-1">
          <header class="tool-image-toolbar">
            <span class="tool-image-title">{{ current.label }} <small>{{ selected + 1 }} / {{ assets.length }}</small></span>
            <button type="button" aria-label="上一张" :disabled="!assets.slice(0, selected).some(a => a.src)" @click="move(-1)">‹</button>
            <button type="button" aria-label="下一张" :disabled="!assets.slice(selected + 1).some(a => a.src)" @click="move(1)">›</button>
            <button type="button" aria-label="缩小" :disabled="!fit && zoom <= 0.25" @click="resize(-0.25)">−</button>
            <span class="tool-image-scale">{{ fit ? '适应' : `${Math.round(zoom * 100)}%` }}</span>
            <button type="button" aria-label="放大" :disabled="!fit && zoom >= 4" @click="resize(0.25)">＋</button>
            <button type="button" aria-label="适应窗口" @click="fit = true; zoom = 1">适应窗口</button>
            <button type="button" aria-label="关闭预览" @click="close">✕</button>
          </header>
          <div class="tool-image-stage" :class="{ fit }"><img :src="current.src" :alt="current.label" :style="fit ? {} : { width: `${zoom * 100}%`, maxWidth: 'none', maxHeight: 'none' }" /></div>
          <footer class="tool-image-footer">本次工具返回的图像快照 · ← → 切换 · Esc 关闭</footer>
        </section>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.tool-image-caption { margin: 0 0 8px; color: var(--fg-dim); font-size: 11px; }
.tool-image-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(105px, 1fr)); gap: 10px; }
.tool-image-tile { margin: 0; min-width: 0; }
.tool-image-button { position: relative; display: block; width: 100%; height: 170px; padding: 6px; border: 1px solid var(--border); border-radius: 7px; background: var(--bg, #fff); cursor: zoom-in; }
.tool-image-button img { width: 100%; height: 100%; object-fit: contain; }
.tool-image-button:hover { border-color: var(--accent); }
.tool-image-expand { position: absolute; bottom: 7px; right: 7px; padding: 3px 6px; border-radius: 4px; background: #172033c9; color: #fff; font-size: 10px; }
figcaption { font-size: 11px; color: var(--fg-dim); margin-top: 5px; text-align: center; overflow-wrap: anywhere; }
.tool-image-placeholder { min-height: 100px; display: grid; place-items: center; padding: 12px; text-align: center; background: var(--bg2); border: 1px dashed var(--border); border-radius: 7px; font-size: 11px; color: var(--fg-dim); }
.tool-image-error { display: block; color: var(--danger); font-size: 11px; }
.tool-image-retry { border: 0; background: none; color: var(--accent); padding: 8px 0 0; cursor: pointer; font-size: 11px; }
.tool-image-overlay { position: fixed; inset: 0; z-index: 5000; background: #0d1426b8; display: flex; padding: 24px; align-items: center; justify-content: center; }
.tool-image-dialog { display: flex; flex-direction: column; width: min(1120px, 96vw); height: min(950px, 94vh); overflow: hidden; background: var(--bg, #fff); color: var(--fg, #182034); border: 1px solid var(--border, #dce2ed); border-radius: 12px; box-shadow: 0 24px 90px #0005; }
.tool-image-toolbar { display: flex; gap: 7px; align-items: center; padding: 12px; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
.tool-image-title { flex: 1; min-width: 120px; font-size: 13px; font-weight: 600; }
.tool-image-title small { font-weight: 400; margin-left: 8px; color: var(--fg-dim); }
.tool-image-toolbar button { background: var(--bg2, #f1f4f8); color: inherit; border: 1px solid var(--border, #dce2ed); border-radius: 5px; padding: 5px 9px; cursor: pointer; min-height: 30px; }
.tool-image-toolbar button:disabled { opacity: .35; cursor: default; }
.tool-image-scale { width: 40px; text-align: center; font-size: 12px; }
.tool-image-stage { flex: 1; min-height: 0; overflow: auto; background: #dce1e9; padding: 16px; text-align: center; }
.tool-image-stage.fit { display: flex; align-items: center; justify-content: center; }
.tool-image-stage img { display: block; margin: auto; box-shadow: 0 2px 12px #0002; }
.tool-image-stage.fit img { max-width: 100%; max-height: 100%; object-fit: contain; }
.tool-image-footer { padding: 8px 12px; font-size: 11px; color: var(--fg-dim); text-align: center; }
button:focus-visible { outline: 2px solid var(--accent, #4c70d8); outline-offset: 3px; }
@media (max-width: 600px) { .tool-image-overlay { padding: 8px; } .tool-image-toolbar { gap: 4px; } .tool-image-title { flex-basis: 100%; } }

/* Visual refinement: paper-toned viewer, sage scrim, token motion. */
.tool-image-caption { letter-spacing: .02em; }
.tool-image-button {
  border-radius: var(--radius-sm);
  border-color: color-mix(in srgb, var(--border) 82%, var(--bg2));
  background: var(--surface-raised);
  transition: border-color var(--motion-hover) var(--ease-standard), box-shadow var(--motion-hover) var(--ease-standard);
}
.tool-image-button:hover { border-color: color-mix(in srgb, var(--accent) 55%, var(--border)); box-shadow: var(--shadow-sm); }
.tool-image-expand {
  border-radius: 999px;
  padding: 3px 8px;
  background: color-mix(in srgb, var(--fg) 78%, transparent);
  color: var(--on-accent);
  letter-spacing: .02em;
}
.tool-image-placeholder {
  border-radius: var(--radius-sm);
  border-color: color-mix(in srgb, var(--fg-muted) 40%, var(--border));
  background: var(--surface-muted);
}
.tool-image-retry { border-radius: 5px; text-underline-offset: 3px; transition: color var(--motion-hover) var(--ease-standard); }
.tool-image-retry:hover { color: var(--accent-hover); text-decoration: underline; }
.tool-image-overlay {
  background: color-mix(in srgb, var(--fg) 52%, transparent);
  -webkit-backdrop-filter: blur(6px);
  backdrop-filter: blur(6px);
}
.tool-image-dialog {
  background: var(--glass-g1-bg);
  border-color: var(--glass-edge);
  border-radius: var(--radius-lg);
  box-shadow: var(--glass-highlight), var(--shadow-lg);
  animation: tool-image-in var(--motion-surface) var(--ease-standard);
}
@keyframes tool-image-in { from { opacity: 0; transform: translateY(6px) scale(.985); } to { opacity: 1; transform: translateY(0) scale(1); } }
.tool-image-toolbar { border-bottom-color: color-mix(in srgb, var(--border) 75%, var(--bg2)); }
.tool-image-title { letter-spacing: -.01em; }
.tool-image-title small { font-variant-numeric: tabular-nums; }
.tool-image-toolbar button {
  background: var(--surface-muted);
  border-radius: var(--radius-sm);
  transition: background-color var(--motion-hover) var(--ease-standard), border-color var(--motion-hover) var(--ease-standard);
}
.tool-image-toolbar button:hover:not(:disabled) { background: var(--bg-hover); border-color: color-mix(in srgb, var(--accent) 35%, var(--border)); }
.tool-image-scale { font-variant-numeric: tabular-nums; color: var(--fg-dim); }
.tool-image-stage { background: var(--bg3); }
.tool-image-stage img { box-shadow: var(--shadow-sm); }
@media (prefers-reduced-motion: reduce) {
  .tool-image-dialog { animation: none; }
  .tool-image-button, .tool-image-retry, .tool-image-toolbar button { transition: none; }
}
@media (forced-colors: active) {
  .tool-image-overlay { background: Canvas; -webkit-backdrop-filter: none; backdrop-filter: none; }
  .tool-image-dialog { background: Canvas; box-shadow: none; animation: none; }
  .tool-image-expand { background: Canvas; color: CanvasText; border: 1px solid CanvasText; }
}
</style>
