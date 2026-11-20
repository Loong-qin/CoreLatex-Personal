// 登录页演示窗的无缝循环时间线：三组 LaTeX 片段依次
// 打字 → 编译 → 停留 → 退格 → 下一组，首尾相接不重置。
export const DEMO_SCENES = Object.freeze([
  {
    section: 'Introduction',
    comment: '% A space for new ideas',
    math: '\\[ e^{i\\pi} + 1 = 0 \\]',
    paperTitle: ['Ideas, beautifully', 'typeset.'],
    equation: 'eⁱπ + 1 = 0',
    compileMs: 128,
  },
  {
    section: 'Method',
    comment: '% Gradient descent, softly tuned',
    math: '\\[ \\nabla\\theta = -\\eta\\,\\nabla L(\\theta) \\]',
    paperTitle: ['Methods, clearly', 'argued.'],
    equation: '∇θ = −η ∇L(θ)',
    compileMs: 96,
  },
  {
    section: 'Results',
    comment: '% Every figure finds its place',
    math: '\\[ \\int_0^\\infty e^{-x^2}\\,dx = \\tfrac{\\sqrt{\\pi}}{2} \\]',
    paperTitle: ['Results, elegantly', 'shown.'],
    equation: '∫₀∞ e⁻ˣ² dx = √π/2',
    compileMs: 142,
  },
]);

export const DEMO_TIMING = Object.freeze({ type: 75, erase: 26, compile: 420, hold: 2800, fade: 240, lead: 400 });

export function createLoginDemo({ onUpdate, setTimeout: schedule = setTimeout, clearTimeout: cancel = clearTimeout } = {}) {
  let sceneIndex = 0;
  let chars = 0;
  let phase = 'typing';
  let timer = null;

  const snapshot = () => ({
    sceneIndex,
    typed: DEMO_SCENES[sceneIndex].section.slice(0, chars),
    phase,
    compileMs: DEMO_SCENES[sceneIndex].compileMs,
  });
  const emit = () => onUpdate?.(snapshot());
  const later = (fn, ms) => { timer = schedule(() => { timer = null; fn(); }, ms); };

  function step() {
    const scene = DEMO_SCENES[sceneIndex];
    if (phase === 'typing') {
      if (chars < scene.section.length) { chars += 1; emit(); later(step, DEMO_TIMING.type); }
      else { phase = 'compiling'; emit(); later(step, DEMO_TIMING.compile); }
    } else if (phase === 'compiling') {
      phase = 'ready'; emit(); later(step, DEMO_TIMING.hold);
    } else if (phase === 'ready') {
      phase = 'erasing'; emit(); later(step, DEMO_TIMING.fade);
    } else if (chars > 0) {
      chars -= 1; emit(); later(step, DEMO_TIMING.erase);
    } else {
      sceneIndex = (sceneIndex + 1) % DEMO_SCENES.length;
      phase = 'typing'; emit(); later(step, DEMO_TIMING.type);
    }
  }

  return {
    start() { if (timer !== null) return; emit(); later(step, DEMO_TIMING.lead); },
    stop() { if (timer !== null) { cancel(timer); timer = null; } },
    get running() { return timer !== null; },
    get state() { return snapshot(); },
  };
}
