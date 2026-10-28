import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

// Benchmark-only IPC wrapper around the actual compiled production factory.
// No diagnostic endpoint or fault control is added to the packaged application.
const base = resolve(process.cwd(), 'apps/server/dist');
const { createApplication } = await import(pathToFileURL(resolve(base, 'app.js')).href);
const { readConfig } = await import(pathToFileURL(resolve(base, 'config.js')).href);
const databaseUrl = process.env.BENCH_DATABASE_URL;
const redisUrl = process.env.BENCH_REDIS_URL;
if (!databaseUrl || new URL(databaseUrl).pathname !== '/workspace_benchmark_test')
  throw new Error('Native benchmark requires its disposable benchmark database');
if (!redisUrl || new URL(redisUrl).hostname !== '127.0.0.1')
  throw new Error('Native benchmark requires its isolated Redis endpoint');
const app = await createApplication(
  readConfig({
    HOST: '127.0.0.1',
    PORT: '0',
    DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
    REDIS_PREFIX: 'commonplace-benchmark',
    METRICS_TOKEN: 'benchmark-disposable-metrics-only-0123456789',
    ALLOWED_ORIGINS: 'http://localhost:3100',
  }),
);
let cpu = process.cpuUsage(),
  sampledAt = performance.now(),
  closing = false;
process.on('message', (message: { id?: string; command?: string }) => {
  if (message.command !== 'resources' || typeof message.id !== 'string') return;
  const now = performance.now(),
    delta = process.cpuUsage(cpu);
  cpu = process.cpuUsage();
  process.send?.(
    {
      id: message.id,
      cpuPercent: (delta.user + delta.system) / ((now - sampledAt) * 10),
      rssBytes: process.memoryUsage().rss,
    },
    () => {},
  );
  sampledAt = now;
});
function stop() {
  if (closing) return;
  closing = true;
  const deadline = setTimeout(() => process.exit(1), 15000).unref();
  app.close().then(
    () => {
      clearTimeout(deadline);
      process.exit(0);
    },
    () => process.exit(1),
  );
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.on('disconnect', stop);
process.send?.(
  {
    type: 'ready',
    pid: process.pid,
    port: await app.listen(),
    node: process.version,
  },
  () => {},
);
