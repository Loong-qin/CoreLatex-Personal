import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let contexts, storage, sound;
const parameter = () => ({
  events: [],
  setValueAtTime(value, time) { this.events.push({ kind: 'set', value, time }); },
  linearRampToValueAtTime(value, time) { this.events.push({ kind: 'linear', value, time }); },
  exponentialRampToValueAtTime(value, time) { this.events.push({ kind: 'exponential', value, time }); },
});
class AudioContextStub {
  constructor() { this.state = 'suspended'; this.currentTime = 8; this.destination = {}; this.tones = []; this.gains = []; contexts.push(this); }
  async resume() { this.state = 'running'; }
  createGain() {
    const gain = { gain: parameter(), connect: vi.fn(), disconnect: vi.fn() };
    this.gains.push(gain); return gain;
  }
  createOscillator() {
    const tone = { frequency: parameter(), connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn() };
    this.tones.push(tone); return tone;
  }
}
const complete = (runId, extra = {}) => sound.notifyAgentCompletion({ runId, projectId: 'p1', state: 'completed', live: true, ...extra });
beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers(); vi.setSystemTime(1000000);
  contexts = []; storage = new Map();
  vi.stubGlobal('AudioContext', AudioContextStub);
  vi.stubGlobal('localStorage', { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) });
  vi.stubGlobal('navigator', {});
  sound = await import('./agentCompletionSound.js');
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('agent completion chime', () => {
  it('plays a short, softly attacked and decaying two-note chime, then releases all audio nodes', async () => {
    sound.setCompletionSoundEnabled(true);
    await sound.unlockCompletionSound();
    expect(contexts[0].tones).toHaveLength(0);
    expect(await complete('finished')).toBe(true);
    const { tones, gains, currentTime } = contexts[0];
    expect(tones.length).toBeGreaterThan(1);
    const starts = [...new Set(tones.map(tone => tone.start.mock.calls[0][0]))].sort();
    expect(starts).toHaveLength(2);
    expect(starts[1] - starts[0]).toBeGreaterThan(0.1);
    const fundamentals = starts.map(time => Math.min(...tones.filter(tone => tone.start.mock.calls[0][0] === time).map(tone => tone.frequency.events[0].value)));
    expect(fundamentals[1] / fundamentals[0]).toBeCloseTo(1.5, 2);
    for (const tone of tones) {
      expect(tone.type).toBe('sine');
      expect(tone.stop.mock.calls[0][0] - currentTime).toBeLessThan(1.2);
      expect(tone.stop.mock.calls[0][0]).toBeGreaterThan(tone.start.mock.calls[0][0]);
    }
    for (const gain of gains.slice(1)) {
      expect(gain.gain.events[0].value).toBe(0);
      expect(gain.gain.events.at(-1).value).toBe(0);
      expect(Math.max(...gain.gain.events.map(event => event.value))).toBeLessThan(0.2);
      expect(gain.gain.events.some(event => event.kind === 'exponential')).toBe(true);
    }
    tones.forEach(tone => tone.onended());
    [...tones, ...gains].forEach(node => expect(node.disconnect).toHaveBeenCalledOnce());
  });

  it('never plays on history restoration, unknown outcomes, failure, cancellation or interruption', async () => {
    sound.setCompletionSoundEnabled(true); await sound.unlockCompletionSound();
    for (const state of ['failed', 'cancelled', 'interrupted', 'running', undefined]) {
      expect(await complete(state || 'unknown', { state })).toBe(false);
    }
    expect(await complete('old', { live: false })).toBe(false);
    expect(await sound.notifyAgentCompletion({ runId: 'old', state: 'completed' })).toBe(false);
    expect(await complete('')).toBe(false);
    expect(contexts[0].tones).toHaveLength(0);
  });

  it('stays silent before preferences load and consumes muted events instead of replaying them after enabling', async () => {
    await sound.unlockCompletionSound();
    expect(await complete('before-settings')).toBe(false);
    sound.setCompletionSoundEnabled(true);
    expect(await complete('before-settings')).toBe(false);
    expect(await complete('explicit-muted', { enabled: false })).toBe(false);
    expect(await complete('explicit-muted')).toBe(false);
    expect(await complete('new')).toBe(true);
    sound.setCompletionSoundEnabled(false);
    vi.advanceTimersByTime(1000);
    expect(await complete('after-muted')).toBe(false);
  });

  it('rejects a delayed settings response after the user has switched sound off', async () => {
    sound.setCompletionSoundEnabled(true); await sound.unlockCompletionSound();
    const requestRevision = sound.getCompletionSoundRevision();
    sound.setCompletionSoundEnabled(false);
    expect(sound.getCompletionSoundRevision()).toBeGreaterThan(requestRevision);
    expect(sound.syncCompletionSoundPreference(true, requestRevision)).toBe(false);
    expect(await complete('after-stale-settings')).toBe(false);
    expect(contexts[0].tones).toHaveLength(0);
  });

  it('accepts only the current preference snapshot and invalidates other pending responses', async () => {
    await sound.unlockCompletionSound();
    const requestRevision = sound.getCompletionSoundRevision();
    expect(sound.syncCompletionSoundPreference(true, requestRevision)).toBe(true);
    expect(sound.getCompletionSoundRevision()).toBeGreaterThan(requestRevision);
    expect(sound.syncCompletionSoundPreference(false, requestRevision)).toBe(false);
    expect(sound.syncCompletionSoundPreference(false)).toBe(false);
    expect(await complete('current-settings')).toBe(true);
    const beforeLogout = sound.getCompletionSoundRevision();
    sound.setCompletionSoundEnabled(false);
    expect(sound.syncCompletionSoundPreference(true, beforeLogout)).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(await complete('after-logout')).toBe(false);
  });

  it('does not create or resume audio on task completion, or delay an old chime until the next gesture', async () => {
    sound.setCompletionSoundEnabled(true);
    expect(await complete('locked')).toBe(false);
    expect(contexts).toHaveLength(0);
    const target = new EventTarget();
    const dispose = sound.installCompletionSoundUnlock(target);
    target.dispatchEvent(new Event('pointerdown'));
    await Promise.resolve(); await Promise.resolve();
    expect(contexts).toHaveLength(1);
    expect(contexts[0].tones).toHaveLength(0);
    expect(await complete('locked')).toBe(false);
    expect(await complete('next')).toBe(true);
    dispose();
    contexts[0].state = 'suspended';
    target.dispatchEvent(new Event('keydown'));
    await Promise.resolve();
    expect(contexts[0].state).toBe('suspended');
  });

  it('deduplicates replayed events across fresh page instances and serializes cross-tab notification claims', async () => {
    let pending = Promise.resolve();
    const request = vi.fn((name, callback) => {
      const result = pending.then(callback); pending = result.catch(() => {}); return result;
    });
    vi.stubGlobal('navigator', { locks: { request } });
    sound.setCompletionSoundEnabled(true); await sound.unlockCompletionSound();
    vi.resetModules();
    const other = await import('./agentCompletionSound.js');
    other.setCompletionSoundEnabled(true); await other.unlockCompletionSound();
    const event = { runId: 'one-run', projectId: 'p1', state: 'completed', live: true };
    expect((await Promise.all([sound.notifyAgentCompletion(event), other.notifyAgentCompletion(event)])).filter(Boolean)).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    expect(await other.notifyAgentCompletion(event)).toBe(false);
    expect(contexts.filter(audio => audio.tones.length)).toHaveLength(1);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each(['muted', 'locked'])('a %s tab does not steal the completion chime from another ready tab', async (mode) => {
    if (mode === 'muted') await sound.unlockCompletionSound();
    else sound.setCompletionSoundEnabled(true);
    const event = { runId: 'shared-finish', projectId: 'p1', state: 'completed', live: true };
    expect(await sound.notifyAgentCompletion(event)).toBe(false);
    expect(storage.size).toBe(0);
    vi.resetModules();
    const ready = await import('./agentCompletionSound.js');
    ready.setCompletionSoundEnabled(true); await ready.unlockCompletionSound();
    expect(await ready.notifyAgentCompletion(event)).toBe(true);
    sound.setCompletionSoundEnabled(true); await sound.unlockCompletionSound();
    vi.advanceTimersByTime(1000);
    expect(await sound.notifyAgentCompletion(event)).toBe(false);
    expect(contexts.filter(audio => audio.tones.length)).toHaveLength(1);
  });

  it('coalesces simultaneous different runs across ready tabs into one notification', async () => {
    sound.setCompletionSoundEnabled(true); await sound.unlockCompletionSound();
    expect(await complete('project-one')).toBe(true);
    vi.resetModules();
    const other = await import('./agentCompletionSound.js');
    other.setCompletionSoundEnabled(true); await other.unlockCompletionSound();
    const event = { runId: 'project-two', projectId: 'p2', state: 'completed', live: true };
    expect(await other.notifyAgentCompletion(event)).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(await other.notifyAgentCompletion(event)).toBe(false);
    expect(contexts[1].tones).toHaveLength(0);
  });

  it('allows an explicit preview while muted without enabling future completion sounds', async () => {
    expect(await sound.previewCompletionSound()).toBe(true);
    const previewTones = contexts[0].tones.length;
    vi.advanceTimersByTime(1000);
    expect(await complete('muted')).toBe(false);
    expect(contexts[0].tones).toHaveLength(previewTones);
  });

  it('coalesces a burst of concurrent completions without replaying it later', async () => {
    sound.setCompletionSoundEnabled(true); await sound.unlockCompletionSound();
    expect(await complete('one')).toBe(true);
    expect(await complete('two')).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(await complete('two')).toBe(false);
    expect(await complete('three')).toBe(true);
  });

  it('treats unsupported audio, blocked storage, restricted locks and failed resume as nonfatal', async () => {
    vi.stubGlobal('AudioContext', undefined);
    expect(await sound.previewCompletionSound()).toBe(false);
    vi.stubGlobal('AudioContext', AudioContextStub);
    vi.stubGlobal('localStorage', { getItem() { throw new Error('blocked'); } });
    vi.stubGlobal('navigator', { locks: { request: () => Promise.reject(new Error('restricted')) } });
    sound.setCompletionSoundEnabled(true); await sound.unlockCompletionSound();
    expect(await complete('storage-blocked')).toBe(true);
    expect(await complete('storage-blocked')).toBe(false);
    contexts[0].state = 'suspended';
    contexts[0].resume = () => Promise.reject(new Error('gesture required'));
    expect(await sound.previewCompletionSound()).toBe(false);
    expect(await complete('audio-blocked')).toBe(false);
  });
});


describe('question chime', () => {
  const question = (questionId, extra = {}) => sound.notifyAgentQuestion({ projectId: 'p1', runId: 'r1', questionId, live: true, ...extra });
  it('deduplicates each question independently of the completion and other questions', async () => {
    sound.setCompletionSoundEnabled(true); await sound.unlockCompletionSound();
    expect(await question('q1')).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(await question('q1')).toBe(false);
    expect(await question('q2')).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(await complete('r1')).toBe(true);
  });
  it('keeps restored, muted and locked questions silent without replaying on a later click', async () => {
    expect(await question('locked')).toBe(false);
    sound.setCompletionSoundEnabled(true); await sound.unlockCompletionSound();
    expect(await question('locked')).toBe(false);
    expect(await question('restored', { live: false })).toBe(false);
    expect(await question('muted', { enabled: false })).toBe(false);
    expect(await question('muted')).toBe(false);
    expect(await question('')).toBe(false);
    expect(contexts[0].tones).toHaveLength(0);
  });
  it('deduplicates the same question across page instances', async () => {
    sound.setCompletionSoundEnabled(true); await sound.unlockCompletionSound();
    expect(await question('cross-tab')).toBe(true);
    vi.resetModules(); const other = await import('./agentCompletionSound.js');
    other.setCompletionSoundEnabled(true); await other.unlockCompletionSound(); vi.advanceTimersByTime(1000);
    expect(await other.notifyAgentQuestion({ projectId: 'p1', runId: 'r1', questionId: 'cross-tab', live: true })).toBe(false);
    expect(contexts[1].tones).toHaveLength(0);
  });
});
