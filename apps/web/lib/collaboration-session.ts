import type { HocuspocusProvider } from '@hocuspocus/provider';

/** Maintains presence and recovers a server-closed logical document session. */
export class CollaborationSession {
  private authenticatedSession = false;
  private disposed = false;
  private restartPending = false;
  private completedSessions = 0;
  private paused = false;
  get blocked() {
    return this.paused;
  }

  constructor(
    private readonly provider: HocuspocusProvider,
    private readonly onPolicyBlocked: () => void = () => {},
  ) {
    provider.on('synced', this.synced);
    provider.on('close', this.closed);
    provider.on('status', this.statusChanged);
  }

  private synced = ({ state }: { state: boolean }) => {
    if (!state) return;
    if (!this.authenticatedSession) {
      this.provider.sendStateless(
        JSON.stringify({ type: 'session:ready:v1', reconnected: this.completedSessions > 0 }),
      );
      this.completedSessions++;
    }
    this.authenticatedSession = true;
    const awareness = this.provider.awareness;
    const local = awareness?.getLocalState();
    // Advance the local awareness clock beyond the previous connection's
    // removal tombstone. Otherwise presence can remain absent until heartbeat.
    if (local) awareness?.setLocalState(local);
  };

  private closed = ({ event }: { event?: { code?: number } } = {}) => {
    const awareness = this.provider.awareness;
    // The provider removes remote states on close but retains their clocks.
    // A reconnect's unchanged peer snapshot would then be ignored until that
    // peer's next heartbeat. Forget only absent remote entries so replay can
    // restore presence immediately, while retaining our own removal clock.
    if (awareness) {
      for (const id of awareness.meta.keys()) {
        if (id !== this.provider.document.clientID && !awareness.getStates().has(id))
          awareness.meta.delete(id);
      }
    }
    if (event?.code === 1008 || event?.code === 1009) {
      this.paused = true;
      this.restartPending = false;
      this.authenticatedSession = false;
      this.provider.disconnect();
      this.onPolicyBlocked();
      return;
    }
    const socket = this.provider.configuration.websocketProvider;
    const logicalClose = this.authenticatedSession && socket.status === 'connected';
    this.authenticatedSession = false;
    if (this.disposed || !logicalClose) return;
    // The Hocuspocus document-close opcode leaves the physical socket open.
    // A fresh authenticated session needs a new transport handshake.
    this.restartPending = true;
    this.provider.disconnect();
  };

  private statusChanged = ({ status }: { status: string }) => {
    if (this.disposed || !this.restartPending || status !== 'disconnected') return;
    this.restartPending = false;
    // disconnect() closes asynchronously; connect() is a no-op while the
    // provider still reports connected. Wait for the actual transport close.
    void this.provider.connect().catch(() => {
      /* The provider owns bounded-backoff retries. */
    });
  };

  destroy(): void {
    this.disposed = true;
    this.provider.off('synced', this.synced);
    this.provider.off('close', this.closed);
    this.provider.off('status', this.statusChanged);
  }
}
