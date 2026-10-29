import { runTunnelCommand } from './commands/tunnel.js';

const debug = process.argv.includes('--debug') || process.env.TUNNELLY_DEBUG === '1';

runTunnelCommand(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: Error) => {
    process.stderr.write(`\n  ✗ Unexpected error: ${err.message}\n`);
    if (debug) process.stderr.write(`\n${err.stack}\n`);
    else process.stderr.write('    Run with --debug for details.\n');
    process.exit(1);
  },
);
