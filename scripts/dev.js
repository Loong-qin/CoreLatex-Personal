import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const procs = [
  { name: 'server', cwd: path.join(ROOT, 'server'), args: ['run', 'dev'] },
  { name: 'web', cwd: path.join(ROOT, 'web'), args: ['run', 'dev'] },
];

const children = procs.map(({ name, cwd, args }) => {
  const child = spawn('npm', args, { cwd, shell: false });
  child.stdout.on('data', (d) => process.stdout.write(`[${name}] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[${name}] ${d}`));
  child.on('exit', (code) => {
    console.log(`[${name}] exited (${code})`);
    process.exitCode = code ?? 1;
    for (const c of children) if (c !== child) c.kill();
  });
  return child;
});

process.on('SIGINT', () => {
  for (const c of children) c.kill();
  process.exit(0);
});

console.log('CoreLatex dev：后端 http://127.0.0.1:3333，前端 http://127.0.0.1:5173');
