# Sprint 4: performance and reproducible benchmark evidence

## Accepted Docker follow-up result

The November 2, 2026 full Docker campaign on clean commit
`d358f4654481f3ef4bf89381be338efbf1d1f44e` met the unchanged primary contract.
Measured-input SHA-256 is
`e79a8d10cb8e8d2404628918756b686521635bd3cd3fdf641cf81cbf8956d158`.
This uses workload v1 and execution v4, including four client worker isolates in
one controller process and four independent final-image production Node servers.
All original application/build/dependency inputs, workload definition and
reconnect implementation are unchanged; the fix is in benchmark execution and
verification. Historical failed campaigns remain failures.

[Passing full workflow](https://github.com/maneesh-bijjula/real-time-collaborative-workspace/actions/runs/41513510869),
[manifest](sprint-4/accepted-ubuntu-containers/manifest.json),
[recomputed analysis](sprint-4/accepted-ubuntu-containers/analysis.json),
[independent Python check](sprint-4/accepted-ubuntu-containers/independent-check.json),
[source verification](sprint-4/accepted-ubuntu-containers/source-verification.json)
and [checksums](sprint-4/accepted-ubuntu-containers/SHA256SUMS) identify the inputs
and retained raw operation, recipient-sample and telemetry files. Both the
repository checker with `--check` and the independent Python raw coverage/timing
checker passed after download. State/presence/durability are checked by the
versioned Yjs harness; latency tuples alone cannot independently reconstruct them.

Each repeat completed all 12,000 measured operations and 588,000 peer samples,
with valid offered load, independent rich-text replay, equal full snapshots
including deletion sets across all 50 peers, expected presence, no unexpected
connection/policy failures, and committed PostgreSQL confirmation.

| Repeat | Measured mutations | Peer samples |   p50 |   p95 |   p99 | Maximum | Same-node p95 | Cross-node p95 |
| ------ | -----------------: | -----------: | ----: | ----: | ----: | ------: | ------------: | -------------: |
| 1      |             12,000 |      588,000 | 16.54 | 41.30 | 73.05 |  176.43 |         34.84 |          43.24 |
| 2      |             12,000 |      588,000 | 16.63 | 44.02 | 88.97 |  304.24 |         38.21 |          45.81 |
| 3      |             12,000 |      588,000 | 16.38 | 39.27 | 68.07 |  219.16 |         33.76 |          40.86 |

Values are milliseconds. All **36,000 measured mutations and 1,764,000 peer
samples**, including 1,349,280 cross-node samples, are present. No trimming,
denominator reduction, threshold relaxation or selection of repeats was used.
Source scheduling-lag p95 was 1.37/1.36/1.36 ms; maxima were 87.25/189.02/81.00 ms,
below the unchanged 500 ms guard. Final encoded states were
489,693/488,101/491,285 bytes, starting from 13,599 bytes. Quiescence-to-confirmed
database times were 624.81/783.10/636.69 ms, separate from propagation latency.

All **30 reconnect trials** passed: p50 **107.59 ms**, p95 **171.48 ms**, maximum
**177.15 ms**, with zero missing, failed or timed-out trials. The five-document
and 128 KiB characterizations produced all 27,000 and 147,000 expected samples,
at 23.46 and 26.07 ms p95 respectively. All five large-backlog characterization
trials passed, with a 1,177.60 ms maximum; these do not substitute for the primary
profiles.

The runner was Ubuntu 24.04.5 LTS/Linux x64, with four logical CPUs on an
Intel Xeon Platinum 8573C and approximately 15.61 GiB RAM. The controller ran
Node 24.22.1; server images ran Node 24.22.2, with Docker 28.0.4. PostgreSQL and
Redis used the dedicated random-port/tmpfs benchmark services. The manifest
records four distinct server container PIDs, image IDs/digests and successful
cleanup of only the unique campaign project. This differs from the AMD runner
used for both diagnostics and the historical native acceptance; timing
differences cannot be attributed solely to the client-isolation change or to
Docker versus native execution.

[Resource summaries](sprint-4/accepted-ubuntu-containers/resources-summary.json)
show per-server mean sampled CPU of 23.68–28.13% of one logical CPU, a 63.56%
largest sample and per-server observed peak RSS of approximately 260–319 MiB.
The largest sampled server event-loop p99 observation was 134.22 ms; it is not a
whole-run latency percentile. [Isolate observations](sprint-4/accepted-ubuntu-containers/isolates-summary.json)
show sampled worker heap peaks of 162–204 MB and a largest traffic event-loop
maximum of 196.08 ms, with no diagnostic entries dropped. Worker RSS is
process-wide and must not be summed. Application processing and latency tails
remain present: maximum propagation reached 304.24 ms. These results establish
the defined workload on this recorded host, not arbitrary Docker capacity,
browser/WAN latency, a universal reconnect bound or soak stability.

## Accepted native-process result

The complete Ubuntu native-process campaign met the defined primary contract on October 29, 2026 (October 30 UTC), on clean source commit `68ca5fc5f7755a2e864da9fc20fe7cb90cdd084d`. Measured-input SHA-256 is `75eeac3be6ab40cf1c13cdf6661aec09d71f0b9aa6c0af56622249a213484a10`.

This historical result applies to four independent production Node processes on the recorded AMD single-host environment using execution v2. The Docker acceptance above uses a separate Intel environment and execution v4. Results from different environments or individual passing repeats are not pooled or substituted for a complete campaign. The original native source-verification artifact records the delivery checkpoint; the benchmark harness has subsequently changed as described here.

[Passing workflow](https://github.com/maneesh-bijjula/real-time-collaborative-workspace/actions/runs/40983867983), [manifest](sprint-4/accepted-ubuntu-native/manifest.json), [recomputed analysis](sprint-4/accepted-ubuntu-native/analysis.json), [resource summary](sprint-4/accepted-ubuntu-native/resources-summary.json), [source verification](sprint-4/accepted-ubuntu-native/source-verification.json) and [artifact checksums](sprint-4/accepted-ubuntu-native/SHA256SUMS) identify the tested inputs and raw evidence. Compressed operation, recipient-latency and telemetry JSONL files accompany every load summary. The raw-data checker was also run independently after downloading the artifacts and passed with `--check`.

Latency values below are milliseconds. Each repeat includes all planned work, zero missing samples, correct rich text/formatting/deletion state and expected presence, no unexpected connection/policy errors, and PostgreSQL confirmation after quiescence.

| Repeat | Measured mutations | Peer samples |   p50 |   p95 |   p99 | Maximum | Same-node p95 | Cross-node p95 |
| ------ | -----------------: | -----------: | ----: | ----: | ----: | ------: | ------------: | -------------: |
| 1      |             12,000 |      588,000 | 18.52 | 46.47 | 79.62 |  415.48 |         40.16 |          48.08 |
| 2      |             12,000 |      588,000 | 18.03 | 45.89 | 79.02 |  375.24 |         40.78 |          47.24 |
| 3      |             12,000 |      588,000 | 17.32 | 42.59 | 66.70 |  209.02 |         36.59 |          44.30 |

All 16 source/recipient node pairs are reported per repeat. The largest individual pair p95 values were 56.30, 52.63 and 50.13 ms. The three primary windows contain **36,000 measured mutations and 1,764,000 peer applications**, including **1,349,280 cross-node samples**. Throughput was approximately 100 mutations/second in each window. No outlier trimming or missing-sample removal was used.

All **30 primary reconnect trials** passed: p50 **104.29 ms**, p95 **139.31 ms**, maximum **140.47 ms**, with zero missing, failed or timed-out trials. The separate five-trial large-backlog characterization had a maximum of 1,896.40 ms; it cannot substitute for the primary reconnect contract.

## Native workload and environment

The [versioned workload contract](../benchmarks.md) is unchanged: 50 simultaneous protocol writers distributed 13/13/12/12 across four independent Node instances, two atomic mutations/second/writer, approximately 10 KiB initial text, 30 seconds warmup and 120 measured seconds, repeated three times. Inserts, deletions and bold formatting operate on writer-owned rich-text paragraphs. Presence and relative-position cursors remain active. A sequence witness in the same transaction permits every recipient application to be timed, including merged batches and deletion/formatting operations.

Clients use the actual provider, collaboration-session and database-save tracker. An independent replay oracle checks visible content/formatting, and complete Yjs snapshots check state vectors and deletion sets. The benchmark measures source mutation to peer Yjs model application; it does not measure browser rendering or WAN latency.

The accepted runner exposed four logical CPUs (AMD EPYC 7763), approximately 15.61 GiB RAM, Ubuntu 24.04.5 LTS/Linux x64, host/server **Node 24.22.1**, and Docker 28.0.4. The controller and four distinct production server PIDs shared that host. PostgreSQL and Redis ran in separate disposable containers with random loopback ports; PostgreSQL used the benchmark's tmpfs `_test` database. Exact OS release, PIDs, image IDs/digests and placement are in the manifest. Four Node processes are not four independent host fault domains. All four shutdown codes were zero and cleanup removed only the campaign's own services.

Initial primary encoded state was 13,599 bytes. Final states were 488,852, 490,444 and 487,260 bytes, including CRDT history, structure and measurement witnesses. Atomic updates had 49-byte medians and 74-byte p95/max sizes. Source scheduling-lag p95 values were 7.44, 7.22 and 5.75 ms. Quiescence-to-confirmed-database times were 961.19, 902.69 and 873.78 ms; these are separate from propagation latency.

The five-document characterization produced all 27,000 expected peer samples at 22.78 ms p95. The 128 KiB text characterization produced all 147,000 expected samples at 26.03 ms p95. Each used its documented 10-second warmup/30-second measurement, rather than the primary three-repeat window.

## Native resource observations

[Resource summaries](sprint-4/accepted-ubuntu-native/resources-summary.json) can be regenerated from raw telemetry using `python3 docs/evidence/sprint-4/summarize_resources.py docs/evidence/sprint-4/accepted-ubuntu-native`. Sampling covers the entire load scenario, including warmup and post-traffic checks.

Per-server mean CPU observations ranged from 16.75–21.46% of one logical CPU; the largest sample was 36.20%. Per-server observed peak RSS ranged from 271–322 MiB. The largest per-scrape server event-loop p99 observation was 149.42 ms; that is not a whole-run latency percentile. Controller RSS at scenario completion ranged from 1,233–1,558 MiB and includes all 50 protocol replicas. Its whole-scenario event-loop maxima include untimed final-oracle/check work.

Sampled PostgreSQL CPU peaked at 17.21%, Redis at 6.56%. Raw telemetry includes their before/after counters and memory/network observations, plus per-node persistence, reconciliation, publication, memory and event-loop metrics. Native server network/block I/O is explicitly not sampled. These are sampled observations, not reserved capacity or long-duration memory bounds.

## Earlier implementation and regression verification

- Reusable staged admission avoids cloning the entire live CRDT per frame. Per-document serialization preserves concurrent size admission. Speculative/unapplied updates, deletion-only changes and causal gaps cannot contaminate the next validation.
- Exact V1 encoded-size accounting caches unchanged client contributions. Transaction cleanup invalidates advanced clocks, deletions and split/merge clients, including foreign-client splits with unchanged clocks. Pending histories and calls during transactions/cleanup use the stock encoder. The existing document ceiling remains exact. Seeded concurrent/GC/observer-ordering regressions compare results with the stock encoder; locked Yjs/lib0 assumptions must be revalidated on upgrade.
- Redis publishes accepted deltas with bounded in-flight count/bytes and visible deferrals/failures. Bidirectional load/periodic repair and committed-state reconciliation remain active. Existing socket, frame, document, byte and input-rate limits were not raised.
- Save checks share only in-flight PostgreSQL reads and reuse decoded snapshots only after a fresh successful read returns byte-identical state. Failed reads cannot reuse success. Every edit/connection change invalidates saved status immediately; checks wait 500 ms of quiet and still require a matching deletion-inclusive committed snapshot.
- Failed snapshot writes evict their connection. Driver timeouts cannot return an open transaction/row lock to the pool. Statement/driver/idle-transaction timeouts and real lock-contention regressions cover recovery.
- Outbound updates/presence use a fixed 20 ms merge window, with early flushing at 64 KiB buffered updates. Admission and dirty tracking still run per edit; propagation measurements include batching delay.

Local verification passed **96 unit tests**, **76 integration tests**, type checks, formatting/diff checks and the final-image 50-client correctness smoke. A fault-fixture race was corrected by awaiting the actual Redis disconnect event before acknowledging the injected fault; the original immediate health-503 assertion remains unchanged.

[Historical measured-source regular CI](https://github.com/maneesh-bijjula/real-time-collaborative-workspace/actions/runs/40983850322) passed the complete matrix: unit/integration/type/build/audit checks, native production browser tests (10 passed, one topology-specific skip), all 11 Docker browser tests, both packaged authorization/metrics and Redis/gateway fault checks, operational alert validation and the separate 50-client container correctness smoke. Smoke does not establish latency acceptance. The follow-up delivery must also pass regular CI on its exact final commit; measured-input fingerprints distinguish evidence edits from benchmark behavior changes.

## Docker follow-up investigation (November 2)

The original Docker failures remain failures. A new [instrumented single-repeat
diagnostic](https://github.com/maneesh-bijjula/real-time-collaborative-workspace/actions/runs/41510389829)
on `64629ec` reproduced interrupted source scheduling with 10,670/12,000 measured
operations and 65,170 missing peer samples. Observed p95 was 66.00 ms; that is not
acceptance. [Retained raw data and CPU profile](sprint-4/docker-investigation/inline-diagnostic-64629ec/)
and [diagnosis](sprint-4/docker-investigation/diagnosis.json) preserve this result.
Application and workload inputs were unchanged from the Sprint 4 delivery.

The controller's adjacent heap observations dropped from 1,116,053,040 to
405,934,520 bytes across the interruption. Its sampled CPU profile shows sustained
GC activity around that interval; the event-loop maximum was 1,042.81 ms. Command
launches peaked at 18.35 ms. This implicates controller GC pressure in this
reproduction, without assigning every historical failure or remaining latency
cost to the same cause. The original perf-hooks trace emitted no GC event above
its 50 ms filter, so no single-GC-duration claim is made.

Execution version 4 moves the unchanged 50 load replicas into four worker
isolates, retaining independent documents/providers, save checks, presence and
source schedules. A verified common monotonic time origin permits timestamps at
source mutation and recipient application before IPC. Raw arrivals join source
records afterwards. Independent rich-text replay runs in each worker, full
deletion-inclusive snapshots are compared across all workers, and every peer
still requires database confirmation. The original inline load path remains
available for diagnosis; reconnect execution is unchanged. Application server
code, limits, workload v1, missing-sample checks and thresholds are unchanged.

Local packaged correctness smoke passed. The [retained isolation smoke](sprint-4/docker-investigation/controller-pause-smoke/)
injected an 804.59 ms coordinator pause while all 300 measured operations and
14,700 peer samples completed; maximum propagation was 44.87 ms, showing that delayed IPC did not
become the sample timestamp. CI now runs this isolation regression. The raw
checker additionally recomputes scheduling and verifies planned source sequences;
unit fixtures reject source holes, missing recipient samples and forged saved
scheduling flags. All 98 unit tests and type checks passed; all 76 existing
integration tests passed before the harness-only changes. These are functional
and diagnostic results, not acceptance evidence. The subsequent full clean-source
campaign documented above supplies the Docker acceptance result.

The [worker confirmation repeat](sprint-4/docker-investigation/worker-confirmation-d358f46/)
on clean `d358f46` completed all 12,000 operations and 588,000 samples, with
69.81 ms p95, 179.01 ms maximum scheduling lag, correct state/presence and no
connection errors. Its [workflow](https://github.com/maneesh-bijjula/real-time-collaborative-workspace/actions/runs/41512555922)
ran only one instrumented repeat and cannot establish acceptance. Sampled worker
heaps peaked at 169–202 MB, with traffic event-loop maxima of 111–213 ms.

[Local packaged verification](sprint-4/docker-investigation/local-packaged-verification.json)
passed all 11 browser scenarios and both authorization/operations and real
Redis/gateway fault tests. During the first browser attempt, Playwright's default
output cleanup removed ignored `test-results`, including local benchmark copies.
Committed evidence and external audit artifacts remained intact. Available
committed copies and the failed Ubuntu workflow's raw artifact were restored;
local-only raw data without another copy could not be recovered. The incident
and recovery limits are [recorded explicitly](sprint-4/docker-investigation/artifact-retention-incident.json).
Browser output now uses `test-results/browser`, protecting benchmark directories
from subsequent browser cleanup. The full rerun used the required Chromium build
in a temporary directory after the initial attempt failed before browser launch.

## Failed campaigns and limits

The original same-source [Ubuntu container campaign](https://github.com/maneesh-bijjula/real-time-collaborative-workspace/actions/runs/40983865196) failed all three primary repeats because source scheduling interrupted offered traffic. Observed p95 values were 70.59/46.63/62.29 ms, but 87,220/234,563/113,582 planned peer samples were missing, so those percentiles cannot establish the target. [Retained summaries and scope](sprint-4/current-failed-campaigns/context.json) also include failed local native/container campaigns. The local native first repeat had 73,696 missing planned samples; its two later passing repeats are not accepted separately. The local container run was instrumented only after its first primary failure; subsequent timing is diagnostic evidence.

Earlier revisions failed too. Retained stages include [baseline](sprint-4/baseline/), [staging](sprint-4/staging-only/), [delta publication](sprint-4/delta-only/), [byte-verified decoding](sprint-4/byte-cache/), [size counting](sprint-4/size-counter/), [timeout/native comparison](sprint-4/native-local-cfff-quiet/), [save-check debounce](sprint-4/save-check-debounce/context.json) and [pre-cache Ubuntu batching](sprint-4/ubuntu-batching-76bb/context.json). CPU captures and counter diagnostics are labeled diagnostic, not acceptance. Failures and interrupted work remain failures rather than being removed from denominators.

The primary p95 target passed separately on the recorded native AMD and Docker Intel Ubuntu environments. Maximum propagation delays still exceeded 100 ms. Three two-minute windows do not establish soak stability, arbitrary-document capacity, a universal reconnect bound, capacity on other Docker hosts or a higher sustained rate. Shared CI hardware can vary between runs; each result belongs to its recorded environment and workload.

Reconnect timing begins at explicit healthy-network restoration and ends after all 50 peers, including affected peers and the online observer, converge. It excludes silent TCP failure detection, page reload/IndexedDB replay, dependency restart and automatic gateway failover. Existing packaged failure tests cover those separate functional paths with their documented bounds.

PostgreSQL tmpfs isolates test data and does not characterize production disk latency, host-power-loss durability, backup restoration or database high availability. Database-save confirmation retains the Sprint 1 committed-snapshot contract; collaboration synchronization alone never establishes durability. Deployment still needs the documented secrets, HTTPS/WSS, private networking, proxy and operations configuration.

## Reproduce

From the repository root with locked dependencies and a running Docker engine:

```sh
npm run benchmark:summarize -- docs/evidence/sprint-4/accepted-ubuntu-native --check
npm run benchmark:summarize -- docs/evidence/sprint-4/accepted-ubuntu-containers --check
python3 docs/evidence/sprint-4/verify_campaign.py docs/evidence/sprint-4/accepted-ubuntu-containers
npm run benchmark:full -- --runtime native --output test-results/benchmarks/new-native-campaign
npm run benchmark:full -- --runtime containers --output test-results/benchmarks/new-container-campaign
```

Use a new directory for each campaign. Avoid concurrent builds, pushes and other benchmarks on the host. The harness records source/hardware/Node/image fingerprints, refuses overwrites and cleans up only its own services. Never purge ordinary volumes. The manual GitHub workflow runs either variant and uploads artifacts on failure; container mode remains the default. Artifact hashes can be checked from the accepted campaign directory with `shasum -a 256 -c SHA256SUMS`.

Sprint 5 backup/restore and release closure remain pending. Project 1, CloudDrive and the resume are unchanged.
