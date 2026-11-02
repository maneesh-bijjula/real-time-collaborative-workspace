import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, copyFile, rm, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { platform, release, arch } from 'node:os';
import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { CollaborationSession } from '../../apps/web/lib/collaboration-session.js';
import { DatabaseSaveTracker } from '../../apps/web/lib/database-save.js';
import { completeStateEqual, richState } from '../../benchmarks/workloads.js';

const execute = promisify(execFile);
const project = 'commonplace-release-' + Date.now() + '-' + randomBytes(4).toString('hex');
const privateDirectory = resolve('.release-tmp', project);
const output = resolve('test-results/release', project);
const composeFile = resolve('compose.recovery.yaml');
const composeBase = ['compose', '-p', project, '-f', composeFile];
const checks: string[] = [];
const report: Record<string, unknown> = {
  schemaVersion: 1,
  startedAt: new Date().toISOString(),
  project,
  scope:
    'Disposable final-image functional recovery drill, PostgreSQL 17 logical snapshot. No ordinary application data or volumes. Not a production RPO/RTO guarantee or performance benchmark.',
  checks,
  host: { os: platform(), release: release(), architecture: arch(), node: process.version },
};
const containerChecks: Record<string, unknown>[] = [];
report.containerChecks = containerChecks;
const stages: { name: string; atMs: number }[] = [];
report.stages = stages;
function enterStage(name: string) {
  stage = name;
  stages.push({ name, atMs: performance.now() });
  console.log(JSON.stringify({ event: 'release_drill_stage', stage }));
}
let stage = 'setup',
  failed = true;
type Client = {
  doc: Y.Doc;
  provider: HocuspocusProvider;
  tracker: DatabaseSaveTracker;
  session: CollaborationSession;
};
const clients: Client[] = [];
const oracle = new Y.Doc();
const fingerprint =
  "SELECT encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(d) ORDER BY id)::text,'[]'),'UTF8')),'hex') FROM documents d";

async function compose(args: string[], override?: string) {
  return (
    await execute('docker', [...composeBase, ...(override ? ['-f', override] : []), ...args], {
      timeout: 240000,
      maxBuffer: 2 * 1024 * 1024,
    })
  ).stdout.trim();
}
async function sql(service: string, database: string, query: string) {
  return compose([
    'exec',
    '-T',
    service,
    'psql',
    '-XqAt',
    '-v',
    'ON_ERROR_STOP=1',
    '-U',
    'workspace',
    '-d',
    database,
    '-c',
    query,
  ]);
}
async function until(check: () => boolean | Promise<boolean>, timeout = 20000) {
  const end = performance.now() + timeout;
  while (!(await check())) {
    if (performance.now() >= end) throw new Error('Release check deadline');
    await delay(20);
  }
}
async function endpoint(service: string) {
  const port = await compose(['port', service, '4000']);
  assert(/^127\.0\.0\.1:\d+$/.test(port));
  return 'http://' + port;
}
async function create(url: string, title: string) {
  const response = await fetch(url + '/api/documents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  assert.equal(response.status, 201);
  return (await response.json()) as { id: string; token: string; title: string };
}
async function connect(url: string, document: { id: string; token: string }, name: string) {
  const doc = new Y.Doc();
  doc.getXmlFragment('default');
  const provider = new HocuspocusProvider({
    url: url.replace('http:', 'ws:') + '/collaboration',
    name: document.id,
    token: document.token,
    document: doc,
  });
  const client = {
    doc,
    provider,
    session: new CollaborationSession(provider),
    tracker: new DatabaseSaveTracker(doc, provider, () => {}),
  };
  clients.push(client);
  provider.setAwarenessField('user', { name, color: '#7856b6' });
  await until(() => provider.synced && provider.isAuthenticated);
  return client;
}
function closeClients() {
  for (const c of clients.splice(0)) {
    c.tracker.destroy();
    c.session.destroy();
    c.provider.destroy();
    c.doc.destroy();
  }
}
async function equal(client: Client, expected: Y.Doc) {
  await until(
    () =>
      client.provider.synced &&
      !client.provider.hasUnsyncedChanges &&
      completeStateEqual(client.doc, expected) &&
      client.tracker.state === 'saved',
  );
}
async function cli(args: string[], success = true) {
  try {
    const result = await execute(process.execPath, ['scripts/database.mjs', ...args], {
      timeout: 90000,
      maxBuffer: 1024 * 1024,
    });
    assert(success, 'Operation unexpectedly succeeded');
    return result.stdout;
  } catch (error: any) {
    if (success || !error.code || error.code === 'ERR_ASSERTION') throw error;
    return String(error.stdout);
  }
}
async function containerCommand(
  args: string[],
  expectedEvent: string,
  expectedReason?: string,
  insideRunningContainer = false,
) {
  report.lastContainerCheck = { expectedEvent, expectedReason, insideRunningContainer };
  let result = '',
    code = 0;
  try {
    result = (
      await execute(
        'docker',
        [
          ...composeBase,
          ...(insideRunningContainer ? ['exec', '-T'] : ['run', '--rm', '--no-deps']),
          ...args,
        ],
        {
          timeout: 35000,
          maxBuffer: 1024 * 1024,
        },
      )
    ).stdout;
  } catch (error: any) {
    code = error.code;
    result = String(error.stdout || '') + String(error.stderr || '');
  }
  report.lastContainerCheck = {
    expectedEvent,
    expectedReason,
    insideRunningContainer,
    exitCode: code,
    matchedEvent: result.includes(`"event":"${expectedEvent}"`),
    matchedReason: !expectedReason || result.includes(`"reason":"${expectedReason}"`),
  };
  containerChecks.push(report.lastContainerCheck as Record<string, unknown>);
  assert.equal(code, expectedReason ? 1 : 0);
  assert(result.includes(`"event":"${expectedEvent}"`));
  if (expectedReason) assert(result.includes(`"reason":"${expectedReason}"`));
  for (const secret of [
    'do-not-log-dependency-password',
    'do-not-log-config-sentinel',
    'must-roll-back',
    'recovery-document-content-sentinel',
  ])
    assert(!result.includes(secret));
}

try {
  await mkdir(privateDirectory, { recursive: true, mode: 0o700 });
  await mkdir(output, { recursive: true });
  const commit = (await execute('git', ['rev-parse', 'HEAD'])).stdout.trim();
  const dirty = (await execute('git', ['status', '--porcelain'])).stdout.trim();
  process.env.SOURCE_REVISION = dirty ? 'uncommitted' : commit;
  report.source = { commit, dirty, revisionLabel: process.env.SOURCE_REVISION };
  enterStage('build_and_start_source');
  await compose([
    'up',
    '-d',
    '--build',
    '--wait',
    'postgres',
    'redis',
    'server',
    'postgres-restored',
    'redis-restored',
  ]);
  const ids = (await compose(['ps', '-q'])).split('\n').filter(Boolean);
  const inspected = JSON.parse((await execute('docker', ['inspect', ...ids])).stdout);
  assert(
    inspected
      .filter((c: any) =>
        ['postgres', 'postgres-restored'].includes(c.Config.Labels['com.docker.compose.service']),
      )
      .every((c: any) => Object.hasOwn(c.HostConfig.Tmpfs, '/var/lib/postgresql/data')),
  );
  report.images = inspected.map((c: any) => ({
    service: c.Config.Labels['com.docker.compose.service'],
    image: c.Image,
    revision: c.Config.Labels['org.opencontainers.image.revision'],
  }));
  report.serverNodeVersion = await compose(['exec', '-T', 'server', 'node', '--version']);
  let source = await endpoint('server');
  const document = await create(source, 'recovery-document-content-sentinel');
  const originalClient = await connect(source, document, 'source-editor');
  const paragraph = new Y.XmlElement('paragraph'),
    text = new Y.XmlText();
  originalClient.doc.getXmlFragment('default').push([paragraph]);
  paragraph.push([text]);
  text.insert(0, 'committed formatting; REMOVE-ME; preserved ending');
  text.format(0, 20, { bold: true });
  const beforeDelete = Y.encodeStateVector(originalClient.doc);
  text.delete(22, 9);
  assert.deepEqual(Y.encodeStateVector(originalClient.doc), beforeDelete);
  await until(() => originalClient.tracker.state === 'saved');
  Y.applyUpdate(oracle, Y.encodeStateAsUpdate(originalClient.doc));
  checks.push(
    'Source document has confirmed rich text, formatting and deletion-only state; archive restoration will use empty fresh clients.',
  );

  enterStage('consistent_live_backup');
  const backupDirectory = join(privateDirectory, 'backup');
  const child = spawn(
    process.execPath,
    [
      'scripts/database.mjs',
      'backup',
      '--project',
      project,
      '--file',
      composeFile,
      '--output',
      backupDirectory,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let logs = '',
    snapshotAcquired = false;
  child.stdout.on('data', (bytes) => {
    logs += bytes;
    if (logs.includes('"event":"backup_snapshot_acquired"')) snapshotAcquired = true;
  });
  child.stderr.resume();
  const dumped = new Promise<number | null>((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', resolveExit);
  });
  await until(() => snapshotAcquired, 15000);
  const late = await create(source, 'after-exported-backup-snapshot');
  assert.equal(await dumped, 0);
  assert(logs.includes('"event":"backup_completed"'));
  const manifest = JSON.parse(await readFile(join(backupDirectory, 'manifest.json'), 'utf8'));
  assert.equal(manifest.documentCount, '1');
  assert.equal((await stat(backupDirectory)).mode & 0o777, 0o700);
  assert.equal((await stat(join(backupDirectory, 'database.dump'))).mode & 0o777, 0o600);
  report.backup = manifest;
  checks.push(
    'Online custom-format backup and manifest share one exported repeatable-read snapshot; a later committed document is outside that cut. Private directory/file modes are 0700/0600.',
  );
  closeClients();

  enterStage('startup_and_migration_failures');
  const canonical = await readFile('apps/server/migrations/001_documents.sql', 'utf8');
  const bad = join(privateDirectory, 'bad-migrations'),
    good = join(privateDirectory, 'good-migrations');
  await mkdir(bad, { mode: 0o755 });
  await mkdir(good, { mode: 0o755 });
  await writeFile(join(bad, '001_documents.sql'), canonical + '\n-- checksum mismatch\n', {
    mode: 0o644,
  });
  await writeFile(join(good, '001_documents.sql'), canonical, { mode: 0o644 });
  const dataBefore = await sql('postgres', 'workspace_release_test', fingerprint);
  await containerCommand(
    ['-e', 'DATABASE_URL=do-not-log-config-sentinel', 'server'],
    'startup_failed',
    'configuration_invalid',
  );
  await containerCommand(
    [
      '-e',
      'DATABASE_URL=postgres://workspace:do-not-log-dependency-password@127.0.0.1:1/workspace_release_test',
      'server',
    ],
    'startup_failed',
    'postgres_unavailable',
  );
  await containerCommand(
    ['-e', 'REDIS_URL=redis://127.0.0.1:1', 'server'],
    'startup_failed',
    'dependency_or_listen_failed',
  );
  await containerCommand(
    ['server', 'node', 'apps/server/dist/index.js'],
    'startup_failed',
    'dependency_or_listen_failed',
    true,
  );
  await compose(['up', '-d', '--wait', 'redis-blackhole']);
  await containerCommand(
    ['-e', 'REDIS_URL=redis://redis-blackhole:6379', 'server'],
    'startup_failed',
    'startup_timeout',
  );
  await compose(['stop', '-t', '1', 'redis-blackhole']);
  await containerCommand(
    ['-v', `${bad}:/app/apps/server/migrations:ro`, 'server'],
    'startup_failed',
    'migration_history_invalid',
  );
  await writeFile(
    join(good, '002_release_probe.sql'),
    "CREATE TABLE release_probe(id int); UPDATE documents SET title='must-roll-back'; SELECT 1/0;",
    { mode: 0o644 },
  );
  await containerCommand(
    ['-v', `${good}:/app/apps/server/migrations:ro`, 'server'],
    'startup_failed',
    'migration_apply_failed',
  );
  assert.equal(await sql('postgres', 'workspace_release_test', fingerprint), dataBefore);
  assert.equal(
    await sql('postgres', 'workspace_release_test', "SELECT to_regclass('release_probe') IS NULL"),
    't',
  );
  assert.equal(
    await sql('postgres', 'workspace_release_test', 'SELECT count(*) FROM schema_migrations'),
    '1',
  );
  checks.push(
    'Real production entry points fail nonzero with redacted categories for unavailable PostgreSQL/Redis, changed migration history and failed SQL; existing rows and partial DDL roll back.',
  );

  enterStage('additive_upgrade_and_old_image_refusal');
  await writeFile(join(good, '002_release_probe.sql'), 'CREATE TABLE release_probe(id int);', {
    mode: 0o644,
  });
  await containerCommand(
    [
      '-v',
      `${good}:/app/apps/server/migrations:ro`,
      'server',
      'node',
      'apps/server/dist/migrate-cli.js',
    ],
    'migration_completed',
  );
  await containerCommand(
    [
      '-v',
      `${good}:/app/apps/server/migrations:ro`,
      'server',
      'node',
      'apps/server/dist/migrate-cli.js',
      '--check',
    ],
    'migration_check_passed',
  );
  const override = join(privateDirectory, 'upgrade.json');
  await writeFile(
    override,
    JSON.stringify({
      services: {
        server: {
          volumes: [
            { type: 'bind', source: good, target: '/app/apps/server/migrations', read_only: true },
          ],
        },
      },
    }),
  );
  await compose(['up', '-d', '--force-recreate', '--wait', 'server'], override);
  source = await endpoint('server');
  const upgraded = await connect(source, document, 'upgraded-fresh-editor');
  await equal(upgraded, oracle);
  closeClients();
  await containerCommand(['server'], 'startup_failed', 'migration_history_invalid');
  assert.equal(await sql('postgres', 'workspace_release_test', fingerprint), dataBefore);
  report.upgradeDataDigest = dataBefore;
  checks.push(
    'A corrected synthetic additive migration applies once; a recreated production container and fresh client preserve exact data. An image lacking the newer migration refuses startup without rewriting history.',
  );

  enterStage('restore_refusal_guards');
  const corrupt = join(privateDirectory, 'corrupt');
  await mkdir(corrupt, { mode: 0o700 });
  await copyFile(join(backupDirectory, 'manifest.json'), join(corrupt, 'manifest.json'));
  await copyFile(join(backupDirectory, 'database.dump'), join(corrupt, 'database.dump'));
  await writeFile(join(corrupt, 'database.dump'), 'corrupt archive');
  const restoreArgs = [
    'restore',
    '--project',
    project,
    '--file',
    composeFile,
    '--service',
    'postgres-restored',
  ];
  assert(
    (
      await cli(
        [...restoreArgs, '--backup', corrupt, '--database', 'workspace_corrupt_test'],
        false,
      )
    ).includes('backup_integrity_failed'),
  );
  assert.equal(
    await sql(
      'postgres-restored',
      'postgres',
      "SELECT count(*) FROM pg_database WHERE datname='workspace_corrupt_test'",
    ),
    '0',
  );
  assert(
    (
      await cli(
        [
          'restore',
          '--project',
          project,
          '--file',
          composeFile,
          '--backup',
          backupDirectory,
          '--database',
          'workspace_release_test',
        ],
        false,
      )
    ).includes('target_database_already_exists'),
  );
  assert.equal(await sql('postgres', 'workspace_release_test', fingerprint), dataBefore);
  checks.push(
    'Corrupt backup is rejected before database creation; an existing database is refused without any overwrite or content change.',
  );

  enterStage('restore_transaction_rollback');
  // Deliberately reseal a damaged compressed data stream. Its valid TOC and
  // matching test hash reach pg_restore, which must roll back its whole restore.
  const brokenStream = join(privateDirectory, 'broken-stream');
  await mkdir(brokenStream, { mode: 0o700 });
  const brokenBytes = await readFile(join(backupDirectory, 'database.dump'));
  brokenBytes[brokenBytes.length - 32]! ^= 0xff;
  await writeFile(join(brokenStream, 'database.dump'), brokenBytes, { mode: 0o600 });
  await writeFile(
    join(brokenStream, 'manifest.json'),
    JSON.stringify({
      ...manifest,
      archiveSha256: createHash('sha256').update(brokenBytes).digest('hex'),
    }),
  );
  const brokenResult = await cli(
    [...restoreArgs, '--backup', brokenStream, '--database', 'workspace_failed_restore_test'],
    false,
  );
  assert(
    brokenResult.includes('command_failed') || brokenResult.includes('command_reported_warning'),
  );
  assert.equal(
    await sql(
      'postgres-restored',
      'postgres',
      "SELECT count(*) FROM pg_database WHERE datname='workspace_failed_restore_test'",
    ),
    '1',
  );
  assert.equal(
    await sql(
      'postgres-restored',
      'workspace_failed_restore_test',
      "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename IN ('documents','schema_migrations')",
    ),
    '0',
  );
  checks.push(
    'A deliberately resealed damaged data stream passes preflight but fails inside pg_restore; single-transaction restoration leaves its newly created destination without partial application tables. Existing databases remain untouched.',
  );

  enterStage('source_removed_and_fresh_restore');
  await compose(['stop', '-t', '20', 'server', 'postgres', 'redis'], override);
  const restoredAt = performance.now();
  await cli([...restoreArgs, '--backup', backupDirectory, '--database', 'workspace_restored_test']);
  await compose(['up', '-d', '--build', '--wait', 'server-restored']);
  const destination = await endpoint('server-restored');
  const fresh = await connect(destination, document, 'restored-editor-1'),
    peer = await connect(destination, document, 'restored-editor-2');
  await equal(fresh, oracle);
  await equal(peer, oracle);
  await until(() =>
    [fresh, peer].every((c) => {
      const names = [...c.provider.awareness!.getStates().values()].map((s) => s.user?.name);
      return (
        names.includes('restored-editor-1') &&
        names.includes('restored-editor-2') &&
        !names.includes('source-editor')
      );
    }),
  );
  assert.equal(richState(fresh.doc), richState(oracle));
  report.restoreToFreshConfirmedReadMs = performance.now() - restoredAt;
  report.restoredSnapshotSha256 = createHash('sha256')
    .update(Y.encodeSnapshot(Y.snapshot(fresh.doc)))
    .digest('hex');
  const metadata = await fetch(destination + '/api/documents/' + document.id, {
    headers: { Authorization: 'Bearer ' + document.token },
  });
  assert.equal(metadata.status, 200);
  assert.equal((await metadata.json()).title, document.title);
  assert.equal(
    (
      await fetch(destination + '/api/documents/' + document.id, {
        headers: { Authorization: 'Bearer ' + 'x'.repeat(43) },
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await fetch(destination + '/api/documents/' + late.id, {
        headers: { Authorization: 'Bearer ' + late.token },
      })
    ).status,
    404,
  );
  checks.push(
    'With source application/PostgreSQL/Redis stopped and every old client destroyed, a separate restored deployment serves the original capability to empty fresh peers, preserving rich text, formatting and deletion-inclusive snapshots. Post-snapshot work is absent; wrong tokens remain denied; presence starts fresh.',
  );

  enterStage('restored_writes_and_restart');
  const restoredText = (fresh.doc.getXmlFragment('default').get(0) as Y.XmlElement).get(
    0,
  ) as Y.XmlText;
  restoredText.insert(restoredText.length, ' after restore');
  await until(() => fresh.tracker.state === 'saved' && completeStateEqual(fresh.doc, peer.doc));
  const afterRestore = new Y.Doc();
  Y.applyUpdate(afterRestore, Y.encodeStateAsUpdate(fresh.doc));
  closeClients();
  const destinationBefore = await sql('postgres-restored', 'workspace_restored_test', fingerprint);
  assert(
    (
      await cli(
        [...restoreArgs, '--backup', backupDirectory, '--database', 'workspace_restored_test'],
        false,
      )
    ).includes('target_database_already_exists'),
  );
  assert.equal(
    await sql('postgres-restored', 'workspace_restored_test', fingerprint),
    destinationBefore,
  );
  await compose(['kill', '-s', 'SIGKILL', 'server-restored']);
  await compose(['up', '-d', '--wait', 'server-restored']);
  const restarted = await connect(
    await endpoint('server-restored'),
    document,
    'restart-fresh-editor',
  );
  await equal(restarted, afterRestore);
  closeClients();
  afterRestore.destroy();
  const created = await create(await endpoint('server-restored'), 'new-document-after-restore');
  assert(created.id !== document.id);
  checks.push(
    'Restored peers can edit and obtain database confirmation; a later restore refuses the populated destination, and a SIGKILL/restart with another empty fresh client preserves new confirmed work. New document creation also succeeds.',
  );
  enterStage('backup_after_recovery');
  const recoveredBackup = join(privateDirectory, 'recovered-backup');
  const envFile = join(privateDirectory, 'owned.env');
  await writeFile(envFile, '# owned recovery fixture environment\n', { mode: 0o600 });
  await cli([
    'backup',
    '--project',
    project,
    '--file',
    composeFile,
    '--env-file',
    envFile,
    '--service',
    'postgres-restored',
    '--database',
    'workspace_restored_test',
    '--output',
    recoveredBackup,
  ]);
  const recoveredManifest = JSON.parse(
    await readFile(join(recoveredBackup, 'manifest.json'), 'utf8'),
  );
  assert.equal(recoveredManifest.database, 'workspace_restored_test');
  assert.equal(recoveredManifest.documentCount, '2');
  report.recoveredBackup = recoveredManifest;
  checks.push(
    'A new consistent backup can explicitly select the recovered application database while the PostgreSQL service default remains the maintenance database; explicit Compose environment files are supported.',
  );
  failed = false;
} catch (error: unknown) {
  report.failedStage = stage;
  const location =
    error instanceof Error ? error.stack?.match(/recovery\.(?:js|ts):(\d+):(\d+)/) : null;
  if (location) report.failureLocation = { line: Number(location[1]), column: Number(location[2]) };
  console.error(JSON.stringify({ event: 'release_drill_failed', stage, project }));
} finally {
  closeClients();
  oracle.destroy();
  try {
    await compose(['down', '--timeout', '20', '--remove-orphans']);
    report.cleanedUp = true;
  } catch {
    report.cleanedUp = false;
    failed = true;
  }
  report.completedAt = new Date().toISOString();
  report.passed = !failed;
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'recovery.json'), JSON.stringify(report, null, 2) + '\n');
  if (!failed) await rm(privateDirectory, { recursive: true });
  console.log(
    JSON.stringify({ event: 'release_drill_completed', passed: !failed, evidence: output }),
  );
}
process.exitCode = failed ? 1 : 0;
