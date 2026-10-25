import { Redis, type Configuration } from '@hocuspocus/extension-redis';
import {
  OutgoingMessage,
  type onAwarenessUpdatePayload,
  type onConfigurePayload,
} from '@hocuspocus/server';
import * as Y from 'yjs';
import type { DocumentStore } from './documents.js';

/** Repairs open documents after transient Pub/Sub loss without requiring edits. */
export class SynchronizationRedis extends Redis {
  private timer?: ReturnType<typeof setInterval>;
  private repair?: Promise<void>;
  private stopped = false;
  private failed = false;
  completedRepairs = 0;

  constructor(
    configuration: Partial<Configuration>,
    private readonly store: DocumentStore,
    private readonly intervalMs = 2000,
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
    if (!this.stopped && !this.failed)
      console.error('Redis synchronization interrupted; reconciliation will retry');
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
    this.repair ??= this.reconcile()
      .catch(this.connectionError)
      .finally(() => {
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
    this.failed = false;
    this.completedRepairs++;
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
