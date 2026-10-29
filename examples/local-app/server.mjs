// Tiny local app for testing the tunnel by hand.
//
//   PORT=3000 node examples/local-app/server.mjs
//
//   GET  /            → Hello from local application
//   GET  /api/test    → JSON
//   POST /api/test    → echoes the JSON body
//   GET  /slow?ms=3000→ delayed response
//   GET  /headers     → echoes the request headers it received
//   GET  /large?mb=10 → streams a large response
//   WS   /ws          → WebSocket echo
import http from 'node:http';
import { WebSocketServer } from 'ws';

const port = Number(process.env.PORT ?? process.argv[2] ?? 3000);

const json = (res, status, body) => {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>Local app</title><h1>Hello from local application</h1>
<p>Served from localhost:${port} at ${new Date().toISOString()}</p>`);
    return;
  }

  if (url.pathname === '/api/test' && req.method === 'GET') {
    return json(res, 200, { ok: true, message: 'Hello from the local API', time: Date.now() });
  }

  if (url.pathname === '/api/test' && req.method === 'POST') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    try {
      return json(res, 201, { ok: true, received: raw ? JSON.parse(raw) : null });
    } catch {
      return json(res, 400, { ok: false, error: 'Body must be JSON' });
    }
  }

  if (url.pathname === '/slow') {
    const ms = Math.min(Number(url.searchParams.get('ms') ?? 3000), 120_000);
    await new Promise((r) => setTimeout(r, ms));
    return json(res, 200, { ok: true, delayedMs: ms });
  }

  if (url.pathname === '/headers') {
    return json(res, 200, { method: req.method, url: req.url, headers: req.headers });
  }

  if (url.pathname === '/large') {
    const mb = Math.min(Number(url.searchParams.get('mb') ?? 10), 500);
    const chunk = Buffer.alloc(64 * 1024, 'x');
    const total = mb * 1024 * 1024;
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': total });
    let sent = 0;
    const pump = () => {
      while (sent < total) {
        const piece = chunk.subarray(0, Math.min(chunk.length, total - sent));
        sent += piece.length;
        if (!res.write(piece)) return res.once('drain', pump);
      }
      res.end();
    };
    pump();
    return;
  }

  json(res, 404, { ok: false, error: `No route for ${req.method} ${url.pathname}` });
});

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws) => {
  ws.send('connected to local app');
  ws.on('message', (data, isBinary) => ws.send(data, { binary: isBinary }));
});

server.listen(port, () => {
  console.log(`Local test app listening on http://localhost:${port}`);
});
