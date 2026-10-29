import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket } from 'ws';
import type { ServerConfig } from '../config/index.js';
import type { RequestLogStore } from '../services/requestLog.js';
import type { Logger } from '../utils/logger.js';
import type { HeaderMap } from '../../../shared/protocol.js';
import { parseMessage, type ClientMessage, type ServerMessage } from '../../../shared/protocol.js';
import { decodeFrame, encodeFrame, FrameKind, toBuffer } from '../../../shared/frames.js';
import { PausableSource } from '../../../shared/flow.js';
import { redactHeaders, stripHopByHop } from '../../../shared/headers.js';
import { newRequestId } from '../utils/ids.js';
import { getClientIp } from '../utils/clientIp.js';
import { downPages, sendDownPage, type DownPage } from '../utils/pages.js';
import { WsBridge } from './WsBridge.js';
import type { Tunnel } from './Tunnel.js';

export interface ConnectionDeps {
  config: ServerConfig;
  logger: Logger;
  logStore: RequestLogStore;
  onClose(conn: TunnelConnection, graceful: boolean): void;
}

interface HttpExchange {
  id: string;
  method: string;
  path: string;
  req: IncomingMessage;
  res: ServerResponse;
  clientIp: string;
  startedAt: number;
  requestHeaders: HeaderMap;
  responseHeaders: HeaderMap;
  requestBytes: number;
  responseBytes: number;
  status: number;
  error?: string;
  source: PausableSource;
  timer: NodeJS.Timeout | null;
  remoteDone: boolean;
  /** We asked the CLI to pause because the public client is slow. */
  pausedRemote: boolean;
  finished: boolean;
}

/** One live WebSocket between the server and a CLI, carrying a Tunnel's traffic. */
export class TunnelConnection {
  private exchanges = new Map<string, HttpExchange>();
  private readonly wsBridge: WsBridge;
  private heartbeatTimer: NodeJS.Timeout;
  private lastSeenAt = Date.now();
  private graceful = false;
  private closed = false;

  constructor(
    readonly ws: WebSocket,
    readonly tunnel: Tunnel,
    private readonly deps: ConnectionDeps,
  ) {
    this.wsBridge = new WsBridge(this, deps);

    ws.on('message', (data, isBinary) => {
      this.markAlive();
      if (isBinary) this.handleFrame(toBuffer(data));
      else this.handleMessage(toBuffer(data).toString('utf8'));
    });
    ws.on('pong', () => this.markAlive());
    ws.on('close', (code) => this.handleClose(code));
    ws.on('error', (err) => deps.logger.debug('Tunnel socket error', { tunnel: tunnel.id, error: err.message }));

    // Heartbeat: ping regularly; a connection that stays silent too long is dead.
    this.heartbeatTimer = setInterval(() => {
      if (Date.now() - this.lastSeenAt > deps.config.heartbeatTimeoutMs) {
        deps.logger.warn(`Tunnel heartbeat timed out: ${tunnel.id}`);
        ws.terminate();
        return;
      }
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, deps.config.heartbeatIntervalMs);
  }

  get activeRequests(): number {
    return this.exchanges.size;
  }

  send(message: ServerMessage): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
  }

  sendFrame(kind: FrameKind, id: string, payload: Buffer): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(encodeFrame(kind, id, payload));
  }

  /** Close without triggering the resume grace period. */
  close(code: number, reason: string): void {
    this.graceful = true;
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) this.ws.close(code, reason);
  }

  /** Drop a stale socket that a resumed connection is replacing. */
  terminate(): void {
    this.ws.terminate();
  }

  private markAlive(): void {
    this.lastSeenAt = Date.now();
    this.tunnel.lastHeartbeatAt = this.lastSeenAt;
  }

  // ── public HTTP → tunnel ──────────────────────────────────────────────────

  forwardHttp(req: IncomingMessage, res: ServerResponse): void {
    const { config } = this.deps;
    const clientIp = getClientIp(req, config.trustProxy);
    const ex: HttpExchange = {
      id: newRequestId(),
      method: req.method ?? 'GET',
      path: req.url ?? '/',
      req,
      res,
      clientIp,
      startedAt: Date.now(),
      requestHeaders: this.forwardedHeaders(req, clientIp),
      responseHeaders: {},
      requestBytes: 0,
      responseBytes: 0,
      status: 0,
      source: new PausableSource(req),
      timer: null,
      remoteDone: false,
      pausedRemote: false,
      finished: false,
    };
    this.tunnel.requestCount++;
    res.setHeader('x-tunnelly-request-id', ex.id);
    res.on('finish', () => this.finishExchange(ex));
    res.on('close', () => {
      if (!res.writableEnded) ex.error ??= 'Client closed connection';
      this.finishExchange(ex);
    });

    const declaredLength = Number(req.headers['content-length'] ?? 0);
    if (declaredLength > config.maxRequestBodyBytes) {
      ex.remoteDone = true; // never sent to the CLI
      this.failExchange(ex, downPages.tooLarge(config.maxRequestBodyBytes));
      return;
    }

    this.exchanges.set(ex.id, ex);
    // Idle timeout: restarted by every uploaded chunk, cleared once the local app starts responding.
    const armTimeout = () => {
      if (ex.timer) clearTimeout(ex.timer);
      ex.timer = setTimeout(() => {
        this.failExchange(ex, downPages.timeout(this.tunnel.localPort, Math.round(config.requestTimeoutMs / 1000)));
      }, config.requestTimeoutMs);
    };
    armTimeout();

    this.send({ type: 'request-start', id: ex.id, method: ex.method, path: ex.path, headers: ex.requestHeaders });

    req.on('data', (chunk: Buffer) => {
      if (ex.finished) return;
      ex.requestBytes += chunk.length;
      this.tunnel.bytesIn += chunk.length;
      if (ex.requestBytes > config.maxRequestBodyBytes) {
        this.failExchange(ex, downPages.tooLarge(config.maxRequestBodyBytes));
        return;
      }
      this.sendFrame(FrameKind.BODY, ex.id, chunk);
      ex.source.checkSocket(this.ws);
      if (ex.status === 0) armTimeout();
    });
    req.on('end', () => {
      if (!ex.finished) this.send({ type: 'request-end', id: ex.id });
    });
  }

  private forwardedHeaders(req: IncomingMessage, clientIp: string): HeaderMap {
    const { config } = this.deps;
    const headers = stripHopByHop(req.headers);
    const fromProxy = (name: string) => {
      const value = req.headers[name];
      return config.trustProxy && typeof value === 'string' ? value : undefined;
    };
    const publicUrl = new URL(config.publicUrl);
    headers['x-forwarded-proto'] = fromProxy('x-forwarded-proto') ?? publicUrl.protocol.slice(0, -1);
    headers['x-forwarded-host'] = req.headers.host ?? publicUrl.host;
    headers['x-forwarded-for'] = fromProxy('x-forwarded-for') ?? clientIp;
    return headers;
  }

  private failExchange(ex: HttpExchange, page: DownPage): void {
    if (ex.finished) return;
    ex.error = page.label;
    ex.status = page.status;
    this.abortRemote(ex);
    sendDownPage(ex.res, page, ex.id);
    this.finishExchange(ex);
  }

  private abortRemote(ex: HttpExchange): void {
    if (ex.remoteDone) return;
    ex.remoteDone = true;
    this.send({ type: 'request-abort', id: ex.id });
  }

  private finishExchange(ex: HttpExchange): void {
    if (ex.finished) return;
    ex.finished = true;
    if (ex.timer) clearTimeout(ex.timer);
    ex.source.dispose();
    this.exchanges.delete(ex.id);
    if (ex.error) this.abortRemote(ex);
    if (!ex.req.complete) ex.req.resume(); // drain anything left so the socket can be reused

    const durationMs = Date.now() - ex.startedAt;
    const status = ex.status || ex.res.statusCode;
    this.deps.logStore.add({
      id: ex.id,
      tunnelId: this.tunnel.id,
      method: ex.method,
      path: ex.path,
      status,
      error: ex.error,
      startedAt: ex.startedAt,
      durationMs,
      requestBytes: ex.requestBytes,
      responseBytes: ex.responseBytes,
      clientIp: ex.clientIp,
      requestHeaders: redactHeaders(ex.requestHeaders),
      responseHeaders: redactHeaders(ex.responseHeaders),
    });
    this.deps.logger.info(`${ex.method} ${ex.path} → ${status} ${durationMs}ms`, {
      id: ex.id,
      ...(ex.error ? { error: ex.error } : {}),
    });
  }

  // ── tunnel → public HTTP ──────────────────────────────────────────────────

  private handleMessage(raw: string): void {
    const msg = parseMessage<ClientMessage>(raw);
    if (!msg) return;

    switch (msg.type) {
      case 'response-start': {
        const ex = this.exchanges.get(msg.id);
        if (!ex || ex.res.headersSent) return;
        if (ex.timer) clearTimeout(ex.timer);
        ex.timer = null;
        ex.status = msg.status;
        ex.responseHeaders = stripHopByHop(msg.headers);
        try {
          ex.res.writeHead(msg.status, msg.statusMessage ?? undefined, ex.responseHeaders);
        } catch (err) {
          this.failExchange(ex, downPages.invalidResponse((err as Error).message));
        }
        return;
      }
      case 'response-end': {
        const ex = this.exchanges.get(msg.id);
        if (!ex) return;
        ex.remoteDone = true;
        ex.res.end();
        return;
      }
      case 'response-error': {
        const ex = this.exchanges.get(msg.id);
        if (!ex) return;
        ex.remoteDone = true;
        const port = this.tunnel.localPort;
        this.failExchange(ex, msg.code === 'LOCAL_UNAVAILABLE' ? downPages.localDown(port) : downPages.localError(port, msg.message));
        return;
      }
      case 'flow': {
        // The CLI's local request is backed up: pause reading the public request body.
        const ex = this.exchanges.get(msg.id);
        if (ex) msg.paused ? ex.source.pause('peer') : ex.source.resume('peer');
        return;
      }
      case 'shutdown':
        this.graceful = true;
        this.deps.logger.debug(`Tunnel shutdown requested: ${this.tunnel.id}`);
        return;
      case 'ws-accept':
        this.wsBridge.onAccept(msg);
        return;
      case 'ws-reject':
        this.wsBridge.onReject(msg);
        return;
      case 'ws-close':
        this.wsBridge.onRemoteClose(msg);
        return;
      default:
        return;
    }
  }

  private handleFrame(data: Buffer): void {
    const frame = decodeFrame(data);
    if (!frame) return;
    if (frame.kind !== FrameKind.BODY) {
      this.wsBridge.onFrame(frame);
      return;
    }
    const ex = this.exchanges.get(frame.id);
    if (!ex || ex.finished) return;
    ex.responseBytes += frame.payload.length;
    this.tunnel.bytesOut += frame.payload.length;
    const ok = ex.res.write(frame.payload);
    if (!ok && !ex.pausedRemote) {
      ex.pausedRemote = true;
      this.send({ type: 'flow', id: ex.id, paused: true });
      ex.res.once('drain', () => {
        ex.pausedRemote = false;
        if (!ex.finished) this.send({ type: 'flow', id: ex.id, paused: false });
      });
    }
  }

  // ── public WebSocket upgrades (isolated in WsBridge) ──────────────────────

  forwardUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.tunnel.requestCount++;
    this.wsBridge.open(req, socket, head);
  }

  private handleClose(code: number): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeatTimer);
    if (code === 1000) this.graceful = true;
    for (const ex of [...this.exchanges.values()]) {
      ex.remoteDone = true;
      this.failExchange(ex, downPages.disconnected());
    }
    this.wsBridge.closeAll();
    this.deps.onClose(this, this.graceful);
  }
}
