import { describe, expect, it } from 'vitest';
import { readConfig } from '../../apps/server/src/config.js';

describe('deployment synchronization configuration', () => {
  it('uses a backward-compatible namespace and bounded repair interval', () => {
    expect(readConfig({})).toMatchObject({
      redisPrefix: 'commonplace',
      redisReconcileIntervalMs: 2000,
    });
  });
  it('reads an explicit namespace and interval from the environment', () => {
    expect(
      readConfig({ REDIS_PREFIX: 'commonplace:staging-2', REDIS_RECONCILE_INTERVAL_MS: '500' }),
    ).toMatchObject({ redisPrefix: 'commonplace:staging-2', redisReconcileIntervalMs: 500 });
  });
  it.each(['', 'invalid#reply', 'spaces here', 'x'.repeat(129)])(
    'rejects unsafe namespace %j',
    (value) => {
      expect(() => readConfig({ REDIS_PREFIX: value })).toThrow();
    },
  );
  it.each(['0', '249', '60001', 'NaN', '1.5'])('rejects invalid repair interval %s', (value) => {
    expect(() => readConfig({ REDIS_RECONCILE_INTERVAL_MS: value })).toThrow();
  });
});
