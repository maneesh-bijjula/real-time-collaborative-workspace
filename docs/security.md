# Capability security and resource policy

Commonplace authorizes documents with bearer capabilities, not user accounts. A newly created document receives a random 256-bit token; PostgreSQL stores its SHA-256 hash. A complete private link grants read/write access to that document. Token comparisons validate the 43-character base64url format and use a constant-time digest comparison. Metadata authorization reads do not fetch document content.

## Threat model and trust boundary

Protected assets are document content, share capabilities, committed CRDT history, service availability, and operator credentials. The application treats network clients, HTTP inputs, WebSocket frames, and forwarding headers as untrusted. Tests include unauthenticated requests, incorrect/cross-document capabilities, attempts against already loaded documents, malformed traffic, resource exhaustion, and dependency failures.

The capability is the authorization boundary. A holder can deliberately change or delete that document's content and use any display name. Display names/cursors are not verified identities. There are no accounts, per-user roles, token expiry/revocation, audit history, or protection against another authorized collaborator intentionally editing shared content. Redis and PostgreSQL belong to the trusted backend network; a compromised peer or database is outside the capability boundary. Backend protocols must not be exposed to arbitrary clients.

The browser stores recent share links and IndexedDB copies. The URL fragment is not part of an HTTP page request, but remains accessible to browser JavaScript/extensions and anyone given the complete link. An XSS or browser compromise can expose locally stored capabilities. Keep dependencies patched, use a dedicated application origin, avoid untrusted scripts, and treat exported files and backups as private data. Removing a link from one browser does not revoke other copies.

## Authorization matrix

| Surface                         | Authorized behavior                                                                 | Rejection behavior                                                                                                                                                                |
| ------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/documents`           | Anonymous creation with a valid title, subject to admission limits                  | Invalid input 400, rejected origin 403, oversized body 413, encoded body 415, rate limit 429, capacity/draining 503                                                               |
| `GET /api/documents/:id`        | Correct bearer capability returns metadata without the token                        | Missing, incorrect, or another document's token returns the same 404; invalid ID returns 400                                                                                      |
| `PATCH /api/documents/:id`      | Correct bearer capability and valid title rename the document                       | Same capability rejection as GET; rejected requests do not rename                                                                                                                 |
| WebSocket authentication        | One UUID-addressed document per physical socket, checked before loading/subscribing | Incorrect/missing/cross-document capability receives a generic denial and physical close 1008; queued changes never reach the shared document                                     |
| Sync, awareness, save checks    | Available only to that authenticated document session                               | Switching the addressed document, including awareness queries or save checks, closes the socket without exposing another document                                                 |
| Credential changes/multiplexing | Start a fresh socket/session                                                        | In-place token replacement and session-address multiplexing are not supported; close 1008                                                                                         |
| Client protocol                 | Allowlisted sync/awareness/query/save-check/session-ready/close messages            | Server-only broadcast opcodes, unknown opcodes, trailing or malformed frames are rejected                                                                                         |
| `/live`, `/ready`, `/health`    | Minimal process/dependency readiness status without document details                | Readiness is 503 during draining, failed/stalled dependencies, failed persistence, or excessive dirty age                                                                         |
| `/metrics`                      | Separate operator bearer secret, only when configured                               | Disabled without `METRICS_TOKEN` (404); incorrect/missing operator secret is 401. Document capabilities do not authorize metrics. The example gateway blocks this route entirely. |

An approved browser origin is required when an `Origin` header is present. Requests without `Origin` are allowed for native clients, but still require a document capability. Origins are not authentication: a native client can choose its header. WebSocket upgrades accept exactly `/collaboration`, with no query parameters, so credentials cannot be passed in an upgrade URL. Authentication travels in the first binary protocol message. HTTP metadata uses an Authorization header; neither protocol accepts a token as a query credential.

The four-process authorization matrix tests HTTP reads/renames and WebSocket denial on every warm instance. Further tests cover cold documents, cross-document frames after a valid login, token replacement, rejected sync/awareness/save-check requests, and legitimate peers remaining usable. Final-image tests repeat warm authorization checks on all four containers.

## Bounded processing

The transport uses `ws` with compression disabled, stages frames in bounded queues, and processes each socket serially. Before dispatching to Hocuspocus it validates the binary envelope, document address, opcode, sync encoding, awareness/cursor shape, and stateless schema. Only the versioned database-check and session-ready stateless messages are accepted.

Yjs updates are staged before touching live state. Structural count and exact projected serialized state size are checked there; malformed or oversized local updates therefore cannot partially mutate the shared document. Each loaded document reuses one staging copy that mirrors accepted live/peer updates, avoiding a full CRDT reconstruction on every keystroke. A failed/rejected/unapplied candidate, mismatched deletion-inclusive snapshot, pending causal gap, or document destruction discards that copy; speculative edits/deletions cannot affect later admissions. This adds one bounded-by-document-lifecycle copy in memory. Validation and application of mutating frames remain serialized per document on each process, so simultaneous local sockets cannot individually pass the same smaller revision. Awareness limits include field/byte bounds, safe display colors, and typed Yjs relative positions; malformed cursor objects never reach browser renderers.

These are **per-instance admission limits**, not a distributed storage quota. Redis/committed snapshot merges preserve previously accepted peer edits, including during partitions. Concurrent accepted changes on different instances can merge above the local projected-size ceiling; dropping those histories would violate the durability/convergence contract. Further local updates must fit the ceiling. Large existing documents remain readable subject to outbound capacity. Operators should monitor memory, keep instance counts controlled, and tune document/admission limits for their workload. No cross-node global quota or arbitrary-load availability guarantee is claimed.

Default ceilings (binary units):

| Resource                             | Default                                                                                                                                       |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Physical sockets                     | 512 per instance, 128 per source IP or IPv6 /64                                                                                               |
| Loaded/loading/reserved documents    | 128 per instance, including dirty documents retained for retry                                                                                |
| Sessions granted per document        | 128 per instance                                                                                                                              |
| Authentication queries               | At most 32 in flight; 5-second absolute socket authentication/setup deadline                                                                  |
| Inbound message                      | 256 KiB, including fragmented-message reassembly; text frames rejected                                                                        |
| Pending input per socket             | 512 KiB and 64 messages, including the frame being processed                                                                                  |
| Pending input across instance        | 16 MiB and 4,096 messages                                                                                                                     |
| Output backlog                       | 8 MiB, charging the next response before sending; slow consumers close with 1013                                                              |
| Projected local Yjs state            | 4 MiB serialized; at most 8,192 update structures per incoming update                                                                         |
| Message/byte buckets                 | 100 frames/sec, burst 200; 512 KiB/sec, burst 1 MiB, per socket                                                                               |
| Save-check/session-ready messages    | 5/sec, burst 10, per socket                                                                                                                   |
| Upgrades and authentication attempts | Separate per-IP buckets, each 120/minute with initial burst 120                                                                               |
| API requests and document creation   | Per-IP API bucket 300/minute; nested creation bucket 30/minute                                                                                |
| Admission identity table             | 10,000 entries; idle entries expire after two minutes; new identities fail closed if full                                                     |
| HTTP                                 | 16 KiB JSON, no decompression, 64 API requests in flight; HTTP server TCP ceiling 1,024, header timeout 5 seconds, request timeout 10 seconds |
| Async frame processing               | 15-second deadline; a stalled socket is closed                                                                                                |

Token buckets refill continuously; the per-minute value is also their initial burst capacity. Limits are local to each process. Four independent instances can therefore admit up to four times a per-instance allowance; moving to another instance can obtain a fresh bucket. They do not depend on Redis and continue to bound work during a Redis failure. Use an edge/global limiter if the deployment needs a shared quota or stronger volumetric protection. Shared NAT clients consume the same source-IP allowance; IPv6 privacy addresses in the same /64 share a bucket.

Environment controls are listed in `.env.example`: `MAX_CONNECTIONS`, `MAX_CONNECTIONS_PER_IP`, `MAX_OPEN_DOCUMENTS`, `MAX_DOCUMENT_CLIENTS`, and `MAX_DOCUMENT_BYTES`. Other ceilings are versioned in `apps/server/src/policy.ts`; changing them requires review, load characterization, and the regression suite. Existing documents/volumes are not rewritten or purged by these changes.

On policy close 1008 or oversized-message close 1009, the browser pauses automatic retries, shows **Connection paused**, and leaves the local editor/IndexedDB copy available for text export. It does not show database confirmation while disconnected. A network-online event does not silently resume a permanently rejected session; export first, resolve the limit, then reopen/reload. A large offline backlog can exceed a single-message ceiling even if the total document ceiling is higher. Temporary authentication/setup dependency failures and exhausted instantaneous capacity close with retryable 1013 rather than claiming a capability is invalid. Idle unauthenticated sockets, malformed traffic, and exhausted abuse buckets remain policy rejections. Ordinary transport failures retain the provider's reconnect behavior.

## Proxy and production settings

The checked-in Compose files are localhost development/verification configurations with local credentials. They are not a public production deployment. For a real deployment:

- Serve the browser and API through HTTPS/WSS; allowlist the exact public HTTP(S) origin. Set browser API/WebSocket build arguments to the public endpoints, and rebuild the browser and backend together.
- Restrict backend ports to a private network reachable only by the intended edge/peers. Use separate strong PostgreSQL, Redis, and operator credentials, and dependency TLS where the network requires it. Keep secrets out of Git, `NEXT_PUBLIC_*`, URLs, traces, and access logs.
- Set `TRUSTED_PROXY_CIDRS` only to the actual immediate edge IP/CIDR. With no setting, forwarded headers are ignored. A trusted single-hop edge must **overwrite** `X-Forwarded-For` with one validated client address; lists/invalid addresses are rejected. Do not trust a broad network containing untrusted clients. HTTP and WebSocket admission use the same resolver; the header does not grant document access.
- The example nginx config overwrites forwarding headers, caps request bodies, and blocks operator routes. Configure TLS, access-log redaction, edge limits, and upstream readiness checks in the actual ingress. Strip query credentials at the edge and avoid logging Authorization headers or frames.
- Give each environment a separate PostgreSQL database and Redis prefix. A Redis prefix isolates Pub/Sub, not database tenancy. Configure the same capability/schema/version policy on all collaborating instances.

The web adds no-referrer, nosniff, frame denial, restricted object/base/form behavior, and disabled camera/microphone/geolocation permissions. The CSP restricts those listed behaviors; it is not a full nonce-based script policy. This sprint does not add user identities, a security certification, a penetration-test guarantee, dependency high availability, or a throughput SLA.

## Security verification and maintenance

`tests/integration/security.test.ts` exercises hostile frames, size/byte/message/queue limits, concurrent near-limit updates, upgrade/authentication buckets, in-flight authentication timeout cleanup, per-IP/socket/document caps, trusted/untrusted proxy behavior, compressed HTTP rejection, telemetry redaction, and real dependency failures. Unit tests cover protocol/cursor shapes, bounded token buckets, configuration, redaction/cardinality, and paused retry behavior. Browser tests verify wrong-capability denial and export after a real oversized-message close. Packaged tests validate the delivered images and gateway.

The lockfile includes `body-parser` 2.4.0, addressing [GHSA-27r3-jxmh-p828](https://github.com/advisories/GHSA-27r3-jxmh-p828); request decompression is also disabled. CI runs the production dependency audit and fails for high/critical advisories. An audit result is a dated registry check, not proof that every dependency is vulnerability-free. Re-run it when building/deploying updates.

References: [OWASP WebSocket guidance](https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html), [Prometheus client](https://github.com/prometheus/client_js), and the [operations runbook](operations.md).
