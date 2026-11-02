import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { inspectBackup, migrationFiles, backup } from '../../scripts/lib/backup.mjs';
import { run, Compose } from '../../scripts/lib/compose.mjs';

async function fixture(body) {
  const folder = await mkdtemp(join(tmpdir(), 'commonplace-backup-test-'));
  const archive = Buffer.from('PGDMP-integrity-fixture');
  const manifest = {
    schemaVersion: 1,
    complete: true,
    format: 'postgres-custom',
    postgresMajor: 17,
    encoding: 'UTF8',
    documentCount: '1',
    migrations: await migrationFiles(),
    archiveBytes: archive.length,
    archiveSha256: createHash('sha256').update(archive).digest('hex'),
  };
  await writeFile(join(folder, 'database.dump'), archive, { mode: 0o600 });
  await writeFile(join(folder, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 });
  try {
    await body(folder, manifest);
  } finally {
    await rm(folder, { recursive: true });
  }
}
test('validates a sealed archive hash while retaining a verified open file handle', async () =>
  fixture(async (folder) => {
    const result = await inspectBackup(folder);
    try {
      assert.equal(result.manifest.documentCount, '1');
      assert.equal((await result.archive.stat()).isFile(), true);
    } finally {
      await result.archive.close();
    }
  }));
test('rejects changed bytes, incomplete manifests, unknown migrations and symlink archives', async () => {
  await fixture(async (folder) => {
    await writeFile(join(folder, 'database.dump'), 'corrupt');
    await assert.rejects(inspectBackup(folder), /backup_integrity_failed/);
  });
  for (const change of [
    { complete: false },
    { postgresMajor: 18 },
    { migrations: [{ name: '999_unknown.sql', checksum: '0'.repeat(64) }] },
  ])
    await fixture(async (folder, manifest) => {
      await writeFile(join(folder, 'manifest.json'), JSON.stringify({ ...manifest, ...change }));
      await assert.rejects(inspectBackup(folder));
    });
  await fixture(async (folder) => {
    await rm(join(folder, 'database.dump'));
    await symlink(join(folder, 'manifest.json'), join(folder, 'database.dump'));
    await assert.rejects(inspectBackup(folder));
  });
  if (process.platform !== 'win32')
    for (const name of ['manifest.json', 'database.dump'])
      await fixture(async (folder) => {
        await rm(join(folder, name));
        await promisify(execFile)('mkfifo', [join(folder, name)]);
        await assert.rejects(inspectBackup(folder));
      });
});
test('a failed backup remains private, unsealed and cannot overwrite an existing output', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'commonplace-partial-test-')),
    output = join(parent, 'backup');
  let calls = 0;
  const compose = {
    assertPostgres: async () => {
      calls++;
      throw new Error('source-unavailable');
    },
  };
  try {
    await assert.rejects(backup(compose, 'postgres', output, 30));
    assert.equal((await stat(output)).mode & 0o777, 0o700);
    await assert.rejects(inspectBackup(output));
    await assert.rejects(backup(compose, 'postgres', output, 30));
    assert.equal(calls, 1);
  } finally {
    await rm(parent, { recursive: true });
  }
});
test('requires an explicit project and Compose file and redacts invalid CLI arguments', async () => {
  assert.throws(() => new Compose(undefined, []));
  await assert.rejects(
    run(process.execPath, [
      'scripts/database.mjs',
      'restore',
      '--project',
      'secret-sentinel',
      '--database',
      'ordinary',
    ]),
    (error) => {
      assert(!String(error).includes('secret-sentinel'));
      return true;
    },
  );
});

test('refuses a tool warning even with exit zero, without serializing its private contents', async () => {
  await assert.rejects(
    run(process.execPath, ['-e', 'process.stderr.write("private-tool-warning-sentinel")'], {
      failOnStderr: true,
    }),
    (error) => {
      assert.equal(error.reason, 'command_reported_warning');
      assert(!String(error).includes('private-tool-warning-sentinel'));
      return true;
    },
  );
});

test('direct browser invocation fails closed before discovering tests against an ordinary database', async () => {
  try {
    await promisify(execFile)(
      process.execPath,
      ['node_modules/@playwright/test/cli.js', 'test', '--list'],
      {
        env: {
          ...process.env,
          E2E_MANAGED_RUN: '',
          DATABASE_URL: 'postgres://private-secret-sentinel@localhost/workspace',
        },
        timeout: 15000,
      },
    );
    assert.fail('Unguarded browser test discovery unexpectedly succeeded');
  } catch (error) {
    assert.equal(error.code, 1);
    const logs = String(error.stdout) + String(error.stderr);
    assert(logs.includes('Use npm run test:e2e'));
    assert(!logs.includes('private-secret-sentinel'));
  }
});
