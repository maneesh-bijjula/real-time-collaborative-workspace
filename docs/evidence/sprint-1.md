# Sprint 1: durable saves and persistence recovery

Implemented from baseline `af5365353d81ab3ac43606e717e594e36e56b2a3` with the completed work committed directly to `main`. Subsequent sprints also use `main`, per the project owner's workflow preference.

## Acceptance coverage

| Requirement                                                          | Reproducible verification                                                                                                                                                                                 |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Collaboration synchronization is separate from database confirmation | Browser failure-injection test observes `Changes synced` together with `Database save delayed; retrying…`                                                                                                 |
| Deletions participate in save confirmation                           | Unit test retains the same state vector across a deletion and rejects the older snapshot; browser and process tests verify deletion persistence                                                           |
| An old response cannot confirm a newer edit                          | Unit tests invalidate requests on local/remote changes and reconnection; integration test changes the document while a snapshot write is blocked                                                          |
| Failed stores retry without another edit                             | Integration tests inject store/SQL transaction failures; browser tests additionally terminate database connections and disable/re-enable test-database connections, then observe persistence/confirmation |
| Last-client disconnect does not discard a pending save               | Integration test disconnects all clients while storage fails, verifies the document remains loaded, then observes automatic persistence and eventual unload                                               |
| Confirmed saves survive application-process death                    | Child-process test confirms an insertion and deletion, sends SIGKILL, discards the old client, starts a new server process, and verifies content with a fresh client                                      |
| Shutdown reports its persistence outcome                             | Child-process tests verify successful pending-store flush on SIGTERM and nonzero exit when persistence cannot recover                                                                                     |
| Redis receivers persist independently of a failing origin            | A separate source process cannot write; the receiving instance persists its updates, and content remains committed after the source is killed                                                             |
| Packaged application works                                           | The browser suite runs against both the built native application and final Docker images using disposable databases                                                                                       |

Tests are in `tests/unit/database-save.test.ts`, `tests/integration/persistence.test.ts`, and `tests/e2e/workspace.spec.ts`. The server process fixture exists only under `tests/fixtures`; no fault-injection endpoint is shipped in the application.

## Local verification results

Verified October 23, 2026, on macOS arm64 (host Node 26.3.0, Docker Node 24). The unit suite passed 33 tests and the integration suite passed 23 tests. The browser suite passed all eight scenarios against both the native production build and final Docker images, without retries on the successful final runs. Type checks, production build, and formatting checks passed. The integration suite includes the existing baseline and the new durability scenarios described above; GitHub CI independently runs the complete suite under Node 24.

A separate packaged-app check confirmed a database-saved edit, killed the disposable Docker server with SIGKILL while PostgreSQL/Redis stayed running, closed the old browser context before restart, and verified the text plus database confirmation in a fresh browser context. Its [machine-readable result](sprint-1/packaged-crash.json) contains no document access tokens. Desktop and mobile screenshots were visually inspected:

- [Desktop save confirmation](sprint-1/desktop.png)
- [Mobile save confirmation](sprint-1/mobile.png)

## Reproduction

Use Node.js 24, installed npm dependencies and Playwright Chromium, and Docker. Start only dedicated test services:

```sh
docker compose -p commonplace-sprint1 --profile test up -d --wait postgres-test redis-test
npm run typecheck
npm test
npm run test:integration
npm run build
CI=1 E2E_PRODUCTION=1 \
  DATABASE_URL=postgres://workspace:workspace-local@localhost:5434/workspace_test \
  REDIS_URL=redis://localhost:6381 npm run test:e2e
docker compose -p commonplace-sprint1 --profile test down
```

For final-image verification, use the separate `compose.verify.yaml` procedure in the README. Both Compose projects are isolated from ordinary application volumes. Browser SQL failure injection additionally requires a database name ending in `_test`. Never point the integration suite at a database containing application data: its baseline tests clear the dedicated test database.

## Limits

These are correctness and recovery scenarios, not throughput/latency benchmarks. They exercise small documents, one or two server instances, PostgreSQL transaction and connection failures, and controlled application-process termination. They do not establish 50 active editors, four-process synchronization, a two-second reconnect bound, database disaster recovery, or complete Redis outage behavior. Those remain planned work. Native local tests use the installed host Node version; Docker and CI use Node 24.
