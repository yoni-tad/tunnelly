// Bundles the CLI into a single dist/index.js (shared protocol code included,
// `ws` stays a normal dependency). The default server URL lives in src/config.ts.
import { build } from 'esbuild';
import { chmodSync, readFileSync } from 'node:fs';
import path from 'node:path';

const here = import.meta.dirname;
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
  define: { __TUNNELLY_VERSION__: JSON.stringify(version) },
  logLevel: 'warning',
});
chmodSync(outfile, 0o755);
console.log('Built cli/dist/index.js');
