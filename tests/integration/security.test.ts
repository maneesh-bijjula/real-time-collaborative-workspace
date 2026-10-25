import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { gzipSync } from 'node:zlib';
import { WebSocket } from 'ws';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { Pool } from 'pg';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import { createApplication } from '../../apps/server/src/app.js';
import { readConfig, type ServerConfig } from '../../apps/server/src/config.js';
import type { LogEntry } from '../../apps/server/src/telemetry.js';
import { DatabaseSaveTracker } from '../../apps/web/lib/database-save';
import { CollaborationSession } from '../../apps/web/lib/collaboration-session';
import {
  auth,
  authenticateRaw,
  frame,
  messageType,
  rawClient,
  stateless,
  sync,
} from '../helpers/wire';

const databaseUrl =
  process.env.TEST_DATABASE_URL ||
  'postgres://workspace:workspace-local@localhost:5434/workspace_test';
if (!new URL(databaseUrl).pathname.endsWith('_test'))
  throw new Error('Security tests require a dedicated test database');
const metricsToken = 'metrics-test-secret-' + 'M'.repeat(43);
const base = {
  ...readConfig(),
  host: '127.0.0.1',
  port: 0,
  databaseUrl,
  redisUrl: process.env.TEST_REDIS_URL || 'redis://localhost:6381',
  redisPrefix: 'security:' + randomUUID(),
  metricsToken,
};
type App = Awaited<ReturnType<typeof createApplication>>;
const logs: LogEntry[] = [];
const temporary: App[] = [];
const sockets: WebSocket[] = [];
const clients: {
  doc: Y.Doc;
  provider: HocuspocusProvider;
  tracker: DatabaseSaveTracker;
  session: CollaborationSession;
}[] = [];
let first: App, port: number;
async function application(changes: Partial<ServerConfig> = {}) {
  const app = await createApplication(
    { ...base, ...changes },
    { log: (entry) => logs.push(entry) },
  );
  const port = await app.listen();
  temporary.push(app);
  return { app, port };
}
async function wire(target = port) {
  const c = await rawClient(target);
  sockets.push(c.socket);
  return c;
}
async function editor(document: { id: string; token: string }, target = port) {
  const doc = new Y.Doc();
  const provider = new HocuspocusProvider({
    url: `ws://127.0.0.1:${target}/collaboration`,
    name: document.id,
    token: document.token,
    document: doc,
  });
  const tracker = new DatabaseSaveTracker(doc, provider, () => {}),
    session = new CollaborationSession(provider);
  clients.push({ doc, provider, tracker, session });
  await waitFor(() => expect(provider.synced).toBe(true), { timeout: 5000 });
  return { doc, provider, tracker, text: doc.getText('body') };
}
async function metrics(app = first) {
  return app.telemetry.metrics();
}
async function refused(
  target: number,
  path = '/collaboration',
  headers: Record<string, string> = {},
) {
  return new Promise<number>((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${target}${path}`, { headers });
    sockets.push(socket);
    socket.on('error', () => {});
    socket.on('unexpected-response', (_request, response) => {
      response.resume();
      socket.terminate();
      resolve(response.statusCode!);
    });
    socket.on('open', () => {
      socket.terminate();
      reject(new Error('Unexpected upgrade acceptance'));
    });
  });
}
function waitFor<T>(check: () => T | Promise<T>, options: { timeout?: number } = {}) {
  return vi.waitFor(check, { timeout: 5000, ...options });
}
beforeAll(async () => {
  const running = await application();
  first = running.app;
  port = running.port;
  temporary.pop();
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const c of clients.splice(0)) {
    c.tracker.destroy();
    c.session.destroy();
    c.provider.destroy();
    c.doc.destroy();
  }
  for (const socket of sockets.splice(0)) socket.terminate();
  for (const app of temporary.splice(0)) await app.close();
});
afterAll(async () => {
  await first.close();
});

describe('authorization and hostile protocol traffic', () => {
  it('denies cold and warm documents without leaking content, awareness, or commit checks', async () => {
    const document = await first.store.create('private-title-sentinel');
    for (const warm of [false, true]) {
      const owner = warm ? await editor(document) : undefined;
      owner?.text.insert(0, 'private-content-sentinel');
      if (owner) await waitFor(() => expect(owner.tracker.state).toBe('saved'));
      for (const token of ['', 'x'.repeat(43), (await first.store.create('other')).token]) {
        const c = await wire();
        c.socket.send(auth(document.id, token));
        const attack = new Y.Doc();
        attack.getText('body').insert(0, 'attack-content-sentinel');
        c.socket.send(sync(document.id, 2, Y.encodeStateAsUpdate(attack)));
        c.socket.send(frame(document.id, 3));
        c.socket.send(
          stateless(document.id, { type: 'persistence:check:v1', requestId: randomUUID() }),
        );
        expect(await c.closed).toBe(1008);
        expect(c.messages.every((data) => messageType(data) === 2)).toBe(true);
        expect(Buffer.concat(c.messages).toString()).not.toContain('private-content-sentinel');
        attack.destroy();
      }
      if (owner) expect(owner.text.toString()).toBe('private-content-sentinel');
    }
  });
  it.each([0, 3, 5])(
    'rejects a document switch after authentication (opcode %s)',
    async (opcode) => {
      const a = await first.store.create('a'),
        b = await first.store.create('b');
      const owner = await editor(a);
      owner.text.insert(0, 'unchanged');
      const attacker = await wire();
      await authenticateRaw(attacker, b);
      attacker.socket.send(
        opcode === 0
          ? sync(a.id, 2, new Uint8Array([0, 0]))
          : opcode === 5
            ? stateless(a.id, { type: 'persistence:check:v1', requestId: randomUUID() })
            : frame(a.id, 3),
      );
      expect(await attacker.closed).toBe(1008);
      expect(
        attacker.messages.every((data) => !Buffer.from(data).includes(Buffer.from(a.id))),
      ).toBe(true);
      owner.text.insert(owner.text.length, ' works');
      await waitFor(() => expect(owner.tracker.state).toBe('saved'));
      expect(owner.text.toString()).toBe('unchanged works');
    },
  );
  it('rejects credential replacement on a warm session', async () => {
    const a = await first.store.create('a'),
      b = await first.store.create('b');
    const c = await wire();
    await authenticateRaw(c, a);
    c.socket.send(auth(a.id, b.token));
    expect(await c.closed).toBe(1008);
  });
  it.each(['truncated', 'server_opcode', 'invalid_update', 'bad_awareness', 'text', 'oversized'])(
    'keeps legitimate peers unchanged and usable after %s',
    async (kind) => {
      const document = await first.store.create('safe');
      const owner = await editor(document);
      owner.text.insert(0, 'baseline');
      await waitFor(() => expect(owner.tracker.state).toBe('saved'));
      const before = Y.snapshot(owner.doc);
      const c = await wire();
      await authenticateRaw(c, document);
      const bytes =
        kind === 'truncated'
          ? Uint8Array.of(255)
          : kind === 'server_opcode'
            ? frame(document.id, 6, (e) => encoding.writeVarString(e, 'secret-log-sentinel'))
            : kind === 'invalid_update'
              ? sync(document.id, 2, Uint8Array.of(255))
              : kind === 'bad_awareness'
                ? frame(document.id, 1, (e) => encoding.writeVarUint8Array(e, Uint8Array.of(255)))
                : Buffer.alloc(262145);
      if (kind === 'text') c.socket.send('secret-log-sentinel');
      else c.socket.send(bytes);
      expect([1008, 1009]).toContain(await c.closed);
      expect(Y.equalSnapshots(before, Y.snapshot(owner.doc))).toBe(true);
      owner.text.insert(owner.text.length, ' healthy');
      await waitFor(() => expect(owner.tracker.state).toBe('saved'));
      expect(owner.text.toString()).toBe('baseline healthy');
    },
  );
  it('rejects malformed cursor positions before they reach legitimate browsers', async () => {
    const document = await first.store.create('cursor validation');
    const owner = await editor(document);
    const c = await wire();
    await authenticateRaw(c, document);
    const data = encoding.createEncoder();
    encoding.writeVarUint(data, 1);
    encoding.writeVarUint(data, 4242);
    encoding.writeVarUint(data, 1);
    encoding.writeVarString(
      data,
      JSON.stringify({ cursor: { anchor: 'secret-log-sentinel', head: {} } }),
    );
    c.socket.send(
      frame(document.id, 1, (e) => encoding.writeVarUint8Array(e, encoding.toUint8Array(data))),
    );
    expect(await c.closed).toBe(1008);
    expect(owner.provider.awareness!.getStates().has(4242)).toBe(false);
  });
  it('enforces a staged document size limit before applying an update', async () => {
    const running = await application({ policy: { maxDocumentBytes: 200 } });
    const document = await running.app.store.create('bounded');
    const owner = await editor(document, running.port);
    owner.text.insert(0, 'small');
    await waitFor(() => expect(owner.tracker.state).toBe('saved'));
    const c = await wire(running.port);
    await authenticateRaw(c, document);
    const huge = new Y.Doc();
    huge.getText('body').insert(0, 'x'.repeat(1000));
    c.socket.send(sync(document.id, 2, Y.encodeStateAsUpdate(huge)));
    expect(await c.closed).toBe(1008);
    expect(owner.text.toString()).toBe('small');
    huge.destroy();
    owner.text.insert(0, 'still ');
    await waitFor(() => expect(owner.tracker.state).toBe('saved'));
  });
  it('serializes simultaneous updates at the local document admission ceiling', async () => {
    const running = await application({ policy: { maxDocumentBytes: 200 } });
    const document = await running.app.store.create('concurrent limit');
    const owner = await editor(document, running.port);
    const a = await wire(running.port),
      b = await wire(running.port);
    await authenticateRaw(a, document);
    await authenticateRaw(b, document);
    const updates = [new Y.Doc(), new Y.Doc()];
    updates.forEach((doc, index) => doc.getText('body').insert(0, (index ? 'b' : 'a').repeat(120)));
    a.socket.send(sync(document.id, 2, Y.encodeStateAsUpdate(updates[0]!)));
    b.socket.send(sync(document.id, 2, Y.encodeStateAsUpdate(updates[1]!)));
    await waitFor(() =>
      expect(
        [a.socket, b.socket].filter((socket) => socket.readyState === WebSocket.CLOSED),
      ).toHaveLength(1),
    );
    expect(owner.text.length).toBe(120);
    await waitFor(() => expect(owner.tracker.state).toBe('saved'));
    updates.forEach((doc) => doc.destroy());
  });
  it('rejects unapproved origins, query credentials, and upgrade paths', async () => {
    expect(await refused(port, '/wrong')).toBe(403);
    expect(await refused(port, '/collaboration?token=secret-log-sentinel')).toBe(403);
    expect(await refused(port, '/collaboration', { Origin: 'https://attacker.invalid' })).toBe(403);
    expect(
      (
        await fetch(`http://127.0.0.1:${port}/api/documents`, {
          method: 'POST',
          headers: { Origin: 'https://attacker.invalid', 'Content-Type': 'application/json' },
          body: '{"title":"forbidden"}',
        })
      ).status,
    ).toBe(403);
  });
  it('bounds HTTP bodies and disables request decompression', async () => {
    for (const [body, headers, status] of [
      [JSON.stringify({ title: 'x'.repeat(20000) }), {}, 413],
      [gzipSync('{"title":"compressed"}'), { 'Content-Encoding': 'gzip' }, 415],
    ] as const) {
      const response = await fetch(`http://127.0.0.1:${port}/api/documents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body,
      });
      expect(response.status).toBe(status);
    }
  });
  it('never includes capabilities, document contents, titles, or malformed payloads in logs/metrics', async () => {
    const telemetry = JSON.stringify(logs) + (await metrics());
    for (const secret of [
      metricsToken,
      'private-title-sentinel',
      'private-content-sentinel',
      'attack-content-sentinel',
      'secret-log-sentinel',
    ])
      expect(telemetry).not.toContain(secret);
    expect(
      logs.every((entry) =>
        ['time', 'level', 'event', 'reason'].every((key) => key in entry || key === 'reason'),
      ),
    ).toBe(true);
  });
});

describe('per-instance resource policy', () => {
  it('caps physical sockets, releases admission on close, and bounds idle authentication', async () => {
    const running = await application({ policy: { maxSockets: 1, authenticationTimeoutMs: 500 } });
    const first = await wire(running.port);
    expect(await refused(running.port)).toBe(503);
    expect(await first.closed).toBe(1008);
    await waitFor(async () =>
      expect(await metrics(running.app)).toContain('commonplace_sockets 0'),
    );
    const document = await running.app.store.create('allowed');
    const c = await wire(running.port);
    await authenticateRaw(c, document);
  });
  it('caps per-IP sockets independently of the overall socket ceiling', async () => {
    const running = await application({ policy: { maxSockets: 4, maxSocketsPerIp: 1 } });
    await wire(running.port);
    expect(await refused(running.port)).toBe(503);
  });
  it('caps open documents and per-document grants without leaking reservations', async () => {
    const running = await application({ policy: { maxDocuments: 1, maxDocumentClients: 1 } });
    const a = await running.app.store.create('a'),
      b = await running.app.store.create('b');
    const owner = await editor(a, running.port);
    for (const document of [a, b]) {
      const c = await wire(running.port);
      c.socket.send(auth(document.id, document.token));
      expect(await c.closed).toBe(1013);
    }
    owner.text.insert(0, 'owner healthy');
    await waitFor(() => expect(owner.tracker.state).toBe('saved'));
    expect(await metrics(running.app)).toContain('reason="document_capacity"');
  });
  it('bounds concurrent authentication and cleans up a query that finishes after socket timeout', async () => {
    const running = await application({
      policy: { maxAuthenticating: 1, authenticationTimeoutMs: 500 },
    });
    const document = await running.app.store.create('auth');
    const original = running.app.store.authorize.bind(running.app.store);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(running.app.store, 'authorize').mockImplementation(async (...args) => {
      await blocked;
      return original(...args);
    });
    const a = await wire(running.port);
    a.socket.send(auth(document.id, document.token));
    await waitFor(async () =>
      expect(await metrics(running.app)).toContain('commonplace_authenticating 1'),
    );
    const b = await wire(running.port);
    b.socket.send(auth(document.id, document.token));
    expect(await b.closed).toBe(1013);
    expect(await a.closed).toBe(1013);
    release();
    await waitFor(async () =>
      expect(await metrics(running.app)).toContain('commonplace_authenticating 0'),
    );
    expect(running.app.collaboration.getDocumentsCount()).toBe(0);
  });
  it.each(['message_rate', 'queue_capacity', 'stateless_rate'])(
    'bounds %s while another peer keeps working',
    async (reason) => {
      const policy =
        reason === 'message_rate'
          ? { messageBurst: 6, messagesPerSecond: 1 }
          : reason === 'queue_capacity'
            ? { maxQueueMessages: 3 }
            : { statelessBurst: 2, statelessPerSecond: 1 };
      const running = await application({ policy });
      const document = await running.app.store.create('flood');
      const c = await wire(running.port);
      await authenticateRaw(c, document);
      if (reason === 'queue_capacity') {
        let release!: () => void;
        const blocked = new Promise<void>((resolve) => {
          release = resolve;
        });
        const original = running.app.store.load.bind(running.app.store);
        vi.spyOn(running.app.store, 'load').mockImplementation(async (...args) => {
          await blocked;
          return original(...args);
        });
        c.socket.send(
          stateless(document.id, { type: 'persistence:check:v1', requestId: randomUUID() }),
        );
        for (let i = 0; i < 10; i++) c.socket.send(frame(document.id, 3));
        expect(await c.closed).toBe(1008);
        release();
      } else {
        for (let i = 0; i < 20; i++)
          c.socket.send(
            reason === 'stateless_rate'
              ? stateless(document.id, { type: 'persistence:check:v1', requestId: randomUUID() })
              : frame(document.id, 3),
          );
        expect(await c.closed).toBe(1008);
      }
      await waitFor(async () =>
        expect(await metrics(running.app)).toContain('commonplace_queued_bytes 0'),
      );
      expect(await metrics(running.app)).toContain(`reason="${reason}"`);
      vi.restoreAllMocks();
      // A healthy peer on another instance demonstrates that rejected traffic
      // has not damaged the shared CRDT or its persisted state.
      const healthy = await editor(document);
      healthy.text.insert(0, 'healthy');
      await waitFor(() => expect(healthy.tracker.state).toBe('saved'));
    },
  );
  it.each(['per_socket_queue', 'global_queue', 'input_bytes'])(
    'enforces the %s byte ceiling before allocating protocol state',
    async (boundary) => {
      const policy =
        boundary === 'per_socket_queue'
          ? { maxQueueBytes: 32 }
          : boundary === 'global_queue'
            ? { maxTotalQueueBytes: 32 }
            : { byteBurst: 32 };
      const running = await application({ policy });
      const document = await running.app.store.create('byte ceiling');
      const c = await wire(running.port);
      c.socket.send(auth(document.id, document.token));
      expect(await c.closed).toBe(1008);
      expect(await metrics(running.app)).toContain('commonplace_queued_bytes 0');
      expect(running.app.collaboration.getDocumentsCount()).toBe(0);
    },
  );
  it('limits upgrade and authentication attempts before unbounded work can start', async () => {
    const upgrade = await application({ policy: { upgradesPerMinute: 1 } });
    const firstSocket = await wire(upgrade.port);
    firstSocket.socket.terminate();
    expect(await refused(upgrade.port)).toBe(429);
    const authentication = await application({ policy: { authenticationPerMinute: 1 } });
    const document = await authentication.app.store.create('auth bucket');
    for (let i = 0; i < 2; i++) {
      const c = await wire(authentication.port);
      c.socket.send(auth(document.id, 'x'.repeat(43)));
      expect(await c.closed).toBe(1008);
    }
    expect(await metrics(authentication.app)).toContain('reason="authentication_capacity"');
  });
  it('applies API buckets per instance and ignores untrusted spoofed IPs', async () => {
    const a = await application({ policy: { apiPerMinute: 2 } }),
      b = await application({ policy: { apiPerMinute: 2 } });
    const document = await a.app.store.create('limited');
    for (let i = 0; i < 3; i++)
      expect(
        (
          await fetch(`http://127.0.0.1:${a.port}/api/documents/${document.id}`, {
            headers: {
              Authorization: `Bearer ${document.token}`,
              'X-Forwarded-For': `203.0.113.${i}`,
            },
          })
        ).status,
      ).toBe(i < 2 ? 200 : 429);
    expect(
      (
        await fetch(`http://127.0.0.1:${b.port}/api/documents/${document.id}`, {
          headers: { Authorization: `Bearer ${document.token}` },
        })
      ).status,
    ).toBe(200);
  });
  it('uses an explicitly trusted, overwritten proxy identity for API and socket limits', async () => {
    const running = await application({
      trustedProxyCidrs: ['127.0.0.1/32'],
      policy: { apiPerMinute: 1, upgradesPerMinute: 1 },
    });
    const document = await running.app.store.create('proxy');
    const target = `http://127.0.0.1:${running.port}/api/documents/${document.id}`;
    for (const ip of ['203.0.113.1', '203.0.113.2'])
      expect(
        (
          await fetch(target, {
            headers: { Authorization: `Bearer ${document.token}`, 'X-Forwarded-For': ip },
          })
        ).status,
      ).toBe(200);
    expect(
      (await fetch(target, { headers: { 'X-Forwarded-For': '203.0.113.1, 127.0.0.1' } })).status,
    ).toBe(400);
    expect(await refused(running.port, '/collaboration', { 'X-Forwarded-For': 'bad' })).toBe(400);
  });
  it('terminates a slow consumer before sending a response that exceeds outbound capacity', async () => {
    const running = await application({ policy: { maxOutboundBytes: 1000 } });
    const document = await running.app.store.create('large');
    const doc = new Y.Doc();
    doc.getText('body').insert(0, 'x'.repeat(4000));
    await running.app.store.store(document.id, Y.encodeStateAsUpdate(doc));
    doc.destroy();
    const c = await wire(running.port);
    c.socket.send(auth(document.id, document.token));
    c.socket.send(sync(document.id, 0, Uint8Array.of(0)));
    expect(await c.closed).toBe(1013);
    expect(await metrics(running.app)).toContain('reason="backpressure"');
  });
});

describe('operational truth and protected telemetry', () => {
  it('protects metrics separately from document capabilities and disables them without configuration', async () => {
    const target = `http://127.0.0.1:${port}/metrics`;
    const document = await first.store.create('metrics');
    for (const token of ['', document.token])
      expect((await fetch(target, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(
        401,
      );
    const response = await fetch(target, { headers: { Authorization: `Bearer ${metricsToken}` } });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(await response.text()).toContain('commonplace_ready');
    const running = await application({ metricsToken: undefined });
    expect((await fetch(`http://127.0.0.1:${running.port}/metrics`)).status).toBe(404);
  });
  it.each(['authorization', 'document_load'])(
    'automatically recovers a transient %s failure without denying a valid capability',
    async (failure) => {
      const running = await application();
      const document = await running.app.store.create('transient recovery');
      let allow = false;
      if (failure === 'authorization') {
        const original = running.app.store.authorize.bind(running.app.store);
        vi.spyOn(running.app.store, 'authorize').mockImplementation(async (...args) => {
          if (!allow) throw new Error('database-secret-sentinel');
          return original(...args);
        });
      } else {
        const original = running.app.store.load.bind(running.app.store);
        vi.spyOn(running.app.store, 'load').mockImplementation(async (...args) => {
          if (!allow) throw new Error('database-secret-sentinel');
          return original(...args);
        });
      }
      const connecting = editor(document, running.port);
      try {
        await waitFor(async () =>
          expect(await metrics(running.app)).toMatch(
            /commonplace_socket_disconnects_total\{kind="transport"\} [1-9]/,
          ),
        );
      } finally {
        allow = true;
      }
      const owner = await connecting;
      owner.text.insert(0, 'recovered');
      await waitFor(() => expect(owner.tracker.state).toBe('saved'));
      expect(JSON.stringify(logs) + (await metrics(running.app))).not.toContain(
        'database-secret-sentinel',
      );
    },
  );
  it('separates liveness from readiness during subscriber failure and exposes recovery', async () => {
    const redis = first.synchronization;
    redis.sub.disconnect();
    try {
      expect((await fetch(`http://127.0.0.1:${port}/live`)).status).toBe(200);
      expect((await fetch(`http://127.0.0.1:${port}/ready`)).status).toBe(503);
      expect(await metrics()).toContain(
        'commonplace_dependency_up{dependency="redis_subscriber"} 0',
      );
    } finally {
      await redis.sub.connect();
      await redis.reconcileNow();
    }
    await waitFor(async () =>
      expect((await fetch(`http://127.0.0.1:${port}/ready`)).status).toBe(200),
    );
  });
  it('detects an unresponsive Redis command even while its TCP status says ready', async () => {
    let release!: () => void;
    const blocked = new Promise<string>((resolve) => {
      release = () => resolve('PONG');
    });
    vi.spyOn(first.synchronization.pub, 'ping').mockImplementation(() => blocked);
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect((await fetch(`http://127.0.0.1:${port}/ready`)).status).toBe(503);
      expect((await fetch(`http://127.0.0.1:${port}/live`)).status).toBe(200);
      const body = await metrics();
      expect(body).toContain('commonplace_dependency_up{dependency="postgres"} 1');
      expect(body).toContain('commonplace_dependency_up{dependency="redis_publisher"} 0');
    } finally {
      release();
      vi.restoreAllMocks();
    }
    await waitFor(async () =>
      expect((await fetch(`http://127.0.0.1:${port}/ready`)).status).toBe(200),
    );
  });
  it('reports persistence debt, failure and recovery without false saved/readiness during a real PostgreSQL outage', async () => {
    const document = await first.store.create('outage');
    const owner = await editor(document);
    owner.text.insert(0, 'committed');
    await waitFor(() => expect(owner.tracker.state).toBe('saved'));
    const adminUrl = new URL(databaseUrl),
      dbName = adminUrl.pathname.slice(1);
    adminUrl.pathname = '/postgres';
    if (!/^workspace\w*_test$/.test(dbName))
      throw new Error('Connection failure injection requires a workspace test database');
    const admin = new Pool({ connectionString: adminUrl.toString() });
    try {
      await admin.query(`ALTER DATABASE "${dbName}" ALLOW_CONNECTIONS false`);
      await admin.query(
        'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1',
        [dbName],
      );
      owner.text.insert(owner.text.length, ' pending');
      await waitFor(() => expect(owner.tracker.state).not.toBe('saved'));
      await waitFor(async () =>
        expect((await fetch(`http://127.0.0.1:${port}/ready`)).status).toBe(503),
      );
      expect((await fetch(`http://127.0.0.1:${port}/live`)).status).toBe(200);
      await waitFor(async () => {
        const body = await metrics();
        expect(body).toContain('commonplace_persistence_failures 1');
        expect(body).toContain('commonplace_dirty_documents 1');
        expect(body).toContain('commonplace_dependency_up{dependency="postgres"} 0');
      });
    } finally {
      await admin.query(`ALTER DATABASE "${dbName}" ALLOW_CONNECTIONS true`);
      await admin.end();
    }
    await waitFor(() => expect(owner.tracker.state).toBe('saved'), { timeout: 10000 });
    await waitFor(
      async () => expect((await fetch(`http://127.0.0.1:${port}/ready`)).status).toBe(200),
      { timeout: 5000 },
    );
    const body = await metrics();
    expect(body).toContain('commonplace_dirty_documents 0');
    expect(body).toContain('commonplace_persistence_failures 0');
    expect(body).toMatch(/commonplace_durable_save_seconds_count [1-9]/);
    expect(logs.some((entry) => entry.event === 'persistence_failed')).toBe(true);
    expect(logs.some((entry) => entry.event === 'persistence_recovered')).toBe(true);
  }, 20000);
  it('marks stale persistence debt unready even when a write has not yet failed', async () => {
    const running = await application({ policy: { maxDirtyAgeSeconds: 1 } });
    const document = await running.app.store.create('stalled');
    const owner = await editor(document, running.port);
    const original = running.app.store.store.bind(running.app.store);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(running.app.store, 'store').mockImplementation(async (...args) => {
      await blocked;
      return original(...args);
    });
    try {
      owner.text.insert(0, 'stalled revision');
      await waitFor(
        async () =>
          expect((await fetch(`http://127.0.0.1:${running.port}/ready`)).status).toBe(503),
        { timeout: 3000 },
      );
      expect(running.app.persistence.oldestDirtySeconds).toBeGreaterThanOrEqual(1);
      expect(owner.tracker.state).not.toBe('saved');
    } finally {
      release();
    }
    await waitFor(() => expect(owner.tracker.state).toBe('saved'), { timeout: 5000 });
    expect((await fetch(`http://127.0.0.1:${running.port}/ready`)).status).toBe(200);
  });
  it('counts completed in-page reconnects after authentication, without identity labels', async () => {
    const document = await first.store.create('reconnect metric');
    const owner = await editor(document);
    owner.provider.disconnect();
    await waitFor(() =>
      expect(owner.provider.configuration.websocketProvider.status).toBe('disconnected'),
    );
    await owner.provider.connect();
    await waitFor(() => expect(owner.provider.synced).toBe(true));
    await waitFor(async () =>
      expect(await metrics()).toMatch(/commonplace_reconnects_total [1-9]/),
    );
  });
});
