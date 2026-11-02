import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { it, expect } from 'vitest';
import { createApplication } from '../../apps/server/src/app.js';
import { readConfig } from '../../apps/server/src/config.js';

it('rejects an occupied HTTP port cleanly and closes its own resources without closing the other listener', async () => {
  const occupied = createServer();
  await new Promise<void>((resolve) => occupied.listen(0, '127.0.0.1', resolve));
  const address = occupied.address();
  if (!address || typeof address === 'string') throw new Error('Missing test listener');
  const app = await createApplication(
    {
      ...readConfig(),
      host: '127.0.0.1',
      port: address.port,
      databaseUrl: process.env.TEST_DATABASE_URL!,
      redisUrl: process.env.TEST_REDIS_URL!,
      redisPrefix: 'startup:' + randomUUID(),
    },
    { log: () => {} },
  );
  try {
    await expect(app.listen()).rejects.toThrow('Collaboration listener failed');
    await app.close();
    expect(app.pool.ended).toBe(true);
    expect(occupied.listening).toBe(true);
  } finally {
    await app.close().catch(() => {});
    await new Promise<void>((resolve) => occupied.close(() => resolve()));
  }
});
