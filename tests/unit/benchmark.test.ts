import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import * as Y from 'yjs';
import { distribution, latencyAcceptance } from '../../benchmarks/stats';
import {
  acceptSample,
  analyze,
  offeredLoadValid,
  validateOperation,
} from '../../benchmarks/analysis';
import {
  completeStateEqual,
  mutate,
  nodeFor,
  richState,
  seedDocument,
  smokeLoad,
} from '../../benchmarks/workloads';
import type { Operation } from '../../benchmarks/load';

describe('benchmark measurement integrity', () => {
  it('rejects missing source holes and recipient samples from raw files, and refuses a forged scheduling pass', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commonplace-raw-check-'));
    const profile = { ...smokeLoad, writers: 2, warmupSeconds: 1, measureSeconds: 1 };
    const all: Operation[] = Array.from({ length: 4 }, (_, index) => ({
      index,
      writer: index % 2,
      node: 0,
      document: 0,
      sequence: 3 + Math.floor(index / 2),
      kind: index < 2 ? 'insert' : 'format',
      scheduledMs: 1000 + index * 250,
      startedMs: 1000 + index * 250,
      updateBytes: 42,
    }));
    async function fixture(operations: Operation[], sampleIndices: number[], forged = false) {
      const result = {
        type: 'load',
        name: 'fixture',
        profile,
        correctness: true,
        errors: [],
        actualWindowMs: 1251,
        actualOperations: operations.length,
        expectedOperations: 4,
        expectedSamples: 4,
        offeredLoadValid: forged || offeredLoadValid(operations, profile, 1251),
        scheduleLagMs: distribution(
          operations.map((op) => Math.max(0, op.startedMs - op.scheduledMs)),
        ),
        latencyMs: latencyAcceptance(
          4,
          sampleIndices.map(() => 1),
        ),
      };
      await writeFile(
        join(directory, 'manifest.json'),
        JSON.stringify({ suite: 'smoke', source: { dirty: '' }, cleanedUp: true }),
      );
      await writeFile(join(directory, 'results.json'), JSON.stringify({ results: [result] }));
      await writeFile(
        join(directory, 'fixture.operations.jsonl.gz'),
        gzipSync(operations.map((op) => JSON.stringify(op)).join('\n')),
      );
      await writeFile(
        join(directory, 'fixture.samples.jsonl.gz'),
        gzipSync(sampleIndices.map((i) => JSON.stringify([i, 1 - all[i]!.writer, 1])).join('\n')),
      );
      return analyze(directory);
    }
    try {
      expect((await fixture(all, [0, 1, 2, 3])).loads[0]!.passed).toBe(true);
      const hole = await fixture(
        all.filter((op) => op.index !== 1),
        [0, 2, 3],
      );
      expect(hole.loads[0]).toMatchObject({
        completeOperations: false,
        passed: false,
        latencyMs: { missing: 1 },
      });
      expect((await fixture(all, [0, 1, 2])).loads[0]).toMatchObject({
        completeOperations: true,
        passed: false,
        latencyMs: { missing: 1 },
      });
      await expect(
        fixture(
          all.map((op) => ({ ...op, startedMs: op.startedMs + 500 })),
          [0, 1, 2, 3],
          true,
        ),
      ).rejects.toThrow('offered-load summary mismatch');
    } finally {
      await rm(directory, { recursive: true });
    }
  });
  it('recomputes offered work and rejects corrupt schedules, actor sequences and 500ms interruptions', () => {
    const profile = { ...smokeLoad, writers: 2, warmupSeconds: 1, measureSeconds: 1 };
    const operations: Operation[] = Array.from({ length: 4 }, (_, index) => ({
      index,
      writer: index % 2,
      node: 0,
      document: 0,
      sequence: 3 + Math.floor(index / 2),
      kind: index < 2 ? 'insert' : 'format',
      scheduledMs: 1000 + index * 250,
      startedMs: 1000 + index * 250,
      updateBytes: 42,
    }));
    operations.forEach((op, i) => validateOperation(op, i, profile));
    expect(offeredLoadValid(operations, profile, 751)).toBe(true);
    expect(offeredLoadValid(operations.slice(1), profile, 751)).toBe(false);
    expect(offeredLoadValid(operations, profile, 2001)).toBe(false);
    expect(offeredLoadValid(operations, profile, 749)).toBe(false);
    for (const change of [
      { writer: 1 },
      { sequence: 4 },
      { scheduledMs: NaN },
      { scheduledMs: 999 },
    ])
      expect(() => validateOperation({ ...operations[0]!, ...change }, 0, profile)).toThrow();
    const delayed = operations.map((op) => ({ ...op, startedMs: op.startedMs + 500 }));
    expect(offeredLoadValid(delayed, profile, 1251)).toBe(false);
  });
  it('uses nearest-rank tails, retains outliers, and fails missing samples or the strict threshold', () => {
    expect(distribution([9, 1, 2, 3, 4, 5, 6, 7, 8, 1000])).toMatchObject({
      count: 10,
      p50: 5,
      p95: 1000,
      max: 1000,
    });
    expect(latencyAcceptance(3, [1, 2]).passed).toBe(false);
    expect(latencyAcceptance(1, [100]).passed).toBe(false);
    expect(latencyAcceptance(1, [99.99]).passed).toBe(true);
    expect(latencyAcceptance(0, []).passed).toBe(false);
    expect(latencyAcceptance(3, [1, 2, NaN]).missing).toBe(1);
  });
  it('rejects duplicate, self, cross-document, nonfinite, negative and unknown-operation raw samples', () => {
    const op = { index: 0, writer: 0, document: 0 } as Operation;
    const seen = new Uint8Array(50);
    acceptSample(op, 5, 1, 50, 5, seen);
    for (const [recipient, latency] of [
      [5, 1],
      [0, 1],
      [1, 1],
      [10, Infinity],
      [10, -1],
      [50, 1],
    ])
      expect(() => acceptSample(op, recipient!, latency!, 50, 5, seen)).toThrow();
    expect(() => acceptSample(undefined, 10, 1, 50, 5, seen)).toThrow();
  });
  it('requires deletion state beyond state vectors and preserves formatting in its oracle', () => {
    const a = seedDocument([0], 1024),
      b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    const updates: Uint8Array[] = [];
    a.on('update', (update) => updates.push(update));
    // A deletion-only transaction advances no vector clock.
    const text = (a.getXmlFragment('default').get(0) as Y.XmlElement).get(0) as Y.XmlText;
    text.delete(0, 1);
    expect(Y.encodeStateVector(a)).toEqual(Y.encodeStateVector(b));
    expect(completeStateEqual(a, b)).toBe(false);
    Y.applyUpdate(b, updates[0]!);
    expect(completeStateEqual(a, b)).toBe(true);
    text.format(0, 5, { bold: true });
    expect(richState(a)).not.toBe(richState(b));
    a.destroy();
    b.destroy();
  });
  it('does not apply a later marker across a missing causal update; deterministic rich-text oracles agree', () => {
    const a = seedDocument([0, 1], 1024),
      b = new Y.Doc(),
      expected = new Y.Doc();
    const seed = Y.encodeStateAsUpdate(a);
    Y.applyUpdate(b, seed);
    Y.applyUpdate(expected, seed);
    const updates: Uint8Array[] = [];
    a.on('update', (update) => updates.push(update));
    for (let sequence = 1; sequence <= 10; sequence++) {
      mutate(a, 0, sequence, [0, 1]);
      mutate(expected, 0, sequence, [0, 1]);
    }
    Y.applyUpdate(b, updates.at(-1)!);
    expect(b.getMap('benchmark-sequences').get('0')).toBe(0);
    for (const update of updates.slice(0, -1)) Y.applyUpdate(b, update);
    expect(completeStateEqual(a, b)).toBe(true);
    expect(richState(a)).toBe(richState(expected));
    expect(
      Array.from({ length: 50 }, (_, i) => nodeFor(i)).reduce(
        (n, node) => {
          n[node]!++;
          return n;
        },
        [0, 0, 0, 0],
      ),
    ).toEqual([13, 13, 12, 12]);
    a.destroy();
    b.destroy();
    expected.destroy();
  });
});
