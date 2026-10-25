import 'dotenv/config';
import { createApplication } from './app.js';
import { readConfig } from './config.js';
import { jsonLog } from './telemetry.js';

async function main() {
  const application = await createApplication(readConfig());
  await application.listen();
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
main().catch(() => {
  // Configuration and dependency errors can contain credentials or SQL data.
  jsonLog({ time: new Date().toISOString(), level: 'warn', event: 'startup_failed' });
  process.exit(1);
});
