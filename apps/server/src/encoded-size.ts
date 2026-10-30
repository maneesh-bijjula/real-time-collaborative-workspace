import * as Y from 'yjs';
import { length } from 'lib0/encoding';

const empty = new Uint8Array();
function uintBytes(value: number): number {
  let size = 1;
  while (value > 127) {
    value = Math.floor(value / 128);
    size++;
  }
  return size;
}

/** Runs Yjs's ordinary V1 traversal, counting fields instead of allocating the
 * output. Complex Any values and direct header writes still use lib0 itself.
 * This is an exact encoded-size check, not a growth estimate or relaxed cap.
 */
class SizeEncoder extends Y.UpdateEncoderV1 {
  private fields = 0;
  reset() {
    this.fields = 0;
    this.restEncoder.cpos = 0;
    this.restEncoder.bufs.length = 0;
  }
  get size() {
    return this.fields + length(this.restEncoder);
  }
  override toUint8Array() {
    return empty;
  } // Count only; never exposed as an update.
  override writeLeftID(id: Y.ID) {
    this.fields += uintBytes(id.client) + uintBytes(id.clock);
  }
  override writeRightID(id: Y.ID) {
    this.writeLeftID(id);
  }
  override writeClient(value: number) {
    this.fields += uintBytes(value);
  }
  override writeInfo(_value: number) {
    this.fields++;
  }
  override writeString(value: string) {
    const bytes = Buffer.byteLength(value, 'utf8');
    this.fields += uintBytes(bytes) + bytes;
  }
  override writeParentInfo(_value: boolean) {
    this.fields++;
  }
  override writeTypeRef(value: number) {
    this.fields += uintBytes(value);
  }
  override writeLen(value: number) {
    this.fields += uintBytes(value);
  }
  override writeBuf(value: Uint8Array) {
    this.fields += uintBytes(value.length) + value.length;
  }
  override writeJSON(value: unknown) {
    this.writeString(JSON.stringify(value));
  }
  override writeKey(value: string) {
    this.writeString(value);
  }
  override writeDsClock(value: number) {
    this.fields += uintBytes(value);
  }
  override writeDsLen(value: number) {
    this.fields += uintBytes(value);
  }
}

type Part = { structures: number; deletions: number; hasDeletions: boolean };
type SizeCache = { parts: Map<number, Part>; dirty: Set<number> };

export class DocumentSizer {
  private readonly encoder = new SizeEncoder();
  private readonly caches = new WeakMap<Y.Doc, SizeCache>();

  private cache(document: Y.Doc): SizeCache {
    let cache = this.caches.get(document);
    if (cache) return cache;
    cache = { parts: new Map(), dirty: new Set(document.store.clients.keys()) };
    const created = cache;
    // V1 client blocks have no shared compression state. Recount only clients
    // touched by completed transactions. Splits can change another client's
    // encoding without advancing its clock or deleting anything: the pinned
    // Yjs transaction's merge list is therefore part of invalidation too.
    const changed = (transaction: Y.Transaction) => {
      for (const [client, clock] of transaction.afterState)
        if (clock !== (transaction.beforeState.get(client) ?? 0)) created.dirty.add(client);
      for (const client of transaction.deleteSet.clients.keys()) created.dirty.add(client);
      for (const struct of transaction._mergeStructs) created.dirty.add(struct.id.client);
    };
    const destroyed = () => {
      document.off('afterTransactionCleanup', changed);
      document.off('destroy', destroyed);
      this.caches.delete(document);
      created.parts.clear();
      created.dirty.clear();
    };
    // Invalidate before afterAllTransactions observers, even ones registered
    // before this cache. Calls within cleanup use the stock fallback below.
    document.on('afterTransactionCleanup', changed);
    document.on('destroy', destroyed);
    this.caches.set(document, cache);
    return cache;
  }

  size(document: Y.Doc): number {
    const cache = this.cache(document);
    // Pending V2 histories have special merge semantics. A call inside a live
    // transaction may precede invalidation/GC/merging. Use the stock encoder
    // and force a fresh recount after either case has settled.
    if (
      document.store.pendingStructs ||
      document.store.pendingDs ||
      document._transaction ||
      document._transactionCleanups.length
    ) {
      cache.parts.clear();
      for (const client of document.store.clients.keys()) cache.dirty.add(client);
      return Y.encodeStateAsUpdate(document).length;
    }
    // Client removal is not an ordinary Yjs transaction, but never retain a
    // contribution for an entry that no longer exists.
    for (const client of cache.parts.keys())
      if (!document.store.clients.has(client)) cache.parts.delete(client);

    for (const [client, structs] of document.store.clients) {
      if (!cache.dirty.has(client) && cache.parts.has(client)) continue;
      this.encoder.reset();
      // Match writeClientsStructs/writeStructs in the locked Yjs V1 encoder:
      // struct count, client ID, first clock, then the actual struct writers.
      let structures =
        uintBytes(structs.length) + uintBytes(client) + uintBytes(structs[0]!.id.clock);
      let ranges = 0;
      let deletions = 0;
      for (let i = 0; i < structs.length; i++) {
        const struct = structs[i]!;
        struct.write(this.encoder, 0);
        if (struct.deleted && (i === 0 || !structs[i - 1]!.deleted)) {
          ranges++;
          let deletedLength = struct.length;
          for (let next = i + 1; next < structs.length && structs[next]!.deleted; next++)
            deletedLength += structs[next]!.length;
          deletions += uintBytes(struct.id.clock) + uintBytes(deletedLength);
        }
      }
      structures += this.encoder.size;
      cache.parts.set(client, {
        structures,
        deletions: ranges ? uintBytes(client) + uintBytes(ranges) + deletions : 0,
        hasDeletions: ranges > 0,
      });
    }
    cache.dirty.clear();
    let structures = uintBytes(document.store.clients.size),
      deletions = 0,
      deletionClients = 0;
    for (const part of cache.parts.values()) {
      structures += part.structures;
      deletions += part.deletions;
      if (part.hasDeletions) deletionClients++;
    }
    return structures + uintBytes(deletionClients) + deletions;
  }
}
