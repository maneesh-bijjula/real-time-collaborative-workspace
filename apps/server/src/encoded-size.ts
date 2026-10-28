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

export class DocumentSizer {
  private readonly encoder = new SizeEncoder();
  size(document: Y.Doc): number {
    // Yjs merges pending V2 histories after its main traversal. Use the stock
    // encoder there so gap/delete-only edge cases retain identical semantics.
    if (document.store.pendingStructs || document.store.pendingDs)
      return Y.encodeStateAsUpdate(document).length;
    this.encoder.reset();
    Y.encodeStateAsUpdateV2(document, undefined, this.encoder);
    return this.encoder.size;
  }
}
