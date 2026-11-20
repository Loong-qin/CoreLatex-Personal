<script setup>
// 编辑器右栏 PDF 预览面板：编译控制 + pdfjs 连续滚动 viewer + 错误警告 + SyncTeX 双向跳转
import { ref, shallowRef, computed, watch, onMounted, onActivated, onDeactivated, onBeforeUnmount, nextTick } from 'vue';
import { useEditorStore } from '../../stores/editor.js';
import { useUiStore } from '../../stores/ui.js';
import { useAgentStore } from '../../stores/agent.js';
import { api, getToken } from '../../api.js';
import { useProjectContext } from '../../lib/projectContext.js';
import { hasScrollLayout } from '../../lib/retainedScroll.js';
import { loadPdf, renderPage } from '../../lib/pdfDocument.js';
import { fitScale, clampPage, pageWrapStyleFor } from '../../lib/pdfGeometry.js';

const props = defineProps({ active: { type: Boolean, default: true } });
const projectContext = useProjectContext();
const emit = defineEmits(['jump-to-code']);
const store = useEditorStore();
const ui = useUiStore();
const agent = useAgentStore();
const panelActive = computed(() => props.active && (projectContext?.active.value ?? true) && (!('rightTab' in store) || store.rightTab === 'pdf'));

const engines = ['xelatex', 'pdflatex', 'lualatex'];
const engine = ref('pdflatex');
const texVersion = ref(store.project?.texVersion || '2024');
const texRuntimes = ref([]);
const savingCompileSettings = ref(false);
let compileSettingsRequest = 0;
watch(() => [store.projectId, store.projectVersion], () => {
  ++compileSettingsRequest;
  savingCompileSettings.value = false;
  engine.value = engines.includes(store.project?.compileEngine) ? store.project.compileEngine : 'pdflatex';
  texVersion.value = store.project?.texVersion || '2024';
});
const runtimesLoading = ref(false);
const runtimeError = ref('');
let runtimesRequest = 0;
const selectableRuntimes = computed(() => {
  const options = texRuntimes.value.filter(runtime => runtime.enabled && runtime.available);
  if (!options.some(runtime => runtime.version === texVersion.value)) {
    const known = texRuntimes.value.find(runtime => runtime.version === texVersion.value);
    options.unshift({ version: texVersion.value, label: known?.label || (texVersion.value === 'system' ? '系统 TeX Live' : `TeX Live ${texVersion.value}`), enabled: false, available: false });
  }
  return options;
});
watch(() => store.project?.texVersion, value => { texVersion.value = value || '2024'; });
async function loadRuntimes() {
  if (!panelActive.value || !store.projectId) return;
  const request = ++runtimesRequest;
  const projectId = store.projectId;
  runtimesLoading.value = true;
  try {
    const result = await api.get('/api/tex/runtimes');
    if (disposed || request !== runtimesRequest || projectId !== store.projectId) return;
    if (!Array.isArray(result?.versions)) throw new Error('未能读取 TeX Live 版本');
    texRuntimes.value = result.versions;
    runtimeError.value = '';
  } catch (e) {
    if (!disposed && request === runtimesRequest && projectId === store.projectId) runtimeError.value = 'TeX Live 版本读取失败，请重试';
  } finally { if (!disposed && request === runtimesRequest) runtimesLoading.value = false; }
}
watch(() => [store.projectId, panelActive.value], ([projectId, active]) => { if (projectId && active) loadRuntimes(); });
watch(
  () => store.project?.compileEngine,
  (v) => { if (v && engines.includes(v)) engine.value = v; },
  { immediate: true }
);

const scrollEl = ref(null);
const pageInputEl = ref(null);
// pdfjs 的 PDFDocumentProxy 含 class 私有字段，必须 shallowRef 存放，
// 否则 Vue 的深层响应式 Proxy 会触发 "Cannot read from private field"
const pdfDoc = shallowRef(null);
const totalPages = ref(0);
const pageNum = ref(1);
const pageInput = ref('1');
const pageW = ref(0); // 基准页（第 1 页）宽（pt），供 fitScale 使用
const pageH = ref(0);
const pageSizes = ref([]); // 每页真实尺寸（pt），未渲染页先用基准尺寸占位
const scaleMode = ref('fit-width'); // 'fit-width' | 'fit-page' | 数字
// 'scroll' 连续滚动 | 'page' 单页（仅渲染当前页），localStorage 持久化
const viewMode = ref(
  localStorage.getItem('corelatex.pdfViewMode') === 'page' ? 'page' : 'scroll'
);
const containerW = ref(0);
const containerH = ref(0);
const loading = ref(false);
const loadError = ref('');
const issuesCollapsed = ref(false);
const highlight = ref(null);
const loadedPdfStamp = ref(-1);
const loadedPdfJobId = ref(null);
const blankPage = ref(0); // 自检发现渲染为空白的页码（0 = 无）
const blankDismissed = ref(0); // 用户已忽略提示的页码

// DOM 引用与渲染状态不进响应式系统（canvas 元素 + pdfjs 内部对象）
const wrapEls = new Map(); // pageNum -> .page-wrap 元素
const canvasEls = new Map(); // pageNum -> canvas 元素
const inView = new Map(); // pageNum -> intersectionRatio（含 rootMargin 预取区）
const pending = new Set(); // 等待渲染的页码
const rendered = new Map(); // pageNum -> 已渲染时的 scale

let activeTask = null;
let renderChain = Promise.resolve();
let highlightTimer = null;
let resizeObserver = null;
let io = null;
let measureTimer = null;
let visible = panelActive.value;
let disposed = false;
let documentRequest = 0;
let loadController = null;
let pendingDocumentReload = false;
let renderGeneration = 0;
let suspendedAnchor = null;
let suspendedScrollTop = 0;
let suspendedScrollLeft = 0;
let lastScrollTop = 0;
let lastScrollLeft = 0;
let lastViewAnchor = null;
const blankRetried = new Set(); // 已自动重渲过仍空白的页

const running = computed(() => store.compile.status === 'running');
const hasPdf = computed(() => !!pdfDoc.value);
const issues = computed(() => [
  ...store.compile.errors.map((e) => ({ ...e, kind: 'error' })),
  ...store.compile.warnings.map((w) => ({ ...w, kind: 'warning' })),
]);

const effectiveScale = computed(() =>
  fitScale({
    mode: scaleMode.value,
    containerW: containerW.value,
    containerH: containerH.value,
    pageW: pageW.value,
    pageH: pageH.value,
    currentScale: 1,
  })
);
const zoomPct = computed(() => Math.round(effectiveScale.value * 100));
// 单页模式只挂载当前页，复用同一套占位/IO/渲染管线
const displayedPages = computed(() => {
  if (!totalPages.value) return [];
  if (viewMode.value === 'page') return [clampPage(pageNum.value, totalPages.value)];
  return Array.from({ length: totalPages.value }, (_, i) => i + 1);
});

function measure() {
  if (!visible || disposed || !scrollEl.value || !scrollEl.value.clientWidth || !scrollEl.value.clientHeight) return;
  // 预留四周各 16px 内边距
  containerW.value = Math.max(0, scrollEl.value.clientWidth - 32);
  containerH.value = Math.max(0, scrollEl.value.clientHeight - 32);
  if (suspendedAnchor) {
    const anchor = suspendedAnchor;
    nextTick(() => {
      if (!visible || disposed || !hasScrollLayout(scrollEl.value)) return;
      restoreViewAnchor(anchor);
      scrollEl.value.scrollLeft = suspendedScrollLeft;
      suspendedAnchor = null;
    });
  }
}

function pageSizePt(n) {
  return pageSizes.value[n - 1] || { w: pageW.value, h: pageH.value };
}

function updatePageSize(n, viewport) {
  if (pageSizes.value[n - 1]) return;
  const sizes = pageSizes.value.slice();
  sizes[n - 1] = { w: viewport.width, h: viewport.height };
  pageSizes.value = sizes;
}

async function measurePageSizes(document) {
  const current = () => visible && !disposed && document === pdfDoc.value;
  for (let start = 2; start <= document.numPages && current(); start += 8) {
    const batch = [];
    for (let n = start; n <= Math.min(start + 7, document.numPages); n++) {
      if (!pageSizes.value[n - 1]) {
        batch.push(document.getPage(n).then(page => ({ n, viewport: page.getViewport({ scale: 1 }) })));
      }
    }
    if (!batch.length) continue;
    const pages = await Promise.allSettled(batch);
    if (!current()) return;
    const sizes = pageSizes.value.slice();
    let layoutChanged = false;
    for (const result of pages) {
      if (result.status !== 'fulfilled') continue;
      const { n, viewport } = result.value;
      if (sizes[n - 1]) continue;
      sizes[n - 1] = { w: viewport.width, h: viewport.height };
      layoutChanged ||= viewport.width !== pageW.value || viewport.height !== pageH.value;
    }
    const anchor = layoutChanged ? captureViewAnchor() : null;
    pageSizes.value = sizes;
    if (anchor) {
      await nextTick();
      if (current()) restoreViewAnchor(anchor);
    }
  }
}
// 页面占位样式：fit 系模式布局纯 CSS 驱动，不随 measure() 滞后而溢出（见 pageWrapStyleFor）
function pageWrapStyle(n) {
  return pageWrapStyleFor(scaleMode.value, pageSizePt(n), effectiveScale.value, ptToPxW(n));
}
// fit-page 目标宽（pt→px），与 fitScale 同源；min(100%, px) 已在样式层兜底
function ptToPxW(n) {
  return pageSizePt(n).w * effectiveScale.value;
}

function setWrapRef(n, el) {
  if (el) {
    wrapEls.set(n, el);
    if (io && visible) io.observe(el);
  } else {
    const old = wrapEls.get(n);
    if (old && io) io.unobserve(old);
    wrapEls.delete(n);
    inView.delete(n);
  }
}
function setCanvasRef(n, el) {
  if (el) {
    canvasEls.set(n, el);
  } else {
    canvasEls.delete(n);
    // canvas 卸载（如单页模式翻页）后位图已销毁，清除已渲染标记以便重绘
    rendered.delete(n);
  }
}

// ---------- 渲染队列（每个面板实例内串行） ----------
// renderPage 内部有 await（getPage），并发调用会在同一 canvas 上重叠 render()
// 触发 pdfjs 报错；且 pdfjs 同一文档多 canvas 并发渲染也会互相挤压。
// 用 promise 链保证同一时刻只有一个渲染任务；排队中的页若已滚出
// 预取范围或缩放已变化则直接跳过（快速滚动只画最终停留的页）。
function enqueueRender(n) {
  if (!visible || disposed || !pdfDoc.value) return;
  if (rendered.get(n) === effectiveScale.value) return;
  pending.add(n);
  renderChain = renderChain.catch(() => {}).then(pumpOnce);
}

function pumpOnce() {
  if (!visible || disposed || !pdfDoc.value || !pending.size) return;
  const scale = effectiveScale.value;
  // 丢弃已离开预取范围或已按当前缩放渲染的过期请求
  for (const n of [...pending]) {
    if (!inView.has(n) || rendered.get(n) === scale) pending.delete(n);
  }
  if (!pending.size) return;
  // 优先渲染离视口中心最近的页
  const mid = scrollEl.value
    ? scrollEl.value.scrollTop + scrollEl.value.clientHeight / 2
    : 0;
  let best = null;
  let bestDist = Infinity;
  for (const n of pending) {
    const wrap = wrapEls.get(n);
    if (!wrap) { pending.delete(n); continue; }
    const d = Math.abs(wrap.offsetTop + wrap.offsetHeight / 2 - mid);
    if (d < bestDist) { bestDist = d; best = n; }
  }
  if (best == null) { pending.clear(); return; }
  pending.delete(best);
  return renderOne(best);
}

async function renderOne(n) {
  const canvas = canvasEls.get(n);
  const document = pdfDoc.value;
  if (!visible || disposed || !canvas || !document) return;
  const generation = renderGeneration;
  const current = () => visible && !disposed && generation === renderGeneration && pdfDoc.value === document;
  const scale = effectiveScale.value;
  let ownedTask;
  try {
    const { page, task } = await renderPage(document, n, canvas, scale, { cssSize: false });
    ownedTask = task;
    if (!current()) {
      try { task.cancel(); } catch {}
      await task.promise.catch(() => {});
      return;
    }
    activeTask = task;
    const base = page.getViewport({ scale: 1 });
    updatePageSize(n, base);
    await task.promise;
    if (!current()) return;
    if (scale === effectiveScale.value) {
      rendered.set(n, scale);
      if (isCanvasLikelyBlank(canvas)) {
        if (blankRetried.has(n)) blankPage.value = n;
        else {
          blankRetried.add(n);
          rendered.delete(n);
          enqueueRender(n);
        }
      } else {
        blankRetried.delete(n);
        if (blankPage.value === n) blankPage.value = 0;
      }
    } else enqueueRender(n);
    loadError.value = '';
  } catch (e) {
    if (current() && e?.name !== 'RenderingCancelledException') {
      console.error('PDF 渲染失败', e);
      loadError.value = `渲染失败: ${e?.message || e}`;
    }
  } finally {
    if (activeTask === ownedTask) activeTask = null;
  }
}

// 抽样 16×16 判定画布是否整页空白（读图过重时只看缩略位图）
function isCanvasLikelyBlank(canvas) {
  try {
    const probe = document.createElement('canvas');
    probe.width = 16;
    probe.height = 16;
    const ctx = probe.getContext('2d');
    if (!ctx) return false;
    ctx.drawImage(canvas, 0, 0, 16, 16);
    const { data } = ctx.getImageData(0, 0, 16, 16);
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] !== 0 && (data[i] < 245 || data[i + 1] < 245 || data[i + 2] < 245)) return false;
    }
    return true;
  } catch {
    return false; // 读不出像素（跨域等）时按非空白处理
  }
}

// 视口锚点：缩放/容器尺寸变化时内容总高度会变，绝对 scrollTop 不再指向同一内容，
// 用“视口顶部所在页 + 页内偏移比例”定位，重排后恢复到同一阅读位置
function captureViewAnchor() {
  if (!visible || !pdfDoc.value || !hasScrollLayout(scrollEl.value)) return null;
  if (viewMode.value !== 'scroll') {
    const denom = scrollEl.value.scrollHeight - scrollEl.value.clientHeight;
    return { whole: denom > 0 ? scrollEl.value.scrollTop / denom : 0 };
  }
  const top = scrollEl.value.scrollTop + 16; // 容器 padding 16px
  let best = null;
  for (const [n, wrap] of wrapEls) {
    if (wrap.offsetTop > top || !wrap.offsetHeight) continue;
    if (!best || wrap.offsetTop > best.offsetTop) {
      best = { page: n, offsetTop: wrap.offsetTop, height: wrap.offsetHeight };
    }
  }
  if (!best) return null;
  const ratio = Math.min(1, Math.max(0, (top - best.offsetTop) / best.height));
  return { page: best.page, ratio };
}

function restoreViewAnchor(anchor) {
  if (!visible || disposed || !anchor || !hasScrollLayout(scrollEl.value)) return;
  if (anchor.whole != null) {
    const denom = Math.max(0, scrollEl.value.scrollHeight - scrollEl.value.clientHeight);
    scrollEl.value.scrollTop = Math.round(anchor.whole * denom);
    return;
  }
  const wrap = wrapEls.get(anchor.page);
  if (!wrap) return;
  scrollEl.value.scrollTop = Math.max(
    0,
    Math.round(wrap.offsetTop + anchor.ratio * wrap.offsetHeight - 16)
  );
}

// 缩放变化（缩放操作 / 抽屉拖宽 / 窗口尺寸改变 fit-width）→ 全部页标记为未渲染，
// 重排当前可见页，并按锚点恢复视口位置。canvas 无内联尺寸，CSS 100% 拉伸旧位图
// 到新占位尺寸，重渲染后恢复清晰度
watch(effectiveScale, () => {
  if (!visible || disposed || !pdfDoc.value) return;
  const anchor = suspendedAnchor || captureViewAnchor();
  rendered.clear();
  pending.clear();
  for (const n of inView.keys()) enqueueRender(n);
  // 等 Vue 应用新占位尺寸后再恢复，锚点按新高度换算
  const generation = renderGeneration;
  nextTick(() => { if (visible && !disposed && generation === renderGeneration) restoreViewAnchor(anchor); });
});

// 连续/单页切换：持久化并重建观察与滚动位置
watch(viewMode, async (mode) => {
  localStorage.setItem('corelatex.pdfViewMode', mode);
  rendered.clear();
  pending.clear();
  inView.clear();
  if (io) io.disconnect();
  await nextTick();
  if (io) {
    for (const el of wrapEls.values()) io.observe(el);
  }
  if (mode === 'scroll' && totalPages.value) scrollToPage(pageNum.value);
});

// ---------- IntersectionObserver：可见性 -> 渲染队列 + 当前页 ----------
function onIntersect(entries) {
  if (!visible || disposed) return;
  for (const entry of entries) {
    const n = Number(entry.target.dataset.page);
    if (!n) continue;
    if (entry.isIntersecting) {
      inView.set(n, entry.intersectionRatio);
      enqueueRender(n);
    } else {
      inView.delete(n);
    }
  }
  updateCurrentPage();
}

// 按可见比例最高的页更新页码显示（用户正在输入页码时不覆盖输入框）
function updateCurrentPage() {
  let best = 0;
  let bestRatio = 0;
  for (const [n, ratio] of inView) {
    if (ratio > bestRatio) { bestRatio = ratio; best = n; }
  }
  if (!best) return;
  pageNum.value = best;
  if (document.activeElement !== pageInputEl.value) {
    pageInput.value = String(best);
  }
}

function destroyDocument(document) {
  if (!document) return;
  try { Promise.resolve(document.destroy()).catch(() => {}); } catch {}
}

async function loadDocument() {
  const url = store.compile.pdfUrl;
  if (!url || disposed) return;
  if (!visible) { pendingDocumentReload = true; return; }
  const request = ++documentRequest;
  const stamp = store.pdfStamp;
  const jobId = store.compile.pdfJobId ?? null;
  pdfJumpRequest++;
  reverseJumpRequest++;
  reverseController?.abort();
  scrollMoveRequest++;
  loadController?.abort();
  const controller = new AbortController();
  loadController = controller;
  const current = () => !disposed && visible && request === documentRequest && store.pdfStamp === stamp;
  let candidate = null;
  pendingDocumentReload = false;
  loading.value = true;
  loadError.value = '';
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${getToken()}` }, signal: controller.signal, cache: 'no-store',
    });
    if (!current()) return;
    if (!res.ok) throw new Error(`下载 PDF 失败 (${res.status})`);
    const buf = await res.arrayBuffer();
    if (!current()) return;
    candidate = await loadPdf(buf);
    if (!current()) return;
    const first = await candidate.getPage(1);
    if (!current()) return;
    const base = first.getViewport({ scale: 1 });
    const prevPage = pageNum.value;
    const prevScrollTop = viewMode.value === 'scroll' && scrollEl.value ? scrollEl.value.scrollTop : null;
    const previous = pdfDoc.value;
    renderGeneration++;
    try { activeTask?.cancel(); } catch {}
    pdfDoc.value = candidate;
    loadedPdfStamp.value = stamp;
    loadedPdfJobId.value = jobId;
    candidate = null;
    destroyDocument(previous);
    totalPages.value = pdfDoc.value.numPages;
    const target = clampPage(prevPage, totalPages.value);
    pageNum.value = target;
    pageInput.value = String(target);
    highlight.value = null;
    blankPage.value = 0;
    blankRetried.clear();
    pageW.value = base.width;
    pageH.value = base.height;
    pageSizes.value = [{ w: base.width, h: base.height }];
    rendered.clear();
    pending.clear();
    inView.clear();
    io?.disconnect();
    await nextTick();
    if (!current()) return;
    measure();
    if (viewMode.value === 'scroll' && scrollEl.value) {
      const maxTop = Math.max(0, scrollEl.value.scrollHeight - scrollEl.value.clientHeight);
      setProgrammaticScrollTop(Math.min(prevScrollTop ?? 0, maxTop));
      enqueueRender(target);
    } else if (scrollEl.value) setProgrammaticScrollTop(0);
    if (io) for (const el of wrapEls.values()) io.observe(el);
    lastViewAnchor = captureViewAnchor();
    void measurePageSizes(pdfDoc.value);
    if (pendingPdfJump) {
      const jump = pendingPdfJump;
      pendingPdfJump = null;
      void jumpToPdf(jump);
    }
  } catch (e) {
    if (current() && e?.name !== 'AbortError') loadError.value = e.message || 'PDF 加载失败';
  } finally {
    destroyDocument(candidate);
    if (request === documentRequest) {
      loading.value = false;
      if (loadController === controller) loadController = null;
    }
  }
}

watch(() => store.pdfStamp, () => {
  if (store.compile.pdfUrl) loadDocument();
});

// ---------- 编译 ----------
async function saveCompileSelection(field) {
  const selected = field === 'engine' ? engine.value : texVersion.value;
  const previous = field === 'engine' ? store.project?.compileEngine || 'pdflatex' : store.project?.texVersion || '2024';
  if (selected === previous || savingCompileSettings.value) return;
  const request = ++compileSettingsRequest;
  const projectId = store.projectId;
  savingCompileSettings.value = true;
  try {
    const saved = await store.saveCompileSettings({ [field]: selected });
    if (disposed || request !== compileSettingsRequest || projectId !== store.projectId || saved === false) return;
  } catch (e) {
    if (disposed || request !== compileSettingsRequest || projectId !== store.projectId) return;
    engine.value = store.project?.compileEngine || 'pdflatex';
    texVersion.value = store.project?.texVersion || '2024';
    ui.error(e.message || '保存编译设置失败');
  } finally { if (!disposed && request === compileSettingsRequest) savingCompileSettings.value = false; }
}
async function doCompile() {
  if (running.value || savingCompileSettings.value) return;
  try {
    await store.compileProject(engine.value, texVersion.value);
  } catch (e) {
    // 含配额不足 403 等，ApiError.message 即后端 error 文案
    ui.error(e.message || '编译失败');
  }
}

// 把单条编译问题提交给智能体快速修复（约束收紧：只做最小修复）
function aiFix(it) {
  if (agent.streaming) {
    ui.error('智能体正在处理中，请等当前任务完成');
    return;
  }
  const kindText = it.kind === 'error' ? '错误' : '警告';
  const others = issues.value
    .filter((x) => x !== it)
    .map((x) => `- [${x.kind === 'error' ? '错误' : '警告'}] ${x.file}:${x.line} ${x.message}`);
  const msg = [
    `LaTeX 编译出现${kindText}，请快速修复：`,
    `文件：${it.file} 第 ${it.line} 行`,
    `信息：${it.message}`,
    others.length ? `同一次编译的其他问题（供参考，可一并做最小修复）：\n${others.join('\n')}` : '',
    '',
    '严格约束（必须遵守）：',
    '1. 只做修复上述问题所需的最小必要改动，禁止顺手改写、润色、优化或重排任何其他内容；',
    '2. 不得改动文章正文措辞、公式、图表与文档结构，除非修复该错误确实必需；',
    '3. 对正式文件的修改会进入变更审查，完成后说明改了什么、为什么这样改。',
  ].filter(Boolean).join('\n');
  store.sidebar = 'agent'; // 打开智能体面板，修复过程实时可见
  agent.sendMessage(store.projectId, msg, { currentFile: it.file || store.activeFile });
}

// ---------- 页码 / 缩放 ----------
function scrollToPage(n) {
  const wrap = wrapEls.get(n);
  if (!wrap || !scrollEl.value) return;
  scrollEl.value.scrollTop = wrap.offsetTop - 16;
  enqueueRender(n);
}
async function setPage(n) {
  if (!totalPages.value) return;
  const p = clampPage(n, totalPages.value);
  pageNum.value = p;
  pageInput.value = String(p);
  // 单页模式下 pageNum 变化会重挂载 page-wrap，等 DOM 更新后再定位/渲染
  await nextTick();
  scrollToPage(p);
}
function commitPageInput() {
  setPage(Number(pageInput.value));
}
function zoomIn() {
  scaleMode.value = Math.min(5, effectiveScale.value * 1.2);
}
function zoomOut() {
  scaleMode.value = Math.max(0.2, effectiveScale.value / 1.2);
}
// Ctrl/Cmd + 滚轮缩放 PDF；无修饰键时不拦截，保持正常滚动
function onWheelZoom(e) {
  if (!e.ctrlKey && !e.metaKey) return;
  if (!pdfDoc.value) return;
  e.preventDefault();
  if (e.deltaY < 0) zoomIn();
  else if (e.deltaY > 0) zoomOut();
}

// ---------- 下载 ----------
function saveBlob(blob, name) {
  const u = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = u;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(u), 5000);
}
async function downloadPdf() {
  if (!store.compile.pdfUrl) return;
  try {
    const res = await api.raw(store.compile.pdfUrl);
    saveBlob(await res.blob(), `${store.project?.name || 'output'}.pdf`);
  } catch (e) {
    ui.error(e.message || '下载 PDF 失败');
  }
}
async function downloadLog() {
  try {
    const res = await api.raw(store.compile.logUrl || `/api/projects/${store.projectId}/log`);
    saveBlob(await res.blob(), 'compile.log');
  } catch (e) {
    ui.error(e.message || '下载日志失败');
  }
}

// ---------- SyncTeX ----------
// 实际显示比例：以页框当前渲染宽度为准。fit 系模式下布局由 CSS 决定，
// effectiveScale(测量值)可能短暂滞后，坐标换算用它会产生偏移
function liveScale(n) {
  const wrap = wrapEls.get(n);
  const w = pageSizePt(n).w;
  return wrap && w > 0 ? wrap.clientWidth / w : effectiveScale.value;
}

let pendingPdfJump = null;
let pdfJumpRequest = 0;
let reverseJumpRequest = 0;
let reverseController = null;

// 代码 → PDF
async function jumpToPdf(hit) {
  const { page, x, y, rect, jobId } = hit;
  const document = pdfDoc.value;
  if (jobId != null && jobId !== store.compile.pdfJobId) return;
  if (!document || (jobId != null && jobId !== loadedPdfJobId.value)) {
    pendingPdfJump = hit;
    return;
  }
  pendingPdfJump = null;
  const request = ++pdfJumpRequest;
  scrollMoveRequest++;
  const p = clampPage(Number(page) || 1, totalPages.value);
  if (!pageSizes.value[p - 1]) {
    try {
      const targetPage = await document.getPage(p);
      if (disposed || document !== pdfDoc.value || request !== pdfJumpRequest) return;
      updatePageSize(p, targetPage.getViewport({ scale: 1 }));
    } catch { return; }
  }
  pageNum.value = p;
  pageInput.value = String(p);
  await nextTick();
  if (disposed || document !== pdfDoc.value || request !== pdfJumpRequest) return;
  enqueueRender(p);
  const size = pageSizePt(p);
  const left = Math.min(Math.max(0, rect?.x ?? (Number(x) - 3 || 0)), Math.max(0, size.w - 6));
  const top = Math.min(Math.max(0, rect?.y ?? (Number(y) - 8 || 0)), Math.max(0, size.h - 6));
  const width = Math.min(size.w - left, Math.max(6, rect?.width || 12));
  const height = Math.min(size.h - top, Math.max(6, rect?.height || 12));
  const scroll = scrollEl.value;
  const wrap = wrapEls.get(p);
  if (scroll && wrap) {
    setProgrammaticScrollTop(wrap.offsetTop + (top + height / 2) * liveScale(p) - scroll.clientHeight / 3);
    const targetX = wrap.offsetLeft + (left + width / 2) * liveScale(p);
    if (targetX < scroll.scrollLeft + 16 || targetX > scroll.scrollLeft + scroll.clientWidth - 16) {
      scroll.scrollLeft = Math.max(0, targetX - scroll.clientWidth / 2);
    }
  }
  highlight.value = {
    page: p,
    style: {
      left: `${left / size.w * 100}%`,
      top: `${top / size.h * 100}%`,
      width: `${width / size.w * 100}%`,
      height: `${height / size.h * 100}%`,
    },
  };
  clearTimeout(highlightTimer);
  highlightTimer = setTimeout(() => { highlight.value = null; }, 1500);
}

// PDF → 代码：双击反查（坐标按被双击页的 canvas 实际显示尺寸换算）
async function onDblClick(e, n) {
  const document = pdfDoc.value;
  if (!document) return;
  const canvas = canvasEls.get(n);
  if (!canvas) return;
  const request = ++reverseJumpRequest;
  const projectId = store.projectId;
  const stamp = loadedPdfStamp.value;
  const jobId = loadedPdfJobId.value;
  if (jobId == null && stamp !== store.pdfStamp) return;
  const rect = canvas.getBoundingClientRect();
  const size = pageSizePt(n);
  const scaleX = rect.width > 0 ? rect.width / size.w : liveScale(n);
  const scaleY = rect.height > 0 ? rect.height / size.h : liveScale(n);
  if (!(scaleX > 0) || !(scaleY > 0)) return;
  const x = Math.min(size.w, Math.max(0, (e.clientX - rect.left) / scaleX));
  const y = Math.min(size.h, Math.max(0, (e.clientY - rect.top) / scaleY));
  reverseController?.abort();
  const controller = new AbortController();
  reverseController = controller;
  const current = () => !disposed && visible && request === reverseJumpRequest && pdfDoc.value === document
    && store.projectId === projectId && (jobId != null || store.pdfStamp === stamp);
  try {
    const q = new URLSearchParams({ page: n, x: x.toFixed(2), y: y.toFixed(2) });
    if (jobId != null) q.set('jobId', jobId);
    const r = await api.get(`/api/projects/${projectId}/synctex/pdf?${q}`, { signal: controller.signal });
    if (current() && r.file && r.line) {
      const target = { file: r.file, line: r.line };
      if (Number.isInteger(r.column) && r.column > 0) target.column = r.column;
      emit('jump-to-code', target);
    }
  } catch (err) {
    if (!current() || controller.signal.aborted) return;
    if (err.status === 404) ui.toast('未找到对应的源码位置');
    else ui.error(err.message || 'SyncTeX 查询失败');
  } finally {
    if (reverseController === controller) reverseController = null;
  }
}

function jumpToCode(item) {
  emit('jump-to-code', { file: item.file, line: item.line });
}

// ---------- 程序化滚动 ----------
let scrollMoveRequest = 0;
function setProgrammaticScrollTop(top) {
  if (!scrollEl.value) return;
  const max = Math.max(0, scrollEl.value.scrollHeight - scrollEl.value.clientHeight);
  scrollEl.value.scrollTop = Math.min(max, Math.max(0, Number(top) || 0));
}

const pageOffsetsPt = computed(() => {
  const offsets = Array(totalPages.value + 1).fill(0);
  for (let i = 1; i <= totalPages.value; i++) offsets[i] = offsets[i - 1] + pageSizePt(i).h;
  return offsets;
});
function contentHeightPt() {
  return pageOffsetsPt.value[totalPages.value] || 0;
}
function posPtOf(page, y) {
  if (!totalPages.value) return null;
  const p = clampPage(Number(page) || 1, totalPages.value);
  return pageOffsetsPt.value[p - 1] + Math.min(Math.max(0, Number(y) || 0), pageSizePt(p).h);
}
function pageAtPos(value) {
  if (!totalPages.value) return null;
  const pos = Math.min(contentHeightPt(), Math.max(0, Number(value) || 0));
  const offsets = pageOffsetsPt.value;
  let lo = 1, hi = totalPages.value;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (pos <= offsets[mid]) hi = mid;
    else lo = mid + 1;
  }
  return { page: lo, y: Math.min(Math.max(0, pos - offsets[lo - 1]), pageSizePt(lo).h) };
}
async function scrollToContentPt(pos) {
  if (!pdfDoc.value || !visible || disposed || !scrollEl.value) return;
  const hit = pageAtPos(pos);
  if (!hit) return;
  const request = ++scrollMoveRequest;
  const pageChanged = viewMode.value === 'page' && hit.page !== pageNum.value;
  pageNum.value = hit.page;
  if (document.activeElement !== pageInputEl.value) pageInput.value = String(hit.page);
  if (pageChanged || (viewMode.value === 'page' && !wrapEls.has(hit.page))) await nextTick();
  if (disposed || !scrollEl.value || request !== scrollMoveRequest) return;
  enqueueRender(hit.page);
  const top = hit.y * liveScale(hit.page);
  const wrap = wrapEls.get(hit.page);
  if (wrap) setProgrammaticScrollTop(wrap.offsetTop + top - 16);
}
function rememberViewAnchor() {
  if (visible && !disposed && hasScrollLayout(scrollEl.value)) {
    lastViewAnchor = captureViewAnchor() || lastViewAnchor;
    lastScrollTop = scrollEl.value.scrollTop;
    lastScrollLeft = scrollEl.value.scrollLeft;
  }
}

function startVisibleWork() {
  if (!visible || disposed) return;
  measure();
  if (scrollEl.value) resizeObserver?.observe(scrollEl.value);
  if (!measureTimer) measureTimer = setInterval(measure, 1000);
  if (io) for (const el of wrapEls.values()) io.observe(el);
}

function pauseVisibleWork() {
  if (!visible) return;
  suspendedAnchor = captureViewAnchor() || lastViewAnchor || suspendedAnchor;
  if (hasScrollLayout(scrollEl.value)) {
    suspendedScrollTop = scrollEl.value.scrollTop;
    suspendedScrollLeft = scrollEl.value.scrollLeft;
  } else {
    suspendedScrollTop = lastScrollTop;
    suspendedScrollLeft = lastScrollLeft;
  }
  visible = false;
  reverseController?.abort();
  resizeObserver?.disconnect();
  io?.disconnect();
  clearInterval(measureTimer);
  measureTimer = null;
  renderGeneration++;
  pending.clear();
  inView.clear();
  try { activeTask?.cancel(); } catch {}
  if (loading.value) pendingDocumentReload = true;
  documentRequest++;
  loadController?.abort();
  loadController = null;
  loading.value = false;
}

onMounted(() => {
  loadRuntimes();
  resizeObserver = new ResizeObserver(measure);
  io = new IntersectionObserver(onIntersect, {
    root: scrollEl.value, rootMargin: '300px 0px', threshold: [0, 0.1, 0.25, 0.5, 0.75, 1],
  });
  if (scrollEl.value) {
    scrollEl.value.addEventListener('wheel', onWheelZoom, { passive: false });
    scrollEl.value.addEventListener('scroll', rememberViewAnchor, { passive: true });
  }
  startVisibleWork();
  if (store.compile.pdfUrl) loadDocument();
});
async function resumeVisibleWork() {
  if (!panelActive.value) return;
  const returning = !visible;
  visible = true;
  await nextTick();
  if (!visible || disposed) return;
  startVisibleWork();
  if (returning) {
    loadRuntimes();
    if (suspendedAnchor) restoreViewAnchor(suspendedAnchor);
    else if (scrollEl.value) scrollEl.value.scrollTop = suspendedScrollTop;
    if (scrollEl.value) scrollEl.value.scrollLeft = suspendedScrollLeft;
    if (hasScrollLayout(scrollEl.value)) suspendedAnchor = null;
  }
  if (pendingDocumentReload || (returning && !pdfDoc.value && !loading.value && store.compile.pdfUrl)) loadDocument();
  else if (returning && pdfDoc.value) void measurePageSizes(pdfDoc.value);
}
watch(panelActive, active => { if (active) resumeVisibleWork(); else pauseVisibleWork(); }, { flush: 'sync' });
onActivated(resumeVisibleWork);
onDeactivated(pauseVisibleWork);
onBeforeUnmount(() => {
  pauseVisibleWork();
  disposed = true;
  pdfJumpRequest++;
  reverseJumpRequest++;
  scrollMoveRequest++;
  pendingPdfJump = null;
  if (scrollEl.value) {
    scrollEl.value.removeEventListener('wheel', onWheelZoom);
    scrollEl.value.removeEventListener('scroll', rememberViewAnchor);
  }
  clearTimeout(highlightTimer);
  destroyDocument(pdfDoc.value);
  pdfDoc.value = null;
});

defineExpose({ jumpToPdf, scrollToContentPt, posPtOf, contentHeightPt });
</script>

<template>
  <div class="pdf-panel">
    <!-- 顶栏 -->
    <div class="toolbar">
      <div class="flex gap8">
        <button class="primary small" :disabled="running || savingCompileSettings" @click="doCompile">
          <span v-if="running" class="spin"></span>{{ running ? '编译中' : '重新编译' }}
        </button>
        <select v-model="engine" class="engine" aria-label="编译引擎" :disabled="savingCompileSettings || store.myRole === 'viewer'" @change="saveCompileSelection('engine')">
          <option v-for="e in engines" :key="e" :value="e">{{ e }}</option>
        </select>
        <select v-model="texVersion" class="engine tex-version" :title="selectableRuntimes.find(runtime => runtime.version === texVersion)?.label" aria-label="TeX Live 版本" :disabled="savingCompileSettings || store.myRole === 'viewer'" @focus="loadRuntimes" @change="saveCompileSelection('texVersion')">
          <option v-for="runtime in selectableRuntimes" :key="runtime.version" :value="runtime.version" :disabled="!runtime.enabled || !runtime.available">{{ runtime.version === 'system' ? '系统 ' + (runtime.detectedVersion || 'TeX') : 'TeX ' + runtime.version }}{{ !runtime.available || !runtime.enabled ? ' · 暂不可用' : '' }}</option>
        </select>
        <button class="ghost small icon" title="下载 PDF" :disabled="!store.compile.pdfUrl" @click="downloadPdf">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M8 2v8m0 0L5 7m3 3 3-3M3 13h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          PDF
        </button>
        <button class="ghost small icon" title="下载编译日志" @click="downloadLog">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M8 2v8m0 0L5 7m3 3 3-3M3 13h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          日志
        </button>
      </div>
      <div class="flex gap8 nav">
        <button class="ghost small" :disabled="!hasPdf || pageNum <= 1" aria-label="上一页" @click="setPage(pageNum - 1)">‹</button>
        <span class="pager">
          <input
            ref="pageInputEl"
            v-model="pageInput"
            class="page-input" aria-label="PDF 页码" inputmode="numeric"
            :disabled="!hasPdf"
            @keyup.enter="commitPageInput"
            @blur="commitPageInput"
          />/{{ totalPages || '-' }}
        </span>
        <button class="ghost small" :disabled="!hasPdf || pageNum >= totalPages" aria-label="下一页" @click="setPage(pageNum + 1)">›</button>
        <button class="ghost small" :disabled="!hasPdf" aria-label="缩小 PDF" @click="zoomOut">−</button>
        <span class="pct">{{ zoomPct }}%</span>
        <button class="ghost small" :disabled="!hasPdf" aria-label="放大 PDF" @click="zoomIn">+</button>
        <div class="seg" role="group" aria-label="缩放模式">
          <button :class="{ on: scaleMode === 'fit-width' }" :disabled="!hasPdf" @click="scaleMode = 'fit-width'">适应宽度</button>
          <button :class="{ on: scaleMode === 'fit-page' }" :disabled="!hasPdf" @click="scaleMode = 'fit-page'">适应页</button>
        </div>
        <div class="seg" role="group" aria-label="翻页模式">
          <button :class="{ on: viewMode === 'scroll' }" title="连续滚动" @click="viewMode = 'scroll'">连续</button>
          <button :class="{ on: viewMode === 'page' }" title="单页显示" @click="viewMode = 'page'">单页</button>
        </div>
      </div>
    </div>

    <div v-if="runtimeError" class="runtime-error" role="status">{{ runtimeError }}<button class="ghost small" :disabled="runtimesLoading" @click="loadRuntimes">重试</button></div>

    <!-- 错误/警告条 -->
    <div v-if="issues.length" class="issues">
      <div class="issues-head" @click="issuesCollapsed = !issuesCollapsed">
        <span>{{ issuesCollapsed ? '▸' : '▾' }}</span>
        <span v-if="store.compile.errors.length" class="cnt error">{{ store.compile.errors.length }} 个错误</span>
        <span v-if="store.compile.warnings.length" class="cnt warning">{{ store.compile.warnings.length }} 个警告</span>
      </div>
      <div v-show="!issuesCollapsed" class="issues-body">
        <div
          v-for="(it, i) in issues"
          :key="i"
          class="issue"
          :class="it.kind"
          @click="jumpToCode(it)"
        >
          <span class="tag">[{{ it.kind === 'error' ? '错误' : '警告' }}]</span>
          <span v-if="it.file" class="loc">{{ it.file }}:{{ it.line }}</span>
          <span class="msg">{{ it.message }}</span>
          <button
            v-if="it.source !== 'request'"
            class="ghost small ai-fix"
            title="提交给智能体快速修复：仅做最小必要修复，不改文章其他内容，修改需经变更审查"
            :disabled="agent.streaming"
            @click.stop="aiFix(it)"
          >AI 修复</button>
        </div>
      </div>
    </div>

    <!-- 空白页提示：渲染自检发现整页空白（多为内嵌矢量图兼容性），提示下载查看 -->
    <div v-if="blankPage && blankPage === pageNum && blankDismissed !== blankPage" class="blank-hint">
      <span>第 {{ blankPage }} 页在浏览器内渲染为空白（可能是内嵌矢量图兼容性所致）。可下载 PDF 查看原文件；若下载后同样空白，请检查该页图片。</span>
      <button class="ghost small" @click="blankDismissed = blankPage">知道了</button>
    </div>

    <!-- PDF 区：连续模式滚动显示所有页，单页模式仅当前页 -->
    <div ref="scrollEl" class="pdf-scroll" tabindex="0" aria-label="PDF 页面">
      <div v-if="loading" class="placeholder muted">加载 PDF 中…</div>
      <div v-else-if="loadError" class="placeholder error-text">{{ loadError }}</div>
      <div v-else-if="!hasPdf" class="placeholder muted">
        <template v-if="store.compile.status === 'failed'">编译失败，请根据错误信息修改后重试</template>
        <template v-else>点击重新编译生成 PDF</template>
      </div>
      <div v-show="hasPdf" class="pages">
        <div
          v-for="n in displayedPages"
          :key="n"
          :ref="(el) => setWrapRef(n, el)"
          class="page-wrap"
          :data-page="n"
          :style="pageWrapStyle(n)"
          @dblclick="onDblClick($event, n)"
        >
          <canvas :ref="(el) => setCanvasRef(n, el)"></canvas>
          <div
            v-if="highlight && highlight.page === n"
            class="highlight"
            :style="highlight.style"
          ></div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pdf-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--glass-inset);
  min-width: 0;
}

.toolbar {
  min-height: 40px;
  flex: none;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  column-gap: 8px;
  row-gap: 4px;
  padding: 4px 8px;
  background: var(--glass-inset);
  box-shadow: var(--glass-highlight);
  border-bottom: 1px solid var(--border);
}
.toolbar .small { padding: 3px 8px; white-space: nowrap; }
.nav { flex-wrap: wrap; row-gap: 4px; }
.engine {
  padding: 3px 6px;
  font-size: 12px;
  background: transparent;
  border-color: transparent;
}
.toolbar > .flex:first-child { flex-wrap: wrap; }
.runtime-error { padding: 5px 10px; font-size: 11px; color: var(--fg-dim); border-bottom: 1px solid var(--border); }
.tex-version { max-width: 190px; }
.icon { display: inline-flex; align-items: center; gap: 4px; }
.nav { flex: none; }
.pager { font-size: 12px; color: var(--fg-dim); white-space: nowrap; }
.page-input {
  width: 36px;
  padding: 2px 4px;
  font-size: 12px;
  text-align: center;
  background: var(--bg);
}
.pct {
  font-size: 12px;
  color: var(--fg-dim);
  min-width: 38px;
  text-align: center;
}
button.active {
  border-color: var(--accent);
  color: var(--accent);
}

/* 胶囊式分段开关：二选一选项 */
.seg {
  display: inline-flex;
  flex: none;
  padding: 2px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--bg);
}
.seg button {
  padding: 2px 10px;
  font-size: 12px;
  line-height: 20px;
  color: var(--fg-dim);
  background: transparent;
  border: none;
  border-radius: 5px;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.15s, color 0.15s;
}
.seg button:hover:not(:disabled):not(.on) { color: var(--fg); }
.seg button.on {
  background: var(--accent-soft);
  color: var(--accent);
}
.seg button:disabled { opacity: 0.45; cursor: default; }

.spin {
  display: inline-block;
  width: 10px;
  height: 10px;
  margin-right: 5px;
  vertical-align: -1px;
  border: 2px solid color-mix(in srgb, currentColor 40%, transparent);
  border-top-color: currentColor;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

.issues {
  flex: none;
  border-bottom: 1px solid var(--border);
  background: var(--bg2);
}
.issues-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 10px;
  font-size: 12px;
  cursor: pointer;
  user-select: none;
}
.cnt.error { color: var(--danger); }
.cnt.warning { color: var(--warn); }
.issues-body {
  max-height: 120px;
  overflow-y: auto;
  padding: 0 10px 6px;
}
.issue {
  display: flex;
  gap: 6px;
  padding: 2px 0;
  font-size: 12px;
  font-family: var(--mono);
  cursor: pointer;
  white-space: nowrap;
}
.issue:hover .msg { text-decoration: underline; }
.issue.error .tag, .issue.error .loc { color: var(--danger); }
.issue.warning .tag, .issue.warning .loc { color: var(--warn); }
.issue .msg {
  color: var(--fg);
  overflow: hidden;
  text-overflow: ellipsis;
}
.ai-fix {
  flex: none;
  margin-left: auto;
  color: var(--accent);
  border: 1px solid var(--accent);
  border-radius: 4px;
  padding: 1px 6px;
  font-size: 11px;
  background: transparent;
  cursor: pointer;
}
.ai-fix:hover:not(:disabled) { background: var(--accent); color: var(--on-accent); }
.ai-fix:disabled { opacity: 0.5; cursor: default; }

.pdf-scroll {
  flex: 1;
  overflow: auto;
  display: flex;
  flex-direction: column;
  padding: 16px;
  position: relative; /* 使 page-wrap 的 offsetTop 相对本容器，供滚动定位 */
}
.blank-hint {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--warn, #d19a66);
  background: rgba(217, 166, 54, 0.12);
  color: var(--fg);
  font-size: 12px;
}
.blank-hint span { flex: 1; }
.placeholder {
  margin: auto;
  font-size: 13px;
}
.error-text { color: var(--danger); }

.pages {
  margin: auto; /* 内容不足一屏时整体居中 */
  width: 100%; /* 给页面的 100%/min(100%) 提供确定参照 */
  display: flex;
  flex-direction: column;
  /* safe：放得下时居中；数字缩放超出时退回起点对齐，溢出向右可滚动，
     而不是双侧溢出导致左半被裁掉够不着 */
  align-items: safe center;
  gap: 12px;
}
.page-wrap {
  position: relative;
  flex: none;
  background: #fff;
  box-shadow: 0 2px 12px rgba(20, 35, 27, 0.12), 0 0 0 1px rgba(20, 35, 27, 0.05);
}
.page-wrap canvas {
  display: block;
  width: 100%;
  height: 100%;
  background: #fff;
}
.highlight {
  position: absolute;
  left: 0;
  width: 100%;
  height: 18px;
  background: rgba(76, 141, 255, 0.35);
  pointer-events: none;
  animation: hl-fade 1.5s ease forwards;
}
@keyframes hl-fade {
  0% { opacity: 1; }
  70% { opacity: 1; }
  100% { opacity: 0; }
}

/* ---- visual refinement layer (presentation only; geometry untouched) ---- */
.toolbar { border-bottom-color: color-mix(in srgb, var(--border) 78%, var(--bg2)); }
.toolbar .primary.small { background-image: var(--accent-gradient); border-color: var(--accent); box-shadow: 0 2px 8px color-mix(in srgb, var(--accent) 18%, transparent); }
.toolbar .primary.small:hover:not(:disabled) { background-image: var(--accent-gradient-hover); }
.toolbar .primary.small:disabled { background-image: none; box-shadow: none; }
.engine { border-radius: 7px; transition: border-color var(--motion-hover) var(--ease-standard), background-color var(--motion-hover) var(--ease-standard); }
.engine:hover:not(:disabled) { border-color: color-mix(in srgb, var(--fg-muted) 45%, var(--border)); background: var(--surface-muted); }
.page-input { border-radius: 6px; font-variant-numeric: tabular-nums; transition: border-color var(--motion-hover) var(--ease-standard), box-shadow var(--motion-hover) var(--ease-standard); }
.page-input:focus-visible { border-color: var(--accent); box-shadow: 0 0 0 3px var(--focus-ring); }
.pct { font-variant-numeric: tabular-nums; }
.seg { border-radius: 8px; border-color: color-mix(in srgb, var(--border) 85%, var(--bg2)); background: color-mix(in srgb, var(--bg) 65%, var(--surface-muted)); }
.seg button { border-radius: 6px; transition: background-color var(--motion-hover) var(--ease-standard), color var(--motion-hover) var(--ease-standard); }
.seg button.on { background: var(--accent-soft); color: var(--accent-hover); font-weight: 650; box-shadow: var(--glass-highlight); }
.runtime-error { border-bottom-color: color-mix(in srgb, var(--border) 78%, var(--bg2)); background: var(--warn-soft); color: var(--warn); }
.issues { border-bottom-color: color-mix(in srgb, var(--border) 78%, var(--bg2)); }
.issues-head { transition: background-color var(--motion-hover) var(--ease-standard); }
.issues-head:hover { background: var(--bg-hover); }
.cnt { padding: 1px 8px; border-radius: 999px; font-weight: 650; font-size: 11px; font-variant-numeric: tabular-nums; }
.cnt.error { background: var(--danger-soft); }
.cnt.warning { background: var(--warn-soft); }
.issues-body { scrollbar-width: thin; scrollbar-color: color-mix(in srgb, var(--fg-muted) 38%, transparent) transparent; }
.issue { padding: 3px 6px; border-radius: 6px; transition: background-color var(--motion-hover) var(--ease-standard); }
.issue:hover { background: var(--bg-hover); }
.issue:hover .msg { text-decoration: none; }
.issue .tag { font-weight: 700; }
.ai-fix { border-radius: 6px; border-color: color-mix(in srgb, var(--accent) 55%, var(--border)); background: var(--accent-soft); font-weight: 600; transition: background-color var(--motion-hover) var(--ease-standard), color var(--motion-hover) var(--ease-standard); }
.ai-fix:hover:not(:disabled) { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
.blank-hint { border-bottom: 1px solid color-mix(in srgb, var(--warn) 32%, transparent); background: var(--warn-soft); }
.pdf-scroll { scrollbar-width: thin; scrollbar-color: color-mix(in srgb, var(--fg-muted) 38%, transparent) transparent; }
.placeholder { letter-spacing: .01em; }
.page-wrap { box-shadow: 0 1px 3px rgba(20, 35, 27, 0.07), 0 8px 26px rgba(20, 35, 27, 0.10), 0 0 0 1px rgba(20, 35, 27, 0.05); }
.highlight { background: color-mix(in srgb, var(--accent) 32%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 40%, transparent); }
@media (prefers-reduced-motion: reduce) {
  .engine, .page-input, .seg button, .issues-head, .issue, .ai-fix { transition: none; }
}
@media (forced-colors: active) {
  .toolbar .primary.small, .toolbar .primary.small:hover:not(:disabled) { background-image: none; }
  .seg button.on { box-shadow: none; }
  .highlight { box-shadow: none; }
}
</style>
