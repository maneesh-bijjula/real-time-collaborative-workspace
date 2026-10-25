import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { Counter, Gauge, Histogram, Registry } from '@prometheus-io/client';

export type Event =
  | 'server_started'
  | 'server_stopping'
  | 'server_stopped'
  | 'startup_failed'
  | 'shutdown_failed'
  | 'request_failed'
  | 'authentication_denied'
  | 'socket_opened'
  | 'socket_closed'
  | 'policy_rejected'
  | 'persistence_failed'
  | 'persistence_recovered'
  | 'synchronization_failed'
  | 'synchronization_recovered'
  | 'dependency_failed'
  | 'dependency_recovered'
  | 'session_reconnected';
export type LogEntry = { time: string; level: 'info' | 'warn'; event: Event; reason?: string };
export type LogSink = (entry: LogEntry) => void;
export const jsonLog: LogSink = (entry) => console.log(JSON.stringify(entry));

const safeReasons = new Set([
  'draining',
  'upgrade_path',
  'origin',
  'forwarded_peer',
  'upgrade_rate',
  'socket_capacity',
  'upgrade_handshake',
  'websocket_server',
  'backpressure',
  'socket_write',
  'socket_protocol',
  'authentication_timeout',
  'binary_required',
  'frame_size',
  'message_rate',
  'queue_capacity',
  'cross_document',
  'stateless_rate',
  'credential_refresh',
  'authentication_required',
  'session_closed',
  'processing_timeout',
  'authentication_capacity',
  'document_capacity',
  'authentication_denied',
  'document_address',
  'protocol',
  'update_structures',
  'credential_size',
  'stateless',
  'malformed',
  'awareness_size',
  'awareness',
  'document_size',
  'malformed_update',
  'api_rate',
  'http_capacity',
  'postgres',
  'redis_publisher',
  'redis_subscriber',
  'reconciliation',
  'http_document',
  'dependency_unavailable',
]);
const reasonCategory = (reason: string) => (safeReasons.has(reason) ? reason : 'other');

/** Per-application registry; label values are fixed categories, never user input. */
export class Telemetry {
  readonly registry = new Registry();
  private readonly lag = monitorEventLoopDelay({ resolution: 20 });
  private readonly logWindows = new Map<string, number>();
  private readonly counters = new Map<string, Counter<string>>();
  private readonly gauges = new Map<string, Gauge<string>>();
  private readonly histograms = new Map<string, Histogram<string>>();
  constructor(private readonly sink: LogSink = jsonLog) {
    for (const [name, help, labels] of [
      ['rejections_total', 'Policy rejections by bounded reason', ['reason']],
      ['authentication_total', 'Authentication results', ['result']],
      ['socket_connections_total', 'Accepted physical WebSockets', []],
      ['socket_disconnects_total', 'Closed physical WebSockets', ['kind']],
      ['sessions_total', 'Established authenticated document sessions', []],
      ['reconnects_total', 'Client-reported in-page authenticated session rejoins', []],
      ['persistence_attempts_total', 'Snapshot storage attempts', ['result']],
      ['reconciliation_total', 'Reconciliation passes', ['result']],
      [
        'http_requests_total',
        'HTTP responses by fixed route and status class',
        ['route', 'result'],
      ],
    ] as const)
      this.counters.set(
        name,
        new Counter({
          name: 'commonplace_' + name,
          help,
          labelNames: [...labels],
          registers: [this.registry],
        }),
      );
    for (const [name, help, labels] of [
      ['sockets', 'Open physical WebSockets including authentication', []],
      ['sessions', 'Active authenticated sessions', []],
      ['documents', 'Loaded and loading documents', []],
      ['authenticating', 'Authentication queries currently in flight', []],
      ['queued_bytes', 'Inbound bytes queued or being processed', []],
      ['dirty_documents', 'Documents with uncommitted revisions', []],
      ['persistence_failures', 'Documents whose last storage attempt failed', []],
      ['oldest_dirty_seconds', 'Age of oldest uncommitted revision', []],
      ['dependency_up', 'Last probe or transport state, 1 healthy / 0 unhealthy', ['dependency']],
      ['ready', 'Whether dependencies, persistence and admission are ready', []],
      ['last_reconciliation_timestamp_seconds', 'Last completed successful reconciliation', []],
      ['resident_memory_bytes', 'Process resident memory', []],
      ['event_loop_delay_p99_seconds', 'Event-loop delay p99 since previous scrape', []],
    ] as const)
      this.gauges.set(
        name,
        new Gauge({
          name: 'commonplace_' + name,
          help,
          labelNames: [...labels],
          registers: [this.registry],
        }),
      );
    for (const [name, help] of [
      ['snapshot_write_seconds', 'Duration of a PostgreSQL snapshot write attempt'],
      [
        'durable_save_seconds',
        'Time from oldest dirty revision until all covered revisions commit',
      ],
      ['reconciliation_seconds', 'Duration of a reconciliation pass'],
    ])
      this.histograms.set(
        name!,
        new Histogram({
          name: 'commonplace_' + name,
          help: help!,
          buckets: [0.005, 0.02, 0.1, 0.5, 1, 2, 5, 15, 60],
          registers: [this.registry],
        }),
      );
    this.lag.enable();
  }
  count(name: string, labels: Record<string, string> = {}) {
    this.counters.get(name)!.inc(labels);
  }
  gauge(name: string, value: number, labels: Record<string, string> = {}) {
    this.gauges.get(name)!.set(labels, value);
  }
  observe(name: string, seconds: number) {
    this.histograms.get(name)!.observe(seconds);
  }
  log(event: Event, reason?: string) {
    // Bound repetitive abuse/outage logs to one event/reason per second. No
    // request data, exceptions, URLs, IDs, tokens, or contents enter the sink.
    if (reason) reason = reasonCategory(reason);
    const key = event + ':' + (reason || '');
    const now = performance.now();
    if (now - (this.logWindows.get(key) ?? -Infinity) < 1000) return;
    this.logWindows.set(key, now);
    this.sink({
      time: new Date().toISOString(),
      level: /failed|denied|rejected/.test(event) ? 'warn' : 'info',
      event,
      ...(reason ? { reason } : {}),
    });
  }
  reject(reason: string) {
    reason = reasonCategory(reason);
    this.count('rejections_total', { reason });
    this.log('policy_rejected', reason);
  }
  async metrics(): Promise<string> {
    this.gauge('resident_memory_bytes', process.memoryUsage().rss);
    this.gauge('event_loop_delay_p99_seconds', this.lag.percentile(99) / 1e9);
    this.lag.reset();
    return this.registry.metrics();
  }
  close() {
    this.lag.disable();
    this.registry.clear();
  }
}
