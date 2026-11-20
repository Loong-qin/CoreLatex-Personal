// 实时时间线：SSE 事件 → liveSteps（叙述与工具交错），收尾时挂到本地消息上
import { describe, it, expect, beforeEach } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useAgentStore } from './agent.js';

beforeEach(() => {
  setActivePinia(createPinia());
});

describe('agent store 时间线', () => {
  it('token 与 tool 事件按到达顺序交错，同一段叙述连续追加', () => {
    const s = useAgentStore();
    s._beginStream();
    expect(s.streamStartedAt).toBeTruthy();

    s._onEvent({ type: 'token', text: '先看' });
    s._onEvent({ type: 'token', text: '现状。' });
    s._onEvent({ type: 'tool', name: 'read_file', status: 'start' });
    s._onEvent({ type: 'tool', name: 'read_file', status: 'end', detail: 'main.tex' });
    s._onEvent({ type: 'token', text: '改好了。' });

    expect(s.liveSteps.map((x) => x.type)).toEqual(['text', 'tool', 'text']);
    expect(s.liveSteps[0].text).toBe('先看现状。');
    expect(s.liveSteps[1]).toMatchObject({ name: 'read_file', status: 'end', detail: 'main.tex' });
    expect(s.liveSteps[2].text).toBe('改好了。');
    expect(s.streamText).toBe('先看现状。改好了。');
  });

  it('没有成对 end 的工具事件单独成行', () => {
    const s = useAgentStore();
    s._beginStream();
    s._onEvent({ type: 'tool', name: 'write_file', status: 'end', detail: '已暂存' });
    expect(s.liveSteps).toHaveLength(1);
    expect(s.liveSteps[0]).toMatchObject({ type: 'tool', name: 'write_file', status: 'end' });
  });

  it('收尾（不重载）时把本轮步骤挂到本地消息上并清空实时状态', async () => {
    const s = useAgentStore();
    s._beginStream();
    s._onEvent({ type: 'token', text: '改好了。' });
    s._onEvent({ type: 'tool', name: 'edit_file', status: 'start' });
    await s._finishStream(null, { reload: false });

    expect(s.streaming).toBe(false);
    expect(s.liveSteps).toEqual([]);
    expect(s.streamStartedAt).toBeNull();
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]).toMatchObject({ role: 'assistant', content: '改好了。' });
    expect(s.messages[0].steps.map((x) => x.type)).toEqual(['text', 'tool']);
  });

  it('开始新一轮时清空上一轮遗留', () => {
    const s = useAgentStore();
    s.liveSteps = [{ type: 'text', text: '旧' }];
    s._beginStream();
    expect(s.liveSteps).toEqual([]);
    expect(s.streamText).toBe('');
  });
});
