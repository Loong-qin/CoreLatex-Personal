import path from 'node:path';
import { runProcess } from './process.js';
import { resolveSynctexInput, synctexArtifact, synctexInputName } from './synctexMap.js';

const QUERY_TIMEOUT_MS = 5000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 512;
const MAX_PARALLEL_QUERIES = 4;
const cache = new Map();
const pending = new Map();
const queue = [];
let activeQueries = 0;

async function runSynctex(args, runtime, cwd) {
  if (activeQueries >= MAX_PARALLEL_QUERIES) await new Promise(resolve => queue.push(resolve));
  else activeQueries++;
  try {
    const result = await runProcess(runtime?.binDir ? path.join(runtime.binDir, 'synctex') : 'synctex', args, {
      cwd,
      env: { ...(runtime?.env || process.env), SYNCTEX_VIEWER: '', SYNCTEX_EDITOR: '', LC_ALL: 'C' },
      timeoutMs: QUERY_TIMEOUT_MS,
      maxOutputBytes: MAX_OUTPUT_BYTES,
    });
    if (result.exitCode !== 0 || result.outputTruncated) return null;
    return result.stdout || '';
  } catch {
    return null;
  } finally {
    activeQueries--;
    const next = queue.shift();
    if (next) {
      activeQueries++;
      next();
    }
  }
}

function* records(output) {
  let fields;
  for (const text of output.split('\n')) {
    const line = text.trimEnd();
    if (line === 'SyncTeX result begin') {
      fields = Object.create(null);
      continue;
    }
    if (!fields) continue;
    if (line === 'SyncTeX result end') {
      yield fields;
      return;
    }
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon);
    if (key === 'Output' && fields.Output !== undefined) {
      yield fields;
      fields = Object.create(null);
    }
    fields[key] = line.slice(colon + 1).trim();
  }
}

function number(value) {
  return value ? Number(value) : NaN;
}

function parseCodeHit(output) {
  for (const record of records(output)) {
    const page = number(record.Page);
    const x = number(record.x);
    const y = number(record.y);
    if (!Number.isInteger(page) || page < 1 || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    const hit = { page, x, y };
    const h = number(record.h);
    const v = number(record.v);
    const w = number(record.W);
    const height = number(record.H);
    if ([h, v, w, height].every(Number.isFinite) && w !== 0 && height > 0) {
      hit.rect = { x: h + Math.min(w, 0), y: v - height, width: Math.abs(w), height };
    }
    return hit;
  }
  return null;
}

function parsePdfHit(output, root) {
  for (const record of records(output)) {
    const line = number(record.Line);
    const input = record.Input || record.File;
    if (!input || !Number.isInteger(line) || line < 1) continue;
    const file = resolveSynctexInput(root, input);
    const relative = path.relative(root, file);
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) continue;
    const column = number(record.Column);
    return Number.isInteger(column) && column > 0 ? { file, line, column } : { file, line };
  }
  return null;
}

function cached(key) {
  if (!cache.has(key)) return undefined;
  const value = cache.get(key);
  cache.delete(key);
  cache.set(key, value);
  return value;
}

function store(key, value) {
  cache.set(key, value);
  if (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
}

async function query(pdfPath, root, artifact, args, runtime, parse) {
  const key = [artifact.signature, root, runtime?.binDir || '', ...args].join('\0');
  const hit = cached(key);
  if (hit !== undefined) return hit;
  let task = pending.get(key);
  if (!task) {
    task = (async () => {
      const output = await runSynctex(args, runtime, root);
      if (output === null || (await synctexArtifact(pdfPath))?.signature !== artifact.signature) return null;
      const value = parse(output);
      store(key, value);
      return value;
    })();
    pending.set(key, task);
  }
  try {
    return await task;
  } finally {
    if (pending.get(key) === task) pending.delete(key);
  }
}

export async function codeToPdf(pdfPath, filePath, line, col, runtime, projectRoot) {
  const pdf = path.resolve(pdfPath);
  const root = path.resolve(projectRoot || path.dirname(pdf));
  const artifact = await synctexArtifact(pdf);
  if (!artifact) return null;
  const source = projectRoot ? await synctexInputName(pdf, filePath, root, artifact) : undefined;
  // The CLI can otherwise fall back to a different file with the same basename.
  if (source === null) return null;
  let input = source ?? path.resolve(root, filePath);
  if (input.startsWith('"') || /^[+-]?\d+:/.test(input)) input = '"' + input + '"';
  return query(pdf, root, artifact, ['view', '-i', line + ':' + col + ':' + input, '-o', pdf], runtime, parseCodeHit);
}

export async function pdfToCode(pdfPath, page, x, y, runtime, projectRoot) {
  const pdf = path.resolve(pdfPath);
  const root = path.resolve(projectRoot || path.dirname(pdf));
  const artifact = await synctexArtifact(pdf);
  if (!artifact) return null;
  return query(pdf, root, artifact, ['edit', '-o', page + ':' + x + ':' + y + ':' + pdf], runtime, output => parsePdfHit(output, root));
}
