import { HocuspocusProvider } from '@hocuspocus/provider';
import * as Y from 'yjs';
import { CollaborationSession } from '../apps/web/lib/collaboration-session.js';
import { DatabaseSaveTracker } from '../apps/web/lib/database-save.js';
import {
  actorsForDocument,
  completeStateEqual,
  nodeFor,
  richState,
  seedDocument,
  writerText,
} from './workloads.js';
import { until } from './runtime.js';

export type Client = {
  index: number;
  node: number;
  document: number;
  doc: Y.Doc;
  provider: HocuspocusProvider;
  session: CollaborationSession;
  tracker?: DatabaseSaveTracker;
  sequence: number;
  closes: number;
  failures: number;
};
type Document = { id: string; token: string; seed: Uint8Array; reference: Y.Doc; actors: number[] };
export class Group {
  readonly clients: Client[] = [];
  readonly documents: Document[] = [];
  constructor(readonly endpoints: string[]) {}
  private attach(client: Client) {
    const document = this.documents[client.document]!;
    const provider = new HocuspocusProvider({
      url: this.endpoints[client.node]!.replace('http:', 'ws:') + '/collaboration',
      name: document.id,
      token: document.token,
      document: client.doc,
    });
    client.provider = provider;
    client.session = new CollaborationSession(provider);
    client.tracker = new DatabaseSaveTracker(client.doc, provider, () => {});
    provider.on('close', () => {
      client.closes++;
    });
    provider.on('authenticationFailed', () => {
      client.failures++;
    });
    provider.setAwarenessField('user', { name: `Editor ${client.index}`, color: '#7856b6' });
  }
  async create(writers: number, count: number, bytes: number) {
    for (let document = 0; document < count; document++) {
      const response = await fetch(this.endpoints[document % 4] + '/api/documents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Disposable benchmark' }),
      });
      if (response.status !== 201) throw new Error('Benchmark document creation failed');
      const capability = (await response.json()) as { id: string; token: string };
      const actors = actorsForDocument(document, count, writers);
      const reference = seedDocument(actors, bytes);
      this.documents.push({
        ...capability,
        actors,
        reference,
        seed: Y.encodeStateAsUpdate(reference),
      });
    }
    // Seed through the actual application protocol before attaching peers.
    for (let i = 0; i < writers; i++) {
      const client = {
        index: i,
        node: nodeFor(i),
        document: i % count,
        doc: new Y.Doc(),
        sequence: 0,
        closes: 0,
        failures: 0,
      } as Client;
      this.clients.push(client);
      this.attach(client);
      if (i < count) {
        await until(() => client.provider.synced);
        Y.applyUpdate(client.doc, this.documents[i]!.seed, 'benchmark-seed');
        await until(() => !client.provider.hasUnsyncedChanges);
      }
    }
    await until(
      () =>
        this.clients.every(
          (client) =>
            client.provider.synced &&
            richState(client.doc) === richState(this.documents[client.document]!.reference),
        ),
      20000,
    );
    await this.converge(true);
  }
  pulse(client: Client) {
    client.provider.setAwarenessField('user', { name: `Editor ${client.index}`, color: '#7856b6' });
    const text = writerText(client.doc, client.index, this.documents[client.document]!.actors);
    const position = Y.createRelativePositionFromTypeIndex(text, text.length);
    client.provider.setAwarenessField('cursor', { anchor: position, head: position });
  }
  equal(includePresence = false) {
    return this.documents.every((document, i) => {
      const peers = this.clients.filter((c) => c.document === i);
      const baseline = peers[0]!.doc;
      return peers.every(
        (client) =>
          client.provider.synced &&
          !client.provider.hasUnsyncedChanges &&
          completeStateEqual(client.doc, baseline) &&
          richState(client.doc) === richState(document.reference) &&
          (!includePresence ||
            document.actors.every((actor) =>
              [...client.provider.awareness!.getStates().values()].some(
                (s) => s.user?.name === `Editor ${actor}`,
              ),
            )),
      );
    });
  }
  converge(presence = false, timeout = 10000) {
    return until(() => this.equal(presence), timeout);
  }
  detach(client: Client) {
    client.tracker?.destroy();
    client.session.destroy();
    client.provider.destroy();
  }
  reattach(client: Client, node: number) {
    client.node = node;
    this.attach(client);
  }
  async durable() {
    for (const client of this.clients) {
      client.tracker?.destroy();
      client.tracker = new DatabaseSaveTracker(client.doc, client.provider, () => {});
    }
    await until(() => this.clients.every((c) => c.tracker!.state === 'saved'), 20000);
  }
  close() {
    for (const client of this.clients) {
      this.detach(client);
      client.doc.destroy();
    }
    for (const document of this.documents) document.reference.destroy();
  }
}
