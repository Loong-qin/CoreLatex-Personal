import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerHooks } from 'node:module';

// Exercise the real MCP integration without installing an optional SDK or
// starting an external server. Only the SDK transport boundary is substituted.
const key = Symbol.for('corelatex.test.mcp-result');
globalThis[key] = { result: { content: [] } };
const clientSource = `export class Client {
  async connect() {}
  async close() {}
  async callTool() { return globalThis[Symbol.for('corelatex.test.mcp-result')].result; }
}`;
const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  const source = specifier === '@modelcontextprotocol/sdk/client/index.js' ? clientSource
    : specifier === '@modelcontextprotocol/sdk/client/stdio.js' ? 'export class StdioClientTransport { constructor(options) {} }' : null;
  return source === null ? nextResolve(specifier, context)
    : { url: 'data:text/javascript,' + encodeURIComponent(source), shortCircuit: true };
} });
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'corelatex-mcp-results-'));
process.env.CORELATEX_DATA_DIR = temp;
let callMcpTool, makePiTool, resetDb, userId;
before(async () => {
  const database = await import('../src/db.js');
  const db = database.getDb(); resetDb = database.resetDb;
  userId = Number(db.prepare("INSERT INTO users(username,password_hash,role) VALUES ('mcp-test','unused','admin')").run().lastInsertRowid);
  db.prepare('INSERT INTO settings(user_id,mcp_config) VALUES (?,?)').run(userId, JSON.stringify({ servers: [{ name: 'fake', command: 'unused' }] }));
  ({ callMcpTool } = await import('../src/services/agent/mcp.js'));
  ({ makePiTool } = await import('../src/services/agent/tools.js'));
});
after(() => { hooks.deregister(); delete globalThis[key]; resetDb(); fs.rmSync(temp, { recursive: true, force: true }); });

test('MCP application errors reject even when the transport succeeds', async () => {
  globalThis[key].result = { isError: true, content: [{ type: 'text', text: 'Permission denied for this document' }] };
  await assert.rejects(callMcpTool(userId, 'fake', 'write', {}), /Permission denied for this document/);
});

test('MCP empty application errors remain failures', async () => {
  globalThis[key].result = { isError: true, content: [] };
  await assert.rejects(callMcpTool(userId, 'fake', 'write', {}));
});

test('structured MCP images remain native blocks instead of JSON base64 text', async () => {
  const data=Buffer.from('native-image-bytes').toString('base64');
  globalThis[key].result={content:[{type:'text',text:'Image result'},{type:'image',data,mimeType:'image/png'}]};
  const out=await callMcpTool(userId,'fake','read',{}, {structured:true});
  assert.equal(out.text,'Image result'); assert.equal(out.images[0].imageBase64,data);
  const tool=makePiTool({name:'mcp__fake__image',parameters:{type:'object'},run:async()=>out},{});
  const result=await tool.execute('image',{});
  assert.equal(result.content.find(c=>c.type==='image').data,data);
  assert.equal(result.content.filter(c=>c.type==='text').map(c=>c.text).join('').includes(data),false);
});

test('MCP success text remains compatible', async () => {
  globalThis[key].result = { isError: false, content: [{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }] };
  assert.equal(await callMcpTool(userId, 'fake', 'read', {}), 'first\nsecond');
});

test('MCP errors propagate through the Pi adapter instead of becoming successful tool evidence', async () => {
  globalThis[key].result = { isError: true, content: [{ type: 'text', text: 'Write was rejected' }] };
  const tool = makePiTool({ name: 'mcp__fake__write', parameters: { type: 'object' }, run: async input => {
    try { return await callMcpTool(userId, 'fake', 'write', input); }
    catch (error) { return { error: error.message }; }
  } }, {});
  await assert.rejects(tool.execute('call', {}), /Write was rejected/);
});
