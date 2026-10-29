/**
 * Tunnelly wire protocol, shared by the server and the CLI.
 *
 * One WebSocket per tunnel carries everything:
 *   - JSON text frames for control messages (below)
 *   - binary frames for body chunks / WebSocket payloads (see frames.ts)
 *
 * Every forwarded exchange is identified by a request ID (`req_xxxxxxxxxxxx`)
 * so both sides can correlate request → local request → response.
 */

export const PROTOCOL_VERSION = 1;

/** Path on the app host where the CLI opens its control WebSocket. */
export const CONNECT_PATH = '/_tunnelly/connect';

export type HeaderMap = Record<string, string | string[]>;

/** Errors the server may send before closing the control connection. */
export type TunnelErrorCode =
  | 'TUNNEL_ACTIVE' // another tunnel already owns the server (fatal for the CLI)
  | 'UNAUTHORIZED' // connect token missing or wrong (fatal)
  | 'UNSUPPORTED_VERSION' // protocol mismatch (fatal)
  | 'REPLACED' // this session was resumed by another connection (fatal)
  | 'BAD_HELLO' // malformed handshake
  | 'HELLO_TIMEOUT'; // no handshake received in time

export const FATAL_ERROR_CODES: ReadonlySet<TunnelErrorCode> = new Set([
  'TUNNEL_ACTIVE',
  'UNAUTHORIZED',
  'UNSUPPORTED_VERSION',
  'REPLACED',
]);

// ── CLI → server ────────────────────────────────────────────────────────────

export interface HelloMessage {
  type: 'hello';
  version: number;
  clientVersion: string;
  localPort: number;
  /** Optional shared connect token (only if the server sets TUNNEL_CONNECT_TOKEN). */
  token?: string;
  /** Present when reconnecting: lets the server hand back the same tunnel/URL. */
  resume?: { tunnelId: string; sessionToken: string };
}

export interface ShutdownMessage {
  type: 'shutdown';
}

export interface ResponseStartMessage {
  type: 'response-start';
  id: string;
  status: number;
  statusMessage?: string;
  headers: HeaderMap;
}

export interface ResponseEndMessage {
  type: 'response-end';
  id: string;
}

export interface ResponseErrorMessage {
  type: 'response-error';
  id: string;
  code: 'LOCAL_UNAVAILABLE' | 'LOCAL_ERROR';
  message: string;
}

export interface WsAcceptMessage {
  type: 'ws-accept';
  id: string;
  protocol?: string;
}

export interface WsRejectMessage {
  type: 'ws-reject';
  id: string;
  status: number;
  message: string;
}

// ── server → CLI ────────────────────────────────────────────────────────────

export interface ReadyMessage {
  type: 'ready';
  tunnelId: string;
  publicUrl: string;
  /** Secret used only to resume this tunnel after a reconnect. Never logged. */
  sessionToken: string;
  resumed: boolean;
}

export interface ErrorMessage {
  type: 'error';
  code: TunnelErrorCode;
  message: string;
  publicUrl?: string;
}

export interface RequestStartMessage {
  type: 'request-start';
  id: string;
  method: string;
  /** Path + query string, e.g. `/users?page=2`. */
  path: string;
  headers: HeaderMap;
}

export interface RequestEndMessage {
  type: 'request-end';
  id: string;
}

export interface RequestAbortMessage {
  type: 'request-abort';
  id: string;
}

export interface WsOpenMessage {
  type: 'ws-open';
  id: string;
  path: string;
  headers: HeaderMap;
  protocols: string[];
}

// ── both directions ─────────────────────────────────────────────────────────

/** Backpressure: ask the peer to pause/resume sending body chunks for `id`. */
export interface FlowMessage {
  type: 'flow';
  id: string;
  paused: boolean;
}

export interface WsCloseMessage {
  type: 'ws-close';
  id: string;
  code?: number;
  reason?: string;
}

export type ClientMessage =
  | HelloMessage
  | ShutdownMessage
  | ResponseStartMessage
  | ResponseEndMessage
  | ResponseErrorMessage
  | WsAcceptMessage
  | WsRejectMessage
  | FlowMessage
  | WsCloseMessage;

export type ServerMessage =
  | ReadyMessage
  | ErrorMessage
  | RequestStartMessage
  | RequestEndMessage
  | RequestAbortMessage
  | WsOpenMessage
  | FlowMessage
  | WsCloseMessage;

export function parseMessage<T extends { type: string }>(data: string): T | null {
  try {
    const value = JSON.parse(data) as unknown;
    if (value && typeof value === 'object' && typeof (value as { type?: unknown }).type === 'string') {
      return value as T;
    }
  } catch {
    // fall through
  }
  return null;
}

/** Close codes used on the control connection. */
export const CloseCode = {
  NORMAL: 1000,
  SERVER_RESTART: 1012,
  REJECTED: 4000,
} as const;

const VALID_WS_CLOSE = new Set([1000, 1001, 1002, 1003, 1007, 1008, 1009, 1010, 1011, 1012, 1013, 1014]);

/** Close codes like 1005/1006 are reported locally but may not be sent; map them to 1000. */
export function safeCloseCode(code?: number): number {
  return code !== undefined && (VALID_WS_CLOSE.has(code) || (code >= 3000 && code <= 4999)) ? code : 1000;
}
