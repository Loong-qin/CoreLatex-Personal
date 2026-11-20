<template>
  <section class="file-preview" aria-label="文件预览">
    <header class="preview-header">
      <div class="preview-title">
        <span class="preview-icon">{{ kind === 'pdf' ? 'PDF' : kind === 'image' ? 'IMG' : kind === 'media' ? 'MEDIA' : 'FILE' }}</span>
        <div>
          <strong>{{ basename(path) }}</strong>
          <small>{{ label }}</small>
        </div>
      </div>
      <button class="download-button" type="button" :disabled="!path" @click="download">下载</button>
    </header>

    <div v-if="loading" class="preview-state">
      <span class="spinner" aria-hidden="true"></span>
      <span>正在加载文件…</span>
    </div>
    <div v-else-if="error" class="preview-state error-state">
      <strong>文件预览失败</strong>
      <span>{{ error }}</span>
      <button type="button" class="retry-button" @click="loadFile">重新加载</button>
    </div>
    <div v-else-if="kind === 'image'" class="image-stage">
      <img :src="objectUrl" :alt="basename(path)" @error="error = '浏览器无法解码此图像格式'" />
    </div>
    <div v-else-if="kind === 'pdf'" class="pdf-stage">
      <div class="pdf-toolbar">
        <button type="button" :disabled="page <= 1" @click="setPage(page - 1)">上一页</button>
        <span>第 {{ page }} / {{ totalPages || 1 }} 页</span>
        <button type="button" :disabled="page >= totalPages" @click="setPage(page + 1)">下一页</button>
      </div>
      <div class="pdf-canvas-wrap">
        <canvas ref="canvasEl"></canvas>
      </div>
    </div>
    <div v-else-if="kind === 'media'" class="media-stage">
      <video v-if="mediaType === 'video'" :src="mediaUrl" controls preload="metadata"></video>
      <audio v-else :src="mediaUrl" controls preload="metadata"></audio>
    </div>
    <div v-else class="preview-state unsupported-state">
      <div class="file-badge">{{ extension || 'BIN' }}</div>
      <strong>该文件无法在编辑器中修改</strong>
      <span>可以下载原文件，或使用系统应用打开。</span>
    </div>
  </section>
</template>

<script setup>
import { computed, markRaw, nextTick, onBeforeUnmount, onActivated, onDeactivated, ref, shallowRef, watch } from 'vue';
import { api } from '../../api.js';
import { useProjectContext } from '../../lib/projectContext.js';
import { projectFileUrl, downloadProjectFile } from '../../lib/projectFileUrl.js';
import { loadPdf, renderPage } from '../../lib/pdfDocument.js';

const props = defineProps({
  projectId: { type: [Number, String], required: true },
  path: { type: String, required: true },
});

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp', '.avif', '.ico']);
const VIDEO_EXTS = new Set(['.mp4', '.webm', '.ogg', '.mov']);
const AUDIO_EXTS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.flac']);
const kind = computed(() => {
  const ext = extension.value;
  if (ext === '.pdf') return 'pdf';
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext) || AUDIO_EXTS.has(ext)) return 'media';
  return 'binary';
});
const mediaType = computed(() => VIDEO_EXTS.has(extension.value) ? 'video' : 'audio');
const extension = computed(() => {
  const i = props.path.lastIndexOf('.');
  return i >= 0 ? props.path.slice(i).toLowerCase() : '';
});
const label = computed(() => kind.value === 'pdf' ? 'PDF 文档' : kind.value === 'image' ? '图像文件' : kind.value === 'media' ? '媒体文件' : '二进制文件');
const basename = (value) => value.split('/').pop() || value;

const loading = ref(false);
const error = ref('');
const objectUrl = ref('');
const canvasEl = ref(null);
const pdfDoc = shallowRef(null);
const page = ref(1);
const totalPages = ref(0);
const projectContext = useProjectContext();
const componentActive = ref(true);
const active = computed(() => componentActive.value && (projectContext?.active.value ?? true));
const mediaUrl = computed(() => projectFileUrl(props.projectId, props.path));
let renderTask = null;
let renderGeneration = 0;
let renderChain = Promise.resolve();
let requestId = 0;
let controller = null;
let needsLoad = true;
let disposed = false;

function destroyPdf(doc) { try { doc?.destroy()?.catch?.(() => {}); } catch {} }
function clearResource() {
  renderGeneration++;
  if (renderTask) { try { renderTask.cancel(); } catch {} renderTask = null; }
  destroyPdf(pdfDoc.value); pdfDoc.value = null;
  if (objectUrl.value) URL.revokeObjectURL(objectUrl.value);
  objectUrl.value = '';
  totalPages.value = 0;
  page.value = 1;
}

function renderPdfPage() {
  const generation = ++renderGeneration;
  try { renderTask?.cancel(); } catch {}
  renderChain = renderChain.catch(() => {}).then(async () => {
    const doc = pdfDoc.value, canvas = canvasEl.value;
    const current = () => !disposed && active.value && generation === renderGeneration && pdfDoc.value === doc;
    if (!doc || !canvas || !current()) return;
    const pageNo = page.value;
    const width = Math.max(1, canvas.parentElement?.clientWidth || 800);
    const firstPage = await doc.getPage(pageNo);
    if (!current()) return;
    const scale = Math.min(2, Math.max(0.5, width / firstPage.getViewport({ scale: 1 }).width));
    const rendered = await renderPage(doc, pageNo, canvas, scale);
    const task = rendered.task;
    if (!current()) { try { task.cancel(); } catch {} await task.promise.catch(() => {}); return; }
    renderTask = task;
    try { await task.promise; }
    catch (err) { if (current() && err?.name !== 'RenderingCancelledException') throw err; }
    finally { if (renderTask === task) renderTask = null; }
  });
  return renderChain;
}

async function loadFile() {
  const id = ++requestId;
  controller?.abort(); controller = null;
  clearResource();
  needsLoad = true;
  loading.value = false;
  error.value = '';
  if (disposed || !active.value) return;
  needsLoad = false;
  // Unsupported files only need a download link. Media uses the browser's
  // metadata/range requests rather than downloading a complete Blob.
  if (kind.value === 'binary' || kind.value === 'media') return;
  const pending = new AbortController(); controller = pending;
  const current = () => !disposed && id === requestId && !pending.signal.aborted;
  loading.value = true;
  try {
    const response = await api.raw(`/api/projects/${props.projectId}/file?path=${encodeURIComponent(props.path)}`, { signal: pending.signal });
    const blob = await response.blob();
    if (!current()) return;
    objectUrl.value = URL.createObjectURL(blob);
    if (kind.value === 'pdf') {
      const buffer = await blob.arrayBuffer();
      if (!current()) return;
      const candidate = await loadPdf(buffer);
      if (!current()) { destroyPdf(candidate); return; }
      pdfDoc.value = markRaw(candidate);
      totalPages.value = candidate.numPages;
      loading.value = false;
      await nextTick();
      if (current()) await renderPdfPage();
    }
  } catch (err) {
    if (current()) error.value = err?.message || '无法读取文件';
  } finally {
    if (current()) loading.value = false;
    if (controller === pending) controller = null;
  }
}

function setPage(next) { page.value = Math.max(1, Math.min(totalPages.value || 1, next)); }
function download() { downloadProjectFile(props.projectId, props.path); }

watch(() => [props.projectId, props.path], loadFile, { immediate: true });
watch(() => page.value, () => {
  if (kind.value === 'pdf' && !loading.value && active.value) renderPdfPage().catch(err => { error.value = err?.message || 'PDF 页面渲染失败'; });
});
watch(active, value => {
  if (!value) {
    if (controller) { needsLoad = true; requestId++; controller.abort(); controller = null; loading.value = false; }
    renderGeneration++; try { renderTask?.cancel(); } catch {}
  } else if (needsLoad) loadFile();
  else if (pdfDoc.value) nextTick(() => renderPdfPage().catch(() => {}));
});
onActivated(() => { componentActive.value = true; });
onDeactivated(() => { componentActive.value = false; });
onBeforeUnmount(() => { disposed = true; requestId++; controller?.abort(); controller = null; clearResource(); });

</script>

<style scoped>
.file-preview { display:flex; flex-direction:column; height:100%; min-height:0; background:var(--bg); color:var(--fg); }
.preview-header { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:10px 16px; border-bottom:1px solid var(--border); background:var(--bg2); flex:0 0 auto; }
.preview-title { display:flex; align-items:center; gap:10px; min-width:0; }
.preview-title strong { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.preview-title small { display:block; color:var(--fg-dim); margin-top:2px; font-size:11px; }
.preview-icon { color:var(--accent); font:600 10px var(--mono); border:1px solid currentColor; border-radius:4px; padding:4px 5px; }
.download-button,.retry-button,.pdf-toolbar button { border:1px solid var(--border); background:var(--bg3); color:var(--fg); border-radius:5px; padding:5px 10px; cursor:pointer; }
.download-button:hover,.retry-button:hover,.pdf-toolbar button:hover:not(:disabled) { background:var(--bg-hover); }
button:disabled { opacity:.45; cursor:not-allowed; }
.preview-state { flex:1; min-height:0; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:9px; color:var(--fg-dim); padding:24px; text-align:center; }
.preview-state strong { color:var(--fg); }
.error-state { color:var(--danger, #ef6b73); }
.error-state span { color:var(--fg-dim); max-width:460px; overflow-wrap:anywhere; }
.spinner { width:24px; height:24px; border:2px solid var(--border); border-top-color:var(--accent); border-radius:50%; animation:spin .8s linear infinite; }
@keyframes spin { to { transform:rotate(360deg); } }
.image-stage,.pdf-stage,.media-stage { flex:1; min-height:0; overflow:auto; display:flex; flex-direction:column; align-items:center; padding:20px; }
.image-stage img { max-width:100%; max-height:100%; object-fit:contain; box-shadow:0 8px 28px rgba(0,0,0,.25); background:#fff; }
.pdf-toolbar { display:flex; align-items:center; gap:12px; color:var(--fg-dim); margin-bottom:12px; flex:0 0 auto; }
.pdf-canvas-wrap { max-width:100%; overflow:auto; background:#fff; box-shadow:0 8px 28px rgba(0,0,0,.25); }
.pdf-canvas-wrap canvas { display:block; max-width:100%; height:auto; }
.media-stage video { width:min(100%, 860px); max-height:80%; background:#000; }
.media-stage audio { width:min(100%, 640px); }
.file-badge { font:600 15px var(--mono); color:var(--accent); border:1px solid var(--accent); border-radius:6px; padding:10px 14px; }

/* ---- visual refinement layer (presentation only) ---- */
.preview-header { border-bottom-color: color-mix(in srgb, var(--border) 78%, var(--bg2)); }
.preview-title strong { letter-spacing: -.01em; }
.preview-icon { border-radius: 6px; border-color: color-mix(in srgb, var(--accent) 35%, transparent); background: var(--accent-soft); color: var(--accent-hover); font-weight: 700; letter-spacing: .05em; }
.download-button,.retry-button,.pdf-toolbar button { border-radius: var(--radius-sm); font-weight: 550; transition: background-color var(--motion-hover) var(--ease-standard), border-color var(--motion-hover) var(--ease-standard), color var(--motion-hover) var(--ease-standard); }
.download-button:hover:not(:disabled),.retry-button:hover,.pdf-toolbar button:hover:not(:disabled) { border-color: color-mix(in srgb, var(--accent) 40%, var(--border)); color: var(--accent-hover); }
.preview-state { letter-spacing: .01em; }
.error-state strong { color: var(--danger); }
.spinner { border-color: color-mix(in srgb, var(--accent) 22%, var(--border)); border-top-color: var(--accent); }
.image-stage,.pdf-stage,.media-stage { scrollbar-width: thin; scrollbar-color: color-mix(in srgb, var(--fg-muted) 38%, transparent) transparent; }
.image-stage img { border-radius: 3px; box-shadow: var(--shadow-md), 0 0 0 1px rgba(20, 35, 27, 0.05); }
.pdf-toolbar { padding: 5px 10px; border: 1px solid color-mix(in srgb, var(--border) 80%, var(--bg2)); border-radius: 999px; background: var(--glass-g1-bg); box-shadow: var(--glass-highlight); font-variant-numeric: tabular-nums; }
.pdf-toolbar button { border-radius: 999px; padding: 4px 12px; }
.pdf-canvas-wrap { box-shadow: var(--shadow-md), 0 0 0 1px rgba(20, 35, 27, 0.05); }
.media-stage video { border-radius: var(--radius-md); box-shadow: var(--shadow-md); }
.file-badge { border-radius: var(--radius-md); border-color: color-mix(in srgb, var(--accent) 45%, transparent); background: var(--accent-soft); color: var(--accent-hover); letter-spacing: .04em; }
.unsupported-state strong { letter-spacing: -.01em; }
@media (prefers-reduced-motion: reduce) {
  .download-button,.retry-button,.pdf-toolbar button { transition: none; }
}
@media (forced-colors: active) {
  .preview-icon, .file-badge { background: Canvas; color: CanvasText; }
}
</style>