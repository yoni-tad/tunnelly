import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { startServer, type TunnellyServer } from '../server/src/tunnellyServer.js';
import type { ServerConfig } from '../server/src/config/index.js';
import { createLogger } from '../server/src/utils/logger.js';
import { TunnelClient, type ConnectedEvent, type TunnelClientOptions } from '../cli/src/tunnel/TunnelClient.js';

export const DOMAIN = 'tunnelly.test';

export async function startTestServer(overrides: Partial<ServerConfig> = {}): Promise<TunnellyServer> {
  return startServer(
    {
      port: 0,
      host: '127.0.0.1',
      nodeEnv: 'test',
      domain: DOMAIN,
      appHosts: ['localhost', '127.0.0.1'],
      publicProtocol: 'http',
      publicPort: '',
      trustProxy: false,
      dashboardPassword: '',
      connectToken: '',
      requestTimeoutMs: 5_000,
      heartbeatIntervalMs: 1_000,
      heartbeatTimeoutMs: 5_000,
      resumeGraceMs: 5_000,
      ...overrides,
    },
    { logger: createLogger({ silent: true }) },
  );
}

export async function startLocalApp(handler: http.RequestListener): Promise<{ server: http.Server; port: number; close(): Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    port,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export function createClient(server: TunnellyServer, localPort: number, extra: Partial<TunnelClientOptions> = {}): TunnelClient {
  return new TunnelClient({
    serverUrl: `http://127.0.0.1:${server.port}`,
    localHost: '127.0.0.1',
    localPort,
    clientVersion: 'test',
    backoff: { baseMs: 50, maxMs: 200, jitter: 0 },
    ...extra,
  });
}

export function waitForEvent<T = unknown>(emitter: NodeJS.EventEmitter, event: string, timeoutMs = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for "${event}"`)), timeoutMs);
    emitter.once(event, (value: T) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

export async function connectClient(client: TunnelClient): Promise<ConnectedEvent> {
  const connected = waitForEvent<ConnectedEvent>(client, 'connected');
  client.start();
  return connected;
}

export async function waitFor(predicate: () => boolean, timeoutMs = 5000, label = 'condition'): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

export interface TestResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

/** Send a request to the Tunnelly server as if it came to `host` (e.g. abc.tunnelly.test). */
export function request(
  port: number,
  opts: { host: string; method?: string; path?: string; headers?: http.OutgoingHttpHeaders; body?: Buffer | string },
): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: opts.method ?? 'GET',
        path: opts.path ?? '/',
        headers: {
          host: opts.host,
          ...(opts.body !== undefined ? { 'content-length': Buffer.byteLength(opts.body) } : {}),
          ...opts.headers,
        },
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(opts.body);
  });
}

export const hostOf = (publicUrl: string) => new URL(publicUrl).host;
