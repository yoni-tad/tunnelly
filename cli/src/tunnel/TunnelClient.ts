import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import {
  FATAL_ERROR_CODES,
  parseMessage,
  PROTOCOL_VERSION,
  type ClientMessage,
  type ErrorMessage,
  type HelloMessage,
  type ServerMessage,
} from '../../../shared/protocol.js';
import { decodeFrame, encodeFrame, FrameKind, toBuffer } from '../../../shared/frames.js';
import { toWebSocketUrl } from '../config.js';
import { backoffDelay, DEFAULT_BACKOFF, type BackoffOptions } from '../utils/backoff.js';
import { findLocalAddress } from '../network/checkLocal.js';
import { LocalForwarder, type ForwarderIO, type RequestLog } from './LocalForwarder.js';
import { LocalWsForwarder } from './LocalWsForwarder.js';

export interface TunnelClientOptions {
  serverUrl: string;
  localHost: string;
  localPort: number;
  /** Resolved address of the local app (from the startup port check), if known. */
  localAddress?: string;
  clientVersion: string;
  token?: string;
  backoff?: BackoffOptions;
  /** How often we ping the server. */
  heartbeatIntervalMs?: number;
  /** No traffic/pong from the server for this long → assume the connection is dead. */
  heartbeatTimeoutMs?: number;
  connectTimeoutMs?: number;
}

export interface ConnectedEvent {
  tunnelId: string;
  publicUrl: string;
  resumed: boolean;
  /** True when a reconnect produced a different public URL than before. */
  urlChanged: boolean;
  firstConnect: boolean;
}

export interface ReconnectingEvent {
  attempt: number;
  delayMs: number;
  reason: string;
  /** False while we have never managed to connect (server unreachable at startup). */
  everConnected: boolean;
}

export type ClientState = 'idle' | 'connecting' | 'connected' | 'waiting' | 'stopped';

export interface TunnelClientEvents {
  connecting: [];
  connected: [ConnectedEvent];
  disconnected: [{ reason: string }];
  reconnecting: [ReconnectingEvent];
  fatal: [ErrorMessage];
  request: [RequestLog];
  stopped: [];
}

/**
 * Maintains the tunnel: connects, performs the handshake, forwards traffic,
 * detects dead connections via heartbeats and reconnects with exponential
 * backoff — resuming the same public URL when the server still has it.
 */
export class TunnelClient extends EventEmitter<TunnelClientEvents> {
  state: ClientState = 'idle';
  private ws: WebSocket | null = null;
  private session: { tunnelId: string; sessionToken: string; publicUrl: string } | null = null;
  private attempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private lastSeenAt = 0;
  private fatalError: ErrorMessage | null = null;
  private lastError: string | undefined;
  private readonly http: LocalForwarder;
  private readonly wsForwarder: LocalWsForwarder;
  private readonly wsUrl: string;
  private readonly opts: Required<Omit<TunnelClientOptions, 'token' | 'localAddress'>> & { token?: string };
  private localAddress: string;
  private resolvingLocal = false;

  constructor(options: TunnelClientOptions) {
    super();
    this.opts = {
      backoff: DEFAULT_BACKOFF,
      heartbeatIntervalMs: 15_000,
      heartbeatTimeoutMs: 45_000,
      connectTimeoutMs: 10_000,
      ...options,
    };
    this.wsUrl = toWebSocketUrl(options.serverUrl);
    this.localAddress = options.localAddress ?? options.localHost;

    const io: ForwarderIO = {
      host: options.localHost,
      port: options.localPort,
      address: () => this.localAddress,
      onLocalUnavailable: () => this.reresolveLocal(),
      send: (msg) => this.send(msg),
      sendFrame: (kind, id, payload, compress = false) => {
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(encodeFrame(kind, id, payload), { compress });
      },
      socket: () => this.ws,
      onLog: (log) => this.emit('request', log),
    };
    this.http = new LocalForwarder(io);
    this.wsForwarder = new LocalWsForwarder(io);
  }

  /** The app may have restarted on another address family (::1 vs 127.0.0.1). */
  private reresolveLocal(): void {
    if (this.resolvingLocal) return;
    this.resolvingLocal = true;
    findLocalAddress(this.opts.localHost, this.opts.localPort)
      .then((address) => {
        if (address) this.localAddress = address;
      })
      .finally(() => {
        this.resolvingLocal = false;
      });
  }

  get publicUrl(): string | null {
    return this.session?.publicUrl ?? null;
  }

  start(): void {
    if (this.state !== 'idle') return;
    this.connect();
  }

  /** Graceful shutdown: tell the server, close the socket, release local resources. */
  async stop(): Promise<void> {
    if (this.state === 'stopped') return;
    this.state = 'stopped';
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.stopHeartbeat();
    this.http.close();
    this.wsForwarder.closeAll();

    const ws = this.ws;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()));
      if (ws.readyState === WebSocket.OPEN) {
        this.send({ type: 'shutdown' });
        ws.close(1000, 'client shutdown');
      } else {
        ws.terminate();
      }
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, 1500).unref());
      await Promise.race([closed, timeout]);
      ws.terminate();
    }
    this.ws = null;
    this.emit('stopped');
  }

  private send(message: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
  }

  private connect(): void {
    this.state = 'connecting';
    this.lastError = undefined;
    this.emit('connecting');

    const ws = new WebSocket(this.wsUrl, {
      handshakeTimeout: this.opts.connectTimeoutMs,
      // Compression is opt-in per message (text responses only); see LocalForwarder.
      perMessageDeflate: { threshold: 1024, zlibDeflateOptions: { level: 4 } },
      maxPayload: 64 * 1024 * 1024,
    });
    this.ws = ws;

    ws.on('open', () => {
      this.markAlive();
      const hello: HelloMessage = {
        type: 'hello',
        version: PROTOCOL_VERSION,
        clientVersion: this.opts.clientVersion,
        localPort: this.opts.localPort,
        ...(this.opts.token ? { token: this.opts.token } : {}),
        ...(this.session ? { resume: { tunnelId: this.session.tunnelId, sessionToken: this.session.sessionToken } } : {}),
      };
      ws.send(JSON.stringify(hello));
    });
    ws.on('message', (data, isBinary) => {
      if (ws !== this.ws) return;
      this.markAlive();
      if (isBinary) this.handleFrame(toBuffer(data));
      else this.handleMessage(toBuffer(data).toString('utf8'));
    });
    ws.on('ping', () => this.markAlive());
    ws.on('pong', () => this.markAlive());
    ws.on('error', (err) => {
      this.lastError = err.message;
    });
    ws.on('close', (code, reason) => this.handleClose(ws, code, reason.toString()));
  }

  private handleMessage(raw: string): void {
    const msg = parseMessage<ServerMessage>(raw);
    if (!msg) return;
    switch (msg.type) {
      case 'ready': {
        const previousUrl = this.session?.publicUrl;
        this.session = { tunnelId: msg.tunnelId, sessionToken: msg.sessionToken, publicUrl: msg.publicUrl };
        this.attempt = 0;
        this.state = 'connected';
        this.startHeartbeat();
        this.emit('connected', {
          tunnelId: msg.tunnelId,
          publicUrl: msg.publicUrl,
          resumed: msg.resumed,
          urlChanged: previousUrl !== undefined && previousUrl !== msg.publicUrl,
          firstConnect: previousUrl === undefined,
        });
        return;
      }
      case 'error':
        if (FATAL_ERROR_CODES.has(msg.code)) this.fatalError = msg;
        else this.lastError = msg.message;
        return;
      case 'request-start':
        this.http.onRequestStart(msg);
        return;
      case 'request-end':
        this.http.onRequestEnd(msg.id);
        return;
      case 'request-abort':
        this.http.onAbort(msg.id);
        return;
      case 'flow':
        this.http.onFlow(msg.id, msg.paused);
        return;
      case 'ws-open':
        this.wsForwarder.onOpen(msg);
        return;
      case 'ws-close':
        this.wsForwarder.onClose(msg);
        return;
    }
  }

  private handleFrame(data: Buffer): void {
    const frame = decodeFrame(data);
    if (!frame) return;
    if (frame.kind === FrameKind.BODY) this.http.onBody(frame.id, frame.payload);
    else this.wsForwarder.onFrame(frame);
  }

  private handleClose(ws: WebSocket, code: number, reason: string): void {
    if (ws !== this.ws) return;
    this.ws = null;
    this.stopHeartbeat();
    this.http.abortAll();
    this.wsForwarder.closeAll();
    if (this.state === 'stopped') return;

    if (this.fatalError) {
      const error = this.fatalError;
      this.state = 'stopped';
      this.emit('fatal', error);
      return;
    }

    const why = this.lastError ?? (reason || (code === 1012 ? 'server restarting' : `connection closed (${code})`));
    if (this.state === 'connected') this.emit('disconnected', { reason: why });
    this.scheduleReconnect(why);
  }

  private scheduleReconnect(reason: string): void {
    const delayMs = backoffDelay(this.attempt, this.opts.backoff);
    this.attempt++;
    this.state = 'waiting';
    this.emit('reconnecting', { attempt: this.attempt, delayMs, reason, everConnected: this.session !== null });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.state === 'waiting') this.connect();
    }, delayMs);
  }

  private markAlive(): void {
    this.lastSeenAt = Date.now();
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      const ws = this.ws;
      if (!ws) return;
      if (Date.now() - this.lastSeenAt > this.opts.heartbeatTimeoutMs) {
        // e.g. Wi-Fi dropped: the socket looks open but nothing gets through.
        this.lastError = 'connection timed out';
        ws.terminate();
        return;
      }
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, this.opts.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }
}
