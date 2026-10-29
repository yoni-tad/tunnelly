import { parseArgs } from 'node:util';
import { resolveServerUrl } from '../config.js';

export interface CliOptions {
  port: number;
  /** Host of the local app (default localhost). */
  localHost: string;
  serverUrl: string;
  token?: string;
  skipCheck: boolean;
  debug: boolean;
}

export type ParsedArgs =
  | { kind: 'run'; options: CliOptions }
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'error'; message: string };

export const USAGE = `Usage:
  npx tunnel <port> [options]

Options:
  --server <url>   Tunnelly server (default: https://tunnelly.yoni-tad.com, or $TUNNELLY_SERVER)
  --host <host>    Local host to forward to (default: localhost)
  --token <token>  Connect token, if the server requires one ($TUNNELLY_TOKEN)
  --skip-check     Start even if nothing is listening on the port yet
  --debug          Show detailed errors
  -h, --help       Show this help
  -v, --version    Show version`;

/** Returns the port number, or null if `value` isn't a valid TCP port. */
export function parsePort(value: string | undefined): number | null {
  if (value === undefined || !/^\d{1,5}$/.test(value)) return null;
  const port = Number(value);
  return port >= 1 && port <= 65535 ? port : null;
}

export function parseCliArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): ParsedArgs {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        server: { type: 'string', short: 's' },
        host: { type: 'string' },
        token: { type: 'string' },
        'skip-check': { type: 'boolean', default: false },
        debug: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', short: 'v', default: false },
      },
    });
  } catch (err) {
    return { kind: 'error', message: (err as Error).message };
  }

  const { values, positionals } = parsed;
  if (values.help) return { kind: 'help' };
  if (values.version) return { kind: 'version' };
  if (positionals.length !== 1) return { kind: 'error', message: 'Invalid port.' };

  const port = parsePort(positionals[0]);
  if (port === null) return { kind: 'error', message: 'Invalid port.' };

  const serverUrl = resolveServerUrl(values.server, env);
  try {
    const protocol = new URL(serverUrl).protocol;
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(protocol)) throw new Error();
  } catch {
    return { kind: 'error', message: `Invalid server URL: ${serverUrl}` };
  }

  return {
    kind: 'run',
    options: {
      port,
      localHost: values.host ?? 'localhost',
      serverUrl,
      token: values.token ?? env.TUNNELLY_TOKEN ?? undefined,
      skipCheck: values['skip-check'] ?? false,
      debug: (values.debug ?? false) || env.TUNNELLY_DEBUG === '1',
    },
  };
}
