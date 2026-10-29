/**
 * End-to-end: HTTP client → Tunnelly server → WebSocket → TunnelClient (CLI) → local app.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import type { TunnellyServer } from '../server/src/tunnellyServer.js';
import type { TunnelClient } from '../cli/src/tunnel/TunnelClient.js';
import type { RequestLog } from '../cli/src/tunnel/LocalForwarder.js';
import { connectClient, createClient, hostOf, request, startLocalApp, startTestServer, waitFor } from './helpers.js';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describe('end-to-end HTTP tunnel', () => {
  let server: TunnellyServer;
  let app: Awaited<ReturnType<typeof startLocalApp>>;
  let client: TunnelClient;
  let host: string;
  const cliLogs: RequestLog[] = [];
  const bigResponse = randomBytes(10 * 1024 * 1024);

  before(async () => {
    app = await startLocalApp(async (req, res) => {
      const url = new URL(req.url!, 'http://x');
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = Buffer.concat(chunks);

      if (url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('Hello from local application');
      } else if (url.pathname === '/echo') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            method: req.method,
            url: req.url,
            headers: req.headers,
            body: body.toString('utf8'),
          }),
        );
      } else if (url.pathname === '/upload-hash') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(`${body.length}:${sha(body)}`);
      } else if (url.pathname === '/big') {
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': bigResponse.length });
        res.end(bigResponse);
      } else if (url.pathname === '/created') {
        res.setHeader('set-cookie', ['a=1; Path=/', 'b=2; Path=/']);
        res.setHeader('x-custom', 'yes');
        res.setHeader('keep-alive', 'timeout=5');
        res.writeHead(201, 'Made It', { location: '/things/1' });
        res.end('created');
      } else if (url.pathname === '/slow') {
        setTimeout(() => res.end('finally'), 2000);
      } else {
        res.writeHead(404);
        res.end('nope');
      }
    });

    // WebSocket echo on the local app
    const wss = new WebSocketServer({ server: app.server, path: '/ws' });
    wss.on('connection', (ws, req) => {
      ws.send(`hello ${req.headers['sec-websocket-protocol'] ?? ''}`.trim());
      ws.on('message', (data, isBinary) => ws.send(data, { binary: isBinary }));
    });

    server = await startTestServer({ requestTimeoutMs: 500 });
    client = createClient(server, app.port);
    client.on('request', (log) => cliLogs.push(log));
    const connected = await connectClient(client);
    host = hostOf(connected.publicUrl);
  });

  after(async () => {
    await client.stop();
    await server.close();
    await app.close();
  });

  test('GET reaches the local app and returns its response', async () => {
    const res = await request(server.port, { host, path: '/' });
    assert.equal(res.status, 200);
    assert.equal(res.body.toString(), 'Hello from local application');
    assert.match(String(res.headers['x-tunnelly-request-id']), /^req_[0-9a-f]{12}$/);
  });

  test('method, path, query, headers and body are forwarded', async () => {
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      const body = method === 'GET' || method === 'OPTIONS' ? undefined : JSON.stringify({ method });
      const res = await request(server.port, {
        host,
        method,
        path: '/echo?page=2&q=a%20b',
        headers: { 'content-type': 'application/json', 'x-trace': 'abc', cookie: 'sid=1', connection: 'keep-alive, x-hop', 'x-hop': 'drop-me' },
        body,
      });
      assert.equal(res.status, 200, method);
      const echoed = JSON.parse(res.body.toString());
      assert.equal(echoed.method, method);
      assert.equal(echoed.url, '/echo?page=2&q=a%20b');
      assert.equal(echoed.headers['x-trace'], 'abc');
      assert.equal(echoed.headers.cookie, 'sid=1');
      assert.equal(echoed.headers['x-hop'], undefined, 'headers nominated by Connection are hop-by-hop');
      assert.equal(echoed.headers.host, `127.0.0.1:${app.port}`, 'Host is rewritten for the local app');
      assert.equal(echoed.headers['x-forwarded-host'], host);
      assert.equal(echoed.headers['x-forwarded-proto'], 'http');
      assert.ok(echoed.headers['x-forwarded-for']);
      assert.equal(echoed.body, body ?? '');
    }
  });

  test('HEAD returns headers without a body', async () => {
    const res = await request(server.port, { host, method: 'HEAD', path: '/' });
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 0);
    assert.equal(res.headers['content-type'], 'text/plain');
  });

  test('status code, status text and response headers are preserved; hop-by-hop dropped', async () => {
    const res = await request(server.port, { host, method: 'POST', path: '/created' });
    assert.equal(res.status, 201);
    assert.equal(res.body.toString(), 'created');
    assert.deepEqual(res.headers['set-cookie'], ['a=1; Path=/', 'b=2; Path=/']);
    assert.equal(res.headers['x-custom'], 'yes');
    assert.equal(res.headers.location, '/things/1');
    assert.notEqual(res.headers['keep-alive'], 'timeout=5');
  });

  test('local 404 is passed through', async () => {
    const res = await request(server.port, { host, path: '/missing' });
    assert.equal(res.status, 404);
    assert.equal(res.body.toString(), 'nope');
  });

  test('large request body is streamed intact', async () => {
    const upload = randomBytes(8 * 1024 * 1024);
    const res = await request(server.port, { host, method: 'POST', path: '/upload-hash', body: upload });
    assert.equal(res.status, 200);
    assert.equal(res.body.toString(), `${upload.length}:${sha(upload)}`);
  });

  test('large response body is streamed intact', async () => {
    const res = await request(server.port, { host, path: '/big' });
    assert.equal(res.status, 200);
    assert.equal(res.body.length, bigResponse.length);
    assert.equal(sha(res.body), sha(bigResponse));
  });

  test('request body over the limit is rejected with 413', async () => {
    const limited = server.config.maxRequestBodyBytes;
    const res = await request(server.port, {
      host,
      method: 'POST',
      path: '/upload-hash',
      headers: { 'content-length': String(limited + 1) },
    }).catch(() => null);
    // The server may answer 413 and close before the body is sent.
    if (res) assert.equal(res.status, 413);
  });

  test('slow local response times out with 503 (not 504, which Cloudflare would replace)', async () => {
    const res = await request(server.port, { host, path: '/slow' });
    assert.equal(res.status, 503);
    assert.match(res.body.toString(), /Gateway timeout/);
  });

  test('requests are logged on the server and the CLI with matching IDs', async () => {
    const res = await request(server.port, { host, path: '/?logged=1', headers: { authorization: 'Bearer secret' } });
    const id = String(res.headers['x-tunnelly-request-id']);

    const entry = server.logStore.get(id);
    assert.ok(entry, 'server log entry exists');
    assert.equal(entry.method, 'GET');
    assert.equal(entry.path, '/?logged=1');
    assert.equal(entry.status, 200);
    assert.ok(entry.durationMs >= 0);
    assert.equal(entry.responseBytes, 'Hello from local application'.length);
    assert.equal(entry.requestHeaders.authorization, '[redacted]', 'sensitive headers are redacted');

    await waitFor(() => cliLogs.some((l) => l.id === id), 2000, 'CLI log');
    const cliLog = cliLogs.find((l) => l.id === id)!;
    assert.equal(cliLog.status, 200);
    assert.equal(cliLog.path, '/?logged=1');
  });

  test('dashboard API exposes tunnel status and request logs', async () => {
    const status = await request(server.port, { host, path: '/_tunnelly/api/status' });
    const body = JSON.parse(status.body.toString());
    assert.equal(body.tunnel.status, 'CONNECTED');
    assert.equal(body.tunnel.publicUrl, 'http://tunnel.test');
    assert.equal(body.tunnel.localPort, app.port);
    assert.ok(body.tunnel.requestCount > 0);
    assert.ok(body.tunnel.bytesOut > 0);
    assert.equal(body.tunnel.sessionToken, undefined, 'session token is never exposed');

    const list = JSON.parse((await request(server.port, { host, path: '/_tunnelly/api/requests' })).body.toString());
    assert.ok(list.requests.length > 0);
    assert.equal(list.requests[0].requestHeaders, undefined, 'list view omits headers');

    const detail = await request(server.port, { host, path: `/_tunnelly/api/requests/${list.requests[0].id}` });
    assert.equal(detail.status, 200);
    assert.ok(JSON.parse(detail.body.toString()).requestHeaders);

    const page = await request(server.port, { host, path: '/_tunnelly/' });
    assert.equal(page.status, 200);
    assert.match(page.body.toString(), /<title>Tunnelly<\/title>/);

    const redirect = await request(server.port, { host, path: '/_tunnelly' });
    assert.equal(redirect.status, 301);
    assert.equal(redirect.headers.location, '/_tunnelly/');
  });

  test('any Host header reaches the tunnel (one URL, routed by path)', async () => {
    const res = await request(server.port, { host: 'localhost:4000', path: '/' });
    assert.equal(res.status, 200);
    assert.equal(res.body.toString(), 'Hello from local application');
  });

  test('WebSocket connections are forwarded (text and binary)', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, ['chat'], { headers: { host } });
    const messages: { data: Buffer; isBinary: boolean }[] = [];
    ws.on('message', (data, isBinary) => messages.push({ data: data as Buffer, isBinary }));
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    assert.equal(ws.protocol, 'chat');
    ws.send('ping');
    ws.send(Buffer.from([1, 2, 3]));
    await waitFor(() => messages.length >= 3, 3000, 'ws echoes');
    assert.equal(messages[0]!.data.toString(), 'hello chat');
    assert.equal(messages[1]!.data.toString(), 'ping');
    assert.equal(messages[1]!.isBinary, false);
    assert.deepEqual([...messages[2]!.data], [1, 2, 3]);
    assert.equal(messages[2]!.isBinary, true);
    ws.close();
    await new Promise((r) => ws.once('close', r));
  });
});

describe('local application unavailable', () => {
  test('returns 503 when nothing listens on the local port', async () => {
    const app = await startLocalApp((_req, res) => res.end('x'));
    const port = app.port;
    await app.close(); // port is now closed

    const server = await startTestServer();
    const client = createClient(server, port);
    try {
      const { publicUrl } = await connectClient(client);
      const res = await request(server.port, { host: hostOf(publicUrl), path: '/' });
      assert.equal(res.status, 503);
      assert.match(res.body.toString(), /Local application unavailable/);
      const entry = server.logStore.list(1)[0];
      assert.equal(entry?.status, 503);
      assert.equal(entry?.error, 'Local application unavailable');
    } finally {
      await client.stop();
      await server.close();
    }
  });
});
