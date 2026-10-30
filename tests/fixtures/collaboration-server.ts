import { createApplication } from '../../apps/server/src/app.js';
import { readConfig } from '../../apps/server/src/config.js';
import { once } from 'node:events';

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

async function disconnect(client: typeof application.synchronization.pub) {
  if (client.status === 'end') return;
  const ended = once(client, 'end');
  client.disconnect();
  // ioredis disconnect() returns before its socket close handler changes the
  // status. A fault acknowledgement must mean the transport is actually down.
  await ended;
}

process.on('message', async (message: { id: string; command: string }) => {
  try {
    const redis = application.synchronization;
    switch (message.command) {
      case 'disconnectSubscriber':
        await disconnect(redis.sub);
        break;
      case 'reconnectSubscriber':
        await redis.sub.connect();
        await redis.reconcileNow();
        break;
      case 'disconnectRedis':
        await Promise.all([disconnect(redis.pub), disconnect(redis.sub)]);
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
        synchronizationHealthy: redis.healthy,
        persistenceFailures: application.persistence.failureCount,
        dependencies: (
          await application.telemetry.registry.getSingleMetric('commonplace_dependency_up')?.get()
        )?.values,
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
