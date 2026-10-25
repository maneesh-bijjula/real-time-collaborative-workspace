import { describe, expect, it, vi } from 'vitest';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import { CollaborationSession } from '../../apps/web/lib/collaboration-session';

function fixture() {
  const listeners = new Map<string, (data?: unknown) => void>();
  const local = { user: { name: 'Returning editor' } };
  const provider = {
    configuration: { websocketProvider: { status: 'connected' } },
    document: { clientID: 1 },
    awareness: {
      getLocalState: () => local,
      setLocalState: vi.fn(),
      meta: new Map([
        [1, { clock: 3 }],
        [2, { clock: 7 }],
        [3, { clock: 1 }],
      ]),
      getStates: () =>
        new Map([
          [1, local],
          [3, local],
        ]),
    },
    on: (event: string, callback: (data?: unknown) => void) => listeners.set(event, callback),
    off: (event: string) => listeners.delete(event),
    sendStateless: vi.fn((_payload: string) => {}),
    disconnect: vi.fn(),
    connect: vi.fn(async () => {}),
  };
  const session = new CollaborationSession(provider as unknown as HocuspocusProvider);
  const emit = (event: string, data?: unknown) => listeners.get(event)?.(data);
  return { provider, session, emit, listeners, local };
}

describe('collaboration connection lifecycle', () => {
  it('refreshes the local presence clock after successful synchronization', () => {
    const f = fixture();
    f.emit('synced', { state: true });
    expect(f.provider.awareness.setLocalState).toHaveBeenCalledWith(f.local);
    f.session.destroy();
  });
  it('forgets absent remote awareness clocks so unchanged peers can return immediately', () => {
    const f = fixture();
    f.emit('close');
    expect([...f.provider.awareness.meta.keys()]).toEqual([1, 3]);
    f.session.destroy();
  });
  it('reports only completed session rejoins and does not count a sync event twice', () => {
    const f = fixture();
    f.emit('synced', { state: true });
    f.emit('synced', { state: true });
    expect(f.provider.sendStateless).toHaveBeenCalledTimes(1);
    expect(JSON.parse(f.provider.sendStateless.mock.calls[0]![0])).toMatchObject({
      reconnected: false,
    });
    f.provider.configuration.websocketProvider.status = 'disconnected';
    f.emit('close');
    f.emit('synced', { state: true });
    expect(JSON.parse(f.provider.sendStateless.mock.calls[1]![0])).toMatchObject({
      reconnected: true,
    });
    f.session.destroy();
  });
  it('starts a fresh handshake for a logical close of an authenticated session', () => {
    const f = fixture();
    f.emit('synced', { state: true });
    f.emit('close');
    expect(f.provider.disconnect).toHaveBeenCalledOnce();
    expect(f.provider.connect).not.toHaveBeenCalled();
    f.emit('status', { status: 'disconnected' });
    expect(f.provider.connect).toHaveBeenCalledOnce();
    f.emit('status', { status: 'disconnected' });
    expect(f.provider.connect).toHaveBeenCalledOnce();
    f.session.destroy();
  });
  it('leaves physical disconnect retries to the provider and does not retry an initial denial', () => {
    const f = fixture();
    f.emit('close');
    expect(f.provider.connect).not.toHaveBeenCalled();
    f.emit('synced', { state: true });
    f.provider.configuration.websocketProvider.status = 'disconnected';
    f.emit('close');
    expect(f.provider.connect).not.toHaveBeenCalled();
    f.session.destroy();
  });
  it.each([1008, 1009])('pauses automatic retries after permanent policy close %s', (code) => {
    const f = fixture();
    f.emit('synced', { state: true });
    f.emit('close', { event: { code } });
    f.emit('status', { status: 'disconnected' });
    expect(f.session.blocked).toBe(true);
    expect(f.provider.disconnect).toHaveBeenCalledOnce();
    expect(f.provider.connect).not.toHaveBeenCalled();
    f.session.destroy();
  });
  it('detaches its listeners before the provider is destroyed', () => {
    const f = fixture();
    f.session.destroy();
    expect(f.listeners.size).toBe(0);
  });
});
