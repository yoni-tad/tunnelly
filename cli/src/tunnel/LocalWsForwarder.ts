import { WebSocket } from 'ws';
import { safeCloseCode, type WsCloseMessage, type WsOpenMessage } from '../../../shared/protocol.js';
import { FrameKind, toBuffer, type Frame } from '../../../shared/frames.js';
import type { ForwarderIO } from './LocalForwarder.js';

/**
 * Forwards public WebSocket connections (e.g. HMR) to the local app.
 * Isolated from HTTP forwarding so a WebSocket problem can't affect it.
 */
export class LocalWsForwarder {
  private sockets = new Map<string, WebSocket>();

  constructor(private readonly io: ForwarderIO) {}

  onOpen(msg: WsOpenMessage): void {
    const { host, port } = this.io;
    const address = this.io.address();
    const headers = { ...msg.headers, host: `${host}:${port}` } as Record<string, string>;
    const target = address.includes(':') ? `[${address}]` : address; // IPv6 literal
    const ws = new WebSocket(`ws://${target}:${port}${msg.path}`, msg.protocols, {
      headers,
      perMessageDeflate: false,
      handshakeTimeout: 10_000,
    });
    this.sockets.set(msg.id, ws);
    const startedAt = Date.now();
    let opened = false;
    let rejected = false;

    const reject = (message: string) => {
      if (opened || rejected) return;
      rejected = true;
      this.sockets.delete(msg.id);
      this.io.send({ type: 'ws-reject', id: msg.id, status: 502, message });
      this.io.onLog({ id: msg.id, method: 'WS', path: msg.path, status: 502, durationMs: Date.now() - startedAt, responseBytes: 0, error: message });
    };

    ws.on('open', () => {
      opened = true;
      this.io.send({ type: 'ws-accept', id: msg.id, protocol: ws.protocol || undefined });
      this.io.onLog({ id: msg.id, method: 'WS', path: msg.path, status: 101, durationMs: Date.now() - startedAt, responseBytes: 0 });
    });
    ws.on('message', (data, isBinary) => {
      this.io.sendFrame(isBinary ? FrameKind.WS_BINARY : FrameKind.WS_TEXT, msg.id, toBuffer(data));
    });
    ws.on('error', (err) => reject(`Local WebSocket failed: ${err.message}`));
    ws.on('close', (code, reason) => {
      if (!opened) return reject('Local WebSocket closed before opening');
      if (this.sockets.get(msg.id) !== ws) return;
      this.sockets.delete(msg.id);
      this.io.send({ type: 'ws-close', id: msg.id, code: safeCloseCode(code), reason: reason.toString() });
    });
  }

  onFrame(frame: Frame): void {
    const ws = this.sockets.get(frame.id);
    if (ws?.readyState === WebSocket.OPEN) ws.send(frame.payload, { binary: frame.kind === FrameKind.WS_BINARY });
  }

  onClose(msg: WsCloseMessage): void {
    const ws = this.sockets.get(msg.id);
    if (!ws) return;
    this.sockets.delete(msg.id);
    if (ws.readyState === WebSocket.OPEN) ws.close(safeCloseCode(msg.code), msg.reason ?? '');
    else ws.terminate();
  }

  closeAll(): void {
    for (const ws of this.sockets.values()) ws.terminate();
    this.sockets.clear();
  }
}
