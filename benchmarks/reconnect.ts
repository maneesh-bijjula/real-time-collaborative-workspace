import { performance } from 'node:perf_hooks';
import * as Y from 'yjs';
import { Group } from './clients.js';
import { Collector } from './collector.js';
import { Deployment, gzipLines, json, sleep, until } from './runtime.js';
import { mutate, type ReconnectProfile } from './workloads.js';
import { distribution } from './stats.js';

export async function reconnect(deployment: Deployment, profile: ReconnectProfile, output: string) {
  const group = new Group(deployment.endpoints);
  const collector = new Collector(deployment);
  const trials: {
    trial: number;
    affected: { writer: number; from: number; to: number }[];
    offlineMs: number;
    backlogUpdateBytes: number;
    elapsedMs: number;
    converged: boolean;
    underTarget: boolean;
  }[] = [];
  let initialBytes = 0,
    finalBytes = 0;
  const errors: string[] = [];
  try {
    await group.create(profile.writers, 1, profile.seedTextBytes);
    await group.durable();
    initialBytes = Y.encodeStateAsUpdate(group.clients[0]!.doc).length;
    collector.start();
    for (let trial = 0; trial < profile.trials; trial++) {
      const affected = Array.from(
        { length: profile.affected },
        (_, j) => group.clients[(trial * profile.affected + j) % profile.writers]!,
      );
      const observer = group.clients.find((c) => !affected.includes(c))!;
      const movement = affected.map((c) => ({
        writer: c.index,
        from: c.node,
        to: (c.node + 1) % 4,
      }));
      affected.forEach((c) => c.provider.disconnect());
      await until(() =>
        affected.every((c) => c.provider.configuration.websocketProvider.status === 'disconnected'),
      );
      for (const move of movement) {
        // Preserve the provider/Y.Doc/awareness clocks; switch only the physical
        // endpoint while disconnected. This is explicit network restoration.
        group.clients[move.writer]!.provider.configuration.websocketProvider.setConfiguration({
          url: deployment.endpoints[move.to]!.replace('http:', 'ws:') + '/collaboration',
        });
      }
      let backlogBytes = 0;
      const listeners = affected.map((c) => {
        const listener = (update: Uint8Array, origin: unknown) => {
          if (origin === 'benchmark-local') backlogBytes += update.length;
        };
        c.doc.on('update', listener);
        return listener;
      });
      const offline = performance.now();
      const rounds = Math.max(profile.mutationsPerActor, profile.observerMutations);
      for (let step = 0; step < rounds; step++) {
        await sleep(offline + (step * profile.offlineMs) / rounds - performance.now());
        const actors = [
          ...(step < profile.mutationsPerActor ? affected : []),
          ...(step < profile.observerMutations ? [observer] : []),
        ];
        for (const client of actors) {
          client.sequence++;
          mutate(client.doc, client.index, client.sequence, group.documents[0]!.actors);
          mutate(
            group.documents[0]!.reference,
            client.index,
            client.sequence,
            group.documents[0]!.actors,
          );
        }
      }
      await sleep(offline + profile.offlineMs - performance.now());
      affected.forEach((c, i) => c.doc.off('update', listeners[i]!));
      const offlineMs = performance.now() - offline;
      const restored = performance.now();
      for (const move of movement) {
        const client = group.clients[move.writer]!;
        client.node = move.to;
        void client.provider.connect().catch(() => {});
      }
      let converged = false;
      try {
        await group.converge(true, 10000);
        converged = true;
      } catch {
        errors.push(`trial_${trial + 1}_timeout_or_divergence`);
      }
      const elapsedMs = performance.now() - restored;
      trials.push({
        trial: trial + 1,
        affected: movement,
        offlineMs,
        backlogUpdateBytes: backlogBytes,
        elapsedMs,
        converged,
        underTarget: converged && elapsedMs < profile.deadlineMs,
      });
      console.log(
        `${profile.id}: trial ${trial + 1}/${profile.trials} ${elapsedMs.toFixed(1)} ms${converged ? '' : ' FAILED'}`,
      );
      if (!converged) break; // Remaining trials explicitly count as missing.
      await group.durable();
    }
    finalBytes = Y.encodeStateAsUpdate(group.clients[0]!.doc).length;
    if (group.clients.some((c) => c.failures || c.session.blocked))
      errors.push('authentication_or_policy_failure');
  } catch {
    errors.push('setup_or_execution_failed');
  } finally {
    await gzipLines(`${output}/${profile.id}.telemetry.jsonl.gz`, [await collector.stop()]);
    group.close();
  }
  const summary = {
    schemaVersion: 1,
    type: 'reconnect',
    profile,
    trials,
    completed: trials.length,
    missing: profile.trials - trials.length,
    failed: trials.filter((t) => !t.underTarget).length,
    timeouts: trials.filter((t) => !t.converged).length,
    durationMs: distribution(trials.map((t) => t.elapsedMs)),
    initialBytes,
    finalBytes,
    errors,
    passed:
      trials.length === profile.trials && trials.every((t) => t.underTarget) && errors.length === 0,
  };
  await json(`${output}/${profile.id}.summary.json`, summary);
  return summary;
}
