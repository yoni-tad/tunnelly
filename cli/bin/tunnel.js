#!/usr/bin/env node
// Stable entry point for the `tunnel` / `tunnelly` bins. It always exists, so npm
// can link it even before the CLI has been built.
import('../dist/index.js').catch((err) => {
  if (err && err.code === 'ERR_MODULE_NOT_FOUND' && String(err.message).includes('dist/index.js')) {
    console.error('\n  ✗ The Tunnelly CLI has not been built yet.\n\n  Run: npm run build\n');
    process.exit(1);
  }
  throw err;
});
