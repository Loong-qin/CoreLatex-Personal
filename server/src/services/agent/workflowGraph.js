import { workflowGate } from './gates.js';
const CONTEXT_TOOLS = new Set(['list_files', 'read_file', 'read_workspace', 'get_document_context', 'view_image']);
const EDIT_TOOLS = new Set(['edit_file', 'write_file', 'copy_to_project', 'run_parallel_edits']);
const SCRIPT_TOOLS = new Set(['run_in_workspace', 'run_skill_script', 'install_tex_packages', 'install_font']);
const EXECUTE_TOOLS = new Set([...EDIT_TOOLS, ...SCRIPT_TOOLS]);
const AUXILIARY_TOOLS = new Set(['plan_task_graph', 'report_progress', 'ask_user', 'read_skill']);
const SCENARIOS = { answer: '直接解答', research: '资料与引用核查', edit: '文稿修改', compile: '编译与排版修复', diagnose: '编译诊断（只读）' };
const RENDER_PATH = /(?:\.(?:tex|bib|sty|cls|bst|clo|def|cfg|bbx|cbx|lbx|tikz|pgf|dat|csv|tsv|ttf|otf|woff2?|afm|pfb|tfm|vf|enc|map|mf|mp|asy|png|jpe?g|pdf|svg|eps|webp|tiff?|bmp)|(?:^|\/)\.?latexmkrc)$/i;
const clean = value => String(value || '').trim().slice(0, 600);
const sourcePath = value => {
  const normalized = String(value || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
  return normalized && !normalized.startsWith('/') && !normalized.includes(':') && !normalized.split('/').includes('..') ? normalized : '';
};
export function validateWorkflowPlan({ scenario, summary, sourcePaths = [] }) {
  if (!Object.hasOwn(SCENARIOS, scenario)) return '请选择 answer、research、edit、compile 或 diagnose 任务路线';
  if (!clean(summary)) return '请提供简短行动摘要';
  if (!Array.isArray(sourcePaths) || sourcePaths.length > 20 || sourcePaths.some(value => typeof value !== 'string' || !sourcePath(value))) return 'sourcePaths 需为最多 20 个有效项目相对路径';
  return null;
}
function nonemptyLocalSource(name, input, resultText, declaredPaths) {
  if (name === 'read_file' && declaredPaths.has(sourcePath(input.path))) {
    try {
      const value = JSON.parse(resultText);
      if (value && typeof value === 'object' && value.view) return !value.conflict && Boolean(value.text?.trim());
    } catch { /* Normal reads are plain text. */ }
    // Pagination metadata is not evidence that the selected body has text.
    return Boolean(String(resultText || '').replace(/\n（[^\n]*共 \d+ 行；本次返回[^\n]*）$/, '').trim());
  }
  if (name !== 'read_workspace') return false;
  for (const file of declaredPaths) {
    if (!file.startsWith('_workspace/')) continue;
    const prefix = `--- ${file.slice(11)} 内容 ---\n`;
    const start = String(resultText || '').indexOf(prefix);
    if (start < 0) continue;
    const bodyStart = start + prefix.length;
    const end = resultText.indexOf('\n--- 结束 ---', bodyStart);
    if (end >= bodyStart && resultText.slice(bodyStart, end).trim()) return true;
  }
  return false;
}
const nonemptyWebSource = resultText => {
  const text = String(resultText || ''), separator = text.indexOf('\n---\n');
  return separator >= 0 && Boolean(text.slice(separator + 5).trim());
};

function texRenderText(value) {
  return String(value ?? '').split(/\r\n|[\r\n]/).flatMap(line => {
    if (/^\s*%/.test(line)) return [];
    for (let i = 0; i < line.length; i++) {
      if (line[i] !== '%') continue;
      let slashes = 0;
      for (let j = i - 1; j >= 0 && line[j] === '\\'; j--) slashes++;
      if (slashes % 2 === 0) return [line.slice(0, i) + '\u0000'];
    }
    return [line];
  }).join('\n');
}
export function renderAffectingPaths(changes = []) {
  return changes.filter(file => {
    if (!RENDER_PATH.test(file.path)) return false;
    if (!/\.tex$/i.test(file.path) || file.encoding === 'base64' || file.before == null || file.after == null) return true;
    // Verbatim/catcode changes can make percent signs printable data.
    if (/\\(?:catcode|scantokens|verb\b|Verb\b|lstinline\b|mintinline\b|url\b|path\b|MakeShortVerb\b|DefineShortVerb\b|lstMakeShortInline\b|begin\s*\{\s*(?:verbatim\*?|Verbatim|lstlisting|minted)\s*\})/.test(file.before + file.after)) return true;
    return texRenderText(file.before) !== texRenderText(file.after);
  }).map(file => file.path);
}

export function toolInvalidatesCompilation(name, effects) {
  return (SCRIPT_TOOLS.has(name) || name.startsWith('mcp__')) && effects?.compilationUnchanged !== true;
}

export const WORKFLOW_GRAPH_PROMPT = '## 标准工作流程（始终启用）\n' +
  '直接解答可以直接回答。执行委托时读取必要的当前内容、执行并核验，无需规划工具。\n' +
  '复用当前且仍可见的读取结果。仅修改已读范围，覆盖前读全。草稿冲突时分别核对 read_file 的默认视图和 view="project"，用 write_file 的 rebase 参数合并并保留用户修改。\n' +
  '来源核查需要实际原文，本地原始资料可用 read_file({path,purpose:"source"}) 读取。候选摘要和稿件本身只用于定位待核实的主张。\n' +
  '本轮正式排版文件有净改动时，用 compile_and_preview 核验当前暂存版本。编译后的读取、资料核查和排版检查沿用仍有效的结果，同版本换页可复用编译。任务范围允许改稿时，根据真实源码错误修正并复查。只读诊断报告实际结果。配额、服务或预览问题如实说明。相同输入反复失败时停止重试。';

// A per-run controller: it authorizes tool ordering and decides whether the
// model may finalize. Snapshots are projections of these gates, not a separate
// cosmetic progress tracker. No provider or orchestration dependency is needed.
export function createWorkflowGraph({ onChange = () => {}, allowWebAccess = true, maxCorrections = 2 } = {}) {
  let planned = false, contextRead = false, sourceRead = false, diagnosticReadOnly = false;
  let needsContext = false, needsSources = false, needsCompile = false, needsDiagnosis = false;
  const declaredSources = new Set();
  let revision = 0, compiledRevision = -1, compileFailed = false, compileAttempted = false, compileStale = false, corrections = 0;
  let waitingState = null, compileBlock = null;
  const graph = {
    version: 1, scenario: 'planning', label: '标准工作流程', status: 'running', currentNode: 'plan',
    nodes: [
      { id: 'plan', label: '任务规划', status: 'running', visits: 1 },
      { id: 'context', label: '读取上下文', status: 'pending', visits: 0 },
      { id: 'research', label: '核查来源', status: 'pending', visits: 0 },
      { id: 'edit', label: '执行任务', status: 'pending', visits: 0 },
      { id: 'verify', label: '验证结果', status: 'pending', visits: 0 },
      { id: 'deliver', label: '完成交付', status: 'pending', visits: 0 },
    ],
    edges: [
      { from: 'plan', to: 'context' }, { from: 'plan', to: 'research' }, { from: 'plan', to: 'deliver', label: '直接解答' },
      { from: 'context', to: 'research', label: '需要来源' }, { from: 'context', to: 'edit' },
      { from: 'context', to: 'verify', label: '编译检查' }, { from: 'research', to: 'edit' },
      { from: 'research', to: 'verify' }, { from: 'edit', to: 'verify' },
      { from: 'verify', to: 'edit', label: '验证失败，修复' }, { from: 'verify', to: 'deliver', label: '验证通过' },
    ],
  };
  const node = id => graph.nodes.find(item => item.id === id);
  const snapshot = () => structuredClone(graph);
  const publish = () => onChange(snapshot());
  const enter = (id, detail = '') => {
    const item = node(id);
    graph.currentNode = id; graph.status = 'running';
    item.status = 'running'; item.visits++;
    if (detail) item.detail = clean(detail);
  };
  const skipUnused = (id, required) => {
    const item = node(id);
    if (required && item.status === 'skipped') item.status = 'pending';
    else if (!required && item.status === 'pending') item.status = 'skipped';
  };
  const category = name => CONTEXT_TOOLS.has(name) ? 'context'
    : ['web_search', 'web_fetch'].includes(name) ? 'research'
      : name === 'compile_and_preview' ? 'verify' : 'edit';

  publish();
  return {
    snapshot,
    invalidateFileEvidence(paths) {
      if (!paths.length) return;
      contextRead = false;
      if (paths.some(file => declaredSources.has(file))) {
        sourceRead = false;
        Object.assign(node('research'), { status: 'pending', detail: '已读来源发生变化，需读取当前正文重新核对' });
      }
      if (needsContext) Object.assign(node('context'), { status: 'pending', detail: '已读文件发生变化，需更新上下文' });
      publish();
    },
    getCompileBlock() { return compileBlock?.fatal ? structuredClone(compileBlock) : null; },
    confirmCompilation() {
      if (compileFailed || compileBlock || compileStale || compiledRevision < 0) return false;
      if (compiledRevision !== revision) {
        compiledRevision = revision;
        Object.assign(node('verify'), { status: 'completed', detail: '当前暂存版本与已编译验证的版本一致' });
        publish();
      }
      return true;
    },
    invalidateCompilation() {
      if (!compileAttempted && compiledRevision < 0) return;
      compiledRevision = -1; compileStale = true;
      Object.assign(node('verify'), { status: 'pending', detail: '编译后项目输入已变化，等待验证当前版本' });
      graph.detail = node('verify').detail; publish();
    },
    plan({ scenario, summary, needsSources: sources = false, sourcePaths = [], automatic = false }) {
      const error = validateWorkflowPlan({ scenario, summary, sourcePaths });
      if (error) return { error };
      planned = true;
      // Replanning can add requirements, never erase previously accepted work.
      needsContext ||= ['edit', 'compile'].includes(scenario);
      needsSources ||= scenario === 'research' || sources === true;
      needsCompile ||= scenario === 'compile';
      needsDiagnosis ||= scenario === 'diagnose';
      diagnosticReadOnly = scenario === 'diagnose' && !automatic;
      for (const file of sourcePaths) declaredSources.add(sourcePath(file));
      graph.scenario = scenario; graph.label = SCENARIOS[scenario]; graph.detail = clean(summary);
      Object.assign(node('plan'), { status: 'completed', detail: clean(summary) });
      skipUnused('context', needsContext); skipUnused('research', needsSources);
      if (needsContext && contextRead) node('context').status = 'completed';
      if (needsSources && sourceRead) Object.assign(node('research'), { status: 'completed', detail: '已读取本轮来源正文' });
      skipUnused('edit', scenario === 'edit' || scenario === 'compile' || revision > 0);
      skipUnused('verify', needsSources || needsContext || needsCompile || needsDiagnosis || revision > 0);
      graph.currentNode = needsContext && !contextRead ? 'context' : needsSources && !sourceRead ? 'research'
        : scenario === 'edit' ? 'edit' : needsCompile || needsDiagnosis ? 'verify' : 'deliver';
      graph.status = 'running'; publish();
      return { scenario, summary: clean(summary), next: node(graph.currentNode).label,
        requirements: { context: needsContext, sources: needsSources, sourcePaths: [...declaredSources], compile: needsCompile, diagnosis: needsDiagnosis } };
    },
    // Deterministic routing from actual operations; no planning model turn.
    observeToolIntent(name) {
      if (name === 'edit_file' && !needsContext && !diagnosticReadOnly) {
        needsContext = true;
        graph.scenario = 'edit'; graph.label = SCENARIOS.edit;
        skipUnused('context', true); skipUnused('edit', true); skipUnused('verify', true);
        if (contextRead) node('context').status = 'completed';
      }
      if (['web_search', 'web_fetch'].includes(name) && !needsSources) {
        needsSources = true; skipUnused('research', true); skipUnused('verify', true);
        if (graph.scenario === 'answer') { graph.scenario = 'research'; graph.label = SCENARIOS.research; }
      }
      if (name === 'compile_and_preview' && graph.scenario === 'answer') {
        graph.scenario = 'diagnose'; graph.label = SCENARIOS.diagnose;
        needsDiagnosis = true; skipUnused('verify', true);
      }
    },
    beforeTool(name, input = {}) {
      if (['plan_task_graph', 'report_progress', 'ask_user'].includes(name)) return null;
      if (name === 'read_file' && input.purpose === 'source' && sourcePath(input.path)) {
        declaredSources.add(sourcePath(input.path)); needsSources = true;
        if (graph.scenario === 'answer') { graph.scenario = 'research'; graph.label = SCENARIOS.research; }
        skipUnused('research', true); skipUnused('verify', true);
      }
      if (!planned) return '任务图尚未规划，请先调用 plan_task_graph 选择任务路线，再执行工具。';
      if (diagnosticReadOnly && (EXECUTE_TOOLS.has(name) || name.startsWith('mcp__'))) return '当前是只读编译诊断路线，不执行写入或脚本；请如实解释编译结果，只有用户要求修改时才重新规划修改路线。';
      if (EXECUTE_TOOLS.has(name) && needsContext && !contextRead) {
        return '执行任务前需要本轮上下文：请先调用 list_files、read_file 或 read_workspace 确认项目/工作区，再继续。';
      }
      return null;
    },
    toolStart(name) {
      if (!planned || AUXILIARY_TOOLS.has(name)) return;
      enter(category(name)); publish();
    },
    toolEnd(name, { succeeded, outcome, compileEvidence, executionEffects, compilationToolInvoked = true,
      input = {}, changedPaths = [], resultText = '', error = '' } = {}) {
      if (!planned || AUXILIARY_TOOLS.has(name)) return;
      if (name === 'compile_and_preview' && !compilationToolInvoked) return;
      const id = category(name), item = node(id);
      item.status = succeeded ? 'completed' : 'failed';
      item.detail = succeeded ? '工具执行成功' : clean(error || '工具执行失败，尚未通过此节点');
      if (succeeded && CONTEXT_TOOLS.has(name)) {
        if (name !== 'get_document_context' || outcome?.file || outcome?.content) contextRead = true;
      }
      if (needsSources && succeeded && ((name === 'web_fetch' && nonemptyWebSource(resultText)) || nonemptyLocalSource(name, input, resultText, declaredSources))) {
        sourceRead = true;
        Object.assign(node('research'), { status: 'completed', detail: name === 'web_fetch' ? '已读取来源网页正文' : '已读取计划中指定的非空来源文件' });
      }
      if (name === 'web_fetch' && succeeded && needsSources && !sourceRead) {
        item.status = 'running'; item.detail = '来源未返回非空正文，等待有效来源';
      }
      if (name === 'web_search' && succeeded && !sourceRead) {
        item.status = 'running'; item.detail = '已找到候选资料，等待读取来源正文';
      }
      if (succeeded && EDIT_TOOLS.has(name) && outcome?.changed === true && outcome.scope === 'project') {
        revision++;
        // Same-content writes and workspace-only writes do not create a gate.
        if (changedPaths.some(value => RENDER_PATH.test(value))) {
          node('verify').status = 'pending'; node('verify').detail = '正式文件已修改，等待编译最新暂存版本';
        }
      }
      // Scripts are not a sandbox and may write before returning an error.
      // Unknown or changed inputs invalidate prior compilation. Only trusted
      // wrapper fingerprints may preserve proof after a read-only check;
      // command output and successful exit status are never proof of no writes.
      if (compilationToolInvoked && toolInvalidatesCompilation(name, executionEffects)) {
        if (compiledRevision >= 0) needsCompile = true;
        revision++;
      }
      if (name === 'compile_and_preview') {
        // This machine evidence comes from the built-in compiler wrapper,
        // independently of the tool's display text or overall preview outcome.
        const typed = compileEvidence && typeof compileEvidence === 'object' &&
          ['succeeded', 'failed', 'blocked', 'unavailable'].includes(compileEvidence.status) ? compileEvidence : null;
        const status = typed?.status || (succeeded ? 'succeeded' : 'failed');
        compileAttempted ||= typed ? typed.attempted === true : true;
        compileFailed = status === 'failed';
        if (status !== 'succeeded') compileStale = false;
        delete item.blocked; delete item.code;
        if (status === 'blocked' || status === 'unavailable') {
          const message = clean(typed.message || error || (status === 'blocked'
            ? '编译受到限制，当前版本尚未完成验证。请解除限制后继续；不得通过脚本绕过限制。'
            : '编译服务不可用，当前版本尚未完成验证。请恢复编译环境后继续。'));
          compileBlock = { reason: message, code: clean(typed.code || (status === 'blocked' ? 'COMPILE_BLOCKED' : 'COMPILER_UNAVAILABLE')),
            fatal: typed.retryable !== true, blocked: true, retryable: typed.retryable === true,
            stage: typed.stage || 'compile', attempted: typed.attempted === true };
          item.status = 'failed'; item.detail = message; item.blocked = true; item.code = compileBlock.code;
          graph.currentNode = 'verify'; graph.detail = message;
        } else if (status === 'succeeded' && typed?.inputStatus === 'unverifiable') {
          compiledRevision = -1; compileStale = false;
          compileBlock = { reason: '编译后无法重新确认项目输入，旧编译结果不能作为当前版本的验证；请检查项目后继续。',
            code: 'COMPILE_INPUT_UNVERIFIABLE', fatal: true, blocked: true, retryable: false, stage: 'compile', attempted: true };
          item.status = 'failed'; item.detail = compileBlock.reason; item.blocked = true; item.code = compileBlock.code;
          graph.currentNode = 'verify'; graph.detail = compileBlock.reason;
        } else if (status === 'succeeded' && typed?.inputsCurrent === false) {
          compileBlock = null; compileStale = true; compiledRevision = -1;
          item.status = 'pending'; item.detail = '编译期间项目输入已变化，旧快照不能证明当前版本';
          graph.detail = item.detail;
        } else if (status === 'succeeded') {
          compileBlock = null; compileStale = false;
          compiledRevision = revision; item.status = 'completed';
          item.detail = typed?.previewStatus && typed.previewStatus !== 'succeeded' || typed?.stage === 'preview' && !succeeded
            ? '最新项目/暂存版本已编译成功；页面预览未完成，不能将预览问题当作正文编译错误。'
            : '最新项目/暂存版本已编译并生成预览';
        } else {
          compileBlock = null;
          if (needsCompile || changedPaths.some(value => RENDER_PATH.test(value))) {
            item.detail = clean(typed?.message || error || '编译失败，需修复后重新验证');
            enter('edit', '编译未通过，进入修复回路');
            graph.detail = '编译未通过，修复后需重新验证';
          } else {
            item.detail = clean(typed?.message || error || '编译失败，已获取诊断结果');
            graph.detail = '已获取编译错误；只读任务不自动执行修复';
          }
        }
      }
      publish();
    },
    wait() {
      const item = node(graph.currentNode);
      waitingState = { id: item.id, status: item.status };
      item.status = 'waiting'; graph.status = 'waiting'; publish();
    },
    resume() {
      if (!waitingState) return;
      node(waitingState.id).status = waitingState.status;
      graph.currentNode = waitingState.id; graph.status = 'running'; waitingState = null; publish();
    },
    prepareCompletion({ changedPaths = [], renderChangedPaths = changedPaths } = {}, { consumeCorrection = true } = {}) {
      const requiresCompile = needsCompile || renderChangedPaths.some(value => RENDER_PATH.test(value));
      if (compileBlock?.fatal) {
        graph.currentNode = 'verify'; graph.status = 'failed'; graph.detail = compileBlock.reason;
        Object.assign(node('verify'), { status: 'failed', detail: compileBlock.reason, blocked: true, code: compileBlock.code });
        publish();
        return { ready: false, failed: true, blocked: true, code: compileBlock.code, reason: compileBlock.reason, limitReached: false };
      }
      const { reason, target } = workflowGate({ planned, needsContext, contextRead, needsSources, sourceRead, allowWebAccess,
        compileBlock, compileStale, requiresCompile, compileFailed, compiledRevision, revision, needsDiagnosis, compileAttempted });
      if (!reason) {
        for (const item of graph.nodes) {
          if (item.id !== 'deliver' && item.status === 'pending') {
            item.status = 'skipped'; item.detail = '本轮无需执行此分支';
          }
        }
        if (!compileFailed && (requiresCompile || needsSources || needsContext)) Object.assign(node('verify'), { status: 'completed', detail: requiresCompile ? '最新暂存版本已通过编译验证' : '本轮上下文/来源证据已核对' });
        graph.detail = '已满足当前路线的交付条件';
        enter('deliver', '已满足当前路线的交付条件'); publish();
        return { ready: true };
      }
      graph.currentNode = target;
      node(target).detail = reason;
      if (!consumeCorrection) {
        if (node(target).status !== 'failed') node(target).status = 'running';
        graph.detail = reason; publish();
        return { ready: false, failed: false, reason, message: '【标准工作流程】' + reason };
      }
      if (corrections >= maxCorrections) {
        graph.status = 'failed'; node(target).status = 'failed'; graph.detail = reason; publish();
        return { ready: false, failed: true, reason, limitReached: true };
      }
      corrections++;
      if (node(target).status !== 'failed') node(target).status = 'running';
      graph.detail = `补充验证 ${corrections}/${maxCorrections}：${reason}`; publish();
      return { ready: false, failed: false, reason,
        message: `【标准工作流程】${reason}这是本轮第 ${corrections}/${maxCorrections} 次补充执行机会；请实际执行必要工具，不要重复完成声明。无法完成时如实说明限制，草稿将保留待审。` };
    },
    finish(status, detail = '') {
      graph.status = status;
      if (detail) graph.detail = clean(detail);
      if (status === 'completed') {
        graph.detail = detail || (needsDiagnosis && compileFailed && !needsCompile ? '诊断已结束；编译错误仍存在，未执行修复' : '本轮执行已结束');
        graph.currentNode = 'deliver'; node('deliver').status = 'completed'; node('deliver').detail = '本轮执行已结束';
      } else {
        const item = node(graph.currentNode);
        if (item.status === 'running' || item.status === 'waiting') {
          item.status = status === 'failed' ? 'failed' : 'pending';
          item.detail = clean(detail || (status === 'cancelled' ? '本轮已停止，此节点未完成' : '本轮未完成'));
        }
      }
      publish();
    },
  };
}
