// pdfjs-dist 封装：worker 配置、文档加载、单页渲染（含 devicePixelRatio 高清适配）
import * as pdfjs from 'pdfjs-dist/build/pdf.mjs';

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString();

/**
 * 从 ArrayBuffer 加载 PDF 文档。
 * @param {ArrayBuffer} arrayBuffer
 * @returns {Promise<import('pdfjs-dist').PDFDocumentProxy>}
 */
export function loadPdf(arrayBuffer) {
  return pdfjs.getDocument({ data: arrayBuffer }).promise;
}

/**
 * 渲染一页到 canvas。canvas 实际像素 = viewport × devicePixelRatio，
 * 保证高分屏清晰。
 * cssSize=true（默认）时同时写内联 CSS 宽高（FilePreview 等依赖内联尺寸 +
 * height:auto 保持比例的调用方）；PdfPanel 传 false——它用外层 .page-wrap
 * 的 aspect-ratio + width:100%/height:100% 控制布局，canvas 若携带内联 px，
 * 缩放切换/测量滞后期会与页框错位（内容偏移）。
 * @returns {Promise<{page, viewport, task}>} task 为 pdfjs RenderTask，
 *   调用方负责 await task.promise，并可在新渲染前 task.cancel()。
 */
export async function renderPage(pdfDoc, pageNo, canvas, scale, { cssSize = true } = {}) {
  const page = await pdfDoc.getPage(pageNo);
  const viewport = page.getViewport({ scale });
  const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
  const cssW = Math.floor(viewport.width);
  const cssH = Math.floor(viewport.height);
  canvas.width = Math.floor(cssW * dpr);
  canvas.height = Math.floor(cssH * dpr);
  if (cssSize) {
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
  }
  const ctx = canvas.getContext('2d');
  const task = page.render({
    canvasContext: ctx,
    viewport,
    transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
  });
  return { page, viewport, task };
}
