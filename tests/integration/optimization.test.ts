import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { HocuspocusProvider } from '@hocuspocus/provider';
import * as Y from 'yjs';
import { createApplication } from '../../apps/server/src/app.js';
import { readConfig } from '../../apps/server/src/config.js';
import { decodeFrame } from '../../apps/server/src/protocol.js';
import { policySchema } from '../../apps/server/src/policy.js';

const databaseUrl =
  process.env.TEST_DATABASE_URL ||
  'postgres://workspace:workspace-local@localhost:5434/workspace_test';
if (!new URL(databaseUrl).pathname.endsWith('_test'))
  throw new Error('Optimization tests require an isolated test database');
const config = {
  ...readConfig(),
  host: '127.0.0.1',
  port: 0,
  databaseUrl,
  redisUrl: process.env.TEST_REDIS_URL || 'redis://localhost:6381',
  redisPrefix: 'optimization:' + randomUUID(),
};
type App = Awaited<ReturnType<typeof createApplication>>;
let first: App, second: App, firstPort: number, secondPort: number;
const clients: { doc: Y.Doc; provider: HocuspocusProvider }[] = [];
beforeAll(async () => {
  first = await createApplication(config);
  second = await createApplication(config);
  firstPort = await first.listen();
  secondPort = await second.listen();
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const c of clients.splice(0)) {
    c.provider.destroy();
    c.doc.destroy();
  }
});
afterAll(async () => {
  await second.close();
  await first.close();
});
async function connect(document: { id: string; token: string }, port: number) {
  const doc = new Y.Doc();
  const provider = new HocuspocusProvider({
    document: doc,
    name: document.id,
    token: document.token,
    url: `ws://127.0.0.1:${port}/collaboration`,
  });
  const client = { doc, provider, text: doc.getText('body') };
  clients.push(client);
  await vi.waitFor(() => expect(provider.synced).toBe(true), { timeout: 5000 });
  return client;
}
function delta(message: unknown) {
  if (!Buffer.isBuffer(message)) return false;
  try {
    const frame = decodeFrame(message.subarray(1 + message[0]!), policySchema.parse({}));
    return frame.type === 0 && frame.syncType === 2;
  } catch {
    return false;
  }
}
async function stored(app: App, id: string, expected: Y.Doc) {
  const doc = new Y.Doc();
  try {
    const state = await app.store.load(id);
    if (state) Y.applyUpdate(doc, state);
    return Y.equalSnapshots(Y.snapshot(doc), Y.snapshot(expected));
  } finally {
    doc.destroy();
  }
}

it('pushes inserts, formatting and deletion-only deltas to an idle peer without per-edit state-vector exchanges', async () => {
  const document = await first.store.create('Delta fanout');
  const a = await connect(document, firstPort),
    b = await connect(document, secondPort);
  vi.spyOn(first.synchronization, 'reconcileNow').mockResolvedValue();
  vi.spyOn(second.synchronization, 'reconcileNow').mockResolvedValue();
  const publish = first.synchronization.pub.publish.bind(first.synchronization.pub);
  const messages: unknown[] = [];
  vi.spyOn(first.synchronization.pub, 'publish').mockImplementation((channel, message) => {
    if (String(channel).endsWith(':' + document.id)) messages.push(message);
    return publish(channel, message);
  });
  a.text.insert(0, 'abcdef');
  await vi.waitFor(() => expect(b.text.toString()).toBe('abcdef'));
  a.text.format(0, 3, { bold: true });
  await vi.waitFor(() => expect(b.text.toDelta()).toEqual(a.text.toDelta()));
  const vector = Y.encodeStateVector(a.doc);
  a.text.delete(1, 2);
  expect(Y.encodeStateVector(a.doc)).toEqual(vector);
  await vi.waitFor(() => expect(b.text.toDelta()).toEqual(a.text.toDelta()));
  expect(messages.filter(delta).length).toBeGreaterThanOrEqual(3);
  for (const message of messages) {
    const frame = decodeFrame(
      (message as Buffer).subarray(1 + (message as Buffer)[0]!),
      policySchema.parse({}),
    );
    expect(frame.type === 0 && frame.syncType === 0).toBe(false);
  }
});

it('bounds stalled delta publications, keeps PostgreSQL progress, and repairs deferred history without a new edit', async () => {
  const document = await first.store.create('Redis publication pressure');
  const a = await connect(document, firstPort),
    b = await connect(document, secondPort);
  vi.spyOn(first.synchronization, 'reconcileNow').mockResolvedValue();
  vi.spyOn(second.synchronization, 'reconcileNow').mockResolvedValue();
  const publish = first.synchronization.pub.publish.bind(first.synchronization.pub);
  let release!: () => void;
  const blocked = new Promise<number>((resolve) => {
    release = () => resolve(1);
  });
  let pending = 0;
  vi.spyOn(first.synchronization.pub, 'publish').mockImplementation((channel, message) => {
    if (String(channel).endsWith(':' + document.id) && delta(message)) {
      pending++;
      return blocked;
    }
    return publish(channel, message);
  });
  try {
    for (let i = 0; i < 45; i++) {
      a.text.insert(a.text.length, 'x');
      await delay(5);
    }
    await vi.waitFor(() => expect(pending).toBe(32));
    const metrics = await first.telemetry.metrics();
    expect(metrics).toContain('commonplace_redis_delta_inflight 32');
    expect(metrics).toMatch(
      /commonplace_redis_delta_publications_total\{result="deferred"\} [1-9]/,
    );
    expect(first.synchronization.healthy).toBe(false);
    await vi.waitFor(async () => expect(await stored(first, document.id, a.doc)).toBe(true), {
      timeout: 5000,
    });
  } finally {
    release();
    vi.restoreAllMocks();
  }
  await first.synchronization.reconcileNow();
  await second.synchronization.reconcileNow();
  await vi.waitFor(() => expect(b.text.toString()).toBe('x'.repeat(45)));
  await vi.waitFor(async () =>
    expect(await first.telemetry.metrics()).toContain('commonplace_redis_delta_inflight 0'),
  );
});

it('coalesces simultaneous committed-snapshot reads without caching a settled or deletion-stale result', async () => {
  const document = await first.store.create('Concurrent database checks');
  const a = await connect(document, firstPort),
    b = await connect(document, firstPort);
  a.text.insert(0, 'committed');
  await vi.waitFor(async () => expect(await stored(first, document.id, a.doc)).toBe(true), {
    timeout: 5000,
  });
  const original = first.store.load.bind(first.store);
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reads = vi.spyOn(first.store, 'load').mockImplementation(async (id) => {
    const state = await original(id);
    await blocked;
    return state;
  });
  const responses: { requestId: string; snapshot?: string; status: string }[] = [];
  for (const client of [a, b])
    client.provider.on('stateless', ({ payload }: { payload: string }) =>
      responses.push(JSON.parse(payload)),
    );
  const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  a.provider.sendStateless(JSON.stringify({ type: 'persistence:check:v1', requestId: ids[0] }));
  b.provider.sendStateless(JSON.stringify({ type: 'persistence:check:v1', requestId: ids[1] }));
  try {
    await vi.waitFor(() => expect(reads).toHaveBeenCalledTimes(1));
    await delay(50);
    expect(reads).toHaveBeenCalledTimes(1);
  } finally {
    release();
  }
  await vi.waitFor(() => expect(responses).toHaveLength(2));
  const deleted = new Y.Doc();
  try {
    Y.applyUpdate(deleted, Y.encodeStateAsUpdate(a.doc));
    deleted.getText('body').delete(0, 1);
    await first.store.store(document.id, Y.encodeStateAsUpdate(deleted));
    a.provider.sendStateless(JSON.stringify({ type: 'persistence:check:v1', requestId: ids[2] }));
    await vi.waitFor(() => expect(responses.some((r) => r.requestId === ids[2])).toBe(true));
    const result = responses.find((r) => r.requestId === ids[2])!;
    expect(
      Y.equalSnapshots(
        Y.decodeSnapshot(Buffer.from(result.snapshot!, 'base64')),
        Y.snapshot(deleted),
      ),
    ).toBe(true);
    expect(reads.mock.calls.length).toBeGreaterThanOrEqual(2);
    reads.mockRejectedValueOnce(new Error('Injected database read failure'));
    a.provider.sendStateless(JSON.stringify({ type: 'persistence:check:v1', requestId: ids[3] }));
    await vi.waitFor(() => expect(responses.some((r) => r.requestId === ids[3])).toBe(true));
    const failed = responses.find((r) => r.requestId === ids[3])!;
    expect(failed.status).toBe('retrying');
    expect(failed.snapshot).toBeUndefined();
  } finally {
    deleted.destroy();
  }
});
