# Persistence contract

Commonplace distinguishes collaboration acknowledgements, committed database content, and browser-local storage. Each status describes a separate operation.

## Database confirmation

After collaboration synchronization, the browser sends an authenticated Hocuspocus stateless request:

```json
{ "type": "persistence:check:v1", "requestId": "random-request-uuid" }
```

The request is scoped to the already-authorized WebSocket document. It does not supply another document ID. The server reads that document's committed PostgreSQL state and responds directly to the requesting connection:

```json
{
  "type": "persistence:status:v1",
  "requestId": "random-request-uuid",
  "status": "available",
  "snapshot": "base64-encoded-Yjs-snapshot"
}
```

`available` means the database read succeeded; it does not by itself mean the editor is saved. `retrying` indicates a pending failed store or a failed database read. A read failure omits `snapshot`. The client compares the returned snapshot with `Y.snapshot(currentDocument)` using `Y.equalSnapshots`, including both state vectors and deletion sets. State vectors alone cannot confirm deletion-only changes.

Only a matching response for the current request, with matching document state and an authenticated, synchronized, connected provider with no unacknowledged updates, can produce **Saved to database**. Every document update, including remote updates, invalidates the request and the saved indication synchronously. Connection changes also invalidate confirmation. An old response cannot acknowledge a new editor revision or reconnect session. The server's snapshot comes from committed bytes, not the mutable in-memory document or an `afterStoreDocument` timestamp.

Checks run every 500 ms while confirmation is pending and the provider is ready. A request times out after five seconds and is retried. Checks stop once the current state is confirmed; later document or connection changes restart them. These checks do not force snapshot writes. Save-confirmation latency and collaboration-propagation latency are separate measurements.

## Snapshot writes and retries

The existing PostgreSQL schema and binary Yjs state are retained. No data migration is required.

1. Hocuspocus debounces stores for 300 ms, with a one-second maximum debounce.
2. Each write attempt captures immutable encoded document state before awaiting SQL.
3. A transaction sets `synchronous_commit=on`, locks the document row, merges its stored CRDT history with the incoming state, and commits.
4. If the attempt fails, it retries without requiring another edit. Retry delay starts at approximately 250 ms, doubles with 20% jitter, and is capped at five seconds. Each retry captures the latest live document state.
5. Hocuspocus holds its document save mutex across retries. Pending saves therefore retain the document when all clients disconnect. Updates arriving during a successful write schedule a subsequent store through the existing debounce/mutex machinery.

Redis's extension-level persistence lock is disabled: a best-effort lock may skip a distinct snapshot on a competing instance, whereas the existing PostgreSQL row lock and CRDT merge already serialize safe persistence. Redis still handles document/presence synchronization. Redis-origin updates are explicitly scheduled for storage so a surviving receiver can persist them independently of the originator.

An ambiguous commit outcome is treated as a failed attempt and retried. Merging the same Yjs history again is idempotent. A database read can confirm data committed by another instance. Save confirmation is conservative: if PostgreSQL has a different snapshot, the client continues waiting until its current document is covered by an equal committed snapshot.

## Shutdown and failure limits

On SIGINT/SIGTERM the application stops accepting connections and asks Hocuspocus to close sessions and flush pending stores. Writes continue retrying during the 12-second shutdown window. If that window expires, the retry loop stops, pending documents can unload, and application close rejects if a save was abandoned. The production entry point exits with status 1 on failure and also has a 15-second hard process deadline for a stalled shutdown. Repeated close calls share the same outcome.

**Saved to database** covers loss of an application process after confirmation, with PostgreSQL and durable storage intact. Tests kill a separate server process with SIGKILL, discard all participating client documents, restart the server, and verify the insertion/deletion through a fresh client. This guarantee assumes normal PostgreSQL durability configuration and functioning durable storage. It does not cover destruction of database storage, unsafe database settings such as `fsync=off`, or a broken storage device.

Unconfirmed edits can still be lost when every in-memory/local copy disappears before a database commit. During a long outage, retries keep pending state in server memory and clients may retain IndexedDB copies; there is no separate durable server update journal. Memory capacity, outage duration, full Redis partition reconciliation, backup restoration, and 50-editor performance require the later planned sprints. Retry scheduling does not itself provide high availability or a recovery-time guarantee.

Deploy browser/backend protocol changes together. An older backend leaves the new UI unconfirmed rather than falsely saved; an older browser does not display the new database-save status.
