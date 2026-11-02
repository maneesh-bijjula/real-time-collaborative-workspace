import { parentPort, workerData } from 'node:worker_threads';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import * as Y from 'yjs';
import { Group, type BenchmarkDocument } from './clients.js';
import { Diagnostics } from './diagnostics.js';
import { sleep } from './runtime.js';
import { mutate, type LoadProfile } from './workloads.js';
import type { Operation } from './load.js';

const { endpoints, indices, documents, profile } = workerData as {
  endpoints: string[];
  indices: number[];
  documents: BenchmarkDocument[];
  profile: LoadProfile;
};
const group = new Group(endpoints);
const warmRounds = profile.warmupSeconds * profile.rate;
const measuredRounds = profile.measureSeconds * profile.rate;
const count = measuredRounds * profile.writers;
const arrivals = new Float64Array(count * profile.writers).fill(NaN);
const operations: Operation[] = [];
const diagnostics = new Diagnostics();
const lag = monitorEventLoopDelay({ resolution: 10 });
let observed = 0,
  stopped = false;
let progress: ReturnType<typeof setInterval> | undefined;

async function execute(command: string, value: any) {
  if (command === 'prepare') {
    await group.connect(indices, documents);
    for (const client of group.clients) {
      const seen = new Int32Array(profile.writers);
      client.doc.getMap<number>('benchmark-sequences').observe((event) => {
        const arrived = performance.now();
        for (const key of event.keysChanged) {
          const writer = Number(key),
            sequence = event.target.get(key)!;
          for (let seq = Math.max(seen[writer]! + 1, warmRounds + 1); seq <= sequence; seq++) {
            if (client.index === writer || seq > warmRounds + measuredRounds) continue;
            const index = (seq - warmRounds - 1) * profile.writers + writer;
            const slot = index * profile.writers + client.index;
            if (!Number.isFinite(arrivals[slot]!)) {
              arrivals[slot] = arrived;
              observed++;
            }
          }
          seen[writer] = sequence;
        }
      });
    }
    return { timeOrigin: performance.timeOrigin, indices };
  }
  if (command === 'start') {
    const began = value.began as number;
    diagnostics.start();
    lag.enable();
    let ticks = 0;
    progress = setInterval(() => {
      parentPort!.postMessage({ type: 'progress', observed });
      if (++ticks % 10 === 0)
        diagnostics.record({
          type: 'replica_heap',
          atMs: performance.now(),
          memory: process.memoryUsage(),
        });
    }, 100);
    const total = (warmRounds + measuredRounds) * profile.writers;
    const warmCount = warmRounds * profile.writers;
    const period = 1000 / profile.rate;
    for (let i = 0; i < total; i++) {
      const writer = i % profile.writers;
      const client = group.clients.find((c) => c.index === writer);
      if (!client) continue;
      const scheduledMs =
        Math.floor(i / profile.writers) * period + (writer * period) / profile.writers;
      await sleep(began + scheduledMs - performance.now());
      if (stopped) break;
      if (performance.now() - began - scheduledMs >= 500) {
        parentPort!.postMessage({
          type: 'interruption',
          atMs: performance.now(),
          scheduledAtMs: began + scheduledMs,
          operation: i,
        });
        break;
      }
      client.sequence++;
      const operation: Operation = {
        index: i - warmCount,
        writer,
        node: client.node,
        document: client.document,
        sequence: client.sequence,
        kind:
          client.sequence % 5 === 0 ? 'delete' : client.sequence % 5 === 4 ? 'format' : 'insert',
        scheduledMs,
        startedMs: performance.now() - began,
        updateBytes: 0,
      };
      const update = (bytes: Uint8Array, origin: unknown) => {
        if (origin === 'benchmark-local') operation.updateBytes += bytes.length;
      };
      client.doc.on('update', update);
      mutate(client.doc, writer, client.sequence, group.documents[client.document]!.actors);
      client.doc.off('update', update);
      if (i >= warmCount) operations.push(operation);
      if (client.sequence % 4 === 0) group.pulse(client);
    }
    return {
      operations,
      endedAtMs: performance.now(),
      sequences: group.clients.map((c) => ({ writer: c.index, sequence: c.sequence })),
    };
  }
  if (command === 'validate') {
    clearInterval(progress);
    const trafficEventLoopMaxMs = lag.max / 1e6;
    for (const document of group.documents)
      for (const writer of document.actors)
        for (let seq = 1; seq <= value.sequences[writer]; seq++)
          mutate(document.reference, writer, seq, document.actors);
    let correct = true;
    try {
      await group.converge(true);
    } catch {
      correct = false;
    }
    const snapshots = group.documents.map((_, i) =>
      Y.encodeSnapshot(Y.snapshot(group.clients.find((c) => c.document === i)!.doc)),
    );
    return {
      correct,
      trafficEventLoopMaxMs,
      snapshots,
      finalBytes: group.documents.map(
        (_, i) => Y.encodeStateAsUpdate(group.clients.find((c) => c.document === i)!.doc).length,
      ),
      digest: createHash('sha256').update(snapshots[0]!).digest('hex'),
      connectionLoss: group.clients.some((c) => c.closes || c.failures || c.session.blocked),
    };
  }
  if (command === 'durable') {
    await group.durable();
    return true;
  }
  if (command === 'collect') {
    lag.disable();
    const telemetry = {
      indices,
      memory: process.memoryUsage(),
      eventLoopP99Ms: lag.percentile(99) / 1e6,
      eventLoopMaxMs: lag.max / 1e6,
      diagnostics: diagnostics.stop(),
    };
    parentPort!.postMessage({ id: value.id, result: { arrivals, telemetry } }, [arrivals.buffer]);
    return undefined;
  }
  if (command === 'close') {
    clearInterval(progress);
    group.close();
    return true;
  }
  throw new Error('Unknown worker command');
}
parentPort!.on('message', (message) => {
  if (message.command === 'stop') {
    stopped = true;
    return;
  }
  void execute(message.command, { ...message.value, id: message.id }).then(
    (result) => {
      if (result !== undefined) parentPort!.postMessage({ id: message.id, result });
    },
    () => parentPort!.postMessage({ id: message.id, failed: true }),
  );
});
