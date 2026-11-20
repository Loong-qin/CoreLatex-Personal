import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { TOOL_METADATA, toolLabel, toolDescription, toolKind } from './toolMetadata.js';
import { buildTimeline, toolPhrase } from './agentUtils.js';
import { toolPresentation } from './toolPresentation.js';
import { buildToolDisplay } from '../../../server/src/services/agent/toolDisplay.js';

describe('shared Chinese tool metadata', () => {
  it('covers the actual built-in definitions, conditional tools and legacy environment tool', () => {
    // Evaluate only the self-contained declaration function, avoiding server
    // initialization, native database modules and any application data access.
    const source = readFileSync(new URL('../../../server/src/services/agent/tools.js', import.meta.url), 'utf8');
    const start = source.indexOf('export function getToolDefinitions()');
    const end = source.indexOf('\nexport async function executeTool', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const definitions = runInNewContext(`${source.slice(start, end).replace(/^export /, '')}\ngetToolDefinitions();`, {}, { timeout: 1000 });
    const loop = readFileSync(new URL('../../../server/src/services/agent/agentLoop.js', import.meta.url), 'utf8');
    const conditional = [...loop.matchAll(/makePiTool\(\s*\{\s*name:\s*['"]([\w]+)['"]/g)].map(match => match[1]);
    expect(definitions.length).toBeGreaterThan(0);
    expect(conditional).toEqual(expect.arrayContaining(['ask_user', 'report_progress', 'plan_task_graph', 'run_agent_graph']));
    expect(conditional).not.toContain('set_chinese_alignment_scope');
    expect(definitions.map(def => def.function.name)).not.toContain('set_chinese_alignment_scope');
    const worker = readFileSync(new URL('../../../server/src/services/agent/specialistAgent.js', import.meta.url), 'utf8');
    const workerTools = [...worker.matchAll(/makePiTool\(\s*\{\s*name:\s*['"]([\w]+)['"]/g)].map(match => match[1]);
    expect(workerTools).toContain('submit_agent_report');
    const names = [...definitions.map(def => def.function.name), ...conditional, ...workerTools, 'prepare_env'];
    for (const name of names) {
      expect(Object.hasOwn(TOOL_METADATA, name), `Missing Chinese metadata for ${name}`).toBe(true);
      expect(toolLabel(name)).toMatch(/[\u4e00-\u9fff]/);
      expect(toolDescription(name)).toMatch(/[\u4e00-\u9fff]/);
    }
  });

  it('localizes historical workspace and file-search tools instead of grouping them as other tools', () => {
    const expected = {
      run_workspace: '运行工作区命令',
      run_workspace_command: '执行工作区命令',
      grep_files: '搜索文件内容',
    };
    for (const [name, label] of Object.entries(expected)) {
      expect(toolLabel(name)).toBe(label);
      expect(toolLabel(name)).not.toContain('其他工具');
      expect(toolDescription(name)).toMatch(/[\u4e00-\u9fff]/);
      expect(buildToolDisplay(name, {}, undefined, { status: 'start' }).title).toBe(label);
    }
  });

  it.each(Object.entries(TOOL_METADATA))('keeps frontend and backend names and types consistent for %s', (name, metadata) => {
    const display = buildToolDisplay(name, {}, undefined, { status: 'start' });
    expect(display.title).toBe(metadata.label);
    expect(display.kind).toBe(toolKind(name));
    expect(toolPresentation({ name }).kind).toBe(metadata.kind);
    expect(toolPhrase(name)).toBe(`已${metadata.label}`);
  });

  it.each(Object.keys(TOOL_METADATA))('localizes historical English display titles for %s without changing the recorded result', name => {
    const display = { version: 1, kind: toolKind(name), title: name, summary: '已记录的结果', text: '实际返回内容' };
    const row = buildTimeline({ toolCalls: [{ name, result: '原始记录', display }] }).rows[0];
    expect(row.label).toBe(toolLabel(name));
    expect(row.display).toMatchObject({ title: toolLabel(name), summary: display.summary, text: display.text });
    expect(display.title).toBe(name);
  });

  it('preserves distinct unknown and external identities in all display formats', () => {
    for (const name of ['future_alpha', 'future_beta', 'constructor', '__proto__', 'mcp__papers__search', 'mcp__library__search']) {
      const label = `${name.startsWith('mcp__') ? '外部工具' : '其他工具'}（${name}）`;
      expect(toolLabel(name)).toBe(label);
      expect(toolDescription(name)).toContain(name);
      expect(toolKind(name)).toBe('generic');
      expect(buildToolDisplay(name, {}, {}, { status: 'start' }).title).toBe(label);
      const legacy = buildTimeline({ toolCalls: [{ name, result: 'result' }] }).rows[0];
      expect(legacy.label).toContain(label);
      const oldTitle = buildTimeline({ toolCalls: [{ name, display: { version: 1, kind: 'generic', title: name } }] }).rows[0];
      expect(oldTitle.label).toBe(label);
    }
    expect(toolLabel('')).toBe('其他工具（未命名）');
  });

  it('keeps failure and cancellation honest when localizing older tools', () => {
    const rows = buildTimeline({ steps: [
      { type: 'tool', name: 'ask_user', status: 'start' },
      { type: 'tool', name: 'plan_task_graph', status: 'error' },
      { type: 'tool', name: 'set_chinese_alignment_scope', status: 'cancelled' },
    ] }).rows;
    expect(rows.map(row => row.label)).toEqual(['正在询问用户', '规划任务图失败', '已取消设置中英对照范围']);
  });
});
