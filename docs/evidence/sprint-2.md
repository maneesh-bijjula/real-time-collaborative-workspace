# Sprint 2: reconnect correctness and four-instance recovery

Implemented from Sprint 1's `main` commit `84e47291c3884fff5be40bff50daf6ed592fa217`. The change retains PostgreSQL transactional snapshot merging and exact database-save confirmation, and adds Redis reconciliation, presence/session recovery, a four-container gateway topology, and reproducible fault checks. See the [synchronization contract and commands](../synchronization.md).

## Acceptance coverage

| Requirement                                                       | Verification                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Four independent Node processes synchronize                       | The cluster integration fixture forks four distinct PIDs and checks concurrent inserts, deletes, Y.Text formatting, Tiptap-compatible Y.Xml rich text, and participant presence. All clients must have equal Yjs snapshots (including deletion sets), text deltas, and XML.                                                                                          |
| Redis resubscription repairs missed messages without another edit | One process's subscriber is disconnected while its client remains connected. A peer changes content, deletes text, formats text, and changes presence. After subscriber reconnection, state and presence converge without any new edit. Health is 503 while the subscriber is down and 200 after it returns.                                                         |
| Divergent changes merge after a partition                         | All four processes lose their Redis transports, independently edit/delete/format, then reconnect. Exact snapshots/deltas converge and all clients receive committed database confirmation.                                                                                                                                                                           |
| Offline clients can change instances                              | A retained browser Y.Doc moves from the first process to the fourth with offline deletions/formatting/inserts while another peer edits. The packaged browser test separately exercises the actual rich text editor, IndexedDB-backed session, four browser contexts pinned to separate backends, and an offline session returning through another backend.           |
| Repeated disconnects preserve content and presence                | Four socket disconnect/rejoin rounds produce each expected edit exactly once. Both returning and observing clients recover participant lists. Unit tests cover retained awareness clocks and waiting for physical socket closure before restarting a logically closed session.                                                                                       |
| Presence has a defined cleanup policy                             | Normal departures/rejoins use a 10-second functional deadline. A missed removal uses a separate 45-second fallback-expiry regression. The implementation publishes removal after the last local socket leaves; abrupt/missed removals may require awareness expiry.                                                                                                  |
| Process loss preserves the Sprint 1 save contract                 | Confirmed concurrent content survives SIGKILL of the fourth process and a fresh process/client reload. The complete Sprint 1 persistence suite also passes, including fresh-client crash recovery without peer replay and failure/retry/shutdown scenarios.                                                                                                          |
| Deployment namespaces are configurable                            | Configuration tests cover safe values/ranges. A fifth isolated-prefix process receives no uncommitted cross-prefix update. Its shared database is explicitly not treated as tenant isolation.                                                                                                                                                                        |
| Final packaged app recovers through actual infrastructure faults  | The guarded packaged test stops/starts Redis, verifies all Node servers survive and all five clients converge with database confirmation, then kills backends until a gateway client must fail over. That client must reauthenticate/synchronize and confirm its database state while its original backend is still down. Pinned clients also recover after restart. |

Source: `tests/integration/cluster.test.ts`, `tests/unit/collaboration-session.test.ts`, `tests/unit/config.test.ts`, `tests/e2e/cluster.spec.ts`, and `tests/packaged/cluster.test.ts`. IPC failure controls are confined to `tests/fixtures/collaboration-server.ts`; the application exposes no fault-injection HTTP endpoint.

## Verification results

Local final verification on October 24, 2026, macOS arm64 with host Node 26.3.0 and Docker Node 24:

| Check                                           | Result                                                                                           |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Application and test type checking              | Passed                                                                                           |
| Unit tests                                      | 49 passed                                                                                        |
| Integration tests                               | 32 passed, including all nine four-process scenarios                                             |
| Production build                                | Backend and Next.js standalone build passed                                                      |
| Native production browser suite                 | 8 passed; the cluster-only scenario is intentionally skipped without the four-container topology |
| Final-image browser suite                       | All 9 passed, including four-session offline formatting/migration/presence                       |
| Real packaged Redis outage and gateway failover | Passed; [machine-readable result](sprint-2/packaged-cluster.json)                                |
| Formatting and diff checks                      | Passed                                                                                           |

The GitHub Actions workflow repeats unit/integration/type/build checks, native and final-image browser suites, and the packaged Redis/gateway fault test under Ubuntu 24.04 and Node 24. Its uploaded report includes `test-results/cluster-verification.json`. Check the Actions run for the exact delivered commit when reviewing a release; local results do not substitute for CI.

Two normal reconnect regressions and the four-browser presence assertion initially failed during development. The completed fixes address final-local-participant removal, returning-ID ownership, logical-session close timing, and retained remote awareness clocks. The final passing runs include those assertions; no acceptance assertion was removed to accept a failure.

## Isolation and limitations

Local tests used only the `commonplace-sprint2` test-service project and the `commonplace-sprint2-verify` packaged project. Integration/native browser tests used `workspace_test` on port 5434 and Redis on 6381; packaged tests used temporary `workspace_verify_test` on 15434. No ordinary application volume was purged. The resume, Project 1, and CloudDrive were not modified.

These are small, single-host functional scenarios with one Redis and one PostgreSQL. Integration repair uses 500 ms; final-image verification uses the 2,000 ms default. Recovery deadlines are functional test bounds, not measured latency distributions or service-level guarantees. Presence after a missed removal may take up to the documented 45-second test bound. The gateway is a local test deployment, not a highly available production configuration.

Four-instance functional synchronization is now verified for these scenarios. The 50-editor workload, <100 ms p95 propagation target, and <2-second reconnect target remain **unverified** until Sprint 4's reproducible benchmark campaign. Authorization/resource policy and operational telemetry remain Sprint 3; disaster restore/release closure remains Sprint 5.
