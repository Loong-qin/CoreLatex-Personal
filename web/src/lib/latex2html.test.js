import { describe, it, expect } from 'vitest';
import { renderLatexToHtml, pickImagePath } from './latex2html.js';

describe('renderLatexToHtml', () => {
  it('渲染标题、加粗、列表、数学、图片', () => {
    const tex = `\\documentclass{article}
\\begin{document}
\\section{Intro}
Some \\textbf{bold} and \\emph{em} text with $x^2$ math.
\\begin{itemize}
\\item First
\\item Second
\\end{itemize}
\\[ E = mc^2 \\]
\\includegraphics[width=0.5\\textwidth]{fig/a.png}
\\end{document}`;
    const html = renderLatexToHtml(tex, { resolveImage: (p) => `/files/${p}` });
    expect(html).toContain('<h2>Intro</h2>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>em</em>');
    expect(html).toContain('class="ltx-math"');
    expect(html).toContain('katex'); // $x^2$ 经 KaTeX 渲染
    expect(html).toContain('<ul>');
    expect(html).toContain('<li>First</li>');
    expect(html).toContain('ltx-displaymath');
    expect(html).toContain('src="/files/fig/a.png"');
  });

  it('HTML 注入被转义', () => {
    const html = renderLatexToHtml('\\begin{document}<script>alert(1)</script>\\end{document}');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('无 document 环境时整体渲染', () => {
    const html = renderLatexToHtml('Just \\textbf{text}');
    expect(html).toContain('<strong>text</strong>');
  });

  it('\\label 渲染为不可见锚点，不显示文字', () => {
    const html = renderLatexToHtml('\\section{Intro}\\label{sec:intro}\nText here.');
    expect(html).toContain('id="ltx-label-sec:intro"');
    expect(html).not.toContain('labelsec:intro');
    expect(html).not.toContain('>sec:intro<');
  });

  it('\\ref / \\eqref 渲染为编号链接，未知 key 显示 [?]', () => {
    const tex = `\\section{Intro}\\label{sec:intro}
\\subsection{Sub}\\label{sec:sub}
See \\ref{sec:intro} and \\ref{sec:sub}, unknown \\ref{sec:nope}.`;
    const html = renderLatexToHtml(tex);
    expect(html).toContain('<a href="#ltx-label-sec:intro" class="ltx-ref">1</a>');
    expect(html).toContain('<a href="#ltx-label-sec:sub" class="ltx-ref">2</a>');
    expect(html).toContain('<a href="#ltx-label-sec:nope" class="ltx-ref">[?]</a>');
  });

  it('\\cite 按首次引用顺序编号，thebibliography 编号对应', () => {
    const tex = `BLIP-2~\\cite{li2023blip2} and \\cite{qi2024visual,li2023blip2}.
\\begin{thebibliography}{9}
\\bibitem{li2023blip2} Li et al. BLIP-2.
\\bibitem{qi2024visual} Qi et al. Visual comparison.
\\end{thebibliography}`;
    const html = renderLatexToHtml(tex);
    expect(html).toContain('<sup class="ltx-cite">[<a href="#ltx-bib-li2023blip2" class="ltx-ref">1</a>]</sup>');
    expect(html).toContain('<sup class="ltx-cite">[<a href="#ltx-bib-li2023blip2" class="ltx-ref">1</a>,<a href="#ltx-bib-qi2024visual" class="ltx-ref">2</a>]</sup>');
    expect(html).toContain('id="ltx-bib-li2023blip2">[1] Li et al. BLIP-2.');
    expect(html).toContain('id="ltx-bib-qi2024visual">[2] Qi et al. Visual comparison.');
    // 引用 key 不外露为原始文本
    expect(html).not.toContain('citeli2023blip2');
  });

  it('natbib 的 \\citep/\\citet（含可选参数）同样编号，key 不外露', () => {
    const tex = `Squeezing \\citep{guo2018countering,xie2018mitigating} and \\citet[see][p.~3]{qi2024visual}.`;
    const html = renderLatexToHtml(tex);
    expect(html).toContain('<sup class="ltx-cite">[<a href="#ltx-bib-guo2018countering" class="ltx-ref">1</a>,<a href="#ltx-bib-xie2018mitigating" class="ltx-ref">2</a>]</sup>');
    expect(html).toContain('<sup class="ltx-cite">[<a href="#ltx-bib-qi2024visual" class="ltx-ref">3</a>]</sup>');
    expect(html).not.toContain('guo2018countering,');
    expect(html).not.toContain('citep');
  });

  it('连续 ≥3 个引用按 natbib sort&compress 压成区间', () => {
    const tex = 'Feature squeezing \\citep{a,b,c} and two \\citep{d,e}.';
    const html = renderLatexToHtml(tex);
    expect(html).toContain('class="ltx-ref">1</a>-<a href="#ltx-bib-c" class="ltx-ref">3</a>');
    expect(html).toContain('<sup class="ltx-cite">[<a href="#ltx-bib-d" class="ltx-ref">4</a>,<a href="#ltx-bib-e" class="ltx-ref">5</a>]</sup>');
  });

  it('\\bibliography{...} 行本身不输出', () => {
    const html = renderLatexToHtml('Text.\n\\bibliography{refs}');
    expect(html).not.toContain('refs');
  });

  it('行内 $...$ 与多行 equation 环境渲染为 KaTeX HTML', () => {
    const tex = `Inline $\\ell_\\infty$ norm.
\\begin{equation}
a^2 + b^2 = c^2 \\label{eq:pyth}
\\end{equation}
Done.`;
    const html = renderLatexToHtml(tex);
    expect(html).toContain('class="ltx-math"');
    expect(html).toContain('ltx-displaymath');
    // KaTeX 输出标志
    expect(html).toContain('class="katex"');
    // 环境内 \label 成为锚点且不破坏渲染
    expect(html).toContain('id="ltx-label-eq:pyth"');
    // KaTeX 渲染出实际符号（ℓ），而非残留源码文本
    expect(html).toContain('ℓ');
  });

  it('数学解析失败回退为 .ltx-math-err 原文', () => {
    const html = renderLatexToHtml('Bad $\\notacommandxyz{$ math.');
    expect(html).toContain('ltx-math-err');
  });

  it('\\includegraphics 的 PDF 路径交给 resolveImage（走 figure 端点）', () => {
    const tex = `\\begin{figure}
\\centering
\\includegraphics[width=0.8\\textwidth]{Fig/intro_figure.pdf}
\\caption{Overview.}
\\label{fig:intro}
\\end{figure}`;
    const seen = [];
    const html = renderLatexToHtml(tex, {
      resolveImage: (p) => { seen.push(p); return `/api/projects/1/figure?path=${encodeURIComponent(p)}`; },
    });
    expect(seen).toEqual(['Fig/intro_figure.pdf']);
    expect(html).toContain('src="/api/projects/1/figure?path=Fig%2Fintro_figure.pdf"');
    expect(html).toContain('<figure id="ltx-label-fig:intro">');
    expect(html).toContain('<figcaption>Overview.</figcaption>');
  });

  it('~ 渲染为 &nbsp;', () => {
    const html = renderLatexToHtml('Model~\\ref{sec:x} works.');
    expect(html).toContain('Model&nbsp;');
    expect(html).not.toContain('Model~');
  });

  it('table* 星号环境渲染且编号按文档顺序（不因候选落选而虚增）', () => {
    const tex = `\\begin{document}
\\begin{table*}[t]
\\caption{First.}
\\begin{tabular}{@{}llcccc@{}}
A & B & C & D & E & F \\\\
G & H & I & J & K & L \\\\
\\end{tabular}
\\end{table*}
\\begin{table}[t]
\\caption{Second.}
\\begin{tabular}{lc}E & F \\\\
\\end{tabular}
\\end{table}
\\begin{table}[t]
\\caption{Third.}
\\begin{tabular}{lc}G & H \\\\
\\end{tabular}
\\end{table}
\\end{document}`;
    const html = renderLatexToHtml(tex);
    const nums = html.match(/Table \d+/g) || [];
    expect(nums).toEqual(['Table 1', 'Table 2', 'Table 3']);
    // 三张表全部渲染（含星号环境）
    expect((html.match(/class="ltx-table"/g) || []).length).toBe(3);
    expect(html).toContain('First.');
    expect(html).toContain('Second.');
    expect(html).toContain('Third.');
  });

  it('未识别命令剥掉命令名但保留参数文本', () => {
    const html = renderLatexToHtml('A \\foo{bar} and \\LaTeX{} logo.');
    expect(html).toContain('bar');
    expect(html).not.toContain('\\foo');
    expect(html).not.toContain('\\LaTeX');
  });

  it('booktabs 表格渲染为 <table>：首行表头、单元格按 & 与 \\\\ 切分、保留列对齐', () => {
    const tex = `\\begin{document}
\\begin{table}[htbp]
\\centering
\\caption{Main results.}
\\begin{tabular}{lcc}
\\toprule
Method & Acc & F1 \\\\
\\midrule
Baseline & 67.1 & 58.2 \\\\
\\textbf{Ours} & \\textbf{78.0} & 69.4 \\\\
\\bottomrule
\\end{tabular}
\\end{table}
\\end{document}`;
    const html = renderLatexToHtml(tex);
    expect(html).toContain('<table class="ltx-tabular">');
    expect(html).toContain('<thead>');
    expect(html).toContain('<th style="text-align:left">Method</th>');
    expect(html).toContain('<th style="text-align:center">Acc</th>');
    expect(html).toContain('<td style="text-align:left">Baseline</td>');
    expect(html).toContain('<td style="text-align:center">67.1</td>');
    expect(html).toContain('<strong>Ours</strong>');
    // 原始分隔符不残留
    expect(html).not.toContain('&amp;');
    expect(html).not.toContain('\\\\');
    expect(html).not.toContain('\\toprule');
    // 表题编号
    expect(html).toContain('Table 1');
    expect(html).toContain('Main results.');
  });

  it('\\multicolumn 渲染为 colspan', () => {
    const tex = `\\begin{tabular}{cc}
\\multicolumn{2}{c}{Overview} \\\\
A & B \\\\
\\end{tabular}`;
    const html = renderLatexToHtml(tex);
    expect(html).toContain('colspan="2"');
    expect(html).toContain('Overview');
  });

  it('列格式含嵌套大括号（@{}）时不泄漏为单元格，对齐仍生效', () => {
    const tex = `\\begin{tabular}{@{}lcccc@{}}
Method & A & B & C & D \\\\
X & 1 & 2 & 3 & 4 \\\\
\\end{tabular}`;
    const html = renderLatexToHtml(tex);
    expect(html).not.toContain('@lcccc');
    expect(html).not.toContain('@{}');
    expect(html).toContain('<td style="text-align:left">Method</td>');
    expect(html).toContain('<td style="text-align:center">1</td>');
  });

  it('单元格内的 \\\\（\\makecell 类）不把行切碎，转为 <br>', () => {
    const tex = `\\begin{tabular}{lc}
\\makecell{(lr)3-5\\\\(lr)6-8} & 34.78 \\\\
Other & 12.00 \\\\
\\end{tabular}`;
    const html = renderLatexToHtml(tex);
    expect(html).toContain('<br>');
    expect(html).toContain('34.78');
    // 两行数据，而不是被单元格内部 \\\\ 切碎后产生的多行
    expect(html.match(/<tr>/g).length).toBe(2);
  });

  it('\\multirow 渲染为 rowspan', () => {
    const tex = `\\begin{tabular}{cc}
\\multirow{2}{*}{VAE} & 1.0 \\\\
 & 2.0 \\\\
\\end{tabular}`;
    const html = renderLatexToHtml(tex);
    expect(html).toContain('rowspan="2"');
    expect(html).toContain('VAE');
  });

  it('双行表头：\\cmidrule 不泄漏为文本，multirow 续行的占位空格被跳过（列不错位）', () => {
    const tex = `\\begin{tabular}{@{}llccccccccc@{}}
\\toprule
\\multirow{2}{*}{Attack} & \\multirow{2}{*}{Defense} &
\\multicolumn{3}{c}{LLaVA} & \\multicolumn{3}{c}{InstructBLIP} & \\multicolumn{3}{c}{Qwen} \\\\
\\cmidrule(lr){3-5} \\cmidrule(lr){6-8} \\cmidrule(lr){9-11}
 & & ASR & VQA & CIDEr & ASR & VQA & CIDEr & ASR & VQA & CIDEr \\\\
\\midrule
\\multirow{2}{*}{VAE} & No Defense & 84.57 & a & b & 76.34 & c & d & 79.41 & e & f \\\\
 & JPEG & 38.42 & g & h & 36.50 & i & j & 25.03 & k & l \\\\
\\bottomrule
\\end{tabular}`;
    const html = renderLatexToHtml(tex);
    // \cmidrule 及其 (lr) 修剪参数不泄漏为文本
    expect(html).not.toContain('(lr)');
    expect(html).toContain('rowspan="2"');
    // 表头共 14 个 th：行1 = Attack/Defense + 3 组组名；行2 跳过被 rowspan 覆盖的前两列后剩 9 个
    expect((html.match(/<th /g) || []).length).toBe(14);
    // 数据行仍为 11 列结构：84.57 在 No Defense 之后、VAE 组内不错位
    expect(html).toContain('>No Defense</td>');
    expect(html).toContain('>84.57<');
  });

  it('algorithm/algorithmic 渲染为结构化伪代码：标题、关键词加粗、逐行保留、行内公式可用', () => {
    const tex = `\\begin{document}
\\begin{algorithm}
\\caption{Purification pipeline}
\\begin{algorithmic}
\\REQUIRE Input image $I_{adv}$
\\STATE $X \\leftarrow T_s(I_{adv})$
\\FOR{each scale $s$ in $S$}
\\STATE Purify $X$ using denoiser
\\ENDFOR
\\RETURN $I_{pur}$
\\end{algorithmic}
\\end{algorithm}
\\end{document}`;
    const html = renderLatexToHtml(tex);
    expect(html).toContain('class="ltx-algo"');
    expect(html).toContain('Algorithm 1');
    expect(html).toContain('Purification pipeline');
    // 关键词加粗
    expect(html).toContain('<strong class="ltx-kw">for</strong>');
    expect(html).toContain('<strong class="ltx-kw">return</strong>');
    // 逐行结构（不是挤成一段）
    expect(html.match(/class="ltx-algo-line"/g).length).toBeGreaterThanOrEqual(5);
    // 行内公式经 KaTeX 渲染
    expect(html).toContain('katex');
    // 算法命令名不残留
    expect(html).not.toContain('\\STATE');
    expect(html).not.toContain('\\algorithmic');
  });
});

describe('pickImagePath', () => {
  it('有扩展名原样返回', () => {
    expect(pickImagePath('fig/a.png', () => false)).toBe('fig/a.png');
  });

  it('无扩展名按 pdf/png/jpg/jpeg/webp 顺序补全', () => {
    const exists = (p) => p === 'fig/a.png';
    expect(pickImagePath('fig/a', exists)).toBe('fig/a.png');
    const pdfOnly = (p) => p === 'fig/a.pdf';
    expect(pickImagePath('fig/a', pdfOnly)).toBe('fig/a.pdf');
  });

  it('都不存在时返回原路径', () => {
    expect(pickImagePath('fig/missing', () => false)).toBe('fig/missing');
  });
});
