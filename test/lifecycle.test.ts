/**
 * Tunnel lifecycle: creation, single-tunnel rule, graceful shutdown,
 * reconnect/resume, heartbeat-based stale connection cleanup.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { CONNECT_PATH, PROTOCOL_VERSION, type ErrorMessage, type ReadyMessage } from '../shared/protocol.js';
import type { ConnectedEvent, ReconnectingEvent } from '../cli/src/tunnel/TunnelClient.js';
import { TunnelClient } from '../cli/src/tunnel/TunnelClient.js';
import { connectClient, createClient, hostOf, request, startLocalApp, startTestServer, waitFor, waitForEvent } from './helpers.js';

const helloFrame = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'hello', version: PROTOCOL_VERSION, clientVersion: 'raw', localPort: 3000, ...extra });

/** A bare WebSocket "CLI" for protocol-level tests. */
async function rawConnect(port: number, opts: { autoPong?: boolean } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${CONNECT_PATH}`, { autoPong: opts.autoPong ?? true });
  const messages: unknown[] = [];
  ws.on('message', (d) => messages.push(JSON.parse(d.toString())));
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return { ws, messages };
}

describe('tunnel lifecycle', () => {
  test('creating a tunnel registers it as CONNECTED on the configured public URL', async () => {
    const server = await startTestServer();
    const app = await startLocalApp((_req, res) => res.end('ok'));
    const client = createClient(server, app.port);
    try {
      const connected = await connectClient(client);
      assert.match(connected.tunnelId, /^tnl_[a-z0-9]{10}$/);
      assert.equal(connected.publicUrl, 'http://tunnel.test');
      assert.equal(connected.firstConnect, true);
      const info = server.manager.currentInfo();
      assert.equal(info?.status, 'CONNECTED');
      assert.equal(info?.localPort, app.port);
      assert.equal(info?.id, connected.tunnelId);
    } finally {
      await client.stop();
      await server.close();
      await app.close();
    }
  });

  test('a second tunnel is rejected while one is active', async () => {
    const server = await startTestServer();
    const first = createClient(server, 3000);
    const second = createClient(server, 3001);
    try {
      const { publicUrl } = await connectClient(first);
      const fatal = waitForEvent<ErrorMessage>(second, 'fatal');
      second.start();
      const error = await fatal;
      assert.equal(error.code, 'TUNNEL_ACTIVE');
      assert.equal(error.message, 'A tunnel is already active.');
      assert.equal(error.publicUrl, publicUrl);
      assert.equal(second.state, 'stopped', 'rejected client does not retry');
      assert.equal(server.manager.currentInfo()?.publicUrl, publicUrl, 'existing tunnel untouched');
    } finally {
      await first.stop();
      await second.stop();
      await server.close();
    }
  });

  test('graceful shutdown releases the tunnel immediately', async () => {
    const server = await startTestServer({ resumeGraceMs: 60_000 });
    const client = createClient(server, 3000);
    const { publicUrl } = await connectClient(client);
    await client.stop();

    await waitFor(() => server.manager.currentInfo()?.status === 'DISCONNECTED', 2000, 'release');
    const res = await request(server.port, { host: hostOf(publicUrl) });
    assert.equal(res.status, 503, 'URL shows "no tunnel running"');
    assert.match(res.body.toString(), /No tunnel running/);

    // A new tunnel can be created right away (no grace-period blocking).
    const next = createClient(server, 3000);
    const connected = await connectClient(next);
    assert.equal(connected.publicUrl, publicUrl, 'same fixed URL');
    await next.stop();
    await server.close();
  });

  test('client reconnects and resumes the same URL after the connection drops', async () => {
    const server = await startTestServer();
    const app = await startLocalApp((_req, res) => res.end('still here'));
    const client = createClient(server, app.port);
    try {
      const first = await connectClient(client);
      const disconnected = waitForEvent(client, 'disconnected');
      const reconnected = waitForEvent<ConnectedEvent>(client, 'connected');

      // Simulate a network drop: kill the socket without a close handshake.
      const tunnelConn = server.manager.current!.connection!;
      tunnelConn.terminate();

      await disconnected;
      const second = await reconnected;
      assert.equal(second.resumed, true);
      assert.equal(second.publicUrl, first.publicUrl);
      assert.equal(second.urlChanged, false);
      assert.equal(server.manager.currentInfo()?.reconnects, 1);

      const res = await request(server.port, { host: hostOf(second.publicUrl) });
      assert.equal(res.body.toString(), 'still here');
    } finally {
      await client.stop();
      await server.close();
      await app.close();
    }
  });

  test('a resumed connection replaces a stale (half-open) one', async () => {
    const server = await startTestServer();
    const raw = await rawConnect(server.port);
    raw.ws.send(helloFrame());
    await waitFor(() => raw.messages.length > 0, 2000, 'ready');
    const ready = raw.messages[0] as ReadyMessage;

    // Same CLI comes back on a new socket while the server still thinks the old one is alive.
    const again = await rawConnect(server.port);
    again.ws.send(helloFrame({ resume: { tunnelId: ready.tunnelId, sessionToken: ready.sessionToken } }));
    await waitFor(() => again.messages.length > 0, 2000, 'resume ready');
    const resumed = again.messages[0] as ReadyMessage;
    assert.equal(resumed.type, 'ready');
    assert.equal(resumed.resumed, true);
    assert.equal(resumed.publicUrl, ready.publicUrl);
    await waitFor(() => raw.ws.readyState === WebSocket.CLOSED, 2000, 'old socket closed');

    // A wrong token cannot take over the tunnel.
    const intruder = await rawConnect(server.port);
    intruder.ws.send(helloFrame({ resume: { tunnelId: ready.tunnelId, sessionToken: 'guess' } }));
    await waitFor(() => intruder.messages.length > 0, 2000, 'intruder rejected');
    assert.equal((intruder.messages[0] as ErrorMessage).code, 'TUNNEL_ACTIVE');
    assert.equal(server.manager.currentInfo()?.status, 'CONNECTED');

    again.ws.close();
    await server.close();
  });

  test('client keeps retrying while the server is down, then starts a fresh tunnel', async () => {
    const first = await startTestServer();
    const port = first.port;
    const client = createClient(first, 3000);
    const original = await connectClient(client);

    const retrying = waitForEvent<ReconnectingEvent>(client, 'reconnecting');
    await first.close(); // server restart — tunnel state is lost
    const event = await retrying;
    assert.equal(event.everConnected, true);

    // Let a few failed attempts happen against the closed port.
    await new Promise((r) => setTimeout(r, 300));
    const reconnected = waitForEvent<ConnectedEvent>(client, 'connected', 8000);
    const second = await startTestServer({ port });
    const after = await reconnected;
    assert.equal(after.resumed, false);
    assert.notEqual(after.tunnelId, original.tunnelId, 'new session after restart');
    assert.equal(after.publicUrl, original.publicUrl, 'URL is fixed');

    await client.stop();
    await second.close();
  });

  test('reconnect delays back off exponentially up to the cap', async () => {
    // Nothing listening on this port.
    const blocker = new WebSocketServer({ port: 0 });
    const port = (blocker.address() as AddressInfo).port;
    await new Promise((r) => blocker.close(r));

    const client = new TunnelClient({
      serverUrl: `http://127.0.0.1:${port}`,
      localHost: '127.0.0.1',
      localPort: 3000,
      clientVersion: 'test',
      backoff: { baseMs: 20, maxMs: 80, jitter: 0 },
    });
    const delays: number[] = [];
    client.on('reconnecting', (e) => delays.push(e.delayMs));
    client.start();
    await waitFor(() => delays.length >= 5, 3000, 'retries');
    await client.stop();
    assert.deepEqual(delays.slice(0, 5), [20, 40, 80, 80, 80]);
  });

  test('CLI detects a silent server via heartbeat and reconnects', async () => {
    // Fake server: completes the handshake, then never answers pings.
    const wss = new WebSocketServer({ port: 0, autoPong: false });
    const port = (wss.address() as AddressInfo).port;
    let connections = 0;
    wss.on('connection', (ws) => {
      connections++;
      ws.once('message', () => {
        ws.send(JSON.stringify({ type: 'ready', tunnelId: 'tnl_fake', publicUrl: 'http://fake', sessionToken: 't', resumed: false }));
      });
    });

    const client = new TunnelClient({
      serverUrl: `http://127.0.0.1:${port}`,
      localHost: '127.0.0.1',
      localPort: 3000,
      clientVersion: 'test',
      backoff: { baseMs: 20, maxMs: 20, jitter: 0 },
      heartbeatIntervalMs: 50,
      heartbeatTimeoutMs: 200,
    });
    try {
      await connectClient(client);
      const reconnecting = await waitForEvent<ReconnectingEvent>(client, 'reconnecting', 3000);
      assert.equal(reconnecting.reason, 'connection timed out');
      await waitFor(() => connections >= 2, 3000, 'second connection');
    } finally {
      await client.stop();
      for (const ws of wss.clients) ws.terminate();
      await new Promise((r) => wss.close(r));
    }
  });

  test('server marks a silent CLI disconnected and later releases it', async () => {
    const server = await startTestServer({ heartbeatIntervalMs: 50, heartbeatTimeoutMs: 200, resumeGraceMs: 300 });
    const raw = await rawConnect(server.port, { autoPong: false });
    raw.ws.send(helloFrame());
    await waitFor(() => server.manager.currentInfo()?.status === 'CONNECTED', 2000, 'connected');
    const host = 'tunnel.test';

    await waitFor(() => server.manager.currentInfo()?.status === 'DISCONNECTED', 2000, 'heartbeat timeout');
    // During the grace period the URL answers "offline" rather than routing elsewhere.
    const offline = await request(server.port, { host });
    assert.equal(offline.status, 503);

    await waitFor(() => server.manager.current === null, 2000, 'release');
    const gone = await request(server.port, { host });
    assert.equal(gone.status, 503);
    await server.close();
  });

  test('handshake: bad hello, wrong version and missing token are rejected', async () => {
    const server = await startTestServer({ connectToken: 's3cret', helloTimeoutMs: 1000 });
    try {
      const cases: [string, string][] = [
        ['not json', 'BAD_HELLO'],
        [helloFrame({ version: 999, token: 's3cret' }), 'UNSUPPORTED_VERSION'],
        [helloFrame({ localPort: 0, token: 's3cret' }), 'BAD_HELLO'],
        [helloFrame(), 'UNAUTHORIZED'],
        [helloFrame({ token: 'wrong' }), 'UNAUTHORIZED'],
      ];
      for (const [frame, code] of cases) {
        const raw = await rawConnect(server.port);
        raw.ws.send(frame);
        await waitFor(() => raw.messages.length > 0, 2000, code);
        assert.equal((raw.messages[0] as ErrorMessage).code, code);
        await waitFor(() => raw.ws.readyState === WebSocket.CLOSED, 2000, 'closed');
      }

      const silent = await rawConnect(server.port);
      await waitFor(() => silent.messages.length > 0, 4000, 'hello timeout');
      assert.equal((silent.messages[0] as ErrorMessage).code, 'HELLO_TIMEOUT');

      const ok = await rawConnect(server.port);
      ok.ws.send(helloFrame({ token: 's3cret' }));
      await waitFor(() => ok.messages.length > 0, 2000, 'ready');
      assert.equal((ok.messages[0] as ReadyMessage).type, 'ready');
      ok.ws.close();
    } finally {
      await server.close();
    }
  });

  test('dashboard requires the password when one is configured', async () => {
    const server = await startTestServer({ dashboardPassword: 'hunter2' });
    try {
      const denied = await request(server.port, { host: 'localhost', path: '/_tunnelly/api/status' });
      assert.equal(denied.status, 401);
      const wrong = await request(server.port, {
        host: 'localhost',
        path: '/_tunnelly/api/status',
        headers: { authorization: 'Basic ' + Buffer.from('me:nope').toString('base64') },
      });
      assert.equal(wrong.status, 401);
      const allowed = await request(server.port, {
        host: 'localhost',
        path: '/_tunnelly/api/status',
        headers: { authorization: 'Basic ' + Buffer.from('me:hunter2').toString('base64') },
      });
      assert.equal(allowed.status, 200);
      const health = await request(server.port, { host: 'localhost', path: '/_tunnelly/health' });
      assert.equal(health.status, 200, 'health check stays public');
    } finally {
      await server.close();
    }
  });

  test('down page: friendly HTML with mascot and steps, JSON for API clients', async () => {
    const server = await startTestServer();
    try {
      const page = await request(server.port, { host: 'tunnel.test', path: '/' });
      assert.equal(page.status, 503);
      assert.equal(page.headers['retry-after'], '5');
      const html = page.body.toString();
      assert.match(html, /class="mascot"/);
      assert.match(html, /If you’re the developer/);
      assert.match(html, /<code>npx tunnelly 3000<\/code>/);
      assert.match(html, /location\.reload/, 'GET pages retry automatically');

      const post = await request(server.port, { host: 'tunnel.test', method: 'POST', path: '/form', body: 'x=1' });
      assert.doesNotMatch(post.body.toString(), /location\.reload/, 'POST pages never auto-resubmit');

      const api = await request(server.port, { host: 'tunnel.test', path: '/api', headers: { accept: 'application/json' } });
      assert.equal(api.status, 503);
      assert.deepEqual(JSON.parse(api.body.toString()).error, 'No tunnel running');
    } finally {
      await server.close();
    }
  });
});
