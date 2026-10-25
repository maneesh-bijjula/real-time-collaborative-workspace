import { z } from 'zod';
import { policySchema, trustedProxyList, type PolicyOverrides } from './policy.js';

const environment = z.object({
  PORT: z.coerce.number().int().min(0).max(65535).default(4000),
  HOST: z.string().default('127.0.0.1'),
  DATABASE_URL: z
    .string()
    .url()
    .default('postgres://workspace:workspace-local@localhost:5433/workspace'),
  REDIS_URL: z.string().url().default('redis://localhost:6380'),
  REDIS_PREFIX: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/)
    .default('commonplace'),
  REDIS_RECONCILE_INTERVAL_MS: z.coerce.number().int().min(250).max(60000).default(2000),
  METRICS_TOKEN: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z
      .string()
      .regex(/^[A-Za-z0-9_-]{32,128}$/)
      .optional(),
  ),
  TRUSTED_PROXY_CIDRS: z.string().default(''),
  MAX_CONNECTIONS: z.coerce.number().int().min(1).max(10000).default(512),
  MAX_CONNECTIONS_PER_IP: z.coerce.number().int().min(1).max(10000).default(128),
  MAX_OPEN_DOCUMENTS: z.coerce.number().int().min(1).max(10000).default(128),
  MAX_DOCUMENT_CLIENTS: z.coerce.number().int().min(1).max(1000).default(128),
  MAX_DOCUMENT_BYTES: z.coerce.number().int().min(1024).max(16777216).default(4194304),
  ALLOWED_ORIGINS: z.string().default('http://localhost:3000,http://127.0.0.1:3000'),
});

export interface ServerConfig {
  port: number;
  host: string;
  databaseUrl: string;
  redisUrl: string;
  redisPrefix: string;
  redisReconcileIntervalMs?: number;
  allowedOrigins: string[];
  metricsToken?: string;
  trustedProxyCidrs?: string[];
  policy?: PolicyOverrides;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const parsed = environment.parse(env);
  const trustedProxyCidrs = parsed.TRUSTED_PROXY_CIDRS.split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  trustedProxyList(trustedProxyCidrs);
  const allowedOrigins = parsed.ALLOWED_ORIGINS.split(',').map((value) => {
    const url = new URL(value.trim());
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/'
    )
      throw new Error('Allowed origins must be HTTP(S) origins without credentials or paths');
    return url.origin;
  });
  if (
    !['postgres:', 'postgresql:'].includes(new URL(parsed.DATABASE_URL).protocol) ||
    !['redis:', 'rediss:'].includes(new URL(parsed.REDIS_URL).protocol)
  )
    throw new Error('Invalid dependency URL protocol');
  return {
    port: parsed.PORT,
    host: parsed.HOST,
    databaseUrl: parsed.DATABASE_URL,
    redisUrl: parsed.REDIS_URL,
    redisPrefix: parsed.REDIS_PREFIX,
    redisReconcileIntervalMs: parsed.REDIS_RECONCILE_INTERVAL_MS,
    allowedOrigins,
    metricsToken: parsed.METRICS_TOKEN,
    trustedProxyCidrs,
    policy: policySchema.parse({
      maxSockets: parsed.MAX_CONNECTIONS,
      maxSocketsPerIp: parsed.MAX_CONNECTIONS_PER_IP,
      maxDocuments: parsed.MAX_OPEN_DOCUMENTS,
      maxDocumentClients: parsed.MAX_DOCUMENT_CLIENTS,
      maxDocumentBytes: parsed.MAX_DOCUMENT_BYTES,
    }),
  };
}
