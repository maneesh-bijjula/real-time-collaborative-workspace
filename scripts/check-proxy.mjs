import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { run, root, event } from './lib/compose.mjs';

let directory;
try {
  await mkdir(join(root, '.release-tmp'), { recursive: true, mode: 0o700 });
  directory = await mkdtemp(join(root, '.release-tmp/proxy-'));
  await run('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '1',
    '-subj',
    '/CN=commonplace.example.com',
    '-keyout',
    join(directory, 'privkey.pem'),
    '-out',
    join(directory, 'fullchain.pem'),
  ]);
  await run('docker', [
    'run',
    '--rm',
    '--network',
    'none',
    '-v',
    join(root, 'ops/nginx.production.example.conf') + ':/etc/nginx/conf.d/default.conf:ro',
    '-v',
    directory + ':/etc/letsencrypt/live/commonplace.example.com:ro',
    '--entrypoint',
    'nginx',
    'nginx:stable-alpine',
    '-t',
  ]);
  event('production_proxy_syntax_passed');
} catch {
  event('production_proxy_syntax_failed');
  process.exitCode = 1;
} finally {
  if (directory) await rm(directory, { recursive: true });
}
