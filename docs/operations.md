# Operational visibility and incident response

Each Node instance owns a separate Prometheus registry and emits structured JSON events. Scrape every instance directly on its private address; a load-balanced `/metrics` URL mixes unrelated process counters and can hide a failed node. The example gateway rejects operator routes.

## Liveness, readiness, and draining

- `GET /live`: 200 while the process can serve HTTP. It does not query PostgreSQL/Redis or certify persistence.
- `GET /ready`: 200 only when PostgreSQL responds, both Redis transports are ready and respond to PING, reconciliation is healthy, there is no failed snapshot store, the oldest dirty revision is at most 30 seconds old, and shutdown has not begun. Otherwise 503. `/health` is a compatibility alias.
- Probes coalesce, cache for 250 ms, and run in the background every two seconds. Responses have a two-second observation deadline. A timed-out underlying probe remains the single in-flight probe until it settles, preventing unbounded probe buildup. Transport status alone is insufficient: tests cover a PING stalled while Redis still reports TCP ready. Observations can lag a newly occurring failure by the sampling/deadline interval; readiness is not a distributed consistency certificate.
- During shutdown readiness goes false before new admission stops. Physical sockets close, pending stores flush/retry under Sprint 1's shutdown deadline, and resources close. Unconfirmed changes still require a surviving peer/local copy if shutdown cannot commit. Failed shutdown reports a nonzero process exit.

Configure the load balancer/orchestrator to route new sessions only to ready nodes. A healthy probe does not promise that an arbitrary document has capacity, that every network path works, or that a future write will commit. Admission can separately return 429/503. The editor's exact committed-snapshot check remains the database durability indication.

## Protect metrics

Generate a separate operator secret with `openssl rand -hex 32`, supply it as `METRICS_TOKEN` through the deployment's secret mechanism, and send `Authorization: Bearer ...` when scraping. Do not reuse a document capability or put this secret in browser build variables. Without the setting, `/metrics` is disabled; an empty setting also disables it. Incorrect credentials return 401 without revealing registry data.

`ops/prometheus/prometheus.yml` demonstrates a four-instance private scrape. Mount the matching secret as `/run/secrets/commonplace_metrics_token` in the Prometheus container; the file must be readable only by the intended service/operator. The example uses a trusted internal HTTP network; configure HTTPS and a CA file if the backend network is not private. Its static target names match `compose.cluster.yaml`; adapt targets and alert thresholds to the actual deployment. The checked-in verification token is a disposable test fixture and must never become a real operator secret.

The repository supplies validated alert examples and PromQL below; it does not deploy a public dashboard, configure a paging destination, or run another project's monitoring stack. Connect these rules to the operator's existing Prometheus/Alertmanager and notification policy.

## Metric contract

All custom names begin with `commonplace_`. Labels use fixed categories only. Document IDs, titles, content, tokens, socket/session IDs, IP addresses, and user names are excluded. Process counters reset at restart; distinguish nodes with the scraper's `instance` label.

| Metric                                                                         | Meaning                                                                                                                                                                                            |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ready`, `dependency_up{dependency}`                                           | Last readiness sample and PostgreSQL / Redis publisher / Redis subscriber / reconciliation state                                                                                                   |
| `sockets`, `sessions`, `documents`, `authenticating`, `queued_bytes`           | Open physical sockets, active authenticated sessions, loaded/loading documents, auth queries in flight, and queued/in-flight input bytes                                                           |
| `socket_connections_total`, `socket_disconnects_total{kind}`, `sessions_total` | Physical and authenticated session lifecycle counters; bounded close kind is normal/policy/transport                                                                                               |
| `reconnects_total`                                                             | Client-reported successful in-page session rejoins, counted once per authenticated connection. It excludes page reloads/new tabs and is operational telemetry, not verified identity/accounting.   |
| `authentication_total{result}`                                                 | Allowed/denied document-capability checks on HTTP and WebSocket surfaces, plus unavailable WebSocket authorization checks during dependency failures                                               |
| `rejections_total{reason}`                                                     | Admission/protocol/limit refusals, with an allowlisted reason category; unrecognized text becomes `other`                                                                                          |
| `http_requests_total{route,result}`                                            | Fixed route category and HTTP status class; no raw URL labels                                                                                                                                      |
| `dirty_documents`, `persistence_failures`, `oldest_dirty_seconds`              | Pending revision count, documents whose last snapshot attempt failed, and monotonic age of oldest uncommitted local revision                                                                       |
| `persistence_attempts_total{result}`                                           | Snapshot write attempts, including retries and their outcomes                                                                                                                                      |
| `snapshot_write_seconds`                                                       | Histogram of PostgreSQL snapshot write attempt duration, excluding retry sleep                                                                                                                     |
| `durable_save_seconds`                                                         | Histogram observed when a dirty episode is fully covered by a successful commit. Concurrent edits can keep an episode open. It is not a per-keystroke sample or collaboration propagation latency. |
| `reconciliation_total{result}`, `reconciliation_seconds`                       | Completed repair passes and duration/outcome; one pass may cover several documents                                                                                                                 |
| `last_reconciliation_timestamp_seconds`                                        | Wall-clock timestamp of last successful repair pass; compare with scraper time                                                                                                                     |
| `resident_memory_bytes`, `event_loop_delay_p99_seconds`                        | RSS and event-loop delay p99 since the previous scrape                                                                                                                                             |

Age tracking starts on change, includes the debounce/retry period, and preserves the age of revisions that arrive during an in-flight store. A successful older write cannot clear newer debt. Save failures/readiness and client confirmation are independent checks; neither collaboration synchronization nor a generic timestamp becomes a database acknowledgement.

## Queries and alerts

Examples for an operator dashboard:

```promql
# Ready instance count, active sessions and recent completed page-session rejoins.
sum(commonplace_ready)
sum(commonplace_sessions)
sum(rate(commonplace_reconnects_total[5m]))

# Worst pending age and failed document count by instance.
commonplace_oldest_dirty_seconds
commonplace_persistence_failures

# Save-episode p95 by instance. This is database persistence, not update latency.
histogram_quantile(0.95, sum by (instance, le) (rate(commonplace_durable_save_seconds_bucket[5m])))

# Rejections by reason and node; never group by document/user/capability.
sum by (instance, reason) (rate(commonplace_rejections_total[5m]))

# Repair errors, RSS and event-loop delay.
sum by (instance) (rate(commonplace_reconciliation_total{result="failure"}[5m]))
commonplace_resident_memory_bytes
commonplace_event_loop_delay_p99_seconds
```

`ops/prometheus/alerts.yml` covers missing scrapes, unready nodes, failed stores, old dirty state, Redis transport failure, and stale repair progress. Each alert includes an operator action. Thresholds are initial operational examples, not measured service objectives. `alerts.test.yml` checks critical failure and healthy cases. CI checks configuration syntax, rule syntax, and rule evaluations using pinned Prometheus 3.15.1:

```sh
docker run --rm --network none -v "$PWD/ops/prometheus:/etc/prometheus:ro" \
  --entrypoint /bin/promtool prom/prometheus:v3.15.1 check config --syntax-only /etc/prometheus/prometheus.yml
docker run --rm --network none -v "$PWD/ops/prometheus:/etc/prometheus:ro" \
  --entrypoint /bin/promtool prom/prometheus:v3.15.1 check rules /etc/prometheus/alerts.yml
docker run --rm --network none -v "$PWD/ops/prometheus:/etc/prometheus:ro" -w /etc/prometheus \
  --entrypoint /bin/promtool prom/prometheus:v3.15.1 test rules alerts.test.yml
```

## Structured logs

Events contain `time`, `level`, `event`, and an optional allowlisted `reason`. First-party startup/request/dependency errors do not serialize raw exceptions, SQL, configuration values, headers, or frames. Repetitive event/reason pairs emit at most once per second per process; counters retain the full rejection/failure counts. This bounds both log volume and reason cardinality. Capture the process/container identity outside the application record.

Useful event sequences are `persistence_failed` → `persistence_recovered`, `synchronization_failed` → `synchronization_recovered`, `dependency_failed` → `dependency_recovered`, and `server_stopping` → `server_stopped` or `shutdown_failed`. Log messages are data; do not copy client-controlled payloads into future error fields. Tests exercise content/token sentinels and arbitrary reason text to prevent accidental telemetry disclosure.

## Incident actions

| Signal                                   | Action and recovery check                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL down / failed or aging stores | Stop routing new sessions to affected nodes, inspect connectivity, credentials, capacity, locks and database logs. Keep processes with dirty state alive while restoring PostgreSQL; do not purge or replace their volumes. Verify failure count and dirty age return to zero, readiness recovers, and editors obtain database confirmation without another edit. |
| Redis transport down / repair stalled    | Restore Redis connectivity/credentials and check both transports respond. Existing local edits can still commit to PostgreSQL. Wait for reconciliation success/timestamp progression and cross-node state/presence convergence; resubscription alone is insufficient. Missed presence removals retain Sprint 2's expiry policy.                                   |
| Policy rejection / queue pressure        | Inspect bounded reason counters and memory/event-loop trends; distinguish an undersized legitimate workload from abuse. Do not blindly raise every limit. Permanently rejected browsers retain local text and pause retries; export before reopening. Apply edge controls for shared/global quotas.                                                               |
| Process crash or rollout                 | Reconnect through a surviving ready instance, check committed content and fresh database confirmation. An abrupt crash can still lose unconfirmed state with no surviving peer/browser copy. Follow the persistence contract; storage destruction and backup restoration are Sprint 5 work.                                                                       |
| Metrics missing                          | Check scrape credentials/private network and process liveness. A missing scrape is not zero backlog. A load-balanced scrape is not per-instance visibility.                                                                                                                                                                                                       |

## Verification boundaries

The security/operations integration tests induce actual PostgreSQL connection loss, Redis subscriber disconnection, a stalled Redis command, blocked writes, concurrent near-limit updates, hostile protocol traffic, proxy spoofing, and admission pressure. They verify no false saved/readiness indication, retained healthy-peer operation, debt clearance/recovery, and bounded/redacted telemetry. Packaged checks verify all four final-image servers, then stop/start the disposable Redis container and check live/ready/metrics during that real outage plus gateway failover.

These single-host functional checks do not establish throughput, WAN behavior, a 50-editor p95, a universal two-second reconnect bound, or independence from single PostgreSQL/Redis/gateway failures. Benchmarking belongs to Sprint 4; disaster recovery and final release closure belong to Sprint 5.
