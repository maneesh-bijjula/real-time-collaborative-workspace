import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { cpus, totalmem, platform, release, arch } from 'node:os';
import { performance } from 'node:perf_hooks';
import { createGzip } from 'node:zlib';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { resolve } from 'node:path';

const exec = promisify(execFile);
export const root = process.cwd();
if (
  JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')).name !==
  'real-time-collaborative-workspace'
)
  throw new Error('Run benchmark commands from the repository root');
export const services = ['server1', 'server2', 'server3', 'server4'];
export async function keepAwake() {
  if (process.platform !== 'darwin') return false;
  const child = spawn('/usr/bin/caffeinate', ['-i', '-w', String(process.pid)], {
    stdio: 'ignore',
  });
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  child.unref(); // The assertion ends automatically when this controller exits.
  return true;
}
const operatorToken = 'benchmark-disposable-metrics-only-0123456789';
export async function command(file: string, args: string[], timeout = 180000): Promise<string> {
  const result = await exec(file, args, { cwd: root, timeout, maxBuffer: 16 * 1024 * 1024 });
  return result.stdout.trim();
}
export async function sleep(ms: number) {
  if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
}
export async function until(test: () => boolean | Promise<boolean>, timeout = 10000) {
  const end = performance.now() + timeout;
  while (!(await test())) {
    if (performance.now() >= end)
      throw new Error('Benchmark convergence/dependency deadline exceeded');
    await sleep(10);
  }
}
export async function json(path: string, value: unknown) {
  await writeFile(path, JSON.stringify(value, null, 2) + '\n');
}
export async function gzipLines(path: string, rows: Iterable<unknown>) {
  await pipeline(
    Readable.from(
      (function* () {
        for (const row of rows) yield JSON.stringify(row) + '\n';
      })(),
    ),
    createGzip({ level: 6 }),
    createWriteStream(path, { flags: 'wx' }),
  );
}
async function sourceFiles(folder: string): Promise<string[]> {
  const result: string[] = [];
  for (const item of await readdir(resolve(root, folder), { withFileTypes: true })) {
    const path = folder + '/' + item.name;
    if (item.isDirectory()) result.push(...(await sourceFiles(path)));
    else result.push(path);
  }
  return result;
}
export async function revision() {
  const files = [
    ...(await sourceFiles('apps/server/src')),
    ...(await sourceFiles('benchmarks')),
    'package.json',
    'apps/server/package.json',
    'package-lock.json',
    'Dockerfile',
    'compose.benchmark.yaml',
    'tsconfig.benchmark.json',
    'apps/web/lib/collaboration-session.ts',
    'apps/web/lib/database-save.ts',
  ].sort();
  const hashes: Record<string, string> = {};
  for (const path of files)
    hashes[path] = createHash('sha256')
      .update(await readFile(resolve(root, path)))
      .digest('hex');
  return {
    commit: await command('git', ['rev-parse', 'HEAD']),
    dirty: await command('git', ['status', '--porcelain']),
    sourceSha256: createHash('sha256').update(JSON.stringify(hashes)).digest('hex'),
    files: hashes,
  };
}
export class Deployment {
  readonly project = 'commonplace-bench-' + Date.now() + '-' + randomUUID().slice(0, 8);
  endpoints: string[] = [];
  private closed = false;
  compose(args: string[], timeout?: number) {
    return command(
      'docker',
      ['compose', '-p', this.project, '-f', 'compose.benchmark.yaml', ...args],
      timeout,
    );
  }
  async start() {
    await this.compose(['up', '-d', '--build', '--wait'], 240000);
    this.endpoints = await Promise.all(
      services.map(async (service) => {
        const port = await this.compose(['port', service, '4000']);
        if (!/^127\.0\.0\.1:\d+$/.test(port)) throw new Error('Unexpected benchmark binding');
        return 'http://' + port;
      }),
    );
    await until(async () =>
      (
        await Promise.all(
          this.endpoints.map(
            async (url) =>
              (await fetch(url + '/ready', { signal: AbortSignal.timeout(2500) })).status === 200,
          ),
        )
      ).every(Boolean),
    );
  }
  async environment() {
    const ids = (await this.compose(['ps', '-q'])).split('\n').filter(Boolean);
    const inspected = JSON.parse(await command('docker', ['inspect', ...ids]));
    const serverPids = inspected
      .filter((x: any) => services.includes(x.Config.Labels['com.docker.compose.service']))
      .map((x: any) => x.State.Pid);
    if (new Set(serverPids).size !== 4 || serverPids.some((pid: number) => pid <= 0))
      throw new Error('Benchmark requires four distinct running container processes');
    const info = JSON.parse(await command('docker', ['info', '--format', '{{json .}}']));
    const imageIds = [...new Set<string>(inspected.map((x: any) => x.Image))];
    const images = JSON.parse(await command('docker', ['image', 'inspect', ...imageIds]));
    return {
      host: {
        os: platform(),
        release: release(),
        arch: arch(),
        cpu: cpus()[0]?.model,
        logicalCpus: cpus().length,
        memoryBytes: totalmem(),
        node: process.version,
      },
      docker: {
        os: info.OperatingSystem,
        architecture: info.Architecture,
        cpus: info.NCPU,
        memoryBytes: info.MemTotal,
        version: info.ServerVersion,
      },
      serverNode: await this.compose(['exec', '-T', 'server1', 'node', '--version']),
      processPlacement:
        'One host: macOS/host Node measurement controller; four independent Node containers and PostgreSQL/Redis in Docker (Linux on CI). No WAN.',
      containers: inspected.map((x: any) => ({
        service: x.Config.Labels['com.docker.compose.service'],
        image: x.Image,
        hostPid: x.State.Pid,
        cpuLimit: x.HostConfig.NanoCpus,
        memoryLimit: x.HostConfig.Memory,
      })),
      images: images.map((x: any) => ({
        id: x.Id,
        digests: x.RepoDigests,
        os: x.Os,
        architecture: x.Architecture,
      })),
    };
  }
  async dependencies() {
    const pg = await this.compose([
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      'workspace',
      '-d',
      'workspace_benchmark_test',
      '-Atc',
      'SELECT row_to_json(s) FROM (SELECT numbackends,xact_commit,xact_rollback,blks_read,blks_hit,tup_returned,tup_fetched,tup_inserted,tup_updated,tup_deleted,temp_bytes,deadlocks FROM pg_stat_database WHERE datname=current_database()) s',
    ]);
    const redis = await this.compose(['exec', '-T', 'redis', 'redis-cli', 'INFO']);
    const allowed =
      /^(used_memory|used_memory_peak|connected_clients|total_commands_processed|total_net_input_bytes|total_net_output_bytes|rejected_connections|instantaneous_ops_per_sec|pubsub_channels|evicted_keys|blocked_clients):/;
    return {
      postgres: JSON.parse(pg),
      redis: Object.fromEntries(
        redis
          .split(/\r?\n/)
          .filter((line) => allowed.test(line))
          .map((line) => {
            const [key, value] = line.split(':');
            return [key, Number(value)];
          }),
      ),
    };
  }
  async metrics() {
    return Promise.all(
      this.endpoints.map(async (url, node) => {
        try {
          const response = await fetch(url + '/metrics', {
            headers: { Authorization: `Bearer ${operatorToken}` },
            signal: AbortSignal.timeout(2000),
          });
          if (!response.ok) throw new Error('Metrics response failed');
          return { node, text: await response.text() };
        } catch {
          return { node, unavailable: true };
        }
      }),
    );
  }
  async resources() {
    const ids = (await this.compose(['ps', '-q'])).split('\n').filter(Boolean);
    const lines = await command(
      'docker',
      ['stats', '--no-stream', '--format', '{{json .}}', ...ids],
      15000,
    );
    return lines
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const x = JSON.parse(line);
        return {
          service: x.Name.replace(this.project + '-', '').replace(/-\d+$/, ''),
          cpuPercent: parseFloat(x.CPUPerc),
          memory: x.MemUsage,
          memoryPercent: parseFloat(x.MemPerc),
          network: x.NetIO,
          blockIO: x.BlockIO,
          pids: Number(x.PIDs),
        };
      });
  }
  async stop() {
    if (this.closed) return;
    this.closed = true;
    await this.compose(['down', '--timeout', '20']);
  }
}
export async function outputDirectory(path: string) {
  const directory = resolve(root, path);
  // Refuse overwrites; benchmark evidence is append-only by directory.
  await mkdir(directory, { recursive: false });
  return directory;
}
