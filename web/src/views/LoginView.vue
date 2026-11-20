<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth.js';
import BrandMark from '../components/BrandMark.vue';
import { Sunny, Moon } from '@element-plus/icons-vue';
import { appearanceState, setThemePref, subscribeAppearance } from '../lib/theme.js';
import { createLoginDemo, DEMO_SCENES } from '../lib/loginDemo.js';

const router = useRouter();
const auth = useAuthStore();

const mode = ref('login'); // 'login' | 'register'
const username = ref('');
const password = ref('');
const displayName = ref('');
const error = ref('');
const loading = ref(false);

function switchMode() {
  error.value = '';
}

async function submit() {
  error.value = '';
  const u = username.value.trim();
  if (!u || !password.value) {
    error.value = '请输入用户名和密码';
    return;
  }
  if (mode.value === 'register' && !displayName.value.trim()) {
    error.value = '请输入昵称';
    return;
  }
  loading.value = true;
  try {
    if (mode.value === 'login') {
      await auth.login(u, password.value);
    } else {
      await auth.register(u, password.value, displayName.value.trim());
    }
    router.push('/');
  } catch (e) {
    error.value = e.message || '操作失败，请重试';
  } finally {
    loading.value = false;
  }
}

// ---------- 外观快捷切换（登录页右上角） ----------
const appearance = ref(appearanceState());
let unsubscribeAppearance = null;
function toggleMode() {
  setThemePref(appearance.value.mode === 'dark' ? 'light' : 'dark');
}

// ---------- 演示窗无缝循环内容 ----------
const demo = ref({ sceneIndex: 0, typed: '', phase: 'typing', compileMs: DEMO_SCENES[0].compileMs });
const scene = computed(() => DEMO_SCENES[demo.value.sceneIndex]);
const demoReady = computed(() => demo.value.phase === 'ready');
const reduceMotion = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
  ? window.matchMedia('(prefers-reduced-motion: reduce)')
  : { matches: false };
let timeline = null;
function onVisibility() {
  if (!timeline) return;
  if (document.visibilityState === 'hidden') timeline.stop();
  else timeline.start();
}

// ---------- 鼠标邻近互动：视差倾斜 / 磁吸徽章 / 光晕跟随 ----------
const demoEl = ref(null);
const aiFloat = ref(null);
const reviewFloat = ref(null);
const rest = { rx: 0, ry: 0, ax: 50, ay: 40, ao: 0, gax: 0, gay: 0, gbx: 0, gby: 0, aix: 0, aiy: 0, rvx: 0, rvy: 0 };
const cur = { ...rest };
const tgt = { ...rest };
let raf = 0;
function writeVars() {
  const el = demoEl.value;
  if (!el) return;
  const s = el.style;
  s.setProperty('--rx', `${cur.rx.toFixed(3)}deg`);
  s.setProperty('--ry', `${cur.ry.toFixed(3)}deg`);
  s.setProperty('--ax', `${cur.ax.toFixed(2)}%`);
  s.setProperty('--ay', `${cur.ay.toFixed(2)}%`);
  s.setProperty('--ao', cur.ao.toFixed(3));
  s.setProperty('--gax', `${cur.gax.toFixed(2)}px`);
  s.setProperty('--gay', `${cur.gay.toFixed(2)}px`);
  s.setProperty('--gbx', `${cur.gbx.toFixed(2)}px`);
  s.setProperty('--gby', `${cur.gby.toFixed(2)}px`);
  s.setProperty('--aix', `${cur.aix.toFixed(2)}px`);
  s.setProperty('--aiy', `${cur.aiy.toFixed(2)}px`);
  s.setProperty('--rvx', `${cur.rvx.toFixed(2)}px`);
  s.setProperty('--rvy', `${cur.rvy.toFixed(2)}px`);
}
function tick() {
  let delta = 0;
  for (const key of Object.keys(cur)) {
    const d = tgt[key] - cur[key];
    cur[key] += d * 0.14;
    delta = Math.max(delta, Math.abs(d));
  }
  writeVars();
  raf = delta > 0.002 ? requestAnimationFrame(tick) : 0;
}
function kick() { if (!raf) raf = requestAnimationFrame(tick); }
function magnet(el, x, y, outX, outY) {
  if (!el) return;
  const r = el.getBoundingClientRect();
  const dx = x - (r.left + r.width / 2);
  const dy = y - (r.top + r.height / 2);
  const dist = Math.hypot(dx, dy) || 1;
  const pull = Math.max(0, 1 - dist / 170);
  tgt[outX] = (dx / dist) * pull * 14;
  tgt[outY] = (dy / dist) * pull * 14;
}
function onPointerMove(e) {
  if (e.pointerType !== 'mouse' || reduceMotion.matches || !demoEl.value) return;
  const r = demoEl.value.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const px = (e.clientX - r.left) / r.width;
  const py = (e.clientY - r.top) / r.height;
  const nx = Math.max(-1, Math.min(1, px * 2 - 1));
  const ny = Math.max(-1, Math.min(1, py * 2 - 1));
  tgt.ry = nx * 3.2;
  tgt.rx = -ny * 2.6;
  tgt.ax = px * 100;
  tgt.ay = py * 100;
  tgt.ao = 1;
  tgt.gax = -nx * 10; tgt.gay = -ny * 8;
  tgt.gbx = nx * 12; tgt.gby = ny * 10;
  magnet(aiFloat.value, e.clientX, e.clientY, 'aix', 'aiy');
  magnet(reviewFloat.value, e.clientX, e.clientY, 'rvx', 'rvy');
  kick();
}
function onPointerLeave() {
  Object.assign(tgt, rest);
  kick();
}

onMounted(() => {
  unsubscribeAppearance = subscribeAppearance(s => { appearance.value = s; });
  if (reduceMotion.matches) {
    demo.value = { sceneIndex: 0, typed: DEMO_SCENES[0].section, phase: 'ready', compileMs: DEMO_SCENES[0].compileMs };
  } else {
    timeline = createLoginDemo({ onUpdate: s => { demo.value = s; } });
    timeline.start();
  }
  document.addEventListener('visibilitychange', onVisibility);
});
onBeforeUnmount(() => {
  unsubscribeAppearance?.();
  timeline?.stop();
  document.removeEventListener('visibilitychange', onVisibility);
  if (raf) cancelAnimationFrame(raf);
});
</script>

<template>
  <main class="login-page">
    <button
      class="mode-toggle"
      type="button"
      :aria-label="appearance.mode === 'dark' ? '切换到浅色模式' : '切换到深色模式'"
      :title="appearance.mode === 'dark' ? '切换到浅色模式' : '切换到深色模式'"
      @click="toggleMode"
    >
      <el-icon :size="16"><Moon v-if="appearance.mode === 'dark'" /><Sunny v-else /></el-icon>
    </button>
    <div class="login-layout">
      <section class="login-intro" aria-label="CoreLatex 工作台">
        <div class="login-brand"><BrandMark class="login-mark" :size="44" aria-hidden="true" /><h1>CoreLatex</h1></div>
        <p class="intro-eyebrow">LATEX WORKSPACE</p>
        <h2>从研究想法<br><span>到完整文稿。</span></h2>
        <p class="intro-copy">编辑 LaTeX、实时预览，与团队和智能体共同完成论文。</p>
        <div
          ref="demoEl"
          class="product-demo"
          aria-hidden="true"
          @pointermove="onPointerMove"
          @pointerleave="onPointerLeave"
        >
          <span class="demo-glow demo-glow-a"></span>
          <span class="demo-glow demo-glow-b"></span>
          <div class="demo-tilt">
            <div class="demo-window">
              <div class="demo-topbar">
                <span class="demo-dots"><i></i><i></i><i></i></span>
                <span class="demo-document"><b>T</b> main.tex</span>
                <span class="demo-saved" :class="{ busy: !demoReady }"><i></i> {{ demoReady ? '已保存' : '保存中…' }}</span>
              </div>
              <div class="demo-content">
                <div class="demo-editor">
                  <div class="demo-pane-title"><span>LaTeX 源码</span><span>main.tex</span></div>
                  <div class="code-block">
                    <div class="code-row"><span class="line-number">01</span><code><span class="code-keyword">\documentclass</span><span class="code-punct">{</span>article<span class="code-punct">}</span></code></div>
                    <div class="code-row"><span class="line-number">02</span><code><span class="code-keyword">\begin</span><span class="code-punct">{</span>document<span class="code-punct">}</span></code></div>
                    <div class="code-row"><span class="line-number">03</span><code>&nbsp;</code></div>
                    <div class="code-row"><span class="line-number">04</span><code><span class="code-keyword">\section</span><span class="code-punct">{</span><span class="typing-text">{{ demo.typed }}</span><span class="typing-caret"></span><span class="code-punct">}</span></code></div>
                    <div class="code-row"><span class="line-number">05</span><code class="code-comment"><Transition name="demo-swap" mode="out-in"><span :key="demo.sceneIndex">{{ scene.comment }}</span></Transition></code></div>
                    <div class="code-row"><span class="line-number">06</span><code class="code-math"><Transition name="demo-swap" mode="out-in"><span :key="demo.sceneIndex">{{ scene.math }}</span></Transition></code></div>
                    <div class="code-row"><span class="line-number">07</span><code>&nbsp;</code></div>
                    <div class="code-row"><span class="line-number">08</span><code><span class="code-keyword">\end</span><span class="code-punct">{</span>document<span class="code-punct">}</span></code></div>
                  </div>
                  <div class="demo-edit-note"><span class="editor-avatar">林</span><span>协作编辑中</span><i></i><i></i><i></i></div>
                </div>
                <span class="demo-flow" :class="{ active: demoReady }">→</span>
                <div class="demo-preview">
                  <div class="demo-pane-title"><span>即时预览</span><span class="pdf-label">PDF</span></div>
                  <div class="demo-paper" :class="{ compiling: !demoReady }">
                    <span class="paper-kicker">RESEARCH PAPER</span>
                    <Transition name="demo-swap" mode="out-in">
                      <div :key="demo.sceneIndex" class="paper-swap">
                        <div class="paper-heading">{{ scene.paperTitle[0] }}<br>{{ scene.paperTitle[1] }}</div>
                        <div class="paper-rule"></div>
                        <div class="paper-line long"></div>
                        <div class="paper-line"></div>
                        <div class="paper-equation">{{ scene.equation }}</div>
                        <div class="paper-line long"></div>
                        <div class="paper-line short"></div>
                      </div>
                    </Transition>
                    <div class="paper-footer"><span>01</span><span>CoreLatex</span></div>
                  </div>
                </div>
              </div>
              <div class="demo-footer">
                <span class="compile-status" :class="{ busy: !demoReady }"><i></i> {{ demoReady ? 'PDF 已更新' : '编译中…' }}</span>
                <span class="compile-time">{{ demoReady ? `${scene.compileMs} ms` : '…' }}</span>
              </div>
              <span class="demo-aura"></span>
            </div>
            <div ref="aiFloat" class="demo-float demo-float-ai"><span class="float-inner"><span class="float-icon">✦</span><span><strong>AI 协作</strong><small>让写作更从容</small></span></span></div>
            <div ref="reviewFloat" class="demo-float demo-float-review"><span class="float-inner"><span class="float-icon">✓</span><span><strong>变更可审查</strong><small>每一处修改清晰可见</small></span></span></div>
          </div>
        </div>
        <div class="intro-tools"><span>源文稿编辑</span><i></i><span>即时编译预览</span><i></i><span>团队协作</span></div>
      </section>
    <el-card class="login-card" shadow="never">
      <div class="form-heading"><span class="form-eyebrow">你的研究空间</span><h2>{{ mode === 'login' ? '欢迎回来' : '创建账户' }}</h2><p>{{ mode === 'login' ? '登录以继续你的文稿。' : '开始创建和管理你的 LaTeX 项目。' }}</p></div>

      <el-tabs v-model="mode" class="login-tabs" stretch @tab-change="switchMode">
        <el-tab-pane label="登录" name="login" />
        <el-tab-pane label="注册" name="register" />
      </el-tabs>

      <el-form label-position="top" @submit.prevent="submit">
        <el-form-item label="用户名">
          <el-input
            v-model="username"
            autocomplete="username"
            placeholder="用户名"
            size="large"
          />
        </el-form-item>
        <el-form-item v-if="mode === 'register'" label="昵称">
          <el-input
            v-model="displayName"
            autocomplete="nickname"
            placeholder="显示名称"
            size="large"
          />
        </el-form-item>
        <el-form-item label="密码">
          <el-input
            v-model="password"
            type="password"
            show-password
            :autocomplete="mode === 'login' ? 'current-password' : 'new-password'"
            placeholder="密码"
            size="large"
            @keyup.enter="submit"
          />
        </el-form-item>

        <el-alert
          v-if="error"
          :title="error"
          type="error"
          :closable="false"
          class="error-alert"
        />

        <el-button
          class="submit-btn"
          type="primary"
          size="large"
          native-type="submit"
          :loading="loading"
        >
          {{ mode === 'login' ? '登 录' : '注册并登录' }}
        </el-button>
      </el-form>
      <p class="form-foot">CoreLatex · LaTeX 论文工作台</p>
    </el-card>
    </div>
  </main>
</template>

<style scoped>
.login-page {
  position: relative;
  isolation: isolate;
  min-height: 100dvh;
  height: 100%;
  overflow: auto;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 42px 32px;
  background:
    radial-gradient(circle at 12% 14%, var(--ambient-1), transparent 31%),
    radial-gradient(circle at 86% 88%, var(--ambient-2), transparent 30%);
  color: var(--fg);
}
.mode-toggle {
  position: absolute;
  z-index: 5;
  top: 20px;
  right: 22px;
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  padding: 0;
  border: 1px solid var(--glass-edge);
  border-radius: 50%;
  background: var(--glass-g2-bg);
  color: var(--fg-dim);
  box-shadow: var(--shadow-sm);
  -webkit-backdrop-filter: var(--glass-g2-filter);
  backdrop-filter: var(--glass-g2-filter);
}
.mode-toggle:hover { color: var(--accent); background: var(--glass-g2-bg); }
.login-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 400px;
  align-items: center;
  gap: clamp(48px, 6vw, 88px);
  max-width: 1100px;
  width: 100%;
  margin: auto;
}
.login-intro { position: relative; min-width: 0; }
.login-brand { display: flex; align-items: center; gap: 12px; margin-bottom: 34px; }
.login-brand h1 { margin: 0; font-size: 23px; letter-spacing: -.035em; font-weight: 650; }
.login-mark {
  display: grid;
  place-items: center;
  flex: none;
  width: 44px;
  height: 44px;
  filter: drop-shadow(0 7px 18px color-mix(in srgb, var(--accent) 14%, transparent));
}
.login-mark svg { width: 100%; height: 100%; }
.intro-eyebrow { font-size: 10px; font-weight: 650; letter-spacing: .23em; color: var(--accent); margin: 0 0 13px; }
.login-intro h2 { font-size: clamp(35px, 3.2vw, 45px); font-weight: 600; line-height: 1.34; letter-spacing: -.045em; margin: 0 0 15px; }
.login-intro h2 span { color: var(--accent); }
.intro-copy { max-width: 38ch; color: var(--fg-dim); font-size: 14px; line-height: 1.85; margin: 0; }

.product-demo {
  position: relative;
  isolation: isolate;
  width: 100%;
  max-width: 500px;
  margin: 28px 0 23px;
  padding: 6px 12px 20px 4px;
}
.demo-glow { position: absolute; z-index: -1; border-radius: 50%; filter: blur(10px); pointer-events: none; }
.demo-glow-a { width: 240px; height: 240px; left: -52px; top: 34px; background: color-mix(in srgb, var(--accent) 20%, transparent); translate: var(--gax, 0px) var(--gay, 0px); animation: glow-breathe 9s ease-in-out infinite; }
.demo-glow-b { width: 210px; height: 210px; right: -26px; bottom: -18px; background: color-mix(in srgb, var(--accent-secondary) 16%, transparent); translate: var(--gbx, 0px) var(--gby, 0px); animation: glow-breathe 11s ease-in-out infinite reverse; }
.demo-tilt {
  transform: perspective(1100px) rotateX(var(--rx, 0deg)) rotateY(var(--ry, 0deg));
  will-change: transform;
}
.demo-window {
  position: relative;
  overflow: hidden;
  border: 1px solid var(--glass-edge);
  border-radius: 18px;
  background: var(--glass-g2-bg);
  box-shadow: var(--shadow-md), var(--glass-highlight);
  -webkit-backdrop-filter: var(--glass-g2-filter);
  backdrop-filter: var(--glass-g2-filter);
  animation: demo-drift 9s ease-in-out infinite;
}
.demo-aura {
  position: absolute;
  inset: 0;
  z-index: 4;
  border-radius: inherit;
  background: radial-gradient(260px circle at var(--ax, 50%) var(--ay, 40%), color-mix(in srgb, var(--accent) 9%, transparent), transparent 70%);
  opacity: var(--ao, 0);
  transition: opacity .35s var(--ease-standard);
  pointer-events: none;
}
.demo-topbar { height: 40px; display: flex; align-items: center; gap: 12px; padding: 0 14px; border-bottom: 1px solid color-mix(in srgb, var(--border) 60%, transparent); }
.demo-dots { display: flex; gap: 4px; }
.demo-dots i { width: 5px; height: 5px; border-radius: 50%; background: var(--bg3); }
.demo-dots i:first-child { background: color-mix(in srgb, var(--danger) 52%, var(--bg3)); }
.demo-dots i:nth-child(2) { background: color-mix(in srgb, var(--warn) 52%, var(--bg3)); }
.demo-dots i:last-child { background: color-mix(in srgb, var(--success) 52%, var(--bg3)); }
.demo-document { display: flex; align-items: center; gap: 6px; color: var(--fg-dim); font-family: var(--mono); font-size: 9px; }
.demo-document b { display: grid; place-items: center; width: 15px; height: 17px; border-radius: 4px; background: var(--accent-soft); color: var(--accent); font-family: Georgia, serif; font-size: 10px; }
.demo-saved { display: flex; align-items: center; gap: 5px; margin-left: auto; color: var(--fg-dim); font-size: 8px; }
.demo-saved i, .compile-status i { width: 5px; height: 5px; border-radius: 50%; background: var(--success); box-shadow: 0 0 0 3px var(--success-soft); }
.demo-saved.busy i, .compile-status.busy i { background: var(--warn); box-shadow: 0 0 0 3px var(--warn-soft); animation: demo-status-busy 1.2s ease-in-out infinite; }
.demo-content {
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 1.08fr) minmax(0, .92fr);
  gap: 12px;
  padding: 13px;
  background: linear-gradient(135deg, color-mix(in srgb, var(--accent) 5%, transparent), color-mix(in srgb, var(--accent-secondary) 5%, transparent));
}
.demo-editor, .demo-preview { min-width: 0; overflow: hidden; border: 1px solid color-mix(in srgb, var(--fg) 10%, transparent); border-radius: 10px; }
.demo-editor { background: color-mix(in srgb, var(--surface-raised) 82%, transparent); }
.demo-preview { background: color-mix(in srgb, var(--surface-muted) 74%, transparent); }
.demo-pane-title { display: flex; align-items: center; justify-content: space-between; gap: 8px; height: 30px; padding: 0 9px; border-bottom: 1px solid color-mix(in srgb, var(--fg) 9%, transparent); color: var(--fg-dim); font-size: 8px; }
.demo-pane-title > span:last-child { color: var(--fg-muted); font-family: var(--mono); font-size: 7px; }
.demo-pane-title .pdf-label { padding: 2px 5px; border-radius: 4px; background: color-mix(in srgb, var(--accent-secondary) 12%, transparent); color: var(--accent-secondary); font-family: var(--font); font-weight: 650; letter-spacing: .06em; }
.code-block { padding: 9px 7px 6px; }
.code-row { display: grid; grid-template-columns: 19px minmax(0, 1fr); align-items: center; min-height: 18px; font-family: var(--mono); font-size: 8px; line-height: 1.5; white-space: nowrap; }
.code-row code { overflow: hidden; color: var(--fg-dim); font-family: inherit; }
.line-number { color: var(--fg-muted); font-size: 7px; user-select: none; }
.code-keyword { color: var(--syntax-keyword); }
.code-punct { color: var(--syntax-type); }
.code-comment { color: var(--syntax-comment); }
.code-math { color: var(--syntax-atom); }
.typing-text { color: var(--accent); }
.typing-caret { display: inline-block; width: 1px; height: 10px; margin-left: 2px; vertical-align: -2px; background: var(--accent); animation: demo-caret 1.1s step-end infinite; }
.demo-edit-note { display: flex; align-items: center; gap: 4px; padding: 1px 9px 9px; color: var(--fg-dim); font-size: 7px; }
.editor-avatar { display: grid; place-items: center; width: 17px; height: 17px; margin-right: 2px; border-radius: 50%; background: color-mix(in srgb, var(--accent-secondary) 16%, transparent); color: var(--accent-secondary); font-size: 7px; }
.demo-edit-note i { width: 2px; height: 2px; border-radius: 50%; background: var(--accent); animation: demo-dot 1.5s ease-in-out infinite; }
.demo-edit-note i:nth-last-child(2) { animation-delay: .2s; }
.demo-edit-note i:last-child { animation-delay: .4s; }
.demo-flow {
  position: absolute;
  z-index: 2;
  left: 50%;
  top: 50%;
  display: grid;
  place-items: center;
  width: 23px;
  height: 23px;
  border: 1px solid var(--glass-edge);
  border-radius: 50%;
  background: var(--surface-raised);
  color: var(--fg-muted);
  font-size: 11px;
  box-shadow: var(--shadow-sm);
  transform: translate(-50%, -50%);
  transition: color var(--motion-surface) var(--ease-standard), box-shadow var(--motion-surface) var(--ease-standard);
}
.demo-flow.active { color: var(--accent); box-shadow: 0 4px 16px color-mix(in srgb, var(--accent) 22%, transparent); }
.demo-paper { min-height: 181px; margin: 10px; padding: 13px 12px 9px; border: 1px solid color-mix(in srgb, var(--fg) 8%, transparent); border-radius: 3px; background: var(--surface-raised); box-shadow: var(--shadow-sm); }
.paper-swap { transition: opacity var(--motion-surface) var(--ease-standard); }
.demo-paper.compiling .paper-swap { opacity: .55; }
.paper-kicker { display: block; margin-bottom: 8px; color: var(--fg-muted); font-size: 5px; letter-spacing: .16em; }
.paper-heading { margin-bottom: 9px; color: var(--fg); font-family: Georgia, serif; font-size: 14px; line-height: 1.25; letter-spacing: -.025em; }
.paper-rule { width: 20px; height: 2px; margin-bottom: 10px; border-radius: 2px; background: var(--accent); }
.paper-line { width: 87%; height: 2px; margin-bottom: 4px; border-radius: 2px; background: color-mix(in srgb, var(--fg) 10%, transparent); }
.paper-line.long { width: 100%; }
.paper-line.short { width: 62%; }
.paper-equation { margin: 12px 0; padding: 5px 0; border-radius: 5px; color: var(--accent-hover); background: var(--accent-soft); text-align: center; font-family: Georgia, serif; font-style: italic; font-size: 15px; }
.paper-footer { display: flex; justify-content: space-between; margin-top: 11px; padding-top: 6px; border-top: 1px solid color-mix(in srgb, var(--fg) 8%, transparent); color: var(--fg-muted); font-size: 5px; letter-spacing: .08em; }
.demo-footer { display: flex; align-items: center; justify-content: space-between; height: 32px; padding: 0 14px; border-top: 1px solid color-mix(in srgb, var(--border) 60%, transparent); color: var(--fg-dim); font-size: 8px; }
.compile-status { display: flex; align-items: center; gap: 6px; }
.compile-status:not(.busy) i { animation: demo-status 3s ease-in-out infinite; }
.compile-time { color: var(--fg-muted); font-family: var(--mono); font-size: 7px; }
.demo-float {
  position: absolute;
  z-index: 3;
  border: 1px solid var(--glass-edge);
  border-radius: 12px;
  background: var(--glass-g3-bg);
  box-shadow: var(--shadow-md), var(--glass-highlight);
  -webkit-backdrop-filter: var(--glass-g3-filter);
  backdrop-filter: var(--glass-g3-filter);
}
.demo-float-ai { top: 64px; right: -15px; translate: var(--aix, 0px) var(--aiy, 0px); }
.demo-float-review { left: -11px; bottom: 1px; translate: var(--rvx, 0px) var(--rvy, 0px); }
.float-inner { display: flex; align-items: center; gap: 8px; padding: 9px 12px 9px 9px; }
.demo-float-ai .float-inner { animation: demo-float-ai 7s ease-in-out infinite; }
.demo-float-review .float-inner { animation: demo-float-review 8s ease-in-out infinite; }
.float-icon { display: grid; place-items: center; width: 27px; height: 27px; border-radius: 8px; background: color-mix(in srgb, var(--accent-secondary) 14%, transparent); color: var(--accent-secondary); font-size: 13px; }
.demo-float-review .float-icon { background: var(--success-soft); color: var(--success); }
.demo-float strong, .demo-float small { display: block; white-space: nowrap; }
.demo-float strong { color: var(--fg); font-size: 9px; font-weight: 650; }
.demo-float small { margin-top: 2px; color: var(--fg-dim); font-size: 7px; }
.intro-tools { display: flex; align-items: center; gap: 12px; color: var(--fg-dim); font-size: 10px; }
.intro-tools i { height: 3px; width: 3px; background: var(--accent); border-radius: 50%; opacity: .38; }

.demo-swap-enter-active, .demo-swap-leave-active { transition: opacity .22s var(--ease-standard), transform .22s var(--ease-standard); }
.demo-swap-enter-from { opacity: 0; transform: translateY(4px); }
.demo-swap-leave-to { opacity: 0; transform: translateY(-4px); }

.login-card {
  width: 100%;
  border: 1px solid var(--glass-edge);
  border-radius: 22px;
  background: var(--glass-g3-bg);
  box-shadow: var(--shadow-lg), var(--glass-highlight);
  -webkit-backdrop-filter: var(--glass-g3-filter);
  backdrop-filter: var(--glass-g3-filter);
}
.login-card :deep(.el-card__body) { padding: 33px 32px 23px; }
.form-heading { margin-bottom: 24px; }
.form-eyebrow { font-size: 10px; color: var(--accent); font-weight: 600; letter-spacing: .10em; }
.form-heading h2 { font-size: 27px; line-height: 1.25; letter-spacing: -.035em; font-weight: 650; margin: 10px 0; }
.form-heading p { margin: 0; color: var(--fg-dim); font-size: 12px; line-height: 1.7; }
.login-tabs { margin-bottom: 23px; }
.login-tabs :deep(.el-tabs__header) { margin: 0; }
.login-tabs :deep(.el-tabs__nav-wrap)::after { display: none; }
.login-tabs :deep(.el-tabs__nav) { padding: 3px; border-radius: 10px; background: color-mix(in srgb, var(--bg3) 62%, transparent); }
.login-tabs :deep(.el-tabs__item) { position: relative; z-index: 1; height: 32px; line-height: 32px; color: var(--fg-dim); font-size: 12px; transition: color var(--motion-menu) var(--ease-standard); }
.login-tabs :deep(.el-tabs__item.is-active) { color: var(--accent-hover); }
.login-tabs :deep(.el-tabs__active-bar) { z-index: 0; bottom: 3px; height: 32px; border-radius: 8px; background: var(--surface-raised); box-shadow: var(--shadow-sm); }
.login-card :deep(.el-form-item) { margin-bottom: 20px; }
.login-card :deep(.el-form-item__label) { font-size: 12px; padding-bottom: 7px; color: var(--fg-dim); }
.login-card :deep(.el-input__wrapper) { min-height: 43px; border-radius: 10px; background: color-mix(in srgb, var(--surface-muted) 80%, transparent); box-shadow: 0 0 0 1px var(--border) inset; }
.login-card :deep(.el-input__wrapper:hover) { background: var(--surface-raised); }
.login-card :deep(.el-input__wrapper.is-focus) { background: var(--surface-raised); box-shadow: 0 0 0 1px var(--accent) inset, 0 0 0 3px var(--focus-ring); }
.error-alert { margin-bottom: 18px; text-align: left; }
.submit-btn { width: 100%; min-height: 43px; margin-top: 7px; border-radius: 10px; font-weight: 650; letter-spacing: .10em; box-shadow: 0 7px 16px color-mix(in srgb, var(--accent) 20%, transparent); }
.form-foot { margin: 25px 0 0; padding-top: 18px; border-top: 1px solid var(--border); color: var(--fg-dim); font-size: 10px; text-align: center; letter-spacing: .08em; }

@keyframes demo-drift { 0%, 100% { transform: translateY(0) rotate(-.2deg); } 50% { transform: translateY(-5px) rotate(.2deg); } }
@keyframes glow-breathe { 0%, 100% { scale: 1; opacity: .85; } 50% { scale: 1.12; opacity: 1; } }
@keyframes demo-caret { 0%, 46% { opacity: 1; } 47%, 100% { opacity: 0; } }
@keyframes demo-dot { 0%, 100% { opacity: .28; transform: translateY(0); } 50% { opacity: .9; transform: translateY(-1px); } }
@keyframes demo-status { 0%, 100% { box-shadow: 0 0 0 3px var(--success-soft); } 50% { box-shadow: 0 0 0 5px var(--success-soft); } }
@keyframes demo-status-busy { 0%, 100% { box-shadow: 0 0 0 3px var(--warn-soft); } 50% { box-shadow: 0 0 0 5px var(--warn-soft); } }
@keyframes demo-float-ai { 0%, 100% { transform: translate(0, 0); } 50% { transform: translate(-3px, -6px); } }
@keyframes demo-float-review { 0%, 100% { transform: translate(0, 0); } 50% { transform: translate(4px, 5px); } }

@media (max-width: 1050px) {
  .login-layout { grid-template-columns: minmax(0, 1fr) 370px; gap: 42px; }
  .login-intro h2 { font-size: 35px; }
  .product-demo { margin-top: 24px; }
  .demo-float-ai { right: -4px; }
  .demo-float-review { left: -4px; }
  .code-row { font-size: 7px; }
}
@media (max-width: 860px) and (min-width: 761px) {
  .login-page { padding-inline: 24px; }
  .login-layout { grid-template-columns: minmax(0, 1fr) 350px; gap: 30px; }
  .demo-float { display: none; }
  .demo-content { gap: 8px; padding: 9px; }
  .demo-paper { margin: 7px; padding-inline: 9px; }
}
@media (max-height: 760px) and (min-width: 761px) {
  .login-page { padding-block: 24px; }
  .login-brand { margin-bottom: 20px; }
  .login-intro h2 { font-size: 34px; }
  .product-demo { margin-block: 14px; padding-bottom: 16px; }
  .demo-content { padding: 10px; }
  .demo-paper { min-height: 164px; margin: 8px; }
}
@media (max-width: 760px) {
  .login-page { padding: 28px 20px; }
  .login-layout { grid-template-columns: 1fr; max-width: 400px; gap: 24px; }
  .login-brand { margin: 0; justify-content: center; }
  .login-intro h2, .intro-eyebrow, .intro-copy, .product-demo, .intro-tools { display: none; }
  .login-card { border-radius: 20px; }
  .login-card :deep(.el-card__body) { padding: 29px 24px 22px; }
  .form-heading { margin-bottom: 22px; }
  .mode-toggle { top: 14px; right: 14px; }
}
@media (prefers-reduced-motion: reduce) {
  .demo-window, .demo-glow-a, .demo-glow-b, .demo-float-ai .float-inner, .demo-float-review .float-inner { animation: none !important; }
  .demo-tilt { transform: none; }
  .typing-caret, .demo-edit-note i, .demo-saved i, .compile-status i { animation: none !important; }
  .demo-swap-enter-active, .demo-swap-leave-active, .demo-aura { transition: none; }
}
@media (update: slow), (prefers-reduced-transparency: reduce) {
  .demo-window, .login-card, .demo-float, .mode-toggle { border-color: var(--border); background: var(--surface-raised); -webkit-backdrop-filter: none; backdrop-filter: none; }
}
@media (forced-colors: active) {
  .demo-glow, .demo-aura { display: none; }
  .demo-window, .login-card, .demo-float, .mode-toggle { border-color: CanvasText; background: Canvas; box-shadow: none; }
}
</style>
