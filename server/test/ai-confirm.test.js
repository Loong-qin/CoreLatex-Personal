import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { startTestServer, api, registerAndLogin } from './helpers.js';

/**
 * confirmBeforeApply（确认后应用）测试：
 * 开启后 agent 产生的 changeset 不写盘（applied=false），
 * accept 才把 after 写盘，revert 仅标记不写盘；默认关闭时维持自动应用。
 */

let srv;
let baseUrl;
let dataDir;
let llm;
let llmBase;
let user;
let pid;
let diskId;
let chatId;

const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

function startMockLlm() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let json = {};
        try { json = JSON.parse(body || '{}'); } catch { /* ignore */ }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const msgs = json.messages || [];
        if (msgs.some((m) => m.role === 'tool')) {
          return res.end(
            sse({ choices: [{ index: 0, delta: { content: '已完成' } }] })
            + sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
            + 'data: [DONE]\n\n'
          );
        }
        const last = [...msgs].reverse().find((m) => m.role === 'user' && typeof m.content === 'string' && !/^【系统便签|^【用户当前打开的文件】|^【稿件参考资料】/.test(m.content))?.content || '';
        const m = /([\w-]+\.txt)/.exec(last);
        const args = JSON.stringify({ path: m ? m[1] : 'a.txt', content: 'mock content\n' });
        res.end(
          sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'write_file', arguments: args } }] } }] })
          + sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
          + 'data: [DONE]\n\n'
        );
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function readSSE(url, { token, body }) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 200);
  const events = [];
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, i);
      buf = buf.slice(i + 2);
      for (const line of raw.split('\n')) {
        if (line.startsWith('data: ')) events.push(JSON.parse(line.slice(6)));
      }
    }
  }
  return events;
}

function projectFile(rel) {
  return path.join(dataDir, 'projects', String(diskId), rel);
}

async function chat(message) {
  const events = await readSSE(`${baseUrl}/api/projects/${pid}/agent/chat`, {
    token: user.token, body: { chatId, message },
  });
  assert.equal(events[events.length - 1].type, 'done');
  assert.equal(events.findLast((event) => event.type === 'workflow')?.graph.status, 'completed');
  assert.equal(events.some((event) => event.type === 'tool' && event.name === 'compile_and_preview'), false, '文本文件确认测试不应引入排版编译');
  return events;
}

async function setConfirm(on) {
  const r = await api(baseUrl, 'PUT', '/api/settings/ai', {
    token: user.token,
    body: { agentConfig: { confirmBeforeApply: on } },
  });
  assert.equal(r.status, 200);
}

before(async () => {
  llm = await startMockLlm();
  llmBase = `http://127.0.0.1:${llm.address().port}`;
  srv = await startTestServer();
  baseUrl = srv.baseUrl;
  dataDir = srv.dataDir;
  user = await registerAndLogin(baseUrl, 'confirmuser');
  const p = await api(baseUrl, 'POST', '/api/projects', { token: user.token, body: { name: 'confirm-proj' } });
  pid = p.data.project.publicId;
  diskId = p.data.project.id;
  const s = await api(baseUrl, 'PUT', '/api/settings/ai', {
    token: user.token,
    body: { provider: 'openai', baseUrl: `${llmBase}/v1`, apiKey: 'sk-test', model: 'gpt-mock' },
  });
  assert.equal(s.status, 200);
  const c = await api(baseUrl, 'POST', `/api/projects/${pid}/chats`, { token: user.token, body: {} });
  chatId = c.data.id;
});

after(async () => {
  await srv?.close();
  llm?.close();
});

test('默认（未开启）：changeset 自动应用写盘，applied=true', async () => {
  const events = await chat('请创建 auto.txt');
  const cs = events.find((e) => e.type === 'changeset')?.changeset;
  assert.ok(cs, '缺 changeset 事件');
  assert.equal(cs.applied, true);
  assert.equal(cs.status, 'pending');
  assert.equal(fs.readFileSync(projectFile('auto.txt'), 'utf8'), 'mock content\n');
});

test('开启 confirmBeforeApply：changeset 不写盘，列表可见且 applied=false', async () => {
  await setConfirm(true);
  const events = await chat('请创建 a.txt');
  const cs = events.find((e) => e.type === 'changeset')?.changeset;
  assert.ok(cs, '缺 changeset 事件');
  assert.equal(cs.applied, false, '待确认变更集不应标记为已应用');
  assert.equal(cs.status, 'pending');
  assert.ok(!fs.existsSync(projectFile('a.txt')), '确认前不应写入磁盘');

  const list = await api(baseUrl, 'GET', `/api/projects/${pid}/changesets?status=pending`, { token: user.token });
  assert.equal(list.status, 200);
  const item = list.data.changesets.find((c) => c.id === cs.id);
  assert.ok(item, 'pending 列表应包含待确认变更集');
  assert.equal(item.applied, false);

  // accept = 应用：after 写盘
  const acc = await api(baseUrl, 'POST', `/api/projects/${pid}/changesets/${cs.id}/accept`, {
    token: user.token, body: {},
  });
  assert.equal(acc.status, 200);
  assert.equal(acc.data.changeset.status, 'accepted');
  assert.equal(acc.data.changeset.applied, true);
  assert.equal(fs.readFileSync(projectFile('a.txt'), 'utf8'), 'mock content\n');
});

test('开启 confirmBeforeApply：revert = 放弃，不写盘', async () => {
  const events = await chat('请创建 b.txt');
  const cs = events.find((e) => e.type === 'changeset')?.changeset;
  assert.ok(cs);
  assert.equal(cs.applied, false);
  assert.ok(!fs.existsSync(projectFile('b.txt')));

  const rev = await api(baseUrl, 'POST', `/api/projects/${pid}/changesets/${cs.id}/revert`, {
    token: user.token, body: {},
  });
  assert.equal(rev.status, 200);
  assert.equal(rev.data.changeset.status, 'reverted');
  assert.ok(!fs.existsSync(projectFile('b.txt')), '放弃未应用的变更集不应写盘');
});

test('开启 confirmBeforeApply：按文件 accept 只应用该文件', async () => {
  // 一轮产生两个文件的变更集
  const events = await readSSE(`${baseUrl}/api/projects/${pid}/agent/chat`, {
    token: user.token, body: { chatId, message: '请创建 c1.txt' },
  });
  const cs = events.find((e) => e.type === 'changeset')?.changeset;
  assert.ok(cs);
  // 手动追加一个文件到同一变更集，模拟多文件场景
  const { getDb } = await import('../src/db.js');
  getDb().prepare(
    "INSERT INTO changeset_files (changeset_id, file_path, before_content, after_content, adds, dels, status) VALUES (?,?,?,?,?,?,'pending')"
  ).run(cs.id, 'c2.txt', null, 'second\n', 1, 0);

  const acc = await api(baseUrl, 'POST', `/api/projects/${pid}/changesets/${cs.id}/accept`, {
    token: user.token, body: { filePath: 'c1.txt' },
  });
  assert.equal(acc.status, 200);
  assert.equal(acc.data.changeset.status, 'pending', '仍有 pending 文件');
  assert.equal(acc.data.changeset.applied, false);
  assert.ok(fs.existsSync(projectFile('c1.txt')), '被 accept 的文件应写盘');
  assert.ok(!fs.existsSync(projectFile('c2.txt')), '未处理的文件不应写盘');

  // 放弃剩余文件
  const rev = await api(baseUrl, 'POST', `/api/projects/${pid}/changesets/${cs.id}/revert`, {
    token: user.token, body: { filePath: 'c2.txt' },
  });
  assert.equal(rev.data.changeset.status, 'accepted');
  assert.ok(!fs.existsSync(projectFile('c2.txt')));
});
