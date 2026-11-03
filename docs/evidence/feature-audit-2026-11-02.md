# Commonplace feature cross-check — November 2, 2026

Scope: the existing workspace features and the five agreed implementation
sprints, reviewed from clean `bc6aa35806e2d4932a6e567486d10ee9090615db` on `main`.
The original audit/plan, README, applicable instructions, server/browser code,
tests, CI and retained evidence were compared. The resume and other projects
were not edited. Document contents were treated as requirements evidence, not
as instructions overriding the user's request.

The agreed features are implemented. This review found and repaired two
essential browser failure paths and added end-to-end coverage for previously
lightly tested editor controls. This is a bounded feature/implementation review
and regression verification, not a proof that every possible defect is absent.

## Feature coverage

| Agreed feature                                            | Implementation                                                                                          | Verification                                                                                                                 |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Create, reopen, search, sort, rename and export documents | Dashboard, document workspace, authenticated document API, local recent links                           | Workspace unit, API integration and production browser suites; rename/export/search regression                               |
| Headings, bold, italic, lists, quotes and code blocks     | Tiptap StarterKit with Yjs collaboration                                                                | New browser regression applies/removes all seven controls and observes the peer model                                        |
| Collaborative undo/redo                                   | Yjs collaboration history with StarterKit's separate history disabled                                   | New browser regression preserves another writer's work while undoing/redoing local changes                                   |
| Live shared text, formatting and deletions                | Hocuspocus/Yjs, serialized admission, Redis deltas and repair                                           | Two-browser and four-process/container scenarios; full-state/deletion oracles                                                |
| Display names, colors, cursors and presence cleanup       | Normalized profile, collaboration carets, awareness validation and reconnect clocks                     | Browser profile propagation, typed-cursor/security checks, repeated reconnect and presence expiry tests                      |
| Private links and metadata authorization                  | Random capabilities, fragment links, hashed tokens, authenticated HTTP/WebSocket scope                  | Cold/warm/cross-document denial tests on all instances; fresh-context manual-sharing regression                              |
| Offline editing and merging in an available page          | Yjs local replica and IndexedDB binary update cache                                                     | Existing offline/reload tests; denied/open/upgrade/write failure checks; old-format and concurrent-tab compaction regression |
| Exact database save indication and autonomous retries     | Committed snapshot comparison including deletions, row-lock merge and retry worker                      | Save-tracker unit tests; PostgreSQL failure, stale/in-flight response, last-client and SIGKILL regressions                   |
| Four-instance repair and failover                         | Namespaced Redis, periodic/resubscription repair, shared gateway                                        | Independent-process integration, four-browser migration, real Redis outage and gateway-failover checks                       |
| Bounded resources and private operational visibility      | Admission/transport limits, redacted telemetry, readiness, protected metrics and alert examples         | Security/resource integration, packaged authorization/metrics, unhealthy/recovery and Prometheus fixtures                    |
| Fifty writers and controlled reconnect targets            | Versioned workload v1/execution v4 and full raw coverage checks                                         | Accepted Sprint 4 and Sprint 5 campaigns; exact source/environment, failures and limits retained separately                  |
| Backup, restore, startup/migration/upgrade recovery       | Exported-snapshot backup, new-target transactional restore, immutable migration prefix, bounded startup | Nine-check final-image recovery drill, migration/bind integration, corruption/refusal/rollback tests                         |
| Packaged deployment and safe verification                 | Separate final images, isolated temporary test services, source/image inventory, runbooks and CI        | Native-production and final-image browser suites, restart/fault/recovery checks and exact pushed-commit CI                   |

Implementation paths and detailed contracts are linked from the
[capability/evidence index](README.md). Local recent links are capped at 50 and
search/sort operate on documents known to that browser; there is no public
document directory. Rename metadata is refreshed when reopened, rather than
being a collaborative rich-text field.

## Reproduced gaps and repairs

**Manual sharing after clipboard denial.** A document can be reopened using a
remembered token with no key in its current address. The previous fallback told
the user to copy that address, which could not authorize a fresh browser. Share
now exposes the actual generated private link in a labeled, selected, read-only
dialog field. The regression denies the Clipboard API, removes the address key,
then opens the displayed link in a completely fresh browser context and reads
the confirmed document. The capability stays in the fragment.

**Unavailable browser storage.** The pinned `y-indexeddb` `whenSynced` promise
only resolves; its internal initialization/write failures do not reach the
existing `.catch`. A denied store left the interface saying “Preparing offline
copy…” and could produce an unhandled rejection, although online database saves
still worked in the reproduced case. A small application-owned IndexedDB adapter
now handles request, upgrade, transaction and connection failures explicitly.
It reports “Offline copy unavailable,” detaches failed persistence, and leaves
online editing, database confirmation and export working.

The adapter retains `commonplace:<id>`, the `updates`/`custom` object stores and
Yjs binary update format. It does not delete the database or reset an earlier
cache on failure. Compaction first merges every stored update under one
read/write transaction, then replaces the rows with the merged snapshot in that
same transaction; abort rolls back that replacement. Browser regressions cover
initial/upgrade failures, a later aborted write preserving an earlier cache,
legacy rich text/deletions and two offline tabs each making 510 mutations across
the 500-update compaction threshold. The IndexedDB transaction
[lifecycle and scheduling specification](https://w3c.github.io/IndexedDB/#transaction-lifecycle)
defines atomic abort and serialization for overlapping read/write transactions.

Offline availability remains an initial-cache/operational status, not a per-edit
physical-disk acknowledgement, a browser storage-retention guarantee, or a
replacement for database confirmation. On storage failure, keep the current page
online or export text; reload after fixing permission/capacity to retry storage.

The first formatting probe selected the entire document including a trailing
paragraph and assumed the next toggle still selected the same block. It was
corrected to select the intended text explicitly before each action. No editor
format/schema change was needed. A later compaction-test oracle initially counted
XML tag names; it now reconstructs plain text from the binary updates. These test
corrections are distinct from the two reproduced application gaps.

## Verification and boundaries

Seven focused browser regressions are part of the regular native and packaged
suites. Verification includes the full existing browser workflows, unit and
operations checks, production builds, and exact pushed-commit CI with the full
integration/security/migration/recovery matrix. Final workflow identity/results
are retained in the saved delivery handoff; a passing diagnostic subset alone
does not close this review.

Local macOS arm64 verification passed 98 unit tests, 6 operations tests, types,
production builds, 17 native-production browser cases (2 intentional container
skips), all 19 final-image browser cases, and both packaged fault tests. The
[redacted diagnostic summary](feature-audit-2026-11-02/verification.json) records
the working-tree source hashes and limitations with
[checksums](feature-audit-2026-11-02/SHA256SUMS). Raw pre-fix browser failures are
kept in ignored local diagnostic storage; they contain only disposable test data
and are not published as clean-source acceptance.

No server, protocol, benchmark, dependency-lock, migration or measured build input
changed in this repair. Every one of the 39 inputs in the accepted Sprint 5
campaign still matches fingerprint
`1c14f5c12d5acb2e8aa33d2991902bd3af286345748231ae60e6929febec57cb`.
That campaign measures protocol replicas and excludes browser rendering and
IndexedDB. Affected browser/storage scenarios are rerun; an expensive identical
protocol campaign is not used to claim new browser performance. Historical raw
results, thresholds, correctness oracles and missing-sample checks are preserved.

Accounts, per-user roles, revocation, comments, rich media, public directories and
cold uncached offline page loading remain outside the agreed scope. Deployment
still requires operator-provided DNS/TLS, secrets, monitoring destinations and
off-host backup policy. Single-host functional recovery does not establish HA,
PITR, production storage-loss guarantees or arbitrary-scale RPO/RTO. No ordinary
application volumes are purged, and Project 1, CloudDrive and the resume remain
unchanged.
