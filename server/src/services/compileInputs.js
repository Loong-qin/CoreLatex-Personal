import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { runProcess } from './process.js';

const MAX_RECORDER_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 5000;
const MAX_BYTES = 128 * 1024 * 1024;
const sameStat = (a, b) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode &&
  a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const inside = (root, file) => file === root || file.startsWith(root + path.sep);
const failure = (reason, recorded = false, inputs = []) => ({ version: 1, complete: false, recorded, reason, inputs });
const changedSince = (stat, startedAt) => stat.ctimeMs >= startedAt || stat.mtimeMs >= startedAt;

function changedSymlink(filename, realPath, startedAt) {
  if (filename === realPath) return false;
  let current = path.parse(filename).root, hops = 0;
  let remaining = filename.slice(current.length).split(path.sep).filter(Boolean);
  while (remaining.length) {
    const next = path.join(current, remaining.shift());
    const stat = fs.lstatSync(next);
    if (!stat.isSymbolicLink()) { current = next; continue; }
    if (changedSince(stat, startedAt) || ++hops > 40) return true;
    const target = path.resolve(current, fs.readlinkSync(next));
    current = path.parse(target).root;
    remaining = [...target.slice(current.length).split(path.sep).filter(Boolean), ...remaining];
  }
  return false;
}

function distributionFile(file, runtime) {
  // Distribution packages contain their own lookup macros. Analyze custom
  // included classes/styles the same way regardless of their authoring path.
  const roots = ['/usr/share/texlive/texmf-dist', '/usr/share/texmf', '/var/lib/texmf'];
  if (runtime?.binDir) roots.push(path.resolve(runtime.binDir, '../..', 'texmf-dist'));
  return roots.some(root => inside(root, file));
}

// Filesystem timestamps can lag JavaScript's wall clock by one kernel tick.
// Establish the boundary using the same kernel timestamps as the input files,
// after crossing a tick so files copied immediately before it remain older.
export async function compilationInputBoundary(buildDir, { signal } = {}) {
  signal?.throwIfAborted();
  const filename = path.join(buildDir, '.compile-input-boundary-' + randomUUID());
  let fd;
  try {
    fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
    fs.writeSync(fd, 'start');
    const first = fs.fstatSync(fd), initial = Math.max(first.ctimeMs, first.mtimeMs);
    for (let attempt = 0; attempt < 128; attempt++) {
      signal?.throwIfAborted();
      await new Promise(resolve => setTimeout(resolve, 1));
      fs.writeSync(fd, '.');
      const next = fs.fstatSync(fd), stamp = Math.max(next.ctimeMs, next.mtimeMs);
      if (stamp > initial) return stamp;
    }
    return null;
  } catch (error) { signal?.throwIfAborted(); return null; }
  finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(filename); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

// Keep inline text because a verbatim macro can treat an inline percent sign
// as literal text.
export function withoutCommentLines(text) {
  return text.replace(/(^|[\r\n])[ \t]*%[^\r\n]*/g, '$1');
}

// Ignore comments when looking for features the TeX recorder cannot observe.
// An escaped percent is text; an even-length backslash run leaves it a comment.
function withoutComments(text) {
  return text.split(/\r\n|[\r\n]/).map(line => {
    let slashes = 0;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '%' && slashes % 2 === 0) return line.slice(0, i);
      slashes = line[i] === '\\' ? slashes + 1 : 0;
    }
    return line + '\n';
  }).join('');
}

const EXCLUDED = new Set(['_workspace', '.build', '.preview', '.versions', '.git']);

function groupAt(text, offset, opening, closing) {
  while (/\s/.test(text[offset] || '') && offset < text.length) offset++;
  if (text[offset] !== opening) return null;
  const start = ++offset;
  let depth = 1, braces = 0;
  for (; offset < text.length; offset++) {
    const character = text[offset];
    if (opening === '[') {
      if (character === '{') braces++;
      else if (character === '}') braces--;
      if (braces) continue;
    }
    if (character === opening) depth++;
    else if (character === closing && --depth === 0) return { value: text.slice(start, offset), end: offset + 1 };
  }
  return null;
}

function fontOptions(raw) {
  const parts = [];
  let start = 0, depth = 0;
  for (let i = 0; i <= raw.length; i++) {
    if (raw[i] === '{') depth++;
    else if (raw[i] === '}') depth--;
    if (depth < 0) return null;
    if ((raw[i] === ',' && !depth) || i === raw.length) { parts.push(raw.slice(start, i)); start = i + 1; }
  }
  if (depth) return null;
  const parsed = new Map();
  const benign = new Set(['Path', 'Scale', 'Ligatures', 'Numbers', 'Color', 'Colour', 'LetterSpace', 'WordSpace',
    'HyphenChar', 'Renderer', 'Script', 'Language', 'AutoFakeBold', 'AutoFakeSlant']);
  for (const part of parts.filter(value => value.trim())) {
    const position = part.indexOf('=');
    if (position < 0) return null;
    const key = part.slice(0, position).trim(); let value = part.slice(position + 1).trim();
    if (!benign.has(key) || parsed.has(key)) return null;
    if (value.startsWith('{')) {
      const group = groupAt(value, 0, '{', '}');
      if (!group || group.end !== value.length) return null;
      value = group.value;
    }
    if (!value || /[\\#$\0]/.test(value)) return null;
    parsed.set(key, value);
  }
  return parsed;
}

// XeTeX/fontspec can load font files outside TeX's recorder. Support the exact
// project-file form returned by download_font; other selectors stay incomplete
// instead of confusing a recorded TeX document with recorded font discovery.
function explicitFontInputs(source, root) {
  const text = withoutComments(source), files = [];
  if (/\\(?:setCJKmainfont|setCJKsansfont|setCJKmonofont|newfontfamily|newfontface|newCJKfontfamily|CJKfontspec|setmathfont|babelfont|defaultfontfeatures|addfontfeatures|font)\b/.test(text) ||
      /\\csname\s*(?:fontspec|setmainfont|setsansfont|setmonofont)\s*\\endcsname/.test(text)) return { problem: 'unrecorded-font' };
  const commands = /\\(?:fontspec|setmainfont|setsansfont|setmonofont)\b/g;
  for (const match of text.matchAll(commands)) {
    let cursor = match.index + match[0].length, options = '';
    const before = groupAt(text, cursor, '[', ']');
    if (before) { options = before.value; cursor = before.end; }
    const name = groupAt(text, cursor, '{', '}');
    if (!name || !name.value.trim() || /[\\#$\0]/.test(name.value)) return { problem: 'unrecorded-font' };
    const after = groupAt(text, name.end, '[', ']');
    if (after) options += (options ? ',' : '') + after.value;
    const parsed = fontOptions(options);
    const filename = name.value.trim();
    if (!parsed || !/\.(?:ttf|otf|ttc)$/i.test(filename) || /[{}*?]/.test(filename)) return { problem: 'unrecorded-font' };
    const directory = parsed.get('Path');
    if (directory && (/[{}*?]/.test(directory) || directory.startsWith('~') || path.isAbsolute(filename))) return { problem: 'unrecorded-font' };
    const file = path.resolve(root, directory || '.', filename);
    // Without explicit Path, a missing local filename may resolve through
    // kpsewhich/fontconfig. Do not falsely record only a missing cwd candidate.
    if (!directory && !fs.existsSync(file)) return { problem: 'unrecorded-font' };
    files.push(file);
  }
  return { files };
}

function conditionalFileLookups(source, root) {
  const text = withoutComments(source), files = [];
  // Primitive probes can affect output without an INPUT line when the file
  // was absent. Catcode/token changes also defeat the literal lookup scanner.
  if (/\\(?:catcode|scantokens)(?![A-Za-z])/.test(withoutCommentLines(source)) ||
      /\\(?:openin|read|readline|ifeof)(?![A-Za-z])/.test(text)) return { problem: 'conditional-lookup-unrecorded' };
  // Font-name availability can depend on unrecorded fontconfig searches.
  if (/\\IfFontExistsTF\b/.test(text)) return { problem: 'font-lookup-unrecorded' };
  for (const match of text.matchAll(/\\(?:IfFileExists|InputIfFileExists)\s*\{([^}]*)\}/g)) {
    const name = match[1].trim();
    if (!name || /[\\#$\r\n\0]/.test(name)) return { problem: 'conditional-lookup-unrecorded' };
    const absolute = path.resolve(root, name);
    const relative = path.relative(root, absolute);
    if (!inside(root, absolute) || relative.split(path.sep).some(segment => EXCLUDED.has(segment))) {
      files.push(absolute);
      if (!path.extname(name)) files.push(absolute + '.tex');
    }
  }
  return { files };
}

async function readStable(filename, budget, signal, inspect = false) {
  signal?.throwIfAborted();
  const realPath = fs.realpathSync(filename);
  const fd = fs.openSync(realPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile()) return { problem: 'unverifiable' };
    if (inspect && before.size > MAX_RECORDER_BYTES) return { problem: 'limit' };
    budget.bytes += before.size;
    if (++budget.files > MAX_FILES || budget.bytes > MAX_BYTES) return { problem: 'limit' };
    const digest = createHash('sha256');
    const decoder = inspect ? new StringDecoder('utf8') : null;
    let source = '';
    const stream = fs.createReadStream(null, { fd, autoClose: false, signal });
    for await (const chunk of stream) {
      digest.update(chunk);
      if (inspect) source += decoder.write(chunk);
    }
    if (inspect) source += decoder.end();
    const after = fs.fstatSync(fd);
    if (!sameStat(before, after) || fs.realpathSync(filename) !== realPath || !sameStat(after, fs.statSync(realPath))) {
      return { problem: 'unstable' };
    }
    return { sha256: digest.digest('hex'), size: after.size, stat: after, realPath, source };
  } finally { fs.closeSync(fd); }
}

async function bibliographyInputs({ logPath, cwd, projectRoot, runtime, signal }) {
  if (!logPath || !runtime?.binDir || fs.statSync(logPath).size > MAX_RECORDER_BYTES) return null;
  const text = fs.readFileSync(logPath, 'utf8');
  const wanted = [];
  for (const match of text.matchAll(/^Database file #\d+:\s*(.+)\s*$/gm)) wanted.push(['bib', match[1].trim()]);
  for (const match of text.matchAll(/^The style file:\s*(.+)\s*$/gm)) wanted.push(['bst', match[1].trim()]);
  if (!wanted.some(([kind]) => kind === 'bib') || !wanted.some(([kind]) => kind === 'bst')) return null;
  const resolved = [];
  const env = { ...runtime.env, BIBINPUTS: projectRoot + ':' + (process.env.BIBINPUTS || ''),
    BSTINPUTS: projectRoot + ':' + (process.env.BSTINPUTS || '') };
  for (const [format, name] of wanted) {
    signal?.throwIfAborted();
    if (!name || name.length > 4096 || name.includes('\0')) return null;
    const result = await runProcess(path.join(runtime.binDir, 'kpsewhich'), ['--format=' + format, name],
      { cwd, env, signal, timeoutMs: 5000, maxOutputBytes: 65536 });
    if (result.exitCode !== 0 || result.outputTruncated) return null;
    const file = result.stdout.trim();
    if (!file || file.includes('\n') || file.includes('\r')) return null;
    resolved.push(path.resolve(cwd, file));
  }
  return resolved;
}

// Read each pass before TeX replaces its .fls. Inputs used only on an early
// pass may still affect the final PDF via the generated auxiliary files.
export function readCompilationRecorder(recorderPath, compileRoot, startedAt = 0) {
  let fd;
  try {
    fd = fs.openSync(recorderPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_RECORDER_BYTES) return failure('recorder-unreadable', true);
    if (startedAt && stat.mtimeMs < startedAt && stat.ctimeMs < startedAt) return failure('recorder-stale', true);
    const content = fs.readFileSync(fd, 'utf8');
    if (!sameStat(stat, fs.lstatSync(recorderPath)) || !sameStat(stat, fs.fstatSync(fd))) return failure('unstable', true);
    const lines = content.split(/\r?\n/);
    if (lines.length > 20000) return failure('recorder-limit', true);
    const directories = lines.filter(line => line.startsWith('PWD ')).map(line => path.resolve(line.slice(4)));
    if (!directories.length || directories.some(directory => directory !== path.resolve(compileRoot))) return failure('recorder-context-mismatch', true);
    const paths = prefix => lines.filter(line => line.startsWith(prefix)).map(line => path.resolve(compileRoot, line.slice(prefix.length)));
    const files = paths('INPUT ');
    return files.length ? { recorded: true, files, outputs: paths('OUTPUT ') } : failure('recorder-empty', true);
  } catch (error) {
    return error.code === 'ENOENT' ? failure('recorder-missing') : failure('recorder-unreadable', true);
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

/** Capture the compiler's actual reads while its queued project snapshot exists.
 * Project/staged byte snapshots remain the caller's responsibility. A staged
 * input is marked delegated because its original file is not the compiled draft.
 */
export async function captureCompilationInputs({ recorderPath, recorders, compileRoot, sourceRoot = compileRoot,
  stagedPaths = [], startedAt = 0, signal, engine, unrecordedInputs = false,
  bibtexRan = false, bibliographyLogPath, buildDir = path.dirname(recorderPath || ''), runtime } = {}) {
  let recorded = false;
  const inputs = [];
  try {
    signal?.throwIfAborted();
    if (!recorderPath || !path.isAbsolute(compileRoot || '') || !path.isAbsolute(sourceRoot || '')) return failure('invalid-context');
    const root = path.resolve(compileRoot), original = path.resolve(sourceRoot);
    const passes = recorders || [readCompilationRecorder(recorderPath, root, startedAt)];
    recorded = passes.some(pass => pass.recorded);
    const problem = passes.find(pass => pass.reason);
    if (problem || !passes.length) return failure(problem?.reason || 'recorder-empty', recorded);
    if (unrecordedInputs || engine === 'lualatex') return failure('unrecorded-io', recorded);
    const outputs = new Set(passes.flatMap(pass => pass.outputs));
    const files = [...new Set(passes.flatMap(pass => pass.files))];
    if (bibtexRan) {
      const bibliography = await bibliographyInputs({ logPath: bibliographyLogPath, cwd: buildDir, projectRoot: root, runtime, signal });
      if (!bibliography) return failure('bibliography-unrecorded', true);
      files.push(...bibliography);
      // Bibtex's own generated output is an input to TeX but is not a TeX
      // OUTPUT record. Its real sources/styles were added from the .blg above.
      outputs.add(path.join(path.dirname(recorderPath), path.basename(recorderPath).replace(/\.fls$/i, '.bbl')));
    }
    const budget = { files: 0, bytes: 0 }, seen = new Set(), reads = [], lookups = [];
    const staged = new Set(stagedPaths.map(file => String(file).replace(/\\/g, '/')));
    for (const file of files) {
      signal?.throwIfAborted();
      if (outputs.has(file) && inside(buildDir, file)) continue;
      const relative = inside(root, file) ? path.relative(root, file) : null;
      const target = relative === null ? file : path.resolve(original, relative);
      if (seen.has(target)) continue;
      seen.add(target);
      const scope = relative === null ? 'external' : relative === '_workspace' || relative.startsWith('_workspace' + path.sep) ? 'workspace' : 'project';
      const read = await readStable(file, budget, signal, /\.(?:tex|sty|cls|ltx|def|cfg)$/i.test(file));
      if (read.problem) return failure(read.problem, true, inputs);
      if (!['pdflatex', 'xelatex'].includes(engine) && /\\(?:directlua|latelua)\b/.test(withoutComments(read.source))) return failure('unrecorded-io', true, inputs);
      if (read.source && (scope !== 'external' || !distributionFile(read.realPath, runtime))) {
        if (root !== original && /\.\.[/\\]/.test(withoutComments(read.source))) {
          // A preview lives one directory deeper. Its ../ target can differ
          // from the target of the same source after application to the project.
          return failure('preview-relative-external', true, inputs);
        }
        const conditional = conditionalFileLookups(read.source, root);
        if (conditional.problem) return failure(conditional.problem, true, inputs);
        lookups.push(...conditional.files);
        const fonts = explicitFontInputs(read.source, root);
        if (fonts.problem) return failure(fonts.problem, true, inputs);
        lookups.push(...fonts.files);
      }
      // Changes to an external dependency during the run may precede our first
      // observation. Never claim its post-run bytes are what TeX actually read.
      if (startedAt && (changedSince(read.stat, startedAt) || changedSymlink(file, read.realPath, startedAt))) {
        return failure('unstable', true, inputs);
      }
      const delegated = relative !== null && staged.has(relative.split(path.sep).join('/'));
      const entry = { path: target, sha256: read.sha256, size: read.size, scope,
        ...(relative !== null ? { relativePath: relative.split(path.sep).join('/') } : {}),
        ...(delegated ? { delegated: true } : {}) };
      if (!delegated) entry.realPath = root === original || scope === 'external' ? read.realPath : fs.realpathSync(target);
      inputs.push(entry); reads.push([file, read]);
    }
    for (const file of new Set(lookups)) {
      signal?.throwIfAborted();
      const relative = inside(root, file) ? path.relative(root, file) : null;
      const target = relative === null ? file : path.resolve(original, relative);
      if (seen.has(target)) continue;
      seen.add(target);
      const scope = relative === null ? 'external' : relative.split(path.sep).includes('_workspace') ? 'workspace' : 'project';
      const details = { path: target, scope,
        ...(relative !== null ? { relativePath: relative.split(path.sep).join('/') } : {}) };
      try { fs.lstatSync(file); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        if (++budget.files > MAX_FILES) return failure('limit', true, inputs);
        let parent = path.dirname(file);
        while (!fs.existsSync(parent) && path.dirname(parent) !== parent) parent = path.dirname(parent);
        const parentStat = fs.statSync(parent);
        if (startedAt && changedSince(parentStat, startedAt)) return failure('unstable', true, inputs);
        inputs.push({ ...details, missing: true });
        continue;
      }
      const read = await readStable(file, budget, signal);
      if (read.problem) return failure(read.problem, true, inputs);
      if (startedAt && (changedSince(read.stat, startedAt) || changedSymlink(file, read.realPath, startedAt))) return failure('unstable', true, inputs);
      const delegated = relative !== null && staged.has(details.relativePath);
      inputs.push({ ...details, size: read.size, sha256: read.sha256,
        ...(delegated ? { delegated: true } : { realPath: root === original || scope === 'external' ? read.realPath : fs.realpathSync(target) }) });
      reads.push([file, read]);
    }
    for (const [file, read] of reads) {
      if (fs.realpathSync(file) !== read.realPath || !sameStat(read.stat, fs.statSync(read.realPath))) return failure('unstable', true, inputs);
      if (startedAt && changedSymlink(file, read.realPath, startedAt)) return failure('unstable', true, inputs);
    }
    if (!inputs.length) return failure('recorder-empty', true);
    return { version: 1, recorded: true, complete: true, inputs };
  } catch (error) {
    signal?.throwIfAborted();
    return failure(error.code === 'ENOENT' ? 'input-missing' : 'input-unreadable', recorded, inputs);
  }
}

/** Verify only immutable manifest facts. The caller must separately compare its
 * current project/draft snapshot for every delegated staged entry.
 */
export async function verifyCompilationInputs(manifest, { signal } = {}) {
  if (manifest?.version !== 1 || manifest.complete !== true || manifest.recorded !== true ||
      !Array.isArray(manifest.inputs) || !manifest.inputs.length || manifest.inputs.length > MAX_FILES) return 'unverifiable';
  const budget = { files: 0, bytes: 0 }, checked = [], missing = [];
  try {
    for (const input of manifest.inputs) {
      signal?.throwIfAborted();
      if (!input || !path.isAbsolute(input.path || '')) return 'unverifiable';
      if (input.missing === true) {
        try { fs.lstatSync(input.path); return 'changed'; }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        missing.push(input.path); continue;
      }
      if (!/^[a-f0-9]{64}$/.test(input.sha256 || '')) return 'unverifiable';
      if (input.delegated === true && ['project', 'workspace'].includes(input.scope)) continue;
      const read = await readStable(input.path, budget, signal);
      if (read.problem === 'unstable') return 'unstable';
      if (read.problem) return 'unverifiable';
      if (read.realPath !== input.realPath || read.sha256 !== input.sha256 || read.size !== input.size) return 'changed';
      checked.push([input.path, read]);
    }
    for (const [file, read] of checked) {
      if (fs.realpathSync(file) !== read.realPath || !sameStat(read.stat, fs.statSync(read.realPath))) return 'unstable';
    }
    for (const file of missing) {
      try { fs.lstatSync(file); return 'changed'; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return 'current';
  } catch (error) {
    signal?.throwIfAborted();
    return error.code === 'ENOENT' ? 'changed' : 'unverifiable';
  }
}
