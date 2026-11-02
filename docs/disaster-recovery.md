# PostgreSQL backup and recovery

The operator tools require Node 24, Docker Compose, and a running PostgreSQL 17
Compose service with `POSTGRES_USER`, `POSTGRES_PASSWORD` and `POSTGRES_DB`.
They use that container's PostgreSQL tools, not a host `pg_dump` installation.
Every operation requires an explicit project and Compose file; repeat `--file`
for overlays and use `--env-file` for the deployment environment file.

## What a backup covers

`npm run db:backup` exports a repeatable-read PostgreSQL snapshot and keeps its
read-only transaction open while `pg_dump --snapshot` writes a custom-format
archive. The document count and migration checksums come from that same snapshot.
Concurrent commits after the cut are excluded, including commits made while the
dump is still running. A live backup does not flush unsaved editor memory.
For a maintenance backup, stop admission at the edge, wait for confirmed saves,
gracefully stop every writer instance, then dump while PostgreSQL remains running.
Never stop a process with unconfirmed changes merely to make a backup.

The archive contains private document titles, Yjs binary histories (including
deletions), access-token hashes, timestamps and migration history. It contains
no plaintext capability tokens because the database does not store them. Retain
the original complete share links separately in an appropriately protected place;
restoring the database cannot reconstruct a lost 256-bit token. Redis presence,
browser IndexedDB, environment secrets, TLS keys, PostgreSQL roles/ACLs and other
databases are outside this logical backup. Restored objects belong to the target
restore role; privileges are not copied.

The output directory is created exclusively with mode 0700; the archive and
manifest use mode 0600. Existing directories/backups are refused. Parent
directories are created when needed without changing existing permissions.
The manifest is sealed only after the dump exits successfully, reports no
warnings, and the archive is flushed and hashed. Failed runs can leave a private
unsealed directory or `.partial` file; these are not valid backups. Retry into
a new output directory. Do not commit archives: `.backups/`, private drill data,
environment files and dump files are excluded from Git/Docker build inputs.

## Create and retain a backup

From the repository root, with the intended deployment still selected:

```sh
npm run db:backup -- \
  --project commonplace --file compose.yaml --env-file .env.release \
  --database workspace --output .backups/pre-upgrade-2026-11-02
```

`--service` defaults to `postgres`. `--database` selects the actual source
database explicitly; if omitted, the running service's `POSTGRES_DB` is used.
Explicit selection matters after recovery when a PostgreSQL container may
still have a maintenance database as its initialization default. Names accepted
by the tools are lowercase identifiers, at most 63 characters, using letters,
digits and underscores, beginning with a letter.

Keep the archive and manifest together. Record `snapshotAt` (the database
statement time of the exported snapshot), `createdAt` (completion), source
project/database, PostgreSQL tool version, archive size/SHA-256 and migration
history. Exit zero and `backup_completed` identify a sealed output; a partial
directory, recent filename or checksum alone does not prove restorability.
Regularly run a fresh restore drill with the intended application version.

Copy sealed backups to access-controlled storage outside the database host,
encrypt them using the operator's storage/key policy, and keep the decryption
keys available independently. Choose and monitor backup frequency, retention
and off-host copy completion for the required recovery point. The repository
does not install a scheduler, cloud bucket, encryption-key manager or WAL/PITR
service. Loss of both database storage and its only same-host backup remains
unrecoverable. SHA-256 detects accidental corruption; it does not authenticate
a backup supplied by an untrusted party. Restore only trusted archives: a
PostgreSQL archive can contain executable database objects.

## Restore into a separate fresh deployment

Preserve the source deployment, its volumes and the selected backup. Use a
different host or a new project with non-conflicting loopback ports. For a
same-host recovery, copy the protected environment to `.env.restore` and choose,
for example, `POSTGRES_PORT=15435`, `REDIS_PORT=16382`, `API_PORT=4200` and
`WEB_PORT=3200`. Keep the candidate private and outside public routing.

1. Set `POSTGRES_DB=postgres` in `.env.restore` for initial database bootstrap.
   Start only PostgreSQL and Redis; do not start application writers yet:

   ```sh
   docker compose --env-file .env.restore -p commonplace-restored -f compose.yaml \
     up -d --wait postgres redis
   ```

2. Restore to a database name that does **not** exist:

   ```sh
   npm run db:restore -- \
     --project commonplace-restored --file compose.yaml --env-file .env.restore \
     --backup .backups/pre-upgrade-2026-11-02 --database workspace_recovered_20261102
   ```

   Integrity, supported PostgreSQL major/encoding, known migration-prefix
   checksums and `pg_restore --list` are checked before target creation. An
   existing database is always refused, including an empty one. `createdb`
   also fails if another creator wins a race. The tool never uses `--clean`,
   overwrites existing databases, or drops source storage.

   `pg_restore --single-transaction --exit-on-error` applies schema and data
   together. A failure inside it rolls back that transaction; the newly created
   database remains for inspection. A later verification failure also leaves
   the new target private for inspection. Do not route traffic to either case
   or retry by overwriting it: choose another new database after diagnosing the
   failure. A successful restore verifies count/history and runs `ANALYZE`.

3. Set `POSTGRES_DB=workspace_recovered_20261102` in `.env.restore`. Use the
   image version associated with the backup, or a tested version whose known
   migration history contains that backup prefix. Start/reconcile the database
   service configuration, then apply/check migrations explicitly:

   ```sh
   docker compose --env-file .env.restore -p commonplace-restored -f compose.yaml \
     up -d --wait postgres redis
   docker compose --env-file .env.restore -p commonplace-restored -f compose.yaml \
     run --rm --no-deps server node apps/server/dist/migrate-cli.js
   docker compose --env-file .env.restore -p commonplace-restored -f compose.yaml \
     run --rm --no-deps server node apps/server/dist/migrate-cli.js --check
   docker compose --env-file .env.restore -p commonplace-restored -f compose.yaml \
     up -d --no-build --wait server web
   ```

   Normal `compose.yaml` uses a persistent PostgreSQL volume, so reconciling its
   container environment retains the restored data. The drill's tmpfs databases
   are intentionally disposable and are not a production storage configuration.

4. Check candidate readiness, image/source inventory, metadata authorization,
   expected text, formatting, deletions and a new confirmed edit. Keep public
   traffic in maintenance while the edge is switched to the candidate for an
   operator-only fresh-browser check. Use the original complete link in a fresh
   context with no IndexedDB/provider copy: otherwise a surviving client can
   repopulate missing state and hide an incomplete restore. Verify an application
   restart with another fresh client before reopening admission. Keep the old
   deployment/volumes until the recovery is accepted and retention permits removal.

5. Back up the recovered database explicitly and resume the operator's off-host
   backup/monitoring policy:

   ```sh
   npm run db:backup -- \
     --project commonplace-restored --file compose.yaml --env-file .env.restore \
     --database workspace_recovered_20261102 --output .backups/after-recovery-2026-11-02
   ```

Restore/backup commands have a default 300-second command deadline, adjustable
with `--timeout-seconds 30..3600`, plus bounded connection/lock waits. Errors emit
fixed categories and nonzero exits, without raw SQL, URLs, tool stderr or private
contents. Investigate the selected service's protected operator logs when needed;
never paste a dump, secrets or document contents into public CI evidence.

## Recovery boundaries and verification

Recovery point is the exported snapshot, not the latest edit or dump completion
time. Successfully committed work after that point is outside the archive.
Old browser/IndexedDB copies may merge additional history when reconnected; the
application does not implement an operator-controlled exact rewind of all peers.
Unconfirmed edits still need a surviving client copy. The save contract remains
the exact current PostgreSQL snapshot contract, separate from backup freshness.

`npm run test:release` builds real server images in a unique temporary deployment.
It tests active-write snapshot consistency, private output modes, malformed and
resealed damaged archives, refusal of existing targets, transactional restore
failure, migration/startup failure, additive upgrade and old-image refusal,
separate fresh deployment recovery, authorization, formatting/deletion snapshots,
fresh presence, later edits, SIGKILL/restart and backup after recovery. It stops
the source services and destroys old clients before recovery. Only its own tmpfs
services are removed; no ordinary volumes are purged. Redacted evidence is under
`test-results/release/`; private archives stay outside that artifact directory.

Regular CI runs this drill. The manual **Packaged recovery campaign** workflow
runs it separately and retains failure evidence. See [Sprint 5 evidence](evidence/sprint-5.md)
and the [PostgreSQL 17 dump](https://www.postgresql.org/docs/17/app-pgdump.html),
[snapshot](https://www.postgresql.org/docs/17/functions-admin.html#FUNCTIONS-SNAPSHOT-SYNCHRONIZATION)
and [restore](https://www.postgresql.org/docs/17/app-pgrestore.html) documentation.
These single-host functional checks do not establish production disk durability,
storage failure independence, a production RPO/RTO SLA, multi-region recovery,
PITR, automated backup retention or restore performance at arbitrary scale.
