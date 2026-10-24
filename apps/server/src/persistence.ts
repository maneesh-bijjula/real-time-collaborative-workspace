import { setTimeout as delay } from 'node:timers/promises';
import { Database } from '@hocuspocus/extension-database';
import { Redis } from '@hocuspocus/extension-redis';
import {
  isTransactionOrigin,
  type onChangePayload,
  type onStatelessPayload,
  type onStoreDocumentPayload,
} from '@hocuspocus/server';
import * as Y from 'yjs';
import type { DocumentStore } from './documents.js';

// PostgreSQL's row lock and CRDT merge own persistence coordination. Redis's
// best-effort store lock can skip a unique snapshot on another instance.
export class SynchronizationRedis extends Redis {
  override async onStoreDocument(): Promise<void> {}
  override async afterStoreDocument(): Promise<void> {}
}

export class DurableDatabase extends Database {
  private readonly stopping = new AbortController();
  private readonly failures = new Set<string>();
  abandonedSaves = false;

  constructor(private readonly store: DocumentStore) {
    super({ fetch: ({ documentName }) => store.load(documentName) });
  }

  // Hocuspocus normally skips stores for Redis-origin updates. Persist them too,
  // so a surviving instance does not rely on the originating process staying up.
  async onChange(data: onChangePayload): Promise<void> {
    if (isTransactionOrigin(data.transactionOrigin) && data.transactionOrigin.source === 'redis') {
      await data.instance.storeDocumentHooks(data.document, {
        instance: data.instance,
        document: data.document,
        documentName: data.documentName,
        clientsCount: data.clientsCount,
        lastContext: data.context,
        lastTransactionOrigin: data.transactionOrigin,
      });
    }
  }

  override async onStoreDocument({ documentName, document }: onStoreDocumentPayload) {
    let backoff = 250;
    // Hocuspocus holds document.saveMutex across this entire hook. An unsaved
    // document therefore stays loaded even if its last client disconnects.
    while (!this.stopping.signal.aborted) {
      const state = Y.encodeStateAsUpdate(document);
      try {
        await this.store.store(documentName, state);
        this.failures.delete(documentName);
        return;
      } catch {
        if (!this.failures.has(documentName))
          console.error('Document persistence failed; retrying pending saves');
        this.failures.add(documentName);
        try {
          await delay(Math.min(5000, backoff * (0.8 + Math.random() * 0.4)), undefined, {
            signal: this.stopping.signal,
          });
        } catch {
          // Shutdown interrupts the retry delay, not a successful commit.
        }
        backoff = Math.min(5000, backoff * 2);
      }
    }
    // Only a failed shutdown may abandon a pending save. Let Hocuspocus unload
    // and release its resources, then make application.close() reject.
    this.abandonedSaves = true;
  }

  async onStateless({ payload, documentName, connection }: onStatelessPayload): Promise<void> {
    if (payload.length > 256) return;
    let request: { type?: unknown; requestId?: unknown };
    try {
      request = JSON.parse(payload);
      if (
        !request ||
        request.type !== 'persistence:check:v1' ||
        typeof request.requestId !== 'string' ||
        !/^[a-f\d-]{36}$/i.test(request.requestId)
      )
        return;
    } catch {
      return;
    }
    const response = {
      type: 'persistence:status:v1',
      requestId: request.requestId,
      status: this.failures.has(documentName) ? 'retrying' : 'available',
      snapshot: undefined as string | undefined,
    };
    const committed = new Y.Doc();
    try {
      // Read the committed database state, never the live mutable document or
      // an afterStoreDocument timestamp. Snapshots include the deletion set.
      const state = await this.store.load(documentName);
      if (state) Y.applyUpdate(committed, state);
      response.snapshot = Buffer.from(Y.encodeSnapshot(Y.snapshot(committed))).toString('base64');
    } catch {
      response.status = 'retrying';
    } finally {
      committed.destroy();
    }
    connection.sendStateless(JSON.stringify(response));
  }

  stop(): void {
    this.stopping.abort();
  }
}
