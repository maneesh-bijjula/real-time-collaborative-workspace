import { performance } from 'node:perf_hooks';
import type { Pool } from 'pg';
import type { DurableDatabase } from './persistence.js';
import type { SynchronizationRedis } from './synchronization.js';
import type { Telemetry } from './telemetry.js';

export class Readiness {
  private probe?: Promise<void>;
  private observations = { postgres: false, publisher: false, subscriber: false };
  private sampledAt = -Infinity;
  private transportSignature = '';
  private postgres = false;
  private publisher = false;
  private subscriber = false;
  private readonly prior = new Map<string, boolean>();
  private timer: ReturnType<typeof setInterval>;
  draining = false;
  constructor(
    private readonly pool: Pool,
    private readonly redis: SynchronizationRedis,
    private readonly persistence: DurableDatabase,
    private readonly telemetry: Telemetry,
    private readonly maxDirtyAge: number,
  ) {
    this.timer = setInterval(() => {
      void this.check();
    }, 2000).unref();
  }
  async check(): Promise<boolean> {
    if (this.draining) return this.sample();
    const deadline = performance.now() + 2000;
    for (;;) {
      const signature = `${this.redis.pub.status}:${this.redis.sub.status}`;
      if (
        !this.probe &&
        (performance.now() - this.sampledAt > 250 || signature !== this.transportSignature)
      ) {
        this.transportSignature = signature;
        const probeConfig = { text: 'SELECT 1', query_timeout: 1500 };
        const observation = { postgres: false, publisher: false, subscriber: false };
        this.observations = observation;
        const query = this.pool.query(probeConfig).then(
          () => {
            observation.postgres = true;
          },
          () => {},
        );
        const ping = (client: typeof this.redis.pub, field: 'publisher' | 'subscriber') =>
          client.status === 'ready'
            ? client.ping().then(
                () => {
                  observation[field] = true;
                },
                () => {},
              )
            : Promise.resolve();
        this.probe = Promise.all([
          query,
          ping(this.redis.pub, 'publisher'),
          ping(this.redis.sub, 'subscriber'),
        ])
          .then(() => {})
          .finally(() => {
            this.probe = undefined;
          });
      }
      const waiting = this.probe;
      const observedSignature = this.transportSignature;
      if (waiting) {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          waiting,
          new Promise<void>((resolve) => {
            timeout = setTimeout(
              () => resolve(),
              Math.max(0, deadline - performance.now()),
            ).unref();
          }),
        ]);
        clearTimeout(timeout);
        this.sampledAt = performance.now();
        this.postgres = this.observations.postgres;
        this.publisher = this.observations.publisher;
        this.subscriber = this.observations.subscriber;
      }
      const changed = observedSignature !== `${this.redis.pub.status}:${this.redis.sub.status}`;
      if (!changed || performance.now() >= deadline || (waiting && this.probe === waiting)) break;
      // The completed pass may have skipped PING while this transport was
      // reconnecting. Observe the new connection within the same deadline.
      this.sampledAt = -Infinity;
    }

    return this.sample();
  }
  sample(): boolean {
    const dependencies: Record<string, boolean> = {
      postgres: this.postgres,
      redis_publisher: this.redis.pub.status === 'ready' && this.publisher,
      redis_subscriber: this.redis.sub.status === 'ready' && this.subscriber,
      reconciliation: this.redis.healthy,
    };
    for (const [dependency, up] of Object.entries(dependencies)) {
      this.telemetry.gauge('dependency_up', up ? 1 : 0, { dependency });
      if (this.prior.get(dependency) !== up) {
        this.telemetry.log(up ? 'dependency_recovered' : 'dependency_failed', dependency);
        this.prior.set(dependency, up);
      }
    }
    this.persistence.sampleMetrics();
    const ready =
      !this.draining &&
      Object.values(dependencies).every(Boolean) &&
      this.persistence.failureCount === 0 &&
      this.persistence.oldestDirtySeconds <= this.maxDirtyAge;
    this.telemetry.gauge('ready', ready ? 1 : 0);
    return ready;
  }
  close() {
    this.draining = true;
    clearInterval(this.timer);
    this.sample();
  }
}
