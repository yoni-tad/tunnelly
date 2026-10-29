import type { HeaderMap } from '../../../shared/protocol.js';

export type TunnelStatus = 'CONNECTING' | 'CONNECTED' | 'DISCONNECTED';

/** Public (dashboard-safe) view of a tunnel. Never includes the session token. */
export interface TunnelInfo {
  id: string;
  hostname: string;
  publicUrl: string;
  status: TunnelStatus;
  localPort: number;
  clientVersion: string;
  clientIp: string;
  createdAt: number;
  connectedAt: number | null;
  disconnectedAt: number | null;
  lastHeartbeatAt: number | null;
  reconnects: number;
  requestCount: number;
  bytesIn: number;
  bytesOut: number;
  activeRequests: number;
}

export interface RequestLogEntry {
  id: string;
  tunnelId: string;
  method: string;
  path: string;
  status: number;
  /** Set when the request failed inside the tunnel (timeout, local app down, ...). */
  error?: string;
  startedAt: number;
  durationMs: number;
  requestBytes: number;
  responseBytes: number;
  clientIp: string;
  requestHeaders: HeaderMap;
  responseHeaders: HeaderMap;
}
