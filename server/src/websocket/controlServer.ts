import type { IncomingMessage } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ServerConfig } from '../config/index.js';
import type { Logger } from '../utils/logger.js';
import { parseMessage, PROTOCOL_VERSION, type HelloMessage } from '../../../shared/protocol.js';
import { toBuffer } from '../../../shared/frames.js';
import { rejectConnection, type TunnelManager } from '../tunnel/TunnelManager.js';
import { getClientIp } from '../utils/clientIp.js';
import { safeEqual } from '../utils/secure.js';

export interface ControlDeps {
  config: ServerConfig;
  logger: Logger;
  manager: TunnelManager;
}

/** WebSocket server for CLI control connections (`/_tunnelly/connect`). */
export function createControlServer(deps: ControlDeps): WebSocketServer {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 16 * 1024 * 1024,
    // Lets the CLI compress text responses on the (usually slow) upload leg.
    perMessageDeflate: { threshold: 1024 },
  });
  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => handleHandshake(ws, req, deps));
  return wss;
}

function handleHandshake(ws: WebSocket, req: IncomingMessage, { config, logger, manager }: ControlDeps): void {
  const clientIp = getClientIp(req, config.trustProxy);
  ws.on('error', (err) => logger.debug('Control socket error', { error: err.message }));

  const timer = setTimeout(() => rejectConnection(ws, 'HELLO_TIMEOUT', 'No handshake received.'), config.helloTimeoutMs);

  ws.once('message', (data, isBinary) => {
    clearTimeout(timer);
    const hello = isBinary ? null : parseMessage<HelloMessage>(toBuffer(data).toString('utf8'));

    if (!hello || hello.type !== 'hello') {
      rejectConnection(ws, 'BAD_HELLO', 'Invalid handshake.');
      return;
    }
    if (hello.version !== PROTOCOL_VERSION) {
      rejectConnection(
        ws,
        'UNSUPPORTED_VERSION',
        `This server speaks protocol v${PROTOCOL_VERSION}, the CLI speaks v${hello.version}. Update the CLI.`,
      );
      return;
    }
    if (!Number.isInteger(hello.localPort) || hello.localPort < 1 || hello.localPort > 65535) {
      rejectConnection(ws, 'BAD_HELLO', 'Invalid local port.');
      return;
    }
    if (config.connectToken && !safeEqual(hello.token ?? '', config.connectToken)) {
      logger.warn('Rejected tunnel: bad connect token', { clientIp });
      rejectConnection(ws, 'UNAUTHORIZED', 'This server requires a valid TUNNELLY_TOKEN.');
      return;
    }
    manager.register(ws, hello, clientIp);
  });
}
