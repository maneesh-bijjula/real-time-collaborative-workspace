import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import cors from 'cors';
import express, { type ErrorRequestHandler } from 'express';
import { Pool } from 'pg';
import { Server } from '@hocuspocus/server';
import { ZodError } from 'zod';
import type { ServerConfig } from './config.js';
import { createDocumentBody, documentId, DocumentStore } from './documents.js';
import { migrate } from './migrate.js';
import { DurableDatabase } from './persistence.js';
import { SynchronizationRedis } from './synchronization.js';
import { Telemetry, type LogSink } from './telemetry.js';
import { AdmissionLimits, clientIp, ipLimitKey, policySchema, trustedProxyList } from './policy.js';
import { CollaborationTransport, type SessionContext } from './transport.js';
import { Readiness } from './readiness.js';

export async function createApplication(
  config: ServerConfig,
  options: { shutdownTimeoutMs?: number; log?: LogSink } = {},
) {
  const policy = policySchema.parse(config.policy || {});
  const limits = new AdmissionLimits(policy.maxLimiterKeys);
  const trusted = trustedProxyList(config.trustedProxyCidrs || []);
  const redis = new URL(config.redisUrl);
  const telemetry = new Telemetry(options.log);
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: 10,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
    query_timeout: 10000,
  });
  pool.on('error', () => telemetry.log('dependency_failed', 'postgres'));
  try {
    await migrate(pool);
  } catch {
    await pool.end();
    telemetry.close();
    throw new Error('Database initialization failed');
  }
  const store = new DocumentStore(pool);
  const persistence = new DurableDatabase(store, telemetry);
  const app = express();
  const redisExtension = new SynchronizationRedis(
    {
      host: redis.hostname,
      port: Number(redis.port || 6379),
      prefix: config.redisPrefix,
      options: {
        username: redis.username ? decodeURIComponent(redis.username) : undefined,
        password: redis.password ? decodeURIComponent(redis.password) : undefined,
        db: Number(redis.pathname.slice(1) || 0),
        ...(redis.protocol === 'rediss:' ? { tls: {} } : {}),
        connectTimeout: 5000,
        maxRetriesPerRequest: 1,
      },
    },
    store,
    config.redisReconcileIntervalMs,
    telemetry,
  );
  let transport: CollaborationTransport;
  const collaborationServer = new Server<SessionContext>({
    port: config.port,
    address: config.host,
    stopOnSignals: false,
    // The onUpgrade hook delegates to the bounded, serial transport below.
    maxUnauthenticatedQueueSize: policy.maxQueueBytes,
    maxUnauthenticatedQueueMessages: policy.maxQueueMessages,
    maxPendingDocuments: 1,
    name: randomUUID(),
    quiet: true,
    debounce: 300,
    maxDebounce: 1000,
    extensions: [redisExtension, persistence],
    async onAuthenticate({ documentName, token, context }) {
      return transport.authenticate(context.session, documentName, token);
    },
    async connected({ context }) {
      transport.connected(context.session);
    },
    async onDisconnect({ context }) {
      transport.disconnected(context.session);
    },
    async afterHandleMessage({ context }) {
      transport.handled(context.session);
    },
    async onStateless({ connection, payload }) {
      transport.reportReady(connection, payload);
    },
    async onRequest({ request, response }) {
      app(request, response);
      // Hocuspocus uses an empty rejection to delegate HTTP handling to another router.
      throw null;
    },
    async onUpgrade({ request, socket, head }) {
      transport.upgrade(request, socket, head);
      throw null;
    },
  });
  transport = new CollaborationTransport(
    collaborationServer.hocuspocus,
    store,
    policy,
    limits,
    telemetry,
    config.allowedOrigins,
    config.trustedProxyCidrs || [],
  );
  const readiness = new Readiness(
    pool,
    redisExtension,
    persistence,
    telemetry,
    policy.maxDirtyAgeSeconds,
  );
  let httpInFlight = 0;
  app.use((request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    const route =
      request.path === '/api/documents'
        ? 'documents'
        : /^\/api\/documents\/[^/]+$/.test(request.path)
          ? 'document'
          : ['/health', '/live', '/ready', '/metrics'].includes(request.path)
            ? request.path.slice(1)
            : 'other';
    response.once('finish', () =>
      telemetry.count('http_requests_total', {
        route,
        result: `${Math.floor(response.statusCode / 100)}xx`,
      }),
    );
    if (request.headers.origin && !config.allowedOrigins.includes(request.headers.origin)) {
      telemetry.reject('origin');
      return void response.status(403).json({ error: 'Origin denied' });
    }
    if (route === 'document' || route === 'documents') {
      let key: string;
      try {
        key = ipLimitKey(clientIp(request, trusted));
      } catch {
        telemetry.reject('forwarded_peer');
        return void response.status(400).json({ error: 'Invalid proxy header' });
      }
      const creating = route === 'documents' && request.method === 'POST';
      if (
        !limits.take('api', key, policy.apiPerMinute) ||
        (creating && !limits.take('create', key, policy.createsPerMinute))
      ) {
        telemetry.reject('api_rate');
        response.setHeader('Retry-After', '2');
        return void response.status(429).json({ error: 'Request rate exceeded' });
      }
      if (transport.draining || httpInFlight >= 64) {
        telemetry.reject('http_capacity');
        return void response.status(503).json({ error: 'Service busy' });
      }
      httpInFlight++;
      response.once('close', () => {
        httpInFlight--;
      });
    }
    next();
  });
  app.disable('x-powered-by');
  app.use(cors({ origin: config.allowedOrigins }));
  app.use(express.json({ limit: '16kb', inflate: false }));
  app.use((_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });
  app.get('/live', (_request, response) => response.json({ status: 'alive' }));
  for (const endpoint of ['/health', '/ready'])
    app.get(endpoint, async (_request, response) => {
      const ready = await readiness.check();
      response.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'unavailable' });
    });
  app.get('/metrics', async (request, response) => {
    if (!config.metricsToken) return void response.sendStatus(404);
    const expected = createHash('sha256').update(config.metricsToken).digest();
    const supplied = createHash('sha256')
      .update(
        request.headers.authorization?.startsWith('Bearer ')
          ? request.headers.authorization.slice(7)
          : '',
      )
      .digest();
    if (!timingSafeEqual(expected, supplied)) return void response.sendStatus(401);
    readiness.sample();
    telemetry.gauge(
      'documents',
      new Set([
        ...collaborationServer.hocuspocus.documents.keys(),
        ...collaborationServer.hocuspocus.loadingDocuments.keys(),
      ]).size,
    );
    response.type(telemetry.registry.contentType).send(await telemetry.metrics());
  });
  app.post('/api/documents', async (request, response) => {
    const input = createDocumentBody.parse(request.body);
    const document = await store.create(input.title);
    response.status(201).location(`/api/documents/${document.id}`).json(document);
  });
  const token = (header: string | undefined) =>
    header?.startsWith('Bearer ') ? header.slice(7) : '';
  app.get('/api/documents/:id', async (request, response) => {
    const id = documentId.parse(request.params.id);
    const document = await store.authorize(id, token(request.headers.authorization));
    telemetry.count('authentication_total', { result: document ? 'allowed' : 'denied' });
    if (!document) {
      telemetry.log('authentication_denied', 'http_document');
      return void response.status(404).json({ error: 'Document not found or access denied' });
    }
    response.json(document);
  });
  app.patch('/api/documents/:id', async (request, response) => {
    const id = documentId.parse(request.params.id);
    const input = createDocumentBody.parse(request.body);
    const document = await store.rename(id, token(request.headers.authorization), input.title);
    telemetry.count('authentication_total', { result: document ? 'allowed' : 'denied' });
    if (!document) {
      telemetry.log('authentication_denied', 'http_document');
      return void response.status(404).json({ error: 'Document not found or access denied' });
    }
    response.json(document);
  });
  app.use((_request, response) => {
    response.status(404).json({ error: 'Endpoint not found' });
  });
  const errorHandler: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
    if (error instanceof ZodError)
      return void response.status(400).json({
        error: 'Invalid request',
        issues: error.issues.map((issue) => ({
          field: issue.path.join('.'),
          message: issue.message,
        })),
      });
    if (error instanceof SyntaxError && 'body' in error)
      return void response.status(400).json({ error: 'Malformed JSON' });
    if (typeof error === 'object' && error !== null && 'status' in error && error.status === 413)
      return void response.status(413).json({ error: 'Request is too large' });
    if (typeof error === 'object' && error !== null && 'status' in error && error.status === 415)
      return void response.status(415).json({ error: 'Unsupported encoding or content type' });
    telemetry.log('request_failed');
    response.status(503).json({ error: 'Service temporarily unavailable' });
  };
  app.use(errorHandler);

  const server = collaborationServer.httpServer;
  server.headersTimeout = 5000;
  server.requestTimeout = 10000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 32;
  server.maxConnections = 1024;
  let closing: Promise<void> | undefined;
  return {
    server,
    store,
    pool,
    collaboration: collaborationServer.hocuspocus,
    synchronization: redisExtension,
    telemetry,
    readiness,
    persistence,
    async listen(): Promise<number> {
      await redisExtension.pub.ping();
      await collaborationServer.listen();
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Server has no TCP address');
      await readiness.check();
      telemetry.log('server_started');
      return address.port;
    },
    close(): Promise<void> {
      closing ??= (async () => {
        readiness.close();
        transport.draining = true;
        telemetry.log('server_stopping');
        const timeout = setTimeout(() => persistence.stop(), options.shutdownTimeoutMs ?? 12000);
        try {
          await transport.close();
          await collaborationServer.destroy();
          if (persistence.abandonedSaves)
            throw new Error('Shutdown could not persist all pending document changes');
        } finally {
          clearTimeout(timeout);
          persistence.stop();
          await pool.end();
          telemetry.log('server_stopped');
          telemetry.close();
        }
      })();
      return closing;
    },
  };
}
