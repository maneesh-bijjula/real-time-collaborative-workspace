import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { HocuspocusProvider } from '@hocuspocus/provider';
import * as Y from 'yjs';
import { createApplication } from '../../apps/server/src/app.js';
import type { ServerConfig } from '../../apps/server/src/config.js';

const databaseUrl =
  process.env.TEST_DATABASE_URL ||
  'postgres://workspace:workspace-local@localhost:5434/workspace_test';
if (!new URL(databaseUrl).pathname.endsWith('_test'))
  throw new Error('Integration tests require a database name ending in _test');
const config: ServerConfig = {
  port: 0,
  host: '127.0.0.1',
  databaseUrl,
  redisUrl: process.env.TEST_REDIS_URL || 'redis://localhost:6381',
  redisPrefix: 'test:' + randomUUID(),
  allowedOrigins: ['http://localhost:3000'],
};
type Application = Awaited<ReturnType<typeof createApplication>>;
type Created = { id: string; token: string; title: string };
let first: Application;
let second: Application;
let firstPort: number;
let secondPort: number;
let clients: { provider: HocuspocusProvider; doc: Y.Doc }[] = [];

async function create(title = 'Shared notes'): Promise<Created> {
  const response = await fetch(`http://127.0.0.1:${firstPort}/api/documents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  expect(response.status).toBe(201);
  return response.json();
}

async function connect(document: Created, port = firstPort) {
  const doc = new Y.Doc();
  let ready!: () => void;
  let fail!: (reason: Error) => void;
  const synced = new Promise<void>((resolve, reject) => {
    ready = resolve;
    fail = reject;
  });
  const provider = new HocuspocusProvider({
    url: `ws://127.0.0.1:${port}/collaboration`,
    name: document.id,
    token: document.token,
    document: doc,
    onSynced: ({ state }) => {
      if (state) ready();
    },
    onAuthenticationFailed: () => fail(new Error('Access denied')),
  });
  clients.push({ provider, doc });
  await Promise.race([
    synced,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error('Client did not sync')), 8000);
      timer.unref();
    }),
  ]);
  return { provider, doc, text: doc.getText('body') };
}

beforeAll(async () => {
  first = await createApplication(config);
  firstPort = await first.listen();
  await first.pool.query('DELETE FROM documents');
  second = await createApplication(config);
  secondPort = await second.listen();
});
afterEach(async () => {
  for (const client of clients) {
    client.provider.destroy();
    client.doc.destroy();
  }
  clients = [];
});
afterAll(async () => {
  if (second) await second.close();
  if (first) await first.close();
});

describe('document HTTP access', () => {
  it('hashes the share token and authorizes metadata reads', async () => {
    const document = await create();
    const stored = await first.pool.query('SELECT access_token_hash FROM documents WHERE id = $1', [
      document.id,
    ]);
    expect(stored.rows[0].access_token_hash).toHaveLength(32);
    expect(stored.rows[0].access_token_hash.toString('utf8')).not.toBe(document.token);
    const response = await fetch(`http://127.0.0.1:${firstPort}/api/documents/${document.id}`, {
      headers: { Authorization: `Bearer ${document.token}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).not.toHaveProperty('token');
  });
  it('hides documents from callers without the correct token', async () => {
    const document = await create();
    for (const token of ['', 'x'.repeat(43)]) {
      expect(
        (
          await fetch(`http://127.0.0.1:${firstPort}/api/documents/${document.id}`, {
            headers: { Authorization: `Bearer ${token}` },
          })
        ).status,
      ).toBe(404);
    }
  });
  it('validates titles, IDs, and malformed JSON', async () => {
    for (const body of ['not-json', '{"title":""}', '{"title":"ok","state":"injected"}']) {
      expect(
        (
          await fetch(`http://127.0.0.1:${firstPort}/api/documents`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
          })
        ).status,
      ).toBe(400);
    }
    expect((await fetch(`http://127.0.0.1:${firstPort}/api/documents/not-a-uuid`)).status).toBe(
      400,
    );
  });
  it('renames an authorized document and preserves SQL-like text as data', async () => {
    const document = await create();
    const title = "'; DROP TABLE documents; --";
    const response = await fetch(`http://127.0.0.1:${firstPort}/api/documents/${document.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${document.token}` },
      body: JSON.stringify({ title }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).title).toBe(title);
    expect((await first.pool.query('SELECT count(*) FROM documents')).rows[0].count).not.toBe('0');
  });
  it('checks PostgreSQL and Redis health', async () =>
    expect((await fetch(`http://127.0.0.1:${firstPort}/health`)).status).toBe(200));
});

describe('collaborative editing and durability', () => {
  it('synchronizes edits between two clients', async () => {
    const document = await create();
    const a = await connect(document);
    const b = await connect(document);
    a.text.insert(0, 'Hello team');
    await vi.waitFor(() => expect(b.text.toString()).toBe('Hello team'));
    b.text.insert(b.text.length, '!');
    await vi.waitFor(() => expect(a.text.toString()).toBe('Hello team!'));
  });
  it('merges concurrent offline edits on reconnect', async () => {
    const document = await create();
    const a = await connect(document);
    const b = await connect(document);
    a.provider.disconnect();
    b.provider.disconnect();
    await vi.waitFor(() => {
      expect(a.provider.configuration.websocketProvider.status).toBe('disconnected');
      expect(b.provider.configuration.websocketProvider.status).toBe('disconnected');
    });
    a.text.insert(0, 'alpha');
    b.text.insert(0, 'beta');
    await Promise.all([a.provider.connect(), b.provider.connect()]);
    await vi.waitFor(
      () => {
        expect(a.text.toString()).toBe(b.text.toString());
        expect(a.text.toString()).toContain('alpha');
        expect(a.text.toString()).toContain('beta');
      },
      { timeout: 5000 },
    );
  });
  it('propagates presence and removes a disconnected participant', async () => {
    const document = await create();
    const a = await connect(document);
    const b = await connect(document);
    a.provider.setAwarenessField('user', { name: 'Alex', color: '#7856b6' });
    await vi.waitFor(() =>
      expect(
        Array.from(b.provider.awareness!.getStates().values()).some(
          (state) => state.user?.name === 'Alex',
        ),
      ).toBe(true),
    );
    a.provider.destroy();
    await vi.waitFor(() =>
      expect(
        Array.from(b.provider.awareness!.getStates().values()).some(
          (state) => state.user?.name === 'Alex',
        ),
      ).toBe(false),
    );
  });
  it('synchronizes clients connected to separate servers through Redis', async () => {
    const document = await create();
    const a = await connect(document, firstPort);
    const b = await connect(document, secondPort);
    a.text.insert(0, 'across instances');
    await vi.waitFor(() => expect(b.text.toString()).toBe('across instances'));
    b.text.insert(b.text.length, ' works');
    await vi.waitFor(() => expect(a.text.toString()).toBe('across instances works'));
  });
  it('persists Yjs state in PostgreSQL and reloads it into a new document', async () => {
    const document = await create();
    const a = await connect(document);
    a.text.insert(0, 'Durable text');
    await vi.waitFor(
      async () => {
        const state = await first.store.load(document.id);
        expect(state).not.toBeNull();
        const restored = new Y.Doc();
        Y.applyUpdate(restored, state!);
        expect(restored.getText('body').toString()).toBe('Durable text');
        restored.destroy();
      },
      { timeout: 5000 },
    );
  });
  it('merges concurrent persisted snapshots without losing CRDT history', async () => {
    const document = await create();
    const a = new Y.Doc();
    const b = new Y.Doc();
    a.getText('body').insert(0, 'one');
    b.getText('body').insert(0, 'two');
    await Promise.all([
      first.store.store(document.id, Y.encodeStateAsUpdate(a)),
      second.store.store(document.id, Y.encodeStateAsUpdate(b)),
    ]);
    const restored = new Y.Doc();
    Y.applyUpdate(restored, (await first.store.load(document.id))!);
    expect(restored.getText('body').toString()).toContain('one');
    expect(restored.getText('body').toString()).toContain('two');
    a.destroy();
    b.destroy();
    restored.destroy();
  });
  it('rejects a websocket client with an invalid document token', async () => {
    const document = await create();
    await expect(connect({ ...document, token: 'x'.repeat(43) })).rejects.toThrow('Access denied');
  });

  it('preserves deletions when an older persisted snapshot arrives later', async () => {
    const document = await create();
    const source = new Y.Doc();
    source.getText('body').insert(0, 'abcdef');
    const stale = Y.encodeStateAsUpdate(source);
    source.getText('body').delete(1, 2);
    await first.store.store(document.id, Y.encodeStateAsUpdate(source));
    await second.store.store(document.id, stale);
    const restored = new Y.Doc();
    Y.applyUpdate(restored, (await first.store.load(document.id))!);
    expect(restored.getText('body').toString()).toBe('adef');
    source.destroy();
    restored.destroy();
  });

  it('reloads document content after a complete collaboration server restart', async () => {
    const document = await create();
    let temporary = await createApplication({
      ...config,
      redisPrefix: config.redisPrefix + ':restart',
    });
    try {
      let port = await temporary.listen();
      const a = await connect(document, port);
      a.text.insert(0, 'Survives a restart');
      await vi.waitFor(async () => expect(await first.store.load(document.id)).not.toBeNull(), {
        timeout: 5000,
      });
      a.provider.destroy();
      a.doc.destroy();
      clients = clients.filter((client) => client.provider !== a.provider);
      await temporary.close();
      temporary = await createApplication({
        ...config,
        redisPrefix: config.redisPrefix + ':restart',
      });
      port = await temporary.listen();
      const b = await connect(document, port);
      expect(b.text.toString()).toBe('Survives a restart');
      b.provider.destroy();
      b.doc.destroy();
      clients = clients.filter((client) => client.provider !== b.provider);
    } finally {
      await temporary.close();
    }
  });
});
