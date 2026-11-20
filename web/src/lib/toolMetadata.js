// All user-facing tool names share this catalog. Keep server toolDisplay titles
// in sync; toolMetadata.test.js checks both current definitions and server output.
export const TOOL_METADATA = Object.freeze({
  list_files: { label: '列出文件', desc: '浏览项目的文件与目录结构', kind: 'files' },
  read_file: { label: '读取文件', desc: '读取项目文件的内容或指定行范围', kind: 'read' },
  read_workspace: { label: '查看工作区', desc: '查看智能体工作区的文件清单与内容预览', kind: 'files' },
  view_image: { label: '查看图像', desc: '预览项目、草稿或工作区的图片与单页 PDF 图稿', kind: 'image' },
  write_file: { label: '写入文件', desc: '新建文件或整体替换文件内容', kind: 'edit' },
  edit_file: { label: '修改文件', desc: '通过精确查找替换修改文件的局部内容', kind: 'edit' },
  copy_to_project: { label: '复制到项目', desc: '把工作区产物复制到项目正式位置', kind: 'edit' },
  run_in_workspace: { label: '运行命令', desc: '从智能体工作区启动命令或脚本', kind: 'command' },
  get_document_context: { label: '获取文档上下文', desc: '获取用户当前打开的文件路径与内容', kind: 'context' },
  read_skill: { label: '读取技能', desc: '读取技能说明及其附属文件，了解具体操作方法', kind: 'skill' },
  run_skill_script: { label: '运行技能脚本', desc: '执行技能提供的脚本文件', kind: 'command' },
  compile_and_preview: { label: '编译并预览', desc: '编译 LaTeX 并查看 PDF 页面图像，检查排版与错误', kind: 'compile' },
  web_search: { label: '联网搜索', desc: '搜索公开网页、文档与学术资料', kind: 'search' },
  web_fetch: { label: '读取网页', desc: '获取指定网页的正文内容', kind: 'web' },
  ask_user: { label: '询问用户', desc: '就必要信息或选项提问，等待用户回答后继续任务', kind: 'question' },
  report_progress: { label: '报告进度', desc: '展示执行计划、当前证据或决策摘要', kind: 'progress' },
  run_parallel_edits: { label: '并行编辑', desc: '按明确的文件或段落边界并行修改，检查冲突后合并草稿', kind: 'generic' },
  run_agent_graph: { label: '执行智能体协作', desc: '并行执行独立智能体的分析、查证、审阅或验证任务并汇总报告', kind: 'generic' },
  submit_agent_report: { label: '提交协作报告', desc: '提交独立智能体基于实际核查的结论、问题和依据', kind: 'generic' },
  plan_task_graph: { label: '规划任务图', desc: '选择任务路线，安排资料核查、修改与验证步骤', kind: 'generic' },
  set_chinese_alignment_scope: { label: '设置中英对照范围', desc: '根据用户明确指令调整本轮中文对照检查范围', kind: 'generic' },
  // Retained for earlier execution records, even when not offered this run.
  run_workspace: { label: '运行工作区命令', desc: '在历史版本的工作区中执行命令或脚本', kind: 'command' },
  run_workspace_command: { label: '执行工作区命令', desc: '在历史版本的工作区中执行命令或脚本', kind: 'command' },
  grep_files: { label: '搜索文件内容', desc: '在项目文件中检索匹配的文本或正则表达式', kind: 'search' },
  inspect_runtime_resources: { label: '检查运行环境', desc: '查看可用字体与已配置的 TeX Live 版本', kind: 'generic' },
  install_tex_packages: { label: '安装 TeX 宏包', desc: '为指定 TeX 版本持久安装缺失宏包，仅管理员可用', kind: 'generic' },
  install_font: { label: '安装字体', desc: '安装已上传字体供 LaTeX 和 Python 绘图使用，仅管理员可用', kind: 'generic' },
  prepare_env: { label: '准备环境', desc: '准备任务所需的编译与运行环境', kind: 'command' },
});

function metadata(name) {
  return Object.hasOwn(TOOL_METADATA, name) ? TOOL_METADATA[name] : null;
}

export function toolLabel(name) {
  const id = String(name ?? '');
  return metadata(id)?.label || `${id.startsWith('mcp__') ? '外部工具' : '其他工具'}（${id || '未命名'}）`;
}

export function toolDescription(name) {
  const id = String(name ?? '');
  return metadata(id)?.desc || (id.startsWith('mcp__')
    ? `由外部服务提供的工具：${id}`
    : `尚未收录用途说明的工具：${id || '未命名'}`);
}

export function toolKind(name) {
  return metadata(String(name ?? ''))?.kind || 'generic';
}
