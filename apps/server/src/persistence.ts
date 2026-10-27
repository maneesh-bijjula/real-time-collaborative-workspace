import { performance } from 'node:perf_hooks';
import type { SessionContext } from './transport.js';
import type { Telemetry } from './telemetry.js';
import { setTimeout as delay } from 'node:timers/promises';
import { Database } from '@hocuspocus/extension-database';
import {
  isTransactionOrigin,
  type onChangePayload,
  type onStatelessPayload,
  type onStoreDocumentPayload,
} from '@hocuspocus/server';
import * as Y from 'yjs';
import type { DocumentStore } from './documents.js';

export class DurableDatabase extends Database {
  private readonly stopping = new AbortController();
  private readonly failures = new Set<string>();
  private readonly checks = new Map<string, Promise<string>>();
  abandonedSaves = false;
  private readonly dirty = new Map<
    string,
    { since: number; version: number; inFlight: boolean; nextSince?: number }
  >();
  get pendingCount() {
    return this.dirty.size;
  }
  get failureCount() {
    return this.failures.size;
  }
  get oldestDirtySeconds() {
    return this.dirty.size
      ? Math.max(
          0,
          (performance.now() - Math.min(...[...this.dirty.values()].map((item) => item.since))) /
            1000,
        )
      : 0;
  }
  private refreshMetrics() {
    this.telemetry?.gauge('dirty_documents', this.pendingCount);
    this.telemetry?.gauge('persistence_failures', this.failureCount);
    this.telemetry?.gauge('oldest_dirty_seconds', this.oldestDirtySeconds);
  }
  sampleMetrics() {
    this.refreshMetrics();
  }

  constructor(
    private readonly store: DocumentStore,
    private readonly telemetry?: Telemetry,
  ) {
    super({
      fetch: async ({ documentName, context }) => {
        try {
          return await store.load(documentName);
        } catch {
          telemetry?.log('dependency_failed', 'postgres');
          (context as SessionContext | undefined)?.session?.socket.close(
            1013,
            'Service temporarily unavailable',
          );
          throw { reason: 'Service unavailable' };
        }
      },
    });
  }

  // Hocuspocus normally skips stores for Redis-origin updates. Persist them too,
  // so a surviving instance does not rely on the originating process staying up.
  async onChange(data: onChangePayload): Promise<void> {
    let item = this.dirty.get(data.documentName);
    if (!item) {
      item = { since: performance.now(), version: 0, inFlight: false };
      this.dirty.set(data.documentName, item);
    }
    item.version++;
    if (item.inFlight && item.nextSince === undefined) item.nextSince = performance.now();
    this.refreshMetrics();
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
      const item = this.dirty.get(documentName);
      const version = item?.version;
      if (item) {
        item.inFlight = true;
        item.nextSince = undefined;
      }
      const started = performance.now();
      try {
        await this.store.store(documentName, state);
        this.telemetry?.count('persistence_attempts_total', { result: 'success' });
        if (this.failures.delete(documentName)) this.telemetry?.log('persistence_recovered');
        if (item && item.version === version) {
          this.telemetry?.observe('durable_save_seconds', (performance.now() - item.since) / 1000);
          this.dirty.delete(documentName);
        } else if (item) {
          item.since = item.nextSince ?? item.since;
        }
        this.refreshMetrics();
        return;
      } catch {
        this.telemetry?.count('persistence_attempts_total', { result: 'failure' });
        if (!this.failures.has(documentName)) this.telemetry?.log('persistence_failed');
        this.failures.add(documentName);
        this.refreshMetrics();
        if (item) item.inFlight = false;
        this.telemetry?.observe('snapshot_write_seconds', (performance.now() - started) / 1000);
        try {
          await delay(Math.min(5000, backoff * (0.8 + Math.random() * 0.4)), undefined, {
            signal: this.stopping.signal,
          });
        } catch {
          // Shutdown interrupts the retry delay, not a successful commit.
        }
        backoff = Math.min(5000, backoff * 2);
      } finally {
        if (item) item.inFlight = false;
        if (!this.failures.has(documentName))
          this.telemetry?.observe('snapshot_write_seconds', (performance.now() - started) / 1000);
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
    try {
      // Read the committed database state, never the live mutable document or
      // an afterStoreDocument timestamp. Concurrent checks share only an
      // in-flight read/decode; no settled result is cached across checks.
      let checking = this.checks.get(documentName);
      if (!checking) {
        const pending = (async () => {
          const committed = new Y.Doc();
          try {
            const state = await this.store.load(documentName);
            if (state) Y.applyUpdate(committed, state);
            return Buffer.from(Y.encodeSnapshot(Y.snapshot(committed))).toString('base64');
          } finally {
            committed.destroy();
          }
        })().finally(() => {
          if (this.checks.get(documentName) === pending) this.checks.delete(documentName);
        });
        this.checks.set(documentName, pending);
        checking = pending;
      }
      response.snapshot = await checking;
    } catch {
      response.status = 'retrying';
    }
    connection.sendStateless(JSON.stringify(response));
  }

  stop(): void {
    this.stopping.abort();
  }
}
