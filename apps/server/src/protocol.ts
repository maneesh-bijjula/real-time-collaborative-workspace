import {
  createDecoder,
  readVarString,
  readVarUint,
  readVarUint8Array,
  hasContent,
} from 'lib0/decoding';
import * as Y from 'yjs';
import type { ResourcePolicy } from './policy.js';

export class PolicyError extends Error {
  constructor(readonly reason: string) {
    super('Collaboration policy rejected the message');
  }
}
export type Frame = {
  document: string;
  type: number;
  syncType?: number;
  payload?: Uint8Array;
  token?: string;
};
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
export function decodeFrame(data: Uint8Array, policy: ResourcePolicy): Frame {
  try {
    const decoder = createDecoder(data);
    const document = readVarString(decoder);
    if (!uuid.test(document)) throw new PolicyError('document_address');
    const type = readVarUint(decoder);
    const result: Frame = { document, type };
    if (type === 0 || type === 4) {
      result.syncType = readVarUint(decoder);
      result.payload = readVarUint8Array(decoder);
      if (result.syncType === 0) Y.decodeStateVector(result.payload);
      else if (result.syncType === 1 || result.syncType === 2) {
        const decoded = Y.decodeUpdate(result.payload);
        if (decoded.structs.length > policy.maxUpdateStructs)
          throw new PolicyError('update_structures');
      } else throw new PolicyError('protocol');
    } else if (type === 1) {
      result.payload = readVarUint8Array(decoder);
      validateAwareness(result.payload);
    } else if (type === 2) {
      if (readVarUint(decoder) !== 0) throw new PolicyError('protocol');
      result.token = readVarString(decoder);
      if (result.token.length > 128) throw new PolicyError('credential_size');
      if (hasContent(decoder) && !/^[\w.+-]{1,32}$/.test(readVarString(decoder)))
        throw new PolicyError('protocol');
    } else if (type === 5) {
      const payload = readVarString(decoder);
      if (payload.length > 256) throw new PolicyError('stateless');
      const value = JSON.parse(payload);
      if (value?.type === 'persistence:check:v1') {
        if (
          typeof value.requestId !== 'string' ||
          !/^[a-f\d-]{36}$/i.test(value.requestId) ||
          Object.keys(value).length !== 2
        )
          throw new PolicyError('stateless');
      } else if (value?.type === 'session:ready:v1') {
        if (typeof value.reconnected !== 'boolean' || Object.keys(value).length !== 2)
          throw new PolicyError('stateless');
      } else throw new PolicyError('stateless');
    } else if (type !== 3 && type !== 7) {
      // BroadcastStateless, SyncStatus and unknown/server-only opcodes cannot
      // be submitted by clients, even with a valid capability.
      throw new PolicyError('protocol');
    }
    if (hasContent(decoder)) throw new PolicyError('protocol');
    return result;
  } catch (error) {
    if (error instanceof PolicyError) throw error;
    throw new PolicyError('malformed');
  }
}
function relativePosition(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const position = value as Record<string, unknown>;
  if (Object.keys(position).some((key) => !['type', 'tname', 'item', 'assoc'].includes(key)))
    return false;
  const id = (value: unknown) => {
    if (value === null || value === undefined) return true;
    if (typeof value !== 'object' || Array.isArray(value)) return false;
    const item = value as Record<string, unknown>;
    return (
      Object.keys(item).length === 2 &&
      ['client', 'clock'].every(
        (key) =>
          Number.isSafeInteger(item[key]) &&
          Number(item[key]) >= 0 &&
          Number(item[key]) <= 0xffffffff,
      )
    );
  };
  return (
    id(position.type) &&
    id(position.item) &&
    (position.tname === null ||
      position.tname === undefined ||
      (typeof position.tname === 'string' &&
        position.tname.length <= 128 &&
        !/[\u0000-\u001f]/u.test(position.tname))) &&
    (position.assoc === undefined ||
      (Number.isSafeInteger(position.assoc) && Math.abs(Number(position.assoc)) <= 1))
  );
}
function validateAwareness(bytes: Uint8Array) {
  const decoder = createDecoder(bytes);
  const count = readVarUint(decoder);
  if (count > 128 || bytes.length > 64 * 1024) throw new PolicyError('awareness_size');
  for (let i = 0; i < count; i++) {
    if (readVarUint(decoder) > 0xffffffff || !Number.isSafeInteger(readVarUint(decoder)))
      throw new PolicyError('awareness');
    const raw = readVarString(decoder);
    if (raw.length > 2048) throw new PolicyError('awareness_size');
    const state = JSON.parse(raw);
    if (state === null) continue;
    if (
      typeof state !== 'object' ||
      Array.isArray(state) ||
      Object.keys(state).some((key) => !['user', 'cursor'].includes(key))
    )
      throw new PolicyError('awareness');
    if (
      state.user !== undefined &&
      (!state.user ||
        typeof state.user.name !== 'string' ||
        state.user.name.length > 64 ||
        /[\u0000-\u001f]/u.test(state.user.name) ||
        typeof state.user.color !== 'string' ||
        !/^#[\da-f]{6}$/i.test(state.user.color) ||
        Object.keys(state.user).some((key) => !['name', 'color'].includes(key)))
    )
      throw new PolicyError('awareness');
    if (
      state.cursor !== undefined &&
      state.cursor !== null &&
      (typeof state.cursor !== 'object' ||
        Array.isArray(state.cursor) ||
        Object.keys(state.cursor).some((key) => !['anchor', 'head'].includes(key)) ||
        !relativePosition(state.cursor.anchor) ||
        !relativePosition(state.cursor.head))
    )
      throw new PolicyError('awareness');
  }
  if (hasContent(decoder)) throw new PolicyError('malformed');
}
export function validateDocumentUpdate(document: Y.Doc, frame: Frame, policy: ResourcePolicy) {
  if (!frame.payload || frame.syncType === 0 || (frame.type !== 0 && frame.type !== 4)) return;
  // Stage untrusted updates in a disposable CRDT before touching the live
  // document. Rejected/decode-failing updates cannot partially mutate peers.
  const probe = new Y.Doc();
  try {
    Y.applyUpdate(probe, Y.encodeStateAsUpdate(document));
    Y.applyUpdate(probe, frame.payload);
    if (Y.encodeStateAsUpdate(probe).length > policy.maxDocumentBytes)
      throw new PolicyError('document_size');
  } catch (error) {
    if (error instanceof PolicyError) throw error;
    throw new PolicyError('malformed_update');
  } finally {
    probe.destroy();
  }
}
