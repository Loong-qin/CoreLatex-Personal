import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import zlib from 'node:zlib';

const SP_PER_BP = 65536 * 72.27 / 72;
export function spToBp(sp) { return sp / SP_PER_BP; }

const BOX_RE = /^([\[(gkxhrv$])\s*(\d+),(-?\d+)(?:,-?\d+)?:(-?\d+),(-?\d+|=)(?=[:,]|$)/;
const FORM_REF_RE = /^f\d+:-?\d+,(-?\d+|=)$/;
const INPUT_RE = /^Input:(\d+):(.*)$/;
const HEADER_RE = /^(Magnification|Unit|X Offset|Y Offset):\s*(.*)$/;
const OFFSET_UNITS = {
  sp: spToBp(1), pt: 72 / 72.27, bp: 1, pc: 12 * 72 / 72.27,
  in: 72, cm: 72 / 2.54, mm: 72 / 25.4,
  dd: (1238 / 1157) * 72 / 72.27, cc: (14856 / 1157) * 72 / 72.27,
  nd: (685 / 642) * 72 / 72.27, nc: (1370 / 107) * 72 / 72.27,
};

function offsetInBp(value) {
  const match = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s*([a-z]+)?$/i.exec(value);
  return match ? Number(match[1]) * (OFFSET_UNITS[match[2] || 'sp'] ?? NaN) : NaN;
}

function scanner(consume) {
  const inputs = new Map();
  const header = {};
  const postscript = {};
  let page = 0;
  let formDepth = 0;
  let lastY = 0;
  let inPostscript = false;
  return {
    inputs,
    transform() {
      // TeX Live applies the preamble unit to the offsets, and applies both
      // magnifications to positions. The XDV/PDF postscript offsets replace
      // the preamble offsets and already carry their own units.
      const unit = Number(header.Unit);
      const baseScale = spToBp(unit > 0 ? unit : 1);
      const magnification = Number(header.Magnification);
      const postMagnification = Number(postscript.Magnification);
      const postY = offsetInBp(postscript['Y Offset']);
      return {
        scale: baseScale * (magnification > 0 ? magnification / 1000 : 1) * (postMagnification > 0 ? postMagnification : 1),
        yOffset: Number.isFinite(postY) ? postY : (Number(header['Y Offset']) || 0) * baseScale,
      };
    },
    push(raw) {
      const text = raw.trim();
      if (text[0] === '{') {
        page = Number.parseInt(text.slice(1), 10) || 0;
        return;
      }
      if (text[0] === '}') { page = 0; return; }
      if (text[0] === '<') { formDepth++; return; }
      if (text[0] === '>') { formDepth = Math.max(0, formDepth - 1); return; }
      if (text.startsWith('Input:')) {
        const input = INPUT_RE.exec(text);
        if (input) inputs.set(Number(input[1]), input[2].trim());
        return;
      }
      if (!page && !formDepth) {
        if (text === 'Post scriptum:') inPostscript = true;
        const field = HEADER_RE.exec(text);
        if (field) (inPostscript ? postscript : header)[field[1]] = field[2];
        return;
      }
      if (text[0] === 'f') {
        const ref = FORM_REF_RE.exec(text);
        if (ref && ref[1] !== '=') lastY = Number(ref[1]);
        return;
      }
      const match = BOX_RE.exec(text);
      if (!match) return;
      const [, kind, tag, line, x, y] = match;
      if (y !== '=') lastY = Number(y);
      // Form records use coordinates local to the form. Native point queries
      // can resolve its placements, while the scroll map uses page anchors.
      if (page && !formDepth && Number(line) > 0) {
        consume({ kind, tag: Number(tag), line: Number(line), page, x: Number(x), y: lastY });
      }
    },
  };
}

export function parseSynctex(content) {
  const boxes = [];
  const parser = scanner(box => boxes.push(box));
  for (const line of content.split('\n')) parser.push(line);
  return { inputs: parser.inputs, boxes };
}

function rank(kind) {
  if (kind === 'x') return 0;
  if (kind === '(' || kind === 'h') return 1;
  if (kind === '[' || kind === 'v') return 3;
  return 2;
}

function earlierAnchor(box, prior) {
  return !prior || box.page < prior.page ||
    (box.page === prior.page && (rank(box.kind) < rank(prior.kind) ||
      (rank(box.kind) === rank(prior.kind) && box.y < prior.y)));
}

export function resolveSynctexInput(root, input) {
  const file = input.replace(/^"(.*)"$/, '$1');
  return path.resolve(root, file);
}

function sourceKey(file) {
  const absolute = path.resolve(file);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

function lineIndex(root) {
  const tags = new Map();
  const parser = scanner(box => {
    let lines = tags.get(box.tag);
    if (!lines) {
      lines = new Map();
      tags.set(box.tag, lines);
    }
    if (earlierAnchor(box, lines.get(box.line))) lines.set(box.line, box);
  });
  return {
    push: parser.push,
    finish() {
      const { scale, yOffset } = parser.transform();
      const sources = new Map();
      for (const [tag, input] of parser.inputs) {
        const file = sourceKey(resolveSynctexInput(root, input));
        let source = sources.get(file);
        if (!source) {
          source = { input, lines: new Map() };
          sources.set(file, source);
        }
        for (const box of tags.get(tag)?.values() || []) {
          if (earlierAnchor(box, source.lines.get(box.line))) source.lines.set(box.line, box);
        }
      }
      let lineCount = 0;
      for (const source of sources.values()) {
        source.lines = Array.from(source.lines.values())
          .sort((a, b) => a.line - b.line)
          .map(box => ({ line: box.line, page: box.page, y: box.y * scale + yOffset }));
        lineCount += source.lines.length;
      }
      return { sources, lineCount };
    },
  };
}

export function buildLineMap(content, targetFile, root = process.cwd()) {
  const parser = lineIndex(root);
  for (const line of content.split('\n')) parser.push(line);
  return parser.finish().sources.get(sourceKey(path.resolve(root, targetFile)))?.lines ?? [];
}

async function fileStat(file) {
  try {
    const stat = await fs.promises.stat(file);
    if (stat.isFile()) return stat;
  } catch {}
  return null;
}

function statKey(stat) {
  return stat ? [stat.dev, stat.ino, stat.mtimeMs, stat.ctimeMs, stat.size].join(':') : '';
}

export async function synctexArtifact(pdfPath) {
  const pdf = path.resolve(pdfPath);
  const base = pdf.replace(/\.pdf$/i, '');
  const plain = base + '.synctex';
  const gzip = plain + '.gz';
  const [pdfStat, plainStat, gzipStat] = await Promise.all([fileStat(pdf), fileStat(plain), fileStat(gzip)]);
  if (!pdfStat) return null;
  return {
    signature: [pdf, statKey(pdfStat), statKey(plainStat), statKey(gzipStat)].join('\0'),
    sidecars: [plainStat && { path: plain, stat: plainStat }, gzipStat && { path: gzip, stat: gzipStat }]
      .filter(Boolean).sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs),
  };
}

const MAX_CONTENT_BYTES = 64 * 1024 * 1024;
const MAX_LINE_LENGTH = 64 * 1024;
const MAX_CACHE_ENTRIES = 16;
const MAX_CACHED_LINES = 200000;
const cache = new Map();
const pending = new Map();
let cachedLines = 0;

async function readIndex(file, root) {
  const source = fs.createReadStream(file);
  const stream = file.endsWith('.gz') ? zlib.createGunzip() : source;
  if (stream !== source) {
    source.on('error', error => stream.destroy(error));
    source.pipe(stream);
  }
  const parser = lineIndex(root);
  const decoder = new StringDecoder('utf8');
  let tail = '';
  let bytes = 0;
  try {
    for await (const chunk of stream) {
      bytes += chunk.length;
      if (bytes > MAX_CONTENT_BYTES) return null;
      const lines = (tail + decoder.write(chunk)).split('\n');
      tail = lines.pop();
      if (tail.length > MAX_LINE_LENGTH) return null;
      for (const line of lines) parser.push(line);
    }
    parser.push(tail + decoder.end());
    return parser.finish();
  } catch {
    return null;
  } finally {
    source.destroy();
    if (stream !== source) stream.destroy();
  }
}

async function artifactIndex(pdfPath, root, artifact) {
  if (!artifact?.sidecars.length) return null;
  const key = artifact.signature + '\0' + root;
  if (cache.has(key)) {
    const value = cache.get(key);
    cache.delete(key);
    cache.set(key, value);
    return value;
  }
  let task = pending.get(key);
  if (!task) {
    task = (async () => {
      for (const { path: file, stat } of artifact.sidecars) {
        if (stat.size > MAX_CONTENT_BYTES) continue;
        const value = await readIndex(file, root);
        if (!value) continue;
        if ((await synctexArtifact(pdfPath))?.signature !== artifact.signature) return null;
        if (value.lineCount <= MAX_CACHED_LINES) {
          cache.set(key, value);
          cachedLines += value.lineCount;
          while (cache.size > MAX_CACHE_ENTRIES || cachedLines > MAX_CACHED_LINES) {
            const oldest = cache.keys().next().value;
            cachedLines -= cache.get(oldest).lineCount;
            cache.delete(oldest);
          }
        }
        return value;
      }
      return null;
    })();
    pending.set(key, task);
  }
  try {
    return await task;
  } finally {
    if (pending.get(key) === task) pending.delete(key);
  }
}

export async function synctexInputName(pdfPath, fileAbs, root, artifact) {
  const index = await artifactIndex(pdfPath, root, artifact);
  if (!index?.sources.size) return undefined;
  return index.sources.get(sourceKey(fileAbs))?.input ?? null;
}

export async function synctexLineMap(pdfPath, fileAbs, root = path.dirname(path.resolve(pdfPath))) {
  const artifact = await synctexArtifact(pdfPath);
  if (!artifact) return null;
  const index = await artifactIndex(pdfPath, path.resolve(root), artifact);
  return { lines: index?.sources.get(sourceKey(fileAbs))?.lines ?? [] };
}
