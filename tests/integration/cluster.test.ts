import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { Pool } from 'pg';
import * as Y from 'yjs';
import { DatabaseSaveTracker } from '../../apps/web/lib/database-save';
import {
  auth,
  authenticateRaw,
  frame,
  messageType,
  rawClient,
  stateless,
  sync,
} from '../helpers/wire';
import { CollaborationSession } from '../../apps/web/lib/collaboration-session';

const databaseUrl =
  process.env.TEST_DATABASE_URL ||
  'postgres://workspace:workspace-local@localhost:5434/workspace_test';
const redisUrl = process.env.TEST_REDIS_URL || 'redis://localhost:6381';
if (!new URL(databaseUrl).pathname.endsWith('_test'))
  throw new Error('Cluster tests require an isolated test database');
const prefix = 'cluster-test:' + randomUUID();
const pool = new Pool({ connectionString: databaseUrl });
type Node = { child: ChildProcess; port: number; pid: number; errors: () => string };
type Created = { id: string; token: string };
type Client = {
  doc: Y.Doc;
  provider: HocuspocusProvider;
  tracker: DatabaseSaveTracker;
  session: CollaborationSession;
  text: Y.Text;
};
const nodes: Node[] = [];
const clients: Client[] = [];
const timeout = 10000;

async function start(namespace = prefix): Promise<Node> {
  const child = fork(
    fileURLToPath(new URL('../fixtures/collaboration-server.ts', import.meta.url)),
    [],
    {
      execArgv: ['--import', 'tsx'],
      env: {
        ...process.env,
        HOST: '127.0.0.1',
        PORT: '0',
        DATABASE_URL: databaseUrl,
        REDIS_URL: redisUrl,
        REDIS_PREFIX: namespace,
        REDIS_RECONCILE_INTERVAL_MS: '500',
        ALLOWED_ORIGINS: 'http://localhost:3000',
      },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    },
  );
  let errors = '';
  child.stderr!.on('data', (data) => {
    errors = (errors + data.toString()).slice(-4000);
  });
  const startup = new AbortController();
  const ready = once(child, 'message', { signal: startup.signal });
  const exit = once(child, 'exit', { signal: startup.signal }).then(() => {
    throw new Error('Fixture exited early: ' + errors);
  });
  const limit = delay(timeout, undefined, { signal: startup.signal }).then(() => {
    throw new Error('Fixture startup timed out: ' + errors);
  });
  try {
    const [message] = (await Promise.race([ready, exit, limit])) as [{ port: number; pid: number }];
    const node = { child, port: message.port, pid: message.pid, errors: () => errors };
    nodes.push(node);
    return node;
  } catch (error) {
    child.kill('SIGKILL');
    throw error;
  } finally {
    startup.abort();
  }
}
async function command(node: Node, name: string): Promise<{ completedRepairs: number }> {
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Fixture command timed out: ' + name + '\n' + node.errors()));
    }, timeout);
    const listener = (message: {
      id: string;
      error?: string;
      result: { completedRepairs: number };
    }) => {
      if (message.id !== id) return;
      cleanup();
      if (message.error) reject(new Error(message.error));
      else resolve(message.result);
    };
    function cleanup() {
      clearTimeout(timer);
      node.child.off('message', listener);
    }
    node.child.on('message', listener);
    node.child.send({ id, command: name });
  });
}
async function stop(node: Node, signal: NodeJS.Signals = 'SIGTERM') {
  if (node.child.exitCode !== null || node.child.signalCode !== null) return;
  const exit = once(node.child, 'exit');
  node.child.kill(signal);
  const timer = setTimeout(() => node.child.kill('SIGKILL'), 5000).unref();
  await exit;
  clearTimeout(timer);
}
async function create(): Promise<Created> {
  const response = await fetch(`http://127.0.0.1:${nodes[0]!.port}/api/documents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Four-process recovery test' }),
  });
  expect(response.status).toBe(201);
  return response.json();
}
async function connect(document: Created, node: Node, doc = new Y.Doc()): Promise<Client> {
  const provider = new HocuspocusProvider({
    url: `ws://127.0.0.1:${node.port}/collaboration`,
    name: document.id,
    token: document.token,
    document: doc,
  });
  const tracker = new DatabaseSaveTracker(doc, provider, () => {});
  const session = new CollaborationSession(provider);
  const client = { doc, provider, tracker, session, text: doc.getText('body') };
  clients.push(client);
  await vi.waitFor(() => expect(provider.synced && !provider.hasUnsyncedChanges).toBe(true), {
    timeout,
  });
  return client;
}
function detach(client: Client, destroyDocument = true) {
  client.tracker.destroy();
  client.session.destroy();
  client.provider.destroy();
  if (destroyDocument) client.doc.destroy();
  const index = clients.indexOf(client);
  if (index >= 0) clients.splice(index, 1);
}
async function converge(group: Client[], bound = timeout) {
  await vi.waitFor(
    () => {
      const baseline = group[0]!.doc;
      for (const client of group) {
        expect(Y.equalSnapshots(Y.snapshot(client.doc), Y.snapshot(baseline))).toBe(true);
        expect(client.text.toDelta()).toEqual(group[0]!.text.toDelta());
        expect(client.doc.getXmlFragment('default').toString()).toBe(
          baseline.getXmlFragment('default').toString(),
        );
      }
    },
    { timeout: bound },
  );
}
async function durable(group: Client[]) {
  await vi.waitFor(() => group.forEach((client) => expect(client.tracker.state).toBe('saved')), {
    timeout,
  });
}
function people(client: Client) {
  return [...client.provider.awareness!.getStates().values()]
    .flatMap((state) => (state.user?.name ? [state.user.name] : []))
    .sort();
}

beforeAll(async () => {
  for (let i = 0; i < 4; i++) await start();
}, 45000);
afterEach(async () => {
  for (const client of [...clients]) detach(client);
  await Promise.all(
    nodes
      .filter((node) => node.child.exitCode === null && node.child.signalCode === null)
      .map(async (node) => {
        await command(node, 'resumePersistence');
        const status = (await command(node, 'inspect')) as unknown as {
          publisher: string;
          subscriber: string;
        };
        if (status.publisher === 'end') await command(node, 'reconnectRedis');
        else if (status.subscriber === 'end') await command(node, 'reconnectSubscriber');
      }),
  );
});
afterAll(async () => {
  await Promise.all(nodes.map((node) => stop(node)));
  await pool.end();
}, 15000);

describe('four independent Node processes', () => {
  it('exchanges concurrent inserts, deletes, formatting, rich-text nodes, and presence', async () => {
    expect(new Set(nodes.slice(0, 4).map((node) => node.pid)).size).toBe(4);
    expect(nodes.every((node) => node.pid !== process.pid)).toBe(true);
    const document = await create();
    const group = await Promise.all(nodes.slice(0, 4).map((node) => connect(document, node)));
    group.forEach((client, i) => {
      client.provider.setAwarenessField('user', { name: 'Editor ' + i, color: '#7856b6' });
      client.text.insert(0, `editor-${i};`);
      const paragraph = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      client.doc.getXmlFragment('default').insert(0, [paragraph]);
      paragraph.insert(0, [text]);
      text.insert(0, `paragraph-${i}`);
      text.format(0, text.length, { bold: {} });
    });
    await converge(group);
    group[0]!.text.delete(0, 2);
    group[1]!.text.format(0, 3, { bold: true });
    await converge(group);
    await durable(group);
    await vi.waitFor(
      () =>
        group.forEach((client) =>
          expect(people(client)).toEqual(['Editor 0', 'Editor 1', 'Editor 2', 'Editor 3']),
        ),
      { timeout },
    );
    expect(group[0]!.doc.getXmlFragment('default').toString()).toContain('<bold>');
  });

  it('repairs the missed-subscriber regression without any post-reconnect edit', async () => {
    const document = await create();
    const a = await connect(document, nodes[0]!),
      b = await connect(document, nodes[1]!);
    a.text.insert(0, 'abcdef');
    await converge([a, b]);
    await durable([a, b]);
    await command(nodes[1]!, 'disconnectSubscriber');
    expect((await fetch(`http://127.0.0.1:${nodes[1]!.port}/health`)).status).toBe(503);
    a.text.delete(1, 2);
    a.text.format(0, 2, { italic: true });
    a.text.insert(4, ' missed');
    a.provider.setAwarenessField('user', { name: 'Recovered presence', color: '#7856b6' });
    await delay(200);
    expect(b.text.toString()).toBe('abcdef');
    await command(nodes[1]!, 'reconnectSubscriber');
    expect(
      (await fetch(`http://127.0.0.1:${nodes[1]!.port}/health`)).status,
      JSON.stringify(await command(nodes[1]!, 'inspect')),
    ).toBe(200);
    await converge([a, b]);
    await durable([a, b]);
    expect(b.text.toString()).toBe('adef missed');
    await vi.waitFor(() => expect(people(b)).toContain('Recovered presence'), { timeout });
  });

  it('merges divergent edits after all Redis transports disconnect and reconnect', async () => {
    const document = await create();
    const group = await Promise.all(nodes.slice(0, 4).map((node) => connect(document, node)));
    group[0]!.text.insert(0, 'abcdef');
    await converge(group);
    await durable(group);
    await Promise.all(nodes.slice(0, 4).map((node) => command(node, 'disconnectRedis')));
    group.forEach((client, i) => {
      client.text.delete(0, 1);
      client.text.insert(0, `partition-${i};`);
      client.text.format(0, 3, { bold: true });
    });
    await delay(300);
    await Promise.all(nodes.slice(0, 4).map((node) => command(node, 'reconnectRedis')));
    await converge(group);
    await durable(group);
    for (let i = 0; i < 4; i++) expect(group[0]!.text.toString()).toContain(`partition-${i};`);
  });

  it('merges offline changes when the same client document reconnects on another instance', async () => {
    const document = await create();
    let a = await connect(document, nodes[0]!);
    const b = await connect(document, nodes[1]!);
    a.text.insert(0, 'abcdef');
    await converge([a, b]);
    a.provider.disconnect();
    await vi.waitFor(() =>
      expect(a.provider.configuration.websocketProvider.status).toBe('disconnected'),
    );
    a.text.delete(1, 2);
    a.text.insert(a.text.length, ' offline');
    a.text.format(0, 2, { italic: true });
    b.text.insert(0, 'online;');
    const local = a.doc;
    detach(a, false);
    a = await connect(document, nodes[3]!, local);
    await converge([a, b]);
    await durable([a, b]);
    expect(a.text.toString()).toContain('online;');
    expect(a.text.toString()).toContain('offline');
    expect(a.text.toString()).not.toContain('abcdef');
  });

  it('survives repeated socket disconnects without duplicate content or stale participants', async () => {
    const document = await create();
    const a = await connect(document, nodes[0]!),
      b = await connect(document, nodes[2]!);
    a.provider.setAwarenessField('user', { name: 'Repeated editor', color: '#7856b6' });
    b.provider.setAwarenessField('user', { name: 'Observer', color: '#277c73' });
    await vi.waitFor(() => expect(people(b)).toEqual(['Observer', 'Repeated editor']), { timeout });
    for (let i = 0; i < 4; i++) {
      a.provider.disconnect();
      await vi.waitFor(() =>
        expect(a.provider.configuration.websocketProvider.status).toBe('disconnected'),
      );
      await vi.waitFor(() => expect(people(b)).not.toContain('Repeated editor'), { timeout });
      a.text.insert(a.text.length, `round-${i};`);
      await a.provider.connect();
      await converge([a, b]);
      await vi.waitFor(
        () => {
          expect(people(a)).toEqual(['Observer', 'Repeated editor']);
          expect(people(b)).toEqual(['Observer', 'Repeated editor']);
        },
        { timeout },
      );
    }
    await durable([a, b]);
    expect(b.text.toString()).toBe('round-0;round-1;round-2;round-3;');
  });

  it('automatically reconnects after server-initiated connection closure', async () => {
    const document = await create();
    const a = await connect(document, nodes[0]!),
      b = await connect(document, nodes[1]!);
    a.text.insert(0, 'automatic');
    await converge([a, b]);
    let disconnected = false;
    a.provider.on('status', ({ status }: { status: string }) => {
      if (status === 'disconnected') disconnected = true;
    });
    await command(nodes[0]!, 'closeClients');
    await vi.waitFor(() => expect(disconnected).toBe(true), { timeout });
    await vi.waitFor(() => expect(a.provider.synced && a.provider.isAuthenticated).toBe(true), {
      timeout,
    });
    a.text.insert(a.text.length, ' recovery');
    await converge([a, b]);
    await durable([a, b]);
    expect(b.text.toString()).toBe('automatic recovery');
  });

  it('cleans up a missed presence removal within the documented 45-second expiry bound', async () => {
    const document = await create();
    const a = await connect(document, nodes[0]!),
      b = await connect(document, nodes[1]!);
    a.provider.setAwarenessField('user', { name: 'Departed editor', color: '#7856b6' });
    await vi.waitFor(() => expect(people(b)).toContain('Departed editor'), { timeout });
    await command(nodes[1]!, 'disconnectSubscriber');
    detach(a);
    await delay(200);
    await command(nodes[1]!, 'reconnectSubscriber');
    await vi.waitFor(() => expect(people(b)).not.toContain('Departed editor'), { timeout: 45000 });
  }, 55000);

  it('preserves committed changes after SIGKILL and restores the fourth process from PostgreSQL', async () => {
    const document = await create();
    const group = await Promise.all(nodes.slice(0, 4).map((node) => connect(document, node)));
    group.forEach((client, i) => client.text.insert(0, `node-${i};`));
    await converge(group);
    await durable(group);
    const expected = group[0]!.text.toDelta();
    await stop(nodes[3]!, 'SIGKILL');
    detach(group[3]!);
    const restarted = await start();
    nodes[3] = restarted;
    nodes.pop();
    const fresh = await connect(document, restarted);
    await converge([...group.slice(0, 3), fresh]);
    await durable([fresh]);
    expect(fresh.text.toDelta()).toEqual(expected);
  });

  it('denies missing, wrong and cross-document credentials on every warm instance', async () => {
    const a = await create(),
      b = await create();
    const group = await Promise.all(nodes.slice(0, 4).map((node) => connect(a, node)));
    group[0]!.text.insert(0, 'private cluster content');
    group[0]!.provider.setAwarenessField('user', { name: 'Private participant', color: '#7856b6' });
    await converge(group);
    await durable(group);
    for (const node of nodes.slice(0, 4)) {
      for (const token of ['', 'x'.repeat(43), b.token]) {
        for (const method of ['GET', 'PATCH']) {
          const response = await fetch(`http://127.0.0.1:${node.port}/api/documents/${a.id}`, {
            method,
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            ...(method === 'PATCH'
              ? { body: JSON.stringify({ title: 'unauthorized rename' }) }
              : {}),
          });
          expect(response.status).toBe(404);
          expect(await response.text()).not.toContain('private cluster content');
        }
        const attacker = await rawClient(node.port);
        try {
          attacker.socket.send(auth(a.id, token));
          attacker.socket.send(sync(a.id, 2, Uint8Array.of(0, 0)));
          attacker.socket.send(frame(a.id, 3));
          attacker.socket.send(
            stateless(a.id, { type: 'persistence:check:v1', requestId: randomUUID() }),
          );
          expect(await attacker.closed).toBe(1008);
          expect(attacker.messages.every((data) => messageType(data) === 2)).toBe(true);
        } finally {
          attacker.socket.terminate();
        }
      }
      const switched = await rawClient(node.port);
      try {
        await authenticateRaw(switched, b);
        switched.socket.send(frame(a.id, 3));
        expect(await switched.closed).toBe(1008);
        expect(switched.messages.every((data) => !data.includes(Buffer.from(a.id)))).toBe(true);
      } finally {
        switched.socket.terminate();
      }
      const metadata = await fetch(`http://127.0.0.1:${node.port}/api/documents/${a.id}`, {
        headers: { Authorization: `Bearer ${a.token}` },
      });
      expect((await metadata.json()).title).toBe('Four-process recovery test');
    }
    group[1]!.text.insert(group[1]!.text.length, ' still healthy');
    await converge(group);
    await durable(group);
    expect(group[0]!.text.toString()).toBe('private cluster content still healthy');
  }, 30000);

  it('isolates different Redis namespaces while their uncommitted documents are open', async () => {
    const isolated = await start(prefix + ':isolated');
    try {
      const document = await create();
      const a = await connect(document, nodes[0]!),
        b = await connect(document, isolated);
      await command(nodes[0]!, 'pausePersistence');
      a.text.insert(0, 'not a Redis peer');
      await delay(1600);
      expect(b.text.toString()).toBe('');
      expect(a.tracker.state).not.toBe('saved');
      await command(nodes[0]!, 'resumePersistence');
      // Shared PostgreSQL is still shared durable storage; REDIS_PREFIX only
      // isolates Pub/Sub transport, not database authorization or tenancy.
      await durable([a]);
      detach(a);
      detach(b);
    } finally {
      await stop(isolated);
    }
  });
});
