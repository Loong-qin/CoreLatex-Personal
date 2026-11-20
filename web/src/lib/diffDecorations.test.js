// @vitest-environment jsdom
// 审阅行内 diff：computeInlineDiff 在真实文档坐标上产出带装饰的修改块，
// 注入 EditorView 后 decorations facet 必须可见（渲染数据源），widget 正确插入。
import { describe, it, expect } from 'vitest';
import { EditorView, Decoration } from '@codemirror/view';
import { EditorState, Compartment } from '@codemirror/state';
import { setDiffDeco, diffDecoField, computeInlineDiff, reviewHunksFor } from './diffDecorations.js';

describe('computeInlineDiff', () => {
  it('改动行标绿、删除的旧行产出红底 widget，修改块携带两侧行内容与装饰', () => {
    const { hunks, adds, dels } = computeInlineDiff('a\nb\nc\n', 'a\nB2\nc\n');
    expect(adds).toBe(1);
    expect(dels).toBe(1);
    expect(hunks.length).toBe(1);
    expect(hunks[0]).toMatchObject({ from: 2, to: 4, oldLines: ['b'], newLines: ['B2'], adds: 1, dels: 1 });
    const points = [];
    hunks[0].ranges.forEach((r) => {
      const { from, to, value } = r;
      points.push({ from, to, cls: value.spec.class || (value.spec.widget && 'widget') });
    });
    // 同一位置上的 widget 与行装饰先后顺序不敏感；行装饰是零长度（行首位置，作用整行）
    // 整行被改写不属于「细微改动」：不做字词级标注
    const byCls = Object.fromEntries(points.map((p) => [p.cls, p]));
    expect(points.length).toBe(2);
    expect(byCls['widget']).toMatchObject({ from: 2, to: 2 });
    expect(byCls['cm-diff-add']).toMatchObject({ from: 2, to: 2 });
    expect(byCls['cm-diff-add-mark']).toBeUndefined();
  });

  it('细微改动（少量字符变化）才输出字词级标注', () => {
    const { hunks } = computeInlineDiff(
      'a\nThe cat sat on the mat.\nc\n',
      'a\nThe cat sat on the mat today.\nc\n'
    );
    expect(hunks.length).toBe(1);
    const marks = hunks[0].ranges.filter((r) => r.value.spec.class === 'cm-diff-add-mark');
    expect(marks.length).toBeGreaterThanOrEqual(1);
    // 标注覆盖新增的「today」
    const line2From = 2; // 'a\n' 之后
    expect(marks.some((m) => m.from >= line2From && m.to > m.from)).toBe(true);
  });

  it('无差异 → 无修改块', () => {
    const { hunks } = computeInlineDiff('same\n', 'same\n');
    expect(hunks).toEqual([]);
  });

  it('相邻修改之间的未变行不标绿，并保留独立修改块', () => {
    const { hunks, adds, dels } = computeInlineDiff('a\nMID\nc\nz\n', 'a\nm\nc\nzz\n');
    expect(hunks).toHaveLength(2);
    expect(adds).toBe(2);
    expect(dels).toBe(2);
    const green = hunks.flatMap((h) => h.ranges).filter((r) => r.value.spec.class === 'cm-diff-add');
    expect(green.map((r) => r.from)).toEqual([2, 6]);
    expect(green.some((r) => r.from === 4)).toBe(false); // unchanged c line
  });

  it('注入 EditorView 后 decorations facet 可见（渲染数据源）', () => {
    const conf = new Compartment();
    const { hunks } = computeInlineDiff('old\n', 'old\nadded\n');
    const decorations = Decoration.set(hunks.flatMap((h) => h.ranges), true);
    const view = new EditorView({
      state: EditorState.create({ doc: 'old\nadded\n', extensions: [conf.of([])] }),
      parent: document.body,
    });
    view.dispatch({
      effects: [conf.reconfigure([diffDecoField]), setDiffDeco.of(decorations)],
    });
    expect(view.state.field(diffDecoField).size).toBe(decorations.size);
    const all = view.state.facet(EditorView.decorations);
    expect(all.some((d) => d && typeof d.size === 'number' && d.size >= decorations.size)).toBe(true);
    expect(hunks.length).toBe(1);
  });

  // 保存此处的基线拼接：base[0..baseFrom) + doc[docFrom..docTo] + base[baseTo..] 必须还原文档，
  // baseTo/docTo 任一为 0 都会导致基线整体错位（前文全部标红）；结尾换行与文档对齐，
  // 否则末行残留无法消除的幽灵改块
  const saveSplice = (base, doc, h) => {
    let next = [...base.split('\n').slice(0, h.baseFrom - 1),
     ...doc.split('\n').slice(h.docFrom - 1, h.docTo),
     ...base.split('\n').slice(h.baseTo)].join('\n');
    if (doc.endsWith('\n')) {
      if (next !== '' && !next.endsWith('\n')) next += '\n';
    } else if (next.endsWith('\n')) next = next.slice(0, -1);
    return next;
  };

  it('改写块：baseTo/docTo 为闭区间末行，保存此处拼接后与文档一致', () => {
    const base = 'l1\nl2\nl3\nl4\nl5';
    const doc = 'l1\nL2-new\nL2b\nl3\nl4\nl5';
    const { hunks } = computeInlineDiff(base, doc);
    expect(hunks.length).toBe(1);
    expect(hunks[0]).toMatchObject({ baseFrom: 2, baseTo: 2, docFrom: 2, docTo: 3 });
    expect(saveSplice(base, doc, hunks[0])).toBe(doc);
  });

  it('多个修改块各自携带正确的区间坐标', () => {
    const base = 'a\nb\nc\nd\ne\nf';
    const doc = 'a\nB\nc\nd\nE2\nE3\nf';
    const { hunks } = computeInlineDiff(base, doc, { mergeGap: 0 });
    expect(hunks.length).toBe(2);
    expect(hunks[0]).toMatchObject({ baseFrom: 2, baseTo: 2, docFrom: 2, docTo: 2 });
    expect(hunks[1]).toMatchObject({ baseFrom: 5, baseTo: 5, docFrom: 5, docTo: 6 });
    // 只保存第一块：基线仅前进第一处修改，第二块仍是待处理差异
    expect(saveSplice(base, doc, hunks[0])).toBe('a\nB\nc\nd\ne\nf');
  });

  it('纯新增块：baseTo = baseFrom - 1，拼接后新行落在正确位置', () => {
    const base = 'a\nb';
    const doc = 'a\nX\nY\nb';
    const { hunks } = computeInlineDiff(base, doc);
    expect(hunks.length).toBe(1);
    expect(hunks[0]).toMatchObject({ baseFrom: 2, baseTo: 1, docFrom: 2, docTo: 3, dels: 0, adds: 2 });
    expect(saveSplice(base, doc, hunks[0])).toBe(doc);
  });

  it('纯删除块：docTo = docFrom - 1，拼接后旧行被移除', () => {
    const base = 'a\nX\nY\nb';
    const doc = 'a\nb';
    const { hunks } = computeInlineDiff(base, doc);
    expect(hunks.length).toBe(1);
    expect(hunks[0]).toMatchObject({ baseFrom: 2, baseTo: 3, docFrom: 2, docTo: 1, dels: 2, adds: 0 });
    expect(saveSplice(base, doc, hunks[0])).toBe(doc);
  });

  it('从空基线新建文件（有无结尾换行两种约定），保存后基线与文档一致', () => {
    for (const doc of ['line1\nline2', 'line1\nline2\n']) {
      const base = '';
      const { hunks } = computeInlineDiff(base, doc);
      expect(hunks.length).toBe(1);
      expect(hunks[0]).toMatchObject({ baseFrom: 1, baseTo: 0, docFrom: 1, docTo: 2 });
      expect(saveSplice(base, doc, hunks[0])).toBe(doc);
    }
  });

  it('基线与文档结尾换行约定不一致时，保存后仍能对齐消除全部差异', () => {
    const base = 'a\nb'; // 无结尾换行
    const doc = 'a\nB\n'; // 有结尾换行
    const { hunks } = computeInlineDiff(base, doc);
    expect(hunks.length).toBe(1);
    expect(saveSplice(base, doc, hunks[0])).toBe(doc);
  });

  it('保留一处修改后，附近另一处 AI 修改仍待审', () => {
    const base = 'A\nX\nB\nY\nC';
    const doc = "A\nX'\nB\nY'\nC";
    const hunks = reviewHunksFor(base, doc);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]).toMatchObject({ baseFrom: 2, baseTo: 2, docFrom: 2, docTo: 2, oldAll: 'X' });
    const remaining = reviewHunksFor(saveSplice(base, doc, hunks[0]), doc);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({ baseFrom: 4, baseTo: 4, docFrom: 4, docTo: 4, oldAll: 'Y' });
  });

  it('服务端投影已包含人工标题和 label 时，审阅仅标记 AI 正文', () => {
    const base = '\\title{Control}\n\\label{new}\nbody old\n';
    const current = '\\title{Control}\n\\label{new}\nbody AI\n';
    const hunks = reviewHunksFor(base, current);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toMatchObject({ docFrom: 3, docTo: 3, oldLines: ['body old'], newLines: ['body AI'] });
  });
});
