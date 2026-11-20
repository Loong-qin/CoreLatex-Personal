/**
 * 端到端冒烟：起真实服务器（临时数据目录）→ 注册→登录→建项目→写文件→真实编译→PDF→
 * synctex→统计→版本→审阅→管理统计。任何一步失败即退出码 1。
 * 用法：node scripts/smoke.js [--keep]
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const keep = process.argv.includes('--keep');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'corelatex-smoke-'));
process.env.CORELATEX_DATA_DIR = dataDir;

const steps = [];
async function step(name, fn) {
  process.stdout.write(`→ ${name} ... `);
  try {
    await fn();
    console.log('OK');
    steps.push([name, 'OK']);
  } catch (e) {
    console.log('FAIL');
    console.error(`  ${e.message}`);
    steps.push([name, 'FAIL']);
    process.exitCode = 1;
    throw e;
  }
}

async function api(base, method, p, { token, body, raw } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${base}${p}`, { method, headers, body: payload });
  if (raw) return res;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status}: ${data.error || JSON.stringify(data)}`);
  return data;
}

const assert = (cond, msg) => { if (!cond) throw new Error(`断言失败: ${msg}`); };

async function main() {
  const { startServer } = await import('../server/src/index.js');
  const server = startServer(0, '127.0.0.1');
  await new Promise((r) => server.on('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  console.log(`冒烟服务器 ${base}（数据目录 ${dataDir}）\n`);

  let token, pid;
  try {
    await step('注册首个用户（应为管理员）', async () => {
      const r = await api(base, 'POST', '/api/auth/register', { body: { username: 'smokeadmin', password: 'smoke123', displayName: 'Smoke' } });
      assert(r.user.role === 'admin', '首用户角色应为 admin');
      const l = await api(base, 'POST', '/api/auth/login', { body: { username: 'smokeadmin', password: 'smoke123' } });
      token = l.token;
    });

    await step('子智能体模型及思考强度配置', async () => {
      // 本地占位配置仅验证设置接口，不会连接模型服务。
      await api(base, 'PUT', '/api/settings/ai', { token, body: {
        providers: [{
          id: 'smoke-provider', name: 'Smoke fixture', apiFormat: 'openai',
          baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'smoke-fixture-only', enabled: true,
          models: [
            { id: 'smoke-main', model: 'smoke-main', name: 'Smoke main', enabled: true, reasoningLevels: ['low', 'high'] },
            { id: 'smoke-worker', model: 'smoke-worker', name: 'Smoke worker', enabled: true, reasoningLevels: ['low', 'high'] },
          ],
        }],
        activeModelId: 'smoke-main',
        agentConfig: { graphOrchestration: true, subagentModelId: 'smoke-worker', subagentReasoningEffort: 'high' },
      } });
      const settings = await api(base, 'GET', '/api/settings/ai', { token });
      assert(settings.activeModelId === 'smoke-main', '主模型不应被子智能体配置改变');
      assert(settings.agentConfig?.graphOrchestration === true, '多智能体配置应保存');
      assert(settings.agentConfig?.subagentModelId === 'smoke-worker', '子智能体模型应保存');
      assert(settings.agentConfig?.subagentReasoningEffort === 'high', '子智能体思考强度应保存');
      assert(!JSON.stringify(settings).includes('smoke-fixture-only'), '模型密钥不应原样返回');
    });

    await step('TeX 镜像配置读写', async () => {
      const original = await api(base, 'GET', '/api/admin/runtime-resources/tex-mirrors', { token });
      assert(original.current?.length && original.historic?.length, '默认镜像应包含当前与历史源');
      const sample = {
        current: ['https://mirror.example.org/current', 'https://backup.example.org/current'],
        historic: ['https://mirror.example.org/tex/{year}/tlnet-final', 'https://backup.example.org/tex/{year}/tlnet-final'],
      };
      const saved = await api(base, 'PUT', '/api/admin/runtime-resources/tex-mirrors', { token, body: sample });
      assert(JSON.stringify(saved) === JSON.stringify(sample), '多镜像配置保存应返回相同内容');
      const readback = await api(base, 'GET', '/api/admin/runtime-resources/tex-mirrors', { token });
      assert(JSON.stringify(readback) === JSON.stringify(sample), '多镜像配置应持久化');
      await api(base, 'PUT', '/api/admin/runtime-resources/tex-mirrors', { token, body: original });
    });

    await step('创建项目（默认 TeX Live 2024）', async () => {
      const r = await api(base, 'POST', '/api/projects', { token, body: { name: 'smoke-paper' } });
      pid = r.project.publicId;
      assert(r.project.texVersion === '2024', `新项目 TeX 版本 ${r.project.texVersion}`);
    });

    await step('检查系统 TeX 运行环境', async () => {
      const r = await api(base, 'GET', '/api/tex/runtimes', { token });
      const system = r.versions?.find(item => item.version === 'system');
      assert(r.defaultVersion === '2024', `默认 TeX 版本 ${r.defaultVersion}`);
      assert(system?.enabled && system?.available, '系统 TeX 应可用并启用');
      for (const version of ['2022', '2024', '2026']) {
        assert(r.versions?.some(item => item.version === version), `版本目录应包含 ${version}`);
      }
    });

    await step('保存编译器及版本设置（不触发编译）', async () => {
      const jobsBefore = await api(base, 'GET', `/api/projects/${pid}/compile/jobs`, { token });
      const saved = await api(base, 'PATCH', `/api/projects/${pid}/compile/settings`, {
        token, body: { engine: 'xelatex', texVersion: 'system' },
      });
      assert(saved.engine === 'xelatex' && saved.texVersion === 'system', '接口应返回已保存设置');
      const project = await api(base, 'GET', `/api/projects/${pid}`, { token });
      assert(project.project?.compileEngine === 'xelatex', '项目应保存 XeLaTeX 引擎');
      assert(project.project?.texVersion === 'system', '项目应保存系统 TeX 版本');
      const jobsAfter = await api(base, 'GET', `/api/projects/${pid}/compile/jobs`, { token });
      assert(jobsBefore.jobs.length === 0 && jobsAfter.jobs.length === 0, '保存设置不应触发编译');
    });

    const tex = `\\documentclass{article}
\\title{Smoke Test}
\\begin{document}
\\maketitle
\\section{Introduction}
Hello CoreLatex, this is a smoke test with math $E=mc^2$.
\\begin{equation} x^2 + y^2 = z^2 \\end{equation}
\\begin{figure}\\caption{A figure}\\end{figure}
\\end{document}
`;
    await step('写入 main.tex', async () => {
      await api(base, 'POST', `/api/projects/${pid}/files`, { token, body: { path: 'main.tex', content: tex, overwrite: true } });
    });

    await step('真实编译（系统 TeX / xelatex）', async () => {
      // 新项目默认 2024，但运行环境未必已安装该年度；显式验证系统编译器。
      const r = await api(base, 'POST', `/api/projects/${pid}/compile`, { token, body: { engine: 'xelatex', texVersion: 'system', persistSelection: false } });
      assert(r.status === 'success', `编译状态 ${r.status}，错误：${JSON.stringify(r.errors?.slice(0, 2))}`);
      assert(r.texVersion === 'system', `实际使用的 TeX 版本 ${r.texVersion}`);
      const project = await api(base, 'GET', `/api/projects/${pid}`, { token });
      assert(project.project?.texVersion === 'system', `编译后的项目 TeX 版本 ${project.project?.texVersion}`);
    });

    await step('获取 PDF', async () => {
      const res = await api(base, 'GET', `/api/projects/${pid}/pdf`, { token, raw: true });
      const buf = Buffer.from(await res.arrayBuffer());
      assert(buf.slice(0, 5).toString() === '%PDF-', 'PDF 魔数');
    });

    await step('SyncTeX 双向定位', async () => {
      const fwd = await api(base, 'GET', `/api/projects/${pid}/synctex/code?file=main.tex&line=5&col=1`, { token });
      assert(fwd.page >= 1, `正向 page=${fwd.page}`);
      const back = await api(base, 'GET', `/api/projects/${pid}/synctex/pdf?page=1&x=100&y=200`, { token });
      assert(back.file && back.line >= 1, `反向 ${JSON.stringify(back)}`);
    });

    await step('项目统计', async () => {
      const s = await api(base, 'GET', `/api/projects/${pid}/stats`, { token });
      assert(s.words > 0 && s.headings >= 1 && s.inlineMath >= 1 && s.displayMath >= 1 && s.figuresAndTables >= 1,
        JSON.stringify(s));
    });

    await step('版本快照与恢复', async () => {
      const v = await api(base, 'POST', `/api/projects/${pid}/versions`, { token, body: { message: 'smoke v1' } });
      assert(v.version?.id || v.id, '版本已创建');
      const list = await api(base, 'GET', `/api/projects/${pid}/versions`, { token });
      assert(list.versions.length >= 1, '版本列表');
      await api(base, 'POST', `/api/projects/${pid}/files`, {
        token, body: { path: 'main.tex', content: 'Changed after snapshot', overwrite: true },
      });
      await api(base, 'POST', `/api/projects/${pid}/versions/${v.version?.id || v.id}/restore`, { token });
      const restored = await api(base, 'GET', `/api/projects/${pid}/file?path=main.tex`, { token, raw: true });
      assert(await restored.text() === tex, '恢复后的内容应等于快照');
    });

    await step('审阅意见生命周期', async () => {
      const r = await api(base, 'POST', `/api/projects/${pid}/reviews`, {
        token, body: { filePath: 'main.tex', start: 60, end: 70, quotedText: 'smoke test', content: '这里需要润色' },
      });
      const rid = r.review?.id || r.id;
      assert(rid, '创建审阅');
      await api(base, 'POST', `/api/projects/${pid}/reviews/${rid}/replies`, { token, body: { content: 'Smoke verified' } });
      await api(base, 'POST', `/api/projects/${pid}/reviews/${rid}/resolve`, { token });
      const list = await api(base, 'GET', `/api/projects/${pid}/reviews`, { token });
      assert(list.reviews[0].status === 'done', '已完成状态');
    });

    await step('管理统计', async () => {
      const s = await api(base, 'GET', '/api/admin/stats', { token });
      assert(s.projectCount >= 1 && s.userCount >= 1, JSON.stringify(s));
    });

    await step('导出项目 zip', async () => {
      const res = await api(base, 'GET', `/api/projects/${pid}/export`, { token, raw: true });
      const buf = Buffer.from(await res.arrayBuffer());
      assert(buf.slice(0, 2).toString() === 'PK', 'zip 魔数');
    });
  } finally {
    await new Promise((r) => server.close(r));
    if (!keep) fs.rmSync(dataDir, { recursive: true, force: true });
    console.log(keep ? `\n数据保留于 ${dataDir}` : '\n临时数据已清理');
    const failed = steps.filter(([, s]) => s === 'FAIL');
    console.log(`\n冒烟结果：${steps.length - failed.length}/${steps.length} 通过`);
  }
}

main().catch(() => { process.exitCode = 1; });
