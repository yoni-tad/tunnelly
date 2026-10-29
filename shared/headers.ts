import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http';
import type { HeaderMap } from './protocol.js';

/** Hop-by-hop headers (RFC 7230 §6.1) — meaningful only for a single connection. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/**
 * Copy headers, dropping hop-by-hop headers and anything the `Connection`
 * header nominates as hop-by-hop. Everything else (cookies, content-type,
 * content-length, content-encoding, cache headers, ...) is preserved.
 */
export function stripHopByHop(headers: IncomingHttpHeaders | OutgoingHttpHeaders | HeaderMap): HeaderMap {
  const nominated = new Set<string>();
  const connection = headers['connection'];
  if (typeof connection === 'string') {
    for (const token of connection.split(',')) nominated.add(token.trim().toLowerCase());
  }

  const result: HeaderMap = {};
  for (const [rawName, value] of Object.entries(headers)) {
    if (value === undefined || value === null) continue;
    const name = rawName.toLowerCase();
    if (HOP_BY_HOP.has(name) || nominated.has(name)) continue;
    result[name] = Array.isArray(value) ? value.map(String) : String(value);
  }
  return result;
}

/** Headers whose values are replaced by `[redacted]` in stored logs. */
const SENSITIVE = new Set(['authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-api-key']);

export function redactHeaders(headers: HeaderMap): HeaderMap {
  const result: HeaderMap = {};
  for (const [name, value] of Object.entries(headers)) {
    result[name] = SENSITIVE.has(name) ? '[redacted]' : value;
  }
  return result;
}
