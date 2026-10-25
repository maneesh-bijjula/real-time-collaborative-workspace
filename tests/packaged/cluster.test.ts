import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { HocuspocusProvider } from '@hocuspocus/provider';
import * as Y from 'yjs';
import { CollaborationSession } from '../../apps/web/lib/collaboration-session';
import { DatabaseSaveTracker } from '../../apps/web/lib/database-save';

import { test } from 'vitest';

test('packaged Redis outage and gateway failover', async () => {
  // This command intentionally injects faults only into the disposable topology.
  const project = process.env.CLUSTER_VERIFY_PROJECT || 'commonplace-verify';
  assert(
    ['commonplace-verify', 'commonplace-sprint2-verify', 'commonplace-sprint3-verify'].includes(
      project,
    ),
    'Only the named disposable verification projects are allowed',
  );
  const execute = promisify(execFile);
  const composeArgs = [
    'compose',
    '-p',
    project,
    '-f',
    'compose.verify.yaml',
    '-f',
    'compose.cluster.yaml',
  ];
  async function compose(...args: string[]) {
    return (await execute('docker', [...composeArgs, ...args], { timeout: 120000 })).stdout;
  }
  const configuration = JSON.parse(await compose('config', '--format', 'json'));
  assert(configuration.services.postgres.tmpfs?.includes('/var/lib/postgresql/data'));
  assert.equal(configuration.services.postgres.environment.POSTGRES_DB, 'workspace_verify_test');
  assert(!configuration.services.postgres.volumes?.length, 'Persistent volumes are not permitted');
  const services = ['server', 'server2', 'server3', 'server4'];
  type Client = {
    doc: Y.Doc;
    provider: HocuspocusProvider;
    session: CollaborationSession;
    tracker: DatabaseSaveTracker;
    text: Y.Text;
  };
  const clients: Client[] = [];
  function makeClient(document: { id: string; token: string }, port: number): Client {
    const doc = new Y.Doc();
    const provider = new HocuspocusProvider({
      url: `ws://localhost:${port}/collaboration`,
      name: document.id,
      token: document.token,
      document: doc,
    });
    const session = new CollaborationSession(provider);
    const tracker = new DatabaseSaveTracker(doc, provider, () => {});
    const client = { doc, provider, session, tracker, text: doc.getText('packaged-verification') };
    clients.push(client);
    return client;
  }
  async function waitFor(check: () => void, timeout = 20000) {
    const deadline = Date.now() + timeout;
    for (;;) {
      try {
        check();
        return;
      } catch (error) {
        if (Date.now() >= deadline) throw error;
        await delay(50);
      }
    }
  }
  async function converged() {
    await waitFor(() => {
      for (const c of clients) {
        assert(c.provider.synced && c.provider.isAuthenticated, 'Client is not synchronized');
        assert(
          Y.equalSnapshots(Y.snapshot(c.doc), Y.snapshot(clients[0]!.doc)),
          'Snapshots differ',
        );
        assert.deepEqual(c.text.toDelta(), clients[0]!.text.toDelta());
        assert.equal(c.tracker.state, 'saved', 'Current snapshot lacks database confirmation');
      }
    }, 30000);
  }
  const checks: string[] = [];
  let failed = true;
  try {
    const response = await fetch('http://localhost:4200/api/documents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Disposable packaged cluster verification' }),
    });
    assert.equal(response.status, 201);
    const document = (await response.json()) as { id: string; token: string };
    const pinned = [4100, 4101, 4102, 4103].map((port) => makeClient(document, port));
    const observer = makeClient(document, 4200);
    await converged();
    pinned[0]!.text.insert(0, 'abcdef');
    await converged();
    checks.push(
      'Four direct server endpoints and shared gateway synchronize with committed save confirmation',
    );

    await compose('stop', '-t', '1', 'redis');
    await delay(300);
    for (const port of [4100, 4101, 4102, 4103]) {
      assert.equal((await fetch(`http://localhost:${port}/live`)).status, 200);
      assert.equal((await fetch(`http://localhost:${port}/ready`)).status, 503);
      const metrics = await fetch(`http://localhost:${port}/metrics`, {
        headers: { Authorization: 'Bearer commonplace-verification-metrics-only-0123456789' },
      });
      assert.equal(metrics.status, 200);
      assert(
        (await metrics.text()).includes(
          'commonplace_dependency_up{dependency="redis_subscriber"} 0',
        ),
      );
    }
    checks.push(
      'Every instance stays live, becomes unready and reports unavailable Redis telemetry during the real Redis outage',
    );
    pinned.forEach((c, i) => {
      c.text.delete(0, 1);
      c.text.insert(0, `partition-${i};`);
      c.text.format(0, 3, { bold: true });
    });
    await delay(500);
    await compose('start', 'redis');
    // No further edits are made after Redis returns.
    await converged();
    for (let i = 0; i < 4; i++) assert(observer.text.toString().includes(`partition-${i};`));
    for (const port of [4100, 4101, 4102, 4103]) {
      assert.equal((await fetch(`http://localhost:${port}/health`)).status, 200);
    }
    checks.push(
      'Real Redis container stop/start preserves all Node processes and repairs divergent inserts, deletes and formatting without another edit',
    );

    let observerClosed = false;
    observer.provider.on('status', ({ status }: { status: string }) => {
      if (status === 'disconnected') observerClosed = true;
    });
    let failedOver = false;
    for (const service of services) {
      observerClosed = false;
      await compose('kill', '-s', 'SIGKILL', service);
      await delay(750);
      if (observerClosed) {
        // The killed backend stays down until the gateway client has rejoined
        // a surviving backend. A successful reconnect cannot use the old node.
        await waitFor(() => {
          assert(observer.provider.synced && observer.provider.isAuthenticated);
          assert.equal(observer.tracker.state, 'saved');
        });
        assert.deepEqual(
          observer.text.toDelta(),
          pinned.find((c) => c.provider.synced)!.text.toDelta(),
        );
        failedOver = true;
      }
      await compose('up', '-d', '--wait', service);
      await converged();
      if (failedOver) break;
    }
    assert(failedOver, 'The gateway observer did not encounter a killed backend');
    checks.push(
      'Gateway reconnects to a surviving node while its original backend remains stopped; restarted pinned clients recover exact committed state',
    );
    failed = false;
    const result = {
      schemaVersion: 1,
      verifiedAt: new Date().toISOString(),
      topology: '4 Node containers, 1 nginx gateway, PostgreSQL 17, Redis 8',
      clients: 5,
      checks,
      scope:
        'Single-host functional fault verification. Polling bounds are test deadlines, not latency percentiles or a resume benchmark.',
    };
    await mkdir('test-results', { recursive: true });
    await writeFile(
      'test-results/cluster-verification.json',
      JSON.stringify(result, null, 2) + '\n',
    );
    console.log(JSON.stringify(result, null, 2));
  } finally {
    for (const c of clients) {
      c.tracker.destroy();
      c.session.destroy();
      c.provider.destroy();
      c.doc.destroy();
    }
    if (failed) {
      // Restore only these explicitly guarded disposable services after a failed probe.
      await compose('start', 'redis');
      await compose('up', '-d', '--wait', ...services);
    }
  }
}, 150000);
