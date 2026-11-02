# Build, deploy, upgrade and roll back

Commonplace is packaged as separate Node server and Next.js standalone images.
The default Compose deployment is bound to loopback and uses one persistent
PostgreSQL volume. Redis is a transient synchronization dependency. A single
PostgreSQL, Redis or edge remains a failure domain; this is not an HA deployment.

## Prepare a release

Use a clean checkout of the chosen commit, Node 24 and Docker Compose. Run the
required checks in CI, including unit/integration/operations tests, isolated
native browser tests, final-image browser/restart/fault tests, recovery drill,
benchmark correctness smoke and operational configuration validation. Full load
campaigns are opt-in; rerun affected profiles when application/build or benchmark
inputs can change the recorded results. Evidence belongs to its recorded commit,
images and environment, not to a later tree with the same project name.

For a public deployment, copy `.env.release.example` to a protected `.env.release`
(mode 0600), replace every placeholder, and supply two independent random secrets
(`openssl rand -hex 32`). Hex PostgreSQL passwords avoid URL-reserved characters
in the Compose connection string. Set the exact HTTPS origin, public API and WSS
URLs, a deployment-specific Redis prefix, and the exact trusted edge peer CIDRs.
Keep environment files/keys out of Git, browser bundles and image build context.
Native workspace commands accept exported backend variables or an environment
file in their working directory; Compose reads its explicitly selected env file.

Build both application images from the same checkout and browser URL settings:

```sh
export SOURCE_REVISION="$(git rev-parse HEAD)"
export COMMONPLACE_SERVER_IMAGE="commonplace-server:${SOURCE_REVISION}"
export COMMONPLACE_WEB_IMAGE="commonplace-web:${SOURCE_REVISION}"
docker compose --env-file .env.release -p commonplace -f compose.yaml build server web
```

The final images contain `org.opencontainers.image.revision`. Default development
builds are labeled `uncommitted`; that label does not establish a release source.
Retain actual image IDs/registry digests as well as source tags. Tags can be
retargeted: preserve verified images in the operator's registry/archive, and use
digest references through `COMMONPLACE_SERVER_IMAGE`/`COMMONPLACE_WEB_IMAGE` when
promoting a published release. This repository does not automatically publish
images, configure a registry, or change a public deployment.

## Fresh deployment

```sh
docker compose --env-file .env.release -p commonplace -f compose.yaml up -d --wait postgres redis
docker compose --env-file .env.release -p commonplace -f compose.yaml \
  run --rm --no-deps server node apps/server/dist/migrate-cli.js
docker compose --env-file .env.release -p commonplace -f compose.yaml \
  run --rm --no-deps server node apps/server/dist/migrate-cli.js --check
docker compose --env-file .env.release -p commonplace -f compose.yaml \
  up -d --no-build --wait server web
npm run release:manifest -- \
  --project commonplace --file compose.yaml --env-file .env.release \
  --output .backups/release-inventory-2026-11-02 --require-source-match
```

The manifest records the clean source commit/lockfile, migration checksums,
running service image IDs, revision labels, digests and architectures. The strict
flag refuses a dirty tree or mismatched application images. It inventories
versions; readiness, secrets, routing and recovery policy require their own
checks. Existing output directories are refused. Use a unique output per release.

Provide HTTPS/WSS at a trusted edge before public use. The supplied
`ops/nginx.production.example.conf` is a host-nginx template for loopback ports
3000/4000, with WebSocket upgrade, overwritten forwarded-IP headers, and blocked
operator routes. Replace its domain/certificate paths. Check the actual edge peer
address seen inside Docker before setting `TRUSTED_PROXY_CIDRS`; broad shared
network trust permits spoofing. Restrict backend/metrics access to the intended
private network. Supply valid certificates, DNS, renewal and operator access
through the deployment platform. `npm run test:proxy` checks template syntax with
temporary self-signed fixture certificates in a network-isolated container; it
does not install certificates or validate an actual public endpoint.

Route new sessions only to `/ready` instances. `/live` is not a durability or
dependency check. Scrape every instance directly with its separate metrics
secret, validate the operational alerts, and verify backup/off-host copy policy.
Perform a private create/share/edit/reconnect check and a fresh-client confirmed
read after application restart before accepting the deployment. See the
[operations runbook](operations.md) and [evidence index](evidence/README.md).

## Upgrade with existing data

1. Retain the previous source/image inventory and a verified, off-host-capable
   [backup](disaster-recovery.md). Use a maintenance window for incompatible
   changes; stop admission and let existing writers reach confirmed save. Do not
   terminate a dirty process while storage is unavailable. Do not run migrations
   concurrently with an operator backup/export transaction.
2. Review every new SQL file. Keep applied migration files byte-for-byte
   unchanged. Add migrations under a new zero-padded numeric filename such as `002_title_index.sql` (ASCII digits, underscore, lowercase letters/digits/underscores, `.sql`). Names and stored history use deterministic C ordering.
   `schema_migrations` must be an unchanged known prefix; checksum changes,
   unknown later migrations and gaps are refused. All pending files run under
   one PostgreSQL transaction/advisory lock. SQL requiring execution outside a
   transaction (such as concurrent index creation) is not supported by this runner.
3. Apply migrations with the new server image using `migrate-cli.js`, then run
   `--check`. A pending migration is reported as `migration_pending`; invalid
   recorded history is `migration_history_invalid`; failed SQL is
   `migration_apply_failed`. Nonzero exit stops the release. Never delete or
   rewrite history to force a deployment through. A failed transaction, including
   partial DDL/DML, is rolled back and its connection discarded.
4. Roll out the matching server and web images with `--no-build --wait`, keeping
   PostgreSQL's volume. Application startup also checks/applies migrations, but
   its 20-second startup deadline is deliberately bounded. Use the standalone
   migration command for longer planned work; its default statement deadline is
   60 seconds, adjustable with `--timeout-seconds 30..3600`. A successful migration
   stays committed even if a subsequent Redis or bind failure stops application
   startup. Such startup failure does not erase stored documents or undo an
   already committed schema migration.
5. Check readiness on every node, image inventory, old complete share links,
   formatting/deletions, presence, confirmed new writes and fresh-client restart
   recovery. Reopen admission only after the checks pass. Do not claim a
   collaboration acknowledgement or an old browser copy proves restored storage.

Configuration, PostgreSQL, migration, dependency/listen and startup-timeout
failures produce nonzero exits with fixed structured reasons. Unavailable Redis,
a Redis connection that accepts TCP but never responds, and an occupied HTTP
port are covered by packaged startup tests. Startup failures never become ready
release candidates. Graceful shutdown retains the 12-second store-retry window
and 15-second outer deadline; check for nonzero shutdown exits and pending debt.

## Rollback and recovery

An application-only rollback is safe to attempt only when the old image knows
the complete applied migration history and its browser/backend protocol remains
compatible. Select the previously retained image references together and run
`migrate-cli.js --check` before routing traffic. Older images refuse unknown
newer migration history even if a change appears additive. Do not bypass this
by changing stored checksums or deleting migration rows.

If schema compatibility does not permit application rollback, keep the current
deployment/volumes and restore the pre-upgrade backup to a **new** database in a
separate private deployment, then validate with the previous known images and
fresh clients. Follow [the recovery procedure](disaster-recovery.md). Work after
the backup's snapshot can be absent; retain the newer deployment for inspection
and deliberate recovery of that work. User/browser-local history may merge on
reconnect, so a database restore is not a global exact rewind of every editor.

`docker compose down` retains ordinary named volumes. Never use `down -v`,
volume pruning or database deletion as a restart, upgrade or recovery step. The
release drill uses only its own uniquely named tmpfs stacks and deliberately
stops its source; that test procedure is not permission to purge application
data. No automatic destructive down-migrations are provided.
