import { describe, it, expect } from 'vitest';
import { parseLatexOutline, activeOutlineIndex, stripComment } from './outline.js';

describe('parseLatexOutline', () => {
  const tex = [
    '\\documentclass{article}',
    '\\begin{document}',
    '\\section{Introduction}',
    'text % \\section{注释里的不算}',
    '\\subsection{Background}',
    '\\subsubsection{Detail}',
    '\\section*{Ack}',
    '\\section{方法 \\textbf{核心}}',
    '\\end{document}',
  ].join('\n');

  it('解析层级、标题、行号', () => {
    const items = parseLatexOutline(tex);
    expect(items).toHaveLength(5);
    expect(items[0]).toMatchObject({ level: 1, title: 'Introduction', line: 2 });
    expect(items[1]).toMatchObject({ level: 2, title: 'Background', line: 4 });
    expect(items[2]).toMatchObject({ level: 3, title: 'Detail', line: 5 });
    expect(items[3]).toMatchObject({ level: 1, title: 'Ack', line: 6 });
    expect(items[4].title).toBe('方法 核心');
  });

  it('activeOutlineIndex 取最后不超过光标的项', () => {
    const items = parseLatexOutline(tex);
    expect(activeOutlineIndex(items, 0)).toBe(-1);
    expect(activeOutlineIndex(items, 3)).toBe(0);
    expect(activeOutlineIndex(items, 4)).toBe(1);
    expect(activeOutlineIndex(items, 8)).toBe(4);
  });

  it('空文本与无标题', () => {
    expect(parseLatexOutline('')).toEqual([]);
    expect(parseLatexOutline('hello')).toEqual([]);
  });
});

describe('stripComment', () => {
  it('去掉未转义 % 后内容，保留 \\%', () => {
    expect(stripComment('a % b')).toBe('a ');
    expect(stripComment('a \\% b')).toBe('a \\% b');
    expect(stripComment('100%')).toBe('100');
  });
});
