import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { isLocalPortReachable } from '../src/network/checkLocal.js';

test('detects a listening local port', async () => {
  const server = net.createServer((s) => s.end());
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  assert.equal(await isLocalPortReachable('127.0.0.1', port), true);
  await new Promise((r) => server.close(r));
  assert.equal(await isLocalPortReachable('127.0.0.1', port), false);
});
