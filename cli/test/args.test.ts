import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCliArgs, parsePort } from '../src/utils/args.js';
import { resolveServerUrl, toWebSocketUrl } from '../src/config.js';

test('parsePort accepts valid ports', () => {
  assert.equal(parsePort('3000'), 3000);
  assert.equal(parsePort('1'), 1);
  assert.equal(parsePort('65535'), 65535);
});

test('parsePort rejects invalid ports', () => {
  for (const bad of [undefined, '', '0', '65536', '-1', 'abc', '3000abc', '30.5', ' 3000', '999999']) {
    assert.equal(parsePort(bad), null, `expected ${JSON.stringify(bad)} to be rejected`);
  }
});

test('parseCliArgs: valid port with defaults', () => {
  const result = parseCliArgs(['3000'], {});
  assert.equal(result.kind, 'run');
  if (result.kind !== 'run') return;
  assert.equal(result.options.port, 3000);
  assert.equal(result.options.localHost, 'localhost');
  assert.equal(result.options.skipCheck, false);
  assert.equal(result.options.debug, false);
});

test('parseCliArgs: invalid or missing port is an error', () => {
  for (const argv of [[], ['abc'], ['0'], ['70000'], ['3000', '4000']]) {
    const result = parseCliArgs(argv, {});
    assert.equal(result.kind, 'error', `argv ${JSON.stringify(argv)}`);
    if (result.kind === 'error') assert.equal(result.message, 'Invalid port.');
  }
});

test('parseCliArgs: unknown flag is an error', () => {
  assert.equal(parseCliArgs(['3000', '--nope'], {}).kind, 'error');
});

test('parseCliArgs: help and version', () => {
  assert.equal(parseCliArgs(['--help'], {}).kind, 'help');
  assert.equal(parseCliArgs(['-v'], {}).kind, 'version');
});

test('parseCliArgs: options and env', () => {
  const result = parseCliArgs(['8080', '--host', '127.0.0.1', '--skip-check', '--debug'], {
    TUNNELLY_SERVER: 'https://env.example.com',
    TUNNELLY_TOKEN: 'secret',
  });
  assert.equal(result.kind, 'run');
  if (result.kind !== 'run') return;
  assert.equal(result.options.localHost, '127.0.0.1');
  assert.equal(result.options.serverUrl, 'https://env.example.com');
  assert.equal(result.options.token, 'secret');
  assert.equal(result.options.skipCheck, true);
  assert.equal(result.options.debug, true);
});

test('parseCliArgs: rejects non-http server URLs', () => {
  assert.equal(parseCliArgs(['3000', '--server', 'ftp://x'], {}).kind, 'error');
  assert.equal(parseCliArgs(['3000', '--server', 'not a url'], {}).kind, 'error');
});

test('server URL precedence: flag > env > default', () => {
  assert.equal(resolveServerUrl('https://flag.dev', { TUNNELLY_SERVER: 'https://env.dev' }), 'https://flag.dev');
  assert.equal(resolveServerUrl(undefined, { TUNNELLY_SERVER: 'https://env.dev' }), 'https://env.dev');
  assert.equal(resolveServerUrl(undefined, {}), 'http://localhost:4000');
});

test('toWebSocketUrl maps http(s) to ws(s) on the connect path', () => {
  assert.equal(toWebSocketUrl('https://example.com'), 'wss://example.com/_tunnelly/connect');
  assert.equal(toWebSocketUrl('http://localhost:4000/'), 'ws://localhost:4000/_tunnelly/connect');
  assert.equal(toWebSocketUrl('wss://example.com/anything?x=1'), 'wss://example.com/_tunnelly/connect');
});
