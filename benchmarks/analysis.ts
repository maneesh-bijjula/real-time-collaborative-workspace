import { createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import { distribution, latencyAcceptance } from './stats.js';
import { nodeFor, primary, reconnect } from './workloads.js';
import type { Operation } from './load.js';

export async function* lines(path: string) {
  const source = createReadStream(path);
  const input = source.pipe(createGunzip());
  source.on('error', (error) => input.destroy(error));
  const reader = createInterface({ input, crlfDelay: Infinity });
  // Forward source/decompression failures rather than silently accepting a
  // truncated file as a smaller successful sample set.
  let failure: Error | undefined;
  input.on('error', (error) => {
    failure = error;
    reader.close();
  });
  try {
    for await (const line of reader) yield JSON.parse(line);
  } finally {
    source.destroy();
    input.destroy();
  }
  if (failure) throw failure;
}
export function acceptSample(
  op: Operation | undefined,
  recipient: number,
  value: number,
  writers: number,
  documents: number,
  seen: Uint8Array,
) {
  if (
    !op ||
    !Number.isInteger(recipient) ||
    recipient < 0 ||
    recipient >= writers ||
    recipient === op.writer ||
    recipient % documents !== op.document ||
    !Number.isFinite(value) ||
    value < 0
  )
    throw new Error('Invalid raw latency sample');
  const slot = op.index * writers + recipient;
  if (seen[slot]) throw new Error('Duplicate raw latency sample');
  seen[slot] = 1;
}
export async function analyze(directory: string) {
  const manifest = JSON.parse(await readFile(`${directory}/manifest.json`, 'utf8'));
  const saved = JSON.parse(await readFile(`${directory}/results.json`, 'utf8'));
  const loads = [],
    rejoins = [];
  const pooled: number[] = [];
  for (const result of saved.results) {
    if (result.type === 'load') {
      const operations: Operation[] = [];
      for await (const op of lines(`${directory}/${result.name}.operations.jsonl.gz`)) {
        if (
          op.index !== operations.length ||
          !Number.isInteger(op.writer) ||
          op.writer < 0 ||
          op.writer >= result.profile.writers ||
          op.node !== nodeFor(op.writer) ||
          op.document !== op.writer % result.profile.documents ||
          !Number.isFinite(op.startedMs) ||
          op.updateBytes <= 0
        )
          throw new Error('Invalid raw operation');
        operations.push(op);
      }
      const values: number[] = [],
        same: number[] = [],
        cross: number[] = [];
      const pairs = Array.from({ length: 16 }, () => [] as number[]);
      const seen = new Uint8Array(operations.length * result.profile.writers);
      for await (const [index, recipient, value] of lines(
        `${directory}/${result.name}.samples.jsonl.gz`,
      )) {
        const op = operations[index];
        acceptSample(op, recipient, value, result.profile.writers, result.profile.documents, seen);
        values.push(value);
        (op!.node === nodeFor(recipient) ? same : cross).push(value);
        pairs[op!.node * 4 + nodeFor(recipient)]!.push(value);
      }
      const expectedOperations =
        result.profile.measureSeconds * result.profile.rate * result.profile.writers;
      const expectedSamples =
        expectedOperations * (result.profile.writers / result.profile.documents - 1);
      const latencyMs = latencyAcceptance(expectedSamples, values);
      if (JSON.stringify(latencyMs) !== JSON.stringify(result.latencyMs))
        throw new Error('Saved/raw latency summary mismatch');
      const completeOperations =
        operations.length === expectedOperations &&
        Array.from(
          { length: result.profile.writers },
          (_, writer) =>
            operations.filter((op) => op.writer === writer).length ===
            result.profile.measureSeconds * result.profile.rate,
        ).every(Boolean);
      const measured = {
        name: result.name,
        profile: result.profile,
        completeOperations,
        latencyMs,
        sameNodeMs: distribution(same),
        crossNodeMs: distribution(cross),
        pairs: pairs.map((values, pair) => ({
          source: Math.floor(pair / 4),
          recipient: pair % 4,
          ...distribution(values),
        })),
        correctness: result.correctness,
        offeredLoadValid: result.offeredLoadValid,
        errors: result.errors,
        passed:
          completeOperations &&
          latencyMs.passed &&
          result.correctness &&
          result.offeredLoadValid &&
          result.errors.length === 0,
      };
      loads.push(measured);
      if (result.profile.primary) for (const value of values) pooled.push(value);
    } else if (result.type === 'reconnect') {
      rejoins.push({
        profile: result.profile,
        completed: result.trials.length,
        missing: result.profile.trials - result.trials.length,
        failed: result.trials.filter(
          (t: any) => !t.converged || t.elapsedMs >= result.profile.deadlineMs,
        ).length,
        durationMs: distribution(result.trials.map((t: any) => t.elapsedMs)),
        passed:
          result.trials.length === result.profile.trials &&
          result.trials.every(
            (t: any, i: number) =>
              t.trial === i + 1 &&
              t.converged &&
              Number.isFinite(t.elapsedMs) &&
              t.elapsedMs >= 0 &&
              t.elapsedMs < result.profile.deadlineMs,
          ) &&
          !result.errors.length,
      });
    }
  }
  const primaries = loads.filter(
    (r) => r.profile.id === primary.id && JSON.stringify(r.profile) === JSON.stringify(primary),
  );
  const primaryReconnect = rejoins.filter(
    (r) => r.profile.id === reconnect.id && JSON.stringify(r.profile) === JSON.stringify(reconnect),
  );
  const primaryTargetsPassed = Boolean(
    manifest.suite === 'full' &&
    !manifest.source.dirty &&
    !manifest.fatal &&
    manifest.cleanedUp &&
    primaries.length === primary.repeats &&
    new Set(primaries.map((r) => r.name)).size === primary.repeats &&
    primaries.every((r) => r.passed) &&
    primaryReconnect.length === 1 &&
    primaryReconnect[0]!.passed,
  );
  return {
    schemaVersion: 1,
    source: manifest.source,
    suite: manifest.suite,
    primaryTargetsPassed,
    pooledPrimaryLatencyMs: distribution(pooled),
    loads,
    reconnect: rejoins,
  };
}
