import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { HocuspocusProvider } from '@hocuspocus/provider';
import * as Y from 'yjs';
import { createApplication } from '../../apps/server/src/app.js';
import type { ServerConfig } from '../../apps/server/src/config.js';
import { DatabaseSaveTracker } from '../../apps/web/lib/database-save';

const config: ServerConfig = {
  port: 0,
  host: '127.0.0.1',
  databaseUrl:
    process.env.TEST_DATABASE_URL ||
    'postgres://workspace:workspace-local@localhost:5434/workspace_test',
  redisUrl: process.env.TEST_REDIS_URL || 'redis://localhost:6381',
  redisPrefix: 'durability-test:' + randomUUID(),
  allowedOrigins: ['http://localhost:3000'],
};
if (!new URL(config.databaseUrl).pathname.endsWith('_test'))
  throw new Error('Persistence tests require a dedicated test database');
type Application = Awaited<ReturnType<typeof createApplication>>;
type Created = { id: string; token: string };
let application: Application;
let port: number;
const clients: { provider: HocuspocusProvider; doc: Y.Doc; tracker: DatabaseSaveTracker }[] = [];
const children = new Set<ChildProcess>();

async function connect(document: Created, targetPort = port) {
  const doc = new Y.Doc();
  const provider = new HocuspocusProvider({
    url: `ws://127.0.0.1:${targetPort}/collaboration`,
    name: document.id,
    token: document.token,
    document: doc,
  });
  const tracker = new DatabaseSaveTracker(doc, provider, () => {});
  const client = { provider, doc, tracker, text: doc.getText('body') };
  clients.push(client);
  await vi.waitFor(() => expect(provider.synced && !provider.hasUnsyncedChanges).toBe(true), {
    timeout: 8000,
  });
  return client;
}
function dispose(client: (typeof clients)[number]) {
  client.tracker.destroy();
  client.provider.destroy();
  client.doc.destroy();
  const index = clients.indexOf(client);
  if (index >= 0) clients.splice(index, 1);
}
async function saved(client: (typeof clients)[number]) {
  await vi.waitFor(() => expect(client.tracker.state).toBe('saved'), { timeout: 8000 });
}
async function stored(id: string) {
  const doc = new Y.Doc();
  const state = await application.store.load(id);
  if (state) Y.applyUpdate(doc, state);
  const text = doc.getText('body').toString();
  doc.destroy();
  return text;
}
async function processServer(fail = false) {
  const child = fork(
    fileURLToPath(new URL('../fixtures/persistence-server.ts', import.meta.url)),
    [],
    {
      execArgv: ['--import', 'tsx'],
      env: {
        ...process.env,
        PERSISTENCE_TEST_CONFIG: JSON.stringify({
          ...config,
          redisPrefix: config.redisPrefix + ':process',
        }),
        FAIL_PERSISTENCE: fail ? '1' : '0',
      },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    },
  );
  children.add(child);
  const ready = once(child, 'message');
  const exited = once(child, 'exit').then(() => {
    throw new Error('Server fixture exited before listening');
  });
  const [{ port: targetPort }] = (await Promise.race([ready, exited])) as [{ port: number }];
  return { child, port: targetPort };
}
async function kill(child: ChildProcess, signal: NodeJS.Signals) {
  const exited = once(child, 'exit');
  child.kill(signal);
  const result = await exited;
  children.delete(child);
  return result;
}

beforeAll(async () => {
  application = await createApplication(config);
  port = await application.listen();
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const client of [...clients]) dispose(client);
  await Promise.all([...children].map((child) => kill(child, 'SIGKILL')));
});
afterAll(async () => {
  await application?.close();
});

describe('database-confirmed durability', () => {
  it('does not confirm synchronization as persistence, then retries an idle failed save', async () => {
    const document = await application.store.create('Retry without another edit');
    const client = await connect(document);
    const original = application.store.store.bind(application.store);
    let failing = true;
    const store = vi.spyOn(application.store, 'store').mockImplementation(async (...args) => {
      if (failing) throw new Error('Injected storage failure');
      return original(...args);
    });
    client.text.insert(0, 'Save me');
    await vi.waitFor(() => expect(store).toHaveBeenCalled());
    await vi.waitFor(() => expect(client.provider.hasUnsyncedChanges).toBe(false));
    expect(client.tracker.state).not.toBe('saved');
    expect(await stored(document.id)).toBe('');
    await vi.waitFor(() => expect(client.tracker.state).toBe('retrying'));
    failing = false;
    await saved(client);
    expect(await stored(document.id)).toBe('Save me');
    expect(store.mock.calls.length).toBeGreaterThan(1);
  });

  it('retains and retries a dirty document after its last client disconnects', async () => {
    const document = await application.store.create('Disconnected retry');
    const client = await connect(document);
    const original = application.store.store.bind(application.store);
    let failing = true;
    const store = vi.spyOn(application.store, 'store').mockImplementation(async (...args) => {
      if (failing) throw new Error('Injected storage failure');
      return original(...args);
    });
    client.text.insert(0, 'Retained until committed');
    await vi.waitFor(() => expect(store).toHaveBeenCalled());
    dispose(client);
    expect(application.collaboration.documents.has(document.id)).toBe(true);
    failing = false;
    await vi.waitFor(
      async () => expect(await stored(document.id)).toBe('Retained until committed'),
      { timeout: 8000 },
    );
    await vi.waitFor(
      () => expect(application.collaboration.documents.has(document.id)).toBe(false),
      { timeout: 5000 },
    );
  });

  it('does not mark an edit or deletion arriving during a write as already saved', async () => {
    const document = await application.store.create('In-flight edits');
    const client = await connect(document);
    client.text.insert(0, 'abcdef');
    await saved(client);
    const original = application.store.store.bind(application.store);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const store = vi.spyOn(application.store, 'store').mockImplementation(async (...args) => {
      await gate;
      return original(...args);
    });
    try {
      client.text.insert(6, ' first');
      await vi.waitFor(() => expect(store).toHaveBeenCalled());
      client.text.delete(1, 2);
      client.text.insert(client.text.length, ' second');
      await delay(700);
      expect(client.tracker.state).not.toBe('saved');
      expect(await stored(document.id)).toBe('abcdef');
    } finally {
      release();
    }
    await saved(client);
    expect(await stored(document.id)).toBe('adef first second');
  });

  it('confirms committed state independently on clients connected to two instances', async () => {
    const second = await createApplication(config);
    try {
      const document = await application.store.create('Concurrent nodes');
      const a = await connect(document),
        b = await connect(document, await second.listen());
      a.text.insert(0, 'one');
      b.text.insert(0, 'two');
      await Promise.all([saved(a), saved(b)]);
      expect(a.text.toString()).toBe(b.text.toString());
      expect(await stored(document.id)).toBe(a.text.toString());
      dispose(a);
      dispose(b);
    } finally {
      await second.close();
    }
  });

  it('retries after a real PostgreSQL transaction failure without reporting saved', async () => {
    const document = await application.store.create('PostgreSQL failure');
    const client = await connect(document);
    const functionName = 'fail_save_' + document.id.replaceAll('-', '');
    await application.pool
      .query(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.id = '${document.id}'::uuid THEN RAISE EXCEPTION 'Injected save failure'; END IF; RETURN NEW; END $$`);
    await application.pool.query(
      `CREATE TRIGGER ${functionName} BEFORE UPDATE OF state ON documents FOR EACH ROW EXECUTE FUNCTION ${functionName}()`,
    );
    try {
      client.text.insert(0, 'Recover after SQL rollback');
      await vi.waitFor(() => expect(client.tracker.state).toBe('retrying'), { timeout: 4000 });
      expect(await stored(document.id)).toBe('');
    } finally {
      await application.pool.query(`DROP TRIGGER ${functionName} ON documents`);
      await application.pool.query(`DROP FUNCTION ${functionName}()`);
    }
    await saved(client);
    expect(await stored(document.id)).toBe('Recover after SQL rollback');
  });

  it('persists Redis-received edits when the originating instance cannot store them', async () => {
    const document = await application.store.create('Surviving replica persistence');
    const source = await processServer(true);
    const receiver = await createApplication({
      ...config,
      redisPrefix: config.redisPrefix + ':process',
    });
    try {
      const a = await connect(document, source.port);
      const b = await connect(document, await receiver.listen());
      a.text.insert(0, 'Persisted by the receiving instance');
      await Promise.all([saved(a), saved(b)]);
      await kill(source.child, 'SIGKILL');
      dispose(a);
      expect(await stored(document.id)).toBe('Persisted by the receiving instance');
      expect(b.text.toString()).toBe('Persisted by the receiving instance');
      dispose(b);
    } finally {
      await receiver.close();
    }
  });

  it('survives SIGKILL after confirming an insertion and a deletion, with no client replay', async () => {
    const document = await application.store.create('Abrupt crash');
    const first = await processServer();
    const client = await connect(document, first.port);
    client.text.insert(0, 'abcdef');
    await saved(client);
    client.text.delete(1, 2);
    await saved(client);
    await kill(first.child, 'SIGKILL');
    dispose(client);
    const second = await processServer();
    const fresh = await connect(document, second.port);
    expect(fresh.text.toString()).toBe('adef');
    await saved(fresh);
    dispose(fresh);
    expect((await kill(second.child, 'SIGTERM'))[0]).toBe(0);
  });

  it('flushes pending edits on SIGTERM before exiting successfully', async () => {
    const document = await application.store.create('Graceful flush');
    const server = await processServer();
    const client = await connect(document, server.port);
    client.text.insert(0, 'Flush before exit');
    await vi.waitFor(() => expect(client.provider.hasUnsyncedChanges).toBe(false));
    expect((await kill(server.child, 'SIGTERM'))[0]).toBe(0);
    dispose(client);
    expect(await stored(document.id)).toBe('Flush before exit');
  });

  it('exits unsuccessfully when shutdown cannot persist pending changes', async () => {
    const document = await application.store.create('Failed shutdown');
    const server = await processServer(true);
    const client = await connect(document, server.port);
    client.text.insert(0, 'Cannot save');
    await vi.waitFor(() => expect(client.provider.hasUnsyncedChanges).toBe(false));
    expect((await kill(server.child, 'SIGTERM'))[0]).toBe(1);
    dispose(client);
    expect(await stored(document.id)).toBe('');
  });
});
