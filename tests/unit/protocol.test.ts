import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import { decodeFrame, validateDocumentUpdate } from '../../apps/server/src/protocol.js';
import { policySchema } from '../../apps/server/src/policy.js';
import { frame, sync, auth } from '../helpers/wire';
const id = '16d3f83f-b3eb-42a4-9f81-66d93dced721',
  policy = policySchema.parse({});

describe('untrusted binary protocol', () => {
  it.each([
    new Uint8Array([255]),
    frame(id, 6, (e) => encoding.writeVarString(e, 'private')),
    frame('__proto__', 3),
    frame(id + '\0session', 3),
    frame(id, 999),
    sync(id, 2, new Uint8Array([255])),
  ])('rejects malformed, multiplexed and server-only frames', (bytes) => {
    expect(() => decodeFrame(bytes, policy)).toThrow();
  });
  function awareness(state: unknown) {
    const encoded = encoding.createEncoder();
    encoding.writeVarUint(encoded, 1);
    encoding.writeVarUint(encoded, 42);
    encoding.writeVarUint(encoded, 1);
    encoding.writeVarString(encoded, JSON.stringify(state));
    return frame(id, 1, (e) => encoding.writeVarUint8Array(e, encoding.toUint8Array(encoded)));
  }
  it.each([
    { cursor: { anchor: 'invalid', head: {} } },
    { cursor: { anchor: {}, head: { item: { client: -1, clock: 1 } } } },
    { user: { name: 'unsafe', color: 'url(javascript:alert(1))' } },
    { user: { name: 'x'.repeat(2049), color: '#7856b6' } },
  ])('rejects awareness that could break peer cursor rendering', (value) => {
    expect(() => decodeFrame(awareness(value), policy)).toThrow();
  });
  it('accepts the editor relative-position schema including nullable fields', () => {
    const doc = new Y.Doc();
    const position = Y.createRelativePositionFromTypeIndex(doc.getXmlFragment('default'), 0);
    expect(
      decodeFrame(
        awareness({
          user: { name: 'Editor', color: '#7856b6' },
          cursor: { anchor: position, head: position },
        }),
        policy,
      ).type,
    ).toBe(1);
    doc.destroy();
  });
  it('rejects trailing bytes and oversized credentials', () => {
    expect(() => decodeFrame(Uint8Array.from([...frame(id, 3), 0]), policy)).toThrow();
    expect(() => decodeFrame(auth(id, 'x'.repeat(129)), policy)).toThrow();
  });
  it('stages updates so rejecting a document limit never changes live state', () => {
    const original = new Y.Doc(),
      incoming = new Y.Doc();
    original.getText('body').insert(0, 'baseline');
    Y.applyUpdate(incoming, Y.encodeStateAsUpdate(original));
    incoming.getText('body').insert(0, 'x'.repeat(1024));
    const before = Y.snapshot(original);
    const decoded = decodeFrame(sync(id, 2, Y.encodeStateAsUpdate(incoming)), policy);
    expect(() =>
      validateDocumentUpdate(original, decoded, { ...policy, maxDocumentBytes: 100 }),
    ).toThrow();
    expect(Y.equalSnapshots(before, Y.snapshot(original))).toBe(true);
    original.destroy();
    incoming.destroy();
  });
  it('limits structural expansion independently of frame size', () => {
    const doc = new Y.Doc();
    for (let i = 0; i < 4; i++) doc.getMap('m').set('key' + i, i);
    expect(() =>
      decodeFrame(sync(id, 2, Y.encodeStateAsUpdate(doc)), { ...policy, maxUpdateStructs: 2 }),
    ).toThrow();
    doc.destroy();
  });
});
