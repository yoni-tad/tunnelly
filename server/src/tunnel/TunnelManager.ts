import type { WebSocket } from 'ws';
import type { ServerConfig } from '../config/index.js';
import type { RequestLogStore } from '../services/requestLog.js';
import type { Logger } from '../utils/logger.js';
import type { TunnelInfo } from '../types/index.js';
import { CloseCode, type ErrorMessage, type HelloMessage, type TunnelErrorCode } from '../../../shared/protocol.js';
import { newSessionToken, newTunnelId } from '../utils/ids.js';
import { safeEqual } from '../utils/secure.js';
import { Tunnel } from './Tunnel.js';
import { TunnelConnection } from './TunnelConnection.js';

export interface ManagerDeps {
  config: ServerConfig;
  logger: Logger;
  logStore: RequestLogStore;
}

export function rejectConnection(ws: WebSocket, code: TunnelErrorCode, message: string, publicUrl?: string): void {
  const msg: ErrorMessage = { type: 'error', code, message, ...(publicUrl ? { publicUrl } : {}) };
  ws.send(JSON.stringify(msg));
  ws.close(CloseCode.REJECTED, code);
}

/**
 * Owns tunnel sessions. V1 policy: exactly one tunnel at a time, served at
 * PUBLIC_URL.
 *
 * (Multiple tunnels later = give each tunnel its own hostname, turn `active`
 * into a Map keyed by hostname, and make TUNNEL_ACTIVE a per-account limit.)
 */
export class TunnelManager {
  private active: Tunnel | null = null;
  /** Most recent released tunnel, so the dashboard can show "Disconnected". */
  private last: Tunnel | null = null;
  private shuttingDown = false;

  constructor(private readonly deps: ManagerDeps) {}

  register(ws: WebSocket, hello: HelloMessage, clientIp: string): void {
    const { logger } = this.deps;
    const existing = this.active;

    // Reconnect from the same CLI: hand back the same tunnel and URL. A stale
    // half-open socket from before the network drop is simply replaced.
    if (
      hello.resume &&
      existing &&
      existing.id === hello.resume.tunnelId &&
      safeEqual(existing.sessionToken, hello.resume.sessionToken)
    ) {
      const stale = existing.connection;
      existing.connection = null;
      stale?.terminate();
      existing.clientIp = clientIp;
      existing.reconnects++;
      this.attach(existing, ws, true);
      return;
    }

    if (existing && existing.status !== 'DISCONNECTED') {
      logger.warn('Rejected tunnel: another tunnel is already active', { active: existing.id, clientIp });
      rejectConnection(ws, 'TUNNEL_ACTIVE', 'A tunnel is already active.', existing.publicUrl);
      return;
    }
    // The previous tunnel dropped and never resumed — it no longer blocks new ones.
    if (existing) this.release(existing, 'superseded by a new tunnel');

    const tunnel = new Tunnel(
      newTunnelId(),
      this.deps.config.publicUrl,
      newSessionToken(),
      hello.localPort,
      hello.clientVersion,
      clientIp,
    );
    this.active = tunnel;
    this.attach(tunnel, ws, false);
  }

  private attach(tunnel: Tunnel, ws: WebSocket, resumed: boolean): void {
    if (tunnel.graceTimer) clearTimeout(tunnel.graceTimer);
    tunnel.graceTimer = null;

    const conn = new TunnelConnection(ws, tunnel, {
      ...this.deps,
      onClose: (c, graceful) => this.onConnectionClosed(c, graceful),
    });
    tunnel.connection = conn;
    tunnel.status = 'CONNECTED';
    tunnel.connectedAt ??= Date.now();
    tunnel.disconnectedAt = null;
    tunnel.lastHeartbeatAt = Date.now();

    conn.send({
      type: 'ready',
      tunnelId: tunnel.id,
      publicUrl: tunnel.publicUrl,
      sessionToken: tunnel.sessionToken,
      resumed,
    });
    this.deps.logger.info(`Tunnel ${resumed ? 'resumed' : 'connected'}: ${tunnel.id}`, {
      localPort: tunnel.localPort,
      clientIp: tunnel.clientIp,
    });
    this.deps.logger.info(`Public URL: ${tunnel.publicUrl}`);
  }

  private onConnectionClosed(conn: TunnelConnection, graceful: boolean): void {
    const tunnel = conn.tunnel;
    if (tunnel.connection !== conn) return; // already replaced by a resumed connection
    tunnel.connection = null;
    if (this.active !== tunnel) return;

    if (graceful || this.shuttingDown) {
      this.release(tunnel, 'closed by client');
      return;
    }

    // Unexpected drop: mark disconnected now, but keep the URL reserved briefly
    // so the CLI can resume it after a network blip.
    tunnel.status = 'DISCONNECTED';
    tunnel.disconnectedAt = Date.now();
    const grace = this.deps.config.resumeGraceMs;
    this.deps.logger.warn(`Tunnel connection lost: ${tunnel.id}`, { reservedForSeconds: Math.round(grace / 1000) });
    tunnel.graceTimer = setTimeout(() => this.release(tunnel, 'did not reconnect in time'), grace);
    tunnel.graceTimer.unref();
  }

  private release(tunnel: Tunnel, reason: string): void {
    if (tunnel.graceTimer) clearTimeout(tunnel.graceTimer);
    tunnel.graceTimer = null;
    if (this.active === tunnel) this.active = null;
    this.last = tunnel;
    tunnel.status = 'DISCONNECTED';
    tunnel.disconnectedAt ??= Date.now();
    tunnel.connection?.close(CloseCode.NORMAL, 'released');
    this.deps.logger.info(`Tunnel disconnected: ${tunnel.id}`, { reason });
  }

  /** The tunnel serving the public URL, if any (connected or reconnecting). */
  get current(): Tunnel | null {
    return this.active;
  }

  /** Dashboard view: the active tunnel, or the most recent one. */
  currentInfo(): TunnelInfo | null {
    return (this.active ?? this.last)?.info() ?? null;
  }

  shutdown(): void {
    this.shuttingDown = true;
    const tunnel = this.active;
    if (!tunnel) return;
    tunnel.connection?.close(CloseCode.SERVER_RESTART, 'Server restarting');
    this.release(tunnel, 'server shutting down');
  }
}
