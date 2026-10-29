import { VERSION } from '../config.js';
import { Ui } from '../logger/ui.js';
import { findLocalAddress } from '../network/checkLocal.js';
import { fetchLatestVersion, isNewer } from '../network/updateCheck.js';
import { TunnelClient } from '../tunnel/TunnelClient.js';
import { parseCliArgs, USAGE } from '../utils/args.js';

/** `tunnel <port>` — returns the process exit code. */
export async function runTunnelCommand(argv: string[]): Promise<number> {
  const parsed = parseCliArgs(argv);
  const ui = new Ui(process.stdout, parsed.kind === 'run' && parsed.options.debug);

  if (parsed.kind === 'help') {
    process.stdout.write(`Tunnelly ${VERSION} — expose localhost through your own domain\n\n${USAGE}\n`);
    return 0;
  }
  if (parsed.kind === 'version') {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (parsed.kind === 'error') {
    ui.error(parsed.message, 'Usage:', 'npx tunnel 3000', '', 'Run with --help for all options.');
    return 1;
  }

  const options = parsed.options;
  const localUrl = `http://${options.localHost}:${options.port}`;

  const localAddress = options.skipCheck ? undefined : await findLocalAddress(options.localHost, options.port);
  if (localAddress === null) {
    ui.error(
      `Cannot connect to ${options.localHost}:${options.port}`,
      'Make sure your local application is running.',
      '(Use --skip-check to start the tunnel anyway.)',
    );
    return 1;
  }

  ui.banner();
  ui.connecting(options.serverUrl, VERSION);

  // Non-blocking: an outdated global install should never fail silently again.
  if (!VERSION.includes('dev') && !process.env.TUNNELLY_NO_UPDATE_CHECK) {
    void fetchLatestVersion().then((latest) => {
      if (latest && isNewer(latest, VERSION)) ui.updateAvailable(VERSION, latest);
    });
  }

  const client = new TunnelClient({
    serverUrl: options.serverUrl,
    localHost: options.localHost,
    localPort: options.port,
    localAddress,
    token: options.token,
    clientVersion: VERSION,
  });

  return new Promise<number>((resolve) => {
    client.on('connected', (e) => {
      ui.debug(`tunnel ${e.tunnelId}${e.resumed ? ' (resumed)' : ''}`);
      ui.connected({ localUrl, ...e });
    });
    client.on('disconnected', (e) => ui.disconnected(e.reason));
    client.on('reconnecting', (e) => ui.reconnecting(e));
    client.on('request', (log) => ui.request(log));
    client.on('fatal', (error) => {
      ui.fatal(error);
      resolve(1);
    });

    let stopping = false;
    const shutdown = async () => {
      if (stopping) {
        process.exit(130); // second Ctrl+C: don't wait
      }
      stopping = true;
      ui.stopping();
      await client.stop();
      ui.stopped();
      resolve(0);
    };
    process.on('SIGINT', () => void shutdown());
    process.on('SIGTERM', () => void shutdown());

    client.start();
  });
}
