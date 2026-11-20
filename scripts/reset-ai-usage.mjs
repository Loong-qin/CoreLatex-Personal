#!/usr/bin/env node
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { DB_PATH } from '../server/src/config.js';
import { resetAiUsage } from '../server/src/services/agent/usageReset.js';
import { readMaintenanceOwnerFile } from './maintenance-owner-file.mjs';

let db;
try {
  const { values } = parseArgs({ options: {
    database: { type: 'string', default: DB_PATH },
    apply: { type: 'boolean', default: false },
    'owner-file': { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) {
    console.log('node scripts/reset-ai-usage.mjs [--database PATH] [--apply --owner-file PATH]\n' +
      'Preview is read-only. Apply clears AI usage once under an owned, active maintenance gate.');
  } else {
    const ownerToken = values.apply ? readMaintenanceOwnerFile(values['owner-file']) : undefined;
    const require = createRequire(new URL('../server/package.json', import.meta.url));
    const Database = require('better-sqlite3');
    // Use a separate connection so the application's startup recovery cannot run.
    db = new Database(values.database, { fileMustExist: true, readonly: !values.apply, timeout: 5000 });
    db.pragma('foreign_keys = ON');
    console.log(JSON.stringify(resetAiUsage(db, { apply: values.apply, ownerToken }), null, 2));
  }
} catch (error) {
  console.error(JSON.stringify({ error: error.message }));
  process.exitCode = 1;
} finally {
  db?.close();
}
