import { randomUUID } from 'node:crypto';
import cors from 'cors';
import express, { type ErrorRequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import { Pool } from 'pg';
import { Server } from '@hocuspocus/server';
import { Database } from '@hocuspocus/extension-database';
import { Redis } from '@hocuspocus/extension-redis';
import { ZodError } from 'zod';
import type { ServerConfig } from './config.js';
import { createDocumentBody, documentId, DocumentStore } from './documents.js';
import { migrate } from './migrate.js';

export async function createApplication(config: ServerConfig) {
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: 10,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
  });
  await migrate(pool);
  const store = new DocumentStore(pool);
  const redis = new URL(config.redisUrl);
  const app = express();
  const redisExtension = new Redis({
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
  });
  const collaborationServer = new Server({
    port: config.port,
    address: config.host,
    stopOnSignals: false,
    websocketOptions: { maxPayload: 1024 * 1024 },
    name: randomUUID(),
    quiet: true,
    debounce: 300,
    maxDebounce: 1000,
    extensions: [
      redisExtension,
      new Database({
        fetch: ({ documentName }) => store.load(documentName),
        store: ({ documentName, state }) => store.store(documentName, state),
      }),
    ],
    async onAuthenticate({ documentName, token }) {
      const document = await store.authorize(documentName, token);
      if (!document) throw new Error('Document access denied');
      return { documentId: document.id };
    },
    async onRequest({ request, response }) {
      app(request, response);
      // Hocuspocus uses an empty rejection to delegate HTTP handling to another router.
      throw null;
    },
    async onUpgrade({ request, socket }) {
      const origin = request.headers.origin;
      if (
        request.url?.split('?')[0] !== '/collaboration' ||
        (origin && !config.allowedOrigins.includes(origin))
      ) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        throw null;
      }
    },
  });
  app.disable('x-powered-by');
  app.use(cors({ origin: config.allowedOrigins }));
  app.use(express.json({ limit: '16kb' }));
  app.use((_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });
  app.get('/health', async (_request, response) => {
    await pool.query('SELECT 1');
    await redisExtension.pub.ping();
    response.json({ status: 'ok' });
  });
  app.post(
    '/api/documents',
    rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false }),
    async (request, response) => {
      const input = createDocumentBody.parse(request.body);
      const document = await store.create(input.title);
      response.status(201).location(`/api/documents/${document.id}`).json(document);
    },
  );
  const token = (header: string | undefined) =>
    header?.startsWith('Bearer ') ? header.slice(7) : '';
  app.get('/api/documents/:id', async (request, response) => {
    const id = documentId.parse(request.params.id);
    const document = await store.authorize(id, token(request.headers.authorization));
    if (!document)
      return void response.status(404).json({ error: 'Document not found or access denied' });
    response.json(document);
  });
  app.patch('/api/documents/:id', async (request, response) => {
    const id = documentId.parse(request.params.id);
    const input = createDocumentBody.parse(request.body);
    const document = await store.rename(id, token(request.headers.authorization), input.title);
    if (!document)
      return void response.status(404).json({ error: 'Document not found or access denied' });
    response.json(document);
  });
  app.use((_request, response) => {
    response.status(404).json({ error: 'Endpoint not found' });
  });
  const errorHandler: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
    if (error instanceof ZodError)
      return void response
        .status(400)
        .json({
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
    console.error('Request failed', error instanceof Error ? error.message : 'Unknown error');
    response.status(503).json({ error: 'Service temporarily unavailable' });
  };
  app.use(errorHandler);

  const server = collaborationServer.httpServer;
  return {
    server,
    store,
    pool,
    collaboration: collaborationServer.hocuspocus,
    async listen(): Promise<number> {
      await redisExtension.pub.ping();
      await collaborationServer.listen();
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Server has no TCP address');
      return address.port;
    },
    async close(): Promise<void> {
      await collaborationServer.destroy();
      await pool.end();
    },
  };
}
