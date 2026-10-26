import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { Deployment, sleep } from './runtime.js';

export class Collector {
  private stopped = false;
  private readonly started = performance.now();
  private readonly lag = monitorEventLoopDelay({ resolution: 10 });
  private readonly cpu = process.cpuUsage();
  private tasks: Promise<void>[] = [];
  readonly samples: unknown[] = [];
  constructor(private readonly deployment: Deployment) {}
  start() {
    this.lag.enable();
    const loop = async (type: 'metrics' | 'resources', period: number) => {
      while (!this.stopped) {
        const at = performance.now() - this.started;
        try {
          this.samples.push({ atMs: at, type, values: await this.deployment[type]() });
        } catch {
          this.samples.push({ atMs: at, type, unavailable: true });
        }
        const end = performance.now() + period;
        while (!this.stopped && performance.now() < end) await sleep(100);
      }
    };
    this.tasks = [loop('metrics', 1000), loop('resources', 5000)];
  }
  async stop() {
    this.stopped = true;
    await Promise.all(this.tasks);
    this.lag.disable();
    return {
      samples: this.samples,
      controller: {
        cpuMicroseconds: process.cpuUsage(this.cpu),
        elapsedMs: performance.now() - this.started,
        rssBytes: process.memoryUsage().rss,
        eventLoopP99Ms: this.lag.percentile(99) / 1e6,
        eventLoopMaxMs: this.lag.max / 1e6,
      },
    };
  }
}
