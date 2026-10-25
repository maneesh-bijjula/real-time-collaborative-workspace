import { expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { Readiness } from '../../apps/server/src/readiness.js';
import { Telemetry } from '../../apps/server/src/telemetry.js';
import type { SynchronizationRedis } from '../../apps/server/src/synchronization.js';
import type { DurableDatabase } from '../../apps/server/src/persistence.js';

it('refreshes a probe that began during reconnect before reporting the new transport healthy', async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pool = {
    query: vi
      .fn()
      .mockImplementationOnce(() => pending)
      .mockResolvedValue({}),
  };
  const redis = {
    healthy: true,
    pub: { status: 'ready', ping: vi.fn().mockResolvedValue('PONG') },
    sub: { status: 'connect', ping: vi.fn().mockResolvedValue('PONG') },
  };
  const persistence = { failureCount: 0, oldestDirtySeconds: 0, sampleMetrics: vi.fn() };
  const telemetry = new Telemetry(() => {});
  const readiness = new Readiness(
    pool as unknown as Pool,
    redis as unknown as SynchronizationRedis,
    persistence as unknown as DurableDatabase,
    telemetry,
    30,
  );
  try {
    const checking = readiness.check();
    redis.sub.status = 'ready';
    release();
    expect(await checking).toBe(true);
    expect(redis.sub.ping).toHaveBeenCalledOnce();
    expect(await telemetry.metrics()).toContain(
      'commonplace_dependency_up{dependency="redis_subscriber"} 1',
    );
  } finally {
    readiness.close();
    telemetry.close();
  }
});
