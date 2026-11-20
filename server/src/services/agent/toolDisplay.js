// Presentation is deliberately separate from model content. Never put this
// envelope into the tool's text block or use it as evidence of execution.
// No frontend runtime dependency: toolMetadata.test.js verifies this mirror.
const SPECS = {
  list_files: ['files', '列出文件'], read_file: ['read', '读取文件'],
  read_workspace: ['files', '查看工作区'], view_image: ['image', '查看图像'],
  write_file: ['edit', '写入文件'], edit_file: ['edit', '修改文件'],
  copy_to_project: ['edit', '复制到项目'], run_in_workspace: ['command', '运行命令'],
  get_document_context: ['context', '获取文档上下文'], read_skill: ['skill', '读取技能'],
  run_skill_script: ['command', '运行技能脚本'], compile_and_preview: ['compile', '编译并预览'],
  web_search: ['search', '联网搜索'], web_fetch: ['web', '读取网页'],
  report_progress: ['progress', '报告进度'], ask_user: ['question', '询问用户'],
  plan_task_graph: ['generic', '规划任务图'],
  run_agent_graph: ['generic', '执行智能体协作'],
  run_parallel_edits: ['generic', '并行编辑'],
  submit_agent_report: ['generic', '提交协作报告'],
  set_chinese_alignment_scope: ['generic', '设置中英对照范围'],
  run_workspace: ['command', '运行工作区命令'],
  run_workspace_command: ['command', '执行工作区命令'],
  grep_files: ['search', '搜索文件内容'],
  prepare_env: ['command', '准备环境'],
  inspect_runtime_resources: ['generic', '检查运行环境'],
  install_tex_packages: ['generic', '安装 TeX 宏包'],
  install_font: ['generic', '安装字体'],
};
const SECRET = /(?:api[_-]?key|token|authorization|password|passwd|secret|credential|cookie)/i;

export function sanitizeToolText(value, limit = 16_000) {
  return String(value ?? '')
    .replace(/data:[\w.+/-]+;base64,[A-Za-z0-9+/=\s]+/g, '[图像数据已省略]')
    .replace(/("(?:imageBase64|data|blob)"\s*:\s*")[A-Za-z0-9+/=]{128,}"/g, '$1[二进制数据已省略]"')
    .replace(/[A-Za-z0-9+/]{512,}={0,2}/g, '[二进制数据已省略]')
    .replace(/(Bearer\s+)[^\s"',;]+/gi, '$1[已隐藏]')
    .replace(/((?:api[_-]?key|(?:access[_-]?|refresh[_-]?)?token|authorization|password|passwd|secret|credential|cookie)\s*["']?\s*[:=]\s*["']?)[^\s"',;&]+/gi, '$1[已隐藏]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[已隐藏]@')
    .slice(0, limit);
}

export function safeToolDebug(value, limit = 2000) {
  if (typeof value === 'string') {
    try { return safeToolDebug(JSON.parse(value), limit); } catch { return sanitizeToolText(value, limit); }
  }
  const seen = new WeakSet();
  const clean = (v, depth = 0) => {
    if (typeof v === 'string') return sanitizeToolText(v, limit);
    if (!v || typeof v !== 'object') return v;
    if (depth > 5 || seen.has(v)) return '[已省略]';
    seen.add(v);
    if (Array.isArray(v)) return v.slice(0, 30).map((x) => clean(x, depth + 1));
    return Object.fromEntries(Object.entries(v).slice(0, 40).map(([k, x]) => [k,
      SECRET.test(k) ? '[已隐藏]' : /^(imageBase64|blob)$/i.test(k) || k === 'data' && v.type === 'image'
        ? '[二进制数据已省略]' : clean(x, depth + 1)]));
  };
  return sanitizeToolText(JSON.stringify(clean(value)), limit);
}

function url(value) {
  try {
    const u = new URL(String(value));
    if (!['http:', 'https:'].includes(u.protocol)) return undefined;
    if (u.username || u.password) return undefined;
    for (const key of u.searchParams.keys()) if (SECRET.test(key)) return undefined;
    return u.href.slice(0, 2000);
  } catch { return undefined; }
}

export function buildToolDisplay(name, input = {}, output, { meta = {}, images = [], status = 'end' } = {}) {
  name = String(name ?? '');
  const fallbackTitle = `${name.startsWith('mcp__') ? '外部工具' : '其他工具'}（${name || '未命名'}）`;
  const [kind, title] = Object.hasOwn(SPECS, name) ? SPECS[name] : ['generic', sanitizeToolText(fallbackTitle, 500)];
  const d = { version: 1, kind, title, summary: '', fields: [] };
  const field = (label, value) => { if (value !== undefined && value !== null && value !== '') d.fields.push({ label, value: sanitizeToolText(value, 500) }); };
  const text = (value, key = 'text', max = 16_000) => {
    if (value == null || value === '') return;
    d[key] = sanitizeToolText(value, max);
    if (String(value).length > max) d.truncated = true;
  };
  const compileTiming = c => {
    const value = c.reused ? c.originalDurationMs : c.durationMs;
    field(c.reused ? '原编译耗时' : '耗时', value == null ? undefined : `${value} ms`);
    if (c.reused) field('编译执行', '复用本轮同版本结果，未重新编译');
  };
  const out = output && typeof output === 'object' ? output : {};
  const body = typeof output === 'string' ? output : out.text ?? out.content ?? '';
  const file = input.path || input.targetPath || out.path;
  field('文件', file);
  if (name === 'copy_to_project') field('来源', input.workspacePath);
  if (status !== 'end' || out.error) {
    d.summary = status === 'start' ? '正在执行' : status === 'cancelled' ? '操作已停止，结果未确认' : '执行失败';
    if (status !== 'start') text(out.error || body || '工具未返回可确认的结果', 'notice', 4000);
    if (kind === 'search') {
      field('搜索词', input.query);
      field('来源', meta.search?.engine || [...new Set((meta.search?.attempts || []).filter(item => !/not_configured$/.test(item.reason || '')).map(item => item.engine).filter(Boolean))].join('、'));
    }
    if (kind === 'command') {
      field('命令', input.command || [input.script, input.args].filter(Boolean).join(' ')); field('技能', input.skill);
      const c = meta.command || out;
      field('退出码', c.exitCode); if (c.timedOut) field('执行状态', '已超时');
      text([c.stdout, c.stderr ? `[stderr]\n${c.stderr}` : ''].filter(Boolean).join('\n'));
    }
    if (kind === 'compile' && meta.compile) {
      const c = meta.compile;
      if (c.reused && status !== 'start' && status !== 'cancelled') d.summary = c.errors?.length
        ? '编译失败，复用本轮同版本诊断，未重新编译'
        : '预览失败，复用本轮同版本编译结果，未重新编译';
      field('编译引擎', c.engine); compileTiming(c);
      field('版本', c.previewMode ? '磁盘基线 + 本轮暂存修改（隔离预览）' : '项目正式版本');
      d.items = (c.errors || []).slice(0, 30).map(e => ({ label: sanitizeToolText(e.message || e, 2000), ...(e.file ? { path: sanitizeToolText(e.file, 500) } : {}), ...(e.line ? { detail: `第 ${e.line} 行` } : {}) }));
    }
    return d;
  }
  if (['inspect_runtime_resources', 'install_tex_packages', 'install_font'].includes(name)) {
    d.summary = name === 'inspect_runtime_resources' ? '已检查可用字体与 TeX 版本'
      : out.changed ? '运行环境已更新' : '资源已可用，环境未改变';
    field('TeX 版本', out.version || out.currentVersion || input.version);
    field('宏包', Array.isArray(out.packages || input.packages) ? (out.packages || input.packages).join('、') : undefined);
    field('字体', Array.isArray(out.fonts) ? out.fonts.length + ' 项' : undefined);
    text(out.output || safeToolDebug(output, 16000));
    if (out.changed) d.notice = '资源已持久保存；排版结果需使用更新后的环境重新验证。';
    return d;
  }
  if (name === 'run_parallel_edits') {
    d.summary = out.merged ? out.changed ? '并行修改已合并到主草稿' : '并行任务完成，内容未改变' : '并行编辑已返回';
    field('编辑任务', Array.isArray(input.tasks) ? input.tasks.length : undefined);
    field('修改文件', Array.isArray(out.changedPaths) ? out.changedPaths.join('、') : undefined);
    d.items = (out.reports || []).map(item => ({ label: sanitizeToolText(item.id, 120), detail: sanitizeToolText(item.report?.summary || '', 2000) }));
    if (out.merged) d.notice = '修改已汇入本轮待审草稿；最终应用情况请查看变更审阅。';
    for (const draft of out.drafts || []) field('保留草稿', draft.draftPath);
    return d;
  }
  if (images.length) d.images = images;
  switch (kind) {
    case 'compile': {
      const c = meta.compile || {};
      const viewedPages = c.pages?.length || images.length;
      d.summary = `${c.reused ? '复用本轮同版本编译结果，未重新编译' : '编译成功'}${viewedPages ? `，已读取 ${viewedPages} 页图像` : ''}`;
      if (c.reused) field('页面来源', c.renderedFromCache ? '复用本轮页面快照' : '由本轮 PDF 快照重新渲染');
      field('文档页数', c.totalPages || undefined);
      field('已读取页面', (c.pages || images.map((i) => i.page).filter(Boolean)).join('、'));
      field('编译引擎', c.engine); compileTiming(c);
      field('图像精度', c.dpi ? `${c.dpi} DPI` : undefined);
      field('版本', c.previewMode === true ? '磁盘基线 + 本轮暂存修改（隔离预览）' : c.previewMode === false ? '项目正式版本' : undefined);
      field('警告', c.warnings?.length);
      if (c.warnings?.length) d.items = c.warnings.slice(0, 20).map((w) => ({ label: sanitizeToolText(w.message || w, 1000), ...(w.file ? { path: sanitizeToolText(w.file, 500) } : {}) }));
      if (c.droppedPages?.length) d.notice = `第 ${c.droppedPages.join('、')} 页达到单次图像上限，未返回给智能体。`;
      if (!meta.compile) text(body);
      break;
    }
    case 'image':
      d.summary = images.length ? '已读取图像' : '图像已读取，预览暂不可用';
      field('版本', String(body).includes('暂存') ? '本轮暂存版本' : '文件读取时的快照');
      break;
    case 'read': {
      const search = meta.fileSearch, r = meta.read || search || {};
      d.summary = search ? `匹配 ${search.matchedLines} 行` : r.start ? `已读取第 ${r.start}–${r.end} 行` : '已读取文件内容';
      if (search) { field('查找文本', input.find); field('匹配行号', search.matchLines.join('、')); }
      field('总行数', r.totalLines); field('版本', r.view === 'project' ? '当前正式文件' : r.staged ? '本轮暂存版本' : '文件读取时的快照');
      if (out.conflict) d.notice = '正式文件已变化，当前草稿存在基线冲突；需核对双方内容后继续。';
      d.startLine = r.start || Math.max(1, Number(input.offset) || 1);
      d.language = String(file || '').split('.').pop();
      text(r.content ?? body); if (r.truncated) d.truncated = true;
      break;
    }
    case 'edit': {
      d.outcome = out.applied ? 'applied' : out.staged ? 'staged' : out.changed ? 'restored' : 'no-change';
      d.summary = { applied: '已写入工作区', staged: '执行时已暂存修改', restored: '暂存修改已恢复到原始版本', 'no-change': '内容相同，未产生修改' }[d.outcome];
      field('位置', out.scope === 'workspace' ? '智能体工作区' : '项目文件');
      const e = meta.edit || {};
      field('对比范围', e.scope || (name === 'edit_file' ? '唯一匹配的替换片段' : undefined));
      if (!e.binary) {
        let before = String(e.before ?? input.search ?? ''), after = String(e.after ?? input.replace ?? '');
        if ((before.length > 10_000 || after.length > 10_000) && before !== after) {
          let prefix = 0;
          while (prefix < Math.min(before.length, after.length) && before[prefix] === after[prefix]) prefix++;
          const offset = Math.max(0, prefix - 300);
          field('截取位置', `从原内容第 ${before.slice(0, offset).split('\n').length} 行附近起，展示实际改动位置`);
          before = before.slice(offset); after = after.slice(offset); d.truncated = true;
        }
        if (e.before !== undefined || name === 'edit_file') d.before = sanitizeToolText(before, 10_000);
        if (e.after !== undefined || name === 'edit_file') d.after = sanitizeToolText(after, 10_000);
        if (before.length > 10_000 || after.length > 10_000) d.truncated = true;
      } else d.notice = '二进制文件已复制，内容不以文本差异展示。';
      if (out.staged) d.notice = '工具执行时修改处于暂存状态；本轮最终应用情况请查看变更审阅。';
      break;
    }
    case 'files': {
      const entries = meta.files || (name === 'list_files' ? String(body).split('\n').filter((x) => x && !x.startsWith('（')).map((p) => ({ label: p, path: p })) : []);
      d.summary = entries.length ? `已列出 ${entries.length} 个文件或目录` : '已查看文件列表';
      d.items = entries.slice(0, 100).map((i) => ({ label: sanitizeToolText(i.label || i.path, 500), ...(i.path ? { path: sanitizeToolText(i.path, 500) } : {}), ...(i.detail ? { detail: sanitizeToolText(i.detail, 2000) } : {}) }));
      if (entries.length > 100) d.truncated = true;
      if (name === 'read_workspace' || !entries.length) text(body);
      if (meta.filesTruncated) { d.truncated = true; d.notice = '工作区文件较多，本次只返回前 50 个文件。'; }
      break;
    }
    case 'search':
      d.summary = `找到 ${meta.search?.results?.length ?? 0} 条候选结果`;
      field('搜索词', input.query); field('来源', meta.search?.engine);
      if (meta.search?.notice) text(meta.search.notice, 'notice', 4000);
      if (meta.search) d.items = meta.search.results.slice(0, 10).map((r) => ({ label: sanitizeToolText(r.title || r.url, 500), detail: sanitizeToolText(r.snippet, 2000), ...(url(r.url) ? { url: url(r.url) } : {}) }));
      else { d.summary = '已返回搜索结果'; text(body); }
      break;
    case 'web':
      d.summary = sanitizeToolText(meta.web?.title || '已读取网页正文', 300);
      d.items = [{ label: '来源网页', ...(url(meta.web?.url || input.url) ? { url: url(meta.web?.url || input.url) } : {}) }];
      text(meta.web?.text ?? body); break;
    case 'command': {
      d.summary = '命令执行完成';
      field('命令', input.command || [input.script, input.args].filter(Boolean).join(' ')); field('技能', input.skill);
      const c = meta.command || out;
      field('退出码', c.exitCode ?? 0);
      text(c.stdout != null || c.stderr != null ? [c.stdout, c.stderr ? `[stderr]\n${c.stderr}` : ''].filter(Boolean).join('\n') : body || '（无输出）');
      break;
    }
    case 'skill':
      d.summary = '已读取技能说明'; field('技能', input.name); field('附属文件', input.file);
      text(body); if (String(body).includes('[以下未读取成功]')) d.notice = String(body).split('[以下未读取成功]')[1].slice(0, 2000);
      break;
    case 'context':
      d.summary = out.file ? '已读取编辑器上下文' : '当前没有打开的文档'; field('当前文档', out.file);
      text(out.content); d.notice = '这是本轮请求发起时的编辑器内容快照。'; break;
    case 'question':
      d.summary = '已收到用户回答'; field('问题', input.question); text(out.answer ?? body); break;
    case 'progress':
      d.summary = sanitizeToolText(body || input.summary || '进度已更新', 500); break;
    default:
      d.summary = '工具已返回结果'; field('工具', name);
      text(body || safeToolDebug(output, 16_000));
  }
  if (meta.imageNotice) d.notice = [d.notice, meta.imageNotice].filter(Boolean).join('\n');
  return d;
}
