import type { IncomingMessage } from 'node:http';
import { STATUS_CODES } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { safeCloseCode, type WsAcceptMessage, type WsCloseMessage, type WsRejectMessage } from '../../../shared/protocol.js';
import { FrameKind, toBuffer, type Frame } from '../../../shared/frames.js';
import { redactHeaders, stripHopByHop } from '../../../shared/headers.js';
import { newRequestId } from '../utils/ids.js';
import { getClientIp } from '../utils/hosts.js';
import type { ConnectionDeps, TunnelConnection } from './TunnelConnection.js';

/**
 * Forwards public WebSocket upgrades (e.g. Vite/Next.js HMR) through the tunnel.
 *
 * Kept separate from HTTP forwarding on purpose: if anything here misbehaves
 * the HTTP path is unaffected. Flow: public upgrade → `ws-open` to the CLI →
 * CLI connects to the local app → `ws-accept` → we complete the upgrade.
 */

const PROTOCOL_KEY = Symbol('tunnellyProtocol');
type UpgradeRequest = IncomingMessage & { [PROTOCOL_KEY]?: string };

const ACCEPT_TIMEOUT_MS = 10_000;

const publicWss = new WebSocketServer({
  noServer: true,
  maxPayload: 64 * 1024 * 1024,
  // Echo back whichever subprotocol the local app picked.
  handleProtocols: (_protocols, req) => (req as UpgradeRequest)[PROTOCOL_KEY] ?? false,
});

interface Pending {
  req: UpgradeRequest;
  socket: Duplex;
  head: Buffer;
  timer: NodeJS.Timeout;
  startedAt: number;
}

interface Open {
  ws: WebSocket;
  req: IncomingMessage;
  startedAt: number;
  bytesIn: number;
  bytesOut: number;
}

function rejectSocket(socket: Duplex, status: number, message: string): void {
  if (socket.destroyed) return;
  const body = `${message}\n`;
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? 'Error'}\r\n` +
      'Connection: close\r\nContent-Type: text/plain; charset=utf-8\r\n' +
      `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
}

export class WsBridge {
  private pending = new Map<string, Pending>();
  private sockets = new Map<string, Open>();

  constructor(
    private readonly conn: TunnelConnection,
    private readonly deps: Pick<ConnectionDeps, 'logger' | 'logStore' | 'config'>,
  ) {}

  open(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const id = newRequestId();
    const headers = stripHopByHop(req.headers);
    for (const name of Object.keys(headers)) if (name.startsWith('sec-websocket-')) delete headers[name];
    const protocols = String(req.headers['sec-websocket-protocol'] ?? '')
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);

    const timer = setTimeout(() => {
      this.pending.delete(id);
      rejectSocket(socket, 504, 'Local application did not accept the WebSocket in time');
    }, ACCEPT_TIMEOUT_MS);
    this.pending.set(id, { req, socket, head, timer, startedAt: Date.now() });
    socket.on('error', () => {});
    socket.once('close', () => {
      const p = this.pending.get(id);
      if (p && p.socket === socket) {
        clearTimeout(p.timer);
        this.pending.delete(id);
        this.conn.send({ type: 'ws-close', id });
      }
    });

    this.conn.send({ type: 'ws-open', id, path: req.url ?? '/', headers, protocols });
  }

  onAccept(msg: WsAcceptMessage): void {
    const p = this.pending.get(msg.id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(msg.id);
    if (msg.protocol) p.req[PROTOCOL_KEY] = msg.protocol;

    publicWss.handleUpgrade(p.req, p.socket, p.head, (ws) => {
      const entry: Open = { ws, req: p.req, startedAt: p.startedAt, bytesIn: 0, bytesOut: 0 };
      this.sockets.set(msg.id, entry);
      this.deps.logger.info(`WS ${p.req.url} → 101`, { id: msg.id });

      ws.on('message', (data, isBinary) => {
        const payload = toBuffer(data);
        entry.bytesIn += payload.length;
        this.conn.tunnel.bytesIn += payload.length;
        this.conn.sendFrame(isBinary ? FrameKind.WS_BINARY : FrameKind.WS_TEXT, msg.id, payload);
      });
      ws.on('close', (code, reason) => {
        if (this.sockets.get(msg.id) !== entry) return;
        this.sockets.delete(msg.id);
        this.conn.send({ type: 'ws-close', id: msg.id, code: safeCloseCode(code), reason: reason.toString() });
        this.log(msg.id, entry);
      });
      ws.on('error', () => {});
    });
  }

  onReject(msg: WsRejectMessage): void {
    const p = this.pending.get(msg.id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(msg.id);
    rejectSocket(p.socket, msg.status || 502, msg.message);
  }

  onFrame(frame: Frame): void {
    const entry = this.sockets.get(frame.id);
    if (!entry || entry.ws.readyState !== WebSocket.OPEN) return;
    entry.bytesOut += frame.payload.length;
    this.conn.tunnel.bytesOut += frame.payload.length;
    entry.ws.send(frame.payload, { binary: frame.kind === FrameKind.WS_BINARY });
  }

  onRemoteClose(msg: WsCloseMessage): void {
    const entry = this.sockets.get(msg.id);
    if (!entry) return;
    this.sockets.delete(msg.id);
    entry.ws.close(safeCloseCode(msg.code), msg.reason ?? '');
    this.log(msg.id, entry);
  }

  closeAll(): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      rejectSocket(p.socket, 502, 'Tunnel disconnected');
      this.pending.delete(id);
    }
    for (const [id, entry] of this.sockets) {
      this.sockets.delete(id);
      entry.ws.close(1001, 'Tunnel disconnected');
      this.log(id, entry);
    }
  }

  private log(id: string, entry: Open): void {
    this.deps.logStore.add({
      id,
      tunnelId: this.conn.tunnel.id,
      method: 'WS',
      path: entry.req.url ?? '/',
      status: 101,
      startedAt: entry.startedAt,
      durationMs: Date.now() - entry.startedAt,
      requestBytes: entry.bytesIn,
      responseBytes: entry.bytesOut,
      clientIp: getClientIp(entry.req, this.deps.config.trustProxy),
      requestHeaders: redactHeaders(stripHopByHop(entry.req.headers)),
      responseHeaders: {},
    });
  }
}
