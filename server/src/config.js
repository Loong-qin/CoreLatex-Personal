import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const DATA_DIR = process.env.CORELATEX_DATA_DIR
  ? path.resolve(process.env.CORELATEX_DATA_DIR)
  : path.join(ROOT, 'data');

export const PORT = Number(process.env.PORT || 3333);
export const HOST = process.env.HOST || '127.0.0.1';

export const PROJECTS_DIR = path.join(DATA_DIR, 'projects');
export const SKILLS_DIR = path.join(DATA_DIR, 'skills');
export const DB_PATH = path.join(DATA_DIR, 'corelatex.db');

export function ensureDataDirs() {
  for (const d of [DATA_DIR, PROJECTS_DIR, SKILLS_DIR]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

export function getJwtSecret() {
  ensureDataDirs();
  const secretFile = path.join(DATA_DIR, 'secret.key');
  if (!fs.existsSync(secretFile)) {
    fs.writeFileSync(secretFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  }
  return fs.readFileSync(secretFile, 'utf8').trim();
}

export function projectDir(projectId) {
  return path.join(PROJECTS_DIR, String(projectId));
}
