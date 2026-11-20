import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { DATA_DIR } from '../config.js';
import { getDb } from '../db.js';
import { HttpError } from '../util.js';
import { runProcess } from './process.js';
import { runtimeEnvironment, getRuntimeResourceRevision, bumpRuntimeResourceRevision, withRuntimeInstallLock, currentRuntimeInstallOwnerId } from './runtimeEnvironment.js';
import { SUPPORTED_TEX_VERSIONS, texRepositories, verifyTexRepository } from './texMirrors.js';

export const TEX_VERSIONS = [...SUPPORTED_TEX_VERSIONS];
export const DEFAULT_TEX_VERSION = '2024';
export const TEX_RUNTIME_ROOT = path.join(DATA_DIR, 'runtime', 'texlive');
const key = 'tex_runtimes';
const probeCache = new Map();
const platform = process.arch === 'arm64' ? 'aarch64-linux' : 'x86_64-linux';

function readConfig() {
  try { return JSON.parse(getDb().prepare('SELECT value FROM system_settings WHERE key = ?').get(key)?.value || '{}'); }
  catch { return {}; }
}
function validVersion(version, system = true) {
  if (!TEX_VERSIONS.includes(version) && !(system && version === 'system')) throw new HttpError(400, '不支持的 TeX Live 版本');
  return version;
}
function findSystemBin() {
  return (process.env.PATH || '').split(path.delimiter).find(p => {
    try { fs.accessSync(path.join(p, 'pdflatex'), fs.constants.X_OK); return true; } catch { return false; }
  }) || '';
}
function probe(binDir) {
  if (!binDir) return { available: false, error: '未找到编译器' };
  const cached = probeCache.get(binDir);
  if (cached && Date.now() - cached.at < 15000) return cached.result;
  let result;
  try {
    const output = execFileSync(path.join(binDir, 'pdflatex'), ['--version'], { encoding: 'utf8', timeout: 3000, maxBuffer: 16384 });
    const version = output.match(/TeX Live\s+(\d{4})/)?.[1] || null;
    result = { available: !!version, detectedVersion: version, error: version ? '' : '无法识别 TeX Live 版本' };
  } catch { result = { available: false, error: '编译器不存在、不可执行或无法启动' }; }
  probeCache.set(binDir, { at: Date.now(), result });
  return result;
}
function describe(version, config) {
  const settings = config[version] || {};
  const candidates = version === 'system' ? [findSystemBin()] : [
    settings.binDir,
    path.join(TEX_RUNTIME_ROOT, version, 'bin', platform),
    `/usr/local/texlive/${version}/bin/${platform}`,
    `/opt/texlive/${version}/bin/${platform}`,
  ].filter(Boolean);
  // An explicitly configured installation must not silently fall back elsewhere.
  const binDir = settings.binDir || candidates.find(dir => fs.existsSync(path.join(dir, 'pdflatex'))) || candidates[0] || '';
  const installing = version !== 'system' && fs.existsSync(path.join(TEX_RUNTIME_ROOT, version, '.corelatex-installing'));
  const detected = installing ? { available: false, error: '正在安装，完成后才能使用' } : probe(binDir);
  const matches = version === 'system' || detected.detectedVersion === version;
  const available = version === 'system' ? !!binDir : detected.available && matches;
  const managedRoot = path.join(TEX_RUNTIME_ROOT, version) + path.sep;
  let managed = false;
  try { managed = version !== 'system' && fs.realpathSync(binDir).startsWith(managedRoot); } catch {}
  return {
    version, label: version === 'system' ? `系统 TeX Live${detected.detectedVersion ? ' ' + detected.detectedVersion : ''}（兼容）` : `TeX Live ${version}`,
    enabled: settings.enabled ?? (version === DEFAULT_TEX_VERSION || version === 'system'),
    installed: available, available, binDir, managed,
    detectedVersion: detected.detectedVersion || null,
    error: available ? '' : !matches && detected.available ? `目录实际是 TeX Live ${detected.detectedVersion}，与所选版本不符` : detected.error,
  };
}

export function listTexRuntimes({ admin = false } = {}) {
  const config = readConfig();
  return { defaultVersion: DEFAULT_TEX_VERSION, versions: ['system', ...TEX_VERSIONS].map(version => {
    const item = describe(version, config);
    if (!admin) { delete item.binDir; delete item.managed; }
    return item;
  }) };
}

export function configureTexRuntime(version, patch = {}) {
  validVersion(version);
  if (patch.enabled !== undefined && typeof patch.enabled !== 'boolean') throw new HttpError(400, 'enabled 必须为布尔值');
  if (patch.binDir !== undefined && (typeof patch.binDir !== 'string' || !path.isAbsolute(patch.binDir) || /[\r\n\0]/.test(patch.binDir))) throw new HttpError(400, '编译器目录必须是绝对路径');
  const config = readConfig();
  const next = { ...config[version] };
  if (patch.enabled !== undefined) next.enabled = patch.enabled;
  if (patch.binDir !== undefined) next.binDir = path.normalize(patch.binDir);
  const item = describe(version, { ...config, [version]: next });
  if (item.enabled && !item.available) throw new HttpError(409, item.error || '请先安装该版本');
  config[version] = next;
  bumpRuntimeResourceRevision();
  getDb().prepare('INSERT INTO system_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(config));
  return listTexRuntimes({ admin: true });
}

export function resolveTexRuntime(version = DEFAULT_TEX_VERSION, { allowDisabled = false } = {}) {
  validVersion(version);
  // Legacy/system compilation keeps the ambient toolchain without executing
  // an extra engine process. Version probing belongs to discovery/configuration;
  // in particular it must not run before quota checks or count as a compile.
  const config = readConfig();
  const item = version === 'system' ? {
    version, label: '系统 TeX Live（兼容）', enabled: config.system?.enabled ?? true,
    binDir: config.system?.binDir || findSystemBin(), managed: false,
  } : describe(version, config);
  if (!allowDisabled && !item.enabled) throw new HttpError(409, `TeX Live ${version} 未由管理员启用`);
  if (!item.available && version !== 'system') throw new HttpError(409, `${item.label} 不可用：${item.error}。请联系管理员安装或配置。`);
  return { ...item, revision: getRuntimeResourceRevision(), env: runtimeEnvironment({ ...process.env, PATH: item.binDir ? item.binDir + path.delimiter + (process.env.PATH || '') : process.env.PATH }) };
}

export function texRepository(version) {
  validVersion(version, false);
  return texRepositories(version)[0];
}

async function downloadInstaller(repository, archive, { signal } = {}) {
  let failure;
  for (let attempt = 0; attempt < 2; attempt++) {
    signal?.throwIfAborted();
    try {
      const timeout = AbortSignal.timeout(120000);
      const response = await fetch(repository + '/install-tl-unx.tar.gz', { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      if (!response.ok || !response.body) throw new Error(`安装程序下载失败（HTTP ${response.status}）`);
      const fd = fs.openSync(archive, 'wx');
      let size = 0;
      try {
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > 32 * 1024 * 1024) throw new Error('安装程序超过 32 MB 限制');
          fs.writeSync(fd, chunk);
        }
      } finally { fs.closeSync(fd); }
      return;
    } catch (error) {
      fs.rmSync(archive, { force: true });
      signal?.throwIfAborted();
      failure = error;
    }
  }
  throw failure;
}

// Every destination, including system and per-user caches, stays on /data.
// A verified base is retained while component downloads retry or move to
// another verified mirror of the same TeX Live release.
export async function installTexVersion(version, { signal, onProgress = () => {} } = {}) {
  validVersion(version, false);
  if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch)) throw new HttpError(400, '自动安装目前支持 Linux x64/arm64');
  return withRuntimeInstallLock(async () => {
    const current = describe(version, readConfig());
    if (current.available) return { version, installed: true, alreadyInstalled: true, changed: false, enabled: current.enabled };
    const target = path.join(TEX_RUNTIME_ROOT, version);
    if (fs.existsSync(target)) {
      // Only our dedicated marker identifies a managed incomplete install.
      // Preserve the complete prior tree instead of deleting it; unknown or
      // symlinked directories are never moved or modified automatically.
      const previousMarker = path.join(target, '.corelatex-installing');
      let managedIncomplete = false;
      try {
        if (fs.lstatSync(target).isDirectory() && fs.lstatSync(previousMarker).isFile()) {
          const contents = fs.readFileSync(previousMarker, 'utf8');
          if (contents === 'incomplete') managedIncomplete = true; // original installer marker
          else {
            const record = JSON.parse(contents);
            managedIncomplete = record.protocol === 2 && record.version === version && typeof record.ownerId === 'string' && !!record.ownerId;
          }
        }
      } catch {}
      if (!managedIncomplete) throw new HttpError(409, '该版本目录已存在但不完整，请管理员检查目录后重试');
      fs.renameSync(target, path.join(TEX_RUNTIME_ROOT, '.interrupted-' + version + '-' + randomUUID()));
      onProgress(`已保留先前中断的 TeX Live ${version} 安装，正在重新开始`);
    }
    fs.mkdirSync(TEX_RUNTIME_ROOT, { recursive: true });
    const work = fs.mkdtempSync(path.join(TEX_RUNTIME_ROOT, '.install-' + version + '-'));
    const marker = path.join(target, '.corelatex-installing');
    const binDir = path.join(target, 'bin', platform);
    let complete = false, ownsTarget = false, published = false, baseInstalled = false;
    const errors = [];
    const requiredCollections = ['collection-xetex', 'collection-luatex', 'collection-fontsrecommended', 'collection-latexrecommended', 'collection-latexextra', 'collection-langchinese', 'collection-pictures', 'collection-mathscience', 'collection-publishers', 'collection-bibtexextra', 'biber'];
    const reportFailure = (repository, stage, error) => {
      const host = new URL(repository).hostname;
      const detail = String(error?.message || error || '未知错误').trim().slice(-900);
      // Keep the diagnostic for every attempt inside the job's 4KB error limit.
      errors.push(`${host} ${stage}：${detail.slice(-240)}`);
      onProgress(`${host} ${stage}失败：${detail}`);
    };
    const processFailure = result => {
      // Preserve stderr when stdout contains hundreds of successful package lines.
      const stderr = (result.stderr || '').trim().slice(-160);
      const stdout = (result.stdout || '').trim().slice(-50);
      return [stderr && 'stderr: ' + stderr, stdout && 'stdout: ' + stdout].filter(Boolean).join('；') ||
        (result.timedOut ? '安装超时' : `退出码 ${result.exitCode}`);
    };
    bumpRuntimeResourceRevision();
    try {
      const repositories = texRepositories(version);
      for (let index = 0; index < repositories.length; index++) {
        signal?.throwIfAborted();
        const repository = repositories[index];
        const host = new URL(repository).hostname;
        let attemptDir;
        try {
          onProgress(`正在检查 TeX Live ${version} 镜像（${index + 1}/${repositories.length}）：${host}`);
          await verifyTexRepository(version, repository, { signal });
          if (!baseInstalled) {
            attemptDir = fs.mkdtempSync(path.join(work, 'mirror-'));
            fs.mkdirSync(target);
            ownsTarget = true;
            fs.writeFileSync(marker, JSON.stringify({ protocol: 2, version, ownerId: currentRuntimeInstallOwnerId() }));
            onProgress(`正在下载安装程序：${host}`);
            const archive = path.join(attemptDir, 'installer.tar.gz');
            await downloadInstaller(repository, archive, { signal });
            const listing = await runProcess('tar', ['-tzf', archive], { signal, timeoutMs: 30000, maxOutputBytes: 4 * 1024 * 1024 });
            if (listing.exitCode !== 0 || listing.outputTruncated) throw new Error('无法校验安装程序压缩包');
            const entries = listing.stdout.trim().split('\n');
            if (entries.some(p => path.isAbsolute(p) || p.split('/').includes('..'))) throw new Error('安装程序包含非法路径');
            const extracted = await runProcess('tar', ['-xzf', archive, '--no-same-owner', '-C', attemptDir], { signal, timeoutMs: 30000 });
            if (extracted.exitCode !== 0) throw new Error('安装程序解压失败');
            const installerDir = fs.readdirSync(attemptDir).find(n => n.startsWith('install-tl-') && fs.existsSync(path.join(attemptDir, n, 'install-tl')));
            if (!installerDir) throw new Error('未找到官方 install-tl');
            const profile = path.join(attemptDir, 'install.profile');
            fs.writeFileSync(profile, `selected_scheme scheme-small
TEXDIR ${target}
TEXMFSYSVAR ${target}/texmf-var
TEXMFSYSCONFIG ${target}/texmf-config
TEXMFVAR ${target}/texmf-var
TEXMFCONFIG ${target}/texmf-config
TEXMFHOME ${target}/texmf-home
TEXMFLOCAL ${target}/texmf-local
option_doc 0
option_src 0
`);
            onProgress(`正在安装 TeX Live ${version}（${host}），下载时间取决于网络`);
            const result = await runProcess('perl', [path.join(attemptDir, installerDir, 'install-tl'), '-profile', profile, '-repository', repository, '-no-interaction'], { cwd: attemptDir, signal, timeoutMs: 60 * 60 * 1000, maxOutputBytes: 1024 * 1024 });
            if (result.exitCode !== 0) throw new Error(`TeX Live 基础安装失败：${processFailure(result)}`);
            // Never resume an installation on another mirror until its actual
            // base binary has been identified as the requested year.
            probeCache.clear();
            if (probe(binDir).detectedVersion !== version) throw new Error('基础安装的版本与请求不符');
            baseInstalled = true;
          } else {
            probeCache.clear();
            if (probe(binDir).detectedVersion !== version) throw new Error('已安装基础版本校验失败，无法继续');
          }

          let collectionsOK = false;
          for (let attempt = 1; attempt <= 2; attempt++) {
            signal?.throwIfAborted();
            onProgress(`正在安装 XeLaTeX、LuaLaTeX 与常用字体及宏包（${host}，第 ${attempt}/2 次）`);
            try {
              const env = runtimeEnvironment({ ...process.env, PATH: binDir + path.delimiter + process.env.PATH });
              const metadata = await runProcess(path.join(binDir, 'tlmgr'), ['--repository', repository, 'info', '--only-remote', '--data', 'name', ...requiredCollections], { signal, timeoutMs: 120000, env });
              if (metadata.exitCode !== 0) throw new Error('无法检查宏包集合：' + processFailure(metadata));
              const names = new Set(metadata.stdout.split(/\s+/));
              const missing = requiredCollections.filter(name => !names.has(name));
              if (missing.length) throw new Error('镜像缺少宏包集合：' + missing.join(', '));
              const collections = await runProcess(path.join(binDir, 'tlmgr'), ['--repository', repository, 'install', ...requiredCollections], { signal, timeoutMs: 60 * 60 * 1000, env });
              if (collections.exitCode !== 0) throw new Error(processFailure(collections));
              collectionsOK = true;
              break;
            } catch (error) {
              signal?.throwIfAborted();
              reportFailure(repository, `组件安装第 ${attempt}/2 次`, error);
            }
          }
          if (!collectionsOK) continue;
          const repositoryResult = await runProcess(path.join(binDir, 'tlmgr'), ['option', 'repository', repository], { signal, timeoutMs: 30000 });
          if (repositoryResult.exitCode !== 0) throw new Error('无法保存该版本的 TeX 包仓库：' + processFailure(repositoryResult));
          onProgress('正在验证三个编译引擎');
          const smoke = fs.mkdtempSync(path.join(work, 'smoke-'));
          fs.writeFileSync(path.join(smoke, 'main.tex'), String.raw`\documentclass{article}
\begin{document}CoreLatex runtime verification\end{document}`);
          for (const engine of ['pdflatex', 'xelatex', 'lualatex']) {
            const check = await runProcess(path.join(binDir, engine), ['-interaction=batchmode', '-halt-on-error', '-no-shell-escape', 'main.tex'], {
              cwd: smoke, signal, timeoutMs: 120000, env: runtimeEnvironment({ ...process.env, PATH: binDir + path.delimiter + process.env.PATH }),
            });
            if (check.exitCode !== 0 || !fs.existsSync(path.join(smoke, 'main.pdf'))) throw new Error(engine + ' 验证编译失败，未启用该版本：' + processFailure(check));
            fs.unlinkSync(path.join(smoke, 'main.pdf'));
          }
          probeCache.clear();
          if (probe(binDir).detectedVersion !== version) throw new Error('安装结果的版本与请求不符，未启用');
          fs.unlinkSync(marker);
          // Other server processes may use this now-complete directory as soon
          // as the marker disappears. Never delete it on a later config error.
          published = true;
          probeCache.clear();
          configureTexRuntime(version, { enabled: true, binDir });
          complete = true;
          onProgress(`TeX Live ${version} 已安装并启用`);
          return { version, installed: true, enabled: true, changed: true, repository };
        } catch (error) {
          signal?.throwIfAborted();
          if (published) throw error;
          reportFailure(repository, baseInstalled ? '继续安装' : '基础安装', error);
          // A verified base remains available for the next same-year mirror.
          // Delete only the target that this invocation created if the base
          // installation itself never passed its version check.
          if (!baseInstalled && ownsTarget) { fs.rmSync(target, { recursive: true, force: true }); ownsTarget = false; }
          probeCache.clear();
        } finally {
          if (attemptDir) fs.rmSync(attemptDir, { recursive: true, force: true });
        }
      }
      throw new Error('TeX Live 镜像下载失败或安装失败：' + errors.join('；'));
    } finally {
      if (!complete && ownsTarget && !published) fs.rmSync(target, { recursive: true, force: true });
      fs.rmSync(work, { recursive: true, force: true });
      probeCache.clear();
    }
  }, { blocksCompiles: false });
}
