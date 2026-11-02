import 'dotenv/config';
import { createApplication } from './app.js';
import { readConfig } from './config.js';
import { jsonLog } from './telemetry.js';
import { MigrationError } from './migrate.js';

let startupReason = 'configuration_invalid';
const startupDeadline = setTimeout(() => {
  jsonLog({
    time: new Date().toISOString(),
    level: 'warn',
    event: 'startup_failed',
    reason: 'startup_timeout',
  });
  process.exit(1);
}, 20_000).unref();

async function main() {
  const config = readConfig();
  startupReason = 'initialization_failed';
  const application = await createApplication(config);
  startupReason = 'dependency_or_listen_failed';
  try {
    await application.listen();
  } catch (error) {
    await application.close().catch(() => {});
    throw error;
  }
  clearTimeout(startupDeadline);
  let closing = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      if (closing) return;
      closing = true;
      const timeout = setTimeout(() => {
        jsonLog({ time: new Date().toISOString(), level: 'warn', event: 'shutdown_failed' });
        process.exit(1);
      }, 15_000).unref();
      application.close().then(
        () => {
          clearTimeout(timeout);
          process.exit(0);
        },
        () => {
          jsonLog({ time: new Date().toISOString(), level: 'warn', event: 'shutdown_failed' });
          process.exit(1);
        },
      );
    });
  }
}
main().catch((error: unknown) => {
  clearTimeout(startupDeadline);
  // Configuration and dependency errors can contain credentials or SQL data.
  jsonLog({
    time: new Date().toISOString(),
    level: 'warn',
    event: 'startup_failed',
    reason: error instanceof MigrationError ? error.reason : startupReason,
  });
  process.exit(1);
});
