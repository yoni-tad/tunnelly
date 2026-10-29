import http, { type ClientRequest, type IncomingMessage } from 'node:http';
import type { ClientMessage, HeaderMap, RequestStartMessage } from '../../../shared/protocol.js';
import { FrameKind } from '../../../shared/frames.js';
import { PausableSource } from '../../../shared/flow.js';
import { stripHopByHop } from '../../../shared/headers.js';

export interface RequestLog {
  id: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  responseBytes: number;
  error?: string;
}

export interface ForwarderIO {
  host: string;
  port: number;
  send(message: ClientMessage): void;
  sendFrame(kind: FrameKind, id: string, payload: Buffer): void;
  /** The current tunnel socket, used for send-buffer backpressure. */
  socket(): { bufferedAmount: number; readyState: number } | null;
  onLog(log: RequestLog): void;
}

interface Exchange {
  id: string;
  method: string;
  path: string;
  startedAt: number;
  localReq: ClientRequest;
  source: PausableSource | null;
  status: number;
  responseBytes: number;
  pausedRemote: boolean;
  done: boolean;
}

const UNAVAILABLE_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENOTFOUND', 'ETIMEDOUT', 'EAI_AGAIN']);

/** Replays tunneled HTTP requests against the local app and streams responses back. */
export class LocalForwarder {
  private exchanges = new Map<string, Exchange>();
  private agent = new http.Agent({ keepAlive: true, maxSockets: 64 });

  constructor(private readonly io: ForwarderIO) {}

  get activeCount(): number {
    return this.exchanges.size;
  }

  onRequestStart(msg: RequestStartMessage): void {
    const { host, port } = this.io;
    const headers: HeaderMap = { ...msg.headers };
    // Most dev servers (Vite, webpack, Next) only accept their own Host header.
    // The public hostname is still available as X-Forwarded-Host.
    headers.host = `${host}:${port}`;
    delete headers.expect;

    const localReq = http.request({ host, port, method: msg.method, path: msg.path, headers, agent: this.agent });
    const ex: Exchange = {
      id: msg.id,
      method: msg.method,
      path: msg.path,
      startedAt: Date.now(),
      localReq,
      source: null,
      status: 0,
      responseBytes: 0,
      pausedRemote: false,
      done: false,
    };
    this.exchanges.set(ex.id, ex);

    localReq.on('response', (res) => this.handleResponse(ex, res));
    localReq.on('error', (err: NodeJS.ErrnoException) => {
      if (ex.done) return;
      const unavailable = !ex.status && UNAVAILABLE_CODES.has(err.code ?? '');
      this.io.send({
        type: 'response-error',
        id: ex.id,
        code: unavailable ? 'LOCAL_UNAVAILABLE' : 'LOCAL_ERROR',
        message: unavailable
          ? `Cannot connect to ${host}:${port}. Make sure your local application is running.`
          : `Error talking to ${host}:${port}: ${err.message}`,
      });
      this.finish(ex, unavailable ? `${host}:${port} unreachable` : err.message);
    });
  }

  private handleResponse(ex: Exchange, res: IncomingMessage): void {
    if (ex.done) {
      res.destroy();
      return;
    }
    ex.status = res.statusCode ?? 502;
    this.io.send({
      type: 'response-start',
      id: ex.id,
      status: ex.status,
      statusMessage: res.statusMessage,
      headers: stripHopByHop(res.headers),
    });

    const source = new PausableSource(res);
    ex.source = source;
    res.on('data', (chunk: Buffer) => {
      if (ex.done) return;
      ex.responseBytes += chunk.length;
      this.io.sendFrame(FrameKind.BODY, ex.id, chunk);
      const socket = this.io.socket();
      if (socket) source.checkSocket(socket);
    });
    res.on('end', () => {
      if (ex.done) return;
      this.io.send({ type: 'response-end', id: ex.id });
      this.finish(ex);
    });
    res.on('error', (err) => {
      if (ex.done) return;
      this.io.send({ type: 'response-error', id: ex.id, code: 'LOCAL_ERROR', message: err.message });
      this.finish(ex, err.message);
    });
  }

  onBody(id: string, chunk: Buffer): void {
    const ex = this.exchanges.get(id);
    if (!ex || ex.done) return;
    const ok = ex.localReq.write(chunk);
    if (!ok && !ex.pausedRemote) {
      // Local app is reading slower than the public client uploads: ask the server to pause.
      ex.pausedRemote = true;
      this.io.send({ type: 'flow', id, paused: true });
      ex.localReq.once('drain', () => {
        ex.pausedRemote = false;
        if (!ex.done) this.io.send({ type: 'flow', id, paused: false });
      });
    }
  }

  onRequestEnd(id: string): void {
    this.exchanges.get(id)?.localReq.end();
  }

  onAbort(id: string): void {
    const ex = this.exchanges.get(id);
    if (!ex) return;
    this.finish(ex, 'Client closed connection');
    ex.localReq.destroy();
  }

  onFlow(id: string, paused: boolean): void {
    const source = this.exchanges.get(id)?.source;
    if (!source) return;
    if (paused) source.pause('peer');
    else source.resume('peer');
  }

  /** The tunnel dropped: abandon every in-flight local request. */
  abortAll(): void {
    for (const ex of [...this.exchanges.values()]) {
      this.finish(ex, 'Tunnel disconnected');
      ex.localReq.destroy();
    }
  }

  close(): void {
    this.abortAll();
    this.agent.destroy();
  }

  private finish(ex: Exchange, error?: string): void {
    if (ex.done) return;
    ex.done = true;
    ex.source?.dispose();
    this.exchanges.delete(ex.id);
    this.io.onLog({
      id: ex.id,
      method: ex.method,
      path: ex.path,
      status: ex.status || 503,
      durationMs: Date.now() - ex.startedAt,
      responseBytes: ex.responseBytes,
      error,
    });
  }
}
