// Markdown → HTML（Visual 预览 / CoreAgent 对话面板）：marked 渲染 + 最小消毒
// 消毒策略：自定义 renderer 覆盖 html() —— 原始 HTML 一律转义为文本；
// link/image 的 href 经 sanitizeUrl 过滤，拒绝 javascript: 等危险协议。
import { Marked } from 'marked';

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** 返回安全 URL，危险协议返回 null */
function sanitizeUrl(url) {
  const u = String(url || '').trim();
  if (/^(https?:|mailto:|#|\/)/i.test(u)) return u;
  if (/^data:image\//i.test(u)) return u;
  if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return null; // javascript:、vbscript: 等一律拒绝
  return u; // 无协议的相对路径
}

function isRelativeUrl(u) {
  return !/^(https?:|mailto:|#|\/|data:)/i.test(u);
}

/**
 * renderMarkdownToHtml(md, { resolveImage, breaks }) → HTML 字符串
 * resolveImage(path) 把相对图片路径映射为可访问 URL。
 * breaks=true 时单个换行也折行（聊天面板用，保留用户纯文本的换行观感）。
 */
export function renderMarkdownToHtml(md, { resolveImage, breaks = false } = {}) {
  if (!md) return '';
  const marked = new Marked({
    gfm: true,
    breaks: !!breaks,
    renderer: {
      html({ text }) {
        return escapeHtml(text);
      },
      link({ href, title, tokens, text, autolink }) {
        const inner = autolink ? escapeHtml(text) : this.parser.parseInline(tokens);
        const safe = sanitizeUrl(href);
        if (safe === null) return inner;
        let out = `<a href="${escapeHtml(safe)}"`;
        if (title) out += ` title="${escapeHtml(title)}"`;
        out += ' target="_blank" rel="noopener noreferrer">';
        return out + inner + '</a>';
      },
      image({ href, title, text, tokens }) {
        const alt = tokens ? this.parser.parseInline(tokens, this.parser.textRenderer) : text;
        const safe = sanitizeUrl(href);
        if (safe === null) return escapeHtml(alt);
        const src = resolveImage && isRelativeUrl(safe) ? resolveImage(safe) : safe;
        let out = `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}"`;
        if (title) out += ` title="${escapeHtml(title)}"`;
        return out + '>';
      },
    },
  });
  return marked.parse(md);
}

export const MD_CSS = `
.md-visual { font-family: -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif; line-height: 1.75; padding: 24px 32px; color: var(--fg); }
.md-visual h1, .md-visual h2, .md-visual h3, .md-visual h4, .md-visual h5, .md-visual h6 {
  line-height: 1.3; margin: 1.2em 0 0.6em; color: var(--fg);
}
.md-visual h1 { font-size: 1.7em; border-bottom: 1px solid var(--border); padding-bottom: 0.3em; }
.md-visual h2 { font-size: 1.4em; border-bottom: 1px solid var(--border); padding-bottom: 0.25em; }
.md-visual h3 { font-size: 1.2em; }
.md-visual h4 { font-size: 1.05em; }
.md-visual p { margin: 0.7em 0; }
.md-visual a { color: var(--accent); text-decoration: none; }
.md-visual a:hover { text-decoration: underline; }
.md-visual ul, .md-visual ol { padding-left: 1.8em; margin: 0.7em 0; }
.md-visual li { margin: 0.25em 0; }
.md-visual blockquote {
  margin: 0.8em 0; padding: 4px 14px; color: var(--fg-dim);
  border-left: 3px solid var(--accent); background: var(--bg2); border-radius: 0 6px 6px 0;
}
.md-visual code {
  font-family: var(--mono); font-size: 0.92em;
  background: var(--bg3); padding: 1px 5px; border-radius: 4px;
}
.md-visual pre {
  background: var(--bg2); border: 1px solid var(--border); border-radius: 6px;
  padding: 12px 14px; overflow-x: auto; margin: 0.8em 0;
}
.md-visual pre code { background: none; padding: 0; }
.md-visual table { border-collapse: collapse; margin: 0.8em 0; width: auto; max-width: 100%; }
.md-visual th, .md-visual td { border: 1px solid var(--border); padding: 6px 12px; }
.md-visual th { background: var(--bg2); }
.md-visual tr:nth-child(even) td { background: var(--bg2); }
.md-visual img { max-width: 100%; border-radius: 6px; }
.md-visual hr { border: none; border-top: 1px solid var(--border); margin: 1.4em 0; }
.md-visual del { color: var(--fg-dim); }
`;

// 对话面板（280-560px 窄栏）用的紧凑 Markdown 样式，配 .md-chat 使用。
// 与 MD_CSS 分开：那里的字号/间距是给宽页面预览的，在气泡里会撑破面板。
export const CHAT_MD_CSS = `
.md-chat { line-height: 1.6; word-break: break-word; overflow-wrap: anywhere; }
.md-chat > *:first-child { margin-top: 0; }
.md-chat > *:last-child { margin-bottom: 0; }
.md-chat h1, .md-chat h2, .md-chat h3,
.md-chat h4, .md-chat h5, .md-chat h6 {
  margin: 0.7em 0 0.4em; line-height: 1.35; font-weight: 700; color: var(--fg);
}
.md-chat h1 { font-size: 1.15em; }
.md-chat h2 { font-size: 1.05em; }
.md-chat h3, .md-chat h4, .md-chat h5, .md-chat h6 { font-size: 1em; }
.md-chat p { margin: 0.5em 0; }
.md-chat strong { font-weight: 600; }
.md-chat ul, .md-chat ol { margin: 0.4em 0; padding-left: 1.4em; }
.md-chat li { margin: 0.15em 0; }
.md-chat li > p { margin: 0.2em 0; }
.md-chat a { color: var(--accent); text-decoration: none; }
.md-chat a:hover { text-decoration: underline; }
.md-chat code {
  font-family: var(--mono); font-size: 0.92em;
  background: var(--bg3); padding: 1px 4px; border-radius: 3px;
}
.md-chat pre {
  margin: 0.5em 0; padding: 7px 9px;
  background: var(--bg2); border: 1px solid var(--border); border-radius: 6px;
  font-family: var(--mono); font-size: 12px; line-height: 1.5;
  white-space: pre-wrap; overflow-wrap: anywhere; overflow-x: hidden;
}
.md-chat pre code { background: none; padding: 0; font-size: inherit; }
.md-chat blockquote {
  margin: 0.5em 0; padding: 2px 10px;
  color: var(--fg-dim); background: var(--bg2);
  border-left: 3px solid var(--border); border-radius: 0 4px 4px 0;
}
.md-chat table {
  display: block; overflow-x: auto; max-width: 100%;
  border-collapse: collapse; margin: 0.5em 0; font-size: 12px;
}
.md-chat th, .md-chat td { border: 1px solid var(--border); padding: 3px 8px; white-space: nowrap; }
.md-chat th { background: var(--bg2); }
.md-chat tr:nth-child(even) td { background: var(--bg2); }
.md-chat img { max-width: 100%; border-radius: 4px; }
.md-chat hr { border: none; border-top: 1px solid var(--border); margin: 0.8em 0; }
.md-chat del { color: var(--fg-dim); }
`;

// 流式输出光标：挂在最后一个块级元素末尾（内容为空时挂容器上）
export const CHAT_CURSOR_CSS = `
.md-chat.is-streaming > *:last-child::after,
.md-chat.is-streaming:empty::after {
  content: ''; display: inline-block;
  width: 6px; height: 1em; margin-left: 2px;
  vertical-align: text-bottom; background: var(--accent);
  animation: md-chat-blink 1s steps(1) infinite;
}
@keyframes md-chat-blink { 50% { opacity: 0; } }
`;
