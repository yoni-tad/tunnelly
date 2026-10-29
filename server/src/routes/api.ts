import { Router } from 'express';
import type { RequestLogStore } from '../services/requestLog.js';
import type { TunnelManager } from '../tunnel/TunnelManager.js';
import type { ServerConfig } from '../config/index.js';

export function apiRouter(deps: { manager: TunnelManager; logStore: RequestLogStore; config: ServerConfig; startedAt: number }): Router {
  const router = Router();

  router.get('/status', (_req, res) => {
    res.json({
      tunnel: deps.manager.currentInfo(),
      server: {
        publicUrl: deps.config.publicUrl,
        startedAt: deps.startedAt,
        uptimeMs: Date.now() - deps.startedAt,
      },
    });
  });

  // Summaries only; headers are fetched per request on demand.
  router.get('/requests', (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 200, 1000);
    const requests = deps.logStore.list(limit).map(({ requestHeaders, responseHeaders, ...summary }) => summary);
    res.json({ requests });
  });

  router.get('/requests/:id', (req, res) => {
    const entry = deps.logStore.get(req.params.id);
    if (!entry) {
      res.status(404).json({ error: 'Request not found' });
      return;
    }
    res.json(entry);
  });

  return router;
}
