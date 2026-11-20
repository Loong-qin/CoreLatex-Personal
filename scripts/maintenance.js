#!/usr/bin/env node
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { DB_PATH } from '../server/src/config.js';
import { acquireMaintenance, maintenanceStatus, renewMaintenance, releaseMaintenance } from '../server/src/services/maintenance.js';
import { readMaintenanceOwnerFile } from './maintenance-owner-file.mjs';

const require = createRequire(new URL('../server/package.json', import.meta.url));
const Database = require('better-sqlite3');
const args = process.argv.slice(2), command = args.shift();
let database = DB_PATH, ownerFile, ttlMs = 15 * 60 * 1000, childArgs = [];
let db, createdOwner = false;

function loadOwner(create = false) {
  if (!ownerFile) throw new Error('--owner-file is required');
  if (create && !fs.existsSync(ownerFile)) {
    fs.writeFileSync(ownerFile, randomBytes(32).toString('hex') + '\n', { flag: 'wx', mode: 0o600 });
    createdOwner = true;
  }
  return readMaintenanceOwnerFile(ownerFile);
}
function print(value) { process.stdout.write(JSON.stringify(value) + '\n'); }

try {
  while (args.length) {
    const option = args.shift();
    if (option === '--') { childArgs = args.splice(0); break; }
    if (!args.length) throw new Error('Missing option value');
    const value = args.shift();
    if (option === '--database') database = value;
    else if (option === '--owner-file') ownerFile = value;
    else if (option === '--ttl-seconds') ttlMs = Number(value) * 1000;
    else throw new Error('Unknown option: ' + option);
  }
  if (!['acquire', 'status', 'renew', 'release', 'with'].includes(command)) throw new Error('Usage: maintenance.js acquire|status|renew|release|with --owner-file PATH [--database PATH] [--ttl-seconds N] [-- command args...]');
  if (command === 'with' && !childArgs.length) throw new Error('with requires a child command after --');
  if (command !== 'with' && childArgs.length) throw new Error('Only with accepts a child command');
  db = new Database(database, { fileMustExist: true, timeout: 5000 });
  // Do not call getDb(): its application-start recovery must never run inside
  // a maintenance inspection process. Old binaries must be bootstrapped by an
  // external admission barrier; a CLI alone cannot retrofit their admission.
  for (const table of ['maintenance_gate', 'compile_leases', 'agent_runs']) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) throw new Error('Application does not support atomic maintenance; refusing to claim a gate');
  }
  if (command === 'status') print(maintenanceStatus(db));
  else {
    const ownerToken = loadOwner(command === 'acquire' || command === 'with');
    if (command === 'release') print(releaseMaintenance(db, { ownerToken }));
    else if (command === 'renew') print(renewMaintenance(db, { ownerToken, ttlMs }));
    else {
      let acquired = false;
      try {
        const status = acquireMaintenance(db, { ownerToken, ttlMs }); acquired = true;
        print(status);
        if (command === 'with') {
          let timer, terminateTimer, renewalError, terminatingSignal;
          const child = spawn(childArgs[0], childArgs.slice(1), { stdio: 'inherit', shell: false });
          const terminate = signal => {
            terminatingSignal = signal;
            child.kill('SIGTERM');
            terminateTimer ??= setTimeout(() => child.kill('SIGKILL'), 5000);
            terminateTimer.unref();
          };
          const sigint = () => terminate('SIGINT'), sigterm = () => terminate('SIGTERM');
          process.on('SIGINT', sigint); process.on('SIGTERM', sigterm);
          timer = setInterval(() => {
            try { renewMaintenance(db, { ownerToken, ttlMs }); }
            catch (error) { renewalError = error; terminate('maintenance-expired'); }
          }, Math.max(1000, Math.floor(ttlMs / 3)));
          timer.unref();
          try {
            const exit = await new Promise((resolve, reject) => {
              child.once('error', reject);
              child.once('close', (code, signal) => resolve({ code, signal }));
            });
            if (renewalError) throw renewalError;
            process.exitCode = terminatingSignal || exit.signal ? 1 : exit.code ?? 1;
          } finally {
            clearInterval(timer); clearTimeout(terminateTimer);
            process.removeListener('SIGINT', sigint); process.removeListener('SIGTERM', sigterm);
          }
        }
      } finally {
        if (command === 'with' && acquired) releaseMaintenance(db, { ownerToken });
        // A failed acquire must not strand a credential whose gate never began.
        if (!acquired && createdOwner) fs.unlinkSync(ownerFile);
      }
    }
  }
} catch (error) {
  process.stderr.write(JSON.stringify({ error: error.message, status: error.status || 1, ...(error.work ? { work: error.work } : {}) }) + '\n');
  process.exitCode = 1;
} finally { db?.close(); }
