import { expect, it } from 'vitest';
import { Telemetry, type LogEntry } from '../../apps/server/src/telemetry.js';
it('bounds reason cardinality and drops free-form text before logs or labels', async () => {
  const entries: LogEntry[] = [];
  const telemetry = new Telemetry((entry) => entries.push(entry));
  try {
    for (let i = 0; i < 100; i++) telemetry.reject('secret-untrusted-reason-' + i);
    telemetry.log('request_failed', 'postgres-password-sentinel');
    const output = JSON.stringify(entries) + (await telemetry.metrics());
    expect(output).not.toContain('secret-untrusted-reason');
    expect(output).not.toContain('postgres-password-sentinel');
    expect(output).toContain('reason="other"');
    expect(entries.length).toBe(2);
  } finally {
    telemetry.close();
  }
});
