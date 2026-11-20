// 轻量 LaTeX → HTML 渲染（Visual 视图）：只读展示，不追求完整排版
// 管线：抽取多行结构（数学环境/figure/参考文献）→ 抽取行内数学 →
// 逐行块级解析（标题/列表/图片/段落）→ 行内排版 → 回填占位符
import katex from 'katex';
import { stripComment } from './outline.js';

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const MATH_ENVS = ['equation', 'align', 'gather', 'multline', 'eqnarray'];
// 无扩展名时的补全顺序
const IMAGE_EXTS = ['.pdf', '.png', '.jpg', '.jpeg', '.webp'];

/**
 * \includegraphics 路径补全：有扩展名原样返回；无扩展名时按 IMAGE_EXTS
 * 顺序用 exists(candidate) 探测，都不存在则返回原路径。
 */
export function pickImagePath(p, exists) {
  if (/\.[a-zA-Z0-9]+$/.test(p)) return p;
  if (typeof exists === 'function') {
    for (const ext of IMAGE_EXTS) {
      if (exists(p + ext)) return p + ext;
    }
  }
  return p;
}

function renderMath(tex, displayMode) {
  try {
    const html = katex.renderToString(tex, { displayMode, throwOnError: false, strict: false });
    if (!html.includes('katex-error')) return html;
  } catch { /* fallthrough */ }
  return `<span class="ltx-math-err">${escapeHtml(tex)}</span>`;
}

/** 从 open 位置（'{'）取配对的花括号内容 */
function takeBraced(s, open) {
  if (s[open] !== '{') return null;
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '{' && s[i - 1] !== '\\') depth++;
    else if (s[i] === '}' && s[i - 1] !== '\\') {
      depth--;
      if (!depth) return { content: s.slice(open + 1, i), end: i + 1 };
    }
  }
  return null;
}

/**
 * renderLatexToHtml(tex, { resolveImage }) → HTML 字符串
 * resolveImage(path) 把 \includegraphics 的路径映射为可访问 URL。
 */
export function renderLatexToHtml(tex, { resolveImage } = {}) {
  if (!tex) return '';
  // 只取 document 环境内容
  const docMatch = tex.match(/\\begin\{document\}([\s\S]*)\\end\{document\}/);
  let body = docMatch ? docMatch[1] : tex;
  // 逐行去注释（保留换行，多行环境仍能匹配）
  body = body.split('\n').map((l) => stripComment(l)).join('\n');

  // 预扫描 \label / \cite，分别按出现顺序编号
  const labelNum = new Map();
  for (const m of body.matchAll(/\\label\{([^}]*)\}/g)) {
    if (!labelNum.has(m[1])) labelNum.set(m[1], labelNum.size + 1);
  }
  const citeNum = new Map();
  for (const m of body.matchAll(/\\cite[a-zA-Z]*(?:\[[^\]]*\])*\{([^}]*)\}/g)) {
    for (const key of m[1].split(',').map((k) => k.trim()).filter(Boolean)) {
      if (!citeNum.has(key)) citeNum.set(key, citeNum.size + 1);
    }
  }

  // 占位符：抽出的块/行内片段最后统一回填（纯字母数字，排版与转义都不会碰到）
  const slots = [];
  const stash = (html, block) => {
    slots.push({ html, block });
    return `LTXSLOT${slots.length - 1}Z`;
  };

  // 数学内容里的 \label：提取为锚点并从源码中剥掉（KaTeX 不认识 \label）
  const stashMath = (content, display) => {
    const anchors = [];
    const cleaned = content.replace(/\\label\{([^}]*)\}/g, (_, key) => {
      anchors.push(`<a id="ltx-label-${escapeHtml(key)}"></a>`);
      return '';
    });
    const rendered = renderMath(cleaned, display);
    return stash(
      display ? `<div class="ltx-displaymath">${anchors.join('')}${rendered}</div>`
        : `<span class="ltx-math">${anchors.join('')}${rendered}</span>`,
      display,
    );
  };

  // 行内/单行数学（$$...$$、\[...\]、\(...\)、$...$），\$ 不算
  const stashInlineMathIn = (s) => s
    .replace(/(?<!\\)\$\$([\s\S]+?)(?<!\\)\$\$/g, (_, c) => stashMath(c, true))
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, c) => stashMath(c, true))
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, c) => stashMath(c, false))
    .replace(/(?<!\\)\$([^$\n]+?)(?<!\\)\$/g, (_, c) => stashMath(c, false));

  const renderImage = (p) => {
    const url = resolveImage ? resolveImage(p) : p;
    return `<img src="${escapeHtml(url)}" alt="${escapeHtml(p)}" />`;
  };

  // 取 src 中第一个 \begin{env}…\end{env} 的内容（跳过可选参数 [..]；star 环境的结尾同样带 *）
  const findEnv = (src, env) => {
    const m = new RegExp(`\\\\begin\\{${env}(\\*?)\\}(?:\\[[^\\]]*\\])?`).exec(src);
    if (!m) return null;
    const name = env + (m[1] || '');
    const endIdx = src.indexOf(`\\end{${name}}`, m.index + m[0].length);
    if (endIdx < 0) return null;
    return { content: src.slice(m.index + m[0].length, endIdx), end: endIdx + `\\end{${name}}`.length };
  };

  let tableNum = 0;
  let algoNum = 0;

  function inline(s) {
    let h = escapeHtml(s);
    // LaTeX 转义字符
    h = h.replace(/\\([$%&#_{}])/g, '$1');
    h = h.replace(/~/g, '&nbsp;');
    h = h.replace(/\\textbf\{([^{}]*)\}/g, '<strong>$1</strong>');
    h = h.replace(/\\textit\{([^{}]*)\}/g, '<em>$1</em>');
    h = h.replace(/\\emph\{([^{}]*)\}/g, '<em>$1</em>');
    h = h.replace(/\\underline\{([^{}]*)\}/g, '<u>$1</u>');
    h = h.replace(/\\texttt\{([^{}]*)\}/g, '<code>$1</code>');
    // 交叉引用：\label 为不可见锚点，\ref/\eqref/\pageref 为编号链接
    h = h.replace(/\\label\{([^}]*)\}/g, (_, key) => `<a id="ltx-label-${escapeHtml(key)}"></a>`);
    h = h.replace(/\\(eqref|ref|pageref)\{([^}]*)\}/g, (_, cmd, key) => {
      const n = labelNum.get(key);
      const text = n == null ? '[?]' : (cmd === 'eqref' ? `(${n})` : String(n));
      return `<a href="#ltx-label-${escapeHtml(key)}" class="ltx-ref">${text}</a>`;
    });
    // 引用（含 natbib 的 \citep/\citet）：按全文首次引用顺序编号，上标 [n]；
    // 与 natbib sort&compress 一致：升序排列，连续 ≥3 个压成 a-c
    h = h.replace(/\\cite[a-zA-Z]*(?:\[[^\]]*\])*\{([^}]*)\}/g, (_, keys) => {
      const nums = keys.split(',').map((k) => k.trim()).filter(Boolean)
        .map((key) => ({ key, n: citeNum.get(key) }))
        .sort((a, b) => (a.n ?? Infinity) - (b.n ?? Infinity));
      const link = ({ key, n }) => (n == null
        ? '[?]'
        : `<a href="#ltx-bib-${escapeHtml(key)}" class="ltx-ref">${n}</a>`);
      const parts = [];
      for (let i = 0; i < nums.length; i++) {
        let j = i;
        while (j + 1 < nums.length && nums[j + 1].n === nums[j].n + 1) j++;
        if (j - i >= 2) parts.push(`${link(nums[i])}-${link(nums[j])}`);
        else for (let k = i; k <= j; k++) parts.push(link(nums[k]));
        i = j;
      }
      return `<sup class="ltx-cite">[${parts.join(',')}]</sup>`;
    });
    // 未识别命令：剥掉命令名但保留参数文本（\foo{bar} → bar）
    for (let i = 0; i < 4; i++) {
      const next = h.replace(/\\[a-zA-Z]+\*?\s*(?:\[[^\]]*\])?\{([^{}]*)\}/g, '$1');
      if (next === h) break;
      h = next;
    }
    h = h.replace(/\\[a-zA-Z]+\*?/g, '');
    h = h.replace(/[{}]/g, '');
    h = h.replace(/``/g, '“').replace(/''/g, '”');
    h = h.replace(/---/g, '—').replace(/--/g, '–');
    return h;
  }

  const parseFigure = (inner) => {
    let labelId = '';
    const lm = inner.match(/\\label\{([^}]*)\}/);
    if (lm) labelId = lm[1];
    const imgs = [];
    for (const m of inner.matchAll(/\\includegraphics(?:\[[^\]]*\])?\{([^{}]*)\}/g)) {
      imgs.push(renderImage(m[1]));
    }
    // figure 里嵌表格也常见（\begin{figure}\begin{tabular}…）
    const tab = findEnv(inner, 'tabular') || findEnv(inner, 'longtable');
    const tableHtml = tab ? parseTabular(tab.content) : '';
    let caption = '';
    const cm = inner.match(/\\caption/);
    if (cm) {
      const open = inner.indexOf('{', cm.index + cm[0].length);
      const braced = open >= 0 ? takeBraced(inner, open) : null;
      if (braced) caption = `<figcaption>${inline(stashInlineMathIn(braced.content))}</figcaption>`;
    }
    const idAttr = labelId ? ` id="ltx-label-${escapeHtml(labelId)}"` : '';
    return `<figure${idAttr}>${imgs.join('')}${tableHtml}${caption}</figure>`;
  };

  // ---- 表格：tabular/tabular*/longtable → <table> ----
  // 行按顶层 \\ 分隔、列按顶层未转义的 & 分隔（跳过 {...} 嵌套——\makecell{A\\B} 之类的
  // 单元格内 \\ 不会把行切碎）；列格式支持 @{}/>{}/<{}/!{} 组与 *{n}{X} 展开；
  // \multicolumn → colspan，\multirow → rowspan，单元格内 \\ → <br>。
  const splitTopLevel = (s, rowSep) => {
    const parts = [];
    let cur = '';
    let depth = 0;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === '\\' && i + 1 < s.length) {
        if (rowSep && s[i + 1] === '\\' && depth === 0) {
          parts.push(cur);
          cur = '';
          i++;
          continue;
        }
        cur += ch + s[i + 1];
        i++;
        continue;
      }
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      if (!rowSep && depth === 0 && ch === '&') {
        parts.push(cur);
        cur = '';
        continue;
      }
      cur += ch;
    }
    parts.push(cur);
    return parts;
  };

  const parseTabular = (raw) => {
    let inner = raw;
    const aligns = [];
    // 列格式：取首个深度感知的花括号组；tabularx 的第一组是宽度（不含 l/c/r），列格式在第二组
    const firstBraced = () => {
      const open = inner.indexOf('{');
      if (open < 0) return null;
      const braced = takeBraced(inner, open);
      return braced ? { content: braced.content, rest: inner.slice(braced.end) } : null;
    };
    const specLetters = (s) => {
      let t = s.replace(/\*\{(\d+)\}\{([^{}]*)\}/g, (_, n, cs) => cs.repeat(Number(n)));
      t = t.replace(/[@!><]\{[^{}]*\}/g, '');
      return t.match(/[lcrX]/gi) || [];
    };
    const g1 = firstBraced();
    if (g1) {
      inner = g1.rest;
      let spec = g1.content;
      let ls = specLetters(spec);
      if (!ls.length) {
        const g2 = firstBraced();
        if (g2) {
          spec = g2.content;
          inner = g2.rest;
          ls = specLetters(spec);
        }
      }
      for (const a of ls) {
        aligns.push(a.toLowerCase() === 'l' ? 'left' : a.toLowerCase() === 'r' ? 'right' : 'center');
      }
    }
    const rows = [];
    let headerCount = -1; // 首条 \midrule 之前的行视为表头
    let sawRule = false;
    // booktabs 规则线：\hline/\toprule/\midrule/\bottomrule（可带 [粗细]）、
    // \cline/\cmidrule（可带 (lr) 修剪与 {列区间}）——都是横线装饰，不是文本
    const RULE_RE = /\\(?:hline|toprule|midrule|bottomrule|cmidrule|cline)\*?(?:\[[^\]]*\])?(?:\([^)]*\))?(?:\{[^}]*\})?/g;
    for (const seg of splitTopLevel(inner, true)) {
      if (/\\midrule/.test(seg) && headerCount < 0 && rows.length) headerCount = rows.length;
      if (/\\(?:hline|toprule|midrule|bottomrule)/.test(seg)) sawRule = true;
      const text = seg
        .replace(RULE_RE, '')
        .replace(/\\(?:endfirsthead|endhead|endfoot|endlastfoot|tabularnewline)\b/g, '')
        .trim();
      if (text) rows.push(text);
    }
    if (!rows.length) return '';
    if (headerCount < 0) headerCount = sawRule && rows.length > 1 ? 1 : 0;

    const renderRow = (text, isHeader) => {
      const tag = isHeader ? 'th' : 'td';
      const cells = splitTopLevel(text, false).map((cellSrc, colIdx) => {
        // \multirow 让第 1 列被上方行占用：LaTeX 续行的占位空单元格在 HTML 里必须跳过，
        // 否则本行所有单元格整体右移一列（列错位的根源）
        if ((occ[colIdx + 1] || -1) >= rowIdx) return null;
        let cell = cellSrc.trim();
        let colspan = 0;
        let rowspan = 0;
        const mc = cell.match(/^\\multicolumn\{(\d+)\}\{[^{}]*\}/);
        if (mc) {
          colspan = Number(mc[1]);
          cell = cell.slice(mc[0].length);
        }
        const mr = cell.match(/^\\multirow\{(\d+)\}\{[^{}]*\}/);
        if (mr) {
          rowspan = Number(mr[1]);
          cell = cell.slice(mr[0].length);
        }
        if (colspan || rowspan) {
          const open = cell.indexOf('{');
          const braced = open >= 0 ? takeBraced(cell, open) : null;
          if (braced) cell = braced.content;
        }
        const align = aligns[colIdx] || 'center';
        const span = `${colspan > 1 ? ` colspan="${colspan}"` : ''}${rowspan > 1 ? ` rowspan="${rowspan}"` : ''}`;
        const body = inline(stashInlineMathIn(cell)).replace(/\\\\/g, '<br>');
        return { col: colIdx + 1, colspan: colspan || 1, rowspan: rowspan || 1, html: `<${tag} style="text-align:${align}"${span}>${body}</${tag}>` };
      });
      for (const c of cells) {
        if (!c) continue;
        for (let k = 0; k < c.colspan; k++) occ[c.col + k] = rowIdx + c.rowspan - 1;
      }
      rowIdx++;
      return `<tr>${cells.filter(Boolean).map((c) => c.html).join('')}</tr>`;
    };
    let rowIdx = 0;
    const occ = {}; // 列号 → 被 rowspan 覆盖到的最后一行（0 基）
    const headHtml = headerCount > 0 ? rows.slice(0, headerCount).map((t) => renderRow(t, true)).join('') : '';
    const bodyHtml = (headerCount > 0 ? rows.slice(headerCount) : rows).map((t) => renderRow(t, false)).join('');
    const thead = headHtml ? `<thead>${headHtml}</thead>` : '';
    return `<div class="ltx-tablewrap"><table class="ltx-tabular">${thead}<tbody>${bodyHtml}</tbody></table></div>`;
  };

  // ---- 伪代码：algorithmic → 逐行结构化块，关键词加粗、保留缩进与行内公式 ----
  const ALGO_KW = {
    state: '', ensure: 'Ensure:', require: 'Require:',
    if: 'if', then: 'then', else: 'else', elsif: 'else if', endif: 'end if',
    for: 'for', forall: 'for all', foreach: 'for each', do: 'do', endfor: 'end for',
    while: 'while', endwhile: 'end while', repeat: 'repeat', until: 'until',
    return: 'return', function: 'function', endfunction: 'end function',
    procedure: 'procedure', endprocedure: 'end procedure',
    comment: '▷', break: 'break', continue: 'continue', call: '',
  };
  const KW_MARK = (label) => `\u0001KW\u0002${label}\u0001/KW\u0002`;

  const parseAlgorithmic = (raw) => {
    const out = [];
    for (const src of raw.split('\n')) {
      const line = src.replace(/\\\\\s*$/, '').trim();
      if (!line || /^\\(begin|end)\{/.test(line)) continue;
      const indent = (src.match(/^\s*/) || [''])[0].replace(/\t/g, '  ');
      // 先抽走数学（避免 \forall 等数学命令被当成关键词），再把算法关键词转成标记
      const prepared = stashInlineMathIn(line).replace(/\\([A-Za-z]+)/g, (m, name) => {
        const label = ALGO_KW[name.toLowerCase()];
        if (label === undefined) return m;
        return label ? KW_MARK(label) : '';
      });
      const html = inline(prepared)
        .replace(/\u0001KW\u0002([\s\S]*?)\u0001\/KW\u0002/g, '<strong class="ltx-kw">$1</strong>');
      out.push(`<div class="ltx-algo-line">${indent}${html}</div>`);
    }
    return out.join('');
  };

  // algorithm 浮动体：标题（\caption）+ 伪代码主体
  const parseAlgorithmFloat = (inner) => {
    algoNum++;
    let cap = '';
    const cm = inner.match(/\\caption/);
    if (cm) {
      const open = inner.indexOf('{', cm.index + cm[0].length);
      const braced = open >= 0 ? takeBraced(inner, open) : null;
      if (braced) cap = inline(stashInlineMathIn(braced.content));
    }
    const bodyEnv = findEnv(inner, 'algorithmic') || findEnv(inner, 'algorithm2e');
    const bodyHtml = parseAlgorithmic(bodyEnv ? bodyEnv.content : inner);
    return `<section class="ltx-algo"><div class="ltx-algo-head">Algorithm ${algoNum}${cap ? `<span class="ltx-algo-cap">${cap}</span>` : ''}</div><div class="ltx-algo-body">${bodyHtml}</div></section>`;
  };

  // table 浮动体：标题 + 内嵌 tabular
  const parseTableFloat = (inner) => {
    tableNum++;
    let cap = '';
    const cm = inner.match(/\\caption/);
    if (cm) {
      const open = inner.indexOf('{', cm.index + cm[0].length);
      const braced = open >= 0 ? takeBraced(inner, open) : null;
      if (braced) cap = inline(stashInlineMathIn(braced.content));
    }
    const tab = findEnv(inner, 'tabular') || findEnv(inner, 'tabularx') || findEnv(inner, 'longtable');
    const tbl = tab ? parseTabular(tab.content) : '';
    return `<figure class="ltx-table"><div class="ltx-table-cap">Table ${tableNum}${cap ? `<span>${cap}</span>` : ''}</div>${tbl}</figure>`;
  };

  const parseBibliography = (inner) => {
    const items = [];
    // \bibitem{key} 内容（到下一个 \bibitem 或结尾）
    const re = /\\bibitem(?:\[[^\]]*\])?\{([^}]*)\}([\s\S]*?)(?=\\bibitem|$)/g;
    for (const m of inner.matchAll(re)) {
      const key = m[1];
      if (!citeNum.has(key)) citeNum.set(key, citeNum.size + 1);
      const n = citeNum.get(key);
      items.push(`<li id="ltx-bib-${escapeHtml(key)}">[${n}] ${inline(stashInlineMathIn(m[2].trim()))}</li>`);
    }
    if (!items.length) return '';
    return `<section class="ltx-bibsec"><h2>References</h2><ol class="ltx-bib">${items.join('')}</ol></section>`;
  };

  // 第一遍：抽取多行结构（数学环境、figure、thebibliography），每次取最靠前的匹配
  for (;;) {
    let best = null; // { index, end, html } 或 { index, end, handler, content }（惰性：选中才解析）
    const consider = (index, end, html, lazy) => {
      if (end > index && (!best || index < best.index)) {
        best = lazy ? { index, end, ...lazy } : { index, end, html };
      }
    };
    for (const env of MATH_ENVS) {
      const m = new RegExp(`\\\\begin\\{${env}\\*?\\}`).exec(body);
      if (!m) continue;
      const name = m[0].slice('\\begin{'.length, -1);
      const endIdx = body.indexOf(`\\end{${name}}`, m.index + m[0].length);
      if (endIdx < 0) continue;
      const content = body.slice(m.index + m[0].length, endIdx);
      const rendered = stashMath(content, true);
      consider(m.index, endIdx + `\\end{${name}}`.length, rendered);
    }
    {
      const m = /\\begin\{figure\}(?:\[[^\]]*\])?/.exec(body);
      if (m) {
        const endIdx = body.indexOf('\\end{figure}', m.index + m[0].length);
        if (endIdx >= 0) {
          const inner = body.slice(m.index + m[0].length, endIdx);
          consider(m.index, endIdx + '\\end{figure}'.length, stash(parseFigure(inner), true));
        }
      }
    }
    {
      const m = /\\begin\{thebibliography\}(?:\{[^}]*\})?/.exec(body);
      if (m) {
        const endIdx = body.indexOf('\\end{thebibliography}', m.index + m[0].length);
        if (endIdx >= 0) {
          const inner = body.slice(m.index + m[0].length, endIdx);
          consider(m.index, endIdx + '\\end{thebibliography}'.length, stash(parseBibliography(inner), true));
        }
      }
    }
    // 表格浮动体 / 伪代码（嵌套时外层 index 更小、先被取走，内层由其解析器消化）。
    // 候选只记录位置与解析器，选中后才调用：落选候选不能递增编号或产生废弃占位。
    for (const [env, handler] of [
      ['table', parseTableFloat],
      ['algorithm', parseAlgorithmFloat],
      ['longtable', parseTabular],
      ['tabular', parseTabular],
      ['tabularx', parseTabular],
      ['algorithmic', parseAlgorithmic],
    ]) {
      const m = new RegExp(`\\\\begin\\{${env}\\*?\\}`).exec(body);
      if (!m) continue;
      const found = findEnv(body, env);
      if (!found) continue;
      consider(m.index, found.end, null, { handler, content: found.content });
    }
    if (!best) break;
    const bestHtml = best.handler ? stash(best.handler(best.content), true) : best.html;
    body = body.slice(0, best.index) + bestHtml + body.slice(best.end);
  }

  // 第二遍：抽取正文剩余的行内数学
  body = stashInlineMathIn(body);

  const out = [];
  const lines = body.split('\n');
  let inItemize = null; // 'itemize' | 'enumerate' | null
  let para = [];

  const flushPara = () => {
    const text = para.join(' ').trim();
    para = [];
    if (text) out.push(`<p>${inline(text)}</p>`);
  };
  const closeList = () => {
    if (inItemize) { out.push(inItemize === 'itemize' ? '</ul>' : '</ol>'); inItemize = null; }
  };

  for (const raw of lines) {
    const line = raw.trim();
    // 独占一行的块级占位符（数学环境/figure/参考文献/行间公式）
    const wholeSlot = /^LTXSLOT(\d+)Z$/.exec(line);
    if (wholeSlot && slots[Number(wholeSlot[1])].block) {
      flushPara(); closeList();
      out.push(slots[Number(wholeSlot[1])].html);
      slots[Number(wholeSlot[1])].html = '';
      continue;
    }
    // 标题
    const sec = line.match(/\\(chapter|section|subsection|subsubsection)\*?\s*(?:\[[^\]]*\])?\s*\{([^{}]*)\}/);
    if (sec) {
      flushPara(); closeList();
      const tag = { chapter: 'h1', section: 'h2', subsection: 'h3', subsubsection: 'h4' }[sec[1]];
      // 同行余量（常见 \section{...}\label{...} 写法）：保留 \label 锚点等内容
      const rest = line.slice(sec.index + sec[0].length).trim();
      out.push(`<${tag}>${inline(sec[2])}</${tag}>${rest ? inline(rest) : ''}`);
      continue;
    }
    // 图片（figure 环境之外的裸 \includegraphics）
    const img = line.match(/\\includegraphics(?:\[[^\]]*\])?\{([^{}]*)\}/);
    if (img) {
      flushPara(); closeList();
      out.push(`<div class="ltx-fig">${renderImage(img[1])}</div>`);
      continue;
    }
    // 列表
    if (/^\\begin\{itemize\}/.test(line)) { flushPara(); inItemize = 'itemize'; out.push('<ul>'); continue; }
    if (/^\\begin\{enumerate\}/.test(line)) { flushPara(); inItemize = 'enumerate'; out.push('<ol>'); continue; }
    if (/^\\end\{(itemize|enumerate)\}/.test(line)) { flushPara(); closeList(); continue; }
    const it = line.match(/^\\item\s*(.*)$/);
    if (it && inItemize) { out.push(`<li>${inline(it[1])}</li>`); continue; }
    // 参考文献声明本身不输出
    if (/^\\bibliography\{/.test(line)) { flushPara(); continue; }
    // 忽略环境/命令行
    if (/^\\(begin|end)\{/.test(line)) { flushPara(); continue; }
    if (/^\\(maketitle|tableofcontents|newpage|clearpage|centering|vspace|hspace)\b/.test(line)) { flushPara(); continue; }
    if (!line) { flushPara(); continue; }
    para.push(line);
  }
  flushPara();
  closeList();

  let html = out.join('\n');
  // 回填行内占位符（段落/标题/列表项里的数学）
  html = html.replace(/LTXSLOT(\d+)Z/g, (_, i) => slots[Number(i)].html || '');
  return html;
}

export const VISUAL_CSS = `
.ltx-visual { font-family: Georgia, 'Times New Roman', serif; line-height: 1.7; padding: 24px 32px; color: var(--fg); }
.ltx-visual h1 { font-size: 1.6em; } .ltx-visual h2 { font-size: 1.35em; }
.ltx-visual h3 { font-size: 1.15em; } .ltx-visual h4 { font-size: 1em; }
.ltx-math .katex { font-size: 1.02em; }
.ltx-displaymath { background: var(--bg3); border-radius: 6px; padding: 8px 14px; margin: 10px 0; overflow-x: auto; }
.ltx-math-err { font-family: monospace; color: var(--red, #c0392b); background: var(--bg3); border-radius: 4px; padding: 0 4px; }
.ltx-ref { color: var(--blue); text-decoration: none; }
.ltx-cite { color: var(--blue); }
.ltx-cite a { color: inherit; text-decoration: none; }
.ltx-visual img { max-width: 100%; }
.ltx-fig img, .ltx-visual figure img { max-width: 100%; border-radius: 6px; }
.ltx-visual figure { margin: 12px 0; text-align: center; }
.ltx-visual figcaption { color: var(--fg-dim); font-size: 0.92em; margin-top: 6px; }
.ltx-bibsec h2 { font-size: 1.2em; }
.ltx-bib { padding-left: 0; list-style: none; }
.ltx-bib li { margin: 4px 0; }
.ltx-visual code { background: var(--bg3); padding: 1px 5px; border-radius: 4px; }
/* 表格（booktabs 风格：仅横线，首末行加重） */
.ltx-table { margin: 14px 0; }
.ltx-table-cap { text-align: center; color: var(--fg-dim); font-size: 0.92em; margin-bottom: 6px; }
.ltx-table-cap span { color: var(--fg); margin-left: 8px; }
.ltx-tablewrap { overflow-x: auto; }
.ltx-tabular { border-collapse: collapse; margin: 0 auto; font-size: 0.95em; }
.ltx-tabular th, .ltx-tabular td { padding: 3px 12px; }
.ltx-tabular thead th { border-top: 1.6px solid var(--fg); border-bottom: 1px solid var(--fg); font-weight: 600; }
.ltx-tabular tbody tr:last-child { border-bottom: 1.6px solid var(--fg); }
.ltx-tabular td { border-bottom: 1px solid var(--border); }
.ltx-tabular tbody tr:last-child td { border-bottom: none; }
/* 伪代码（algorithm/algorithmic） */
.ltx-algo { margin: 14px 0; border: 1px solid var(--border); border-radius: 8px; background: var(--bg3); }
.ltx-algo-head { padding: 6px 12px; border-bottom: 1px solid var(--border); font-weight: 600; font-size: 0.95em; }
.ltx-algo-head .ltx-algo-cap { font-weight: 400; margin-left: 8px; }
.ltx-algo-body { padding: 8px 14px; font-size: 0.93em; white-space: pre-wrap; overflow-x: auto; line-height: 1.6; }
.ltx-algo-line { min-height: 1.4em; }
.ltx-kw { font-weight: 700; }
`;
