import type { HocuspocusProvider } from '@hocuspocus/provider';
import * as Y from 'yjs';

export type DatabaseSaveState = 'saving' | 'saved' | 'retrying';

/** Confirms the editor's current state against a committed PostgreSQL snapshot. */
export class DatabaseSaveTracker {
  state: DatabaseSaveState = 'saving';
  private requestId: string | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private responseTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(
    private readonly document: Y.Doc,
    private readonly provider: HocuspocusProvider,
    private readonly onState: (state: DatabaseSaveState) => void,
  ) {
    document.on('update', this.invalidate);
    provider.on('status', this.invalidate);
    provider.on('close', this.invalidate);
    provider.on('synced', this.resume);
    provider.on('unsyncedChanges', this.resume);
    provider.on('stateless', this.receive);
    this.schedule();
  }

  private connected() {
    return (
      this.provider.configuration.websocketProvider.status === 'connected' &&
      this.provider.isAuthenticated &&
      this.provider.synced &&
      !this.provider.hasUnsyncedChanges
    );
  }

  private setState(state: DatabaseSaveState) {
    this.state = state;
    this.onState(state);
  }

  private schedule = () => {
    if (this.disposed || this.timer || this.requestId || this.state === 'saved') return;
    this.timer = setTimeout(this.check, 500);
  };

  private resume = () => {
    if (this.provider.hasUnsyncedChanges) this.invalidate();
    else this.schedule();
  };

  private invalidate = () => {
    // Invalidate synchronously on local edits, remote edits, and connection
    // changes. An old response cannot acknowledge a newer editor revision.
    this.requestId = null;
    clearTimeout(this.responseTimer);
    // A response cannot confirm the current state while edits keep arriving.
    // Wait for a quiet interval before asking the server for another snapshot.
    clearTimeout(this.timer);
    this.timer = undefined;
    this.setState('saving');
    this.schedule();
  };

  private check = () => {
    this.timer = undefined;
    if (this.disposed) return;
    if (!this.connected()) return this.schedule();
    this.requestId = crypto.randomUUID();
    this.provider.sendStateless(
      JSON.stringify({
        type: 'persistence:check:v1',
        requestId: this.requestId,
      }),
    );
    this.responseTimer = setTimeout(() => {
      this.requestId = null;
      this.setState('retrying');
      this.schedule();
    }, 5000);
  };

  private receive = ({ payload }: { payload: string }) => {
    try {
      const response = JSON.parse(payload);
      if (
        !response ||
        response.type !== 'persistence:status:v1' ||
        !this.requestId ||
        response.requestId !== this.requestId
      )
        return;
      this.requestId = null;
      clearTimeout(this.responseTimer);
      if (this.connected() && typeof response.snapshot === 'string') {
        const committed = Y.decodeSnapshot(
          Uint8Array.from(atob(response.snapshot), (c) => c.charCodeAt(0)),
        );
        // State vectors alone miss deletion-only edits. Full snapshot equality
        // also prevents a delayed response from marking a later revision saved.
        if (Y.equalSnapshots(committed, Y.snapshot(this.document))) {
          this.setState('saved');
          return;
        }
      }
      this.setState(response.status === 'retrying' ? 'retrying' : 'saving');
    } catch {
      this.requestId = null;
      clearTimeout(this.responseTimer);
      this.setState('retrying');
    }
    this.schedule();
  };

  destroy(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    clearTimeout(this.responseTimer);
    this.document.off('update', this.invalidate);
    this.provider.off('status', this.invalidate);
    this.provider.off('close', this.invalidate);
    this.provider.off('synced', this.resume);
    this.provider.off('unsyncedChanges', this.resume);
    this.provider.off('stateless', this.receive);
  }
}
