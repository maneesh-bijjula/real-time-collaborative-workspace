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
