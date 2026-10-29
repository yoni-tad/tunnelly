import type { TunnelInfo, TunnelStatus } from '../types/index.js';
import type { TunnelConnection } from './TunnelConnection.js';

/**
 * A tunnel session. It outlives individual WebSocket connections: when the CLI
 * reconnects with the session token, the same Tunnel (and public URL) is reused.
 */
export class Tunnel {
  status: TunnelStatus = 'CONNECTING';
  connection: TunnelConnection | null = null;
  readonly createdAt = Date.now();
  connectedAt: number | null = null;
  disconnectedAt: number | null = null;
  lastHeartbeatAt: number | null = null;
  reconnects = 0;
  requestCount = 0;
  bytesIn = 0;
  bytesOut = 0;
  graceTimer: NodeJS.Timeout | null = null;

  constructor(
    readonly id: string,
    readonly publicUrl: string,
    /** Internal secret for resuming this session. Never exposed via the API or logs. */
    readonly sessionToken: string,
    public localPort: number,
    public clientVersion: string,
    public clientIp: string,
  ) {}

  info(): TunnelInfo {
    return {
      id: this.id,
      publicUrl: this.publicUrl,
      status: this.status,
      localPort: this.localPort,
      clientVersion: this.clientVersion,
      clientIp: this.clientIp,
      createdAt: this.createdAt,
      connectedAt: this.connectedAt,
      disconnectedAt: this.disconnectedAt,
      lastHeartbeatAt: this.lastHeartbeatAt,
      reconnects: this.reconnects,
      requestCount: this.requestCount,
      bytesIn: this.bytesIn,
      bytesOut: this.bytesOut,
      activeRequests: this.connection?.activeRequests ?? 0,
    };
  }
}
