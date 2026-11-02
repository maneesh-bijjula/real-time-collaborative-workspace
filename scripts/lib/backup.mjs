import { constants } from 'node:fs';
import { mkdir, open, readFile, readdir, rename, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join, dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { root, OperationError, event } from './compose.mjs';

const migrationsDirectory = resolve(root, 'apps/server/migrations');
export async function migrationFiles() {
  const names = (await readdir(migrationsDirectory)).filter((name) => name.endsWith('.sql'));
  if (!names.length || names.some((name) => !/^\d+_[a-z0-9_]+\.sql$/.test(name)))
    throw new OperationError('migration_files_invalid');
  return Promise.all(
    names.sort().map(async (name) => ({
      name,
      checksum: createHash('sha256')
        .update(await readFile(join(migrationsDirectory, name)))
        .digest('hex'),
    })),
  );
}
export async function digest(handle) {
  const hash = createHash('sha256');
  for await (const chunk of handle.createReadStream({ start: 0, autoClose: false }))
    hash.update(chunk);
  return hash.digest('hex');
}
export async function validateMetadata(metadata) {
  const files = await migrationFiles();
  if (
    metadata?.postgresMajor !== 17 ||
    metadata.encoding !== 'UTF8' ||
    typeof metadata.documentCount !== 'string' ||
    !/^\d+$/.test(metadata.documentCount) ||
    !Array.isArray(metadata.migrations) ||
    !metadata.migrations.length ||
    metadata.migrations.length > files.length ||
    metadata.migrations.some(
      (row, i) => row.name !== files[i]?.name || row.checksum !== files[i]?.checksum,
    )
  )
    throw new OperationError('backup_schema_or_version_incompatible');
}

export async function inspectBackup(directory) {
  const folder = resolve(directory);
  if (!(await lstat(folder)).isDirectory()) throw new OperationError('invalid_backup_manifest');
  const manifestFile = await open(
    join(folder, 'manifest.json'),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  let manifest;
  try {
    const info = await manifestFile.stat();
    if (!info.isFile() || info.size > 1024 * 1024)
      throw new OperationError('invalid_backup_manifest');
    manifest = JSON.parse(await manifestFile.readFile('utf8'));
  } finally {
    await manifestFile.close();
  }
  if (
    manifest.schemaVersion !== 1 ||
    manifest.complete !== true ||
    manifest.format !== 'postgres-custom' ||
    !Number.isSafeInteger(manifest.archiveBytes) ||
    manifest.archiveBytes <= 0 ||
    !/^[a-f0-9]{64}$/.test(manifest.archiveSha256 ?? '')
  )
    throw new OperationError('invalid_backup_manifest');
  await validateMetadata(manifest);
  const archive = await open(
    join(folder, 'database.dump'),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await archive.stat();
    if (
      !info.isFile() ||
      info.size !== manifest.archiveBytes ||
      (await digest(archive)) !== manifest.archiveSha256
    )
      throw new OperationError('backup_integrity_failed');
    return { manifest, archive };
  } catch (error) {
    await archive.close();
    throw error;
  }
}

export async function backup(compose, service, directory, timeoutSeconds, database) {
  if (database && !/^[a-z][a-z0-9_]{0,62}$/.test(database))
    throw new OperationError('source_database_name_invalid');
  const folder = resolve(directory);
  // Exclusive private directory: failed/partial backups never become valid and
  // existing backups are never overwritten. Only the final manifest seals it.
  await mkdir(dirname(folder), { recursive: true, mode: 0o700 });
  await mkdir(folder, { mode: 0o700 });
  await compose.assertPostgres(service);
  const toolVersion = await compose.pg(service, 'pg_dump', ['--version'], {
    timeoutSeconds,
    failOnStderr: true,
  });
  const args = compose.pgArgs(
    service,
    'psql',
    ['-XqAt', '-v', 'ON_ERROR_STOP=1', ...(database ? ['--dbname=' + database] : [])],
    timeoutSeconds,
  );
  // PGDATABASE comes from the source service environment, not host credentials.
  const sh = args.indexOf('sh');
  args[sh + 2] =
    'export PGPASSWORD="$POSTGRES_PASSWORD" PGDATABASE="$POSTGRES_DB"; exec psql --username="$POSTGRES_USER" "$@"';
  const child = spawn('docker', [...compose.args, ...args], {
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let snapshotWarning = false;
  child.stderr.on('data', () => {
    snapshotWarning = true;
  });
  child.stdin.on('error', () => {});
  const deadline = setTimeout(() => child.kill('SIGKILL'), timeoutSeconds * 1000);
  const exited = new Promise((resolveExit, reject) => {
    child.once('error', () => reject(new OperationError('snapshot_session_unavailable')));
    child.once('close', (code) =>
      code === 0 && !snapshotWarning
        ? resolveExit()
        : reject(new OperationError('snapshot_session_failed')),
    );
  });
  exited.catch(() => {});
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let file;
  try {
    const metadataPromise = new Promise((resolveMetadata, reject) => {
      lines.once('line', (line) => {
        try {
          resolveMetadata(JSON.parse(line));
        } catch {
          reject(new OperationError('snapshot_metadata_failed'));
        }
      });
      exited.then(() => reject(new OperationError('snapshot_metadata_missing')), reject);
    });
    child.stdin.write(`BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT json_build_object('snapshot',pg_export_snapshot(), 'database',current_database(), 'snapshotAt',statement_timestamp(),
 'postgresMajor',current_setting('server_version_num')::int / 10000, 'encoding',current_setting('server_encoding'),
 'documentCount',(SELECT count(*)::text FROM documents),
 'migrations',(SELECT json_agg(json_build_object('name',name,'checksum',checksum) ORDER BY name COLLATE "C") FROM schema_migrations));\n`);
    const metadata = await metadataPromise;
    await validateMetadata(metadata);
    if (
      !/^[a-f0-9]+-[a-f0-9]+-\d+$/i.test(metadata.snapshot) ||
      !/^[a-z][a-z0-9_]{0,62}$/.test(metadata.database)
    )
      throw new OperationError('invalid_exported_snapshot');
    event('backup_snapshot_acquired');
    file = await open(join(folder, 'database.dump.partial'), 'wx', 0o600);
    await compose.pg(
      service,
      'pg_dump',
      [
        '--format=custom',
        '--no-owner',
        '--no-acl',
        '--lock-wait-timeout=5000',
        '--snapshot=' + metadata.snapshot,
        '--dbname=' + metadata.database,
      ],
      { stdout: file.fd, timeoutSeconds, failOnStderr: true },
    );
    await file.sync();
    const archiveBytes = (await file.stat()).size;
    await file.close();
    file = undefined;
    child.stdin.end('COMMIT;\n\\q\n');
    await exited;
    await rename(join(folder, 'database.dump.partial'), join(folder, 'database.dump'));
    const archive = await open(join(folder, 'database.dump'), 'r');
    let archiveSha256;
    try {
      archiveSha256 = await digest(archive);
    } finally {
      await archive.close();
    }
    const { snapshot, ...metadataFields } = metadata;
    const manifest = {
      schemaVersion: 1,
      complete: true,
      format: 'postgres-custom',
      createdAt: new Date().toISOString(),
      toolVersion,
      sourceProject: compose.project,
      sourceService: service,
      ...metadataFields,
      archiveBytes,
      archiveSha256,
    };
    const output = await open(join(folder, 'manifest.json.partial'), 'wx', 0o600);
    try {
      await output.writeFile(JSON.stringify(manifest, null, 2) + '\n');
      await output.sync();
    } finally {
      await output.close();
    }
    await rename(join(folder, 'manifest.json.partial'), join(folder, 'manifest.json'));
    const directoryHandle = await open(folder, 'r');
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
    event('backup_completed', { archiveBytes });
    return manifest;
  } finally {
    clearTimeout(deadline);
    lines.close();
    await file?.close();
    if (child.exitCode === null) child.kill('SIGTERM');
    await exited.catch(() => {});
  }
}

export async function restore(compose, service, directory, target, timeoutSeconds) {
  if (
    !/^[a-z][a-z0-9_]{0,62}$/.test(target ?? '') ||
    ['postgres', 'template0', 'template1'].includes(target)
  )
    throw new OperationError('new_target_database_required');
  const { manifest, archive } = await inspectBackup(directory);
  try {
    await compose.assertPostgres(service);
    const major = await compose.sql(
      service,
      'postgres',
      "SELECT current_setting('server_version_num')::int / 10000",
      { timeoutSeconds },
    );
    if (Number(major) !== manifest.postgresMajor)
      throw new OperationError('postgres_major_mismatch');
    await compose.pg(service, 'pg_restore', ['--list'], {
      input: archive.createReadStream({ start: 0, autoClose: false }),
      timeoutSeconds,
      failOnStderr: true,
    });
    if (
      await compose.sql(
        service,
        'postgres',
        `SELECT 1 FROM pg_database WHERE datname='${target}'`,
        { timeoutSeconds },
      )
    )
      throw new OperationError('target_database_already_exists');
    // createdb itself rejects a concurrent creator. No --clean, DROP, or writes
    // to an existing target are ever used. Failed restores leave the new target
    // for inspection; pg_restore rolls its schema/data transaction back.
    await compose.pg(
      service,
      'createdb',
      ['--maintenance-db=postgres', '--template=template0', '--encoding=UTF8', '--', target],
      { timeoutSeconds },
    );
    await compose.pg(
      service,
      'pg_restore',
      ['--single-transaction', '--exit-on-error', '--no-owner', '--no-acl', '--dbname=' + target],
      {
        input: archive.createReadStream({ start: 0, autoClose: false }),
        timeoutSeconds,
        failOnStderr: true,
      },
    );
    const restored = JSON.parse(
      await compose.sql(
        service,
        target,
        `SELECT json_build_object(
 'documentCount',(SELECT count(*)::text FROM documents),
 'migrations',(SELECT json_agg(json_build_object('name',name,'checksum',checksum) ORDER BY name COLLATE "C") FROM schema_migrations))`,
        { timeoutSeconds },
      ),
    );
    if (
      restored.documentCount !== manifest.documentCount ||
      restored.migrations?.length !== manifest.migrations.length ||
      restored.migrations.some(
        (row, i) =>
          row.name !== manifest.migrations[i].name ||
          row.checksum !== manifest.migrations[i].checksum,
      )
    )
      throw new OperationError('restored_metadata_mismatch');
    await compose.pg(
      service,
      'psql',
      ['-Xq', '-v', 'ON_ERROR_STOP=1', '-d', target, '-c', 'ANALYZE'],
      { timeoutSeconds },
    );
    event('restore_completed', { documentCount: restored.documentCount });
    return restored;
  } finally {
    await archive.close();
  }
}
