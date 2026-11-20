import { describe, it, expect } from 'vitest';
import { renderMarkdownToHtml, MD_CSS, CHAT_MD_CSS, CHAT_CURSOR_CSS } from './markdown2html.js';

describe('renderMarkdownToHtml', () => {
  it('渲染标题、加粗、列表、代码块、引用、表格、链接', () => {
    const md = `# Title
## Section
Some **bold** and *em* text.

- first
- second

> a quote

\`\`\`js
const x = 1;
\`\`\`

| A | B |
|---|---|
| 1 | 2 |

[link](https://example.com)`;
    const html = renderMarkdownToHtml(md);
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<h2>Section</h2>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>em</em>');
    expect(html).toContain('<li>first</li>');
    expect(html).toContain('<blockquote>');
    expect(html).toContain('<code class="language-js">');
    expect(html).toContain('<table>');
    expect(html).toContain('<td>1</td>');
    expect(html).toContain('href="https://example.com"');
  });

  it('原始 HTML 被转义，不产生脚本注入', () => {
    const html = renderMarkdownToHtml('# Hi\n\n<script>alert(1)</script>\n\n<div onclick="x()">raw</div>');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<div');
    expect(html).toContain('&lt;script&gt;');
  });

  it('javascript: 链接被剥除 href', () => {
    const html = renderMarkdownToHtml('[click](javascript:alert(1))');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('<a href');
    expect(html).toContain('click');
  });

  it('相对图片路径经 resolveImage 映射，绝对 URL 保持不变', () => {
    const html = renderMarkdownToHtml('![fig](fig/a.png) ![web](https://x.com/b.png)', {
      resolveImage: (p) => `/files/${p}`,
    });
    expect(html).toContain('src="/files/fig/a.png"');
    expect(html).toContain('src="https://x.com/b.png"');
  });

  it('空输入返回空串', () => {
    expect(renderMarkdownToHtml('')).toBe('');
    expect(renderMarkdownToHtml(null)).toBe('');
  });

  it('breaks=true 时单个换行也折行（聊天面板保留纯文本换行）', () => {
    expect(renderMarkdownToHtml('第一行\n第二行', { breaks: true })).toContain('<br>');
    expect(renderMarkdownToHtml('第一行\n第二行')).not.toContain('<br>');
  });
});

describe('聊天面板 Markdown 样式', () => {
  it('CHAT_MD_CSS 只作用于 .md-chat，不影响 .md-visual', () => {
    expect(CHAT_MD_CSS).toContain('.md-chat');
    expect(CHAT_MD_CSS).not.toContain('.md-visual');
  });

  it('紧凑排版关键规则齐备', () => {
    expect(CHAT_MD_CSS).toContain('.md-chat h1 { font-size: 1.15em; }');
    expect(CHAT_MD_CSS).toContain('.md-chat h2 { font-size: 1.05em; }');
    expect(CHAT_MD_CSS).toContain('.md-chat pre');
    expect(CHAT_MD_CSS).toContain('white-space: pre-wrap');
    expect(CHAT_MD_CSS).toContain('display: block; overflow-x: auto');
  });

  it('光标样式挂在流式容器上', () => {
    expect(CHAT_CURSOR_CSS).toContain('.md-chat.is-streaming');
  });

  it('MD_CSS 仍只作用于 .md-visual', () => {
    expect(MD_CSS).toContain('.md-visual');
    expect(MD_CSS).not.toContain('.md-chat');
  });
});
