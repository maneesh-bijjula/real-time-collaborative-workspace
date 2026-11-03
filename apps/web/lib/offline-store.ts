import * as Y from 'yjs';
import { PREFERRED_TRIM_SIZE } from 'y-indexeddb';

export type OfflineCopyState = 'loading' | 'available' | 'unavailable';

/** Own transaction errors explicitly; y-indexeddb's whenSynced never rejects.
 * Retain its database name, updates/custom stores and binary update format so
 * existing offline edits survive. Never clear browser storage on a failure.
 */
export class OfflineStore {
  private db?: IDBDatabase;
  private stopped = false;
  private writes = 0;
  private listening = false;

  constructor(
    name: string,
    private readonly document: Y.Doc,
    private readonly onState: (state: OfflineCopyState) => void,
  ) {
    try {
      const request = window.indexedDB.open(name);
      request.onupgradeneeded = () => {
        try {
          const db = request.result;
          if (!db.objectStoreNames.contains('updates'))
            db.createObjectStore('updates', { autoIncrement: true });
          if (!db.objectStoreNames.contains('custom')) db.createObjectStore('custom');
        } catch {
          request.transaction?.abort();
          this.fail();
        }
      };
      request.onerror = () => this.fail();
      request.onblocked = () => this.fail();
      request.onsuccess = () => {
        const db = request.result;
        if (this.stopped) return db.close();
        this.db = db;
        db.onversionchange = () => this.fail();
        db.onclose = () => this.fail();
        this.checkpoint(true);
      };
    } catch {
      this.fail();
    }
  }

  private transaction() {
    const transaction = this.db!.transaction('updates', 'readwrite');
    transaction.onabort = () => this.fail();
    // Request errors bubble here; let IndexedDB abort atomically. No rejected
    // promises or user data escape into React's event loop or telemetry.
    transaction.onerror = () => this.fail();
    return transaction;
  }

  private checkpoint(initial = false) {
    if (this.stopped) return;
    let transaction: IDBTransaction | undefined;
    try {
      transaction = this.transaction();
      const store = transaction.objectStore('updates');
      const request = store.getAll();
      request.onsuccess = () => {
        if (this.stopped) return;
        try {
          // The read/write lock serializes this merge with every other tab.
          // Compact only after incorporating every stored update, and clear/add
          // in the SAME transaction so quota/abort preserves the prior copy.
          Y.transact(
            this.document,
            () => {
              for (const update of request.result) Y.applyUpdate(this.document, update, this);
            },
            this,
          );
          store.clear();
          store.add(Y.encodeStateAsUpdate(this.document));
          if (!this.listening) {
            this.document.on('update', this.update);
            this.listening = true;
          }
        } catch {
          transaction!.abort();
          this.fail();
        }
      };
      transaction.oncomplete = () => {
        if (!this.stopped && initial) this.onState('available');
      };
      this.writes = 0;
    } catch {
      try {
        transaction?.abort();
      } catch {
        /* Already completed. */
      }
      this.fail();
    }
  }

  private update = (update: Uint8Array, origin: unknown) => {
    if (origin === this || this.stopped) return;
    try {
      const transaction = this.transaction();
      transaction.objectStore('updates').add(update);
      if (++this.writes >= PREFERRED_TRIM_SIZE) this.checkpoint();
    } catch {
      this.fail();
    }
  };

  private fail() {
    if (this.stopped) return;
    this.destroy();
    this.onState('unavailable');
  }

  destroy() {
    this.stopped = true;
    if (this.listening) this.document.off('update', this.update);
    this.db?.close();
  }
}
