// Bundles the CLI into a single dist/index.js (shared protocol code included,
// `ws` stays a normal dependency) and bakes in the default server URL so that
// `npx tunnel 3000` needs no configuration on a new machine.
//
// Default server URL, first match wins:
//   TUNNELLY_SERVER env var  →  PUBLIC_URL in the repo's .env  →  http://localhost:4000
import { build } from 'esbuild';
import { chmodSync, readFileSync } from 'node:fs';
import path from 'node:path';

const here = import.meta.dirname;

function fromDotEnv(key) {
  try {
    const text = readFileSync(path.join(here, '..', '.env'), 'utf8');
    const match = text.match(new RegExp(`^\\s*${key}\\s*=\\s*"?([^"\\n#]+)"?`, 'm'));
    return match?.[1]?.trim();
  } catch {
    return undefined;
  }
}

const serverUrl = process.env.TUNNELLY_SERVER || fromDotEnv('PUBLIC_URL') || 'http://localhost:4000';
const { version } = JSON.parse(readFileSync(path.join(here, 'package.json'), 'utf8'));
const outfile = path.join(here, 'dist', 'index.js');

await build({
  entryPoints: [path.join(here, 'src', 'index.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  packages: 'external',
  banner: { js: '#!/usr/bin/env node' },
  define: {
    __TUNNELLY_DEFAULT_SERVER__: JSON.stringify(serverUrl),
    __TUNNELLY_VERSION__: JSON.stringify(version),
  },
  logLevel: 'warning',
});
chmodSync(outfile, 0o755);
console.log(`Built cli/dist/index.js  (default server: ${serverUrl})`);
