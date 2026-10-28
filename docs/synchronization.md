# Multi-instance synchronization and reconnects

Commonplace uses Hocuspocus/Yjs sessions on independent Node processes, Redis Pub/Sub for live fan-out, and PostgreSQL for committed document snapshots. All instances in one deployment must use the same database, Redis endpoint, `REDIS_PREFIX`, editor schema, and application version. No sticky-session routing is required for document convergence. A reconnect can land on any surviving instance; its authenticated Yjs handshake merges that browser's retained changes with the server's state.

## Repair protocol

The live path publishes each accepted non-Redis-origin Yjs delta directly in the pinned extension's identifier-prefixed Sync/Update envelope. It does not request a full state-vector/deletion-set exchange for every keystroke. Redis-origin changes are not echoed. Initial loading and periodic repair still use the extension's bidirectional handshake below, preserving compatibility and recovery for missed inserts, formatting and deletion-only changes.

At most 128 delta publications and 16 MiB of payload are retained in flight per instance. PostgreSQL dirty tracking/stores do not await Redis acknowledgement. If Redis is disconnected or that budget fills, publication is deferred to repair, synchronization health becomes unhealthy, and the accepted history remains in the live document and follows the normal persistence contract. No extra unbounded application/offline publication queue is created. The next successful repair recovers deferred history without a new edit. Metrics expose published/failed/deferred counts and retained work. Redis publication alone is never database-save confirmation.

Redis Pub/Sub does not retain messages for disconnected subscribers. Resubscribing alone therefore cannot repair missed changes in an already loaded document. `SynchronizationRedis` adds these steps:

1. On Redis publisher/subscriber readiness, request a repair pass. Also run a periodic pass, by default every 2,000 ms, to cover subscription races and losses while documents stay open.
2. Await subscription to this instance's reply channel, then reuse the pinned extension's document subscription and bidirectional state-vector handshake. Peers exchange missing Yjs structures and deletion sets; awareness is queried again. Recovery requires no additional user edit.
3. Merge the committed PostgreSQL snapshot into each connected, loaded document. This also recovers committed changes after a peer process has disappeared. The Sprint 1 row-lock/CRDT snapshot merge and persistence retry rules remain in force.

Only one repair pass runs per instance at a time. Idle/unloaded documents are restored through their normal load path. A transport or database failure is reported without contents or tokens, and a later timer/readiness event retries. Async Redis protocol-reply errors are contained so a temporary Redis outage does not terminate Node through an unhandled promise rejection. The wrapper is tested against the pinned Hocuspocus 4.7.1 extension; its final-participant removal envelope uses that version's wire framing and must be revalidated when upgrading.

`REDIS_RECONCILE_INTERVAL_MS` accepts integers from 250 to 60,000. A shorter interval adds Redis state-vector/awareness exchanges and one PostgreSQL snapshot read per connected document per pass. The default is a repair cadence, **not** a promised end-to-end recovery time. Redis retry delay, document size, database availability, network delay, and load also affect recovery. Snapshot reconciliation adds work that the performance sprint must characterize.

`REDIS_PREFIX` defaults to `commonplace` and accepts 1–128 letters, digits, colons, underscores, or hyphens, beginning with a letter or digit. Set a distinct prefix for deployments sharing a Redis service. Redis Pub/Sub channels are not isolated by the Redis database number. A prefix isolates collaboration transport; it does not create database tenancy. Deployments sharing PostgreSQL document rows still share committed content and capability authorization. Use separate databases for separate environments.

## Session and presence policy

The browser retains its Y.Doc/IndexedDB state while offline. On a successful synchronization it advances its local presence clock, allowing its state to supersede an earlier disconnect removal. On close, absent remote presence clocks are forgotten so an unchanged peer snapshot can restore participants immediately on reconnect. A server-initiated document-session close may leave the physical WebSocket open; the browser closes that transport, waits for its disconnected event, and starts a fresh authenticated session. Ordinary physical disconnect retries remain the provider's responsibility.

The server tracks presence IDs whose awareness clock advances on a connection, including returning IDs already known via Redis. Normal connection closure publishes removals even when it was the final local socket. Normal removal/rejoin scenarios have a 10-second functional test deadline. A removal lost during Pub/Sub disruption or abrupt process death can leave a ghost until Yjs awareness expiry: the pinned implementation uses a 30-second stale threshold and periodic scans. Regression tests allow **45 seconds** for that fallback cleanup. Presence is ephemeral, not a database record or verified identity. These tests do not establish a security boundary for participant labels.

`/health` and `/ready` return 503 while a dependency probe fails, either Redis transport is not ready/responsive, reconciliation is unhealthy, persistence has failed or aged beyond policy, or shutdown is draining. `/live` remains a separate process liveness check. This checks dependency connectivity; it does not certify that all documents have completed a repair or that every pending edit is durable. The separate database-save indicator continues to require an exact committed snapshot, including deletions. See [Sprint 3 operations](operations.md) for active probes, protected per-instance metrics, and operational alerts.

## Disposable four-container deployment

From the repository root, with ports 3100, 4100–4103, 4200, and 15434 free:

```sh
docker compose -p commonplace-verify -f compose.verify.yaml -f compose.cluster.yaml up -d --build --wait
```

Open `http://localhost:3100`. The built browser uses `http://localhost:4200` for API requests and `ws://localhost:4200/collaboration` for collaboration. Nginx distributes new connections across four Node containers. It refreshes Docker DNS addresses, retries failed upstream connections, and lets reconnecting clients use a surviving backend. Existing WebSockets remain attached to their original backend until disconnected. This is a localhost verification topology, with local credentials, no TLS, one Redis, one PostgreSQL, and one gateway; it is not a highly available production deployment.

Run all browser tests, including four independent browser contexts pinned to different server endpoints and one offline session returning through another instance:

```sh
E2E_EXTERNAL=1 E2E_BASE_URL=http://localhost:3100 \
  DATABASE_URL=postgres://workspace:workspace-local@localhost:15434/workspace_verify_test \
  E2E_CLUSTER_WEBSOCKETS=ws://localhost:4100/collaboration,ws://localhost:4101/collaboration,ws://localhost:4102/collaboration,ws://localhost:4103/collaboration \
  npm run test:e2e
npm run test:cluster:packaged
```

The packaged fault command stops/starts only this stack's Redis, applies divergent edits through four direct endpoints, and verifies convergence/database confirmation without another edit. It then SIGKILLs backends until its fifth, gateway-connected observer must reconnect, verifies recovery **before restarting the killed backend**, and verifies pinned clients after restart. It writes `test-results/cluster-verification.json`. The command permits only `commonplace-verify` or the local `CLUSTER_VERIFY_PROJECT=commonplace-sprint2-verify` / `commonplace-sprint3-verify` projects and verifies that PostgreSQL is the temporary verification database with no persistent volume. Do not point fault tests at ordinary application services.

Clean up this disposable stack without touching ordinary application volumes:

```sh
docker compose -p commonplace-verify -f compose.verify.yaml -f compose.cluster.yaml down
```

The overlay inherits the temporary PostgreSQL storage from `compose.verify.yaml`. Stopping/removing this verification PostgreSQL container intentionally discards its test data. Do not use it for documents you want to keep.

## Verification scope

`tests/integration/cluster.test.ts` starts four separately forked Node processes with distinct PIDs and a unique Redis prefix. It covers concurrent inserts/deletes/formatting/rich-text nodes, presence, subscriber loss with idle recovery, divergent Redis-disconnected edits, offline migration, repeated disconnects, logical-session reset, missed removal expiry, confirmed-save process death/restart, and namespace isolation. It uses a 500 ms repair interval to keep functional tests bounded; packaged verification uses the 2,000 ms default. Fault controls exist only in the IPC test fixture, not a production HTTP endpoint.

The browser test checks actual Tiptap formatting, participant counts, offline merging, and database confirmation across final images. CI runs both test layers and the real Redis/gateway fault command. These small single-host scenarios establish correctness for the exercised cases. They do not verify 50 active editors, p95 update latency below 100 ms, or reconnect convergence below two seconds. Sprint 4 provides that measurement campaign.
