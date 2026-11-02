import { Worker } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import * as Y from 'yjs';
import { Group } from './clients.js';
import { Collector } from './collector.js';
import { trace } from './diagnostics.js';
import { Deployment, gzipLines, until } from './runtime.js';
import { reportLoad, type Operation } from './load.js';
import { nodeFor, type LoadProfile } from './workloads.js';

class ReplicaWorker {
  private id = 0;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  readonly worker: Worker;
  observed = 0;
  constructor(data: unknown, onInterruption: (event: any) => void) {
    this.worker = new Worker(new URL('./load-worker.js', import.meta.url), { workerData: data });
    const fail = () => {
      for (const item of this.pending.values()) {
        clearTimeout(item.timer);
        item.reject(new Error('Replica worker failed'));
      }
      this.pending.clear();
    };
    this.worker.on('error', fail);
    this.worker.on('exit', fail);
    this.worker.on('message', (message) => {
      if (message.type === 'progress') {
        this.observed = message.observed;
        return;
      }
      if (message.type === 'interruption') {
        onInterruption(message);
        return;
      }
      const item = this.pending.get(message.id);
      if (!item) return;
      clearTimeout(item.timer);
      this.pending.delete(message.id);
      if (message.failed) item.reject(new Error('Replica command failed'));
      else item.resolve(message.result);
    });
  }
  request(command: string, value: unknown = {}, timeout = 30000): Promise<any> {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Replica command deadline'));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.worker.postMessage({ id, command, value });
    });
  }
  stop() {
    this.worker.postMessage({ command: 'stop' });
  }
}

/** Four isolates retain all 50 real replicas while bounding per-isolate GC work.
 * Source and recipient timestamps are taken in their owning isolates, before
 * IPC. A verified common performance.timeOrigin permits subtraction directly.
 */
export async function workerLoad(
  deployment: Deployment,
  profile: LoadProfile,
  repeat: number,
  output: string,
  controllerPauseMs = 0,
) {
  const group = new Group(deployment.endpoints);
  const collector = new Collector(deployment);
  const workers: ReplicaWorker[] = [];
  const errors: string[] = [];
  const count = profile.measureSeconds * profile.rate * profile.writers;
  const expected = count * (profile.writers / profile.documents - 1);
  const latencies = new Float64Array(count * profile.writers).fill(NaN);
  let operations: Operation[] = [],
    initialBytes: number[] = [],
    finalBytes: number[] = [];
  let completed = false,
    finalDigest = '',
    actualWindowMs = 0;
  let durableQuiescenceMs: number | null = null;
  let dependenciesBefore: unknown, dependenciesAfter: unknown;
  const workerTelemetry: unknown[] = [];
  const name = `${profile.id}-${repeat}`;
  let pauseTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await group.prepare(profile.writers, profile.documents, profile.seedTextBytes);
    initialBytes = group.documents.map((d) => Y.encodeStateAsUpdate(d.reference).length);
    const documents = group.documents.map(({ id, token, seed, actors }) => ({
      id,
      token,
      seed,
      actors,
    }));
    for (let node = 0; node < 4; node++) {
      const indices = Array.from({ length: profile.writers }, (_, i) => i).filter(
        (i) => nodeFor(i) === node,
      );
      workers.push(
        new ReplicaWorker(
          { endpoints: deployment.endpoints, indices, documents, profile },
          (event) => {
            trace({ ...event, type: 'source_interruption', worker: node });
            if (!errors.includes('offered_load_interrupted'))
              errors.push('offered_load_interrupted');
            workers.forEach((worker) => worker.stop());
          },
        ),
      );
    }
    const ready = await Promise.all(workers.map((w) => w.request('prepare')));
    if (ready.some((r) => r.timeOrigin !== performance.timeOrigin))
      throw new Error('Replica clock origins differ');
    dependenciesBefore = await deployment.dependencies();
    collector.start();
    const began = performance.now() + 250;
    trace({ type: 'traffic_start', atMs: began, workers: ready });
    if (controllerPauseMs)
      pauseTimer = setTimeout(() => {
        trace({ type: 'controller_pause_start', atMs: performance.now() });
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, controllerPauseMs);
        trace({ type: 'controller_pause_end', atMs: performance.now() });
      }, 1250);
    const traffic = await Promise.all(
      workers.map((w) =>
        w.request(
          'start',
          { began },
          (profile.warmupSeconds + profile.measureSeconds) * 1000 + 30000,
        ),
      ),
    );
    operations = traffic.flatMap((r) => r.operations).sort((a, b) => a.index - b.index);
    actualWindowMs = Math.max(
      0,
      Math.max(...traffic.map((r) => r.endedAtMs)) - began - profile.warmupSeconds * 1000,
    );
    trace({ type: 'traffic_end', atMs: performance.now(), operations: operations.length });
    try {
      await until(() => workers.reduce((sum, w) => sum + w.observed, 0) === expected, 10000);
    } catch {
      errors.push('missing_peer_samples');
    }
    const sequences = new Array<number>(profile.writers).fill(0);
    for (const r of traffic)
      for (const entry of r.sequences) sequences[entry.writer] = entry.sequence;
    const validation = await Promise.all(workers.map((w) => w.request('validate', { sequences })));
    completed =
      validation.every((r) => r.correct) &&
      validation.every((r) =>
        r.snapshots.every((s: Uint8Array, i: number) =>
          Y.equalSnapshots(Y.decodeSnapshot(s), Y.decodeSnapshot(validation[0].snapshots[i])),
        ),
      );
    if (!completed) errors.push('state_or_presence_divergence');
    if (validation.some((r) => r.connectionLoss)) errors.push('unexpected_connection_loss');
    finalBytes = validation[0].finalBytes;
    finalDigest = validation[0].digest;
    const quiescent = performance.now();
    try {
      await Promise.all(workers.map((w) => w.request('durable')));
      durableQuiescenceMs = performance.now() - quiescent;
    } catch {
      errors.push('unconfirmed_postgres_state');
    }
    const collected = await Promise.all(workers.map((w) => w.request('collect')));
    for (const [index, result] of collected.entries()) {
      workerTelemetry.push({
        ...result.telemetry,
        trafficEventLoopMaxMs: validation[index].trafficEventLoopMaxMs,
      });
      for (const op of operations)
        for (const recipient of result.telemetry.indices) {
          const slot = op.index * profile.writers + recipient;
          const arrived = result.arrivals[slot];
          if (Number.isFinite(arrived)) latencies[slot] = arrived - began - op.startedMs;
        }
    }
    dependenciesAfter = await deployment.dependencies();
  } catch {
    errors.push('setup_or_execution_failed');
  } finally {
    clearTimeout(pauseTimer);
    const telemetry = await collector.stop();
    const closed = await Promise.allSettled(
      workers.map(async (w) => {
        try {
          await w.request('close', {}, 5000);
        } finally {
          await w.worker.terminate();
        }
      }),
    );
    if (closed.some((result) => result.status === 'rejected'))
      errors.push('replica_cleanup_failed');
    group.close();
    await gzipLines(`${output}/${name}.telemetry.jsonl.gz`, [
      { ...telemetry, workers: workerTelemetry, dependenciesBefore, dependenciesAfter },
    ]);
  }
  return reportLoad(profile, repeat, output, {
    operations,
    latencies,
    initialBytes,
    finalBytes,
    completed,
    durableQuiescenceMs,
    finalDigest,
    actualWindowMs,
    errors,
  });
}
