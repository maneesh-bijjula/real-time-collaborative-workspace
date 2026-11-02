import 'dotenv/config';
import { parseArgs } from 'node:util';
import { Pool } from 'pg';
import { readConfig } from './config.js';
import { migrate, MigrationError } from './migrate.js';

let pool: Pool | undefined;
let deadline: ReturnType<typeof setTimeout> | undefined;
try {
  const { values } = parseArgs({
    options: {
      check: { type: 'boolean', default: false },
      'timeout-seconds': { type: 'string', default: '60' },
    },
  });
  const milliseconds = Number(values['timeout-seconds']) * 1000;
  if (!Number.isInteger(milliseconds) || milliseconds < 30000 || milliseconds > 3600000)
    throw new Error('Invalid migration deadline');
  deadline = setTimeout(() => {
    console.log(JSON.stringify({ event: 'migration_failed', reason: 'migration_timeout' }));
    process.exit(1);
  }, milliseconds + 5000).unref();
  const config = readConfig();
  pool = new Pool({
    connectionString: config.databaseUrl,
    max: 1,
    connectionTimeoutMillis: 5000,
    statement_timeout: milliseconds,
    query_timeout: milliseconds + 2000,
    idle_in_transaction_session_timeout: 5000,
  });
  pool.on('error', () => {});
  await migrate(pool, { checkOnly: values.check });
  console.log(
    JSON.stringify({ event: values.check ? 'migration_check_passed' : 'migration_completed' }),
  );
} catch (error) {
  console.log(
    JSON.stringify({
      event: 'migration_failed',
      reason: error instanceof MigrationError ? error.reason : 'configuration_invalid',
    }),
  );
  process.exitCode = 1;
} finally {
  await pool?.end().catch(() => {
    process.exitCode = 1;
    console.log(JSON.stringify({ event: 'migration_failed', reason: 'cleanup_failed' }));
  });
  clearTimeout(deadline);
}
