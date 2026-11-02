# Sprint 5: packaged release, recovery and evidence closure

The implementation source is `e9283a92be298cef425164fa706056460dd3a009`.
[Clean-source Ubuntu CI passed](https://github.com/maneesh-bijjula/real-time-collaborative-workspace/actions/runs/41537655871).
The full Docker release recheck passed on the same source. Closure changes add
evidence, documentation and Git archive-ignore rules; all 39 measured inputs
match that source. Regular CI also runs on the final delivery push; its exact
commit status is recorded in the delivery handoff. Local dirty-tree diagnostics
remain separate from clean-source acceptance.

## Implemented contract

- Real PostgreSQL 17 custom-format backup, a single exported repeatable-read
  snapshot shared with the manifest, private exclusive files, archive hashing
  and fail-closed handling of partial/changed/incompatible inputs and warnings.
- Restoration only into a new database, with preflight before creation,
  transactional schema/data restore, recorded-history/count checks and `ANALYZE`.
  An existing database is never overwritten or dropped by the tools.
- Known-prefix immutable migration history, serialized transactional pending
  migrations, discarded failed connections, standalone apply/check commands,
  structured startup categories and a bounded production startup deadline.
- Owned temporary test services by default, random loopback ports, production
  browser builds tied to an owned API and no reuse of development web servers.
  External browser runs validate the actual disposable database and endpoints.
- Final-image browser restart, authorization/Redis/gateway faults, real-image
  backup/restore/startup/upgrade/restart drill, strict source/image inventory,
  proxy syntax and operational-rule validation in regular CI; separate manual
  load and recovery campaigns preserve failure evidence.

The [deployment guide](../deployment.md), [recovery procedure](../disaster-recovery.md)
and [evidence index](README.md) describe operation, rollback and claim boundaries.

## Clean-source release verification

The [workflow record](sprint-5/accepted-ci/workflow.json),
[verification summary](sprint-5/accepted-ci/verification.json),
[recovery report](sprint-5/accepted-ci/recovery.json),
[image inventory](sprint-5/accepted-ci/image-inventory.json) and
[checksums](sprint-5/accepted-ci/SHA256SUMS) retain the accepted source and results.
GitHub's expiring artifact identity/digest is recorded separately from the
per-file checksums. Private database archives and capability tokens are excluded.

| Verification                          | Result                                                                                                 |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Unit / operations / integration       | 98 / 6 / 84 passed                                                                                     |
| Native production browser             | 10 passed; 2 intentional container-only skips                                                          |
| Packaged browser / security and fault | 12 / 2 passed                                                                                          |
| Final-image recovery drill            | All 9 checks passed; all 10 expected container exits/events matched                                    |
| Source/image inventory                | Clean source; all four server images and web image match its OCI revision                              |
| Other checks                          | Types, audit, builds, 50-client controller-isolation correctness smoke, alerts and proxy syntax passed |

Recovery ran on Linux x64 with Node 24.22.1, server Node 24.22.2 and PostgreSQL
17.11. Its source database, Redis and all original clients were stopped before
fresh clients read the separate restored deployment. Exact rich text, formatting,
deletion-inclusive snapshots, metadata and original capability access survived;
wrong capabilities were denied, later work outside the snapshot was absent, and
presence started fresh. New confirmed writes survived a subsequent application
SIGKILL/restart, and a new backup selected the recovered database explicitly.

Negative cases verified configuration/dependency failures, an occupied HTTP port,
a TCP-accepting but nonresponding Redis startup deadline, changed migration
checksums and failed SQL. Source rows stayed unchanged; partial DDL/DML rolled
back. A corrected synthetic additive migration preserved old data through a
container replacement, and the old image refused the unknown newer history.
Corrupt bytes were rejected before target creation; existing databases were
refused; a deliberately resealed damaged compressed stream failed inside
`pg_restore` and left its newly created destination without partial application
tables. All disposable services were cleaned up without volume deletion.

## Full Docker release benchmark

The [complete campaign](https://github.com/maneesh-bijjula/real-time-collaborative-workspace/actions/runs/41537726458)
passed on clean source `e9283a92be298cef425164fa706056460dd3a009`, measured-input
SHA-256 `1c14f5c12d5acb2e8aa33d2991902bd3af286345748231ae60e6929febec57cb`.
It preserves workload v1 and execution v4, including all 50 independent replicas
across four worker isolates, four production Node containers, 2 mutations per
writer per second, 30-second warmup and three 120-second primary windows.
Thresholds, scheduling validity, correctness oracles and missing-sample checks
are unchanged. All 13 benchmark source files other than the runtime's added
build-input fingerprint entry are byte-identical to the accepted Sprint 4 source.

| Primary repeat | p50 ms | p95 ms | p99 ms | Maximum ms | Operations | Peer samples |
| -------------- | ------ | ------ | ------ | ---------- | ---------- | ------------ |
| 1              | 19.95  | 67.25  | 154.34 | 576.65     | 12,000     | 588,000      |
| 2              | 18.95  | 57.84  | 109.01 | 262.29     | 12,000     | 588,000      |
| 3              | 19.01  | 58.13  | 105.99 | 251.91     | 12,000     | 588,000      |

All **36,000 operations and 1,764,000 expected peer samples** are present, with
no duplicate, invalid-recipient or missing samples. Maximum measured source
scheduling lags were 252.35 / 50.19 / 67.46 ms, within the unchanged 500 ms
limit. All offered-load, rich-text/deletion/presence, connection and confirmed
durability checks passed. All **30 controlled reconnect trials** passed: p95
155.60 ms, maximum **177.60 ms**, zero missing/failed/timed-out trials.

Characterizations also completed: five documents p95 24.21 ms (3,000 operations,
27,000 samples), 128 KiB seed p95 27.74 ms (3,000 operations, 147,000 samples),
and five larger-backlog reconnect trials with maximum 1,524.78 ms. These shorter
profiles do not replace the three primary repeats or establish arbitrary scale.

The runner exposed four logical CPUs on an AMD EPYC 7763, approximately 15.61 GiB
RAM, Ubuntu 24.04.5 LTS/Linux x64, Docker 28.0.4, Node 24.22.1 controller and
24.22.2 servers. Four distinct container host PIDs and exact image IDs/digests
are recorded. Controller, servers, PostgreSQL and Redis shared one host; there
was no WAN or browser rendering in these measurements. This result is separate
from historical native and Intel Docker campaigns and does not isolate a
hardware/runtime or application-performance difference. Latency tails exceed
100 ms; the accepted target is the specified p95, not a maximum-delay promise.

The [manifest](sprint-5/accepted-ubuntu-containers/manifest.json),
[recomputed analysis](sprint-5/accepted-ubuntu-containers/analysis.json),
[independent raw check](sprint-5/accepted-ubuntu-containers/independent-check.json),
[source proof](sprint-5/accepted-ubuntu-containers/source-verification.json),
[resources](sprint-5/accepted-ubuntu-containers/resources-summary.json),
[isolate observations](sprint-5/accepted-ubuntu-containers/isolates-summary.json)
and [checksums](sprint-5/accepted-ubuntu-containers/SHA256SUMS) accompany every
compressed raw operation/sample/telemetry file. Both the repository checker and
independent Python checker passed after downloading the artifact. The Python
check independently verifies coverage, membership, scheduling and percentiles;
full CRDT/presence/committed-save correctness remains the versioned harness's
oracle and cannot be reconstructed from latency tuples alone.

```sh
npm run benchmark:summarize -- docs/evidence/sprint-5/accepted-ubuntu-containers --check
python3 docs/evidence/sprint-4/verify_campaign.py docs/evidence/sprint-5/accepted-ubuntu-containers
```

No campaign retry or selected partial repeat was used for this release recheck.
Earlier failures remain in the Sprint 4 and local diagnostic records. Documentation
closure preserves measured inputs; future application/build changes require a
new affected-scenario recheck. This release does not claim soak stability,
cross-host independence, a universal reconnect bound or higher sustained rates.

## Local diagnostics and failures

Local verification used macOS arm64 with a Node 26 controller and production
Node 24 images. Unit tests (98), operations tests (6), the full earlier integration
run (83, followed by the added migration-filename regression), ten native-production
browser tests (two container-only skips), all twelve packaged browser tests and
both packaged security/fault tests passed at their recorded working revisions.
The final eight-test migration/startup subset passed after both fixes. Proxy
syntax validation used temporary certificates and a network-isolated nginx
container. Local image inventory is explicitly dirty/uncommitted evidence.

The first real-image recovery drill passed. Strengthening its preflight found
that PostgreSQL's `--version` must precede connection flags; that failed attempt
created no sealed archive and its own services were cleaned up. The corrected
drill then passed the deliberately damaged compressed-stream restore rollback.
Adding a real port-conflict case exposed the upstream listen promise's missing
HTTP error rejection. The application now contains that event, rejects startup
with a redacted category and cleans up its own resources. The expanded local
drill passed configuration failure, PostgreSQL/Redis unavailability, occupied
port, a connected-but-unresponsive Redis startup deadline, SQL rollback,
additive upgrade, old-image refusal and complete recovery/restart/rebackup.
Failed diagnostics are retained separately from later passes.

## Limits

Backups are logical snapshots with a recorded cut, not an in-memory journal or
zero-loss storage-disaster guarantee. Later confirmed commits are outside an
older archive; old browser copies can merge additional history on reconnect.
The database stores token hashes, so original complete share links must be
retained separately. Dump hashes detect corruption and do not authenticate
untrusted archives. The operator supplies off-host retention/encryption,
scheduling, secrets, TLS/DNS and production recovery objectives. CI's tmpfs and
single-host fixture do not characterize production disk loss, HA, PITR,
multi-region failover, arbitrary database scale or a production RPO/RTO SLA.

Only unique disposable services are used for drills; ordinary volumes, Project 1,
CloudDrive and the resume remain outside this work.
