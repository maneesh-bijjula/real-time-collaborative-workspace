import { describe, expect, it } from 'vitest';
import type { IncomingMessage } from 'node:http';
import {
  AdmissionLimits,
  TokenBucket,
  clientIp,
  ipLimitKey,
  trustedProxyList,
} from '../../apps/server/src/policy.js';
import { readConfig } from '../../apps/server/src/config.js';

describe('bounded admission and proxy identity', () => {
  it('refills against monotonic elapsed time and charges byte costs', () => {
    let now = 1000;
    const bucket = new TokenBucket(4, 2, () => now);
    expect(bucket.take(4)).toBe(true);
    expect(bucket.take()).toBe(false);
    now += 500;
    expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(false);
    now -= 100;
    expect(bucket.take()).toBe(false);
  });
  it('fails closed for new identities when full and expires idle entries', () => {
    let now = 0;
    const limiter = new AdmissionLimits(2, () => now);
    expect(limiter.take('api', 'a', 1)).toBe(true);
    expect(limiter.take('api', 'a', 1)).toBe(false);
    expect(limiter.take('api', 'b', 1)).toBe(true);
    expect(limiter.take('api', 'c', 1)).toBe(false);
    expect(limiter.size).toBe(2);
    now += 120001;
    expect(limiter.take('api', 'c', 1)).toBe(true);
    expect(limiter.size).toBe(1);
  });
  const request = (remote: string, forwarded: string) =>
    ({
      socket: { remoteAddress: remote },
      headers: { 'x-forwarded-for': forwarded },
    }) as unknown as IncomingMessage;
  it('ignores spoofed forwarding headers from untrusted peers', () => {
    expect(clientIp(request('::ffff:127.0.0.1', '203.0.113.1'), trustedProxyList([]))).toBe(
      '127.0.0.1',
    );
  });
  it('accepts only an overwritten single-hop IP from explicitly trusted CIDRs', () => {
    const list = trustedProxyList(['127.0.0.0/8']);
    expect(clientIp(request('127.0.0.1', '203.0.113.1'), list)).toBe('203.0.113.1');
    expect(() => clientIp(request('127.0.0.1', '203.0.113.1, 127.0.0.1'), list)).toThrow();
    expect(() => trustedProxyList(['0.0.0.0/0'])).toThrow();
  });
  it('groups equivalent IPv6 /64 identities', () => {
    expect(ipLimitKey('2001:db8:0:1::1')).toBe(ipLimitKey('2001:0db8:0000:0001:ffff::2'));
    expect(ipLimitKey('2001:db8:0:2::1')).not.toBe(ipLimitKey('2001:db8:0:1::1'));
  });
  it.each([
    { METRICS_TOKEN: 'short' },
    { ALLOWED_ORIGINS: 'https://example.com/path' },
    { ALLOWED_ORIGINS: 'https://secret@example.com' },
    { TRUSTED_PROXY_CIDRS: 'bad' },
    { DATABASE_URL: 'https://example.com' },
    { REDIS_URL: 'https://example.com' },
  ])('rejects unsafe deployment configuration %j', (env) => {
    expect(() => readConfig(env)).toThrow();
  });
});
