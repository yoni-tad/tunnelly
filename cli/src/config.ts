import { CONNECT_PATH } from '../../shared/protocol.js';

// Replaced at build time by build.mjs; undefined when running from source via tsx.
declare const __TUNNELLY_VERSION__: string | undefined;

export const VERSION = typeof __TUNNELLY_VERSION__ !== 'undefined' ? __TUNNELLY_VERSION__ : '1.0.0-dev';

/** Your Tunnelly server. Change this one line if you move it. */
export const DEFAULT_SERVER_URL = 'https://tunnelly.yoni-tad.com';

/** --server flag  →  TUNNELLY_SERVER env  →  DEFAULT_SERVER_URL. */
export function resolveServerUrl(flag: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  return flag || env.TUNNELLY_SERVER || DEFAULT_SERVER_URL;
}

/** https://example.com → wss://example.com/_tunnelly/connect */
export function toWebSocketUrl(serverUrl: string): string {
  const url = new URL(serverUrl);
  if (url.protocol === 'https:') url.protocol = 'wss:';
  else if (url.protocol === 'http:') url.protocol = 'ws:';
  else if (url.protocol !== 'ws:' && url.protocol !== 'wss:') throw new Error(`Unsupported server URL: ${serverUrl}`);
  url.pathname = CONNECT_PATH;
  url.search = '';
  return url.toString();
}
