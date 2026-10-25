# Commonplace · Real-Time Collaborative Workspace

A shared writing workspace built with **TypeScript, Next.js, Node.js, Yjs, WebSockets, PostgreSQL, and Redis**. Create a document, share its private link, and edit together with live cursors and presence.

![The Commonplace workspace](docs/screenshots/workspace.png)

## Features

- Rich text editing with headings, bold, italic, lists, quotes, code blocks, and collaborative undo/redo.
- Live document synchronization through Yjs CRDTs and Hocuspocus WebSockets.
- Shared cursors, selection highlights, participant presence, and editable display names.
- PostgreSQL storage of Yjs binary state, with transactional merging of concurrent snapshots.
- Separate database-confirmed save status, automatic persistence retries, and tested application-crash recovery for confirmed saves.
- Redis synchronization across server instances, periodic missed-message repair, and tested four-process reconnect recovery.
- IndexedDB document copies, offline editing in an open page, and automatic merging on reconnect.
- Private share links, hashed server-side access tokens, document renaming, search, and text export.
- Responsive interface, Docker services, versioned SQL migrations, and automated CI.

## Run with Docker

Install Docker with the Compose plugin, then run:

```sh
docker compose up --build -d
```

Open [localhost:3000](http://localhost:3000), create a document, and click **Share document**. Open that complete link in another browser or incognito window to collaborate.

| Service            | Local address                  |
| ------------------ | ------------------------------ |
| Web interface      | `http://localhost:3000`        |
| API and WebSockets | `http://localhost:4000`        |
| Dependency health  | `http://localhost:4000/health` |
| PostgreSQL         | `localhost:5433`               |
| Redis              | `localhost:6380`               |

Exposed Compose ports bind to localhost. `docker compose down` retains the PostgreSQL data volume. Redis carries transient synchronization messages; persistent document content lives in PostgreSQL.

## Develop locally

Use Node.js 24 and Docker:

```sh
npm ci
docker compose up -d postgres redis
npm run dev
```

The defaults match the local service ports above. Optional backend settings are listed in `.env.example`; copy it to `.env` to customize native development. Browser-facing API and WebSocket URLs can be set in `apps/web/.env.local` before building. The backend and frontend must be rebuilt together when changing the collaboration protocol or editor schema.

## Architecture

```mermaid
flowchart LR
    A[Next.js editor A] <-->|Yjs updates + awareness| S1[Node.js / Hocuspocus]
    B[Next.js editor B] <-->|Yjs updates + awareness| S2[Node.js / Hocuspocus]
    S1 <-->|Pub/Sub| R[(Redis)]
    R <-->|Pub/Sub| S2
    S1 <-->|binary CRDT state| P[(PostgreSQL)]
    S2 <-->|binary CRDT state| P
    A <--> I1[(Browser IndexedDB)]
    B <--> I2[(Browser IndexedDB)]
```

Tiptap provides the rich text editor; Yjs merges concurrent operations; Hocuspocus handles synchronization, awareness, and WebSocket sessions. The application supplies document APIs, share-link authorization, PostgreSQL persistence, Redis configuration, browser storage, and the workspace interface.

Snapshot writes lock their document row and merge the incoming Yjs state with the stored state before committing with `synchronous_commit=on`. An older snapshot therefore cannot overwrite a newer CRDT history or resurrect deleted text. PostgreSQL transactions coordinate persistence across instances; Redis is used for synchronization rather than a best-effort persistence lock. Migrations run transactionally under an advisory lock and verify checksums of previously applied files.

The default Compose topology has one collaboration server. The cluster integration suite starts four independent Node processes and verifies concurrent edits, presence, Redis reconnection, offline migration, and restart recovery. A disposable four-container topology adds a shared nginx gateway; see [synchronization and reconnects](docs/synchronization.md).

## Access and persistence behavior

Each document has a random 256-bit access token. The database stores only its SHA-256 hash. HTTP metadata reads and writes require a bearer token; WebSocket sessions authenticate before loading a document. Share links put the token in the URL fragment, which is not sent as part of an HTTP page request. The browser keeps recent document links locally, so the dashboard lists documents known to that browser rather than a public directory.

Anyone holding a complete share link can read and edit that document. Display names are participant labels, not verified identities. The application uses document-level access links without user accounts, per-user roles, link revocation, or audit history. Keep share links private.

Server snapshots are debounced for 300 ms, with a maximum debounce of one second. The interface distinguishes three independent states:

- **Changes synced** means the collaboration provider has acknowledged the current updates.
- **Saved to database** means an authenticated check read committed PostgreSQL state whose Yjs snapshot matches the editor's current state, including deletions. A new local/remote edit or connection change invalidates that confirmation. While online and awaiting confirmation, checks run every 500 ms; checks stop once the current state is confirmed.
- **Offline copy enabled** means initial IndexedDB restoration completed. It is not a per-edit browser-disk acknowledgement.

Failed writes retry automatically, with exponential backoff and jitter capped at five seconds, even if no further edits occur or the last editor disconnects. Pending saves keep their server document loaded. Changes received through Redis are also scheduled for persistence. The interface shows **Database save delayed; retrying…** when the database check fails or a failed write is pending, and **Database save unconfirmed** while disconnected.

Graceful shutdown closes collaboration connections, flushes pending stores, and allows retries for up to 12 seconds. If it must abandon a pending save, shutdown reports failure and the process exits unsuccessfully; an outer 15-second process deadline bounds a stalled shutdown. An abrupt server crash can still lose **unconfirmed** edits that have not reached PostgreSQL or another surviving client. Confirmed saves are tested against application-process crashes with PostgreSQL and its storage intact, not database-volume destruction. Browser-local copies provide an additional recovery path and merge when reconnected.

See [the persistence contract](docs/persistence.md) and [Sprint 1 verification](docs/evidence/sprint-1.md) for protocol, failure behavior, and test scope. Rebuild the browser and backend together for this save-confirmation protocol; an older backend cannot provide the new database confirmation.

Offline editing works in an already loaded document. IndexedDB restores local content when the page is available, but the app does not install a service worker to load an uncached page without a network. Clearing browser storage removes local copies and the recent-document list; retain the full share link to reopen a document afterward.

## API

| Method    | Path                 | Behavior                                                                                  |
| --------- | -------------------- | ----------------------------------------------------------------------------------------- |
| POST      | `/api/documents`     | Create a document with `{ "title": "Team notes" }`; returns metadata and its access token |
| GET       | `/api/documents/:id` | Read metadata with `Authorization: Bearer TOKEN`                                          |
| PATCH     | `/api/documents/:id` | Rename with the same bearer header and `{ "title": "New title" }`                         |
| GET       | `/health`            | Check PostgreSQL and both Redis transports                                                |
| WebSocket | `/collaboration`     | Hocuspocus protocol; document ID and token supplied through its provider                  |

Titles are trimmed, limited to 120 characters, and validated before parameterized SQL queries. The API rejects unknown fields and malformed input. Creation is limited to 30 requests per minute per source IP. Browser origins are explicitly allowlisted; access tokens remain the document authorization boundary.

## Tests

```sh
# Pure unit tests; no services required.
npm test

# Dedicated PostgreSQL and Redis services, then integration tests.
docker compose --profile test up -d --wait postgres-test redis-test
npm run test:integration

# Type-check application and test code.
npm run typecheck

# Install Chromium once, then test the interface.
npx playwright install chromium
npm run test:e2e
```

Integration tests use `workspace_test` on port 5434 and Redis on port 6381. `TEST_DATABASE_URL` and `TEST_REDIS_URL` override these endpoints; the database name must end in `_test`. The suite clears document data in that dedicated test database. Browser tests start the local application automatically and use its configured development database.

Coverage includes authorization, validation, SQL-like input, concurrent CRDT edits, offline merging, presence cleanup, four-process Redis recovery, transactional snapshot merging, process-crash recovery, text export, search, and mobile layout. GitHub Actions checks production builds, runs native and final-image browser suites, and verifies a real Redis outage plus gateway failover on the disposable four-container topology.

Durability regressions additionally cover deletion-only changes, stale responses, edits during an in-flight write, retries after a PostgreSQL transaction failure, pending saves after the last client disconnects, SIGKILL recovery with fresh clients, and successful/failed graceful shutdown. Browser SQL write-failure injection runs only when `DATABASE_URL` names a database ending in `_test`; connection-failure injection is further restricted to dedicated `workspace*_test` databases and requires the test fixture's administrative privileges.

To test the final Docker images without ordinary application volumes:

```sh
docker compose -p commonplace-verify -f compose.verify.yaml up -d --build --wait
E2E_EXTERNAL=1 E2E_BASE_URL=http://localhost:3100 \
  DATABASE_URL=postgres://workspace:workspace-local@localhost:15434/workspace_verify_test \
  npm run test:e2e
docker compose -p commonplace-verify -f compose.verify.yaml down
```

This disposable stack uses ports 3100 (web), 4100 (API/WebSockets), and 15434 (test PostgreSQL). Its PostgreSQL data is temporary. `E2E_EXTERNAL=1` directs Playwright to the already-running container application. CI runs both native-production and final-image browser suites. Docker build arguments `NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_COLLABORATION_URL` configure browser endpoints at build time.

Functional synchronization and recovery across four independent Node processes and four packaged server containers are tested. The performance targets of 50 active editors at under 100 ms p95 propagation latency and reconnect convergence under two seconds remain unverified. Current tests establish correctness only for their documented small scenarios; Sprint 4 provides the reproducible load/fault benchmark campaign. See [Sprint 2 evidence](docs/evidence/sprint-2.md) and the [four-instance verification commands](docs/synchronization.md#disposable-four-container-deployment).

## Project structure

```text
apps/web/         Next.js interface, rich text editor, browser storage
apps/server/      Express APIs, Hocuspocus server, PostgreSQL storage
tests/unit/       Validation, token handling, workspace utilities
tests/integration/ HTTP, WebSocket, persistence, Redis tests
tests/e2e/        Independent browser sessions and interface flows
```

## References

- [Yjs documentation](https://docs.yjs.dev/)
- [Hocuspocus database persistence](https://tiptap.dev/docs/hocuspocus/server/extensions/database)
- [Hocuspocus Redis synchronization](https://tiptap.dev/docs/hocuspocus/server/extensions/redis)
- [Tiptap collaboration](https://tiptap.dev/docs/editor/extensions/functionality/collaboration)

[MIT License](LICENSE)
