import { createApplication } from '../../apps/server/src/app.js';
import type { ServerConfig } from '../../apps/server/src/config.js';

const config = JSON.parse(process.env.PERSISTENCE_TEST_CONFIG!) as ServerConfig;
if (!new URL(config.databaseUrl).pathname.endsWith('_test'))
  throw new Error('Process fixtures require a dedicated test database');
const application = await createApplication(config, { shutdownTimeoutMs: 1000 });
if (process.env.FAIL_PERSISTENCE === '1') {
  application.store.store = async () => {
    throw new Error('Injected persistent store failure');
  };
}
process.send!({ port: await application.listen() });
process.on('SIGTERM', () => {
  application.close().then(
    () => process.exit(0),
    () => process.exit(1),
  );
});
