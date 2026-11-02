import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { Compose, OperationError, root, run, event } from './lib/compose.mjs';

const [mode, ...args] = process.argv.slice(2);
const abort = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => abort.abort());
let owned, api, apiExited;

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
function loopback(port) {
  if (!/^127\.0\.0\.1:\d+$/.test(port)) throw new OperationError('unexpected_test_binding');
  return port;
}
async function externalBrowserEnvironment() {
  const project = process.env.CLUSTER_VERIFY_PROJECT || 'commonplace-verify';
  if (
    !['commonplace-verify', 'commonplace-sprint2-verify', 'commonplace-sprint3-verify'].includes(
      project,
    )
  )
    throw new OperationError('disposable_external_project_required');
  const compose = new Compose(project, ['compose.verify.yaml', 'compose.cluster.yaml']);
  const config = JSON.parse(await compose.run(['config', '--format', 'json']));
  const pg = config.services.postgres;
  if (
    !pg.tmpfs?.includes('/var/lib/postgresql/data') ||
    pg.volumes?.length ||
    !pg.environment.POSTGRES_DB.endsWith('_test')
  )
    throw new OperationError('temporary_external_database_required');
  const id = await compose.run(['ps', '-q', 'postgres']);
  if (!/^[a-f0-9]+$/.test(id)) throw new OperationError('external_database_unavailable');
  const [container] = JSON.parse(await run('docker', ['inspect', id]));
  if (!Object.hasOwn(container.HostConfig.Tmpfs ?? {}, '/var/lib/postgresql/data'))
    throw new OperationError('temporary_running_database_required');
  if (
    container.Mounts.some(
      (m) => m.Destination.startsWith('/var/lib/postgresql/data') && m.Type !== 'tmpfs',
    ) ||
    !container.Config.Env.includes('POSTGRES_DB=' + pg.environment.POSTGRES_DB)
  )
    throw new OperationError('external_database_mismatch');
  const database = new URL(process.env.DATABASE_URL || '');
  const address = loopback(await compose.run(['port', 'postgres', '5432']));
  if (
    !['localhost', '127.0.0.1'].includes(database.hostname) ||
    database.port !== address.split(':')[1] ||
    database.pathname !== '/' + pg.environment.POSTGRES_DB
  )
    throw new OperationError('external_database_url_mismatch');
  const webAddress = loopback(await compose.run(['port', 'web', '3000']));
  const base = new URL(process.env.E2E_BASE_URL || '');
  if (
    base.protocol !== 'http:' ||
    !['localhost', '127.0.0.1'].includes(base.hostname) ||
    base.port !== webAddress.split(':')[1]
  )
    throw new OperationError('external_browser_url_mismatch');
  const sockets = [];
  for (const service of ['server', 'server2', 'server3', 'server4']) {
    const port = loopback(await compose.run(['port', service, '4000'])).split(':')[1];
    sockets.push(`ws://localhost:${port}/collaboration`);
  }
  return {
    ...process.env,
    E2E_MANAGED_RUN: '1',
    E2E_EXTERNAL: '1',
    E2E_CLUSTER_WEBSOCKETS: sockets.join(','),
  };
}

try {
  if (!['integration', 'browser'].includes(mode)) throw new OperationError('test_mode_required');
  if (mode === 'browser' && process.env.E2E_EXTERNAL === '1') {
    const env = await externalBrowserEnvironment();
    await run(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', ...args], {
      env,
      inherit: true,
      signal: abort.signal,
    });
  } else {
    const project = 'commonplace-test-' + Date.now() + '-' + randomBytes(4).toString('hex');
    owned = new Compose(project, ['compose.test.yaml']);
    event('test_services_starting', { project });
    await owned.run(['up', '-d', '--wait'], { signal: abort.signal });
    const pg = loopback(await owned.run(['port', 'postgres', '5432']));
    const redis = loopback(await owned.run(['port', 'redis', '6379']));
    const database = `postgres://workspace:isolated-tests-only@${pg}/workspace_isolated_test`;
    const env = {
      ...process.env,
      DATABASE_URL: database,
      TEST_DATABASE_URL: database,
      REDIS_URL: `redis://${redis}`,
      TEST_REDIS_URL: `redis://${redis}`,
      REDIS_PREFIX: project,
      E2E_MANAGED_RUN: '1',
      E2E_EXTERNAL: '',
      NEXT_TELEMETRY_DISABLED: '1',
    };
    if (mode === 'integration') {
      await run(
        process.execPath,
        [
          'node_modules/vitest/vitest.mjs',
          'run',
          '--config',
          'vitest.integration.config.ts',
          ...args,
        ],
        { env, inherit: true, signal: abort.signal },
      );
    } else {
      const apiPort = await freePort(),
        webPort = await freePort();
      Object.assign(env, {
        NODE_ENV: 'production',
        E2E_PRODUCTION: '1',
        E2E_API_MANAGED: '1',
        E2E_BASE_URL: `http://127.0.0.1:${webPort}`,
        E2E_CLUSTER_WEBSOCKETS: '',
        HOST: '127.0.0.1',
        HOSTNAME: '127.0.0.1',
        PORT: String(webPort),
        ALLOWED_ORIGINS: `http://127.0.0.1:${webPort}`,
        NEXT_PUBLIC_API_URL: `http://127.0.0.1:${apiPort}`,
        NEXT_PUBLIC_COLLABORATION_URL: `ws://127.0.0.1:${apiPort}/collaboration`,
        METRICS_TOKEN: randomBytes(32).toString('hex'),
      });
      await run('npm', ['run', 'build'], { env, inherit: true, signal: abort.signal });
      api = spawn(process.execPath, ['apps/server/dist/index.js'], {
        cwd: root,
        env: { ...env, PORT: String(apiPort) },
        signal: abort.signal,
        stdio: ['ignore', 'inherit', 'inherit'],
      });
      api.on('error', () => {});
      apiExited = new Promise((resolve) => api.once('close', resolve));
      const deadline = Date.now() + 25000;
      for (;;) {
        if (api.exitCode !== null || api.signalCode !== null || abort.signal.aborted)
          throw new OperationError('test_api_startup_failed');
        try {
          const response = await fetch(`http://127.0.0.1:${apiPort}/metrics`, {
            headers: { Authorization: 'Bearer ' + env.METRICS_TOKEN },
            signal: AbortSignal.timeout(1000),
          });
          // A random operator secret proves this is our API before browsers
          // create data. A port collision cannot select an ordinary dev API.
          if (response.ok && (await response.text()).includes('commonplace_ready 1')) break;
        } catch {
          /* Wait only for this owned production process. */
        }
        if (Date.now() >= deadline) throw new OperationError('test_api_readiness_deadline');
        await delay(100);
      }
      await run(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', ...args], {
        env,
        inherit: true,
        signal: abort.signal,
      });
    }
  }
} catch (error) {
  event('test_run_failed', {
    reason: error instanceof OperationError ? error.reason : 'test_setup_failed',
  });
  process.exitCode = 1;
} finally {
  if (api && api.exitCode === null && api.signalCode === null) {
    api.kill('SIGTERM');
    const timer = setTimeout(() => api.kill('SIGKILL'), 16000);
    const code = await apiExited;
    clearTimeout(timer);
    if (code !== 0) {
      event('test_api_shutdown_failed');
      process.exitCode = 1;
    }
  } else if (api && api.exitCode !== 0) {
    event('test_api_exited_unexpectedly');
    process.exitCode = 1;
  }
  if (owned) {
    try {
      await owned.run(['down', '--timeout', '20']);
      event('test_services_removed', { project: owned.project });
    } catch {
      event('test_cleanup_failed', { project: owned.project });
      process.exitCode = 1;
    }
  }
}
