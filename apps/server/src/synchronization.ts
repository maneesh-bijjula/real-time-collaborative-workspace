import { Redis, type Configuration } from '@hocuspocus/extension-redis';
import {
  OutgoingMessage,
  isTransactionOrigin,
  type onAwarenessUpdatePayload,
  type onChangePayload,
  type onConfigurePayload,
} from '@hocuspocus/server';
import * as Y from 'yjs';
import { performance } from 'node:perf_hooks';
import type { Telemetry } from './telemetry.js';
import type { DocumentStore } from './documents.js';

/** Repairs open documents after transient Pub/Sub loss without requiring edits. */
export class SynchronizationRedis extends Redis {
  private timer?: ReturnType<typeof setInterval>;
  private repair?: Promise<void>;
  private stopped = false;
  private failed = false;
  private deltaInFlight = 0;
  private deltaBytes = 0;
  completedRepairs = 0;
  get healthy() {
    return !this.failed;
  }

  constructor(
    configuration: Partial<Configuration>,
    private readonly store: DocumentStore,
    private readonly intervalMs = 2000,
    private readonly telemetry?: Telemetry,
  ) {
    super(configuration);
    this.pub.on('ready', this.requestRepair);
    this.sub.on('ready', this.requestRepair);
    this.pub.on('error', this.connectionError);
    this.sub.on('error', this.connectionError);

    // The pinned extension installs an async EventEmitter receiver whose
    // rejected Redis reply can otherwise become an unhandled rejection during
    // an outage. Preserve its protocol handler and contain transport failures.
    for (const receiver of this.sub.listeners('messageBuffer')) {
      this.sub.off('messageBuffer', receiver);
      this.sub.on('messageBuffer', (...args: unknown[]) => {
        void Promise.resolve()
          .then(() => receiver.apply(this.sub, args))
          .catch(this.connectionError);
      });
    }
  }

  override async onConfigure(data: onConfigurePayload) {
    await super.onConfigure(data);
    this.timer = setInterval(this.requestRepair, this.intervalMs).unref();
    this.requestRepair();
  }

  // PostgreSQL's row lock/CRDT merge coordinates stores. A best-effort Redis
  // persistence lock must not skip distinct snapshots on competing instances.
  override async onStoreDocument(): Promise<void> {}
  override async afterStoreDocument(): Promise<void> {}

  override async onChange({ documentName, update, transactionOrigin }: onChangePayload) {
    if (
      this.stopped ||
      (isTransactionOrigin(transactionOrigin) && transactionOrigin.source === 'redis')
    )
      return;
    // The upstream per-edit SyncStep1 makes every peer encode/reapply a full
    // deletion set. Push the actual delta instead; retain the existing load and
    // periodic handshakes for missed-message/partition recovery.
    if (
      this.pub.status !== 'ready' ||
      this.deltaInFlight >= 32 ||
      this.deltaBytes + update.length + 256 > 16 * 1024 * 1024
    ) {
      this.telemetry?.count('redis_delta_publications_total', { result: 'deferred' });
      this.connectionError();
      return; // Live/committed history remains available to reconciliation.
    }
    const identifier = Buffer.from(this.configuration.identifier);
    const message = new OutgoingMessage(documentName)
      .createSyncMessage()
      .writeUpdate(update)
      .toUint8Array();
    const payload = Buffer.concat([
      Buffer.from([identifier.length]),
      identifier,
      Buffer.from(message),
    ]);
    this.deltaInFlight++;
    this.deltaBytes += payload.length;
    this.samplePublications();
    // Do not await Redis in the onChange hook: dirty tracking and PostgreSQL
    // stores must continue even when Redis is stalled. Bound retained work and
    // fail closed to repair, rather than accumulating an offline publish queue.
    void Promise.resolve()
      .then(() => this.pub.publish(`${this.configuration.prefix}:${documentName}`, payload))
      .then(
        () => this.telemetry?.count('redis_delta_publications_total', { result: 'published' }),
        () => {
          this.telemetry?.count('redis_delta_publications_total', { result: 'failed' });
          this.connectionError();
        },
      )
      .finally(() => {
        this.deltaInFlight--;
        this.deltaBytes -= payload.length;
        this.samplePublications();
      });
  }

  private samplePublications() {
    this.telemetry?.gauge('redis_delta_inflight', this.deltaInFlight);
    this.telemetry?.gauge('redis_delta_bytes', this.deltaBytes);
  }

  override async onAwarenessUpdate(data: onAwarenessUpdatePayload) {
    const { document, connection, added, updated, removed } = data;
    if (connection) {
      const entry = document.connections.get(connection);
      // Reconnecting IDs may already exist via Redis. Claim only awareness
      // whose clock advanced, not every peer included in a query response.
      for (const clientId of added.concat(updated)) entry?.clients.add(clientId);
    }
    if (removed.length && document.connections.size === 0) {
      // The pinned extension drops awareness when the final local socket
      // leaves. Publish its removal before unload, using the extension's
      // identifier-prefixed wire envelope (covered by four-process tests).
      const identifier = Buffer.from(this.configuration.identifier);
      const message = new OutgoingMessage(data.documentName)
        .createAwarenessUpdateMessage(data.awareness, removed)
        .toUint8Array();
      try {
        await this.pub.publish(
          `${this.configuration.prefix}:${data.documentName}`,
          Buffer.concat([Buffer.from([identifier.length]), identifier, Buffer.from(message)]),
        );
      } catch {
        this.connectionError();
      }
      return;
    }
    await super.onAwarenessUpdate(data);
  }

  private connectionError = () => {
    if (!this.stopped && !this.failed) this.telemetry?.log('synchronization_failed');
    this.failed = true;
  };

  private requestRepair = () => {
    void this.reconcileNow();
  };

  reconcileNow(): Promise<void> {
    if (
      this.stopped ||
      !this.instance ||
      this.pub.status !== 'ready' ||
      this.sub.status !== 'ready'
    )
      return Promise.resolve();
    const started = performance.now();
    this.repair ??= this.reconcile()
      .catch(() => {
        this.telemetry?.count('reconciliation_total', { result: 'failure' });
        this.connectionError();
      })
      .finally(() => {
        this.telemetry?.observe('reconciliation_seconds', (performance.now() - started) / 1000);
        this.repair = undefined;
      });
    return this.repair;
  }

  private async reconcile(): Promise<void> {
    // ioredis emits ready before its automatic resubscriptions are confirmed.
    // Explicitly await the reply subscription before asking peers for state.
    await this.sub.subscribe(`${this.configuration.prefix}#reply:${this.configuration.identifier}`);
    for (const [documentName, document] of this.instance.documents) {
      if (this.stopped) return;
      if (document.isDestroyed || document.isLoading || document.getConnectionsCount() === 0)
        continue;
      // Reuse the extension's public load handshake: subscribe, exchange Yjs
      // state vectors bidirectionally, and request current peer awareness.
      await super.afterLoadDocument({
        documentName,
        document,
        instance: this.instance,
        context: {},
        requestHeaders: new Headers(),
        requestParameters: new URLSearchParams(),
        socketId: '',
        connectionConfig: { isAuthenticated: true, readOnly: false },
      });
      const state = await this.store.load(documentName);
      if (this.stopped) return;
      if (state && this.instance.documents.get(documentName) === document && !document.isDestroyed)
        Y.applyUpdate(document, state, this.redisTransactionOrigin);
    }
    if (this.failed) this.telemetry?.log('synchronization_recovered');
    this.failed = false;
    this.completedRepairs++;
    this.telemetry?.count('reconciliation_total', { result: 'success' });
    this.telemetry?.gauge('last_reconciliation_timestamp_seconds', Date.now() / 1000);
  }

  override async onDestroy() {
    this.stopped = true;
    clearInterval(this.timer);
    this.pub.off('ready', this.requestRepair);
    this.sub.off('ready', this.requestRepair);
    await this.repair;
    await super.onDestroy();
  }
}
