import path from 'node:path';
import express from 'express';
import type { ServerConfig } from './config/index.js';
import type { RequestLogStore } from './services/requestLog.js';
import type { TunnelManager } from './tunnel/TunnelManager.js';
import { basicAuth } from './middleware/basicAuth.js';
import { apiRouter } from './routes/api.js';
import { classifyHost } from './utils/hosts.js';

const PUBLIC_DIR = path.join(import.meta.dirname, '..', 'public');

/** Express app for the app host: health check, dashboard, and its JSON API. */
export function createApp(deps: { config: ServerConfig; manager: TunnelManager; logStore: RequestLogStore; startedAt: number }) {
  const app = express();
  app.disable('x-powered-by');
  if (deps.config.trustProxy) app.set('trust proxy', 'loopback');

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  // For Caddy "on-demand TLS": approve certificates only for the dashboard host
  // and the currently active tunnel, so scanners can't burn Let's Encrypt rate limits.
  app.get('/_tunnelly/tls-check', (req, res) => {
    const host = classifyHost(String(req.query.domain ?? '').toLowerCase(), deps.config);
    const allowed = host.kind === 'app' || (host.kind === 'tunnel' && deps.manager.findBySubdomain(host.subdomain) !== null);
    res.sendStatus(allowed ? 200 : 404);
  });

  app.use(basicAuth(deps.config.dashboardPassword));
  app.use('/api', apiRouter(deps));
  app.use(express.static(PUBLIC_DIR, { index: 'index.html', maxAge: 0 }));
  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  return app;
}
