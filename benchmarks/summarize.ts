import { parseArgs } from 'node:util';
import { analyze } from './analysis.js';
import { json } from './runtime.js';
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { check: { type: 'boolean', default: false } },
});
if (positionals.length !== 1)
  throw new Error('Usage: npm run benchmark:summarize -- <result-directory> [--check]');
const report = await analyze(positionals[0]!);
await json(`${positionals[0]}/analysis.json`, report);
for (const result of report.loads)
  console.log(
    `${result.name}: p95=${result.latencyMs.p95?.toFixed(2)}ms, missing=${result.latencyMs.missing}, passed=${result.passed}`,
  );
for (const result of report.reconnect)
  console.log(
    `${result.profile.id}: p95=${result.durationMs.p95?.toFixed(2)}ms, max=${result.durationMs.max?.toFixed(2)}ms, missing=${result.missing}, failed=${result.failed}`,
  );
console.log('Full primary targets passed: ' + report.primaryTargetsPassed);
if (values.check && !report.primaryTargetsPassed) process.exitCode = 1;
