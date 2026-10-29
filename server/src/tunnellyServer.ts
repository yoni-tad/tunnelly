import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { loadConfig, type ServerConfig } from './config/index.js';
import { createApp } from './app.js';
import { MemoryRequestLogStore, type RequestLogStore } from './services/requestLog.js';
import { TunnelManager } from './tunnel/TunnelManager.js';
import { createControlServer } from './websocket/controlServer.js';
import { classifyHost, getHostname } from './utils/hosts.js';
import { sendErrorPage } from './utils/pages.js';
import { createLogger, type Logger } from './utils/logger.js';
import { CONNECT_PATH } from '../../shared/protocol.js';

export interface TunnellyServer {
  config: ServerConfig;
  manager: TunnelManager;
  logStore: RequestLogStore;
  logger: Logger;
  http: http.Server;
  port: number;
  close(): Promise<void>;
}

/**
 * Wires everything together. All traffic arrives on one port; the Host header
 * decides where it goes:
 *
 *   DOMAIN (and APP_HOSTS)   → Express: dashboard, API, CLI WebSocket endpoint
 *   <subdomain>.DOMAIN       → the tunnel (raw Node handler — no Express middleware)
 */
export async function startServer(
  overrides: Partial<ServerConfig> = {},
  opts: { logger?: Logger } = {},
): Promise<TunnellyServer> {
  const config = loadConfig(overrides);
  const logger = opts.logger ?? createLogger({ level: config.logLevel, format: config.logFormat });
  const logStore = new MemoryRequestLogStore(config.requestLogLimit);
  const manager = new TunnelManager({ config, logger, logStore });
  const startedAt = Date.now();
  const app = createApp({ config, manager, logStore, startedAt });
  const controlWss = createControlServer({ config, logger, manager });

  const server = http.createServer((req, res) => {
    const host = classifyHost(getHostname(req), config);
    if (host.kind === 'app') {
      app(req, res);
      return;
    }
    if (host.kind === 'tunnel') {
      const tunnel = manager.findBySubdomain(host.subdomain);
      if (!tunnel) {
        sendErrorPage(res, 404, 'Tunnel not found', `There is no active tunnel at ${req.headers.host}. It may have been stopped.`);
      } else if (!tunnel.connection) {
        sendErrorPage(res, 502, 'Tunnel offline', 'The Tunnelly CLI for this URL is reconnecting. Try again in a few seconds.');
      } else {
        tunnel.connection.forwardHttp(req, res);
      }
      return;
    }
    sendErrorPage(res, 404, 'Unknown host', `${req.headers.host ?? '(none)'} is not served by this Tunnelly server.`);
  });

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    const host = classifyHost(getHostname(req), config);
    const pathname = (req.url ?? '/').split('?')[0];

    if (host.kind === 'app' && pathname === CONNECT_PATH) {
      controlWss.handleUpgrade(req, socket, head, (ws) => controlWss.emit('connection', ws, req));
      return;
    }
    if (host.kind === 'tunnel') {
      const conn = manager.findBySubdomain(host.subdomain)?.connection;
      if (conn) {
        conn.forwardUpgrade(req, socket, head);
        return;
      }
    }
    socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });

  // Requests are bounded by REQUEST_TIMEOUT_MS ourselves; streamed bodies may be slow.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 65_000;

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => resolve());
  });
  const port = (server.address() as AddressInfo).port;

  return {
    config,
    manager,
    logStore,
    logger,
    http: server,
    port,
    close: async () => {
      manager.shutdown();
      for (const ws of controlWss.clients) ws.terminate();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
