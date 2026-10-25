import { createApplication } from '../../apps/server/src/app.js';
import { readConfig } from '../../apps/server/src/config.js';

const config = readConfig(process.env);
if (!new URL(config.databaseUrl).pathname.endsWith('_test'))
  throw new Error('Collaboration process fixtures require an isolated test database');
const application = await createApplication(config, { shutdownTimeoutMs: 1500 });
const originalStore = application.store.store.bind(application.store);
let failPersistence = false;
application.store.store = async (...args) => {
  if (failPersistence) throw new Error('Injected persistence failure');
  return originalStore(...args);
};
process.send!({ type: 'ready', port: await application.listen(), pid: process.pid });

process.on('message', async (message: { id: string; command: string }) => {
  try {
    const redis = application.synchronization;
    switch (message.command) {
      case 'disconnectSubscriber':
        redis.sub.disconnect();
        break;
      case 'reconnectSubscriber':
        await redis.sub.connect();
        await redis.reconcileNow();
        break;
      case 'disconnectRedis':
        redis.pub.disconnect();
        redis.sub.disconnect();
        break;
      case 'reconnectRedis':
        await Promise.all([redis.pub.connect(), redis.sub.connect()]);
        await redis.reconcileNow();
        break;
      case 'pausePersistence':
        failPersistence = true;
        break;
      case 'resumePersistence':
        failPersistence = false;
        break;
      case 'closeClients':
        application.collaboration.closeConnections();
        break;
      case 'repair':
        await redis.reconcileNow();
        break;
      case 'inspect':
        break;
      default:
        throw new Error('Unknown fixture command');
    }
    process.send?.({
      id: message.id,
      result: {
        pid: process.pid,
        publisher: redis.pub.status,
        subscriber: redis.sub.status,
        completedRepairs: redis.completedRepairs,
        documents: application.collaboration.getDocumentsCount(),
      },
    });
  } catch (error) {
    process.send?.({
      id: message.id,
      error: error instanceof Error ? error.message : 'Fixture command failed',
    });
  }
});
process.on('SIGTERM', () => {
  application.close().then(
    () => process.exit(0),
    () => process.exit(1),
  );
});
