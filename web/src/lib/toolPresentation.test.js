import { describe, it, expect } from 'vitest';
import { buildTimeline } from './agentUtils.js';
import { toolPresentation, technicalToolText, safeArtifactUrl, safeToolLink } from './toolPresentation.js';

describe('tool result presentation', () => {
  it.each([
    ['list_files', 'files'], ['read_workspace', 'files'], ['read_file', 'read'], ['view_image', 'image'],
    ['write_file', 'edit'], ['edit_file', 'edit'], ['copy_to_project', 'edit'], ['compile_and_preview', 'compile'],
    ['run_in_workspace', 'command'], ['run_skill_script', 'command'], ['prepare_env', 'command'], ['read_skill', 'skill'],
    ['web_search', 'search'], ['web_fetch', 'web'], ['get_document_context', 'context'], ['ask_user', 'question'],
    ['report_progress', 'progress'], ['mcp__git__status', 'generic'], ['future_tool', 'generic'],
  ])('classifies %s into %s', (name, kind) => { expect(toolPresentation({ name, result: '真实结果' }).kind).toBe(kind); });

  it('preserves real image references, read line numbers, notices and bounded structured output in live and history', () => {
    const display = { version: 1, kind: 'compile', title: '编译与预览', summary: '已读取 1 页图像', fields: [{ label: '版本', value: '本轮暂存版本' }], images: [{ id: 'snap-1', url: '/api/projects/p/agent/artifacts/snap-1', label: '第 15 页', page: 15 }], notice: '暂存修改尚未写入正式文件' };
    const live = buildTimeline({ steps: [{ type: 'tool', name: 'compile_and_preview', status: 'end', detail: '预览编译成功', display }] }).rows[0];
    const history = buildTimeline({ toolCalls: [{ name: 'compile_and_preview', result: '预览编译成功', display }] }).rows[0];
    expect(live.display).toEqual(history.display);
    expect(live.display.images[0]).toMatchObject(display.images[0]);
    expect(live.display.notice).toContain('尚未写入');
    expect(toolPresentation({ display: { version: 1, kind: 'read', startLine: 20, text: 'line' } }).startLine).toBe(20);
  });

  it('recovers old JSON text without rendering truncated image bytes or credentials anywhere', () => {
    const secret = 'private-token-value';
    const base64 = '/9j/AAQSkZJRgABA'.repeat(90);
    const malformed = `{"text":"预览编译成功\\n第 15 页","token":"${secret}","images":[{"imageBase64":"${base64}`;
    const row = buildTimeline({ steps: [{ type: 'tool', name: 'compile_and_preview', input: { api_key: secret, pages: '15' }, result: malformed }] }).rows[0];
    const rendered = JSON.stringify(row);
    expect(rendered).not.toContain(secret);
    expect(rendered).not.toContain('/9j/AAQ');
    expect(row.display.text).toContain('预览编译成功');
    expect(row.display.notice).toContain('未保存');
    expect(row.display.images).toEqual([]);
    expect(technicalToolText({ password: secret, imageBase64: base64, text: 'keep' })).not.toContain(secret);
    expect(technicalToolText({ credential: secret, client_secret: secret, url: `https://name:${secret}@example.test` })).not.toContain(secret);
    for (const result of [{ type: 'image', data: base64 }, `{"type":"image","data":"${base64}`]) {
      const legacyMcp = buildTimeline({ toolCalls: [{ name: 'mcp__images__render', result }] }).rows[0];
      expect(JSON.stringify(legacyMcp)).not.toContain('/9j/AAQ');
    }
  });

  it('keeps ordinary long text and does not invent successful edits from tool arguments', () => {
    const long = 'x'.repeat(1200);
    expect(technicalToolText(long)).toBe(long);
    const row = toolPresentation({ name: 'edit_file', input: { search: 'old', replace: 'new' }, result: { error: '匹配失败' }, state: 'error' });
    expect(row.before).toBeUndefined(); expect(row.after).toBeUndefined(); expect(row.text).toBe('匹配失败');
    expect(row.summary).toContain('失败');
    expect(toolPresentation({ name: 'write_file', result: { changed: false } }).summary).toBe('未产生文件修改');
    expect(toolPresentation({ name: 'read_file', state: 'cancelled' }).summary).toContain('取消');
    expect(toolPresentation({ name: 'read_file', state: 'running' }).summary).toContain('正在执行');
  });

  it('uses explicit execution status rather than treating successful file contents as a failure', () => {
    const rows = buildTimeline({ steps: [
      { type: 'tool', name: 'read_file', status: 'end', result: '{"error":"This is the file content"}' },
      { type: 'tool', name: 'read_file', status: 'error', result: '{"error":"Access denied"}' },
      { type: 'tool', name: 'mcp__service__read', status: 'end', result: '{"error":"content only"}', display: { version: 1, kind: 'generic', summary: '已读取' } },
      { type: 'tool', name: 'edit_file', status: 'end', result: '{"error":"Legacy failed mutation"}' },
    ] }).rows;
    expect(rows[0].state).toBe('ok'); expect(rows[1].state).toBe('error');
    expect(rows[2].state).toBe('ok'); expect(rows[3].state).toBe('error');
  });

  it('rejects unsafe image URLs and only allows public web links with credentials removed', () => {
    for (const bad of ['https://evil.test/x', '//evil.test/x', '/api/auth/token', '/api/projects/p/agent/artifacts/a?token=secret', '/api/projects/../agent/artifacts/x']) expect(safeArtifactUrl(bad)).toBe('');
    expect(safeArtifactUrl('/api/projects/p/agent/artifacts/snap-1')).toBe('/api/projects/p/agent/artifacts/snap-1');
    for (const bad of ['javascript:alert(1)', 'data:text/html,test', 'https://u:p@host.test']) expect(safeToolLink(bad)).toBe('');
    expect(safeToolLink('https://site.test/?token=secret&q=tex')).toBe('https://site.test/?q=tex');
  });

  it('gives old file, search, webpage and command outputs readable structure', () => {
    expect(toolPresentation({ name: 'list_files', result: ['a.tex', 'figures/'] }).items).toHaveLength(2);
    expect(toolPresentation({ name: 'web_search', result: { results: [{ title: 'A source', url: 'https://example.test', snippet: 'Useful' }] } }).items[0]).toMatchObject({ label: 'A source', detail: 'Useful', url: 'https://example.test/' });
    const command = toolPresentation({ name: 'run_in_workspace', input: { command: 'python check.py' }, result: { stdout: 'out', stderr: 'warning', exitCode: 0 } });
    expect(command.text).toContain('warning'); expect(command.fields).toContainEqual({ label: '退出码', value: '0' });
    expect(toolPresentation({ name: 'web_fetch', input: { url: 'https://example.test' }, result: { text: 'body' } }).items[0].url).toBe('https://example.test/');
    const mcp = toolPresentation({ name: 'mcp__service__tool', display: { version: 1, kind: 'generic', text: '{"title":"条目","count":3}' } });
    expect(mcp.text).toBe(''); expect(mcp.fields).toContainEqual({ label: 'title', value: '条目' });
    expect(toolPresentation({ name: 'mcp__service__list', result: { results: [null, 0, false, { title: 'safe' }] } }).items.map(i => i.label)).toEqual(['0', 'false', 'safe']);
  });
});
