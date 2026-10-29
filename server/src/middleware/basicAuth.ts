import type { RequestHandler } from 'express';
import { safeEqual } from '../utils/secure.js';

/**
 * Single-account dashboard protection: HTTP Basic auth, any username,
 * password = DASHBOARD_PASSWORD. Disabled when no password is configured (dev).
 */
export function basicAuth(password: string): RequestHandler {
  return (req, res, next) => {
    if (!password) return next();
    const header = req.headers.authorization ?? '';
    if (header.startsWith('Basic ')) {
      const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
      const supplied = decoded.slice(decoded.indexOf(':') + 1);
      if (safeEqual(supplied, password)) return next();
    }
    res.setHeader('WWW-Authenticate', 'Basic realm="Tunnelly", charset="UTF-8"');
    res.status(401).send('Authentication required');
  };
}
