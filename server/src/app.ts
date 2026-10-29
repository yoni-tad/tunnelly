import path from 'node:path';
import express from 'express';
import type { ServerConfig } from './config/index.js';
import type { RequestLogStore } from './services/requestLog.js';
import type { TunnelManager } from './tunnel/TunnelManager.js';
import { basicAuth } from './middleware/basicAuth.js';
import { apiRouter } from './routes/api.js';
import { APP_PREFIX } from '../../shared/protocol.js';

const PUBLIC_DIR = path.join(import.meta.dirname, '..', 'public');

/** Express app for /_tunnelly/…: health check, dashboard, and its JSON API. */
export function createApp(deps: { config: ServerConfig; manager: TunnelManager; logStore: RequestLogStore; startedAt: number }) {
  const app = express();
  app.disable('x-powered-by');
  if (deps.config.trustProxy) app.set('trust proxy', true);

  const router = express.Router();

  router.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  // The dashboard uses relative URLs, so it must be served from /_tunnelly/ (with slash).
  router.use((req, res, next) => {
    if (req.originalUrl.split('?')[0] === APP_PREFIX) res.redirect(301, APP_PREFIX + '/');
    else next();
  });

  router.use(basicAuth(deps.config.dashboardPassword));
  router.use('/api', apiRouter(deps));
  router.use(express.static(PUBLIC_DIR, { index: 'index.html', maxAge: 0 }));
  router.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  app.use(APP_PREFIX, router);
  return app;
}
