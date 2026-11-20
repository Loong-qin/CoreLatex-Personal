import fs from 'node:fs';
import os from 'node:os';
import { getDb } from '../../db.js';
import { requireProjectAccess } from '../../access.js';
import { buildToolDisplay, safeToolDebug } from './toolDisplay.js';
import { persistToolImages } from './artifacts.js';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runProcess } from '../process.js';
import { SKILLS_DIR, projectDir as configuredProjectDir } from '../../config.js';
import { listRuntimeFonts, installFontFiles, installTexPackages } from '../runtimeResources.js';
import { downloadFontFile } from '../fontDownloads.js';
import { listTexRuntimes } from '../texRuntimes.js';
import { getRuntimeResourceRevision } from '../runtimeEnvironment.js';
import { assertStorageQuota, assertCompileQuota } from '../../quotas.js';
import { flushProjectRooms } from '../../collab.js';
import { compileProject, previewCompileProject } from '../compile.js';
import { verifyCompilationInputs, withoutCommentLines } from '../compileInputs.js';
import { assertWorkAdmission, createCompileLease, startCompileLease, finishCompileLease } from '../maintenance.js';
import { webSearch, fetchPageText } from '../webService.js';
import { isSkillDisabled, readSkillFile, skillFileList } from './skills.js';
import { filterMeaningfulChanges } from './changesets.js';
import { buildTree, HttpError, isTextFile, safeJoin, toPosix } from '../../util.js';
import { fileState, draftConflict, rememberRead, readCovers, advanceRead, fileHash } from './fileState.js';

/**
 * CoreAgent 工具集。所有路径为项目相对 posix 路径，一律过 safeJoin。
 * executeTool 永不抛出：失败返回 {error: '...'} 供模型自我纠正。
 * ctx = { project, user, db, workspaceDir, projectDir, chatId, changesetBuffer, agentConfig, currentFile, currentContent, reads }
 *   reads: Map<rel, hash>——本轮 read_file 读取时的内容哈希，供先读后改闸判定内容是否过期
 */

const READ_TRUNCATE = 50_000;
// read_file 单次读取上限 10MB：常规稿件整读不再截断，避免模型浪费轮次用命令行分段读
const READ_MAX_BYTES = 10 * 1024 * 1024;
const RUN_TIMEOUT_MS = 60_000;
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const FIGURE_PDF_MAX_BYTES = 20 * 1024 * 1024;
const IMAGE_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

function searchOutcomeNotice({ engine, fallbackReason, quality } = {}) {
  const notices = [];
  const provider = ({ searxng: 'SearXNG', bing: 'Bing', duckduckgo: 'DuckDuckGo' })[engine] || '当前搜索来源';
  if (fallbackReason) {
    const reason = /not_configured$/.test(fallbackReason) ? '优先搜索服务未配置'
      : /query_mismatch$/.test(fallbackReason) ? '之前的搜索来源返回了不同检索词的结果'
        : /(?:no_relevant|irrelevant|low_relevance)/.test(fallbackReason) ? '之前的搜索来源未返回与查询匹配的条目'
        : /no_results/.test(fallbackReason) ? '之前的搜索来源未返回可用条目'
          : /timeout/.test(fallbackReason) ? '之前的搜索来源请求超时' : '之前的搜索来源暂不可用';
    notices.push(`${reason}，本次结果来自 ${provider}。`);
  }
  const discarded = Math.max(0, Math.floor(Number(quality?.discardedCount) || 0));
  if (discarded) notices.push(`已过滤 ${discarded} 条与查询不匹配的结果。`);
  return notices.join(' ');
}

function contentHash(s) {
  return createHash('sha256').update(String(s)).digest('hex');
}

/** 先读后改闸：本轮未读取过、或读取后文件又被外部改动（用户修改/撤销），拒绝编辑。
 * 对话历史里的文件内容只是历史快照，必须以本轮 read_file 的实测内容为编辑依据。 */
function assertFreshRead(ctx, rel, base) {
  if (!ctx.reads) return null; // 无读取追踪的调用方（如既有测试）跳过
  const recorded = ctx.reads.get(rel);
  if (recorded === undefined) {
    return { code: 'FILE_READ_REQUIRED', error: `请先用 read_file 读取 ${rel} 的当前内容再编辑（本轮尚未读取；对话历史中的内容可能已过期）` };
  }
  if (recorded !== contentHash(base)) {
    return { code: 'FILE_CHANGED', error: `${rel} 在本轮读取后被外部改动（用户修改或撤销），请重新 read_file 确认当前内容后再编辑` };
  }
  return null;
}

// A cache belongs to one agent run, never to a project/user globally. Its private
// PDF already comes from compile.js's queue-protected snapshot in os.tmpdir().
const compilationCaches = new WeakMap();
const CACHE_MAX_INPUT_BYTES = 128 * 1024 * 1024;
const CACHE_MAX_FILES = 5000;
const CACHE_MAX_PAGE_BYTES = 8 * 1024 * 1024;
const CACHE_MAX_PAGES = 16;
const COMPILE_OUTPUT_DIRS = new Set(['.build', '.preview', '.versions', '.git', '_workspace']);

function disposeCompilationEntry(entry) {
  if (!entry || entry.refs > 0 || !entry.retired) return;
  if (entry.snapshotDir) fs.rmSync(entry.snapshotDir, { recursive: true, force: true });
  entry.pageImages?.clear(); entry.pageBytes = 0;
}
function retireCompilationEntry(state) {
  if (!state.entry) return;
  const entry = state.entry; state.entry = null;
  entry.retired = true; disposeCompilationEntry(entry);
}

/** Share this object with workers in this run; await cleanup() in run finally.
 * invalidate() is synchronous and must follow scripts/MCP with unknown effects.
 * Already borrowed PDFs are removed after their operation releases them. */
export function createCompilationCache({ signal } = {}) {
  const controller = new AbortController();
  const state = { entry: null, proof: null, generation: 0, owner: null, tail: Promise.resolve(), closed: false, controller };
  let cleanupPromise;
  const cache = {
    invalidate() { state.generation++; state.proof = null; retireCompilationEntry(state); },
    cleanup() {
      if (cleanupPromise) return cleanupPromise;
      state.closed = true; cache.invalidate();
      controller.abort(new DOMException('本轮编译缓存已关闭', 'AbortError'));
      signal?.removeEventListener('abort', aborted);
      cleanupPromise = state.tail.catch(() => {}).then(() => retireCompilationEntry(state));
      return cleanupPromise;
    },
  };
  const aborted = () => { void cache.cleanup(); };
  compilationCaches.set(cache, state);
  signal?.addEventListener('abort', aborted, { once: true });
  if (signal?.aborted) aborted();
  return Object.freeze(cache);
}

function withCompilationCache(ctx, operation) {
  ctx.signal?.throwIfAborted();
  const db = getDb();
  // Cover the actual cache queue, PDF inspection/renderers and finally cleanup,
  // including cache hits. The caller's cancellation race must not release this
  // lease while a renderer is still exiting in the background.
  const lease = createCompileLease(db, { projectId: ctx.project.id, userId: ctx.user.id, kind: 'preview' });
  const state = compilationCaches.get(ctx.compilationCache);
  const signal = state ? (ctx.signal ? AbortSignal.any([ctx.signal, state.controller.signal]) : state.controller.signal) : ctx.signal;
  const invoke = async cache => {
    signal?.throwIfAborted();
    startCompileLease(db, lease);
    return operation(cache, signal);
  };
  if (!state) return invoke(null).finally(() => finishCompileLease(db, lease));
  const owner = compileScope(ctx);
  if (state.owner === null) state.owner = owner;
  // Even accidental reuse of a run object must not return another user's PDF.
  const eligible = state.owner === owner;
  const pending = state.tail.catch(() => {}).then(() => invoke(eligible ? state : null))
    .finally(() => finishCompileLease(db, lease));
  state.tail = pending.catch(() => {});
  // A cancelled worker must not wait for another worker's TeX process. Its
  // queued continuation still checks the signal and never starts extra work.
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason || new DOMException('编译已取消', 'AbortError'));
    signal.addEventListener('abort', aborted, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
    if (signal.aborted) aborted();
  });
}

function uncertainTexInputs(source) {
  // Full project hashing covers ordinary macro-selected project files. We cannot
  // prove arbitrary Lua, external paths or generated dependency names without a
  // recorder manifest, so these documents compile normally with no reuse.
  const text = withoutCommentLines(source);
  if (/\\(?:directlua|latelua|openin|read|write18|pdfuniformdeviate|uniformdeviate|csname|catcode|scantokens)\b/.test(text)) return true;
  if (/["'={\s](?:\.\.\/|~\/|\/[A-Za-z]|[A-Za-z]:[\\/])/.test(text)) return true;
  if (/(?:_workspace|\.build|\.preview|\.versions|\.git)[\\/]/.test(text)) return true;
  const commands = /\\(?:input|include|subfile|includegraphics|bibliography|bibliographystyle|addbibresource|lstinputlisting|verbatiminput|InputIfFileExists|IfFileExists|usepackage|RequirePackage|documentclass|LoadClass|graphicspath|fontspec|setmainfont|setsansfont|setmonofont)\*?\s*(?:\[[^\]]*\]\s*)?(\{[^}]*\}|[^\s{}]+)/g;
  for (const match of text.matchAll(commands)) {
    if (!match[1].startsWith('{') || /\\|#|\$|\|/.test(match[1])) return true;
  }
  return false;
}

const UNSTABLE_FINGERPRINT = Symbol('unstable fingerprint');
const COMPILE_SEARCH_VARS = ['TEXINPUTS', 'BIBINPUTS', 'BSTINPUTS', 'TEXMFHOME', 'TEXMFLOCAL'];
const liveCompileSettings = project => getDb().prepare('SELECT main_file,compile_engine,tex_version FROM projects WHERE id=?').get(project.id);
const stageSnapshot = ctx => filterMeaningfulChanges(ctx.changesetBuffer).map(item => ({ ...item }))
  .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const sameStage = (a, b) => a.length === b.length && a.every(({ path, encoding, before, after }, i) =>
  path === b[i].path && encoding === b[i].encoding && before === b[i].before && after === b[i].after);
const compileScope = ctx => JSON.stringify([ctx.project?.id, ctx.user?.id, ctx.chatId ?? null]);

async function compilationFingerprint(ctx, staged, signal, selectedSettings) {
  // Retry once when files were modified during scanning. An unsupported or
  // unreadable input still returns null rather than fabricating a change.
  for (let attempt = 0; attempt < 2; attempt++) {
    const fingerprint = await collectCompilationFingerprint(ctx, staged, signal, selectedSettings);
    if (fingerprint !== UNSTABLE_FINGERPRINT) return fingerprint;
  }
  return UNSTABLE_FINGERPRINT;
}
async function collectCompilationFingerprint(ctx, staged, signal, selectedSettings) {
  try {
    signal?.throwIfAborted();
    // Flush collaborative edits before measuring the bytes the compiler reads.
    flushProjectRooms(ctx.project.id, { strict: true });
    const root = configuredProjectDir(ctx.project.id);
    const settings = liveCompileSettings(ctx.project);
    if (selectedSettings && JSON.stringify(selectedSettings) !== JSON.stringify(settings)) return UNSTABLE_FINGERPRINT;
    const environment = Object.fromEntries(['PATH', ...COMPILE_SEARCH_VARS, 'SOURCE_DATE_EPOCH'].map(key => [key, process.env[key] || '']));
    // A recorded path alone does not catch a new, higher-priority match in
    // another configured search root. Only assert full proof with known roots.
    const customSearch = COMPILE_SEARCH_VARS.some(name => environment[name].replace(/[.:]/g, '').trim());
    let reusable = !customSearch;
    if (fs.lstatSync(root).isSymbolicLink()) return null;
    const hash = createHash('sha256');
    const add = value => { const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value)); hash.update(String(bytes.length) + ':'); hash.update(bytes); };
    const runtimeResourceRevision = getRuntimeResourceRevision();
    const date = new Date().toISOString().slice(0, 10);
    const project = settings || ctx.project;
    add(JSON.stringify({ project: ctx.project.id, user: ctx.user.id, root, mainFile: project.main_file || 'main.tex',
      engine: project.compile_engine || 'pdflatex', texVersion: project.tex_version || 'system', runtimeResourceRevision,
      preview: !!(staged.length || ctx.agentConfig?.confirmBeforeApply), environment, date }));
    let bytes = 0, entriesSeen = 0, unstable = false;
    const checked = [];
    const sameStat = (a, b) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode &&
      a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
    async function visit(dir, rel = '') {
      const dirStat = fs.lstatSync(dir);
      if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) return false;
      checked.push([dir, dirStat]);
      const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'));
      for (const item of entries) {
        signal?.throwIfAborted();
        if (item.isDirectory() && COMPILE_OUTPUT_DIRS.has(item.name)) continue;
        if (++entriesSeen > CACHE_MAX_FILES) return false;
        const file = path.join(dir, item.name), relative = rel ? rel + '/' + item.name : item.name;
        if (item.isSymbolicLink() || !item.isDirectory() && !item.isFile()) return false;
        if (item.isDirectory()) { add('directory:' + relative); if (!await visit(file, relative)) return false; continue; }
        const before = fs.statSync(file);
        bytes += before.size;
        if (bytes > CACHE_MAX_INPUT_BYTES) return false;
        add('file:' + relative); add(before.size);
        let source = '';
        let inspect = reusable && (/\.(?:tex|sty|cls|ltx|def|cfg|bib|bst)$/i.test(relative) || /(?:^|\/)\.?latexmkrc$/i.test(relative));
        if (inspect && before.size > 2 * 1024 * 1024) { reusable = false; inspect = false; }
        const contents = createHash('sha256');
        const stream = fs.createReadStream(file, { flags: fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0), signal });
        for await (const chunk of stream) { contents.update(chunk); if (inspect) source += chunk.toString('utf8'); }
        const after = fs.statSync(file);
        if (!sameStat(before, after)) { unstable = true; return false; }
        checked.push([file, after]);
        if (inspect && uncertainTexInputs(source)) reusable = false;
        add(contents.digest());
      }
      return true;
    }
    if (!await visit(root)) return unstable ? UNSTABLE_FINGERPRINT : null;
    // A previously hashed file or directory may change while a later file is
    // streaming. Recheck all metadata synchronously at the end of the walk.
    const stillCurrent = () => {
      try {
        return runtimeResourceRevision === getRuntimeResourceRevision() && JSON.stringify(settings) === JSON.stringify(liveCompileSettings(ctx.project)) &&
          date === new Date().toISOString().slice(0, 10) &&
          Object.entries(environment).every(([name, value]) => value === (process.env[name] || '')) &&
          checked.every(([file, before]) => sameStat(before, fs.lstatSync(file)));
      } catch { return false; }
    };
    if (!stillCurrent()) return UNSTABLE_FINGERPRINT;
    // Proposals passed here are the frozen net diff, including its baseline.
    for (const item of staged) {
      add(JSON.stringify([item.path, item.encoding || 'utf8', item.before ?? null]));
      const contents = Buffer.from(item.after ?? '', item.encoding === 'base64' ? 'base64' : 'utf8');
      bytes += contents.length;
      if (bytes > CACHE_MAX_INPUT_BYTES) return null;
      if (reusable && /\.(?:tex|sty|cls|ltx|def|cfg|bib|bst)$/i.test(item.path) &&
          (contents.length > 2 * 1024 * 1024 || uncertainTexInputs(contents.toString('utf8')))) reusable = false;
      add(contents);
    }
    return { key: hash.digest('hex'), reusable, customSearch, stillCurrent };
  } catch { signal?.throwIfAborted(); return null; }
}

// A successful compile is proof only for the inputs it actually saw.  Return
// unknown when safe fingerprinting is unavailable: this check must not invent a
// change or force repeated compilations for projects with uncertain inputs.
export async function checkCompilationFreshness(ctx, signal = ctx?.signal) {
  const state = compilationCaches.get(ctx?.compilationCache);
  const proof = state?.proof;
  if (!proof || state.closed || state.owner !== compileScope(ctx)) return 'unknown';
  const staged = stageSnapshot(ctx);
  const checkCtx = { ...ctx, agentConfig: { ...ctx.agentConfig, confirmBeforeApply: proof.previewMode } };
  const current = await compilationFingerprint(checkCtx, staged, signal);
  if (state.proof !== proof) return 'unknown';
  if (current === UNSTABLE_FINGERPRINT) return 'unstable';
  if (!current || proof.formalOnly && !current.reusable) return 'unverifiable';
  if (current.key !== proof.key) return 'changed';
  const status = proof.manifest ? await verifyCompilationInputs(proof.manifest, { signal }) : proof.formalOnly ? 'current' : 'unknown';
  if (state.proof !== proof) return 'unknown';
  if (!current.stillCurrent() || !sameStage(staged, stageSnapshot(ctx))) return 'unstable';
  return status === 'current' && !proof.complete ? 'unknown' : status;
}

function rememberPage(entry, key, image) {
  const size = image.imageBase64.length;
  if (size > CACHE_MAX_PAGE_BYTES) return;
  if (entry.pageImages.has(key)) entry.pageBytes -= entry.pageImages.get(key).imageBase64.length;
  entry.pageImages.delete(key); entry.pageImages.set(key, image); entry.pageBytes += size;
  while (entry.pageImages.size > CACHE_MAX_PAGES || entry.pageBytes > CACHE_MAX_PAGE_BYTES) {
    const oldest = entry.pageImages.keys().next().value;
    entry.pageBytes -= entry.pageImages.get(oldest).imageBase64.length; entry.pageImages.delete(oldest);
  }
}

export function getToolDefinitions() {
  const obj = (properties = {}, required = []) => ({ type: 'object', properties, required });
  const str = (description) => ({ type: 'string', description });
  const fn = (name, description, parameters) => ({ type: 'function', function: { name, description, parameters } });
  return [
    fn('list_files', '列出项目的全部文件与目录（项目相对路径）', obj()),
    fn('read_file', '读取文件内容（默认整读，单次上限 10MB；超长文件可用 offset/limit 按行分页）',
      obj({
        path: str('项目相对路径，如 main.tex'),
        find: str('逐行查找区分大小写的字面文本。核对改稿中的用词时默认搜索暂存稿；返回匹配行数、前 20 个行号和首个匹配处的正文。offset 可指定搜索起点，limit 可指定显示行数'),
        view: { type: 'string', enum: ['effective', 'project'], description: '默认 effective 读取当前草稿（无草稿则正式文件）；project 显式读取正式文件。冲突时必须分别核对两个版本，返回各自哈希' },
        purpose: { type: 'string', enum: ['context', 'source'], description: '默认 context；核查本地原始资料正文时显式设 source，在同一次实际读取中记录来源证据' },
        offset: { type: 'integer', description: '起始行号（1 基），默认从第 1 行开始' },
        limit: { type: 'integer', description: '本次读取的行数，默认读到文件末尾' },
      }, ['path'])),
    fn('read_workspace', '查看工作区 _workspace/ 的文件清单与小文件内容预览', obj()),
    fn('view_image', '预览项目、当前草稿或工作区的栅格图（png/jpg/jpeg/webp/gif，≤5MB）或 PDF 图稿的单页（PDF ≤20MB）。支持视觉的模型可直接检查配色、标签、构图；无需编译论文。',
      obj({
        path: str('项目相对路径，如 figures/result.pdf 或 _workspace/figures/result.png'),
        page: { type: 'integer', minimum: 1, maximum: 2147483647, description: '仅用于 PDF，默认第 1 页' },
      }, ['path'])),
    fn('write_file', '新建或整体覆写文件（_workspace/ 内直接写入立即生效；项目正式文件先暂存，对话结束后作为可审查变更自动应用）',
      obj({ path: str('项目相对路径，_workspace/ 开头则写入工作区'), content: str('完整的新文件内容'),
        rebase: obj({ projectHash: str('重新完整读取的正式文件 SHA-256'), draftHash: str('重新完整读取的旧草稿 SHA-256') }, ['projectHash', 'draftHash']) }, ['path', 'content'])),
    fn('edit_file', '局部修改文件：search 文本必须在文件中唯一出现，将被 replace 替换一次（_workspace/ 内直接写入）',
      obj({ path: str('项目相对路径'), search: str('要被替换的原文（必须唯一匹配）'), replace: str('替换后的文本'), baseHash: str('采用审阅建议时必须提供建议中的当前草稿 SHA-256；不匹配则拒绝'), fixAppliedFor: str('本次修复对应的 findingId（仅关联记录，不代表已经复核通过）') }, ['path', 'search', 'replace'])),
    fn('run_parallel_edits', '并行暂存2至4个明确边界的编辑任务。主智能体须先读取现有目标文件；按文件或互不重叠的原始行范围分工。各编辑器独立草稿，全部通过后统一合并待审，不能直接写正式文件。',
      obj({ tasks: { type: 'array', minItems: 2, maxItems: 4, items: {
        type: 'object', additionalProperties: false, required: ['id', 'task', 'scope'], properties: {
          id: { type: 'string', minLength: 1, maxLength: 80 }, label: { type: 'string', maxLength: 120 },
          task: { type: 'string', minLength: 1, maxLength: 2000 },
          scope: { type: 'array', minItems: 1, maxItems: 20, items: {
            type: 'object', additionalProperties: false, required: ['path'], properties: {
              path: str('项目相对文本文件路径；禁止工作区。省略行号表示整个文件'),
              startLine: { type: 'integer', minimum: 1, description: '冻结草稿中的起始行，1基，含该行；须与endLine同时指定' },
              endLine: { type: 'integer', minimum: 1, description: '冻结草稿中的末行，含该行；不同任务的范围不能重叠' },
            },
          } },
        },
      } } }, ['tasks'])),
    fn('copy_to_project', '把 _workspace/ 中的文件复制到项目指定位置（正式项目文件统一进入变更审查，含图片/PDF等二进制）',
      obj({ workspacePath: str('_workspace/ 内的相对路径'), targetPath: str('项目内目标相对路径') }, ['workspacePath', 'targetPath'])),
    fn('run_in_workspace', '执行 bash，初始目录为 _workspace/（不是安全沙箱；确认模式禁用；需允许脚本；60s 超时）',
      obj({ command: str('要执行的 shell 命令') }, ['command'])),
    fn('inspect_runtime_resources', '查看服务器可用字体和已配置的 TeX Live 版本，用于检查缺失字体或宏包。返回字体文件位置，可供 Python 绘图明确选择字体。', obj()),
    fn('install_tex_packages', '从已配置镜像为当前或指定受管 TeX Live 版本安装宏包，需要当前项目的编辑权限。只接受宏包名称。安装持久保留，实际环境变更后需重新编译。',
      obj({ version: str('可选：已配置的 TeX 版本标识；默认当前项目版本'), packages: { type: 'array', minItems: 1, maxItems: 30, items: str('宏包名称，如 algorithms') } }, ['packages'])),
    fn('install_font', '安装一个 TTF、OTF 或 TTC 字体，需要当前项目的编辑权限。恰好提供一个项目或工作区相对路径或公开 HTTPS 字体直链。CTAN 字体优先尝试已配置镜像，安装持久保留，可用于 LaTeX 和 Python 绘图。',
      obj({ path: str('项目相对字体路径，如 _workspace/uploads/Example.ttf；不能是 URL 或符号链接'), url: str('公开 HTTPS 直链，下载 TTF、OTF 或 TTC；禁止内网地址'), sha256: str('可选：直链文件的 SHA-256，用于核对下载内容') })),
    fn('get_document_context', '获取用户当前打开的文件路径与内容', obj()),
    fn('read_skill', '读取技能内容：默认返回 SKILL.md 正文，并在末尾附技能目录内的其他文件清单；配合 file 参数可读取附属文件，支持逗号分隔一次读多个、以 / 结尾读取整个目录、../其他技能名/ 前缀读取兄弟技能的共享文件',
      obj({
        name: str('技能名'),
        file: str('可选：文件相对路径，支持逗号分隔批量读取；以 / 结尾则读取整个目录；../<技能名>/<文件> 表示兄弟技能内的文件，例如 "../nature-shared/core/ethics.md"'),
      }, ['name'])),
    fn('run_skill_script', '执行技能目录内的脚本（.py 用 python3、.sh 用 bash，其他按可执行文件运行）。以脚本所在目录为工作目录，超时 60 秒；需允许执行脚本',
      obj({
        skill: str('技能名'),
        script: str('脚本相对路径，例如 scripts/render.py'),
        args: str('可选：传给脚本的命令行参数'),
      }, ['skill', 'script'])),
    fn('compile_and_preview', '用项目当前配置的编译引擎编译项目，并把生成的 PDF 渲染为页面图像返回（支持视觉的模型可直接查看排版效果）。用于排版检查：图表位置、留白、溢出、间距、字体与断行等。编译计入编译时长配额',
      obj({
        pages: str('可选：要查看的页码，如 "3" 或 "2-4" 或 "1,3,5"；默认返回前 3 页'),
        dpi: { type: 'integer', description: '可选：渲染精度 DPI，50-150（默认 100）。排大图/细间距用 120-150，常规检查用默认值即可；DPI 越高图像越大' },
      })),
    fn('web_search', '联网搜索：查询互联网资料（LaTeX 语法与宏包文档、学术资料、报错解决方案等），返回标题/链接/摘要列表',
      obj({
        query: str('搜索词（可用中英文）'),
        max_results: { type: 'integer', description: '返回结果数上限，默认 8，最多 10' },
      }, ['query'])),
    fn('web_fetch', '读取网页正文文本（文档页面、百科、论文页等），返回标题与正文（截断至约 2 万字符）',
      obj({ url: str('要读取的 http/https 网页地址') }, ['url'])),
  ];
}

export async function executeTool(name, input, ctx) {
  const fn = TOOL_IMPLS[name];
  if (!fn) return { error: `未知工具：${name}` };
  try {
    ctx.signal?.throwIfAborted();
    return await fn(input || {}, ctx);
  } catch (err) {
    if (name === 'web_search' && err.searchDiagnostics && ctx.presentation) {
      ctx.presentation.search = { ...err.searchDiagnostics, results: [] };
    }
    if (name === 'compile_and_preview' && !ctx.signal?.aborted) {
      const evidence = err.compileEvidence || ctx.presentation?.compileEvidence || {
        status: err.code === 'COMPILE_QUOTA_EXHAUSTED' || err.status === 403 ? 'blocked' : 'unavailable',
        attempted: false, stage: 'compile', code: err.code || (err.status === 403 ? 'COMPILE_BLOCKED' : 'COMPILER_UNAVAILABLE'),
        retryable: false, message: err.message || String(err),
      };
      if (ctx.presentation) ctx.presentation.compileEvidence = evidence;
      return { error: err.message || String(err), compileEvidence: evidence };
    }
    return { error: err.message || String(err) };
  }
}

/**
 * 把一个工具（定义 + 实现）包装成 pi-agent-core 的 AgentTool。
 * - 底层保留 executeTool 的 {error} 约定，适配层抛出交给 pi 标记失败，避免失败编辑被计为成功；
 * - 字符串结果原样保留，对象序列化为文本元信息；图片字节仅放入原生图像块；
 * - out.images（如 compile_and_preview 的页面渲染）转为 pi 的 ImageContent 进模型上下文。
 */
export function makePiTool({ name, description, parameters, run }, ctx) {
  return {
    name,
    label: name,
    description,
    parameters,
    execute: async (_toolCallId, params, toolSignal) => {
      const signals = [ctx?.signal, toolSignal].filter(Boolean);
      const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
      signal?.throwIfAborted();
      const meta = {};
      // Scripts can write even if they fail. Use the successful compilation's
      // proof before and after execution, independently of PDF cache eligibility.
      const inspectEffects = ['run_in_workspace', 'run_skill_script', 'install_tex_packages', 'install_font'].includes(name);
      const priorProof = inspectEffects ? compilationCaches.get(ctx?.compilationCache)?.proof : null;
      const hadCurrentCompilation = priorProof && await checkCompilationFreshness(ctx, signal) === 'current';
      let out;
      try {
        out = await run(params || {}, signal, meta);
        signal?.throwIfAborted();
        if (name === 'compile_and_preview') {
          const evidence = meta.compileEvidence || out?.compileEvidence;
          if (evidence) {
            if (evidence.status === 'succeeded') evidence.previewStatus = out?.error ? 'failed' : 'succeeded';
            if (evidence.inputsCurrent === false && out && typeof out === 'object') {
              const notice = evidence.inputStatus === 'unverifiable'
                ? '编译后的输入无法重新核验，不能确认当前版本；草稿将保留待审。'
                : evidence.inputStatus === 'unstable'
                  ? '项目输入正在变化，无法确认编译快照对应当前版本；请稳定后重新验证。'
                  : '编译期间项目输入发生变化，结果仅适用于旧快照；请重新编译当前版本。';
              if (typeof out.text === 'string') out.text += '\n' + notice;
              else if (typeof out.error === 'string') out.error += '\n' + notice;
            }
            ctx.toolEvidence ||= new Map();
            ctx.toolEvidence.set(_toolCallId, structuredClone(evidence));
          }
        }
        if (out && typeof out === 'object' && out.error) throw new Error(String(out.error));
      } catch (error) {
        // Pi must still see a rejected call. Preserve rich diagnostics out of
        // band, since Pi's Error adapter only retains error.message.
        ctx?.toolDisplays?.set(_toolCallId, buildToolDisplay(name, params || {}, out || { error: error.message }, { meta, status: signal?.aborted ? 'cancelled' : 'error' }));
        throw error;
      } finally {
        if (inspectEffects) {
          const unchanged = !signal?.aborted && (meta.scriptDispatched === false ||
            (hadCurrentCompilation && compilationCaches.get(ctx.compilationCache)?.proof === priorProof &&
              await checkCompilationFreshness(ctx, signal) === 'current'));
          ctx.toolEffects ||= new Map();
          ctx.toolEffects.set(_toolCallId, {
            compilationUnchanged: !!unchanged,
          });
        }
      }
      const images = out && typeof out === 'object' && Array.isArray(out.images) ? out.images : [];
      // Image bytes belong only in native image blocks. Keeping a second copy
      // in text wastes context and survives the text-only model fallback.
      const textOutput = images.length ? {
        ...out, images: images.map(({ imageBase64, ...metadata }) => metadata),
      } : out;
      const text = typeof textOutput === 'string' ? textOutput : JSON.stringify(textOutput);
      const content = [{ type: 'text', text }];
      for (const img of images) {
        content.push({ type: 'image', data: img.imageBase64, mimeType: img.mediaType || 'image/png' });
      }
      let displayImages = [];
      if (images.length) {
        try { displayImages = persistToolImages(ctx || {}, images); }
        catch (error) { meta.imageNotice = error.status === 403 && /存储空间不足/.test(error.message)
          ? '图像已返回给智能体，但存储空间不足，未保存可预览的快照。'
          : '图像已返回给智能体，但保存预览失败，当前无法打开此快照。'; }
      }
      const display = buildToolDisplay(name, params || {}, out, { meta, images: displayImages });
      const readVersion = name === 'read_file' && meta.read ? { path: meta.read.path, view: meta.read.view,
        contentHash: meta.read.contentHash, start: meta.read.start, end: meta.read.end, purpose: meta.read.purpose,
        startOffset: meta.read.startOffset, endOffset: meta.read.endOffset,
        resultHash: contentHash(text) } : null;
      return { content, details: { text: safeToolDebug(text), display, ...(readVersion ? { readVersion } : {}), ...(meta.compileEvidence ? { compileEvidence: structuredClone(meta.compileEvidence) } : {}) } };
    },
  };
}

/** 全部内建工具 → pi AgentTool（实现仍走 TOOL_IMPLS，闸门/暂存/配额语义不变） */
export function getPiTools(ctx) {
  ctx.toolDisplays ||= new Map();
  ctx.toolEvidence ||= new Map();
  ctx.readEvidence ||= new Map();
  ctx.fileReads ||= new Map();
  ctx.fileObservations ||= new Map();
  return getToolDefinitions().filter(d => d.function.name !== 'run_parallel_edits' || typeof ctx.runParallelEdits === 'function').map((d) => makePiTool({
    name: d.function.name,
    description: d.function.description,
    parameters: d.function.parameters,
    run: async (input, signal, presentation) => {
      if (d.function.name === 'run_in_workspace' || d.function.name === 'run_skill_script') presentation.scriptDispatched = false;
      // Check ownership/review identity before even probing recovery state.
      ctx.assertDraftReadable?.();
      const editing = ['edit_file', 'write_file', 'copy_to_project', 'run_parallel_edits'].includes(d.function.name);
      const before = editing && ctx.checkpointDraft ? structuredClone(ctx.changesetBuffer) : null;
      const reads = before ? new Map(ctx.reads) : null;
      const fileReads = before ? structuredClone(ctx.fileReads) : null;
      const observations = before ? new Map(ctx.fileObservations) : null;
      let recovery;
      if (editing && d.function.name !== 'run_parallel_edits' && ctx.executionRecovery) {
        try {
          const state = fileState(ctx, input.path || input.targetPath);
          recovery = ctx.executionRecovery.before(d.function.name, input, [state.projectHash, state.effectiveHash,
            ctx.reads?.get(state.rel), ctx.fileReads.get(`effective:${state.rel}`), ctx.fileReads.get(`project:${state.rel}`)]);
          if (recovery.block) { ctx.onNoProgress?.(recovery.block); return { error: recovery.block.reason }; }
        } catch { /* Invalid paths are rejected by the actual tool. */ }
      }
      try {
        if (d.function.name === 'read_file' && ctx.assertDraftReadable) { /* Inspection is allowed during a disk conflict. */ }
        else if (d.function.name === 'write_file' && input.rebase && ctx.assertDraftRebaseCurrent) ctx.assertDraftRebaseCurrent();
        else ctx.assertDraftCurrent?.();
        const out = await executeTool(d.function.name, input, { ...ctx, signal, presentation });
        if (recovery) ctx.executionRecovery.record(recovery.key, out);
        if (before && !out?.error && JSON.stringify(before) !== JSON.stringify(ctx.changesetBuffer)) {
          // A complete checkpoint, including binary bytes, precedes tool success.
          ctx.checkpointDraft(out.rebased ? { rebasePath: out.path } : undefined);
        }
        if (before && out?.error) {
          ctx.changesetBuffer.splice(0, ctx.changesetBuffer.length, ...before);
          ctx.reads.clear(); for (const [key, value] of reads) ctx.reads.set(key, value);
          ctx.fileReads.clear(); for (const [key, value] of fileReads) ctx.fileReads.set(key, value);
          ctx.fileObservations.clear(); for (const [key, value] of observations) ctx.fileObservations.set(key, value);
        }
        return out;
      } catch (error) {
        if (recovery && error.code === 'DRAFT_DISK_CONFLICT') ctx.executionRecovery.record(recovery.key, { code: 'DRAFT_BASE_CHANGED' });
        if (before) {
          ctx.changesetBuffer.splice(0, ctx.changesetBuffer.length, ...before);
          ctx.reads.clear(); for (const [key, value] of reads) ctx.reads.set(key, value);
          ctx.fileReads.clear(); for (const [key, value] of fileReads) ctx.fileReads.set(key, value);
          ctx.fileObservations.clear(); for (const [key, value] of observations) ctx.fileObservations.set(key, value);
        }
        throw error;
      }
    },
  }, ctx));
}

function flatTree(nodes, acc = []) {
  for (const n of nodes) {
    if (n.type === 'dir') {
      acc.push(`${n.path}/`);
      flatTree(n.children || [], acc);
    } else {
      acc.push(n.path);
    }
  }
  return acc;
}

/** 规范化项目相对路径并过安全校验，返回 {rel, abs} */
function resolveProjectPath(ctx, rel) {
  const abs = safeJoin(ctx.projectDir, String(rel || ''));
  return { rel: toPosix(path.relative(ctx.projectDir, abs)), abs };
}

function stagedEntry(ctx, rel) {
  return (ctx.changesetBuffer || []).find((f) => f.path === rel);
}

/** Hash the effective draft using the same safe path resolution as file tools. */
export function projectEvidenceHash(ctx, relative) {
  try {
    const state = fileState(ctx, relative);
    // Final application writes exactly the reviewed proposal before publishing
    // the terminal graph. Those bytes still satisfy its evidence manifest.
    if (state.conflict && state.project !== state.effective) return undefined;
    return state.effectiveHash;
  } catch { return undefined; }
}

/** Keep one run-local proposal per path, dropping changes reverted to its base. */
function stageChange(ctx, rel, abs, after, encoding = 'utf8') {
  const existing = stagedEntry(ctx, rel);
  if (existing && (existing.encoding || 'utf8') !== encoding) throw new Error('同轮不能切换文件的文本/二进制类型');
  const before = existing ? existing.before : (fs.existsSync(abs) ? fs.readFileSync(abs).toString(encoding) : null);
  const current = existing ? existing.after : before;
  const changed = filterMeaningfulChanges([{ path: rel, before: current, after, encoding }]).length > 0;
  if (!changed) return { changed: false, staged: !!existing };
  const next = { path: rel, before, after, encoding };
  const staged = filterMeaningfulChanges([next]).length > 0;
  if (existing) {
    if (staged) existing.after = after;
    else ctx.changesetBuffer.splice(ctx.changesetBuffer.indexOf(existing), 1);
  } else if (staged) ctx.changesetBuffer.push(next);
  return { changed: true, staged };
}

function projectWriteResult(rel, result) {
  return {
    path: rel, scope: 'project', ...result, applied: false,
    text: !result.changed ? `${rel} 内容一致，未产生新修改`
      : result.staged ? `已暂存对 ${rel} 的修改（尚未应用，对话结束后进入变更审查）`
      : `${rel} 已取消本轮暂存修改，该文件无待提交修改；本次未执行正式写盘`,
  };
}

function workspaceWriteResult(rel, changed) {
  return { path: rel, scope: 'workspace', changed, staged: false, applied: changed,
    text: changed ? `已直接写入工作区文件 ${rel}（不属于正式项目修改）` : `${rel} 内容一致，未产生修改` };
}

/** 工作区（_workspace/）是智能体的草稿区：写入直接落盘，不进变更审查 */
function isWorkspacePath(rel) {
  return rel === '_workspace' || rel.startsWith('_workspace/');
}

/** 工作区直接写盘：先冲刷该项目协同防抖缓冲，避免打开中的旧内容随后覆盖写入 */
function writeDirect(ctx, abs, content) {
  if (ctx.project?.id != null) flushProjectRooms(ctx.project.id);
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  if (fs.existsSync(abs) && fs.readFileSync(abs).equals(bytes)) return false;
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, bytes);
  return true;
}

function truncate(s, n, note = '\n...（内容过长已截断）') {
  return s.length > n ? s.slice(0, n) + note : s;
}

async function withRuntimeResourceAccess(ctx, install) {
  const revoked = new AbortController();
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, revoked.signal]) : revoked.signal;
  const db = getDb();
  const beforeInstall = () => {
    signal.throwIfAborted();
    try {
      const user = db.prepare('SELECT id,status FROM users WHERE id=?').get(ctx.user?.id);
      if (user?.status !== 'active') throw new HttpError(403, '账号已被禁用或删除');
      const { project } = requireProjectAccess(user, ctx.project?.public_id, { write: true });
      assertWorkAdmission(db);
      return project;
    } catch (error) {
      revoked.abort(error);
      throw error;
    }
  };
  const project = beforeInstall();
  // These operations can spend minutes in a download or an installer process.
  const watchAccess = setInterval(() => {
    try { beforeInstall(); } catch { clearInterval(watchAccess); }
  }, 250);
  watchAccess.unref();
  try { return await install(project, { signal, beforeInstall }); }
  finally { clearInterval(watchAccess); }
}

function readFontUpload(projectId, rel) {
  if (typeof rel !== 'string' || !rel || rel.includes('\\') || /^[A-Za-z]+:/.test(rel)) throw new Error('字体必须来自项目内的相对文件路径');
  const root = configuredProjectDir(projectId);
  const abs = safeJoin(root, rel);
  let current = root;
  for (const segment of ['', ...path.relative(root, abs).split(path.sep)]) {
    if (segment) current = path.join(current, segment);
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('字体路径不允许符号链接');
  }
  const fd = fs.openSync(abs, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.size <= 0 || info.size > 30 * 1024 * 1024) throw new Error('字体必须是非空普通文件，且不超过30MB');
    return { originalname: path.basename(abs), buffer: fs.readFileSync(fd) };
  } finally { fs.closeSync(fd); }
}

async function renderFigurePdfPage(bytes, page, signal) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'corelatex-figure-preview-'));
  const source = path.join(dir, 'figure.pdf');
  const prefix = path.join(dir, 'preview');
  const output = prefix + '.png';
  try {
    fs.writeFileSync(source, bytes, { mode: 0o600 });
    const render = await runProcess('pdftoppm', [
      '-png', '-singlefile', '-scale-to', '1200', '-f', String(page), '-l', String(page), source, prefix,
    ], { signal, timeoutMs: 15_000, maxOutputBytes: 4096 }).catch(error => {
      if (error.code === 'ENOENT') throw new Error('pdftoppm 不可用，无法预览独立 PDF 图稿');
      throw error;
    });
    if (render.timedOut) throw new Error('PDF 图稿预览超时');
    if (render.exitCode || !fs.existsSync(output)) {
      throw new Error(`无法预览 PDF 图稿第 ${page} 页，请核对页码和文件是否有效`);
    }
    const size = fs.statSync(output).size;
    if (!size || size > IMAGE_MAX_BYTES) throw new Error('PDF 图稿未生成可用的预览图像');
    return fs.readFileSync(output);
  } finally {
    fs.rmSync(output, { force: true });
    fs.rmSync(source, { force: true });
    fs.rmdirSync(dir);
  }
}

const TOOL_IMPLS = {
  async inspect_runtime_resources(_input, ctx) {
    const [fonts, tex] = await Promise.all([listRuntimeFonts(), listTexRuntimes({ admin: false })]);
    return { currentVersion: ctx.project.tex_version || 'system', fonts, tex };
  },
  install_tex_packages(input, ctx) {
    return withRuntimeResourceAccess(ctx, (project, options) => installTexPackages({
      version: input.version || project.tex_version || 'system', packages: input.packages,
    }, { ...options, persistRepository: false }));
  },
  install_font(input, ctx) {
    return withRuntimeResourceAccess(ctx, async (project, options) => {
      const hasPath = typeof input.path === 'string' && !!input.path.trim();
      const hasUrl = typeof input.url === 'string' && !!input.url.trim();
      if (hasPath === hasUrl) throw new Error('请恰好提供一个字体项目路径或 HTTPS 下载地址');
      if (input.sha256 && !hasUrl) throw new Error('SHA-256 校验仅用于字体下载');
      const file = hasUrl
        ? await downloadFontFile(input.url, { signal: options.signal, sha256: input.sha256 })
        : readFontUpload(project.id, input.path);
      options.beforeInstall();
      const result = await installFontFiles([file], options);
      return hasUrl ? { ...result, sha256: file.sha256, requestedUrl: file.requestedUrl, sourceUrl: file.sourceUrl } : result;
    });
  },
  run_parallel_edits: async (input, ctx) => typeof ctx.runParallelEdits === 'function'
    ? ctx.runParallelEdits(input, ctx.signal) : { error: '当前执行器未启用受控并行编辑' },
  list_files(_input, ctx) {
    const paths = flatTree(buildTree(ctx.projectDir));
    return paths.length ? paths.join('\n') : '（项目为空）';
  },

  async view_image(input, ctx) {
    const { rel, abs } = resolveProjectPath(ctx, input.path);
    const staged = stagedEntry(ctx, rel);
    const stat = staged ? null : fs.statSync(abs, { throwIfNoEntry: false });
    if (!staged && !stat?.isFile()) return { error: `文件不存在：${rel}` };
    const extension = path.extname(abs).toLowerCase();
    const pdf = extension === '.pdf';
    const mediaType = pdf ? 'image/png' : IMAGE_MIME[extension];
    if (!mediaType) return { error: `${rel} 不是可查看的图像格式（支持 png/jpg/jpeg/webp/gif/pdf）` };
    let readPath = abs;
    if (pdf && !staged) {
      const root = fs.realpathSync(ctx.projectDir);
      readPath = fs.realpathSync(abs);
      if (!readPath.startsWith(root + path.sep)) return { error: 'PDF 图稿路径不在项目内' };
    }
    // Match read_file and preview compilation: inspect the current proposal,
    // including newly staged files, without applying it to the project.
    const encoding = staged?.encoding === 'base64' ? 'base64' : 'utf8';
    const size = staged ? Buffer.byteLength(staged.after ?? '', encoding) : stat.size;
    const limit = pdf ? FIGURE_PDF_MAX_BYTES : IMAGE_MAX_BYTES;
    if (size > limit) return { error: `${rel} 超过 ${limit / 1048576}MB 上限（当前 ${(size / 1048576).toFixed(1)}MB），请先压缩或转换格式后再查看` };
    const page = input.page ?? 1;
    if (pdf && (!Number.isInteger(page) || page < 1 || page > 2147483647)) return { error: 'PDF 页码必须为正整数' };
    const bytes = staged ? Buffer.from(staged.after ?? '', encoding) : fs.readFileSync(readPath);
    const preview = pdf ? await renderFigurePdfPage(bytes, page, ctx.signal) : bytes;
    // 复用 compile_and_preview 的图像返回管线：images 数组由 agentLoop 转为多模态内容进模型
    const description = pdf ? `已预览 PDF 图稿 ${rel} 的第 ${page} 页` : `已加载图像 ${rel}`;
    return {
      text: `${description}（${mediaType}，${(preview.length / 1024).toFixed(0)} KB${staged ? '，本轮暂存版本' : ''}）。请基于图像内容直接观察与回答（外观、构图、配色、文字标签等）。`,
      images: [{ mediaType, imageBase64: preview.toString('base64'), ...(pdf ? { page } : {}) }],
    };
  },

  read_file(input, ctx) {
    if (ctx.project?.id != null) flushProjectRooms(ctx.project.id);
    const { rel, abs } = resolveProjectPath(ctx, input.path);
    const state = fileState(ctx, rel);
    const view = input.view || 'effective';
    if (!['effective', 'project'].includes(view)) return { error: 'view 必须是 effective 或 project' };
    const staged = view === 'project' ? null : state.draft;
    if (staged?.encoding === 'base64') return { error: rel + ' 是暂存二进制文件，无法作为文本读取' };
    if (!staged) {
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return { error: `文件不存在：${rel}` };
      if (!isTextFile(abs)) return { error: `${rel} 不是文本文件，无法读取` };
    }
    const full = staged ? staged.after : state.project;
    if (full == null) return { error: `${rel} 已在草稿中删除` };
    // Keep the CR in CRLF as before. Each split consumes one code unit, so
    // the same offsets address LF, CRLF and classic TeX files with bare CR.
    const lines = full.split(/\n|\r(?!\n)/);
    const totalLines = lines.length;

    // 行窗口：offset（1 基起始行）/ limit（行数），供超长文件分页
    let start = Math.floor(Number(input.offset)) || 1;
    let searchResult;
    if (input.find !== undefined) {
      if (typeof input.find !== 'string' || !input.find.length || /[\r\n]/.test(input.find)) {
        return { error: 'find 必须是非空的单行字面文本' };
      }
      const matchLines = [];
      let matchedLines = 0;
      const fromLine = Math.max(1, start);
      for (let i = fromLine - 1; i < totalLines; i++) {
        if (!lines[i].includes(input.find)) continue;
        matchedLines++;
        if (matchLines.length < 20) matchLines.push(i + 1);
      }
      searchResult = { view, staged: !!staged, fromLine, matchedLines, matchLines, totalLines,
        contentHash: view === 'project' ? state.projectHash : state.effectiveHash };
      if (ctx.presentation) ctx.presentation.fileSearch = searchResult;
      if (!matchedLines) {
        // Observe the version for delivery checks without granting edit coverage.
        if (view === 'effective') {
          ctx.fileObservations ||= new Map();
          ctx.fileObservations.set(rel, state.projectHash);
        }
        return { ...searchResult, text: '', ...(state.conflict ? { conflict: true, notice: draftConflict(state).error,
          projectHash: state.projectHash, draftHash: state.effectiveHash } : {}) };
      }
      start = matchLines[0];
    }
    start = Math.min(Math.max(1, start), totalLines);
    const limit = Math.floor(Number(input.limit)) || (searchResult ? 1 : 0);
    const end = limit > 0 ? Math.min(totalLines, start - 1 + limit) : totalLines;

    // 单次按字节截到 10MB；至少返回一行（单行超长时原样给出）
    const picked = [];
    let bytes = 0;
    let hitLimit = false;
    for (let i = start - 1; i < end; i++) {
      const lineBytes = Buffer.byteLength(lines[i], 'utf8') + 1;
      if (bytes + lineBytes > READ_MAX_BYTES && picked.length) {
        hitLimit = true;
        break;
      }
      picked.push(lines[i]);
      bytes += lineBytes;
    }

    const shownEnd = start - 1 + picked.length;
    const startOffset = lines.slice(0, start - 1).reduce((sum, line) => sum + line.length + 1, 0);
    const excerptLength = picked.reduce((sum, line) => sum + line.length, picked.length - 1);
    const excerpt = full.slice(startOffset, startOffset + excerptLength);
    const endOffset = Math.min(full.length, startOffset + excerpt.length + (shownEnd < totalLines ? 1 : 0));
    let out = excerpt;
    if (start > 1 || shownEnd < totalLines) {
      const note = [`（${rel} 共 ${totalLines} 行；本次返回第 ${start}–${shownEnd} 行`];
      if (hitLimit) note.push('，已达单次读取 10MB 上限');
      note.push(shownEnd < totalLines ? '；可用 offset 参数继续读取）' : '）');
      out += `\n${note.join('')}`;
    }
    // 记录本轮读取到的内容哈希（完整内容，不受读取窗口影响），供先读后改闸比对
    if (view === 'effective') ctx.reads?.set(rel, contentHash(full));
    rememberRead(ctx, state, view, startOffset, endOffset);
    ctx.readEvidence ||= new Map();
    if (view === 'effective' && !state.conflict) ctx.readEvidence.set(rel, { source: rel, contentHash: contentHash(full), content: excerpt,
      purpose: input.purpose || 'context', startLine: start, endLine: shownEnd, truncated: hitLimit || start > 1 || shownEnd < totalLines, capturedAt: Date.now() });
    if (ctx.presentation) ctx.presentation.read = { path: rel, view, contentHash: fileHash(full), purpose: input.purpose || 'context',
      startOffset, endOffset, start, end: shownEnd, totalLines, content: excerpt, staged: !!staged, truncated: hitLimit };
    // Preserve the ordinary raw-text protocol. Explicit project reads and
    // conflicts carry version metadata, never silently masquerade as a draft.
    if (searchResult || view === 'project' || state.conflict) return { ...searchResult, text: out, view, contentHash: fileHash(full),
      projectHash: state.projectHash, draftHash: state.draft ? state.effectiveHash : null,
      ...(state.conflict ? { conflict: true, notice: draftConflict(state).error } : {}) };
    return out;
  },

  read_workspace(_input, ctx) {
    const dir = ctx.workspaceDir;
    if (!fs.existsSync(dir)) return '工作区为空（_workspace/ 不存在）';
    const files = flatTree(buildTree(dir)).filter((p) => !p.endsWith('/'));
    if (!files.length) return '工作区为空';
    const lines = [];
    if (ctx.presentation) { ctx.presentation.files = []; ctx.presentation.filesTruncated = files.length > 50; }
    for (const rel of files.slice(0, 50)) {
      const abs = path.join(dir, rel);
      let size = 0;
      try { size = fs.statSync(abs).size; } catch { continue; }
      lines.push(`${rel}（${size} 字节）`);
      ctx.presentation?.files.push({ label: rel, path: `_workspace/${rel}`, detail: `${size} 字节` });
      if (isTextFile(abs) && size <= 4096) {
        const content = fs.readFileSync(abs, 'utf8');
        lines.push(`--- ${rel} 内容 ---\n${truncate(content, 2000)}\n--- 结束 ---`);
      }
    }
    if (files.length > 50) lines.push(`...（共 ${files.length} 个文件，仅列前 50）`);
    return lines.join('\n');
  },

  write_file(input, ctx) {
    if (ctx.project?.id != null) flushProjectRooms(ctx.project.id);
    const { rel, abs } = resolveProjectPath(ctx, input.path);
    const content = String(input.content ?? '');
    const state = fileState(ctx, rel);
    if (input.rebase) {
      if (isWorkspacePath(rel) || !state.conflict || !state.projectText || state.draft?.encoding === 'base64') {
        return { code: 'REBASE_STALE', error: 'rebase 仅用于仍然存在的正式文本文件与本轮草稿冲突；删除文件或二进制冲突需用户确认处理' };
      }
      if (input.rebase.projectHash !== state.projectHash || input.rebase.draftHash !== state.effectiveHash ||
        !readCovers(ctx, rel, state.project, { view: 'project' }) || !readCovers(ctx, rel, state.effective)) {
        return { code: 'REBASE_STALE', error: 'rebase 的版本或完整读取范围不符；请重新完整读取正式文件与草稿，结合用户修改后再提交' };
      }
      // Synchronous compare-and-stage: no await between validation/checkpoint.
      state.draft.before = state.project; state.draft.after = content;
      if (content === state.project) ctx.changesetBuffer.splice(ctx.changesetBuffer.indexOf(state.draft), 1);
      ctx.reads?.set(rel, contentHash(content));
      rememberRead(ctx, { ...state, effective: content }, 'effective', 0, content.length);
      ctx.readEvidence?.delete(rel);
      if (ctx.presentation) ctx.presentation.edit = { before: state.effective, after: content, scope: '基于用户当前版本调整草稿' };
      return { ...projectWriteResult(rel, { changed: true, staged: content !== state.project }), rebased: true };
    }
    const conflict = draftConflict(state);
    if (conflict) return conflict;
    if (fs.existsSync(abs) && !isTextFile(abs)) return { error: `${rel} 是二进制文件，不能用 write_file 覆写` };
    if (ctx.presentation) {
      const previous = stagedEntry(ctx, rel);
      ctx.presentation.edit = { before: previous?.after ?? (fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : ''), after: content, scope: '文件全文' };
    }
    if (isWorkspacePath(rel)) {
      const changed = writeDirect(ctx, abs, content);
      ctx.reads?.set(rel, contentHash(content));
      rememberRead(ctx, { ...state, effective: content, projectHash: contentHash(content) }, 'effective', 0, content.length);
      return workspaceWriteResult(rel, changed);
    }
    // 覆写已存在的项目文件同样过先读后改闸（新建文件无需读取）
    const staged = stagedEntry(ctx, rel);
    if (staged?.encoding === 'base64') return { error: rel + ' 是暂存二进制文件，不能用 write_file 覆写' };
    if (staged || fs.existsSync(abs)) {
      const gate = assertFreshRead(ctx, rel, staged ? staged.after : fs.readFileSync(abs, 'utf8'));
      if (gate) return gate;
      if (ctx.fileReads?.has(`effective:${rel}`) && !readCovers(ctx, rel, state.effective)) return { code: 'READ_SCOPE_REQUIRED', error: '整体覆写前须读完当前文件；局部读取请使用 edit_file，仅修改实际读到的片段' };
    }
    const result = stageChange(ctx, rel, abs, content);
    ctx.reads?.set(rel, contentHash(content));
    rememberRead(ctx, { ...state, effective: content }, 'effective', 0, content.length);
    return projectWriteResult(rel, result);
  },

  edit_file(input, ctx) {
    if (ctx.project?.id != null) flushProjectRooms(ctx.project.id);
    const { rel, abs } = resolveProjectPath(ctx, input.path);
    const state = fileState(ctx, rel), conflict = draftConflict(state);
    if (conflict) return conflict;
    const search = String(input.search ?? '');
    const replace = String(input.replace ?? '');
    if (input.fixAppliedFor && !input.baseHash) return { error: '关联修复必须提供 baseHash，以核对建议对应的草稿版本' };
    if (!search) return { error: 'search 不能为空' };
    const staged = stagedEntry(ctx, rel);
    if (staged?.encoding === 'base64') return { error: rel + ' 是二进制文件，不能用 edit_file 修改' };
    let base;
    if (staged) base = staged.after;
    else if (fs.existsSync(abs) && fs.statSync(abs).isFile()) base = fs.readFileSync(abs, 'utf8');
    else return { error: `文件不存在：${rel}` };
    const gate = assertFreshRead(ctx, rel, base);
    if (gate) return gate;
    if (input.baseHash && input.baseHash !== contentHash(base)) return { code: 'STALE_FIX', error: '修复建议的 baseHash 已过期，请重新读取当前草稿并核对问题' };
    const count = base.split(search).length - 1;
    if (count === 0) {
      return { code: 'EDIT_SEARCH_NOT_FOUND', error: `在 ${rel} 中未找到 search 文本。文件开头片段供参考：\n${base.slice(0, 300)}` };
    }
    if (count > 1) {
      return { code: 'EDIT_SEARCH_AMBIGUOUS', error: `search 文本在 ${rel} 中出现 ${count} 次，请补充更多上下文使其唯一` };
    }
    const offset = base.indexOf(search);
    if (ctx.fileReads?.has(`effective:${rel}`) && !readCovers(ctx, rel, base, { start: offset, end: offset + search.length })) {
      return { code: 'READ_SCOPE_REQUIRED', error: '目标片段不在本轮实际读取的范围内，请 read_file 读取该区域后再修改；全文哈希不代表已读全文' };
    }
    const after = base.replace(search, replace);
    if (ctx.presentation) ctx.presentation.edit = { before: search, after: replace, scope: '唯一匹配的替换片段' };
    if (isWorkspacePath(rel)) {
      const changed = writeDirect(ctx, abs, after);
      ctx.reads?.set(rel, contentHash(after));
      advanceRead(ctx, rel, base, after, offset, search.length, replace.length);
      const read = ctx.fileReads?.get(`effective:${rel}`); if (read) read.projectHash = contentHash(after);
      ctx.fileObservations?.set(rel, contentHash(after));
      return workspaceWriteResult(rel, changed);
    }
    const result = stageChange(ctx, rel, abs, after);
    // 链式编辑：以本次暂存结果为新的「已读」基准，同轮连续编辑无需重复读取
    ctx.reads?.set(rel, contentHash(after));
    advanceRead(ctx, rel, base, after, offset, search.length, replace.length);
    return { ...projectWriteResult(rel, result), ...(input.fixAppliedFor ? { fixAppliedFor: String(input.fixAppliedFor).slice(0, 100) } : {}) };
  },

  copy_to_project(input, ctx) {
    if (ctx.project?.id != null) flushProjectRooms(ctx.project.id);
    const srcAbs = safeJoin(ctx.workspaceDir, String(input.workspacePath || ''));
    const { rel, abs: dstAbs } = resolveProjectPath(ctx, input.targetPath);
    const state = fileState(ctx, rel), conflict = draftConflict(state);
    if (conflict) return conflict;
    if (!fs.existsSync(srcAbs) || !fs.statSync(srcAbs).isFile()) {
      return { error: `工作区文件不存在：${input.workspacePath}` };
    }
    if (!isWorkspacePath(rel)) {
      const encoding = isTextFile(srcAbs) ? 'utf8' : 'base64';
      const content = fs.readFileSync(srcAbs).toString(encoding);
      const staged = stagedEntry(ctx, rel);
      if (encoding === 'utf8') {
        if (staged?.encoding === 'base64' || (fs.existsSync(dstAbs) && !isTextFile(dstAbs))) {
          return { error: rel + ' 是二进制文件，不能以文本覆盖' };
        }
        if (staged || fs.existsSync(dstAbs)) {
          const gate = assertFreshRead(ctx, rel, staged ? staged.after : fs.readFileSync(dstAbs, 'utf8'));
          if (gate) return gate;
          if (ctx.fileReads?.has(`effective:${rel}`) && !readCovers(ctx, rel, state.effective)) return { code: 'READ_SCOPE_REQUIRED', error: '覆盖目标文件前须完整读取；局部读取不足以替换全文' };
        }
      }
      assertStorageQuota(ctx.user, fs.statSync(srcAbs).size);
      if (ctx.presentation) ctx.presentation.edit = encoding === 'utf8'
        ? { before: staged?.after ?? (fs.existsSync(dstAbs) ? fs.readFileSync(dstAbs, 'utf8') : ''), after: content, scope: '文件全文' }
        : { binary: true };
      const result = stageChange(ctx, rel, dstAbs, content, encoding);
      if (encoding === 'utf8') ctx.reads?.set(rel, contentHash(content));
      if (encoding === 'utf8') rememberRead(ctx, { ...state, effective: content }, 'effective', 0, content.length);
      return projectWriteResult(rel, result);
    }
    assertStorageQuota(ctx.user, fs.statSync(srcAbs).size);
    if (ctx.presentation) ctx.presentation.edit = isTextFile(srcAbs)
      ? { before: fs.existsSync(dstAbs) && isTextFile(dstAbs) ? fs.readFileSync(dstAbs, 'utf8') : '', after: fs.readFileSync(srcAbs, 'utf8'), scope: '文件全文' }
      : { binary: true };
    const copied = fs.readFileSync(srcAbs), changed = writeDirect(ctx, dstAbs, copied);
    if (isTextFile(srcAbs)) {
      const content = copied.toString('utf8'); ctx.reads?.set(rel, contentHash(content));
      rememberRead(ctx, { ...state, effective: content, projectHash: contentHash(content) }, 'effective', 0, content.length);
    }
    return workspaceWriteResult(rel, changed);
  },

  async run_in_workspace(input, ctx) {
    if (ctx.agentConfig?.confirmBeforeApply) return { error: '确认后应用模式禁用任意脚本：工作目录不是安全沙箱，脚本可绕过变更审查。请手动运行所需脚本，或使用受审查的文件工具。' };
    if (ctx.agentConfig?.allowRunScripts === false) {
      return { error: '当前未允许在工作区执行脚本（可在设置 → 智能体中开启）' };
    }
    const command = String(input.command || '');
    if (!command.trim()) return { error: 'command 不能为空' };
    if (ctx.presentation) ctx.presentation.scriptDispatched = true;
    fs.mkdirSync(ctx.workspaceDir, { recursive: true });
    return runCommand(command, ctx.workspaceDir, ctx.signal);
  },

  async run_skill_script(input, ctx) {
    if (ctx.agentConfig?.confirmBeforeApply) return { error: '确认后应用模式禁用技能脚本：脚本可绕过变更审查。请手动运行脚本，或使用受审查的文件工具。' };
    // 与 run_in_workspace 同一安全开关：未允许执行脚本时直接拒绝
    if (ctx.agentConfig?.allowRunScripts === false) {
      return { error: '当前未允许执行脚本（可在设置 → 智能体中开启）' };
    }
    const name = String(input.skill || '');
    if (!name || /[/\\]/.test(name) || name.includes('..')) return { error: '非法技能名' };
    if (isSkillDisabled(ctx.user.id, name)) return { error: `技能已停用：${name}` };
    const rel = String(input.script ?? '').trim().replaceAll('\\\\', '/');
    if (!rel || rel.split('/').includes('..') || path.isAbsolute(rel)) return { error: '非法脚本路径' };
    const skillDir = path.join(SKILLS_DIR, String(ctx.user.id), name);
    const target = path.join(skillDir, rel);
    if (target !== skillDir && !target.startsWith(skillDir + path.sep)) return { error: '非法脚本路径' };
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return { error: `脚本不存在：${rel}` };
    // 按扩展名选择解释器；脚本以自身所在目录为工作目录（技能内的相对引用可用）
    const ext = path.extname(target).toLowerCase();
    const shq = (s) => `'${String(s).replaceAll("'", `'\\''`)}'`;
    const args = String(input.args ?? '').trim();
    let command;
    if (ext === '.py') command = ['python3', shq(target), args].filter(Boolean).join(' ');
    else if (ext === '.sh') command = ['bash', shq(target), args].filter(Boolean).join(' ');
    else command = [shq(target), args].filter(Boolean).join(' ');
    if (ctx.presentation) ctx.presentation.scriptDispatched = true;
    const r = await runCommand(command, path.dirname(target), ctx.signal);
    if (ctx.presentation) ctx.presentation.command = r;
    const output = [r.stdout, r.stderr].filter(Boolean).join('\n[stderr]\n');
    if (r.error) return r;
    if (r.exitCode) return { error: `脚本退出码 ${r.exitCode}\n${output}`.trim() };
    return truncate(output || '（无输出）', READ_TRUNCATE);
  },

  get_document_context(_input, ctx) {
    return {
      file: ctx.currentFile || null,
      content: ctx.currentContent ? truncate(String(ctx.currentContent), READ_TRUNCATE) : '',
    };
  },

  // 编译（项目当前配置的引擎）+ 把 PDF 渲染为页面图像，供视觉模型检查排版。
  // 返回 { text, images: [{mediaType, imageBase64}] }；agentLoop 将其转为多模态工具结果。
  async compile_and_preview(input, ctx) {
    for (const file of ctx.changesetBuffer || []) {
      const conflict = draftConflict(fileState(ctx, file.path));
      if (conflict) return { ...conflict, compileEvidence: { status: 'blocked', attempted: false, stage: 'inputs',
        code: conflict.code, retryable: true, message: conflict.error } };
    }
    // Freeze the proposal before waiting behind another worker's compilation.
    const staged = stageSnapshot(ctx);
    const liveCtx = ctx;
    const user = ctx.user;
    return withCompilationCache(ctx, async (cache, signal) => {
      // A long-running chat may outlive a user's change of main file/engine.
      const settings = liveCompileSettings(ctx.project);
      const project = { ...ctx.project, ...settings };
      ctx = { ...ctx, project, changesetBuffer: staged, signal };
      const generation = cache?.generation;
      const initial = cache ? await compilationFingerprint(ctx, staged, signal, settings) : null;
      const key = initial?.reusable ? initial.key : null;
      if (cache) cache.proof = null;
      let entry = key && cache.entry?.key === key && (!cache.entry.pdfPath || fs.existsSync(cache.entry.pdfPath)) ? cache.entry : null;
      if (entry?.inputManifest?.recorded && (await verifyCompilationInputs(entry.inputManifest, { signal }) !== 'current' ||
          cache.entry !== entry || generation !== cache.generation)) entry = null;
      const reused = !!entry;
      if (reused && entry.compileEvidence?.status === 'failed' && entry.compileEvidence.code === 'LATEX_ERROR') {
        ctx.onNoProgress?.({ failed: true, code: 'COMPILE_NO_PROGRESS', reason: '相同编译输入的错误已经返回，文件和编译环境未变化；重复编译不能解决该错误。请根据现有诊断修复，或说明受阻原因后继续。' });
      }
      if (entry) entry.refs++;
      else if (cache) retireCompilationEntry(cache);
      let snapshotDir;
      try {
        if (!entry) {
          const previewMode = !!(staged.length || ctx.agentConfig?.confirmBeforeApply);
          const result = previewMode
            ? await previewCompileProject({ project, user, staged, snapshotPdf: true, signal })
            : await compileProject({ project, user, snapshotPdf: true, signal });
          snapshotDir = result.snapshotDir;
          const ok = previewMode ? result.ok : result.status === 'success';
          const errors = result.errors || [];
          const errs = errors.map(e => `${e.file || ''}:${e.line || ''} ${e.message}`).join('\n');
          entry = { key, refs: 1, retired: true, snapshotDir, pdfPath: ok ? result.pdfPath : null,
            inputManifest: result.inputManifest,
            durationMs: result.durationMs, warnings: result.warnings || [], errors,
            compileEvidence: { ...(result.compileEvidence || { status: ok ? 'succeeded' : 'failed', attempted: true, stage: 'compile', code: ok ? 'COMPILE_SUCCEEDED' : 'LATEX_ERROR', retryable: true }),
              inputKey: key, diagnosticsKey: contentHash(JSON.stringify(errors.map(e => [e.file, e.line, e.message]))) },
            engine: result.engine || project.compile_engine || 'pdflatex', previewMode,
            error: ok ? null : (previewMode ? '预览编译失败（基于「磁盘基线 + 暂存修改」的隔离副本）。错误：\n' : '编译失败，无法预览。错误：\n') + truncate(errs || '（无错误详情）', 2000),
            pageImages: new Map(), pageBytes: 0, totalPages: null };
        }
        signal?.throwIfAborted();
        const { pdfPath, engine: engineUsed, durationMs: originalDurationMs, warnings, previewMode } = entry;
        const durationMs = reused ? 0 : originalDurationMs;
        const compileMeta = { engine: engineUsed, durationMs, originalDurationMs, reused, previewMode, warnings, errors: entry.errors };
        if (ctx.presentation) {
          ctx.presentation.compile = compileMeta;
          ctx.presentation.compileEvidence = { ...entry.compileEvidence, reused };
        }
        if (entry.error) return { error: entry.error + (reused ? '\n复用本轮相同输入版本的编译失败诊断，未重新编译。' : '') };
        if (!pdfPath || !fs.existsSync(pdfPath)) return { error: '编译成功但未找到 PDF 文件' };
        const buildDir = path.dirname(pdfPath);

        let totalPages = entry.totalPages || 0;
        if (!totalPages) {
          try {
            const info = await runProcess('pdfinfo', [pdfPath], { signal, timeoutMs: 15_000 });
            const m = String(info.stdout || '').match(/Pages:\s+(\d+)/);
            if (m) totalPages = Number(m[1]);
            if (totalPages > 0) entry.totalPages = totalPages;
          } catch { signal?.throwIfAborted(); }
        }

        const want = [];
        const spec = String(input.pages ?? '').trim();
        if (spec) {
          for (const part of spec.split(/[,，]/)) {
            const m = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
            if (!m) return { error: `页码格式不合法：${part}（示例：3 或 2-4 或 1,3,5）` };
            const a = Number(m[1]), b = m[2] ? Number(m[2]) : a;
            if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 1 || b < 1) return { error: '页码必须是从 1 开始的有效整数' };
            const last = Math.min(Math.max(a, b), totalPages || Number.MAX_SAFE_INTEGER);
            for (let p = Math.min(a, b); p <= last && want.length < 8; p++) if (!want.includes(p)) want.push(p);
          }
        } else want.push(1, 2, 3);
        const pages = [...new Set(want)].filter(p => !totalPages || p <= totalPages).slice(0, 8);
        if (!pages.length) return { error: `页码超出范围（文档共 ${totalPages} 页）` };

        const dpi = Math.min(150, Math.max(50, Number(input.dpi) || 100));
        const images = [], droppedPages = [];
        const IMG_BUDGET = 2 * 1024 * 1024;
        let totalBytes = 0, renderedFromCache = true;
        for (const page of pages) {
          signal?.throwIfAborted();
          const pageKey = `${page}:${dpi}`;
          let image = entry.pageImages.get(pageKey);
          if (image) { entry.pageImages.delete(pageKey); entry.pageImages.set(pageKey, image); }
          else {
            renderedFromCache = false;
            const prefix = path.join(buildDir, `agent-preview-${Date.now()}-${page}`);
            let produced = [];
            try {
              const render = await runProcess('pdftoppm', ['-jpeg', '-jpegopt', 'quality=70', '-r', String(dpi), '-f', String(page), '-l', String(page), pdfPath, prefix], { signal, timeoutMs: 60_000 });
              if (render.exitCode !== 0) throw new Error(render.stderr || '退出码 ' + render.exitCode);
              produced = fs.readdirSync(buildDir).filter(f => f.startsWith(path.basename(prefix)) && f.endsWith('.jpg')).sort();
              if (!produced.length) return { error: `第 ${page} 页渲染未产生图像` };
              image = { mediaType: 'image/jpeg', imageBase64: fs.readFileSync(path.join(buildDir, produced[0])).toString('base64'), page };
              rememberPage(entry, pageKey, image);
            } catch (error) {
              signal?.throwIfAborted();
              return { error: `PDF 渲染失败：${error.message}` };
            } finally {
              // Include partial output left by a failed/cancelled renderer too.
              if (fs.existsSync(buildDir)) for (const f of fs.readdirSync(buildDir).filter(f => f.startsWith(path.basename(prefix)) && f.endsWith('.jpg'))) fs.rmSync(path.join(buildDir, f), { force: true });
            }
          }
          if (images.length && totalBytes + image.imageBase64.length > IMG_BUDGET) { droppedPages.push(page); continue; }
          totalBytes += image.imageBase64.length; images.push({ ...image });
        }
        if (!images.length) return { error: 'PDF 渲染未产生图像' };
        const head = previewMode
          ? `预览编译成功（${originalDurationMs}ms，共 ${totalPages} 页，引擎 ${engineUsed}）——本次基于「磁盘基线 + 暂存修改」的隔离副本，页面反映的已是改后效果；暂存修改仍将在本轮结束后应用、等待审核。`
          : `编译成功（${originalDurationMs}ms，共 ${totalPages} 页，引擎 ${engineUsed}）。`;
        const text = [head,
          reused ? '复用本轮相同输入版本的编译结果，未重新编译；上述耗时为该版本首次编译耗时。' : '',
          reused && renderedFromCache ? '所选页面与精度相同，页面图像也复用本轮快照。' : '',
          `以下为第 ${images.map(i => i.page).join('、')} 页的渲染图像（按顺序对应，渲染精度 ${dpi} DPI）。`,
          droppedPages.length ? `注意：第 ${droppedPages.join('、')} 页因单次图像总量达上限未随本次返回，需要查看请降低 dpi 后分页调用。` : '',
          `警告 ${warnings.length} 条${warnings.length ? '：' + warnings.slice(0, 5).map(w => w.message).join('；') : ''}`,
          '请基于图像检查排版（页面元素位置、图表占位、留白、溢出、间距、字体、断行等）。若需要查看其他页，可再次调用并指定 pages 参数。',
        ].filter(Boolean).join('\n');
        if (ctx.presentation) ctx.presentation.compile = { ...compileMeta, totalPages, pages: images.map(i => i.page), dpi, droppedPages, renderedFromCache: reused && renderedFromCache };
        return { text, images };
      } finally {
        // The project (including an unstaged dependency) can change during TeX
        // or page rendering. Never turn that old snapshot into current proof.
        try {
          if (entry && cache && !signal?.aborted && !cache.closed) {
            const success = entry.compileEvidence.status === 'succeeded';
            const evidence = ctx.presentation?.compileEvidence;
            const manifest = entry.inputManifest;
            const previewMode = entry.previewMode;
            const latest = stageSnapshot(liveCtx);
            const checkCtx = { ...liveCtx, agentConfig: { ...liveCtx.agentConfig, confirmBeforeApply: previewMode } };
            const current = initial?.key ? await compilationFingerprint(checkCtx, latest, signal) : null;
            const formalOnly = !!key && !manifest?.recorded;
            const dependencies = success && initial?.key && manifest?.complete
              ? await verifyCompilationInputs(manifest, { signal }) : null;
            let inputStatus;
            if (generation !== cache.generation) inputStatus = 'invalidated';
            else if (initial === UNSTABLE_FINGERPRINT || current === UNSTABLE_FINGERPRINT || manifest?.reason === 'unstable' ||
                dependencies === 'unstable' || current && (!current.stillCurrent() || !sameStage(latest, stageSnapshot(liveCtx)))) inputStatus = 'unstable';
            else if (initial?.key && (!current || formalOnly && !current.reusable) || dependencies === 'unverifiable') inputStatus = 'unverifiable';
            else if (initial?.key && current.key !== initial.key || dependencies === 'changed') inputStatus = 'changed';
            if (inputStatus) {
              if (success && evidence) Object.assign(evidence, { inputsCurrent: false, inputStatus });
              retireCompilationEntry(cache);
            } else if (initial?.key) {
              const proved = formalOnly || dependencies === 'current' && !initial.customSearch;
              // Even for an incomplete recorder, remember the formal input
              // snapshot so that we can still detect known changes later.
              if (success) cache.proof = { key: initial.key, previewMode, formalOnly, complete: proved,
                manifest: manifest?.complete ? manifest : null };
              if (success && proved && evidence) evidence.inputsCurrent = true;
              if (key && (!success || proved)) {
                if (!reused) { retireCompilationEntry(cache); cache.entry = entry; entry.retired = false; }
              }
            }
          }
        } finally {
          if (entry) { entry.refs--; disposeCompilationEntry(entry); }
          else if (snapshotDir) fs.rmSync(snapshotDir, { recursive: true, force: true });
        }
      }
    });
  },

  // 联网服务（本地部署，见 webService.js）：可在设置中关闭
  async web_search(input, ctx) {
    if (ctx.agentConfig?.allowWebAccess === false) {
      return { error: '当前未允许联网（可在设置 → 智能体中开启「允许联网」）' };
    }
    const max = Math.min(10, Math.max(1, Math.floor(Number(input.max_results)) || 8));
    const search = await webSearch(input.query, { maxResults: max, signal: ctx.signal });
    const { engine, results } = search;
    const notice = searchOutcomeNotice(search);
    if (ctx.presentation) ctx.presentation.search = { ...search, notice };
    const lines = results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ''}`);
    return `搜索词「${String(input.query).trim()}」共 ${results.length} 条候选结果（引擎 ${engine}）：\n${lines.join('\n')}` +
      (notice ? `\n\n检索情况：${notice}` : '') +
      '\n\n搜索结果仅作候选线索，标题和摘要匹配不等于正文支持结论。请用 web_fetch 读取相关原始来源，核对所需事实；不相关的条目不能作为论据。';
  },

  async web_fetch(input, ctx) {
    if (ctx.agentConfig?.allowWebAccess === false) {
      return { error: '当前未允许联网（可在设置 → 智能体中开启「允许联网」）' };
    }
    const url = String(input.url || '').trim();
    if (!url) return { error: 'url 不能为空' };
    const { title, text, url: finalUrl } = await fetchPageText(url, { signal: ctx.signal });
    if (ctx.presentation) ctx.presentation.web = { title, text, url: finalUrl };
    return `【${title || finalUrl}】\n来源：${finalUrl}\n---\n${text}`;
  },

  read_skill(input, ctx) {
    const name = String(input.name || '');
    if (!name || /[/\\]/.test(name) || name.includes('..')) return { error: '非法技能名' };
    if (isSkillDisabled(ctx.user.id, name)) return { error: `技能已停用：${name}` };
    // file 参数：读取技能目录内的附属文件。支持：
    //   1) 单文件：static/core/workflow.md
    //   2) 逗号/换行分隔批量：a.md, b.md, c.md（一次调用读多个，减少往返）
    //   3) 以 / 结尾 = 目录：读取该目录下全部文件
    //   4) 跨技能引用：../<其他技能>/<路径> → 读取兄弟技能目录内的文件（如共享层）
    const file = String(input.file ?? '').trim();
    if (file) {
      const rels = file.split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean).slice(0, 40);
      const parts = [];
      const failed = [];
      for (let rel of rels) {
        // 跨技能引用：../<技能名>/... → 目标技能为 <技能名>
        let skillName = name;
        let relPath = rel.replace(/^\.\//, '');
        const xm = relPath.match(/^\.\.\/([^/]+)\/(.+)$/);
        if (xm) {
          skillName = xm[1];
          relPath = xm[2];
        }
        let list;
        try {
          list = skillFileList(ctx.user.id, skillName);
        } catch (err) {
          failed.push(`${rel}（${err.message}）`);
          continue;
        }
        if (isSkillDisabled(ctx.user.id, skillName)) {
          failed.push(`${rel}（技能已停用）`);
          continue;
        }
        const matches = relPath.endsWith('/')
          ? list.filter((f) => f.startsWith(relPath))
          : list.filter((f) => f === relPath);
        if (!matches.length) { failed.push(`${rel}（不存在）`); continue; }
        for (const f of matches) {
          try {
            parts.push(`===== ${f} =====\n` + readSkillFile(ctx.user.id, skillName, f));
          } catch (err) {
            failed.push(`${f}（${err.message}）`);
          }
        }
      }
      if (!parts.length) return { error: `未能读取到任何文件${failed.length ? '：' + failed.join('；') : ''}` };
      const text = parts.join('\n\n')
        + (failed.length ? `\n\n[以下未读取成功] ${failed.join('；')}` : '');
      return truncate(text, READ_TRUNCATE);
    }
    const p = path.join(SKILLS_DIR, String(ctx.user.id), name, 'SKILL.md');
    if (!fs.existsSync(p)) return { error: `技能不存在：${name}` };
    let body = fs.readFileSync(p, 'utf8');
    // 附带技能目录文件清单：路由型技能（manifest/fragments）可以直接点名批量读取，
    // 不必在文件系统里盲目搜寻
    const others = skillFileList(ctx.user.id, name).filter((f) => f !== 'SKILL.md');
    const scripts = others.filter((f) => /\.(py|sh)$/i.test(f));
    if (scripts.length) {
      body += `\n\n[本技能包含可执行脚本，可用 run_skill_script 运行（以技能目录为工作目录）：]\n${scripts.map((f) => '- ' + f).join('\n')}`;
    }
    if (others.length) {
      body += `\n\n[技能目录内还有以下文件，需要时用 read_skill 的 file 参数一次读取多个（逗号分隔）]\n${others.map((f) => '- ' + f).join('\n')}`;
    }
    return truncate(body, READ_TRUNCATE);
  },
};

async function runCommand(command, cwd, signal) {
  const result = await runProcess('bash', ['-lc', command], {
    cwd, signal, timeoutMs: RUN_TIMEOUT_MS, maxOutputBytes: 20_000,
  });
  if (result.exitCode !== 0) return { ...result, error: result.timedOut ? '命令执行超时（60s）' : '命令退出码 ' + result.exitCode };
  return result;
}
