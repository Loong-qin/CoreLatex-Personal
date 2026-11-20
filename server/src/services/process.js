import { spawn } from 'node:child_process';
import { runtimeEnvironment, runtimeGuardStreams } from './runtimeEnvironment.js';

// Output is bounded while it is read; cancellation terminates the owned process group.
export function runProcess(command, args = [], {
  cwd, env, signal, timeoutMs = 60000, maxOutputBytes = 1024 * 1024,
} = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const grouped = process.platform !== 'win32';
    const child = spawn(command, args, { cwd, env: runtimeEnvironment(env || process.env), detached: grouped, stdio: ['ignore', 'pipe', 'pipe', ...runtimeGuardStreams()] });
    const chunks = { stdout: [], stderr: [] };
    const sizes = { stdout: 0, stderr: 0 };
    let outputTruncated = false, timedOut = false, aborted = false;
    const kill = () => {
      try {
        if (grouped && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') try { child.kill('SIGKILL'); } catch {}
      }
    };
    const abort = () => { aborted = true; kill(); };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    for (const stream of ['stdout', 'stderr']) {
      child[stream].on('data', (value) => {
        const remaining = Math.max(0, maxOutputBytes - sizes[stream]);
        if (value.length > remaining) outputTruncated = true;
        if (remaining) {
          const kept = value.subarray(0, remaining);
          chunks[stream].push(kept);
          sizes[stream] += kept.length;
        }
      });
    }
    child.once('error', (error) => { cleanup(); reject(error); });
    child.once('close', (code, exitSignal) => {
      cleanup();
      // Do not leave background descendants running after their tool has returned.
      if (grouped) kill();
      if (aborted || signal?.aborted) {
        reject(signal?.reason || new DOMException('Operation cancelled', 'AbortError'));
        return;
      }
      resolve({
        stdout: Buffer.concat(chunks.stdout).toString('utf8'),
        stderr: Buffer.concat(chunks.stderr).toString('utf8'),
        exitCode: timedOut ? 124 : (code ?? 1),
        exitSignal, timedOut, outputTruncated,
      });
    });
  });
}
