type Level = 'debug' | 'info' | 'warn' | 'error';
type Fields = Record<string, unknown>;

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, fields?: Fields): void;
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
}

/**
 * Tiny structured logger.
 *   pretty: [INFO] Tunnel connected: tnl_abc123  port=3000
 *   json:   {"time":"…","level":"info","msg":"Tunnel connected: tnl_abc123","port":3000}
 */
export function createLogger(opts: { level?: Level; format?: 'pretty' | 'json'; silent?: boolean } = {}): Logger {
  const min = ORDER[opts.level ?? 'info'];
  const format = opts.format ?? 'pretty';

  const write = (level: Level, msg: string, fields: Fields = {}) => {
    if (opts.silent || ORDER[level] < min) return;
    const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
    if (format === 'json') {
      stream.write(JSON.stringify({ time: new Date().toISOString(), level, msg, ...fields }) + '\n');
      return;
    }
    const extras = Object.entries(fields)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
      .join(' ');
    stream.write(`[${level.toUpperCase()}] ${msg}${extras ? '  ' + extras : ''}\n`);
  };

  return {
    debug: (m, f) => write('debug', m, f),
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
  };
}
