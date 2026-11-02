import { parseArgs } from 'node:util';
import { mkdir, open, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join, dirname } from 'node:path';
import { Compose, run, OperationError, event, root } from './lib/compose.mjs';
import { migrationFiles } from './lib/backup.mjs';

try {
  const { values } = parseArgs({
    options: {
      project: { type: 'string' },
      'env-file': { type: 'string' },
      file: { type: 'string', multiple: true },
      output: { type: 'string' },
      'require-source-match': { type: 'boolean', default: false },
    },
  });
  if (!values.output) throw new OperationError('new_release_output_required');
  const compose = new Compose(values.project, values.file, values['env-file']);
  const commit = await run('git', ['rev-parse', 'HEAD']),
    dirty = await run('git', ['status', '--porcelain']);
  const ids = (await compose.run(['ps', '-q'])).split('\n').filter(Boolean);
  if (!ids.length || ids.some((id) => !/^[a-f0-9]+$/.test(id)))
    throw new OperationError('release_services_unavailable');
  const containers = JSON.parse(await run('docker', ['inspect', ...ids]));
  const services = containers.map((c) => ({
    service: c.Config.Labels['com.docker.compose.service'],
    imageId: c.Image,
    revision: c.Config.Labels['org.opencontainers.image.revision'] ?? null,
    running: c.State.Running,
  }));
  const application = services.filter((s) => s.service.startsWith('server') || s.service === 'web');
  const matches =
    !dirty &&
    application.length >= 2 &&
    application.some((s) => s.service === 'web') &&
    application.every((s) => s.running && s.revision === commit);
  if (values['require-source-match'] && !matches)
    throw new OperationError('release_images_do_not_match_clean_source');
  const images = JSON.parse(
    await run('docker', ['image', 'inspect', ...new Set(services.map((s) => s.imageId))]),
  );
  const manifest = {
    schemaVersion: 1,
    recordedAt: new Date().toISOString(),
    project: values.project,
    source: {
      commit,
      dirty,
      lockfileSha256: createHash('sha256')
        .update(await readFile(join(root, 'package-lock.json')))
        .digest('hex'),
    },
    allApplicationImagesMatchCleanSource: matches,
    migrations: await migrationFiles(),
    services,
    images: images.map((i) => ({
      id: i.Id,
      repoDigests: i.RepoDigests,
      architecture: i.Architecture,
      os: i.Os,
    })),
    scope:
      'Read-only image/source inventory. It does not certify external TLS, secrets, backup policy or deployment health; use the release and recovery checks.',
  };
  const directory = resolve(values.output);
  await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
  await mkdir(directory, { mode: 0o700 });
  const file = await open(join(directory, 'manifest.json'), 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(manifest, null, 2) + '\n');
    await file.sync();
  } finally {
    await file.close();
  }
  event('release_manifest_recorded', { sourceMatch: matches });
} catch (error) {
  event('release_manifest_failed', {
    reason: error instanceof OperationError ? error.reason : 'release_inventory_failed',
  });
  process.exitCode = 1;
}
