import { performance } from 'node:perf_hooks';
import * as Y from 'yjs';
import { Group } from './clients.js';
import { Collector } from './collector.js';
import { Deployment, gzipLines, json, sleep, until } from './runtime.js';
import { mutate, nodeFor, type LoadProfile, type Mutation } from './workloads.js';
import { distribution, latencyAcceptance } from './stats.js';

export type Operation = {
  index: number;
  writer: number;
  node: number;
  document: number;
  sequence: number;
  kind: Mutation;
  scheduledMs: number;
  startedMs: number;
  updateBytes: number;
};
export async function load(
  deployment: Deployment,
  profile: LoadProfile,
  repeat: number,
  output: string,
) {
  const name = `${profile.id}-${repeat}`;
  const group = new Group(deployment.endpoints);
  const collector = new Collector(deployment);
  const operations: Operation[] = [];
  const measuredRounds = profile.measureSeconds * profile.rate;
  const warmRounds = profile.warmupSeconds * profile.rate;
  const count = measuredRounds * profile.writers;
  const latencies = new Float64Array(count * profile.writers).fill(NaN);
  const seen = new Int32Array(profile.writers * profile.writers);
  const byWriter = Array.from({ length: profile.writers }, () => new Map<number, Operation>());
  let observed = 0;
  let active: Operation | undefined;
  let began = 0;
  const expected = count * (profile.writers / profile.documents - 1);
  let completed = false;
  const errors: string[] = [];
  let initialBytes: number[] = [],
    finalBytes: number[] = [];
  let dependenciesBefore: unknown, dependenciesAfter: unknown;
  let durableQuiescenceMs: number | null = null;
  let finalDigest = '';
  let actualWindowMs = 0;
  try {
    await group.create(profile.writers, profile.documents, profile.seedTextBytes);
    initialBytes = group.documents.map((d) => Y.encodeStateAsUpdate(d.reference).length);
    dependenciesBefore = await deployment.dependencies();
    for (const client of group.clients) {
      client.doc.getMap<number>('benchmark-sequences').observe((event) => {
        const arrived = performance.now();
        for (const key of event.keysChanged) {
          const writer = Number(key);
          const sequence = event.target.get(key)!;
          const offset = client.index * profile.writers + writer;
          for (let seq = seen[offset]! + 1; seq <= sequence; seq++) {
            const op = byWriter[writer]?.get(seq);
            if (op && client.index !== writer) {
              const slot = op.index * profile.writers + client.index;
              if (!Number.isFinite(latencies[slot]!)) {
                latencies[slot] = arrived - began - op.startedMs;
                observed++;
              }
            }
          }
          seen[offset] = sequence;
        }
      });
      client.doc.on('update', (bytes: Uint8Array, origin: unknown) => {
        if (origin === 'benchmark-local' && active?.writer === client.index)
          active.updateBytes += bytes.length;
      });
    }
    collector.start();
    began = performance.now();
    const period = 1000 / profile.rate;
    const warmCount = warmRounds * profile.writers;
    const total = (warmRounds + measuredRounds) * profile.writers;
    for (let i = 0; i < total; i++) {
      const writer = i % profile.writers;
      const scheduledMs =
        Math.floor(i / profile.writers) * period + (writer * period) / profile.writers;
      await sleep(began + scheduledMs - performance.now());
      const client = group.clients[writer]!;
      client.sequence++;
      if (i >= warmCount) {
        active = {
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
        operations.push(active);
        byWriter[writer]!.set(client.sequence, active);
      }
      mutate(client.doc, writer, client.sequence, group.documents[client.document]!.actors);
      active = undefined;
      if (client.sequence % 4 === 0) group.pulse(client);
      if ((i + 1) % (profile.writers * profile.rate * 15) === 0)
        console.log(
          `${name}: ${i + 1}/${total} source operations; ${observed}/${expected} measured peer samples observed`,
        );
    }
    actualWindowMs = performance.now() - began - profile.warmupSeconds * 1000;
    try {
      await until(() => observed === expected, 10000);
    } catch {
      errors.push('missing_peer_samples');
    }
    // Independent deterministic content/format oracle, outside timed traffic.
    for (const document of group.documents)
      for (const writer of document.actors)
        for (let sequence = 1; sequence <= group.clients[writer]!.sequence; sequence++)
          mutate(document.reference, writer, sequence, document.actors);
    try {
      await group.converge(true);
      completed = true;
    } catch {
      errors.push('state_or_presence_divergence');
    }
    const quiescent = performance.now();
    try {
      await group.durable();
      durableQuiescenceMs = performance.now() - quiescent;
    } catch {
      errors.push('unconfirmed_postgres_state');
    }
    finalBytes = group.documents.map(
      (_, index) =>
        Y.encodeStateAsUpdate(group.clients.find((c) => c.document === index)!.doc).length,
    );
    const { createHash } = await import('node:crypto');
    finalDigest = createHash('sha256')
      .update(Y.encodeSnapshot(Y.snapshot(group.clients[0]!.doc)))
      .digest('hex');
    if (group.clients.some((c) => c.closes || c.failures || c.session.blocked))
      errors.push('unexpected_connection_loss');
    dependenciesAfter = await deployment.dependencies();
  } catch {
    errors.push('setup_or_execution_failed');
  } finally {
    const telemetry = await collector.stop();
    await gzipLines(`${output}/${name}.telemetry.jsonl.gz`, [
      {
        ...telemetry,
        dependenciesBefore,
        dependenciesAfter,
      },
    ]);
    group.close();
  }
  const samples: number[] = [],
    sameNode: number[] = [],
    crossNode: number[] = [];
  const pairs = Array.from({ length: 16 }, () => [] as number[]);
  for (const op of operations)
    for (let receiver = 0; receiver < profile.writers; receiver++) {
      const value = latencies[op.index * profile.writers + receiver]!;
      if (!Number.isFinite(value)) continue;
      samples.push(value);
      (op.node === nodeFor(receiver) ? sameNode : crossNode).push(value);
      pairs[op.node * 4 + nodeFor(receiver)]!.push(value);
    }
  const lag = operations.map((op) => Math.max(0, op.startedMs - op.scheduledMs));
  const offeredLoadValid =
    operations.length === count &&
    actualWindowMs <= profile.measureSeconds * 1000 + 1000 &&
    lag.every((value) => value < 500);
  const latency = latencyAcceptance(expected, samples);
  const summary = {
    schemaVersion: 1,
    type: 'load',
    profile,
    repeat,
    name,
    expectedOperations: count,
    actualOperations: operations.length,
    expectedSamples: expected,
    latencyMs: latency,
    sameNodeMs: distribution(sameNode),
    crossNodeMs: distribution(crossNode),
    pairs: pairs.map((values, index) => ({
      source: Math.floor(index / 4),
      recipient: index % 4,
      ...distribution(values),
    })),
    scheduleLagMs: distribution(lag),
    actualWindowMs,
    actualMutationsPerSecond: operations.length / (actualWindowMs / 1000),
    offeredLoadValid,
    updateBytes: distribution(operations.map((op) => op.updateBytes)),
    initialBytes,
    finalBytes,
    correctness: completed,
    finalSnapshotSha256: finalDigest,
    durableQuiescenceMs,
    errors,
    passed: latency.passed && completed && offeredLoadValid && errors.length === 0,
  };
  await gzipLines(`${output}/${name}.operations.jsonl.gz`, operations);
  await gzipLines(
    `${output}/${name}.samples.jsonl.gz`,
    (function* () {
      for (const op of operations)
        for (let receiver = 0; receiver < profile.writers; receiver++) {
          const value = latencies[op.index * profile.writers + receiver]!;
          if (Number.isFinite(value)) yield [op.index, receiver, value];
        }
    })(),
  );
  await json(`${output}/${name}.summary.json`, summary);
  return summary;
}
