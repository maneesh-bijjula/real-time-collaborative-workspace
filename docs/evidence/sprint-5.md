# Sprint 5: packaged release, recovery and evidence closure

Implementation validation is in progress. The acceptance source and final
exact-commit CI links will be recorded after clean-source verification; local
dirty-tree diagnostics below are not a final release acceptance claim.

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
