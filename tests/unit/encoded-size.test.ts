import { expect, it } from 'vitest';
import * as Y from 'yjs';
import { DocumentSizer } from '../../apps/server/src/encoded-size.js';

it('matches the stock V1 encoding across rich text, Unicode, JSON, binary, deleted history and reused documents', () => {
  const sizer = new DocumentSizer(),
    doc = new Y.Doc(),
    other = new Y.Doc();
  const check = (value: Y.Doc) =>
    expect(sizer.size(value)).toBe(Y.encodeStateAsUpdate(value).length);
  check(doc);
  check(other);
  const paragraph = new Y.XmlElement('paragraph'),
    text = new Y.XmlText();
  doc.getXmlFragment('default').push([paragraph]);
  paragraph.push([text]);
  text.insert(0, '🙂漢字\ud800' + 'x'.repeat(200));
  text.format(0, 20, { bold: true, custom: { nested: ['a', 1, null] } });
  paragraph.setAttribute('long-key-' + 'x'.repeat(150), 'unicode漢🙂');
  doc.getText('embeds').insertEmbed(0, { image: '🙂', dimensions: [123, 456] });
  doc.getMap('values').set('bytes', new Uint8Array(4097).fill(123));
  doc
    .getMap('values')
    .set('any', { list: [undefined, false, NaN, Infinity, -1, 2 ** 40], nested: { text: '漢' } });
  check(doc);
  check(other);
  check(doc);
  for (let i = 0; i < 240; i++) {
    text.insert(text.length, ` ${i}🙂`);
    doc.getMap('values').set('sequence', i);
    if (i % 3 === 0) text.delete(0, 1);
    if (i % 5 === 0)
      text.format(Math.max(0, text.length - 8), Math.min(8, text.length), {
        bold: i % 10 ? true : null,
      });
    if (i % 7 === 0) {
      check(doc);
      check(other);
    }
  }
  Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
  check(other);
  check(doc);
  doc.getMap('values').delete('bytes');
  doc.getXmlFragment('default').delete(0, 1);
  check(doc);
  Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
  check(other);
  doc.destroy();
  other.destroy();
});

it('matches the stock encoder with pending causal structures and future deletions', () => {
  const sizer = new DocumentSizer(),
    source = new Y.Doc(),
    pending = new Y.Doc();
  const updates: Uint8Array[] = [];
  source.on('update', (update) => updates.push(update));
  source.getText('body').insert(0, 'initial');
  source.getText('body').insert(7, ' missing predecessor');
  source.getText('body').delete(0, 7);
  for (const update of [updates[2]!, updates[1]!, updates[0]!]) {
    Y.applyUpdate(pending, update);
    expect(sizer.size(pending)).toBe(Y.encodeStateAsUpdate(pending).length);
  }
  expect(pending.getText('body').toString()).toBe(source.getText('body').toString());
  source.destroy();
  pending.destroy();
});

it('matches variable-length clock/client and string boundaries', () => {
  const sizer = new DocumentSizer();
  for (const client of [0, 127, 128, 16383, 16384, 0xffffffff]) {
    const doc = new Y.Doc();
    doc.clientID = client;
    const text = doc.getText('a');
    text.insert(0, 'x'.repeat(16400));
    text.delete(1, 16384);
    doc.getText('🙂'.repeat(64)).insert(0, '漢'.repeat(128));
    expect(sizer.size(doc)).toBe(Y.encodeStateAsUpdate(doc).length);
    doc.destroy();
  }
});

it('recounts a foreign client split even when its state vector and deletion set do not change', () => {
  const sizer = new DocumentSizer(),
    author = new Y.Doc(),
    peer = new Y.Doc(),
    replica = new Y.Doc();
  author.getText('body').insert(0, 'abcdefghij');
  const seed = Y.encodeStateAsUpdate(author);
  Y.applyUpdate(peer, seed);
  Y.applyUpdate(replica, seed);
  expect(sizer.size(replica)).toBe(Y.encodeStateAsUpdate(replica).length);
  const before = Y.snapshot(replica),
    structs = replica.store.clients.get(author.clientID)!.length;
  peer.getText('body').insert(5, 'split here');
  Y.applyUpdate(replica, Y.encodeStateAsUpdate(peer));
  expect(Y.snapshot(replica).sv.get(author.clientID)).toBe(before.sv.get(author.clientID));
  expect(Y.equalDeleteSets(Y.snapshot(replica).ds, before.ds)).toBe(true);
  expect(replica.store.clients.get(author.clientID)!.length).toBeGreaterThan(structs);
  expect(sizer.size(replica)).toBe(Y.encodeStateAsUpdate(replica).length);
  author.destroy();
  peer.destroy();
  replica.destroy();
});

it('matches stock encoding during transactions and after nested observer edits', () => {
  const sizer = new DocumentSizer(),
    doc = new Y.Doc();
  const check = () => expect(sizer.size(doc)).toBe(Y.encodeStateAsUpdate(doc).length);
  doc.on('afterAllTransactions', check);
  check();
  doc.getText('body').observe(() => {
    check();
    doc.getMap('observer').set('count', doc.getText('body').length);
  });
  doc.transact(() => {
    doc.getText('body').insert(0, 'a'.repeat(300));
    check();
  });
  check();
  doc.getText('body').delete(20, 200);
  check();
  doc.destroy();
});

it.each([0x86a921, 0x531a4, 0xf814])(
  'matches stock V1 under concurrent shuffled edits (seed %i)',
  (seed) => {
    const sizer = new DocumentSizer(),
      docs = Array.from({ length: 6 }, (_, i) => {
        const doc = new Y.Doc({ gc: i % 2 === 0 });
        doc.clientID = [127, 128, 16383, 16384, 2 ** 30, 0xffffffff][i]!;
        doc.getText('body');
        doc.getArray('items');
        doc.getMap('values');
        return doc;
      });
    let state = seed;
    const random = (maximum: number) => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return Math.floor((state / 0x100000000) * maximum);
    };
    const check = () => {
      for (const doc of docs) expect(sizer.size(doc)).toBe(Y.encodeStateAsUpdate(doc).length);
    };
    check();
    for (let step = 0; step < 400; step++) {
      const source = docs[random(docs.length)]!,
        text = source.getText('body'),
        array = source.getArray('items'),
        values = source.getMap('values');
      source.transact(() => {
        switch (random(6)) {
          case 0:
            text.insert(random(text.length + 1), ` ${step}漢🙂`);
            break;
          case 1:
            if (text.length) text.delete(random(text.length), 1);
            break;
          case 2:
            if (text.length) text.format(random(text.length), 1, { bold: step % 2 ? true : null });
            break;
          case 3:
            values.set(`key${random(5)}`, {
              step,
              bytes: new Uint8Array(random(200)),
              list: [null, NaN],
            });
            break;
          case 4:
            array.insert(random(array.length + 1), [step, `value${step}`]);
            break;
          default:
            if (array.length) array.delete(random(array.length), 1);
        }
      });
      const target = docs[random(docs.length)]!;
      if (target !== source) Y.applyUpdate(target, Y.encodeStateAsUpdate(source));
      check();
    }
    const merged = Y.mergeUpdates(docs.map((doc) => Y.encodeStateAsUpdate(doc)));
    for (const doc of docs) Y.applyUpdate(doc, merged);
    check();
    docs.forEach((doc) => doc.destroy());
  },
);
