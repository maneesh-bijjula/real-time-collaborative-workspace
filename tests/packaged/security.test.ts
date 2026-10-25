import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { test, vi } from 'vitest';
import { HocuspocusProvider } from '@hocuspocus/provider';
import * as Y from 'yjs';
import { DatabaseSaveTracker } from '../../apps/web/lib/database-save';
import { auth, messageType, rawClient } from '../helpers/wire';

const metricsToken = 'commonplace-verification-metrics-only-0123456789';
test('packaged four-instance authorization and protected operations', async () => {
  const response = await fetch('http://localhost:4100/api/documents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'private-packaged-title-sentinel' }),
  });
  assert.equal(response.status, 201);
  const document = (await response.json()) as { id: string; token: string };
  const clients = [4100, 4101, 4102, 4103].map((port) => {
    const doc = new Y.Doc();
    const provider = new HocuspocusProvider({
      url: `ws://localhost:${port}/collaboration`,
      name: document.id,
      token: document.token,
      document: doc,
    });
    const tracker = new DatabaseSaveTracker(doc, provider, () => {});
    return { doc, provider, tracker, text: doc.getText('body') };
  });
  try {
    await vi.waitFor(() => clients.forEach((c) => assert(c.provider.synced)), { timeout: 10000 });
    clients[0]!.text.insert(0, 'private-packaged-content-sentinel');
    await vi.waitFor(
      () =>
        clients.forEach((c) => {
          assert.equal(c.text.toString(), 'private-packaged-content-sentinel');
          assert.equal(c.tracker.state, 'saved');
        }),
      { timeout: 10000 },
    );
    for (const port of [4100, 4101, 4102, 4103]) {
      const endpoint = `http://localhost:${port}`;
      for (const method of ['GET', 'PATCH']) {
        const denied = await fetch(`${endpoint}/api/documents/${document.id}`, {
          method,
          headers: {
            Authorization: 'Bearer ' + 'x'.repeat(43),
            'Content-Type': 'application/json',
          },
          ...(method === 'PATCH' ? { body: '{"title":"unauthorized"}' } : {}),
        });
        assert.equal(denied.status, 404);
        assert(!(await denied.text()).includes('private-packaged'));
      }
      const attacker = await rawClient(port);
      try {
        attacker.socket.send(auth(document.id, 'x'.repeat(43)));
        assert.equal(await attacker.closed, 1008);
        assert(attacker.messages.every((bytes) => messageType(bytes) === 2));
      } finally {
        attacker.socket.terminate();
      }
      assert.equal((await fetch(endpoint + '/metrics')).status, 401);
      assert.equal((await fetch(endpoint + '/live')).status, 200);
      assert.equal((await fetch(endpoint + '/ready')).status, 200);
      const metrics = await fetch(endpoint + '/metrics', {
        headers: { Authorization: `Bearer ${metricsToken}` },
      });
      assert.equal(metrics.status, 200);
      const body = await metrics.text();
      for (const secret of [document.id, document.token, metricsToken, 'private-packaged'])
        assert(!body.includes(secret));
      for (const expected of [
        'commonplace_ready 1',
        'commonplace_sessions 1',
        'commonplace_persistence_failures 0',
        'commonplace_snapshot_write_seconds_count',
      ])
        assert(body.includes(expected));
      assert.equal(
        (
          await fetch(endpoint + '/api/documents/' + document.id, {
            headers: {
              Origin: 'https://attacker.invalid',
              Authorization: `Bearer ${document.token}`,
            },
          })
        ).status,
        403,
      );
    }
    assert.equal(
      (
        await fetch('http://localhost:4200/metrics', {
          headers: { Authorization: `Bearer ${metricsToken}` },
        })
      ).status,
      404,
    );
    clients[1]!.text.insert(clients[1]!.text.length, ' healthy');
    await vi.waitFor(
      () =>
        clients.forEach((c) => {
          assert(c.text.toString().endsWith(' healthy'));
          assert.equal(c.tracker.state, 'saved');
        }),
      { timeout: 10000 },
    );
    await mkdir('test-results', { recursive: true });
    await writeFile(
      'test-results/security-verification.json',
      JSON.stringify(
        {
          schemaVersion: 1,
          verifiedAt: new Date().toISOString(),
          instances: 4,
          checks: [
            'Warm HTTP and WebSocket authorization rejects incorrect capabilities on all four final-image servers',
            'Rejected clients receive no document content or awareness, and legitimate peers remain usable with confirmed saves',
            'Each instance exposes liveness, readiness, and separately authenticated metrics without document/token labels',
            'Unapproved HTTP origins are rejected; the gateway blocks metrics access',
          ],
          scope:
            'Small single-host functional security and operational checks; not an independent penetration test or performance benchmark.',
        },
        null,
        2,
      ) + '\n',
    );
  } finally {
    for (const c of clients) {
      c.tracker.destroy();
      c.provider.destroy();
      c.doc.destroy();
    }
  }
}, 45000);
