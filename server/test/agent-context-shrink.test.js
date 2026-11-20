import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shrinkForContextRetry, buildResumeNote } from '../src/services/agent/agentLoop.js';

/**
 * 400 上下文精简重试的回归测试(2026-10 实录:压缩后模型「不知道自己要干啥」)。
 * 三条底线:
 *  1. 任何级别都不丢「任务锚点」——最近一条真实用户需求必须留在上下文里(L2 被裁则回拼);
 *  2. L1 不丢任何消息,只缩写较早的工具结果正文——本轮进度(工具调用/叙述)完整保留;
 *  3. L2 裁中段后序列仍合法——起始对齐 user 边界,绝不让 toolResult 成为队首孤儿。
 */

const textOf = (m) => (typeof m.content === 'string'
  ? m.content
  : (m.content || []).filter((p) => p && p.type === 'text').map((p) => p.text).join('\n'));
const longText = (tag, n = 3000) => `${tag}:` + 'x'.repeat(n);

function fixture() {
  return [
    { role: 'user', content: '请修复 AGE_NSGAIII.tex 中缩写表跨页的排版问题' },            // 0 任务锚点
    { role: 'assistant', content: '好的，我先查看文件与技能。' },                            // 1
    { role: 'user', content: [{ type: 'text', text: '跨页效果见截图' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }] }, // 2
    { role: 'toolResult', content: [{ type: 'text', text: longText('早期技能正文') }] },     // 3 早于最近10条 → L1 缩写
    { role: 'toolResult', content: [{ type: 'text', text: longText('早期文件读回') }] },     // 4 早于最近10条 → L1 缩写
    { role: 'assistant', content: '已定位问题，开始修改。' },                                // 5
    { role: 'user', content: '【系统便签】历史内容视为过期快照' },                           // 6
    { role: 'assistant', content: '执行修改中' },                                            // 7
    { role: 'assistant', content: '编译并预览' },                                            // 8
    { role: 'assistant', content: '复核页面' },                                              // 9
    { role: 'assistant', content: '整理结论' },                                              // 10
    { role: 'user', content: '继续' },                                                       // 11
    { role: 'assistant', content: '重新编译' },                                              // 12
    { role: 'toolResult', content: [{ type: 'text', text: longText('最近编译读回') }] },     // 13 最近 → L1 保持原文
    { role: 'user', content: '【系统进度备忘】上一轮重试的备忘' },                           // 14
  ];
}

test('L0 首轮保留最新图像和当前附件，仅省略更早图像，消息一条不少', () => {
  const src = fixture();
  src[0] = { role: 'user', content: [
    { type: 'text', text: '更早的图像' },
    { type: 'image', data: 'OLD_IMAGE', mimeType: 'image/png' },
  ] };
  const out = shrinkForContextRetry(src, 0, 0);
  assert.equal(out.length, src.length);
  assert.ok(!out[0].content.some((p) => p.type === 'image'), '较早图像应省略');
  assert.ok(textOf(out[0]).includes('[早期图像已省略]'));
  assert.equal(out[2].content.find((p) => p.type === 'image').data, 'AAAA', '首轮不得丢弃当前唯一有效图像');
  assert.ok(src[0].content.some((p) => p.type === 'image'), '原消息不得被原位修改');
  assert.ok(!textOf(out[3]).includes('工具结果已缩写'), 'L0 不缩写工具结果');
});

test('L1 保留全部消息(本轮进度不丢),较早工具结果被缩写、最近 10 条窗口内保持原文', () => {
  const src = fixture();
  const out = shrinkForContextRetry(src, 1, 0);
  assert.equal(out.length, src.length, 'L1 绝不丢消息');
  for (const m of out) {
    if (Array.isArray(m.content)) assert.ok(!m.content.some((p) => p?.type === 'image'), '真实超限重试仍去除图像');
  }
  assert.ok(textOf(out[3]).includes('工具结果已缩写'), '窗口外的早期工具结果应被缩写');
  assert.ok(textOf(out[3]).length < textOf(src[3]).length);
  assert.ok(textOf(out[4]).includes('工具结果已缩写'));
  assert.equal(textOf(out[13]), textOf(src[13]), '最近窗口内的工具结果保持原文');
});

test('L2 裁中段:任务锚点回拼队首、起始为 user、全部工具结果缩写', () => {
  const src = fixture();
  const out = shrinkForContextRetry(src, 2, 0); // 锚点=首条用户消息(必被裁)
  assert.ok(out.length < src.length, '应裁掉中段');
  assert.equal(out[0].role, 'user');
  assert.notEqual(out[0].role, 'toolResult');
  assert.ok(textOf(out[0]).includes('请修复 AGE_NSGAIII.tex'), '任务锚点必须保留');
  assert.ok(textOf(out[0]).includes('系统标注'), '锚点应带精简标注');
  for (const m of out) {
    if (m.role === 'toolResult') assert.ok(textOf(m).includes('工具结果已缩写'), 'L2 应缩写全部工具结果');
    if (Array.isArray(m.content)) {
      assert.ok(!m.content.some((p) => p && p.type === 'image'), 'L2 不残留图像');
    }
  }
});

test('L2 锚点落在保留区间时不重复回拼', () => {
  const src = fixture();
  const out = shrinkForContextRetry(src, 2, 6); // 锚点取索引 6 的 user 便签(已在后半段)
  const anchors = out.filter((m) => textOf(m).includes('【系统便签】'));
  assert.equal(anchors.length, 1, '已在保留区间的锚点不应重复出现');
});

test('空数组与越界锚点安全', () => {
  assert.deepEqual(shrinkForContextRetry([], 2, -1), []);
  const out = shrinkForContextRetry(fixture(), 2, 999);
  assert.ok(Array.isArray(out) && out.length > 0);
});

test('buildResumeNote 汇总真实工具调用与编辑数,并明确「不重做」指令', () => {
  const note = buildResumeNote({
    toolCalls: [
      { name: 'view_image', input: { path: '_workspace/shot.png' } },
      { name: 'read_skill', input: { name: 'nature-polishing' } },
      { name: 'edit_file', input: { path: 'AGE_NSGAIII.tex' } },
      { name: 'compile_and_preview', input: {} },
    ],
    successfulEdits: 1,
    lastNarration: '已把 FloatBarrier 升级为 clearpage，正在复核跨页效果',
  });
  assert.ok(note.includes('系统进度备忘'));
  assert.ok(note.includes('view_image(_workspace/shot.png)'));
  assert.ok(note.includes('read_skill(nature-polishing)'));
  assert.ok(note.includes('成功 1 次'));
  assert.ok(note.includes('变更已暂存于变更集'));
  assert.ok(note.includes('FloatBarrier'));
  assert.ok(note.includes('不要重做'));
  assert.ok(note.includes('read_skill 重取技能内容不算重复劳动'));
});

test('buildResumeNote 空进度也有安全文案', () => {
  const note = buildResumeNote({ toolCalls: [], successfulEdits: 0, lastNarration: '' });
  assert.ok(note.includes('尚未执行任何工具调用'));
  assert.ok(note.includes('成功 0 次'));
});
