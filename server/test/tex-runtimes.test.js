import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { api, registerAndLogin } from './helpers.js';

let root, db, resetDb, server, base, admin, member, configureTexRuntime, resolveTexRuntime, listTexRuntimes, texRepository, compileProject, previewCompileProject;
const bins = {};
before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'corelatex-runtimes-'));
  process.env.CORELATEX_DATA_DIR = root;
  const database = await import('../src/db.js'); db = database.getDb(); resetDb = database.resetDb;
  ({ configureTexRuntime, resolveTexRuntime, listTexRuntimes, texRepository } = await import('../src/services/texRuntimes.js'));
  ({ compileProject, previewCompileProject } = await import('../src/services/compile.js'));
  for (const version of ['2024', '2025']) {
    const bin = path.join(root, 'toolchains', version, 'bin'); bins[version] = bin; fs.mkdirSync(bin, { recursive: true });
    const body = `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');
if(process.argv.includes('--version')) { console.log('pdfTeX (TeX Live ${version})'); process.exit(0); }
const outputDirectory=process.argv.find(arg=>arg.startsWith('-output-directory=')).slice('-output-directory='.length);
const base=path.basename(process.argv.at(-1)).replace(/\\.tex$/i,'');
fs.mkdirSync(outputDirectory,{recursive:true});
fs.writeFileSync(path.join(outputDirectory,base+'.pdf'),'%PDF-${version}');
fs.writeFileSync(path.join(outputDirectory,base+'.log'),'Output written on '+base+'.pdf');
fs.writeFileSync(path.join(outputDirectory,'runtime.json'),JSON.stringify({version:'${version}',env:process.env.PATH,font:process.env.FONTCONFIG_FILE}));
`;
    for (const engine of ['pdflatex','xelatex','lualatex']) fs.writeFileSync(path.join(bin, engine), body, {mode:0o755});
  }
  const express = (await import('express')).default;
  const {requireAuth} = await import('../src/auth.js');
  const {HttpError} = await import('../src/util.js');
  const app=express(); app.use(express.json());
  app.use('/api/auth',(await import('../src/routes/auth.js')).default);
  app.use('/api/projects',requireAuth,(await import('../src/routes/projects.js')).default);
  app.use('/api/projects',requireAuth,(await import('../src/routes/compile.js')).default);
  app.use('/api',requireAuth,(await import('../src/routes/texRuntimes.js')).default);
  app.use((err,_req,res,_next)=>res.status(err instanceof HttpError?err.status:500).json({error:err.message}));
  server=app.listen(0,'127.0.0.1');await new Promise(r=>server.on('listening',r));base=`http://127.0.0.1:${server.address().port}`;
  admin=await registerAndLogin(base,'admin');member=await registerAndLogin(base,'member');
});
after(async()=>{await new Promise(r=>server.close(r));resetDb();fs.rmSync(root,{recursive:true,force:true});});

test('new projects explicitly default2024; legacy rows retain system runtime',async()=>{
  const r=await api(base,'POST','/api/projects',{token:admin.token,body:{name:'default'}});
  assert.equal(r.status,201);assert.equal(r.data.project.texVersion,'2024');
  const legacy=db.prepare('INSERT INTO projects(name,owner_id) VALUES(?,?)').run('legacy',admin.user.id);
  assert.equal(db.prepare('SELECT tex_version FROM projects WHERE id=?').get(legacy.lastInsertRowid).tex_version,'system');
});
test('only administrators can configure; ordinary catalog omits executable paths',async()=>{
  let r=await api(base,'PATCH','/api/admin/tex/runtimes/2024',{token:member.token,body:{enabled:true,binDir:bins['2024']}});assert.equal(r.status,403);
  r=await api(base,'PATCH','/api/admin/tex/runtimes/2024',{token:admin.token,body:{enabled:true,binDir:bins['2024']}});assert.equal(r.status,200);
  r=await api(base,'GET','/api/tex/runtimes',{token:member.token});assert.equal(r.status,200);
  const item=r.data.versions.find(x=>x.version==='2024');assert.equal(item.available,true);assert.equal(item.enabled,true);assert.equal('binDir' in item,false);
  const runtime=resolveTexRuntime('2024');assert.equal(runtime.binDir,bins['2024']);assert.ok(runtime.env.PATH.startsWith(bins['2024']));assert.ok(runtime.env.FONTCONFIG_FILE.startsWith(root));
});
test('rejects mismatched, missing, disabled and arbitrary version labels',()=>{
  assert.throws(()=>configureTexRuntime('2025',{enabled:true,binDir:bins['2024']}),/实际是/);
  assert.throws(()=>configureTexRuntime('2025',{enabled:true,binDir:path.join(root,'missing')}),/不存在/);
  configureTexRuntime('2025',{enabled:false,binDir:bins['2025']});
  assert.throws(()=>resolveTexRuntime('2025'),/未由管理员启用/);
  assert.throws(()=>resolveTexRuntime('../../bin'),/不支持/);
  assert.throws(()=>configureTexRuntime('2024',{binDir:'relative'}),/绝对路径/);
  assert.match(texRepository('2024'),/2024\/tlnet-final$/);
});
test('formal and staged preview execute the selected absolute binary with its PATH',async()=>{
  configureTexRuntime('2025',{enabled:true,binDir:bins['2025']});
  const created=await api(base,'POST','/api/projects',{token:admin.token,body:{name:'versioned'}});
  const project=db.prepare('SELECT * FROM projects WHERE id=?').get(created.data.project.id);
  const user=db.prepare('SELECT * FROM users WHERE id=?').get(admin.user.id);
  const result=await compileProject({project,user,texVersion:'2025'});
  assert.equal(result.status,'success');assert.equal(result.texVersion,'2025');
  const pdf = await api(base, 'GET', result.pdfUrl, { token: admin.token, raw: true });
  assert.equal(pdf.status, 200);
  assert.match(await pdf.text(), /2025/);
  assert.equal(db.prepare('SELECT tex_version FROM compile_jobs WHERE id=?').get(result.jobId).tex_version,'2025');
  const preview=await previewCompileProject({project,user,texVersion:'2024',staged:[{path:'main.tex',after:'preview content'}]});
  assert.equal(preview.ok,true);assert.equal(preview.texVersion,'2024');
  assert.match(fs.readFileSync(preview.pdfPath,'utf8'),/2024/);
  assert.equal(db.prepare('SELECT tex_version FROM projects WHERE id=?').get(project.id).tex_version,'2024');
});
test('version choice compile endpoint persists only successful selection and rejects unauthorized access',async()=>{
  const created=await api(base,'POST','/api/projects',{token:admin.token,body:{name:'select'}});const id=created.data.project.publicId;
  let r=await api(base,'POST',`/api/projects/${id}/compile`,{token:member.token,body:{texVersion:'2025'}});assert.equal(r.status,403);
  r=await api(base,'POST',`/api/projects/${id}/compile`,{token:admin.token,body:{texVersion:'2025'}});assert.equal(r.status,200);assert.equal(r.data.texVersion,'2025');
  r=await api(base,'GET',`/api/projects/${id}`,{token:admin.token});assert.equal(r.data.project.texVersion,'2025');
  configureTexRuntime('2025',{enabled:false});
  r=await api(base,'POST',`/api/projects/${id}/compile`,{token:admin.token,body:{texVersion:'2025'}});assert.equal(r.status,409);
});

test('official installer stages persistent paths, verifies engines, pins repository and survives DB reopen',async()=>{
  const { execFileSync } = await import('node:child_process');
  const { installTexVersion, TEX_RUNTIME_ROOT } = await import('../src/services/texRuntimes.js');
  const fixture=path.join(root,'official-fixture'); fs.mkdirSync(path.join(fixture,'install-tl-test'),{recursive:true});
  fs.writeFileSync(path.join(fixture,'install-tl-test','install-tl'), String.raw`
use File::Path qw(make_path);
my $profile;
for(my $i=0;$i<@ARGV;$i++) { $profile=$ARGV[$i+1] if $ARGV[$i] eq '-profile'; }
open(my $fh, '<', $profile) or die $!;
my %vars;
while(<$fh>) { $vars{$1}=$2 if /^(TEX(?:DIR|MF[A-Z]+)) (.+)$/; }
my $dir=$vars{'TEXDIR'};
for my $name ('TEXMFSYSVAR','TEXMFSYSCONFIG','TEXMFVAR','TEXMFCONFIG','TEXMFHOME','TEXMFLOCAL') {
  die "missing or non-persistent $name" unless $vars{$name} && index($vars{$name}, "$dir/") == 0;
}
my ($year)=$dir =~ /(\d{4})$/; die 'missing year' unless $year;
$year = $ENV{CORELATEX_FIXTURE_WRONG_VERSION} || $year;
if ($ENV{CORELATEX_FIXTURE_COUNTER}) {
  open(my $counter, '>>', $ENV{CORELATEX_FIXTURE_COUNTER}) or die $!;
  print $counter "$dir\n"; close($counter);
}
my $arch=$ENV{CORELATEX_TEST_ARCH} || 'x86_64-linux';
make_path("$dir/bin/$arch");
for my $engine ('pdflatex','xelatex','lualatex') {
  open(my $out, '>', "$dir/bin/$arch/$engine") or die $!;
  print $out "#!/bin/sh\nif [ \"\$1\" = \"--version\" ]; then echo '(TeX Live $year)'; else printf 'pdf' > main.pdf; fi\n";
  close($out); chmod 0755, "$dir/bin/$arch/$engine";
}
open(my $mgr, '>', "$dir/bin/$arch/tlmgr") or die $!;
print $mgr "#!/bin/sh\nprintf '%s\\n' \"\$*\" >> '$dir/tlmgr.calls'\n";
print $mgr "fixture_root='$dir'\n";
print $mgr <<'EOS';
if [ -n "$CORELATEX_FIXTURE_LOG" ]; then printf '%s\n' "$*" >> "$CORELATEX_FIXTURE_LOG"; fi
if [ "$3" = info ]; then
  shift 6
  for pkg in "$@"; do
    case "$pkg" in
      collection-xetex|collection-luatex|collection-fontsrecommended|collection-latexrecommended|collection-latexextra|collection-langchinese|collection-pictures|collection-mathscience|collection-publishers|collection-bibtexextra|biber)
        if [ "$pkg" != "$CORELATEX_FIXTURE_MISSING" ]; then printf '%s\n' "$pkg"; fi ;;
      *) echo "unknown package: $pkg" >&2 ;;
    esac
  done
  exit 0
fi
if [ "$3" = install ]; then
  case "$CORELATEX_FIXTURE_MODE:$2" in
    fallback:*nju.edu.cn*)
      printf 'partial' > "$fixture_root/.partial-marker"
      echo 'primary diagnostic on stderr' >&2
      printf '%010000d\n' 1
      exit 1 ;;
    fallback:*ftp.math.utah.edu*)
      if [ ! -f "$fixture_root/.partial-marker" ]; then echo 'missing partial data' >&2; exit 1; fi ;;
    fail:*)
      printf 'partial' > "$fixture_root/.partial-marker"
      echo "diagnostic for $2" >&2
      printf '%010000d\n' 1
      exit 1 ;;
  esac
fi
exit 0
EOS
close($mgr); chmod 0755, "$dir/bin/$arch/tlmgr";
`);
  const tar=path.join(fixture,'installer.tar.gz');execFileSync('tar',['-czf',tar,'-C',fixture,'install-tl-test']);
  const bytes=fs.readFileSync(tar), originalFetch=globalThis.fetch, progress=[];
  let installerAttempts=0;
  globalThis.fetch=async(url)=>{
    if (url.endsWith('/tlpkg/texlive.tlpdb')) return new Response('name 00texlive.config\ndepend release/2023\n\n');
    assert.equal(url,texRepository('2023')+'/install-tl-unx.tar.gz');
    installerAttempts++;
    return installerAttempts===1 ? new Response('temporary outage',{status:503}) : new Response(bytes);
  };
  try {
    const result=await installTexVersion('2023',{onProgress:text=>progress.push(text)});
    assert.equal(result.changed,true);assert.equal(result.enabled,true);
    const installed=resolveTexRuntime('2023');assert.ok(installed.binDir.startsWith(path.join(TEX_RUNTIME_ROOT,'2023')));
    assert.equal(fs.existsSync(path.join(TEX_RUNTIME_ROOT,'2023','.corelatex-installing')),false);
    assert.equal(installerAttempts,2);
    const calls=fs.readFileSync(path.join(TEX_RUNTIME_ROOT,'2023','tlmgr.calls'),'utf8');
    assert.match(calls,/option repository https:\/\/mirror\.nju\.edu\.cn/);
    assert.match(calls,/collection-mathscience/);
    assert.doesNotMatch(calls,/collection-science(?:\s|$)/);
    assert.ok(progress.some(text=>text.includes('三个编译引擎')));
    assert.equal((await installTexVersion('2023')).changed,false);
    resetDb();db=(await import('../src/db.js')).getDb();assert.equal(resolveTexRuntime('2023').available,true);
  } finally {globalThis.fetch=originalFetch;}
});

test('wrong-year mirror is skipped and the matching historical fallback is pinned',async()=>{
  const {installTexVersion,TEX_RUNTIME_ROOT}=await import('../src/services/texRuntimes.js');
  const bytes=fs.readFileSync(path.join(root,'official-fixture','installer.tar.gz'));
  const originalFetch=globalThis.fetch, requested=[];
  globalThis.fetch=async(url)=>{
    requested.push(url);
    if (url.endsWith('/tlpkg/texlive.tlpdb')) {
      return new Response('name 00texlive.config\ndepend release/'+(url.includes('nju.edu.cn')?'2024':'2022')+'\n\n');
    }
    assert.match(url,/ftp\.math\.utah\.edu/);
    return new Response(bytes);
  };
  try {
    const installed=await installTexVersion('2022');
    assert.equal(installed.version,'2022');
    assert.match(installed.repository,/ftp\.math\.utah\.edu.*2022/);
    assert.equal(resolveTexRuntime('2022').available,true);
    assert.equal(requested.filter(url=>url.endsWith('/tlpkg/texlive.tlpdb')).length,2);
    assert.equal(requested.some(url=>url.includes('nju.edu.cn')&&url.endsWith('/install-tl-unx.tar.gz')),false);
    assert.match(fs.readFileSync(path.join(TEX_RUNTIME_ROOT,'2022','tlmgr.calls'),'utf8'),/option repository https:\/\/ftp\.math\.utah\.edu/);
  } finally {globalThis.fetch=originalFetch;}
});

test('failed network installation removes only its partial version and releases install lock',async()=>{
  const {installTexVersion,TEX_RUNTIME_ROOT}=await import('../src/services/texRuntimes.js');
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async()=>new Response('offline',{status:503});
  try {
    await assert.rejects(installTexVersion('2026'),/下载失败/);
    assert.equal(fs.existsSync(path.join(TEX_RUNTIME_ROOT,'2026')),false);
    assert.equal(fs.existsSync(path.join(root,'runtime','install.lock')),false);
    assert.equal(resolveTexRuntime('2023').available,true);
    assert.equal(listTexRuntimes().versions.find(x=>x.version==='2026').enabled,false);
  } finally {globalThis.fetch=originalFetch;}
});

test('collection retries retain the validated base and use the next same-year mirror without reinstalling',async()=>{
  const {installTexVersion,TEX_RUNTIME_ROOT}=await import('../src/services/texRuntimes.js');
  const {getTexMirrorConfig,saveTexMirrorConfig}=await import('../src/services/texMirrors.js');
  const originalConfig=getTexMirrorConfig(), originalFetch=globalThis.fetch;
  const counter=path.join(root,'fallback-base.calls'), log=path.join(root,'fallback-tlmgr.calls');
  const bytes=fs.readFileSync(path.join(root,'official-fixture','installer.tar.gz')), progress=[], archiveRequests=[];
  process.env.CORELATEX_FIXTURE_MODE='fallback';process.env.CORELATEX_FIXTURE_COUNTER=counter;process.env.CORELATEX_FIXTURE_LOG=log;
  saveTexMirrorConfig({current:['https://mirror.nju.edu.cn/current','https://ftp.math.utah.edu/current'],historic:originalConfig.historic});
  globalThis.fetch=async(url)=>{
    if (url.endsWith('/tlpkg/texlive.tlpdb')) return new Response('name 00texlive.config\ndepend release/2026\n\n');
    archiveRequests.push(url);return new Response(bytes);
  };
  try {
    const result=await installTexVersion('2026',{onProgress:text=>progress.push(text)});
    assert.match(result.repository,/ftp\.math\.utah\.edu/);
    assert.equal(archiveRequests.length,1,'the base installer must not be downloaded twice');
    assert.equal(fs.readFileSync(counter,'utf8').trim().split('\n').length,1,'the base installer must execute once');
    const calls=fs.readFileSync(log,'utf8').trim().split('\n');
    assert.equal(calls.filter(line=>line.includes('nju.edu.cn')&&line.includes(' install ')).length,2);
    assert.equal(calls.filter(line=>line.includes('ftp.math.utah.edu')&&line.includes(' install ')).length,1);
    assert.ok(progress.some(line=>line.includes('primary diagnostic on stderr')), 'first error should remain visible despite large stdout');
    assert.equal(fs.existsSync(path.join(TEX_RUNTIME_ROOT,'2026','.partial-marker')),true,'partial downloads retained');
    assert.equal(resolveTexRuntime('2026').available,true);
  } finally {
    globalThis.fetch=originalFetch;saveTexMirrorConfig(originalConfig);
    delete process.env.CORELATEX_FIXTURE_MODE;delete process.env.CORELATEX_FIXTURE_COUNTER;delete process.env.CORELATEX_FIXTURE_LOG;
  }
});

test('all mirrors failing reports every stderr and cleans only this version',async()=>{
  const {installTexVersion,TEX_RUNTIME_ROOT}=await import('../src/services/texRuntimes.js');
  const originalFetch=globalThis.fetch, progress=[], log=path.join(root,'all-fail-tlmgr.calls'), counter=path.join(root,'all-fail-base.calls');
  const bytes=fs.readFileSync(path.join(root,'official-fixture','installer.tar.gz'));
  const other=path.join(TEX_RUNTIME_ROOT,'2023','tlmgr.calls'), before=fs.readFileSync(other,'utf8');
  configureTexRuntime('2025',{enabled:false,binDir:path.join(root,'missing-2025')});
  process.env.CORELATEX_FIXTURE_MODE='fail';process.env.CORELATEX_FIXTURE_LOG=log;process.env.CORELATEX_FIXTURE_COUNTER=counter;
  globalThis.fetch=async(url)=>url.endsWith('/tlpkg/texlive.tlpdb')
    ? new Response('name 00texlive.config\ndepend release/2025\n\n') : new Response(bytes);
  try {
    await assert.rejects(installTexVersion('2025',{onProgress:text=>progress.push(text)}), error=>{
      assert.match(error.message,/diagnostic for https:\/\/mirror\.nju\.edu\.cn/);
      assert.match(error.message,/diagnostic for https:\/\/ftp\.math\.utah\.edu/);
      return true;
    });
    assert.equal(fs.readFileSync(counter,'utf8').trim().split('\n').length,1);
    assert.equal(fs.readFileSync(log,'utf8').split('\n').filter(line=>line.includes(' install ')).length,4);
    assert.ok(progress.some(line=>line.includes('diagnostic for https://mirror.nju.edu.cn')));
    assert.equal(fs.existsSync(path.join(TEX_RUNTIME_ROOT,'2025')),false);
    assert.equal(fs.existsSync(path.join(root,'runtime','install.lock')),false);
    assert.equal(fs.readFileSync(other,'utf8'),before);
    assert.equal(resolveTexRuntime('2023').available,true);
  } finally {
    globalThis.fetch=originalFetch;
    delete process.env.CORELATEX_FIXTURE_MODE;delete process.env.CORELATEX_FIXTURE_COUNTER;delete process.env.CORELATEX_FIXTURE_LOG;
  }
});

test('missing required collection is detected before any package download',async()=>{
  const {installTexVersion,TEX_RUNTIME_ROOT}=await import('../src/services/texRuntimes.js');
  const originalFetch=globalThis.fetch, log=path.join(root,'missing-tlmgr.calls');
  const bytes=fs.readFileSync(path.join(root,'official-fixture','installer.tar.gz'));
  configureTexRuntime('2024',{enabled:false,binDir:path.join(root,'missing-2024')});
  process.env.CORELATEX_FIXTURE_MISSING='collection-mathscience';process.env.CORELATEX_FIXTURE_LOG=log;
  globalThis.fetch=async(url)=>url.endsWith('/tlpkg/texlive.tlpdb')
    ? new Response('name 00texlive.config\ndepend release/2024\n\n') : new Response(bytes);
  try {
    await assert.rejects(installTexVersion('2024'),/镜像缺少宏包集合：collection-mathscience/);
    assert.equal(fs.readFileSync(log,'utf8').split('\n').filter(line=>line.includes(' install ')).length,0);
    assert.equal(fs.existsSync(path.join(TEX_RUNTIME_ROOT,'2024')),false);
  } finally {
    globalThis.fetch=originalFetch;delete process.env.CORELATEX_FIXTURE_MISSING;delete process.env.CORELATEX_FIXTURE_LOG;
    configureTexRuntime('2024',{enabled:true,binDir:bins['2024']});
  }
});

test('wrong-version base cannot enter collection retry or be published',async()=>{
  const {installTexVersion,TEX_RUNTIME_ROOT}=await import('../src/services/texRuntimes.js');
  const originalFetch=globalThis.fetch, log=path.join(root,'wrong-base-tlmgr.calls');
  const bytes=fs.readFileSync(path.join(root,'official-fixture','installer.tar.gz'));
  configureTexRuntime('2025',{enabled:false,binDir:path.join(root,'missing-2025')});
  process.env.CORELATEX_FIXTURE_WRONG_VERSION='2024';process.env.CORELATEX_FIXTURE_LOG=log;
  globalThis.fetch=async(url)=>url.endsWith('/tlpkg/texlive.tlpdb')
    ? new Response('name 00texlive.config\ndepend release/2025\n\n') : new Response(bytes);
  try {
    await assert.rejects(installTexVersion('2025'),/基础安装的版本与请求不符/);
    assert.equal(fs.existsSync(log),false,'no tlmgr may run for a wrong-version base');
    assert.equal(fs.existsSync(path.join(TEX_RUNTIME_ROOT,'2025')),false);
    assert.equal(resolveTexRuntime('2023').available,true);
  } finally {
    globalThis.fetch=originalFetch;delete process.env.CORELATEX_FIXTURE_WRONG_VERSION;delete process.env.CORELATEX_FIXTURE_LOG;
  }
});

test('compile requests wait for a complete runtime instead of racing its installer',async()=>{
  const {withRuntimeInstallLock}=await import('../src/services/runtimeEnvironment.js');
  const project=db.prepare('SELECT * FROM projects LIMIT 1').get();
  const user=db.prepare('SELECT * FROM users WHERE id=?').get(admin.user.id);
  await withRuntimeInstallLock(async()=>{
    assert.throws(()=>compileProject({project,user,texVersion:'2024'}),/安装|维护|环境/);
  });
});

test('independent version installation does not block other compiles but still blocks maintenance and resource installs',async()=>{
  const {withRuntimeInstallLock,assertRuntimeReady}=await import('../src/services/runtimeEnvironment.js');
  const project=db.prepare('SELECT * FROM projects LIMIT 1').get();
  const user=db.prepare('SELECT * FROM users WHERE id=?').get(admin.user.id);
  await withRuntimeInstallLock(async()=>{
    assert.throws(()=>assertRuntimeReady(),/安装/);
    assert.doesNotThrow(()=>assertRuntimeReady({allowIndependentInstall:true}));
    await assert.rejects(withRuntimeInstallLock(async()=>{}),/安装/);
    const compile=await compileProject({project,user,texVersion:'2024'});
    assert.equal(compile.status,'success');
  },{blocksCompiles:false});
});
