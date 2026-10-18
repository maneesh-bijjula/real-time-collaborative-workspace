import { z } from 'zod';

const environment = z.object({
  PORT: z.coerce.number().int().min(0).max(65535).default(4000),
  HOST: z.string().default('127.0.0.1'),
  DATABASE_URL: z
    .string()
    .url()
    .default('postgres://workspace:workspace-local@localhost:5433/workspace'),
  REDIS_URL: z.string().url().default('redis://localhost:6380'),
  ALLOWED_ORIGINS: z.string().default('http://localhost:3000,http://127.0.0.1:3000'),
});

export interface ServerConfig {
  port: number;
  host: string;
  databaseUrl: string;
  redisUrl: string;
  redisPrefix: string;
  allowedOrigins: string[];
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const parsed = environment.parse(env);
  return {
    port: parsed.PORT,
    host: parsed.HOST,
    databaseUrl: parsed.DATABASE_URL,
    redisUrl: parsed.REDIS_URL,
    redisPrefix: 'commonplace',
    allowedOrigins: parsed.ALLOWED_ORIGINS.split(',').map((value) => new URL(value.trim()).origin),
  };
}
