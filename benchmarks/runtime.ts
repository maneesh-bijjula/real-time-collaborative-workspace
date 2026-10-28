import { execFile, spawn, fork, type ChildProcess } from 'node:child_process';
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
    ...(await sourceFiles('apps/server/migrations')),
    ...(await sourceFiles('benchmarks')),
    'package.json',
    'apps/server/package.json',
    'apps/server/tsconfig.json',
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
  private readonly native: { child: ChildProcess; port: number; pid: number; node: string }[] = [];
  readonly shutdownCodes: (number | null)[] = [];
  constructor(readonly mode: 'containers' | 'native' = 'containers') {}
  compose(args: string[], timeout?: number) {
    return command(
      'docker',
      ['compose', '-p', this.project, '-f', 'compose.benchmark.yaml', ...args],
      timeout,
    );
  }
  async start() {
    await this.compose(
      ['up', '-d', '--build', '--wait', ...(this.mode === 'native' ? ['postgres', 'redis'] : [])],
      240000,
    );
    if (this.mode === 'native') {
      await command('npm', ['run', 'build', '-w', 'apps/server']);
      const pg = await this.compose(['port', 'postgres', '5432']),
        redis = await this.compose(['port', 'redis', '6379']);
      if (![pg, redis].every((port) => /^127\.0\.0\.1:\d+$/.test(port)))
        throw new Error('Unexpected native dependency binding');
      for (let i = 0; i < 4; i++) {
        const child = fork(resolve(import.meta.dirname, 'native-server.js'), [], {
          cwd: root,
          execArgv: [],
          env: {
            ...process.env,
            NODE_ENV: 'production',
            NODE_OPTIONS: '',
            BENCH_DATABASE_URL: `postgres://workspace:benchmark-disposable-only@${pg}/workspace_benchmark_test`,
            BENCH_REDIS_URL: `redis://${redis}`,
          },
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        });
        const entry = { child, pid: child.pid!, port: 0, node: '' };
        child.on('error', () => {});
        this.native.push(entry);
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error('Native benchmark startup deadline')),
            15000,
          );
          const failed = () => {
            clearTimeout(timer);
            reject(new Error('Native benchmark startup failed'));
          };
          child.once('error', failed);
          child.once('exit', failed);
          child.once('message', (value: any) => {
            clearTimeout(timer);
            child.off('error', failed);
            child.off('exit', failed);
            if (value.type !== 'ready' || value.pid !== child.pid || !Number.isInteger(value.port))
              return reject(new Error('Invalid native ready message'));
            entry.port = value.port;
            entry.node = value.node;
            resolve();
          });
        });
      }
      this.endpoints = this.native.map((node) => `http://127.0.0.1:${node.port}`);
    } else
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
    const pids = this.mode === 'native' ? this.native.map((node) => node.pid) : serverPids;
    if (new Set(pids).size !== 4 || pids.some((pid: number) => pid <= 0))
      throw new Error('Benchmark requires four distinct running Node processes');
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
      runtime: this.mode,
      serverNode:
        this.mode === 'native'
          ? this.native[0]!.node
          : await this.compose(['exec', '-T', 'server1', 'node', '--version']),
      nativeProcesses: this.native.map((node, index) => ({
        node: index,
        pid: node.pid,
        version: node.node,
      })),
      processPlacement:
        this.mode === 'native'
          ? 'One host: controller and four independent native production Node processes; isolated PostgreSQL/Redis containers. No WAN.'
          : 'One host: controller and four independent Node containers; PostgreSQL/Redis in Docker. No WAN.',
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
    if (!ids.length) throw new Error('Owned benchmark services unavailable');
    const lines = await command(
      'docker',
      ['stats', '--no-stream', '--format', '{{json .}}', ...ids],
      15000,
    );
    const containers = lines
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
    const processes = await Promise.all(
      this.native.map(async (node, index) => {
        const id = randomUUID();
        const sample = await new Promise<{ cpuPercent: number; rssBytes: number }>(
          (resolve, reject) => {
            const timer = setTimeout(() => {
              node.child.off('message', listener);
              reject(new Error('Native sample deadline'));
            }, 5000);
            const listener = (value: any) => {
              if (value.id !== id) return;
              clearTimeout(timer);
              node.child.off('message', listener);
              resolve(value);
            };
            node.child.on('message', listener);
            node.child.send({ id, command: 'resources' });
          },
        );
        return {
          service: `server${index + 1}`,
          cpuPercent: sample.cpuPercent,
          memory: `${sample.rssBytes} B`,
          memoryPercent: (sample.rssBytes / totalmem()) * 100,
          network: 'not sampled',
          blockIO: 'not sampled',
          pids: 1,
          rssBytes: sample.rssBytes,
        };
      }),
    );
    return [...containers, ...processes];
  }
  async stop() {
    if (this.closed) return;
    this.closed = true;
    await Promise.all(
      this.native.map(async (node, index) => {
        if (node.child.exitCode !== null || node.child.signalCode !== null) {
          this.shutdownCodes[index] = node.child.exitCode;
          return;
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => node.child.kill('SIGKILL'), 20000).unref();
          node.child.once('exit', (code) => {
            clearTimeout(timer);
            this.shutdownCodes[index] = code;
            resolve();
          });
          node.child.kill('SIGTERM');
        });
      }),
    );
    await this.compose(['down', '--timeout', '20']);
  }
}
export async function outputDirectory(path: string) {
  const directory = resolve(root, path);
  // Refuse overwrites; benchmark evidence is append-only by directory.
  await mkdir(directory, { recursive: false });
  return directory;
}
