import { getDb } from '../../db.js';
import { HttpError } from '../../util.js';

/**
 * MCP（Model Context Protocol）stdio 服务器集成。
 * @modelcontextprotocol/sdk 为可选依赖：任何 import 失败都降级为空工具列表，绝不因缺包崩溃。
 * 连接做模块级缓存（key = userId + serverName，5 分钟空闲过期，惰性检查不挂定时器）。
 */

const IDLE_TTL_MS = 5 * 60 * 1000;
const connCache = new Map(); // key → { client, serverSig, lastUsed }

async function loadSdk() {
  try {
    const clientMod = await import('@modelcontextprotocol/sdk/client/index.js');
    const stdioMod = await import('@modelcontextprotocol/sdk/client/stdio.js');
    return { Client: clientMod.Client, StdioClientTransport: stdioMod.StdioClientTransport };
  } catch {
    return null; // 包未安装或加载失败
  }
}

function readServers(userId) {
  const row = getDb().prepare('SELECT mcp_config FROM settings WHERE user_id = ?').get(userId);
  if (!row) return [];
  let cfg;
  try { cfg = JSON.parse(row.mcp_config || '{}'); } catch { return []; }
  if (!cfg || !Array.isArray(cfg.servers)) return [];
  return cfg.servers.filter((s) => s && s.name && s.command);
}

function serverSig(server) {
  return JSON.stringify({ command: server.command, args: server.args || [], env: server.env || {} });
}

async function getConnection(userId, server, signal) {
  signal?.throwIfAborted();
  const key = `${userId}:${server.name}`;
  const now = Date.now();
  const sig = serverSig(server);
  const hit = connCache.get(key);
  if (hit && hit.serverSig === sig && now - hit.lastUsed < IDLE_TTL_MS) {
    hit.lastUsed = now;
    return hit.client;
  }
  if (hit) {
    try { await hit.client.close(); } catch { /* ignore */ }
    connCache.delete(key);
  }
  const sdk = await loadSdk();
  signal?.throwIfAborted();
  if (!sdk) return null;
  const transport = new sdk.StdioClientTransport({
    command: server.command,
    args: server.args || [],
    env: { ...process.env, ...(server.env || {}) },
  });
  const client = new sdk.Client({ name: 'corelatex', version: '1.0.0' });
  const abort = () => { void client.close().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    signal?.throwIfAborted();
    await new Promise((resolve, reject) => {
      const cancelled = () => reject(signal.reason || new DOMException('Operation cancelled', 'AbortError'));
      signal?.addEventListener('abort', cancelled, { once: true });
      client.connect(transport).then(resolve, reject).finally(() => signal?.removeEventListener('abort', cancelled));
      if (signal?.aborted) cancelled();
    });
    signal?.throwIfAborted();
  } finally { signal?.removeEventListener('abort', abort); }
  connCache.set(key, { client, serverSig: sig, lastUsed: now });
  return client;
}

/** 读取全部已配置 MCP 服务器的工具清单。配置为空/SDK 缺失/单服务器失败 → 跳过或 [] */
export async function getMcpTools(userId, { signal } = {}) {
  signal?.throwIfAborted();
  const servers = readServers(userId);
  if (!servers.length) return [];
  if (!(await loadSdk())) return [];
  const tools = [];
  for (const server of servers) {
    try {
      const client = await getConnection(userId, server, signal);
      if (!client) continue;
      signal?.throwIfAborted();
      const res = await client.listTools(undefined, { signal });
      for (const t of res.tools || []) {
        tools.push({
          server: server.name,
          name: t.name,
          description: t.description || '',
          inputSchema: t.inputSchema || { type: 'object', properties: {} },
        });
      }
    } catch (err) {
      signal?.throwIfAborted();
      console.warn(`[mcp] 服务器 ${server.name} 连接/枚举失败：${err.message}`);
    }
  }
  return tools;
}

/** 调用 MCP 工具，返回结果文本 */
export async function callMcpTool(userId, serverName, toolName, input, { signal, structured = false } = {}) {
  signal?.throwIfAborted();
  const server = readServers(userId).find((s) => s.name === serverName);
  if (!server) throw new HttpError(404, `MCP 服务器未配置：${serverName}`);
  const client = await getConnection(userId, server, signal);
  if (!client) throw new HttpError(502, 'MCP SDK 未安装，无法调用 MCP 工具');
  signal?.throwIfAborted();
  const res = await client.callTool({ name: toolName, arguments: input || {} }, undefined, { signal });
  signal?.throwIfAborted();
  if (structured) {
    const images = (res.content || []).filter((c) => c.type === 'image').map((c) => ({ mediaType: c.mimeType, imageBase64: c.data }));
    const text = (res.content || []).filter((c) => c.type !== 'image').map((c) => c.type === 'text' ? c.text : JSON.stringify(c)).join('\n');
    if (res.isError === true) throw new Error(text || `MCP 工具 ${serverName}/${toolName} 执行失败（未返回错误详情）`);
    return images.length ? { text, images } : text || JSON.stringify(res);
  }
  const parts = (res.content || []).map((c) => (c.type === 'text' ? c.text : JSON.stringify(c)));
  const text = parts.join('\n');
  // MCP can report application failure in a successful protocol response.
  // Propagate it so the Pi adapter records an error, not successful execution.
  if (res.isError === true) throw new Error(text || `MCP 工具 ${serverName}/${toolName} 执行失败（未返回错误详情）`);
  return text || JSON.stringify(res);
}
