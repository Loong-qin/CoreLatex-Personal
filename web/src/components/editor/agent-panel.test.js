import { describe, it, expect } from 'vitest';
import {
  truncateContext,
  truncateText,
  parseToolCalls,
  toolPhrase,
  mcpToolParts,
  toolSummary,
  formatToolInput,
  toolResultKind,
  formatDuration,
  parseTs,
  durationBetween,
  buildTimeline,
  buildSelectionQuote,
  annotateMessageWithSelection,
  mentionsSelectionHint,
  selectionPayload,
  SELECTION_TEXT_MAX,
  toolIcon,
} from '../../lib/agentUtils.js';

describe('truncateContext', () => {
  it('短文本原样返回', () => {
    expect(truncateContext('abc', 10)).toBe('abc');
    expect(truncateContext('abc')).toBe('abc');
  });

  it('超长文本截到 max 并追加截断标记', () => {
    const r = truncateContext('x'.repeat(20000), 12000);
    expect(r.startsWith('x'.repeat(12000))).toBe(true);
    expect(r).toContain('已截断');
    expect(r.length).toBeLessThan(20000);
  });

  it('空值兜底为空字符串', () => {
    expect(truncateContext(null)).toBe('');
    expect(truncateContext(undefined)).toBe('');
  });
});

describe('truncateText', () => {
  it('未超长原样返回', () => {
    expect(truncateText('abc', 10)).toBe('abc');
    expect(truncateText('', 10)).toBe('');
    expect(truncateText(null)).toBe('');
    expect(truncateText(undefined)).toBe('');
  });

  it('超长时截断并标注原长度', () => {
    const r = truncateText('x'.repeat(20), 5);
    expect(r.startsWith('xxxxx')).toBe(true);
    expect(r).toContain('已截断');
    expect(r).toContain('20');
  });

  it('max 非正数视为不截断', () => {
    expect(truncateText('x'.repeat(20), 0)).toBe('x'.repeat(20));
  });
});

describe('parseToolCalls', () => {
  it('JSON 字符串解析为数组', () => {
    expect(parseToolCalls('[{"name":"write_file","detail":"main.tex"}]')).toEqual([
      { name: 'write_file', detail: 'main.tex' },
    ]);
  });

  it('数组原样返回', () => {
    const arr = [{ name: 'a' }, { name: 'b' }];
    expect(parseToolCalls(arr)).toEqual(arr);
  });

  it('单个对象（或对象 JSON 字符串）包装成数组', () => {
    expect(parseToolCalls('{"name":"x"}')).toEqual([{ name: 'x' }]);
    expect(parseToolCalls({ name: 'y' })).toEqual([{ name: 'y' }]);
  });

  it('非法输入返回空数组', () => {
    expect(parseToolCalls('not json')).toEqual([]);
    expect(parseToolCalls('123')).toEqual([]);
    expect(parseToolCalls(null)).toEqual([]);
    expect(parseToolCalls(undefined)).toEqual([]);
    expect(parseToolCalls('')).toEqual([]);
  });
});

describe('toolPhrase', () => {
  it('内置工具映射为过去式短语', () => {
    expect(toolPhrase('list_files')).toBe('已列出文件');
    expect(toolPhrase('read_file')).toBe('已读取文件');
    expect(toolPhrase('read_workspace')).toBe('已查看工作区');
    expect(toolPhrase('write_file')).toBe('已写入文件');
    expect(toolPhrase('edit_file')).toBe('已修改文件');
    expect(toolPhrase('copy_to_project')).toBe('已复制到项目');
    expect(toolPhrase('run_in_workspace')).toBe('已运行命令');
    expect(toolPhrase('get_document_context')).toBe('已获取文档上下文');
    expect(toolPhrase('read_skill')).toBe('已读取技能');
  });

  it('MCP 工具显示中文名称并保留完整标识', () => {
    expect(toolPhrase('mcp__github__create_issue')).toBe('已调用外部工具（mcp__github__create_issue）');
    expect(toolPhrase('mcp__a__b__c')).toBe('已调用外部工具（mcp__a__b__c）');
  });

  it('未知工具保留原名，空名兜底', () => {
    expect(toolPhrase('some_tool')).toBe('已调用其他工具（some_tool）');
    expect(toolPhrase('')).toBe('已调用工具');
    expect(toolPhrase(null)).toBe('已调用工具');
  });
});

describe('toolIcon', () => {
  it('按工具类型给出图标名', () => {
    expect(toolIcon('read_file')).toBe('Document');
    expect(toolIcon('edit_file')).toBe('EditPen');
    expect(toolIcon('run_in_workspace')).toBe('Monitor');
    expect(toolIcon('write_file')).toBe('DocumentAdd');
  });
  it('MCP 工具用外部工具图标，未知工具兜底', () => {
    expect(toolIcon('mcp__github__create_issue')).toBe('MagicStick');
    expect(toolIcon('some_tool')).toBe('Operation');
    expect(toolIcon('')).toBe('Operation');
  });
});

describe('mcpToolParts', () => {  it('拆出 server 与 tool', () => {
    expect(mcpToolParts('mcp__github__create_issue')).toEqual({ server: 'github', tool: 'create_issue' });
    expect(mcpToolParts('mcp__a__b__c')).toEqual({ server: 'a__b', tool: 'c' });
  });

  it('非 MCP 名返回 null', () => {
    expect(mcpToolParts('read_file')).toBeNull();
    expect(mcpToolParts('')).toBeNull();
    expect(mcpToolParts(null)).toBeNull();
  });
});

describe('toolSummary', () => {
  it('按字段优先级挑最信息量的参数', () => {
    expect(toolSummary('read_file', { path: 'chapters/intro.tex', content: 'x'.repeat(200) })).toBe(
      'chapters/intro.tex'
    );
    expect(toolSummary('edit_file', { path: 'main.tex', search: 'a', replace: 'b' })).toBe('main.tex');
    expect(toolSummary('read_skill', { name: 'latex-style' })).toBe('latex-style');
  });

  it('复制到项目显示 来源 → 目标', () => {
    expect(toolSummary('copy_to_project', { workspacePath: 'tmp/a.bin', targetPath: 'figures/a.bin' })).toBe(
      'tmp/a.bin → figures/a.bin'
    );
  });

  it('命令里的换行折叠成空格', () => {
    expect(toolSummary('run_in_workspace', { command: 'pdflatex -halt-on-error\n   main.tex' })).toBe(
      'pdflatex -halt-on-error main.tex'
    );
  });

  it('超长摘要截断', () => {
    const r = toolSummary('read_file', { path: 'x'.repeat(80) });
    expect(r.startsWith('x'.repeat(60))).toBe(true);
    expect(r).toContain('已截断');
  });

  it('无可用字段返回空串', () => {
    expect(toolSummary('list_files', {})).toBe('');
    expect(toolSummary('list_files', null)).toBe('');
    expect(toolSummary('list_files', undefined)).toBe('');
    expect(toolSummary('unknown', { content: 'x', search: 'y' })).toBe('');
    expect(toolSummary('list_files', 'not-an-object')).toBe('');
  });
});

describe('formatToolInput', () => {
  it('对象格式化为缩进 JSON', () => {
    expect(formatToolInput({ path: 'a.tex' })).toBe('{\n  "path": "a.tex"\n}');
    expect(formatToolInput({ a: 1 })).toContain('"a": 1');
  });

  it('空值/空对象返回空串', () => {
    expect(formatToolInput({})).toBe('');
    expect(formatToolInput(null)).toBe('');
    expect(formatToolInput(undefined)).toBe('');
  });

  it('字符串入参去掉首尾空白', () => {
    expect(formatToolInput('  hello  ')).toBe('hello');
    expect(formatToolInput('')).toBe('');
  });
});

describe('toolResultKind', () => {
  it('{error:…} 判为失败', () => {
    expect(toolResultKind('{"error":"文件不存在：main.tex"}')).toBe('error');
    expect(toolResultKind({ error: 'x' })).toBe('error');
  });

  it('截断导致 JSON 不完整时仍按 "error" 字段判失败', () => {
    expect(toolResultKind('{"error":"在 main.tex 中未找到 search 文本。文件开头片段供参考：\\begi')).toBe('error');
  });

  it('非零 exitCode 判为失败', () => {
    expect(toolResultKind('{"stdout":"","stderr":"boom","exitCode":1}')).toBe('error');
    expect(toolResultKind('{"stdout":"","stderr":"","exitCode":124}')).toBe('error');
  });

  it('正常文本与 exitCode=0 判为成功', () => {
    expect(toolResultKind('已暂存对 main.tex 的修改')).toBe('ok');
    expect(toolResultKind('{"stdout":"ok","stderr":"","exitCode":0}')).toBe('ok');
    expect(toolResultKind('main.tex\nrefs.bib')).toBe('ok');
  });

  it('空结果判为成功（工具尚未返回时不算失败）', () => {
    expect(toolResultKind('')).toBe('ok');
    expect(toolResultKind(null)).toBe('ok');
    expect(toolResultKind(undefined)).toBe('ok');
  });
});

describe('formatDuration', () => {
  it('秒 / 分 / 小时分级展示', () => {
    expect(formatDuration(12_000)).toBe('12 秒');
    expect(formatDuration(216_000)).toBe('3 分 36 秒');
    expect(formatDuration(60_000)).toBe('1 分');
    expect(formatDuration(3_600_000)).toBe('1 小时');
    expect(formatDuration(7_500_000)).toBe('2 小时 5 分');
  });

  it('不足一秒与无效输入', () => {
    expect(formatDuration(0)).toBe('不到 1 秒');
    expect(formatDuration(400)).toBe('不到 1 秒');
    expect(formatDuration(-1)).toBe('');
    expect(formatDuration(null)).toBe('');
    expect(formatDuration(undefined)).toBe('');
    expect(formatDuration('abc')).toBe('');
  });
});

describe('parseTs / durationBetween', () => {
  it('SQLite 时间戳按 UTC 解析，ISO 原样解析', () => {
    const utc = Date.UTC(2026, 8, 23, 10, 0, 0);
    expect(parseTs('2026-09-23 10:00:00')).toBe(utc);
    expect(parseTs('2026-09-23T10:00:00.000Z')).toBe(utc);
  });

  it('无法解析返回 null', () => {
    expect(parseTs('')).toBeNull();
    expect(parseTs(null)).toBeNull();
    expect(parseTs('不是时间')).toBeNull();
  });

  it('两时间戳之差（可混用两种格式），倒挂归零', () => {
    expect(durationBetween('2026-09-23 10:00:00', '2026-09-23 10:03:36')).toBe(216_000);
    expect(durationBetween('2026-09-23T10:00:00.000Z', '2026-09-23 10:00:02')).toBe(2000);
    expect(durationBetween('2026-09-23 10:00:05', '2026-09-23 10:00:00')).toBe(0);
  });

  it('任一无效返回 null', () => {
    expect(durationBetween(null, '2026-09-23 10:00:00')).toBeNull();
    expect(durationBetween('2026-09-23 10:00:00', undefined)).toBeNull();
  });
});

describe('选中内容附加到消息', () => {
  const sel = { file: 'sections/method.tex', startLine: 12, endLine: 15, text: 'alpha\n\nbeta' };

  it('引用只占一行：文件 + 行号，不含原文', () => {
    const q = buildSelectionQuote(sel);
    expect(q).toBe('> 📎 **选中内容** · sections/method.tex（第 12–15 行）');
    expect(q).not.toContain('alpha');
  });

  it('单行选中显示「第 N 行」', () => {
    expect(buildSelectionQuote({ ...sel, endLine: 12 })).toContain('（第 12 行）');
  });

  it('无有效选中返回空，消息原样', () => {
    expect(buildSelectionQuote(null)).toBe('');
    expect(buildSelectionQuote({ text: '   ' })).toBe('');
    expect(annotateMessageWithSelection('优化一下', null)).toBe('优化一下');
  });

  it('组合消息 = 一行引用 + 空行 + 原始输入（原文不进消息）', () => {
    const msg = annotateMessageWithSelection('优化一下这段', sel);
    expect(msg).toBe('> 📎 **选中内容** · sections/method.tex（第 12–15 行）\n\n优化一下这段');
  });

  it('selectionPayload 携带原文与位置，超长截断', () => {
    const p = selectionPayload(sel);
    expect(p).toMatchObject({ file: 'sections/method.tex', startLine: 12, endLine: 15 });
    expect(p.text).toBe('alpha\n\nbeta');
    const long = selectionPayload({ ...sel, text: 'x'.repeat(30000) });
    expect(long.text.length).toBeLessThanOrEqual(SELECTION_TEXT_MAX);
    expect(selectionPayload(null)).toBeNull();
    expect(selectionPayload({ text: '  ' })).toBeNull();
  });

  it('mentionsSelectionHint：识别指向某段内容的措辞', () => {
    expect(mentionsSelectionHint('对选中内容进行精简优化')).toBe(true);
    expect(mentionsSelectionHint('把这段改写成英文')).toBe(true);
    expect(mentionsSelectionHint('该段落的引用格式')).toBe(true);
    expect(mentionsSelectionHint('帮我编译一下项目')).toBe(false);
    expect(mentionsSelectionHint('')).toBe(false);
  });
});

describe('buildTimeline', () => {
  const toolStep = { type: 'tool', name: 'read_file', input: { path: 'main.tex' }, result: 'body', ms: 240 };

  it('叙述与工具按顺序交错，末尾叙述即最终回答', () => {
    const { rows, answer } = buildTimeline({
      steps: [{ type: 'text', text: '先看现状。' }, toolStep, { type: 'text', text: '改好了。' }],
      content: '先看现状。改好了。',
    });
    expect(answer).toBe('改好了。');
    expect(rows.map((r) => r.kind)).toEqual(['text', 'tool']);
    expect(rows[0].text).toBe('先看现状。');
    expect(rows[1].label).toBe('已读取文件');
    expect(rows[1].summary).toBe('main.tex');
    expect(rows[1].state).toBe('ok');
    expect(rows[1].ms).toBe(240);
  });

  it('末尾是工具（中断 / 轮次用尽）：正文保留原位置，不重复聚合 content', () => {
    const { rows, answer } = buildTimeline({
      steps: [
        { type: 'text', text: '先看现状。' }, toolStep,
        { type: 'text', text: '脚本写好了，跑一下。' },
        { type: 'tool', name: 'run_in_workspace', input: { command: 'python3 plot.py' }, result: 'ok', ms: 900 },
      ],
      content: '先看现状。脚本写好了，跑一下。',
    });
    expect(answer).toBe('');
    expect(rows.map((r) => r.kind)).toEqual(['text', 'tool', 'text', 'tool']);
    expect(rows[0].text).toBe('先看现状。');
    expect(rows[2].text).toBe('脚本写好了，跑一下。');
    expect(rows[3].label).toBe('已运行命令');
  });

  it('交互进行中（无 content）：叙述留在时间线里，正文先空着', () => {
    const { rows, answer } = buildTimeline({ steps: [{ type: 'text', text: '先看现状。' }, toolStep] });
    expect(answer).toBe('');
    expect(rows.map((r) => r.kind)).toEqual(['text', 'tool']);
  });

  it('空白叙述步骤丢弃，实时工具行带状态', () => {
    const { rows, answer } = buildTimeline({
      steps: [
        { type: 'text', text: '   ' },
        { type: 'tool', name: 'write_file', status: 'start' },
        { type: 'tool', name: 'edit_file', status: 'end', detail: '{"error":"未找到 search 文本"}' },
        { type: 'text', text: '好' },
      ],
    });
    expect(answer).toBe('好');
    expect(rows.map((r) => r.label)).toEqual(['正在写入文件', '修改文件失败']);
    expect(rows[0].state).toBe('running');
    expect(rows[1].state).toBe('error');
  });

  it('实时工具行用服务端摘要（运行中也能看到在动哪个文件/命令）', () => {
    const { rows } = buildTimeline({
      steps: [
        { type: 'tool', name: 'read_file', status: 'start', summary: 'refs.bib', input: { path: 'refs.bib' } },
        { type: 'tool', name: 'run_in_workspace', status: 'start', summary: 'python3 fig/plot.py' },
      ],
    });
    expect(rows[0].summary).toBe('refs.bib');
    expect(rows[0].inputText).toContain('refs.bib');
    expect(rows[1].summary).toBe('python3 fig/plot.py');
    expect(rows[1].state).toBe('running');
  });

  it('MCP 工具行显示「server · tool」，无参数摘要', () => {
    const { rows } = buildTimeline({
      steps: [
        { type: 'tool', name: 'mcp__github__create_issue', input: { title: 'x' }, result: 'ok' },
        { type: 'text', text: '好了' },
      ],
    });
    expect(rows[0].label).toBe(`已调用外部工具（${rows[0].name}）`);
    expect(rows[0].summary).toBe('github · create_issue');
    expect(rows[0].mcp).toBe(true);
  });

  it('老消息（只有 toolCalls）降级为工具步骤行 + 正文', () => {
    const { rows, answer } = buildTimeline({
      toolCalls: [{ name: 'edit_file', input: { path: 'main.tex' }, result: 'ok' }],
      content: '改好了',
    });
    expect(answer).toBe('改好了');
    expect(rows.map((r) => r.label)).toEqual(['编辑结果待核对']);
  });

  it('无步骤时正文原样返回', () => {
    expect(buildTimeline({ content: '只有一段话' })).toEqual({ rows: [], answer: '只有一段话' });
    expect(buildTimeline({})).toEqual({ rows: [], answer: '' });
  });

  it('超长结果只给预览，可整段查看', () => {
    const long = 'x'.repeat(2000);
    const { rows } = buildTimeline({
      steps: [{ type: 'tool', name: 'run_in_workspace', input: { command: 'ls' }, result: long }, { type: 'text', text: '好' }],
    });
    expect(rows[0].longResult).toBe(true);
    expect(rows[0].preview.length).toBeLessThan(long.length);
    expect(rows[0].resultText).toBe(long);
    expect(rows[0].inputText).toContain('"command": "ls"');
    expect(rows[0].hasBody).toBe(true);
  });
});
