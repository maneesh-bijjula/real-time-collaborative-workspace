import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import * as Y from 'yjs';
import { DatabaseSaveTracker } from '../../apps/web/lib/database-save';

class Provider {
  configuration = { websocketProvider: { status: 'connected' } };
  synced = true;
  isAuthenticated = true;
  hasUnsyncedChanges = false;
  sendStateless = vi.fn();
  listeners = new Map<string, Set<(value?: unknown) => void>>();
  on(event: string, callback: (value?: unknown) => void) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(callback);
  }
  off(event: string, callback: (value?: unknown) => void) {
    this.listeners.get(event)?.delete(callback);
  }
  emit(event: string, value?: unknown) {
    this.listeners.get(event)?.forEach((callback) => callback(value));
  }
}

let doc: Y.Doc;
let provider: Provider;
let tracker: DatabaseSaveTracker;

function reply(snapshot = Y.snapshot(doc), requestId?: string) {
  const request = JSON.parse(provider.sendStateless.mock.lastCall![0]);
  provider.emit('stateless', {
    payload: JSON.stringify({
      type: 'persistence:status:v1',
      requestId: requestId ?? request.requestId,
      status: 'available',
      snapshot: Buffer.from(Y.encodeSnapshot(snapshot)).toString('base64'),
    }),
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  doc = new Y.Doc();
  provider = new Provider();
  tracker = new DatabaseSaveTracker(doc, provider as unknown as HocuspocusProvider, () => {});
});
afterEach(() => {
  tracker.destroy();
  doc.destroy();
  vi.useRealTimers();
});

describe('database save confirmation', () => {
  it('waits for edits to settle before requesting a fresh committed snapshot', () => {
    for (let i = 0; i < 10; i++) {
      doc.getText('body').insert(i, 'x');
      vi.advanceTimersByTime(200);
    }
    expect(provider.sendStateless).not.toHaveBeenCalled();
    expect(tracker.state).toBe('saving');
    vi.advanceTimersByTime(300);
    expect(provider.sendStateless).toHaveBeenCalledTimes(1);
    reply();
    expect(tracker.state).toBe('saved');
  });

  it('requires a database response and invalidates immediately on the next edit', () => {
    doc.getText('body').insert(0, 'one');
    expect(tracker.state).toBe('saving');
    vi.advanceTimersByTime(500);
    reply();
    expect(tracker.state).toBe('saved');
    doc.getText('body').insert(3, ' two');
    expect(tracker.state).toBe('saving');
  });

  it('does not confuse an unchanged state vector with a persisted deletion', () => {
    doc.getText('body').insert(0, 'abcdef');
    const beforeDelete = Y.snapshot(doc);
    doc.getText('body').delete(1, 2);
    expect(Y.snapshot(doc).sv).toEqual(beforeDelete.sv);
    vi.advanceTimersByTime(500);
    reply(beforeDelete);
    expect(tracker.state).toBe('saving');
    vi.advanceTimersByTime(500);
    reply();
    expect(tracker.state).toBe('saved');
  });

  it('ignores a delayed response from before a newer edit', () => {
    doc.getText('body').insert(0, 'old');
    vi.advanceTimersByTime(500);
    const oldRequest = JSON.parse(provider.sendStateless.mock.lastCall![0]);
    const oldSnapshot = Y.snapshot(doc);
    doc.getText('body').insert(3, ' new');
    vi.advanceTimersByTime(500);
    reply(oldSnapshot, oldRequest.requestId);
    expect(tracker.state).toBe('saving');
    reply();
    expect(tracker.state).toBe('saved');
  });

  it('invalidates on remote updates as well as local ones', () => {
    vi.advanceTimersByTime(500);
    reply();
    const peer = new Y.Doc();
    peer.getText('body').insert(0, 'peer change');
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer), provider);
    expect(tracker.state).toBe('saving');
    peer.destroy();
  });

  it('requires a new confirmation after reconnecting, even with identical content', () => {
    vi.advanceTimersByTime(500);
    reply();
    expect(tracker.state).toBe('saved');
    provider.configuration.websocketProvider.status = 'disconnected';
    provider.emit('status', { status: 'disconnected' });
    expect(tracker.state).toBe('saving');
    vi.advanceTimersByTime(1000);
    expect(provider.sendStateless).toHaveBeenCalledTimes(1);
    provider.configuration.websocketProvider.status = 'connected';
    provider.emit('status', { status: 'connected' });
    vi.advanceTimersByTime(500);
    reply();
    expect(tracker.state).toBe('saved');
  });

  it('cannot confirm while collaboration changes are still unacknowledged', () => {
    vi.advanceTimersByTime(500);
    provider.hasUnsyncedChanges = true;
    reply();
    expect(tracker.state).toBe('saving');
  });

  it('keeps retrying when the database is unavailable or the server does not respond', () => {
    vi.advanceTimersByTime(500);
    const request = JSON.parse(provider.sendStateless.mock.lastCall![0]);
    provider.emit('stateless', {
      payload: JSON.stringify({
        type: 'persistence:status:v1',
        requestId: request.requestId,
        status: 'retrying',
      }),
    });
    expect(tracker.state).toBe('retrying');
    vi.advanceTimersByTime(5500);
    expect(tracker.state).toBe('retrying');
    vi.advanceTimersByTime(500);
    reply();
    expect(tracker.state).toBe('saved');
  });

  it('ignores an unrelated or malformed message without confirming a save', () => {
    vi.advanceTimersByTime(500);
    provider.emit('stateless', { payload: 'not json' });
    expect(tracker.state).not.toBe('saved');
    vi.advanceTimersByTime(500);
    reply(Y.snapshot(doc), crypto.randomUUID());
    expect(tracker.state).not.toBe('saved');
  });

  it('stops timers and removes listeners when disposed', () => {
    tracker.destroy();
    vi.advanceTimersByTime(10000);
    expect(provider.sendStateless).not.toHaveBeenCalled();
    expect([...provider.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
  });
});
