/** 规整日志中的文件路径：posix 化、去 ./ 前缀、去项目目录绝对前缀 */
function normFile(f, baseDir) {
  let p = String(f || '').trim();
  if (!p) return '';
  p = p.split('\\').join('/');
  if (baseDir) {
    const base = String(baseDir).split('\\').join('/').replace(/\/+$/, '');
    if (p.startsWith(base + '/')) p = p.slice(base.length + 1);
  }
  while (p.startsWith('./')) p = p.slice(2);
  return p;
}

const FILE_TOKEN = /^[^()\s]+$/;
const looksLikeFile = (t) => t.length > 0 && FILE_TOKEN.test(t) && (t.includes('/') || /\.[A-Za-z]{1,8}$/.test(t));

/** 维护 TeX 日志的括号文件栈（尽力而为）。null 占位保持配平。 */
function updateStack(stack, line) {
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '(') {
      let j = i + 1;
      let token = '';
      while (j < line.length && !/[\s()]/.test(line[j])) { token += line[j]; j++; }
      stack.push(token && looksLikeFile(token) ? token : null);
      i = j - 1;
    } else if (ch === ')') {
      stack.pop();
    }
  }
}

function topFile(stack, baseDir) {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i] && /\.tex$/i.test(stack[i])) return normFile(stack[i], baseDir);
  }
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i]) return normFile(stack[i], baseDir);
  }
  return '';
}

const FILE_LINE_ERROR = /^([^\s:][^:]*\.[A-Za-z]{1,8}):(\d+):\s+(.*)$/;
const ON_INPUT_LINE = /\s+on input line (\d+)\.?$/;
const WARNING_START = /^(?:LaTeX|Package\s+[\w.@+-]+|Class\s+[\w.@+-]+)\s+Warning:\s*(.*)$/;
const MAX_WARNING_CONT = 4;

/**
 * 解析 LaTeX 编译日志 → { errors: [{file,line,message}], warnings: [{file,line,message}] }
 * 支持 -file-line-error 风格（./a.tex:12: msg）与经典 "! msg" + "l.<n>" 风格。
 * baseDir 可选，用于把绝对路径规整为项目相对路径。
 */
export function parseLatexLog(log, baseDir) {
  const text = String(log || '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const errors = [];
  const warnings = [];
  const stack = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const fl = line.match(FILE_LINE_ERROR);
    if (fl) {
      errors.push({ file: normFile(fl[1], baseDir), line: Number(fl[2]), message: fl[3].trim() });
      updateStack(stack, line);
      continue;
    }

    if (line.startsWith('! ')) {
      const message = line.slice(2).trim();
      let lineno = 0;
      for (let k = i + 1; k < Math.min(i + 6, lines.length); k++) {
        const lm = lines[k].match(/^l\.(\d+)/);
        if (lm) { lineno = Number(lm[1]); break; }
      }
      errors.push({ file: topFile(stack, baseDir), line: lineno, message });
      updateStack(stack, line);
      continue;
    }

    const wm = line.match(WARNING_START);
    if (wm) {
      let msg = wm[1];
      let lineno = 0;
      let end = i;
      let merged = msg;
      const lm0 = merged.match(ON_INPUT_LINE);
      if (lm0) {
        lineno = Number(lm0[1]);
        msg = merged.slice(0, lm0.index);
      } else {
        // 合并续行，找到 "on input line N" 才接受合并
        for (let k = i + 1; k < Math.min(i + 1 + MAX_WARNING_CONT, lines.length); k++) {
          merged += ' ' + lines[k].trim();
          const lm = merged.match(ON_INPUT_LINE);
          if (lm) {
            lineno = Number(lm[1]);
            msg = merged.slice(0, lm.index);
            end = k;
            break;
          }
        }
      }
      warnings.push({ file: topFile(stack, baseDir), line: lineno, message: msg.trim() });
      for (let k = i; k <= end; k++) updateStack(stack, lines[k]);
      i = end;
      continue;
    }

    updateStack(stack, line);
  }

  return { errors, warnings };
}
