import path from 'node:path';

export interface ServerConfig {
  /** Port the Node process listens on (the reverse proxy forwards to it). */
  port: number;
  host: string;
  nodeEnv: string;
  /**
   * The one public URL, e.g. https://tunnelly.yoni-tad.com. The tunnel is served
   * at its root; the dashboard at /_tunnelly/.
   */
  publicUrl: string;
  /** Trust X-Forwarded-* headers from the reverse proxy. */
  trustProxy: boolean;
  /** HTTP Basic auth password for the dashboard. Required in production. */
  dashboardPassword: string;
  /** Optional shared secret the CLI must present (TUNNELLY_TOKEN on the CLI side). */
  connectToken: string;
  /** Max time to wait for the local app to start responding. */
  requestTimeoutMs: number;
  maxRequestBodyBytes: number;
  heartbeatIntervalMs: number;
  /** A tunnel with no pong for this long is considered dead. */
  heartbeatTimeoutMs: number;
  /** How long a dropped tunnel's URL stays reserved for the same CLI to resume. */
  resumeGraceMs: number;
  helloTimeoutMs: number;
  requestLogLimit: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  logFormat: 'pretty' | 'json';
}

function loadDotEnv(): void {
  // Zero-dependency .env support (Node >= 20.12). Real env vars always win.
  for (const file of [path.resolve('.env')]) {
    try {
      process.loadEnvFile(file);
    } catch {
      // no .env file — fine
    }
  }
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number (got "${raw}")`);
  return value;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

export function loadConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  loadDotEnv();
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  const production = nodeEnv === 'production';
  const port = int('PORT', 4000);

  const config: ServerConfig = {
    port,
    host: process.env.HOST ?? '0.0.0.0',
    nodeEnv,
    publicUrl: process.env.PUBLIC_URL || `http://localhost:${port}`,
    trustProxy: bool('TRUST_PROXY', production),
    dashboardPassword: process.env.DASHBOARD_PASSWORD ?? '',
    connectToken: process.env.TUNNEL_CONNECT_TOKEN ?? '',
    requestTimeoutMs: int('REQUEST_TIMEOUT_MS', 60_000),
    maxRequestBodyBytes: int('MAX_REQUEST_BODY_MB', 50) * 1024 * 1024,
    heartbeatIntervalMs: int('HEARTBEAT_INTERVAL_MS', 15_000),
    heartbeatTimeoutMs: int('HEARTBEAT_TIMEOUT_MS', 45_000),
    resumeGraceMs: int('RESUME_GRACE_MS', 120_000),
    helloTimeoutMs: 10_000,
    requestLogLimit: int('REQUEST_LOG_LIMIT', 1000),
    logLevel: (process.env.LOG_LEVEL as ServerConfig['logLevel']) ?? 'info',
    logFormat: (process.env.LOG_FORMAT as ServerConfig['logFormat']) ?? 'pretty',
    ...overrides,
  };

  if (production && !config.dashboardPassword) {
    throw new Error('DASHBOARD_PASSWORD must be set when NODE_ENV=production');
  }
  try {
    const url = new URL(config.publicUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error();
    config.publicUrl = url.origin;
  } catch {
    throw new Error(`PUBLIC_URL must be an http(s) URL like https://tunnelly.example.com (got "${config.publicUrl}")`);
  }
  return config;
}
