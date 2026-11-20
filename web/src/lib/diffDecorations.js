// 变更集审阅的 CodeMirror 行内 diff：在真实文档上叠加装饰——
// 新增/改动行绿底，被删除的旧内容以红底组件行插在原位。
// 文档本身不变，因此不存在被事务过滤器拦截的问题，协同也可保持绑定。
import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import { StateEffect, StateField } from '@codemirror/state';
import { diffLines, diffWords } from 'diff';

// 审阅 diff 结果缓存：基线/文档未变化时不重复计算（行级 diff 在大文档上可能阻塞主线程，
// 跳转/保存等高频操作必须瞬时响应）
let reviewCache = { base: null, doc: null, hunks: [] };

/** 基线 vs 文档 的行内修改块（带缓存）。ChangesetBar 的数量统计与 CodeEditor 的装饰共用 */
export function reviewHunksFor(base, docText) {
  if (reviewCache.base === base && reviewCache.doc === docText) return reviewCache.hunks;
  const { hunks } = computeInlineDiff(base, docText, { realSide: 'new', mergeGap: 0 });
  reviewCache = { base, doc: docText, hunks };
  return hunks;
}

/** 载入/清除 diff 装饰的 effect（值为 Decoration.set，坐标即真实文档坐标） */
export const setDiffDeco = StateEffect.define();

// 编译诊断（错误/警告）装饰：随编译结果整批替换
export const setDiagDeco = StateEffect.define();

export const diagDecoField = StateField.define({
  create: () => Decoration.none,
  update(value, tr) {
    value = value.map(tr.changes);
    for (const e of tr.effects) if (e.is(setDiagDeco)) value = e.value;
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// 搜索命中高亮装饰：随搜索面板结果整批替换
export const setSearchHl = StateEffect.define();

export const searchHlField = StateField.define({
  create: () => Decoration.none,
  update(value, tr) {
    value = value.map(tr.changes);
    for (const e of tr.effects) if (e.is(setSearchHl)) value = e.value;
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** 搜索命中 → 装饰：items 为 [{ line(0基), col, len }]，len=0 时只标行不标词 */
export function buildSearchHlDeco(items, doc) {
  const ranges = [];
  for (const it of items || []) {
    const lineNo = Math.min(Math.max(1, (Number(it.line) || 0) + 1), doc.lines);
    const ln = doc.line(lineNo);
    const from = ln.from + Math.min(Number(it.col) || 0, ln.length);
    const len = Number(it.len) || 0;
    const to = Math.min(ln.to, from + len);
    if (to > from) ranges.push(Decoration.mark({ class: 'cm-search-hl' }).range(from, to));
  }
  return ranges.length ? Decoration.set(ranges, true) : Decoration.none;
}

/** 编译诊断 → 装饰：错误/警告行整行淡底 + 文字波浪下划线 */
export function buildDiagDeco(errors, warnings, doc) {
  const ranges = [];
  const push = (list, kind) => {
    for (const it of list || []) {
      const lineNo = Number(it.line);
      if (!lineNo || lineNo < 1 || lineNo > doc.lines) continue;
      const ln = doc.line(lineNo);
      ranges.push(Decoration.line({ class: `cm-diag-${kind}-line` }).range(ln.from));
      if (ln.to > ln.from) {
        ranges.push(Decoration.mark({ class: `cm-diag-${kind}-mark` }).range(ln.from, ln.to));
      }
    }
  };
  push(errors, 'error');
  push(warnings, 'warning');
  return ranges.length ? Decoration.set(ranges, true) : Decoration.none;
}

export const diffDecoField = StateField.define({
  create: () => Decoration.none,
  update(value, tr) {
    value = value.map(tr.changes);
    for (const e of tr.effects) if (e.is(setDiffDeco)) value = e.value;
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** 非真实侧的内容块：del=红底旧行（删除线），add=绿底预览插入行。
 * marks 是每行的字词级变动字符段 [start,end]（closeHunk 配对后回填），渲染时加深标注 */
class DiffGhostWidget extends WidgetType {
  constructor(lines, tone) {
    super();
    this.lines = lines;
    this.tone = tone; // 'del' | 'add'
    this.marks = [];
  }
  eq(other) {
    return other instanceof DiffGhostWidget && other.tone === this.tone && other.lines.join('\n') === this.lines.join('\n')
      && JSON.stringify(other.marks) === JSON.stringify(this.marks);
  }
  toDOM() {
    const wrap = document.createElement('div');
    wrap.className = `cm-diff-${this.tone}-widget`;
    this.lines.forEach((line, i) => {
      const row = document.createElement('div');
      row.className = `cm-diff-${this.tone}`;
      let off = 0;
      for (const [a, b] of this.marks[i] || []) {
        if (a > off) row.appendChild(document.createTextNode(line.slice(off, a)));
        const mark = document.createElement('span');
        mark.className = `cm-diff-${this.tone}-mark`;
        mark.textContent = line.slice(a, b);
        row.appendChild(mark);
        off = b;
      }
      if (off < line.length) row.appendChild(document.createTextNode(line.slice(off)));
      if (!row.childNodes.length) row.textContent = ' ';
      wrap.appendChild(row);
    });
    return wrap;
  }
  ignoreEvent() {
    return true;
  }
}

// 碎片合并：被 ≤ gap 字符的相同内容隔开的变化段并成一段，避免标注碎成小方块
function mergeMarks(marks, gap = 4) {
  const merged = [];
  for (const [a, b] of marks) {
    const last = merged[merged.length - 1];
    if (last && a - last[1] <= gap) last[1] = b;
    else merged.push([a, b]);
  }
  return merged;
}

/** 字词级差异：一行旧文本 vs 一行新文本，返回各自发生变动的片段 [start,end]。
 * - 词级比对（而不是字符级），变动段对齐到词边界，不会在单词内部切碎；
 * - 高度重写的行（相似度 < 50%）不做字词标注：整行红绿已足够，
 *   碎块铺满只会更难读。 */
function charMarks(oldText, newText) {
  const oldMarks = [];
  const newMarks = [];
  let a = 0;
  let b = 0;
  let same = 0;
  for (const part of diffWords(oldText, newText)) {
    if (part.added) {
      newMarks.push([b, b + part.value.length]);
      b += part.value.length;
    } else if (part.removed) {
      oldMarks.push([a, a + part.value.length]);
      a += part.value.length;
    } else {
      a += part.value.length;
      b += part.value.length;
      same += part.value.length;
    }
  }
  const similarity = same / Math.max(oldText.length, newText.length, 1);
  // 仅保留「细微」改动的标注：行内变化字符超过 35% 即视为整行改写，整行红绿已足够
  if (1 - similarity > 0.35) return { oldMarks: [], newMarks: [] };
  return { oldMarks: mergeMarks(oldMarks), newMarks: mergeMarks(newMarks) };
}

function splitLines(value) {
  const lines = value.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * computeInlineDiff(before, after, { realSide, mergeGap })
 * → { hunks, adds, dels }
 * realSide: 'new'（默认，文档=after，删除行显示为组件）| 'old'（文档=before，新增行显示为组件）
 * mergeGap: 可选视觉分组间距；审阅固定为 0，未修改的上下文行不能算作 AI 改动。
 * hunks: [{ from, to, oldLines, newLines, adds, dels, signature, ranges }]
 *   - 坐标为真实文档位置；ranges 是该块自己的装饰（供逐条确认后按块剔除）
 */
export function computeInlineDiff(before, after, { realSide = 'new', mergeGap = 0 } = {}) {
  const events = [...diffLines(String(before ?? ''), String(after ?? ''))].map((p) => ({
    kind: p.added ? 'add' : p.removed ? 'del' : 'same',
    lines: splitLines(p.value),
  }));

  // 容差合并：夹在增删事件之间的少量相同行随所在侧标记，改写段落不再"半绿半灰"
  const merged = [];
  let i = 0;
  while (i < events.length) {
    const ev = events[i];
    if (ev.kind !== 'same') {
      merged.push(ev);
      i++;
      continue;
    }
    let j = i;
    let count = 0;
    while (j < events.length && events[j].kind === 'same') {
      count += events[j].lines.length;
      j++;
    }
    const prevChange = merged.length > 0 && merged[merged.length - 1].kind !== 'same';
    const nextChange = j < events.length;
    if (prevChange && nextChange && count <= mergeGap) {
      const kind = realSide === 'new' ? 'add' : 'del';
      // same 标记：该行两侧行号都必须前进（内容没变，只是视觉上并入改写区域）
      for (; i < j; i++) merged.push({ kind, lines: events[i].lines, same: true });
    } else {
      for (; i < j; i++) merged.push(events[i]);
    }
  }

  // 走一遍构造修改块（pos 始终是真实文档游标）
  const hunks = [];
  let pos = 0;
  let baseNo = 0; // 基线（before）行游标
  let docNo = 0;  // 文档（after/当前）行游标
  let adds = 0;
  let dels = 0;
  let hunkFrom = null;
  let baseFrom = 0;
  let baseTo = 0;
  let docFrom = 0;
  let docTo = 0;
  let oldLines = null;
  let newLines = null;
  let oldAllLines = null; // 旧侧全量行（含吸收的相同行），供「撤销此修改」整块还原
  let hunkDecos = null;
  // 字词级标注辅助状态：每行是否为吸收的相同行、真实侧行与幽灵组件的行索引引用
  let oldSame = null;
  let newSame = null;
  let realLineRefs = null;
  let ghostRefs = null;
  const closeHunk = () => {
    if (hunkFrom == null) return;
    const to = newLines.length ? pos - 1 : pos; // 有实际新增行时，范围不含结尾换行
    // 字词级标注只服务「细微改动」：整块改动行数多（大段改写）时整行红绿已足够，
    // 再铺字词标注只会碎片化；短小的修改块才逐行配对标注
    const fine = adds + dels <= 6;
    const oldLineMarks = oldLines.map(() => []);
    const newLineMarks = newLines.map(() => []);
    if (fine) {
      const oldReal = oldLines.map((line, i) => ({ line, i })).filter((_, i) => !oldSame[i]);
      const newReal = newLines.map((line, i) => ({ line, i })).filter((_, i) => !newSame[i]);
      const pairCount = Math.min(oldReal.length, newReal.length);
      for (let k = 0; k < pairCount; k++) {
        const o = oldReal[k];
        const n = newReal[k];
        if (o.line === n.line) continue;
        const { oldMarks, newMarks } = charMarks(o.line, n.line);
        oldLineMarks[o.i] = oldMarks;
        newLineMarks[n.i] = newMarks;
      }
    }
    for (const g of ghostRefs) {
      const marks = g.side === 'del' ? oldLineMarks : newLineMarks;
      g.widget.marks = marks.slice(g.start, g.start + g.count);
    }
    for (const r of realLineRefs) {
      const marks = r.side === 'add' ? newLineMarks : oldLineMarks;
      for (const [a, b] of marks[r.idx] || []) {
        if (b > a) {
          hunkDecos.push(Decoration.mark({ class: `cm-diff-${r.side}-mark` }).range(r.start + a, r.start + b));
        }
      }
    }
    hunks.push({
      from: hunkFrom,
      to,
      baseFrom,
      baseTo: baseNo, // 1 基闭区间末行（含）；保存此处按 [baseFrom, baseTo] 拼接基线
      docFrom,
      docTo: docNo, // 1 基闭区间末行（含）；保存此处按 [docFrom, docTo] 取当前文档行
      oldLines,
      newLines,
      oldAll: oldAllLines.join('\n'),
      adds: newLines.length,
      dels: oldLines.length,
      signature: `${oldLines.join('\n')}=>${newLines.join('\n')}`,
      ranges: hunkDecos,
    });
    hunkFrom = null;
    oldLines = null;
    newLines = null;
    oldAllLines = null;
    hunkDecos = null;
    oldSame = null;
    newSame = null;
    realLineRefs = null;
    ghostRefs = null;
  };
  for (const ev of merged) {
    if (ev.kind === 'same') {
      closeHunk();
      for (const line of ev.lines) {
        pos += line.length + 1;
        baseNo++;
        docNo++;
      }
      continue;
    }
    const isReal = ev.kind === 'add' === (realSide === 'new');
    if (hunkFrom == null) {
      hunkFrom = pos;
      baseFrom = baseNo + 1;
      docFrom = docNo + 1;
      oldLines = [];
      newLines = [];
      oldAllLines = [];
      hunkDecos = [];
      oldSame = [];
      newSame = [];
      realLineRefs = [];
      ghostRefs = [];
    }
    const pushLines = (arr, sameFlags) => {
      const firstIdx = arr.length;
      arr.push(...ev.lines);
      for (let k = 0; k < ev.lines.length; k++) sameFlags.push(!!ev.same);
      return firstIdx;
    };
    let realFirstIdx = 0;
    if (ev.kind === 'add') realFirstIdx = pushLines(newLines, newSame);
    else realFirstIdx = pushLines(oldLines, oldSame);
    if (ev.kind === 'del' || ev.same) oldAllLines.push(...ev.lines);
    if (ev.kind === 'add') adds += ev.lines.length;
    else dels += ev.lines.length;
    if (isReal) {
      const cls = realSide === 'new' ? 'cm-diff-add' : 'cm-diff-del';
      for (let k = 0; k < ev.lines.length; k++) {
        const line = ev.lines[k];
        hunkDecos.push(Decoration.line({ class: cls }).range(pos));
        realLineRefs.push({ start: pos, idx: realFirstIdx + k, side: ev.kind });
        pos += line.length + 1;
        docNo++;
      }
      // 吸收的相同行内容在两侧都存在：基线行号也要前进，否则保存时基线拼接漏行
      if (ev.same) baseNo += ev.lines.length;
    } else {
      const widget = new DiffGhostWidget(ev.lines, ev.kind);
      hunkDecos.push(
        Decoration.widget({ widget, side: -1 }).range(pos)
      );
      ghostRefs.push({ widget, start: realFirstIdx, count: ev.lines.length, side: ev.kind });
      baseNo += ev.lines.length;
      if (ev.same) docNo += ev.lines.length;
    }
  }
  closeHunk();
  return { hunks, adds, dels };
}
