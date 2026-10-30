# Sprint 4: performance and reproducible benchmark evidence

## Accepted workload result

The complete Ubuntu native-process campaign met the defined primary contract on October 29, 2026 (October 30 UTC), on clean source commit `68ca5fc5f7755a2e864da9fc20fe7cb90cdd084d`. Measured-input SHA-256 is `75eeac3be6ab40cf1c13cdf6661aec09d71f0b9aa6c0af56622249a213484a10`.

This result applies to four independent production Node processes on the recorded single-host environment. **The separate Docker campaigns failed the full primary contract. No Docker throughput/latency claim is established.** Results from different environments or individual passing repeats are not pooled or substituted for a complete campaign.

[Passing workflow](https://github.com/maneesh-bijjula/real-time-collaborative-workspace/actions/runs/40983867983), [manifest](sprint-4/accepted-ubuntu-native/manifest.json), [recomputed analysis](sprint-4/accepted-ubuntu-native/analysis.json), [resource summary](sprint-4/accepted-ubuntu-native/resources-summary.json), [source verification](sprint-4/accepted-ubuntu-native/source-verification.json) and [artifact checksums](sprint-4/accepted-ubuntu-native/SHA256SUMS) identify the tested inputs and raw evidence. Compressed operation, recipient-latency and telemetry JSONL files accompany every load summary. The raw-data checker was also run independently after downloading the artifacts and passed with `--check`.

Latency values below are milliseconds. Each repeat includes all planned work, zero missing samples, correct rich text/formatting/deletion state and expected presence, no unexpected connection/policy errors, and PostgreSQL confirmation after quiescence.

| Repeat | Measured mutations | Peer samples |   p50 |   p95 |   p99 | Maximum | Same-node p95 | Cross-node p95 |
| ------ | -----------------: | -----------: | ----: | ----: | ----: | ------: | ------------: | -------------: |
| 1      |             12,000 |      588,000 | 18.52 | 46.47 | 79.62 |  415.48 |         40.16 |          48.08 |
| 2      |             12,000 |      588,000 | 18.03 | 45.89 | 79.02 |  375.24 |         40.78 |          47.24 |
| 3      |             12,000 |      588,000 | 17.32 | 42.59 | 66.70 |  209.02 |         36.59 |          44.30 |

All 16 source/recipient node pairs are reported per repeat. The largest individual pair p95 values were 56.30, 52.63 and 50.13 ms. The three primary windows contain **36,000 measured mutations and 1,764,000 peer applications**, including **1,349,280 cross-node samples**. Throughput was approximately 100 mutations/second in each window. No outlier trimming or missing-sample removal was used.

All **30 primary reconnect trials** passed: p50 **104.29 ms**, p95 **139.31 ms**, maximum **140.47 ms**, with zero missing, failed or timed-out trials. The separate five-trial large-backlog characterization had a maximum of 1,896.40 ms; it cannot substitute for the primary reconnect contract.

## Workload and environment

The [versioned workload contract](../benchmarks.md) is unchanged: 50 simultaneous protocol writers distributed 13/13/12/12 across four independent Node instances, two atomic mutations/second/writer, approximately 10 KiB initial text, 30 seconds warmup and 120 measured seconds, repeated three times. Inserts, deletions and bold formatting operate on writer-owned rich-text paragraphs. Presence and relative-position cursors remain active. A sequence witness in the same transaction permits every recipient application to be timed, including merged batches and deletion/formatting operations.

Clients use the actual provider, collaboration-session and database-save tracker. An independent replay oracle checks visible content/formatting, and complete Yjs snapshots check state vectors and deletion sets. The benchmark measures source mutation to peer Yjs model application; it does not measure browser rendering or WAN latency.

The accepted runner exposed four logical CPUs (AMD EPYC 7763), approximately 15.61 GiB RAM, Ubuntu 24.04.5 LTS/Linux x64, host/server **Node 24.22.1**, and Docker 28.0.4. The controller and four distinct production server PIDs shared that host. PostgreSQL and Redis ran in separate disposable containers with random loopback ports; PostgreSQL used the benchmark's tmpfs `_test` database. Exact OS release, PIDs, image IDs/digests and placement are in the manifest. Four Node processes are not four independent host fault domains. All four shutdown codes were zero and cleanup removed only the campaign's own services.

Initial primary encoded state was 13,599 bytes. Final states were 488,852, 490,444 and 487,260 bytes, including CRDT history, structure and measurement witnesses. Atomic updates had 49-byte medians and 74-byte p95/max sizes. Source scheduling-lag p95 values were 7.44, 7.22 and 5.75 ms. Quiescence-to-confirmed-database times were 961.19, 902.69 and 873.78 ms; these are separate from propagation latency.

The five-document characterization produced all 27,000 expected peer samples at 22.78 ms p95. The 128 KiB text characterization produced all 147,000 expected samples at 26.03 ms p95. Each used its documented 10-second warmup/30-second measurement, rather than the primary three-repeat window.

## Resource observations

[Resource summaries](sprint-4/accepted-ubuntu-native/resources-summary.json) can be regenerated from raw telemetry using `python3 docs/evidence/sprint-4/summarize_resources.py docs/evidence/sprint-4/accepted-ubuntu-native`. Sampling covers the entire load scenario, including warmup and post-traffic checks.

Per-server mean CPU observations ranged from 16.75–21.46% of one logical CPU; the largest sample was 36.20%. Per-server observed peak RSS ranged from 271–322 MiB. The largest per-scrape server event-loop p99 observation was 149.42 ms; that is not a whole-run latency percentile. Controller RSS at scenario completion ranged from 1,233–1,558 MiB and includes all 50 protocol replicas. Its whole-scenario event-loop maxima include untimed final-oracle/check work.

Sampled PostgreSQL CPU peaked at 17.21%, Redis at 6.56%. Raw telemetry includes their before/after counters and memory/network observations, plus per-node persistence, reconciliation, publication, memory and event-loop metrics. Native server network/block I/O is explicitly not sampled. These are sampled observations, not reserved capacity or long-duration memory bounds.

## Implementation and regression verification

- Reusable staged admission avoids cloning the entire live CRDT per frame. Per-document serialization preserves concurrent size admission. Speculative/unapplied updates, deletion-only changes and causal gaps cannot contaminate the next validation.
- Exact V1 encoded-size accounting caches unchanged client contributions. Transaction cleanup invalidates advanced clocks, deletions and split/merge clients, including foreign-client splits with unchanged clocks. Pending histories and calls during transactions/cleanup use the stock encoder. The existing document ceiling remains exact. Seeded concurrent/GC/observer-ordering regressions compare results with the stock encoder; locked Yjs/lib0 assumptions must be revalidated on upgrade.
- Redis publishes accepted deltas with bounded in-flight count/bytes and visible deferrals/failures. Bidirectional load/periodic repair and committed-state reconciliation remain active. Existing socket, frame, document, byte and input-rate limits were not raised.
- Save checks share only in-flight PostgreSQL reads and reuse decoded snapshots only after a fresh successful read returns byte-identical state. Failed reads cannot reuse success. Every edit/connection change invalidates saved status immediately; checks wait 500 ms of quiet and still require a matching deletion-inclusive committed snapshot.
- Failed snapshot writes evict their connection. Driver timeouts cannot return an open transaction/row lock to the pool. Statement/driver/idle-transaction timeouts and real lock-contention regressions cover recovery.
- Outbound updates/presence use a fixed 20 ms merge window, with early flushing at 64 KiB buffered updates. Admission and dirty tracking still run per edit; propagation measurements include batching delay.

Local verification passed **96 unit tests**, **76 integration tests**, type checks, formatting/diff checks and the final-image 50-client correctness smoke. A fault-fixture race was corrected by awaiting the actual Redis disconnect event before acknowledging the injected fault; the original immediate health-503 assertion remains unchanged.

[Exact measured-source regular CI](https://github.com/maneesh-bijjula/real-time-collaborative-workspace/actions/runs/40983850322) passed the complete matrix: unit/integration/type/build/audit checks, native production browser tests (10 passed, one topology-specific skip), all 11 Docker browser tests, both packaged authorization/metrics and Redis/gateway fault checks, operational alert validation and the separate 50-client container correctness smoke. Smoke does not establish latency acceptance. The final delivery's evidence/documentation commit must also pass regular CI; measured-input fingerprints distinguish those edits from behavior changes.

## Failed campaigns and limits

The same-source [Ubuntu container campaign](https://github.com/maneesh-bijjula/real-time-collaborative-workspace/actions/runs/40983865196) failed all three primary repeats because source scheduling interrupted offered traffic. Observed p95 values were 70.59/46.63/62.29 ms, but 87,220/234,563/113,582 planned peer samples were missing, so those percentiles cannot establish the target. [Retained summaries and scope](sprint-4/current-failed-campaigns/context.json) also include failed local native/container campaigns. The local native first repeat had 73,696 missing planned samples; its two later passing repeats are not accepted separately. The local container run was instrumented only after its first primary failure; subsequent timing is diagnostic evidence.

Earlier revisions failed too. Retained stages include [baseline](sprint-4/baseline/), [staging](sprint-4/staging-only/), [delta publication](sprint-4/delta-only/), [byte-verified decoding](sprint-4/byte-cache/), [size counting](sprint-4/size-counter/), [timeout/native comparison](sprint-4/native-local-cfff-quiet/), [save-check debounce](sprint-4/save-check-debounce/context.json) and [pre-cache Ubuntu batching](sprint-4/ubuntu-batching-76bb/context.json). CPU captures and counter diagnostics are labeled diagnostic, not acceptance. Failures and interrupted work remain failures rather than being removed from denominators.

The primary p95 target passed on the recorded native Ubuntu environment. Maximum propagation delays still exceeded 100 ms. Three two-minute windows do not establish soak stability, arbitrary-document capacity, a universal reconnect bound, Docker capacity or a higher sustained rate. Shared CI hardware can vary between runs; the result belongs to its recorded environment and workload.

Reconnect timing begins at explicit healthy-network restoration and ends after all 50 peers, including affected peers and the online observer, converge. It excludes silent TCP failure detection, page reload/IndexedDB replay, dependency restart and automatic gateway failover. Existing packaged failure tests cover those separate functional paths with their documented bounds.

PostgreSQL tmpfs isolates test data and does not characterize production disk latency, host-power-loss durability, backup restoration or database high availability. Database-save confirmation retains the Sprint 1 committed-snapshot contract; collaboration synchronization alone never establishes durability. Deployment still needs the documented secrets, HTTPS/WSS, private networking, proxy and operations configuration.

## Reproduce

From the repository root with locked dependencies and a running Docker engine:

```sh
npm run benchmark:summarize -- docs/evidence/sprint-4/accepted-ubuntu-native --check
npm run benchmark:full -- --runtime native --output test-results/benchmarks/new-native-campaign
npm run benchmark:full -- --runtime containers --output test-results/benchmarks/new-container-campaign
```

Use a new directory for each campaign. Avoid concurrent builds, pushes and other benchmarks on the host. The harness records source/hardware/Node/image fingerprints, refuses overwrites and cleans up only its own services. Never purge ordinary volumes. The manual GitHub workflow runs either variant and uploads artifacts on failure; container mode remains the default. Artifact hashes can be checked from the accepted campaign directory with `shasum -a 256 -c SHA256SUMS`.

Sprint 5 backup/restore and release closure remain pending. Project 1, CloudDrive and the resume are unchanged.
