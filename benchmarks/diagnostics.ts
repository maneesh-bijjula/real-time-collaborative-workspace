import { PerformanceObserver } from 'node:perf_hooks';

// One bounded scenario at a time. Timestamps share performance.now() with the
// source scheduler; no wall-clock or host/container clock subtraction.
let current: Diagnostics | undefined;
export function trace(event: Record<string, unknown>) {
  current?.record(event);
}
export class Diagnostics {
  readonly events: Record<string, unknown>[] = [];
  private dropped = 0;
  private readonly observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries())
      this.record({ type: 'gc', atMs: entry.startTime, durationMs: entry.duration });
  });
  start() {
    current = this;
    this.observer.observe({ entryTypes: ['gc'] });
  }
  record(event: Record<string, unknown>) {
    if (this.events.length < 4096) this.events.push(event);
    else this.dropped++;
  }
  stop() {
    this.observer.disconnect();
    if (current === this) current = undefined;
    return { events: this.events, dropped: this.dropped };
  }
}
