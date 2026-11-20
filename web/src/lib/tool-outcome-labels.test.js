import { describe, expect, it } from 'vitest';
import { buildTimeline, toolResultKind } from './agentUtils.js';
const row = (call) => buildTimeline({ steps: [{ type: 'tool', name: 'edit_file', input: { path: 'main.tex' }, ...call }] }).rows[0];
describe('file mutation evidence in the timeline', () => {
  it('does not describe a started, failed or cancelled edit as a completed file change', () => {
    expect(row({ status: 'start' }).label).toBe('正在修改文件');
    expect(row({ status: 'end', detail: '{"error":"search not found"}' })).toMatchObject({ state: 'error', label: '修改文件失败' });
    expect(row({ status: 'error' }).label).toBe('修改文件失败');
    expect(row({ status: 'cancelled' }).label).toBe('已取消修改文件');
  });
  it.each(['edit_file', 'write_file', 'copy_to_project'])('shows %s no-ops as no change despite a successful tool invocation', name => {
    const result = { text: 'No content difference', changed: false, staged: false, applied: false, path: 'main.tex' };
    expect(row({ name, status: 'end', detail: JSON.stringify(result) })).toMatchObject({ state: 'ok', label: '未产生文件修改' });
    const history = buildTimeline({ toolCalls: [{ name, result }] }).rows[0];
    expect(history.label).toBe('未产生文件修改');
  });
  it('distinguishes a staged project change from an actual workspace write', () => {
    expect(row({ status: 'end', detail: { changed: true, staged: true, applied: false, path: 'main.tex' } }).label).toBe('已暂存文件修改');
    expect(row({ status: 'end', detail: { changed: true, staged: false, applied: true, path: '_workspace/draft.tex' } }).label).toBe('已修改工作区文件');
  });
  it.each(['ok', '', '已暂存对 main.tex 的修改', { changed: true, staged: false, applied: false }])('does not invent a completed file change from incomplete evidence %o', result => {
    expect(row({ status: 'end', result }).label).toBe('编辑结果待核对');
  });
  it('does not call a restored original file a staged modification', () => {
    expect(row({ status: 'end', detail: { changed: true, staged: false, applied: false, scope: 'project', path: 'main.tex' } }).label).toBe('未留下待提交修改');
  });
  it('treats explicit unsuccessful results as failure before considering mutation fields', () => {
    expect(toolResultKind({ ok: false })).toBe('error');
    expect(row({ status: 'end', detail: { success: false, changed: true, staged: true } })).toMatchObject({ state: 'error', label: '修改文件失败' });
  });
});
