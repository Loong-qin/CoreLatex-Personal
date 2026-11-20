#!/usr/bin/env node
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { DB_PATH } from '../server/src/config.js';
import { reconcileAiUsage } from '../server/src/services/agent/usageReconciliation.js';

let db;
try {
  const { values } = parseArgs({ options: {
    database: { type: 'string', default: DB_PATH },
    from: { type: 'string' },
    apply: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) {
    console.log('node scripts/reconcile-ai-usage.mjs [--database PATH] [--from YYYY-MM-DD] [--apply]\n' +
      'Run without --apply to preview matches using a read-only connection.\n' +
      '--from limits matches to legacy rows recorded on or after the Beijing calendar date.');
  } else {
    const require = createRequire(new URL('../server/package.json', import.meta.url));
    const Database = require('better-sqlite3');
    // The server's getDb() also performs restart recovery. Open this connection
    // independently so inspecting the ledger does not change any run's state.
    db = new Database(values.database, { fileMustExist: true, readonly: !values.apply, timeout: 5000 });
    db.pragma('foreign_keys = ON');
    console.log(JSON.stringify(reconcileAiUsage(db, { apply: values.apply, from: values.from }), null, 2));
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  db?.close();
}
