import * as Y from 'yjs';

/** Frozen workload v1: change the ID/version before changing measurement semantics. */
export interface LoadProfile {
  id: string;
  primary: boolean;
  writers: number;
  documents: number;
  seedTextBytes: number;
  rate: number;
  warmupSeconds: number;
  measureSeconds: number;
  repeats: number;
}
export const primary: LoadProfile = Object.freeze({
  id: 'shared-richtext-v1',
  primary: true,
  writers: 50,
  documents: 1,
  seedTextBytes: 10 * 1024,
  rate: 2,
  warmupSeconds: 30,
  measureSeconds: 120,
  repeats: 3,
});
export const characterizations: LoadProfile[] = [
  {
    ...primary,
    id: 'five-documents-v1',
    primary: false,
    documents: 5,
    warmupSeconds: 10,
    measureSeconds: 30,
    repeats: 1,
  },
  {
    ...primary,
    id: 'large-richtext-v1',
    primary: false,
    seedTextBytes: 128 * 1024,
    warmupSeconds: 10,
    measureSeconds: 30,
    repeats: 1,
  },
];
export interface ReconnectProfile {
  id: string;
  primary: boolean;
  writers: number;
  seedTextBytes: number;
  affected: number;
  offlineMs: number;
  mutationsPerActor: number;
  observerMutations: number;
  trials: number;
  deadlineMs: number;
}
export const reconnect: ReconnectProfile = Object.freeze({
  id: 'migration-reconnect-v1',
  primary: true,
  writers: 50,
  seedTextBytes: 10 * 1024,
  affected: 5,
  offlineMs: 2000,
  mutationsPerActor: 8,
  observerMutations: 8,
  trials: 30,
  deadlineMs: 2000,
});
export const backlog: ReconnectProfile = {
  ...reconnect,
  id: 'large-backlog-v1',
  primary: false,
  seedTextBytes: 128 * 1024,
  affected: 10,
  mutationsPerActor: 50,
  trials: 5,
};
export const smokeLoad: LoadProfile = {
  ...primary,
  id: 'smoke-only-v1',
  primary: false,
  warmupSeconds: 1,
  measureSeconds: 3,
  repeats: 1,
};
export const smokeReconnect: ReconnectProfile = {
  ...reconnect,
  id: 'smoke-reconnect-only-v1',
  primary: false,
  offlineMs: 200,
  trials: 2,
};

export function nodeFor(writer: number): number {
  if (writer < 13) return 0;
  if (writer < 26) return 1;
  if (writer < 38) return 2;
  return 3;
}
export function actorsForDocument(index: number, count: number, writers: number): number[] {
  return Array.from({ length: writers }, (_, i) => i).filter((i) => i % count === index);
}
export function seedDocument(actors: number[], bytes: number): Y.Doc {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment('default');
  const markers = doc.getMap<number>('benchmark-sequences');
  doc.transact(() => {
    for (const actor of actors) {
      const paragraph = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      paragraph.insert(0, [text]);
      fragment.push([paragraph]);
      text.insert(
        0,
        (`writer ${actor} ` + 'a'.repeat(bytes)).slice(0, Math.floor(bytes / actors.length)),
      );
      markers.set(String(actor), 0);
    }
  });
  return doc;
}
export function writerText(doc: Y.Doc, actor: number, actors: number[]): Y.XmlText {
  const paragraph = doc.getXmlFragment('default').get(actors.indexOf(actor)) as Y.XmlElement;
  const text = paragraph?.get(0);
  if (!(text instanceof Y.XmlText)) throw new Error('Rich-text seed/schema not synchronized');
  return text;
}
export type Mutation = 'insert' | 'delete' | 'format';
/** Three inserts, one delete, one format per five atomic rich-text transactions. */
export function mutate(doc: Y.Doc, actor: number, sequence: number, actors: number[]): Mutation {
  const text = writerText(doc, actor, actors);
  const kind = sequence % 5 === 0 ? 'delete' : sequence % 5 === 4 ? 'format' : 'insert';
  doc.transact(() => {
    if (kind === 'insert')
      text.insert(text.length, ` ${actor}:${String(sequence).padStart(5, '0')}`);
    else if (kind === 'delete') text.delete(text.length - 4, 4);
    else text.format(text.length - 8, 8, { bold: sequence % 10 === 4 ? true : null });
    // A bounded, per-writer instrumentation map makes deletion/format-only
    // transactions observable. It travels in the SAME atomic update, last.
    doc.getMap<number>('benchmark-sequences').set(String(actor), sequence);
  }, 'benchmark-local');
  return kind;
}
export function richState(doc: Y.Doc): string {
  return JSON.stringify(
    doc
      .getXmlFragment('default')
      .toArray()
      .map((node) => {
        const element = node as Y.XmlElement;
        return {
          name: element.nodeName,
          attrs: element.getAttributes(),
          children: element.toArray().map((text) => (text as Y.XmlText).toDelta()),
        };
      }),
  );
}
export function completeStateEqual(a: Y.Doc, b: Y.Doc): boolean {
  return Y.equalSnapshots(Y.snapshot(a), Y.snapshot(b)) && richState(a) === richState(b);
}
