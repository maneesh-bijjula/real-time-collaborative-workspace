import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';

export type MigrationFailure =
  | 'postgres_unavailable'
  | 'migration_history_invalid'
  | 'migration_pending'
  | 'migration_apply_failed';
export class MigrationError extends Error {
  constructor(readonly reason: MigrationFailure) {
    super(reason);
  }
}

export async function migrate(
  pool: Pool,
  options: { directory?: URL; checkOnly?: boolean } = {},
): Promise<void> {
  let files: { name: string; sql: string; checksum: string }[];
  try {
    const directory = fileURLToPath(
      options.directory ?? new URL('../migrations/', import.meta.url),
    );
    const names = (await readdir(directory)).filter((name) => name.endsWith('.sql'));
    if (names.some((name) => !/^\d+_[a-z0-9_]+\.sql$/.test(name)))
      throw new Error('Invalid migration name');
    files = await Promise.all(
      names.sort().map(async (name) => {
        const sql = await readFile(`${directory}/${name}`, 'utf8');
        return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
      }),
    );
    if (!files.length) throw new Error('No migrations');
  } catch {
    throw new MigrationError('migration_history_invalid');
  }
  const client = await pool.connect().catch(() => {
    throw new MigrationError('postgres_unavailable');
  });
  let discard = false;
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(682943172)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    const applied = await client.query<{ name: string; checksum: string }>(
      'SELECT name, checksum FROM schema_migrations ORDER BY name COLLATE "C"',
    );
    // A known, unchanged prefix is required. An older image must refuse a
    // newer database rather than silently running against an unknown schema.
    for (const [index, row] of applied.rows.entries())
      if (files[index]?.name !== row.name || files[index]?.checksum !== row.checksum)
        throw new MigrationError('migration_history_invalid');
    if (options.checkOnly && applied.rows.length !== files.length)
      throw new MigrationError('migration_pending');
    for (const { name, sql, checksum } of options.checkOnly
      ? []
      : files.slice(applied.rows.length)) {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [
        name,
        checksum,
      ]);
    }
    await client.query('COMMIT');
  } catch (error) {
    discard = true;
    if (!(error instanceof Error && error.message === 'Query read timeout')) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* Disconnect releases the transaction. */
      }
    }
    throw error instanceof MigrationError ? error : new MigrationError('migration_apply_failed');
  } finally {
    client.release(discard);
  }
}
