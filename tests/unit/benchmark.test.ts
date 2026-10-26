import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { distribution, latencyAcceptance } from '../../benchmarks/stats';
import { acceptSample } from '../../benchmarks/analysis';
import {
  completeStateEqual,
  mutate,
  nodeFor,
  richState,
  seedDocument,
} from '../../benchmarks/workloads';
import type { Operation } from '../../benchmarks/load';

describe('benchmark measurement integrity', () => {
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
