import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { loadConfig, type ServerConfig } from './config/index.js';
import { createApp } from './app.js';
import { MemoryRequestLogStore, type RequestLogStore } from './services/requestLog.js';
import { TunnelManager } from './tunnel/TunnelManager.js';
import { createControlServer } from './websocket/controlServer.js';
import { downPages, sendDownPage } from './utils/pages.js';
import { createLogger, type Logger } from './utils/logger.js';
import { APP_PREFIX, CONNECT_PATH } from '../../shared/protocol.js';

export interface TunnellyServer {
  config: ServerConfig;
  manager: TunnelManager;
  logStore: RequestLogStore;
  logger: Logger;
  http: http.Server;
  port: number;
  close(): Promise<void>;
}

const pathOf = (url: string | undefined) => (url ?? '/').split('?')[0]!;
const isAppPath = (url: string | undefined) => {
  const path = pathOf(url);
  return path === APP_PREFIX || path.startsWith(APP_PREFIX + '/');
};

/**
 * Wires everything together. All traffic arrives on one port and one URL; the
 * path decides where it goes:
 *
 *   /_tunnelly/…   → Express: dashboard, API, health check, CLI WebSocket endpoint
 *   everything else → the tunnel (raw Node handler — no Express middleware)
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
    if (isAppPath(req.url)) {
      app(req, res);
      return;
    }
    const tunnel = manager.current;
    if (!tunnel) {
      sendDownPage(res, downPages.noTunnel());
    } else if (!tunnel.connection) {
      sendDownPage(res, downPages.reconnecting());
    } else {
      tunnel.connection.forwardHttp(req, res);
    }
  });

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    if (pathOf(req.url) === CONNECT_PATH) {
      controlWss.handleUpgrade(req, socket, head, (ws) => controlWss.emit('connection', ws, req));
      return;
    }
    const conn = manager.current?.connection;
    if (conn && !isAppPath(req.url)) {
      conn.forwardUpgrade(req, socket, head);
      return;
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
