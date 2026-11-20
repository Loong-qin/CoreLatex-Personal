import { describe, expect, it } from 'vitest';
import { createLoginDemo, DEMO_SCENES, DEMO_TIMING } from './loginDemo.js';

function harness() {
  const queue = [];
  let now = 0;
  return {
    setTimeout: (fn, ms) => { const job = { fn, at: now + ms }; queue.push(job); return job; },
    clearTimeout: (job) => { const i = queue.indexOf(job); if (i >= 0) queue.splice(i, 1); },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        queue.sort((a, b) => a.at - b.at);
        const next = queue[0];
        if (!next || next.at > end) break;
        queue.shift();
        now = next.at;
        next.fn();
      }
      now = end;
    },
  };
}

describe('登录演示无缝循环', () => {
  it('三组场景首尾相接循环，相位完整', () => {
    const clock = harness();
    const states = [];
    const demo = createLoginDemo({ onUpdate: s => states.push(s), setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
    demo.start();
    clock.advance(40000);
    const visited = [...new Set(states.map(s => s.sceneIndex))];
    expect(visited).toEqual([0, 1, 2]);
    // 循环回到第一组且仍在推进（无缝，不停机）
    const last = states[states.length - 1];
    expect(states.some((s, i) => i > 0 && s.sceneIndex === 0 && states[i - 1].sceneIndex === 2)).toBe(true);
    expect(demo.running).toBe(true);
    const phases = new Set(states.map(s => s.phase));
    expect([...phases].sort()).toEqual(['compiling', 'erasing', 'ready', 'typing']);
    // 打字完整出现过每个标题
    for (const scene of DEMO_SCENES) {
      expect(states.some(s => s.typed === scene.section && s.phase === 'compiling')).toBe(true);
    }
    expect(last.compileMs).toBe(DEMO_SCENES[last.sceneIndex].compileMs);
  });

  it('stop 后不再推进，start 可恢复且不会双启动', () => {
    const clock = harness();
    const states = [];
    const demo = createLoginDemo({ onUpdate: s => states.push(s), setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
    demo.start();
    demo.start();
    clock.advance(1000);
    const count = states.length;
    demo.stop();
    expect(demo.running).toBe(false);
    clock.advance(10000);
    expect(states.length).toBe(count);
    demo.start();
    clock.advance(1000);
    expect(states.length).toBeGreaterThan(count);
    demo.stop();
  });

  it('节奏常量保证停留足够阅读', () => {
    expect(DEMO_TIMING.hold).toBeGreaterThanOrEqual(2000);
    expect(DEMO_TIMING.type).toBeGreaterThan(20);
  });
});
