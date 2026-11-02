import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Session } from 'node:inspector';
import { performance } from 'node:perf_hooks';
import { analyze } from './analysis.js';
import { load } from './load.js';
import { workerLoad } from './worker-load.js';
import { reconnect as runReconnect } from './reconnect.js';
import {
  Deployment,
  gzipLines,
  json,
  keepAwake,
  outputDirectory,
  revision,
  root,
} from './runtime.js';
import {
  primary,
  characterizations,
  reconnect,
  backlog,
  smokeLoad,
  smokeReconnect,
} from './workloads.js';

const { values } = parseArgs({
  options: {
    suite: { type: 'string', default: 'smoke' },
    output: { type: 'string' },
    runtime: { type: 'string', default: 'containers' },
    clients: { type: 'string', default: 'workers' },
    'controller-pause-ms': { type: 'string', default: '0' },
  },
});
if (!['smoke', 'full', 'diagnostic'].includes(values.suite!))
  throw new Error('Use --suite smoke, full or diagnostic');
const suite = values.suite!;
const controllerPauseMs = Number(values['controller-pause-ms']);
if (
  !Number.isInteger(controllerPauseMs) ||
  controllerPauseMs < 0 ||
  controllerPauseMs > 2000 ||
  (controllerPauseMs && (suite !== 'smoke' || values.clients !== 'workers'))
)
  throw new Error('Controller pause injection is limited to worker correctness smoke (0–2000ms)');
if (!['inline', 'workers'].includes(values.clients!))
  throw new Error('Use --clients inline or workers');
if (!['containers', 'native'].includes(values.runtime!))
  throw new Error('Use --runtime containers or native');
const path =
  values.output ||
  `test-results/benchmarks/${suite}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
await mkdir(dirname(resolve(root, path)), { recursive: true });
const output = await outputDirectory(path);
const deployment = new Deployment(values.runtime as 'containers' | 'native');
const source = await revision();
const manifest: Record<string, unknown> = {
  schemaVersion: 1,
  suite,
  startedAt: new Date().toISOString(),
  source,
  workloadVersion: 1,
  executionVersion: 4,
  clientExecution: values.clients,
  controllerPauseMs,
  runtime: values.runtime,
  deploymentProject: deployment.project,
  idleSleepInhibited: await keepAwake(),
  profiles:
    suite === 'full'
      ? [primary, ...characterizations, reconnect, backlog]
      : suite === 'diagnostic'
        ? [{ ...primary, repeats: 1 }]
        : [smokeLoad, smokeReconnect],
  schema: {
    operations:
      'JSONL objects: mutation index, writer/node/document indices, sequence/kind, scheduled/started milliseconds from run start, Yjs update bytes',
    samples:
      'JSONL tuples [operation index, recipient index, source-mutation-to-peer-application milliseconds]; source and other-document recipients excluded',
    quantiles:
      'Nearest rank, ceil(p*N); p95 target is strict <100ms; no outlier trimming. Missing samples fail.',
    reconnect:
      'Explicit healthy-network restoration to full content/format/deletion/presence convergence on all 50 peers. Controlled disconnection; excludes silent failure detection.',
    safety:
      'Own unique Compose project, random loopback ports, tmpfs _test database, no application volumes, no credentials/content in results.',
  },
};
await json(`${output}/manifest.json`, manifest);
const results: unknown[] = [];
let failed = false;
let stage = 'deployment_start';
let profiler: Session | undefined;
try {
  console.log(`Starting ${suite} benchmark; artifacts: ${output}`);
  await deployment.start();
  manifest.environment = await deployment.environment();
  await json(`${output}/manifest.json`, manifest);
  profiler = suite === 'diagnostic' ? new Session() : undefined;
  profiler?.connect();
  if (profiler) {
    const session = profiler;
    await new Promise<void>((resolve, reject) =>
      session.post('Profiler.enable', (e) => (e ? reject(e) : resolve())),
    );
    await new Promise<void>((resolve, reject) =>
      session.post('Profiler.start', (e) => (e ? reject(e) : resolve())),
    );
    manifest.profileStartedAtMs = performance.now();
  }
  for (const profile of suite === 'full'
    ? [primary, ...characterizations]
    : suite === 'diagnostic'
      ? [{ ...primary, repeats: 1 }]
      : [smokeLoad]) {
    for (let repeat = 1; repeat <= profile.repeats; repeat++) {
      console.log(`Running ${profile.id} ${repeat}/${profile.repeats}`);
      stage = `${profile.id}-${repeat}`;
      const result =
        values.clients === 'inline'
          ? await load(deployment, profile, repeat, output)
          : await workerLoad(deployment, profile, repeat, output, controllerPauseMs);
      results.push(result);
      if (profile.primary && !result.passed) failed = true;
      if (
        suite === 'smoke' &&
        (!result.correctness || result.latencyMs.missing || result.errors.length)
      )
        failed = true;
      console.log(
        `${result.name}: p95 ${result.latencyMs.p95?.toFixed(2)} ms, missing ${result.latencyMs.missing}, passed ${result.passed}`,
      );
      await json(`${output}/results.json`, {
        results,
        primaryTargetsPassed: null,
        inProgress: true,
      });
    }
  }
  if (profiler) {
    const session = profiler;
    const profile = await new Promise<unknown>((resolve, reject) =>
      session.post('Profiler.stop', (e, value) => (e ? reject(e) : resolve(value.profile))),
    );
    profiler.disconnect();
    profiler = undefined;
    await gzipLines(`${output}/controller.cpuprofile.jsonl.gz`, [profile]);
  }
  for (const profile of suite === 'full'
    ? [reconnect, backlog]
    : suite === 'diagnostic'
      ? []
      : [smokeReconnect]) {
    stage = profile.id;
    const result = await runReconnect(deployment, profile, output);
    results.push(result);
    if (profile.primary && !result.passed) failed = true;
    if (
      suite === 'smoke' &&
      (result.completed !== profile.trials || result.timeouts || result.errors.length)
    )
      failed = true;
    await json(`${output}/results.json`, { results, primaryTargetsPassed: null, inProgress: true });
  }
} catch {
  failed = true;
  // Keep failure evidence without serializing command/configuration errors.
  manifest.fatal =
    'Benchmark setup/execution failed; incomplete results must not establish a target.';
  manifest.failedStage = stage;
  console.error(manifest.fatal);
} finally {
  profiler?.disconnect();
  try {
    await deployment.stop();
    manifest.cleanedUp = true;
    manifest.nativeShutdownCodes = deployment.shutdownCodes;
    if (deployment.shutdownCodes.some((code) => code !== 0)) failed = true;
  } catch {
    manifest.cleanedUp = false;
    failed = true;
    console.error('Disposable benchmark cleanup failed: ' + deployment.project);
  }
  manifest.completedAt = new Date().toISOString();
  manifest.primaryTargetsPassed = suite === 'full' ? !failed : null;
  await json(`${output}/manifest.json`, manifest);
  await json(`${output}/results.json`, {
    results,
    primaryTargetsPassed: suite === 'full' ? !failed : null,
    smokePassed: suite === 'smoke' ? !failed : null,
  });
  try {
    const report = await analyze(output);
    await json(`${output}/analysis.json`, report);
    if (suite === 'full' && !report.primaryTargetsPassed) failed = true;
  } catch {
    failed = true;
    manifest.analysisFailed = true;
  }
  manifest.primaryTargetsPassed = suite === 'full' ? !failed : null;
  await json(`${output}/manifest.json`, manifest);
  await json(`${output}/results.json`, {
    results,
    primaryTargetsPassed: suite === 'full' ? !failed : null,
    smokePassed: suite === 'smoke' ? !failed : null,
  });
}
process.exitCode = failed ? 1 : 0;
