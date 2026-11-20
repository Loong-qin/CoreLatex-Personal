import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

/**
 * 测试辅助：起真实服务器（临时数据目录），返回 { baseUrl, close, dataDir }。
 * 必须在 import 服务器模块之前设置 CORELATEX_DATA_DIR —— 使用 spawn 子进程模式或
 * 在同进程内先于 import 设置 env。这里采用同进程方案：调用方需在动态 import 前设置 env。
 */
export async function startTestServer() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'corelatex-test-'));
  process.env.CORELATEX_DATA_DIR = dataDir;
  const { resetDb } = await import('../src/db.js');
  resetDb();
  const { startServer } = await import('../src/index.js');
  const server = startServer(0, '127.0.0.1');
  await new Promise((resolve) => server.on('listening', resolve));
  const { port } = server.address();
  return {
    dataDir,
    baseUrl: `http://127.0.0.1:${port}`,
    server,
    async close() {
      await new Promise((r) => server.close(r));
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export async function api(base, method, p, { token, body, raw } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (body instanceof FormData) {
    payload = body;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${base}${p}`, { method, headers, body: payload });
  if (raw) return res;
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

export async function registerAndLogin(base, username, password = 'pass1234') {
  await api(base, 'POST', '/api/auth/register', { body: { username, password } });
  const { data } = await api(base, 'POST', '/api/auth/login', { body: { username, password } });
  return { token: data.token, user: data.user };
}
