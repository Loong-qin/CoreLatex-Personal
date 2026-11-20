import fs from 'node:fs';
import path from 'node:path';
import * as unzipper from 'unzipper';
import { SKILLS_DIR } from '../../config.js';
import { HttpError } from '../../util.js';

/**
 * 技能（Skill）管理：data/skills/<userId>/<name>/SKILL.md 约定。
 * SKILL.md 头部解析：frontmatter 的 name:/description:，或首行 `# 标题`，宽容处理。
 */

function userSkillsDir(userId) {
  return path.join(SKILLS_DIR, String(userId));
}

const DISABLED_FILE = '.disabled';

function skillDirOf(userId, name) {
  const n = String(name || '');
  if (!n || /[/\\]/.test(n) || n.includes('..')) throw new HttpError(400, '非法技能名');
  const dir = path.join(userSkillsDir(userId), n);
  if (path.basename(dir) !== n) throw new HttpError(400, '非法技能名');
  return dir;
}

export function sanitizeSkillName(name) {
  return String(name || '').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'skill';
}

function parseSkillMd(content, fallbackName) {
  let body = content;
  let name = null;
  let description = '';
  const fm = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  if (fm) {
    const nm = fm[1].match(/^\s*name:\s*(.+)$/m);
    const dm = fm[1].match(/^\s*description:\s*(.+)$/m);
    if (nm) name = nm[1].trim();
    if (dm) description = dm[1].trim();
    body = content.slice(fm[0].length);
  }
  if (!name) {
    const h = body.match(/^#\s+(.+)$/m);
    name = h ? h[1].trim() : fallbackName;
  }
  if (!description) {
    for (const line of body.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      description = t.slice(0, 200);
      break;
    }
  }
  return { name, description };
}

export function listSkills(userId) {
  const dir = userSkillsDir(userId);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const md = path.join(dir, e.name, 'SKILL.md');
    if (!fs.existsSync(md)) continue;
    try {
      const { description } = parseSkillMd(fs.readFileSync(md, 'utf8'), e.name);
      const enabled = !fs.existsSync(path.join(dir, e.name, DISABLED_FILE));
      out.push({ name: e.name, description, enabled });
    } catch { /* 单个技能损坏不影响列表 */ }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** 查看技能 SKILL.md 正文 */
export function readSkillContent(userId, name) {
  const dir = skillDirOf(userId, name);
  const md = path.join(dir, 'SKILL.md');
  if (!fs.existsSync(md)) throw new HttpError(404, '技能不存在');
  return fs.readFileSync(md, 'utf8');
}

/** 保存技能 SKILL.md 正文（编辑） */
export function writeSkillContent(userId, name, content) {
  const dir = skillDirOf(userId, name);
  const md = path.join(dir, 'SKILL.md');
  if (!fs.existsSync(md)) throw new HttpError(404, '技能不存在');
  if (typeof content !== 'string' || content.length > 512 * 1024) throw new HttpError(400, '内容非法或过大');
  fs.writeFileSync(md, content);
}

/** 新建空白技能 */
export function createSkill(userId, name, description = '') {
  const dirName = sanitizeSkillName(name);
  const dest = path.join(userSkillsDir(userId), dirName);
  if (fs.existsSync(dest)) throw new HttpError(400, `技能 ${dirName} 已存在`);
  fs.mkdirSync(dest, { recursive: true });
  const desc = String(description || '').trim().slice(0, 200);
  fs.writeFileSync(
    path.join(dest, 'SKILL.md'),
    `---\nname: ${dirName}\ndescription: ${desc || '技能说明'}\n---\n\n# ${dirName}\n\n（在此编写技能说明，Agent 会按此处的指示操作。）\n`,
  );
  return dirName;
}

/** 单个技能开关：禁用写入 .disabled 标记，启用移除 */
export function setSkillEnabled(userId, name, enabled) {
  const dir = skillDirOf(userId, name);
  if (!fs.existsSync(path.join(dir, 'SKILL.md'))) throw new HttpError(404, '技能不存在');
  const marker = path.join(dir, DISABLED_FILE);
  if (enabled) fs.rmSync(marker, { force: true });
  else fs.writeFileSync(marker, '');
}

/** 批量：action = enable | disable | delete */
export function batchSkills(userId, names, action) {
  if (!['enable', 'disable', 'delete'].includes(action)) throw new HttpError(400, '非法批量操作');
  let updated = 0;
  const failed = [];
  for (const n of names || []) {
    try {
      if (action === 'delete') deleteSkill(userId, n);
      else setSkillEnabled(userId, n, action === 'enable');
      updated += 1;
    } catch { failed.push(String(n)); }
  }
  return { updated, failed };
}

/** read_skill 工具调用时拒绝已停用的技能 */
export function isSkillDisabled(userId, name) {
  const dir = skillDirOf(userId, name);
  return fs.existsSync(path.join(dir, DISABLED_FILE));
}

/** 技能目录内文件清单（相对路径，含子目录；跳过停用标记） */
export function skillFileList(userId, name) {
  const dir = skillDirOf(userId, name);
  if (!fs.existsSync(dir)) throw new HttpError(404, '技能不存在');
  const out = [];
  const walk = (cur, rel) => {
    for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
      if (e.name === DISABLED_FILE) continue;
      const abs = path.join(cur, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(abs, r);
      else if (e.isFile()) out.push(r);
    }
  };
  walk(dir, '');
  return out.sort();
}

/** 读取技能目录内的任意文件（相对技能根的路径，限制在技能目录内） */
export function readSkillFile(userId, name, rel) {
  const dir = skillDirOf(userId, name);
  const r = String(rel || '').replaceAll('\\', '/');
  if (!r || r.split('/').includes('..') || path.isAbsolute(r)) throw new HttpError(400, '非法技能文件路径');
  const target = path.join(dir, r);
  if (target !== dir && !target.startsWith(dir + path.sep)) throw new HttpError(400, '非法技能文件路径');
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) throw new HttpError(404, '技能文件不存在');
  return fs.readFileSync(target, 'utf8');
}

/**
 * 规划一次技能导入：递归定位任意深度的 SKILL.md，每个 SKILL.md 所在目录即为一个技能根，
 * 该目录下（含更深子目录）的全部文件归属此技能；互为嵌套的根保留最浅层。
 * entries: [{ relPath, buffer }]；返回 [{ root, name, members: [{ rel, buffer }] }]
 */
function planSkillImport(entries) {
  const safe = [];
  for (const e of entries) {
    const rel = String(e.relPath || '').replaceAll('\\', '/');
    if (!rel || rel.includes('\0') || path.isAbsolute(rel)) continue;
    const segs = rel.split('/');
    if (segs.some((x) => x === '' || x === '.' || x === '..')) continue;
    safe.push({ rel, buffer: e.buffer });
  }
  const mdRoots = [];
  for (const s of safe) {
    const segs = s.rel.split('/');
    if (segs[segs.length - 1].toLowerCase() === 'skill.md') mdRoots.push(segs.slice(0, -1));
  }
  if (!mdRoots.length) throw new HttpError(400, '所选内容中未找到 SKILL.md（支持任意层级子目录）');
  // 根级 SKILL.md：整体视为单一技能
  if (mdRoots.some((segs) => segs.length === 0)) return [{ root: '', name: null, members: safe }];
  // 互为前缀的根保留最浅层（外层技能吞并内层 SKILL.md）
  const dirs = [...new Set(mdRoots.map((s) => s.join('/')))];
  const roots = dirs.filter((d) => !dirs.some((o) => o !== d && (d + '/').startsWith(o + '/')));
  return roots.map((root) => ({
    root,
    name: sanitizeSkillName(root.split('/').pop()),
    members: safe
      .filter((s) => s.rel === `${root}/SKILL.md` || s.rel.startsWith(`${root}/`))
      .map((s) => ({ buffer: s.buffer, rel: s.rel.slice(root.length + 1) })),
  }));
}

/** 把规划结果落盘：同名同批自动加序号，覆盖磁盘上的同名旧技能 */
function writePlannedSkills(userId, planned) {
  const destRoot = userSkillsDir(userId);
  fs.mkdirSync(destRoot, { recursive: true });
  const imported = [];
  const batchUsed = new Set();
  for (const sk of planned) {
    let name = sk.name
      ?? sanitizeSkillName(parseSkillMd(sk.members.find((m) => m.rel === 'SKILL.md')?.buffer?.toString('utf8') || '', 'imported-skill'));
    let n = 2;
    while (batchUsed.has(name)) name = `${sk.name || 'skill'}-${n++}`;
    batchUsed.add(name);
    const dest = path.join(destRoot, name);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });
    for (const m of sk.members) {
      if (!m.rel || m.rel.startsWith('..') || m.rel.includes('\0')) continue;
      const target = path.join(dest, m.rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, m.buffer);
    }
    imported.push(name);
  }
  return imported;
}

/** 导入用户电脑上选择的目录（浏览器 webkitdirectory 上传的全部文件，支持任意层级嵌套） */
export function importSkillFiles(userId, entries) {
  return writePlannedSkills(userId, planSkillImport(entries));
}

/**
 * 导入 skill zip：zip 内任意深度的 SKILL.md 所在目录都会被识别为一个技能。
 */
export async function importSkillZip(userId, buffer) {
  const zip = await unzipper.Open.buffer(buffer);
  const entries = [];
  for (const entry of zip.files) {
    if (entry.type !== 'File') continue;
    const norm = path.normalize(String(entry.path || '')).replace(/^[/\\]+/, '').split(path.sep).join('/');
    if (!norm || norm === '.') continue;
    entries.push({ relPath: norm, buffer: await entry.buffer() });
  }
  return writePlannedSkills(userId, planSkillImport(entries));
}

export function deleteSkill(userId, name) {
  const n = String(name || '');
  if (!n || /[/\\]/.test(n) || n.includes('..')) throw new HttpError(400, '非法技能名');
  const dir = path.join(userSkillsDir(userId), n);
  if (!fs.existsSync(dir)) throw new HttpError(404, '技能不存在');
  fs.rmSync(dir, { recursive: true, force: true });
}

/** 系统提示片段：技能清单（仅未停用的）+ 使用规范；无可用技能返回空串。
 * 注意：技能包按用户分别配置，提示词不得硬编码任何具体技能名。 */
export function skillPromptSection(userId) {
  const skills = listSkills(userId).filter((s) => s.enabled);
  if (!skills.length) return '';
  const lines = skills.map((s) => `- ${s.name}${s.description ? `：${s.description}` : ''}`);
  return [
    '## 可用技能（Skills）',
    '',
    '技能包按账号分别配置，以下清单即当前可用的全部技能。接到任务时：',
    '- 动手前先对照清单：任务（或其中某一步）与哪个技能的名称/描述明显相关时，' +
    '先调用 read_skill 读取其完整说明（SKILL.md 正文），按其中的流程、规范与产物要求执行；',
    '- 「润色 / 改写 / 翻译 / 精简 / 学术化 / 规范化表述」这类改写既有文字的任务尤其注意：' +
    '它们与清单中写作、润色、翻译、表述类技能相关的概率很高，直接凭默认风格动笔而绕过技能，' +
    '产物往往不符合既有规范——新任务先 read_skill 加载相关技能，确认清单中确无相关技能才按常规方式完成。' +
    '两个豁免：①极小改动与局部修复（改个词、修单行乱码/错字、局部替换、删一句、格式微调、' +
    '处理报错/编译问题）不属于技能任务，直接完成即可，不要为它们加载技能；' +
    '②同一会话内已加载并执行过某技能的同类跟进任务，沿用其已确立的流程与口径即可，不必重新加载' +
    '（技能说明原文不随历史回放，但上轮执行叙述仍在）——仅当任务类型或范围明显变化、' +
    '或需要具体规范细节时才重新 read_skill；',
    '- 当前轮次里已经读取过的技能不要重复读取；同一会话内已加载并执行过某技能的' +
    '同类跟进任务同样无需重新加载（沿用已确立流程）；仅当任务类型或范围明显变化、' +
    '或需要具体规范细节时才重新 read_skill；',
    '- 读取后确认与任务无关时，简要说明原因即可按正常方式继续；任务与清单均不相关时不调用 read_skill。',
    '',
    '技能清单：',
    ...lines,
  ].join('\n');
}

/** 文字改写类任务关键词（技能路由提示用）：泛写作领域词汇，不涉及任何具体技能名 */
const WRITING_TASK_RE = /润色|改写|重写|翻译|精简|扩写|学术化|学术表达|表述|措辞|文笔|polish|rewrite|translat|tighten|paraphras/i;

/** 简单机械任务信号（技能路由豁免）：修错/删改/格式/报错类动作词。
 *  这类任务与技能无关——强推 read_skill 只会把简单事情复杂化
 *  （2026-10-19 反馈：修标题行乱码的小任务被路由去加载润色技能，
 *  又级联读取共享包片段，过程被拉长数倍）。 */
const MECHANICAL_TASK_RE = /修复|修正|改回|恢复|删除|去掉|加上|添加|补上|替换|重命名|注释掉|报错|错误|失败|乱码|溢出|对不齐|缩进|换行|空格|标点|排版|编译/i;
/** 大范围改写信号：即便带机械动词，整体性任务仍应走技能对照 */
const SUBSTANTIAL_SCOPE_RE = /全文|通篇|整体|全部|重构|重排|大改|overhaul/i;

const DRAWING_SKILL_RE = /绘图|制图|图稿|统计图|示意图|数据可视化|\b(?:plotting|matplotlib|pgfplots|ggplot2|figure[- ]design|scientific[- ]figures?|data[- ]visuali[sz]ation)\b/i;
const CHINESE_CHART_RE = /图稿|图表|示意图|流程图|插图|对比图|科研图|统计图|散点图|折线图|柱状图|直方图|箱线图|热力图|误差图|曲线图|可视化|(?:性能|学习|ROC)\s*曲线/i;
const CHINESE_FIGURE_STYLE_RE = /图例|坐标轴|[xyz]\s*轴|轴标签|刻度|配色|颜色|字号|字体|线宽|线型|线条|分面|分辨率|留白|宽高比/i;
const PROSE_TARGET_RE = /正文|段落|摘要|引言|讨论|章节|图注|文稿|文笔|\b(?:manuscript|prose|paragraphs?|abstract|introduction|discussion|captions?)\b/i;

function requestsFigureWork(text) {
  // The chat route appends source excerpts and attachment lists to the request.
  // A sentence in an excerpt is data, even if it contains an imperative verb.
  const request = text.split(/\n\n\[(?:用户选中的内容|用户上传了 \d+ 个附件)|\n(?:原选区文本|片段（来自文件)/u, 1)[0];
  return request.split(/[。！？；!?,，;\r\n]+/u).some(raw => {
    const clause = raw.trim();
    if (/^(?:(?:请(?:你|先)?|帮我|麻烦你)\s*)?(?:不要|不用|无需|不必|如何|怎么|解释|审阅|核对|检查)/u.test(clause)) return false;
    if (/^(?:please\s+)?(?:do not|don't|how to|explain|review|check)\b/i.test(clause)) return false;

    const draw = /绘制|重绘|重画|画(?:一[张幅个]|出|成)|(?:重新|进行|完成)(?:科研)?(?:制图|绘图|出图)/u.test(clause)
      || /^(?:请|帮我|(?:请)?(?:用|使用|根据|基于))[^。\r\n]{0,60}(?:绘图|制图|出图)$/u.test(clause);
    const chart = CHINESE_CHART_RE.test(clause);
    const makeChart = chart && /(?:制作|生成|设计|重做|导出|做一[张幅个]|做[个张幅])/u.test(clause)
      && !/(?:图稿|图表)(?:的)?(?:说明|引用|解读|描述)$/u.test(clause);
    const numberedFigure = /图\s*[0-9０-９一二三四五六七八九十]+/u.test(clause);
    const reviseFigure = /调整|修改|更换|替换|改成|改为|换成|修正|放大|缩小|移到|移动|重排|优化|加粗|加上|调[大小高低]|再导出/u.test(clause)
      && CHINESE_FIGURE_STYLE_RE.test(clause)
      && (chart || numberedFigure || /图例|坐标轴|[xyz]\s*轴|轴标签/i.test(clause));
    const drawEnglish = /(?:^|[:：]\s*|\b(?:please|to|then)\s+)(?:plot|replot|redraw|re-?render)\s+\S/i.test(clause);
    const makeEnglishChart = /\b(?:create|draw|generate|make|produce|design|rebuild|redesign|revise|update|export)\b.{0,60}\b(?:plots?|figures?|charts?|visuali[sz]ations?)\b(?!\s*(?:\d+\s*)?(?:['’]s\s*)?(?:captions?|references?|discussion)\b)/i.test(clause);
    const reviseEnglishFigure = /\b(?:adjust|change|move|resize|restyle|recolor|revise|fix|enlarge|shrink|increase|decrease)\b/i.test(clause)
      && /\b(?:legend|(?:x|y|z)[ -]axis|axis labels?|tick labels?|plot colors?|figure fonts?|line widths?|plot margins?)\b/i.test(clause);
    return draw || makeChart || reviseFigure || numberedFigure && /导出/u.test(clause)
      || drawEnglish || makeEnglishChart || reviseEnglishFigure
      || /^(?:请|帮我|我想)?\s*(?:科研绘图|科研制图|绘图|制图|数据可视化|图稿迭代)$/u.test(clause);
  });
}

function figureWorkflowHint(skills, recent) {
  const related = skills.filter(skill => DRAWING_SKILL_RE.test(skill.name + ' ' + skill.description));
  const fresh = related.filter(skill => !recent.has(skill.name)).slice(0, 5).map(skill => skill.name);
  const loaded = related.filter(skill => recent.has(skill.name)).slice(0, 5).map(skill => skill.name);
  return [
    '【科研绘图】根据本轮图稿的目标选择必要步骤。',
    fresh.length ? '先从可用制图技能「' + fresh.join('、') + '」中选择与图种或期刊要求相关的技能，用 read_skill 载入。' : '',
    loaded.length ? '近期已载入的制图技能「' + loaded.join('、') + '」可沿用，任务或图种改变时再查。' : '',
    '- 新图先核实数据及来源、变量、单位、筛选和统计口径；必要时用 read_file 的 purpose="source" 读取本地资料。数据有缺口就说明，示意或模拟值明确标注。',
    '- 改图先找既有图源、图稿和数据，沿用原数据及计算方式，只改本轮所需内容。按用途或期刊要求选择版面尺寸和输出格式，留下可重跑的图源、相对数据路径、必要依赖、运行命令和产物位置。',
    '- 允许执行脚本且未启用确认后应用时，在 _workspace/ 生成并迭代。脚本不可用时，按目标使用可编译的 LaTeX 图源，或交付可运行的脚本并标明待生成。论文要引用时用项目编辑工具纳入审查。',
    '- 生成后用 view_image 查看实际栅格图或独立 PDF 页，检查标签、单位、字号、图例、边界和留白；纳入论文后核对编译及版面。交付时列出图稿、图源和数据位置，说明实际完成的检查。',
  ].filter(Boolean).join('\n');
}

/**
 * 技能路由提示（附加到每轮系统便签末尾，即生成前的最后一条消息）。
 *
 * 动机：技能清单位于系统提示词中部，离生成点太远——弱模型在长上下文里几乎不会
 * 主动对照清单（2026-10-12 实录：用户连续 3 轮发「学术化表达优化」类请求，模型
 * 全部直接 read_file→edit_file 改写，零 read_skill，而账号明明配有润色技能；
 * 系统提示词头部的约束会被会话自身的叙述惯性压住，末尾便签才是有效 steering 位）。
 *
 * 匹配信号（任一命中即视为该技能疑似相关）：
 *   a) 请求文本与技能名/描述的字面交集——CJK 需 ≥2 个不同 2 字片段或任一 ≥3 字
 *      连续片段（单个 2 字片段如「论文」碰撞概率过高）；拉丁词需 ≥4 字符且整词
 *      匹配（「tex」子串会撞上「latex」，而本产品请求几乎都带 .tex 文件名）；
 *   b) 请求属文字改写类任务，且技能元数据含写作/润色/翻译/表述类泛词。
 *
 * 简单机械任务豁免：短请求 + 机械动作词（修复/删除/替换/报错…）且非文字改写、
 * 非整体性工作时直接返回空串零打扰——这类任务与技能无关，强推 read_skill 只会把
 * 简单事情复杂化（2026-10-19 反馈：修标题行乱码被路由去加载润色技能并级联共享包）。
 *
 * recentSkills：本会话近期（agentLoop 取最近若干条消息）已 read_skill 加载过本体的
 * 技能名。据此区分两种变体，防止矫枉过正（2026-10-13 实录：跟进型小改写——去括号
 * 表述——每轮都重新加载路由技能并级联 manifest/核心片段，上下文成倍膨胀）：
 *   - 命中技能近期未加载 → 「先 read_skill」加载变体（附任务体量判断与豁免）；
 *   - 命中技能近期已加载 → 跟进变体：沿用已确立的流程与口径，不必重新加载，
 *     仅任务类型/范围变化才重载——与路由型技能自身 SKILL.md 的 follow-up 协议一致。
 * 均不命中且有写作任务特征 → 通用对照提醒；否则空串（非写作任务零打扰）。
 */
export function skillRouteHint(userId, requestText, recentSkills = []) {
  const skills = listSkills(userId).filter((s) => s.enabled);
  const text = String(requestText || '').trim();
  const recent = new Set(recentSkills.map(String));
  const isWritingTask = WRITING_TASK_RE.test(text);
  const figureHint = requestsFigureWork(text) ? figureWorkflowHint(skills, recent) : '';
  if (!skills.length || (figureHint && !(isWritingTask && PROSE_TARGET_RE.test(text)))) return figureHint;
  // 简单机械任务：零打扰放行，不注入任何路由提示，让模型直接动手
  // （长度上限 120：引用报错行/原句的修复类请求通常也不超过此长度）
  if (text && text.length <= 120 && !isWritingTask
    && MECHANICAL_TASK_RE.test(text) && !SUBSTANTIAL_SCOPE_RE.test(text)) return '';
  const cjkRuns = text.match(/[\u4e00-\u9fff]{2,}/g) || [];
  const latinWords = text.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) || [];
  const matched = [];
  for (const s of skills) {
    const meta = `${s.name} ${s.description}`.toLowerCase();
    if (figureHint && DRAWING_SKILL_RE.test(meta)) continue;
    let hit = false;
    const frag2 = new Set();
    for (const w of cjkRuns) {
      for (let i = 0; i + 2 <= w.length; i++) {
        const f = w.slice(i, i + 2).toLowerCase();
        if (meta.includes(f)) frag2.add(f);
      }
      for (let i = 0; i + 3 <= w.length; i++) {
        if (meta.includes(w.slice(i, i + 3).toLowerCase())) { hit = true; break; }
      }
      if (hit) break;
    }
    if (!hit && frag2.size >= 2) hit = true;
    if (!hit) {
      for (const w of latinWords) {
        if (w.length >= 4 && new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(meta)) { hit = true; break; }
      }
    }
    if (!hit && isWritingTask && /润色|写作|翻译|表述|prose|polish|writing|translat/i.test(meta)) hit = true;
    if (hit) matched.push(s);
  }
  const trivialNote = '极小改动（改个词、局部替换、删一句、格式微调）不属于技能任务，直接完成即可。';
  const fresh = matched.filter((s) => !recent.has(s.name));
  const loaded = matched.filter((s) => recent.has(s.name));
  if (matched.length) {
    const parts = figureHint ? [figureHint] : [];
    if (loaded.length) {
      const names = loaded.slice(0, 5).map((s) => s.name).join('、');
      parts.push(
        '【技能路由】本轮疑似与技能「' + names + '」相关，且该技能本会话近期已加载并执行过：' +
        '同类跟进任务沿用已确立的流程与口径即可，不必重新 read_skill（说明原文不随历史回放，' +
        '上轮执行叙述仍是基准）；仅当任务类型或范围明显变化、或需要具体规范细节时才重新加载。'
      );
    }
    if (fresh.length) {
      const names = fresh.slice(0, 5).map((s) => s.name).join('、');
      parts.push(
        '【技能路由】本轮请求疑似与技能「' + names + '」相关。先判断任务体量：' +
        '只有成段文字的润色/改写/翻译或成块内容重构才属于技能任务，动手前先 read_skill 读取其完整说明，' +
        '按其中的流程与规范执行；局部修复（修单行乱码/错字、改个别词、删一句、格式微调、处理报错）' +
        '不属于技能范畴，直接完成即可，不要为这类极小改动加载技能。' +
        '读取后确认与任务无关时，简要说明原因再按常规方式继续。'
      );
    }
    return parts.join('\n');
  }
  if (isWritingTask) {
    return (
      (figureHint ? figureHint + '\n' : '') +
      '【技能路由】本轮有文字改写类任务：动笔前对照系统提示词中的技能清单，' +
      '名称或描述与润色/写作/翻译/表述相关的技能应先 read_skill 加载后再执行' +
      '（本会话已加载过的技能按其既定流程沿用即可，不必重复加载）；' +
      '确认清单中没有相关技能，则直接按常规方式完成。' + trivialNote
    );
  }
  return figureHint;
}
