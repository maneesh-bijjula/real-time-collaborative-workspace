import { BlockList, isIP } from 'node:net';
import type { IncomingMessage } from 'node:http';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';

const positive = (value: number, maximum = 1_000_000_000) =>
  z.number().int().min(1).max(maximum).default(value);
export const policySchema = z
  .object({
    maxSockets: positive(512, 10000),
    maxSocketsPerIp: positive(128, 10000),
    maxDocuments: positive(128, 10000),
    maxDocumentClients: positive(128, 1000),
    maxAuthenticating: positive(32, 1000),
    authenticationTimeoutMs: positive(5000, 30000),
    processingTimeoutMs: positive(15000, 60000),
    maxFrameBytes: positive(256 * 1024, 1024 * 1024),
    maxQueueBytes: positive(512 * 1024, 4 * 1024 * 1024),
    maxTotalQueueBytes: positive(16 * 1024 * 1024, 128 * 1024 * 1024),
    maxQueueMessages: positive(64, 256),
    maxTotalQueueMessages: positive(4096, 32768),
    maxOutboundBytes: positive(8 * 1024 * 1024, 16 * 1024 * 1024),
    maxDocumentBytes: positive(4 * 1024 * 1024, 16 * 1024 * 1024),
    maxUpdateStructs: positive(8192, 65536),
    messagesPerSecond: positive(100, 1000),
    messageBurst: positive(200, 2000),
    bytesPerSecond: positive(512 * 1024, 4 * 1024 * 1024),
    byteBurst: positive(1024 * 1024, 8 * 1024 * 1024),
    statelessPerSecond: positive(5, 100),
    statelessBurst: positive(10, 200),
    upgradesPerMinute: positive(120, 10000),
    authenticationPerMinute: positive(120, 10000),
    apiPerMinute: positive(300, 10000),
    createsPerMinute: positive(30, 1000),
    maxLimiterKeys: positive(10000, 100000),
    maxDirtyAgeSeconds: positive(30, 300),
  })
  .strict();
export type ResourcePolicy = z.infer<typeof policySchema>;
export type PolicyOverrides = Partial<ResourcePolicy>;

export class TokenBucket {
  private tokens: number;
  private updated: number;
  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly now = () => performance.now(),
  ) {
    this.tokens = capacity;
    this.updated = now();
  }
  take(cost = 1): boolean {
    const now = this.now();
    this.tokens = Math.min(
      this.capacity,
      this.tokens + (Math.max(0, now - this.updated) * this.refillPerSecond) / 1000,
    );
    this.updated = now;
    if (cost > this.tokens) return false;
    this.tokens -= cost;
    return true;
  }
}

/** Bounded, per-instance limits. New identities fail closed if the table fills. */
export class AdmissionLimits {
  private readonly buckets = new Map<string, { bucket: TokenBucket; expires: number }>();
  constructor(
    private readonly maximum: number,
    private readonly now = () => performance.now(),
  ) {}
  take(group: string, key: string, limitPerMinute: number): boolean {
    const now = this.now();
    if (this.buckets.size >= this.maximum) this.sweep(now);
    const name = `${group}:${key}`;
    let item = this.buckets.get(name);
    if (!item || item.expires <= now) {
      if (!item && this.buckets.size >= this.maximum) return false;
      item = {
        bucket: new TokenBucket(limitPerMinute, limitPerMinute / 60, this.now),
        expires: now + 120000,
      };
      this.buckets.set(name, item);
    }
    item.expires = now + 120000;
    return item.bucket.take();
  }
  sweep(now = this.now()) {
    for (const [key, value] of this.buckets) if (value.expires <= now) this.buckets.delete(key);
  }
  get size() {
    return this.buckets.size;
  }
}

function normalizedIp(value: string): string {
  return value.startsWith('::ffff:') && isIP(value.slice(7)) === 4 ? value.slice(7) : value;
}
export function trustedProxyList(values: string[]): BlockList {
  const list = new BlockList();
  for (const value of values) {
    const [raw, bits, extra] = value.split('/');
    if (!raw || extra !== undefined || !isIP(raw)) throw new Error('Invalid trusted proxy CIDR');
    const family = isIP(raw) === 4 ? 'ipv4' : 'ipv6';
    if (bits === undefined) list.addAddress(raw, family);
    else {
      const prefix = Number(bits);
      if (!/^\d+$/.test(bits) || prefix < 1 || prefix > (family === 'ipv4' ? 32 : 128))
        throw new Error('Trusted proxies require a nonzero CIDR prefix');
      list.addSubnet(raw, prefix, family);
    }
  }
  return list;
}
export function clientIp(request: IncomingMessage, trusted: BlockList): string {
  const remote = normalizedIp(request.socket.remoteAddress || '');
  if (!isIP(remote)) throw new Error('Unknown peer');
  const forwarded = request.headers['x-forwarded-for'];
  if (forwarded && trusted.check(remote, isIP(remote) === 4 ? 'ipv4' : 'ipv6')) {
    // The trusted, single-hop edge must OVERWRITE incoming forwarding headers.
    if (Array.isArray(forwarded) || !isIP(forwarded.trim()))
      throw new Error('Invalid forwarded peer');
    return normalizedIp(forwarded.trim());
  }
  return remote;
}
/** Aggregate IPv6 privacy addresses in one /64 to bound identity churn. */
export function ipLimitKey(ip: string): string {
  if (isIP(ip) === 4) return ip;
  // URL canonicalization expands neither zeros nor prefixes, so use BlockList's
  // family-independent numeric conversion through eight IPv6 words.
  const [left = '', right = ''] = ip.split('::');
  const a = left ? left.split(':') : [],
    b = right ? right.split(':') : [];
  const words = ip.includes('::') ? [...a, ...Array(8 - a.length - b.length).fill('0'), ...b] : a;
  return (
    words
      .slice(0, 4)
      .map((word) => parseInt(word, 16).toString(16))
      .join(':') + '::/64'
  );
}
