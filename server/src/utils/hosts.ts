import type { IncomingMessage } from 'node:http';
import type { ServerConfig } from '../config/index.js';

/** Lower-cased Host header without the port. */
export function getHostname(req: IncomingMessage): string {
  const host = (req.headers.host ?? '').toLowerCase();
  // IPv6 literal: [::1]:4000
  if (host.startsWith('[')) return host.slice(0, host.indexOf(']') + 1);
  return host.split(':')[0] ?? '';
}

export type HostKind = { kind: 'app' } | { kind: 'tunnel'; subdomain: string } | { kind: 'unknown' };

export function classifyHost(hostname: string, config: ServerConfig): HostKind {
  if (hostname === config.domain || config.appHosts.includes(hostname)) return { kind: 'app' };
  const suffix = '.' + config.domain;
  if (hostname.endsWith(suffix)) {
    const label = hostname.slice(0, -suffix.length);
    // Only single-level subdomains are tunnels.
    if (/^[a-z0-9-]{1,63}$/.test(label)) return { kind: 'tunnel', subdomain: label };
  }
  return { kind: 'unknown' };
}

export function getClientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? '';
}
