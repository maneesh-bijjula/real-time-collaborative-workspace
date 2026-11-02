import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { expect, it } from 'vitest';
import * as Y from 'yjs';
import { migrate } from '../../apps/server/src/migrate.js';
import { DocumentStore } from '../../apps/server/src/documents.js';

const base = process.env.TEST_DATABASE_URL!;
if (!new URL(base).pathname.endsWith('_test'))
  throw new Error('Isolated migration test database required');
const original = await readFile(
  new URL('../../apps/server/migrations/001_documents.sql', import.meta.url),
  'utf8',
);

async function scenario(
  test: (pool: Pool, directory: URL, folder: string) => Promise<void>,
  options = {},
) {
  const admin = new Pool({ connectionString: base });
  const name = 'workspace_migration_' + randomUUID().replaceAll('-', '') + '_test';
  const url = new URL(base);
  url.pathname = '/' + name;
  const folder = await mkdtemp(join(tmpdir(), 'commonplace-migrations-'));
  await writeFile(join(folder, '001_documents.sql'), original);
  let pool: Pool | undefined;
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    pool = new Pool({ connectionString: url.href, max: 2, ...options });
    await test(pool, pathToFileURL(folder + sep), folder);
  } finally {
    await pool?.end();
    await admin.end();
    await rm(folder, { recursive: true });
  }
}
async function seed(pool: Pool) {
  const store = new DocumentStore(pool),
    document = await store.create('migration-content-sentinel');
  const doc = new Y.Doc();
  doc.getText('body').insert(0, 'retained text');
  doc.getText('body').delete(0, 3);
  await store.store(document.id, Y.encodeStateAsUpdate(doc));
  doc.destroy();
}
async function state(pool: Pool) {
  return (
    await pool.query(
      "SELECT id,title,encode(access_token_hash,'hex') AS hash,encode(state,'hex') AS state,created_at,updated_at FROM documents ORDER BY id",
    )
  ).rows;
}

it('rolls back partial DDL and data writes, then applies a corrected additive migration exactly once', async () => {
  await scenario(async (pool, directory, folder) => {
    await migrate(pool, { directory });
    await seed(pool);
    const before = await state(pool);
    await writeFile(
      join(folder, '002_release.sql'),
      "CREATE TABLE release_probe(id int); UPDATE documents SET title='must-roll-back'; SELECT 1/0;",
    );
    await expect(migrate(pool, { directory })).rejects.toMatchObject({
      reason: 'migration_apply_failed',
    });
    expect(await state(pool)).toEqual(before);
    expect(
      (await pool.query("SELECT to_regclass('release_probe') AS name")).rows[0].name,
    ).toBeNull();
    expect(
      (await pool.query('SELECT count(*)::int AS count FROM schema_migrations')).rows[0].count,
    ).toBe(1);
    await writeFile(join(folder, '002_release.sql'), 'CREATE TABLE release_probe(id int);');
    await Promise.all([migrate(pool, { directory }), migrate(pool, { directory })]);
    await migrate(pool, { directory });
    expect(
      (await pool.query('SELECT count(*)::int AS count FROM schema_migrations')).rows[0].count,
    ).toBe(2);
    expect(await state(pool)).toEqual(before);
    // Old-image rollback against a new schema must fail before serving traffic.
    await expect(migrate(pool)).rejects.toMatchObject({ reason: 'migration_history_invalid' });
    expect(await state(pool)).toEqual(before);
  });
});

it.each(['checksum', 'unknown', 'gap', 'filename'])(
  'refuses %s history without changing existing content or recorded history',
  async (kind) => {
    await scenario(async (pool, directory, folder) => {
      await migrate(pool, { directory });
      await seed(pool);
      if (kind === 'filename')
        await writeFile(join(folder, '002-invalid.sql'), 'DROP TABLE documents;');
      else if (kind === 'checksum')
        await pool.query("UPDATE schema_migrations SET checksum=repeat('0',64)");
      else {
        const name = kind === 'unknown' ? '999_unknown.sql' : '003_gap.sql';
        if (kind === 'gap') {
          await writeFile(join(folder, '002_missing.sql'), 'SELECT 1;');
          await writeFile(join(folder, name), 'SELECT 1;');
        }
        await pool.query('INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)', [
          name,
          createHash('sha256').update('SELECT 1;').digest('hex'),
        ]);
      }
      const before = await state(pool),
        history = (await pool.query('SELECT * FROM schema_migrations ORDER BY name')).rows;
      await expect(migrate(pool, { directory })).rejects.toMatchObject({
        reason: 'migration_history_invalid',
      });
      expect(await state(pool)).toEqual(before);
      expect((await pool.query('SELECT * FROM schema_migrations ORDER BY name')).rows).toEqual(
        history,
      );
    });
  },
);

it('preflight refuses pending migrations without applying them, then succeeds after explicit migration', async () => {
  await scenario(async (pool, directory, folder) => {
    await migrate(pool, { directory });
    await seed(pool);
    const before = await state(pool);
    await writeFile(join(folder, '002_pending.sql'), 'CREATE TABLE pending_probe(id int);');
    await expect(migrate(pool, { directory, checkOnly: true })).rejects.toMatchObject({
      reason: 'migration_pending',
    });
    expect(
      (await pool.query("SELECT to_regclass('pending_probe') AS name")).rows[0].name,
    ).toBeNull();
    expect(await state(pool)).toEqual(before);
    await migrate(pool, { directory });
    await migrate(pool, { directory, checkOnly: true });
    expect(await state(pool)).toEqual(before);
  });
});

it('discards a timed-out migration connection, releases its transaction, and retries safely', async () => {
  await scenario(
    async (pool, directory) => {
      await migrate(pool, { directory });
      await seed(pool);
      const before = await state(pool);
      const blocker = await pool.connect();
      await blocker.query('BEGIN');
      await blocker.query('SELECT pg_advisory_xact_lock(682943172)');
      try {
        await expect(migrate(pool, { directory })).rejects.toMatchObject({
          reason: 'migration_apply_failed',
        });
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
      }
      await migrate(pool, { directory });
      expect(await state(pool)).toEqual(before);
    },
    { query_timeout: 150, statement_timeout: 0 },
  );
});
