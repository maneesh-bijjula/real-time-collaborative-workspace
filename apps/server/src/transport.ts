import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { OutgoingMessage, type Hocuspocus, type Connection } from '@hocuspocus/server';
import type { DocumentStore } from './documents.js';
import {
  AdmissionLimits,
  TokenBucket,
  clientIp,
  ipLimitKey,
  trustedProxyList,
  type ResourcePolicy,
} from './policy.js';
import { decodeFrame, DocumentAdmission, PolicyError, type Frame } from './protocol.js';
import type { Telemetry } from './telemetry.js';

export interface Session {
  socket: WebSocket;
  key: string;
  client: ReturnType<Hocuspocus['handleConnection']>;
  queue: { data: Uint8Array; frame: Frame; counted: boolean }[];
  bytes: number;
  processing: boolean;
  closed: boolean;
  connected: boolean;
  documentId?: string;
  authStarted: boolean;
  reserved: boolean;
  frameDone?: () => void;
  authDone?: () => void;
  authTimer?: ReturnType<typeof setTimeout>;
  messages: TokenBucket;
  inputBytes: TokenBucket;
  stateless: TokenBucket;
  reportedReady: boolean;
}
export interface SessionContext {
  session: Session;
  documentId?: string;
}

export class CollaborationTransport {
  private readonly wss: WebSocketServer;
  private readonly sessions = new Set<Session>();
  private readonly peers = new Map<string, number>();
  private readonly documents = new Map<string, number>();
  private readonly trusted;
  private authenticating = 0;
  private queuedBytes = 0;
  private queuedMessages = 0;
  private readonly documentWork = new WeakMap<object, Promise<void>>();
  private readonly admission = new DocumentAdmission();
  private activeSessions = 0;
  draining = false;
  constructor(
    private readonly collaboration: Hocuspocus,
    private readonly store: DocumentStore,
    readonly policy: ResourcePolicy,
    private readonly limits: AdmissionLimits,
    private readonly telemetry: Telemetry,
    private readonly origins: string[],
    trusted: string[],
  ) {
    this.trusted = trustedProxyList(trusted);
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: policy.maxFrameBytes,
      perMessageDeflate: false,
    });
    this.wss.on('error', () => telemetry.log('request_failed', 'websocket_server'));
  }
  upgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
    const reject = (status: number, reason: string) => {
      this.telemetry.reject(reason);
      socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    if (this.draining) return reject(503, 'draining');
    if (request.url !== '/collaboration') return reject(403, 'upgrade_path');
    if (request.headers.origin && !this.origins.includes(request.headers.origin))
      return reject(403, 'origin');
    let key: string;
    try {
      key = ipLimitKey(clientIp(request, this.trusted));
    } catch {
      return reject(400, 'forwarded_peer');
    }
    if (!this.limits.take('upgrade', key, this.policy.upgradesPerMinute))
      return reject(429, 'upgrade_rate');
    if (
      this.sessions.size >= this.policy.maxSockets ||
      (this.peers.get(key) || 0) >= this.policy.maxSocketsPerIp
    )
      return reject(503, 'socket_capacity');
    try {
      this.wss.handleUpgrade(request, socket, head, (ws) =>
        this.open(ws, key, request.headers.origin),
      );
    } catch {
      socket.destroy();
      this.telemetry.reject('upgrade_handshake');
    }
  }
  private open(socket: WebSocket, key: string, origin?: string) {
    const session: Session = {
      socket,
      key,
      client: undefined!,
      queue: [],
      bytes: 0,
      processing: false,
      closed: false,
      connected: false,
      authStarted: false,
      reserved: false,
      reportedReady: false,
      messages: new TokenBucket(this.policy.messageBurst, this.policy.messagesPerSecond),
      inputBytes: new TokenBucket(this.policy.byteBurst, this.policy.bytesPerSecond),
      stateless: new TokenBucket(this.policy.statelessBurst, this.policy.statelessPerSecond),
    };
    this.sessions.add(session);
    this.peers.set(key, (this.peers.get(key) || 0) + 1);
    this.telemetry.count('socket_connections_total');
    this.telemetry.gauge('sockets', this.sessions.size);
    this.telemetry.log('socket_opened');
    const self = this;
    const adapter = {
      get readyState() {
        return socket.readyState;
      },
      send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
        if (session.closed || socket.readyState !== WebSocket.OPEN) return;
        if (
          socket.bufferedAmount +
            (typeof data === 'string'
              ? Buffer.byteLength(data)
              : data instanceof Blob
                ? data.size
                : data.byteLength) >
          self.policy.maxOutboundBytes
        )
          return self.reject(session, 'backpressure', 1013);
        socket.send(data as Uint8Array, (error) => {
          if (error) self.reject(session, 'socket_write');
        });
      },
      close() {
        socket.close(1008, 'Session closed');
      },
    };
    session.client = this.collaboration.handleConnection(
      adapter,
      new Request('http://localhost/collaboration', { headers: origin ? { origin } : {} }),
      { session },
    );
    session.authTimer = setTimeout(
      () => this.reject(session, 'authentication_timeout', session.authStarted ? 1013 : 1008),
      this.policy.authenticationTimeoutMs,
    ).unref();
    let alive = true;
    const heartbeat = setInterval(() => {
      if (!alive) {
        socket.terminate();
        return;
      }
      alive = false;
      socket.ping();
    }, 30000).unref();
    socket.on('pong', () => {
      alive = true;
      session.client.touch();
    });
    socket.on('error', () => this.reject(session, 'socket_protocol'));
    socket.on('message', (raw, binary) => {
      if (session.closed) return;
      try {
        if (!binary) throw new PolicyError('binary_required');
        const data = Buffer.isBuffer(raw)
          ? raw
          : Array.isArray(raw)
            ? Buffer.concat(raw)
            : Buffer.from(raw);
        if (data.byteLength > this.policy.maxFrameBytes) throw new PolicyError('frame_size');
        if (!session.messages.take() || !session.inputBytes.take(data.byteLength))
          throw new PolicyError('message_rate');
        if (
          session.bytes + data.byteLength > this.policy.maxQueueBytes ||
          this.queuedBytes + data.byteLength > this.policy.maxTotalQueueBytes ||
          session.queue.length >= this.policy.maxQueueMessages ||
          this.queuedMessages >= this.policy.maxTotalQueueMessages
        )
          throw new PolicyError('queue_capacity');
        const frame = decodeFrame(data, this.policy);
        if (session.documentId && frame.document !== session.documentId)
          throw new PolicyError('cross_document');
        if (frame.type === 5 && !session.stateless.take()) throw new PolicyError('stateless_rate');
        session.queue.push({ data, frame, counted: true });
        this.queuedMessages++;
        session.bytes += data.byteLength;
        this.queuedBytes += data.byteLength;
        this.telemetry.gauge('queued_bytes', this.queuedBytes);
        void this.process(session);
      } catch (error) {
        this.reject(session, error instanceof PolicyError ? error.reason : 'malformed');
      }
    });
    socket.on('close', (code) => {
      clearInterval(heartbeat);
      clearTimeout(session.authTimer);
      session.closed = true;
      session.authDone?.();
      session.frameDone?.();
      session.client.handleClose();
      this.disconnected(session);
      for (const item of session.queue) this.release(session, item);
      session.queue.length = 0;
      this.sessions.delete(session);
      const count = (this.peers.get(key) || 1) - 1;
      if (count) this.peers.set(key, count);
      else this.peers.delete(key);
      if (session.reserved && session.documentId) {
        const remaining = (this.documents.get(session.documentId) || 1) - 1;
        if (remaining) this.documents.set(session.documentId, remaining);
        else this.documents.delete(session.documentId);
      }
      this.telemetry.gauge('sockets', this.sessions.size);
      this.telemetry.count('socket_disconnects_total', {
        kind: code === 1000 ? 'normal' : code === 1008 || code === 1009 ? 'policy' : 'transport',
      });
      this.telemetry.log('socket_closed');
    });
  }
  private release(session: Session, item: Session['queue'][number]) {
    if (!item.counted) return;
    item.counted = false;
    this.queuedMessages--;
    session.bytes -= item.data.length;
    this.queuedBytes -= item.data.length;
    this.telemetry.gauge('queued_bytes', this.queuedBytes);
  }
  private async process(session: Session) {
    if (session.processing) return;
    session.processing = true;
    try {
      while (!session.closed && session.queue.length) {
        const item = session.queue[0]!;
        if (item.frame.type === 2) {
          if (session.authStarted) throw new PolicyError('credential_refresh');
          session.authStarted = true;
          session.documentId = item.frame.document;
          const ready = new Promise<void>((resolve) => {
            session.authDone = resolve;
          });
          session.client.handleMessage(item.data);
          await ready;
        } else {
          if (!session.connected || item.frame.document !== session.documentId)
            throw new PolicyError('authentication_required');
          const document = this.collaboration.documents.get(item.frame.document);
          if (!document) throw new PolicyError('session_closed');
          const done = new Promise<void>((resolve) => {
            session.frameDone = resolve;
          });
          const timer = setTimeout(
            () => this.reject(session, 'processing_timeout', 1013),
            this.policy.processingTimeoutMs,
          ).unref();
          let release: (() => void) | undefined;
          let finishAdmission: (() => void) | undefined;
          const mutating =
            (item.frame.type === 0 || item.frame.type === 4) && item.frame.syncType !== 0;
          try {
            if (mutating) {
              // Serialize validation through application on this process.
              // Otherwise two sockets could each validate against the same
              // smaller revision and jointly bypass the admission ceiling.
              const prior = this.documentWork.get(document) || Promise.resolve();
              const next = new Promise<void>((resolve) => {
                release = resolve;
              });
              this.documentWork.set(document, next);
              await prior;
            }
            if (!session.closed) {
              finishAdmission = this.admission.prepare(document, item.frame, this.policy);
              session.client.handleMessage(item.data);
              await done;
            }
          } finally {
            finishAdmission?.();
            release?.();
            clearTimeout(timer);
            session.frameDone = undefined;
          }
        }
        this.release(session, item);
        session.queue.shift();
      }
    } catch (error) {
      this.reject(session, error instanceof PolicyError ? error.reason : 'protocol');
    } finally {
      session.processing = false;
    }
  }
  async authenticate(session: Session, id: string, token: string) {
    if (session.closed || id !== session.documentId) throw { reason: 'Access denied' };
    if (this.authenticating >= this.policy.maxAuthenticating) {
      this.reject(session, 'authentication_capacity', 1013);
      throw { reason: 'Service unavailable' };
    }
    if (!this.limits.take('authentication', session.key, this.policy.authenticationPerMinute)) {
      this.reject(session, 'authentication_capacity');
      throw { reason: 'Access denied' };
    }
    this.authenticating++;
    this.telemetry.gauge('authenticating', this.authenticating);
    try {
      let authorized;
      try {
        authorized = await this.store.authorize(id, token);
      } catch {
        this.telemetry.count('authentication_total', { result: 'unavailable' });
        this.telemetry.log('dependency_failed', 'postgres');
        this.reject(session, 'dependency_unavailable', 1013);
        throw { reason: 'Service unavailable' };
      }
      if (session.closed || this.draining) {
        this.reject(session, 'draining', 1013);
        throw { reason: 'Service unavailable' };
      }
      if (!authorized) {
        this.telemetry.count('authentication_total', { result: 'denied' });
        this.telemetry.log('authentication_denied');
        session.socket.send(
          new OutgoingMessage(id).writePermissionDenied('Access denied').toUint8Array(),
        );
        this.reject(session, 'authentication_denied');
        throw { reason: 'Access denied' };
      }
      const names = new Set([
        ...this.collaboration.documents.keys(),
        ...this.collaboration.loadingDocuments.keys(),
        ...this.documents.keys(),
      ]);
      if (
        (!names.has(id) && names.size >= this.policy.maxDocuments) ||
        (this.documents.get(id) || 0) >= this.policy.maxDocumentClients
      ) {
        this.reject(session, 'document_capacity', 1013);
        throw { reason: 'Service unavailable' };
      }
      this.documents.set(id, (this.documents.get(id) || 0) + 1);
      session.reserved = true;
      this.telemetry.count('authentication_total', { result: 'allowed' });
      return { documentId: id };
    } finally {
      this.authenticating--;
      this.telemetry.gauge('authenticating', this.authenticating);
    }
  }

  connected(session: Session) {
    if (session.closed) return;
    clearTimeout(session.authTimer);
    session.connected = true;
    this.telemetry.count('sessions_total');
    this.telemetry.gauge('sessions', ++this.activeSessions);
    session.authDone?.();
    session.authDone = undefined;
  }
  disconnected(session: Session) {
    if (session.connected) {
      session.connected = false;
      this.telemetry.gauge('sessions', --this.activeSessions);
    }
    session.frameDone?.();
  }
  handled(session: Session) {
    session.frameDone?.();
  }
  reportReady(connection: Connection, payload: string) {
    const session = (connection.context as SessionContext).session;
    const message = JSON.parse(payload);
    if (message.type === 'session:ready:v1' && !session.reportedReady) {
      session.reportedReady = true;
      if (message.reconnected) {
        this.telemetry.count('reconnects_total');
        this.telemetry.log('session_reconnected');
      }
    }
  }
  private reject(session: Session, reason: string, code = 1008) {
    if (session.closed) return;
    session.closed = true;
    this.telemetry.reject(reason);
    session.socket.close(
      code,
      code === 1013 ? 'Service temporarily unavailable' : 'Collaboration policy violation',
    );
    const timer = setTimeout(() => session.socket.terminate(), 250).unref();
    session.socket.once('close', () => clearTimeout(timer));
  }
  async close() {
    this.draining = true;
    for (const session of this.sessions) {
      session.socket.close(1012, 'Server restarting');
      const timer = setTimeout(() => session.socket.terminate(), 250).unref();
      session.socket.once('close', () => clearTimeout(timer));
    }
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }
}
