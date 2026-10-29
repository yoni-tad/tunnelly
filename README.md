# Tunnelly

Expose a local app through **your own domain** over HTTPS:

```bash
npx tunnel 3000
```

```
  ╭────────────────────────────────────────────╮
  │                  Tunnelly                  │
  │         Simple localhost tunneling         │
  ╰────────────────────────────────────────────╯

  ✓ Connected to Tunnelly

  Local:   http://localhost:3000
  Public:  https://k3x9q2ab.example.com

  Status:  ● Connected

  Press Ctrl+C to stop

  ──────────────────────────────────────────────

  14:02:11  GET     /                      200    24ms    4.2 KB
  14:02:12  POST    /api/login             201    83ms    1.1 KB
  14:02:12  GET     /dashboard             404     8ms     54 B
```

Tunnelly is a personal, deliberately small alternative to ngrok / Cloudflare Tunnel:
one server, one domain, one active tunnel, no accounts. Everything is in this repo.

- [How it works](#how-it-works)
- [Using the CLI](#using-the-cli)
- [Local development](#local-development)
- [Domain setup (wildcard DNS)](#domain-setup-wildcard-dns)
- [HTTPS setup](#https-setup)
- [Production deployment](#production-deployment)
- [Using it from any computer](#using-it-from-any-computer)
- [Configuration reference](#configuration-reference)
- [Troubleshooting](#troubleshooting)
- [Project layout](#project-layout) · [Design decisions](docs/ARCHITECTURE.md) · [Full deployment guide](docs/DEPLOYMENT.md)

---

## How it works

```
 Browser ──HTTPS──▶ https://k3x9q2ab.example.com
                          │
                    Caddy / nginx         TLS termination (Let's Encrypt)
                          │  http://127.0.0.1:4000
                          ▼
                  Tunnelly server         routes by Host header
                          │
                  persistent WebSocket    opened by the CLI (outbound — no ports to open locally)
                          │
                          ▼
                    Tunnelly CLI          on your laptop
                          │
                          ▼
                 http://localhost:3000    your app
```

1. `npx tunnel 3000` checks your app is listening, then opens a WebSocket to
   `wss://example.com/_tunnelly/connect`.
2. The server creates a tunnel session (`tnl_…`) with a random hostname such as
   `k3x9q2ab.example.com` and sends back the public URL.
3. A browser request to that hostname reaches the server. The server gives it a
   request ID (`req_8f91a2…`), serializes method, path, query and headers, and streams
   them plus the body through the WebSocket.
4. The CLI replays the request against `http://localhost:3000`, then streams the
   status, headers and body back the same way. The server relays the response to
   the browser.
5. Every request is logged in the CLI and on the dashboard at `https://example.com`.

Other behaviour:

- **Heartbeats.** Both sides ping each other, so a dead connection is detected
  within about 45 seconds.
- **Reconnects.** When the connection drops, the CLI reconnects with exponential
  backoff (1s, 2s, 4s … up to 30s). If the server still holds the session, the
  **same public URL** is resumed. If the server restarted, you get a new URL and
  the CLI prints it.
- **Graceful stop.** Ctrl+C tells the server to release the tunnel immediately.
- **WebSockets.** Upgrade requests are forwarded too, so dev-server hot reload works.
- **One tunnel at a time.** A second CLI is rejected with a clear message.

---

## Using the CLI

```bash
npx tunnel 3000                 # expose localhost:3000
npx tunnel 5173 --host 127.0.0.1
npx tunnel 3000 --server http://localhost:4000   # point at a dev server
npx tunnel --help
```

| Option | Env var | Description |
|---|---|---|
| `--server <url>` | `TUNNELLY_SERVER` | Tunnelly server. Defaults to the URL baked in at build time. |
| `--host <host>` | | Local host to forward to (default `localhost`). |
| `--token <token>` | `TUNNELLY_TOKEN` | Only if the server sets `TUNNEL_CONNECT_TOKEN`. |
| `--skip-check` | | Start even if nothing is listening on the port yet. |
| `--debug` | `TUNNELLY_DEBUG=1` | Show detailed errors and reconnect reasons. |

Notes:

- **Host header.** The local app receives `Host: localhost:<port>`, because Vite,
  webpack and Next.js reject unknown hosts. The public hostname is still available
  in `X-Forwarded-Host`, along with `X-Forwarded-Proto: https` and `X-Forwarded-For`.
- **Request IDs.** Every response carries an `X-Tunnelly-Request-Id` header. It
  matches the ID shown on the dashboard.

---

## Local development

Requirements: Node.js 20.12+ (22 LTS recommended). No `.env` is needed for local development.

```bash
npm install
npm run build          # builds server + CLI (needed once for `npx tunnel`)
```

Then run each of these in its own terminal:

```bash
# 1. Tunnelly server on http://localhost:4000 (auto-restarts on changes)
npm run dev

# 2. The tiny test app on http://localhost:3000
npm run local-app

# 3. The CLI, from source (no build needed)
npm run cli -- 3000
#    …or the built CLI, exactly like production:
npx tunnel 3000
```

The CLI prints something like `http://k3x9q2ab.localhost:4000`. Browsers resolve
`*.localhost` to your machine, so you can open it directly. With curl:

```bash
curl http://k3x9q2ab.localhost:4000/api/test
curl -H 'content-type: application/json' -d '{"hi":1}' http://k3x9q2ab.localhost:4000/api/test
```

The dashboard is at <http://localhost:4000>.

The test app (`examples/local-app/server.mjs`) serves:

| Route | Response |
|---|---|
| `GET /` | `Hello from local application` |
| `GET /api/test` | JSON |
| `POST /api/test` | Echoes the JSON body |
| `GET /slow?ms=3000` | Delayed response |
| `GET /headers` | Echoes the received headers (shows `X-Forwarded-*`) |
| `GET /large?mb=10` | Large streamed body |
| `WS /ws` | WebSocket echo |

### Tests

```bash
npm test             # unit + end-to-end tests (node:test)
npm run typecheck
```

The tests cover:

- **End to end:** a real HTTP client → server → WebSocket → CLI → local app.
  Covers every HTTP method, headers and status codes, 8–10 MB streamed uploads and
  downloads, 413 for oversized bodies, 504 timeouts, 502 when the local app is
  down, and WebSocket forwarding.
- **Tunnel lifecycle:** rejecting a second tunnel, graceful shutdown, reconnect and
  resume, takeover of a stale half-open connection, server restart, backoff timing,
  heartbeat-based dead-connection detection on both sides, the handshake checks,
  and dashboard auth.
- **CLI units:** port validation, arguments, backoff, and the local port check.

---

## Domain setup (wildcard DNS)

Tunnelly needs two DNS records pointing at your VPS:

| Type | Name | Value |
|---|---|---|
| `A` | `example.com` | `203.0.113.10` (your VPS IPv4) |
| `A` | `*.example.com` | `203.0.113.10` |
| `AAAA` (optional) | both of the above | your VPS IPv6 |

`DOMAIN=example.com` in `.env` then gives you:

- `https://example.com`: the dashboard and the CLI endpoint.
- `https://<random>.example.com`: tunnels.

**Already using the apex domain for a website?** Use a subdomain instead. Set
`DOMAIN=tunnel.example.com` and create records for `tunnel` and `*.tunnel`.
Tunnels then look like `https://k3x9q2ab.tunnel.example.com`.

**Cloudflare users:** set both records to **DNS only** (grey cloud). Your own
reverse proxy terminates TLS, and Cloudflare's free certificates don't cover
nested wildcards like `*.tunnel.example.com`.

Check the records with:

```bash
dig +short example.com
dig +short anything.example.com     # both should print your VPS IP
```

---

## HTTPS setup

Node never handles TLS. A reverse proxy in front of it terminates HTTPS and
forwards everything, including WebSocket upgrades, to `127.0.0.1:4000`.

The **recommended setup is Caddy with a wildcard certificate**
([`deploy/Caddyfile`](deploy/Caddyfile)):

- Caddy obtains and renews `example.com` + `*.example.com` from Let's Encrypt automatically.
- A wildcard certificate requires the **DNS-01 challenge**, so Caddy needs your DNS
  provider's plugin and an API token. For Cloudflare:
  `sudo caddy add-package github.com/caddy-dns/cloudflare`.
- WebSocket upgrades, `Host` preservation and `X-Forwarded-*` headers work out of the box.

There are two alternatives:

- [`deploy/Caddyfile.on-demand`](deploy/Caddyfile.on-demand) needs **no DNS
  plugin**. Caddy fetches a certificate for each tunnel hostname on its first
  visit, and Tunnelly's `/_tunnelly/tls-check` endpoint approves only the active
  tunnel. The catch is Let's Encrypt's limit of 50 certificates per domain per week,
  because every new tunnel URL needs one.
- [`deploy/nginx.conf`](deploy/nginx.conf) uses nginx with a certbot wildcard
  certificate. It includes the `Upgrade`/`Connection` headers that WebSockets
  require. The CLI cannot connect without them.

---

## Production deployment

Summary below. The full walkthrough is in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

```bash
# 1. VPS: any small Ubuntu/Debian box (1 vCPU / 512 MB is plenty). Open ports 80 + 443.

# 2. Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git

# 3. Code
sudo useradd --system --home /opt/tunnelly --shell /usr/sbin/nologin tunnelly
sudo git clone <your-repo-url> /opt/tunnelly
cd /opt/tunnelly

# 4. Configure
sudo cp .env.example .env
sudo nano .env      # DOMAIN, SERVER_URL, DASHBOARD_PASSWORD
sudo chown -R tunnelly:tunnelly /opt/tunnelly
sudo chmod 600 .env

# 5. Install + build
sudo -u tunnelly npm ci
sudo -u tunnelly npm run build

# 6. Run with systemd
sudo cp deploy/tunnelly.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now tunnelly
curl -s localhost:4000/healthz         # {"ok":true}

# 7. Wildcard DNS: see "Domain setup" above.

# 8. Caddy + HTTPS
sudo apt install -y caddy              # see caddyserver.com/docs/install for the repo
sudo caddy add-package github.com/caddy-dns/cloudflare
sudo systemctl edit caddy              # [Service] Environment=CLOUDFLARE_API_TOKEN=...
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile && sudo nano /etc/caddy/Caddyfile
sudo systemctl restart caddy

# 9. Test, from your laptop
TUNNELLY_SERVER=https://example.com npx tunnel 3000
```

Updating later: `git pull && npm ci && npm run build && sudo systemctl restart tunnelly`.
Connected CLIs reconnect on their own.

PM2 also works if you prefer it:
`pm2 start server/dist/server.js --name tunnelly && pm2 save`.
It reads `.env` from the working directory.

---

## Using it from any computer

The goal is that a new machine needs nothing except `npx`. The CLI build bakes in
your server URL, taken from `TUNNELLY_SERVER` or `SERVER_URL` in `.env`, so no
flags or config files are needed afterwards.

> **About the name `tunnel`:** the npm package name `tunnel` already belongs to a
> popular HTTP-proxy library, so `npx tunnel` can't fetch this CLI from the npm
> registry. The CLI package is called **`tunnelly`** and installs two commands,
> `tunnel` and `tunnelly`.

Pick one:

1. **Publish to npm (recommended).** On any new computer you then run `npx tunnelly 3000`.
   ```bash
   TUNNELLY_SERVER=https://example.com npm run build -w cli
   npm publish -w cli            # `tunnelly` was unclaimed when this was written
   ```
   A scoped name such as `@yourname/tunnel` also works and gives `npx @yourname/tunnel 3000`.
2. **Global install.** Run `npm i -g tunnelly` once. After that, `tunnel 3000` works
   everywhere, without `npx`.
3. **Inside this repo.** `npx tunnel 3000` works as-is, because npm resolves the
   workspace binary.

---

## Configuration reference

Server settings come from environment variables. In production they live in
`.env`; see [`.env.example`](.env.example) for every option.

| Variable | Default | Purpose |
|---|---|---|
| `DOMAIN` | `localhost` | Tunnels at `<id>.DOMAIN`, dashboard at `DOMAIN`. |
| `SERVER_URL` | | Public server URL. Baked into the CLI at build time. |
| `PORT` / `HOST` | `4000` / `127.0.0.1` in production | Where Node listens. |
| `DASHBOARD_PASSWORD` | (required in production) | Basic auth for the dashboard. |
| `TUNNEL_CONNECT_TOKEN` | off | Optional shared secret the CLI must send. |
| `REQUEST_TIMEOUT_MS` | `60000` | 504 if the local app stays silent this long. |
| `MAX_REQUEST_BODY_MB` | `50` | Larger uploads get 413. |
| `HEARTBEAT_INTERVAL_MS` / `HEARTBEAT_TIMEOUT_MS` | `15000` / `45000` | Dead-connection detection. |
| `RESUME_GRACE_MS` | `120000` | How long a dropped tunnel's URL stays reserved for its CLI. |
| `REQUEST_LOG_LIMIT` | `1000` | Requests kept in memory for the dashboard. |
| `LOG_FORMAT` | `pretty` | `json` for structured logs. |

---

## Troubleshooting

**`✗ Cannot connect to localhost:3000`**
Nothing is listening on that port. Start your app first, or check the port.
If the app listens only on IPv4 or only on IPv6, try `--host 127.0.0.1` or `--host ::1`.
Use `--skip-check` to start the tunnel before the app.

**`✗ Invalid port.`**
The port must be a number from 1 to 65535: `npx tunnel 3000`.

**`✗ Unable to connect to Tunnelly server. Retrying…`**
- Check which server the CLI is using: `npx tunnel 3000 --debug`.
- `curl https://example.com/healthz` should return `{"ok":true}`. If it doesn't,
  check `systemctl status tunnelly caddy` and `journalctl -u tunnelly -n 50`.
- Make sure ports 80 and 443 are open (`sudo ufw allow 80,443/tcp`).

**WebSocket connection fails (`Unexpected server response: 400/404/502`)**
The reverse proxy isn't forwarding upgrades or the `Host` header. Caddy does both
by default. nginx needs `proxy_http_version 1.1`, the `Upgrade`/`Connection`
headers and `proxy_set_header Host $host`, as in `deploy/nginx.conf`.

**Public URL doesn't resolve / `DNS_PROBE_FINISHED_NXDOMAIN`**
The wildcard record is missing. `dig +short anything.example.com` must return your
VPS IP. New records can take a few minutes to propagate.

**HTTPS error (`NET::ERR_CERT_COMMON_NAME_INVALID`, handshake failure)**
- Check `journalctl -u caddy -n 100` for ACME errors. The usual causes are a missing
  DNS plugin or API token, or a token without `Zone:DNS:Edit` permission.
- The wildcard certificate must cover `*.DOMAIN`. A certificate for only `DOMAIN`
  does not cover tunnel hostnames.
- With Cloudflare, make sure the records are **DNS only**.

**`404 · Tunnel not found`**
That URL belongs to a tunnel that has stopped. Each run gets a fresh URL; check the CLI output.

**`502 · Tunnel offline`**
The CLI lost its connection and is reconnecting. If it reconnects within
`RESUME_GRACE_MS`, the same URL starts working again.

**`502 · Local application unavailable`**
The tunnel is up, but your app on `localhost:<port>` stopped or crashed.

**Tunnel keeps disconnecting**
Run with `--debug` to see the reasons. Proxies or firewalls that kill idle
connections are covered by the 15-second heartbeat. For nginx, check that
`proxy_read_timeout` is long (the config uses 1h).

**`✗ A tunnel is already active.`**
V1 allows one tunnel at a time. Stop the other CLI with Ctrl+C. If its machine
went offline, the server frees the tunnel automatically after about 45 seconds
plus `RESUME_GRACE_MS`.

---

## Project layout

```
tunnelly/
├── shared/                 wire protocol shared by server + CLI (bundled into both)
│   ├── protocol.ts         message types, error codes
│   ├── frames.ts           binary frame format for body chunks
│   ├── flow.ts             backpressure helper
│   └── headers.ts          hop-by-hop stripping, header redaction
├── server/
│   ├── src/
│   │   ├── config/         env → typed config
│   │   ├── tunnel/         TunnelManager (one-tunnel policy), Tunnel (session),
│   │   │                   TunnelConnection (HTTP forwarding, heartbeat), WsBridge
│   │   ├── websocket/      CLI handshake on /_tunnelly/connect
│   │   ├── routes/         dashboard JSON API
│   │   ├── middleware/     basic auth
│   │   ├── services/       request log store (in-memory; swappable)
│   │   ├── utils/          ids, logger, hosts, error pages
│   │   ├── app.ts          Express app (dashboard + API)
│   │   ├── tunnellyServer.ts  Host-based routing, wiring
│   │   └── server.ts       entry point
│   └── public/             dashboard (plain HTML/CSS/JS, no build step)
├── cli/
│   ├── bin/tunnel.js       bin entry (npx tunnel / tunnelly)
│   ├── build.mjs           esbuild bundle + baked default server URL
│   ├── src/
│   │   ├── commands/       `tunnel <port>`
│   │   ├── tunnel/         TunnelClient (reconnect/heartbeat), Local(Ws)Forwarder
│   │   ├── network/        local port check
│   │   ├── logger/         terminal UI
│   │   └── utils/          args, backoff, formatting
│   └── test/               CLI unit tests
├── examples/local-app/     tiny test app
├── test/                   end-to-end + lifecycle tests
├── deploy/                 Caddyfile(s), nginx.conf, systemd unit
└── docs/                   ARCHITECTURE.md, DEPLOYMENT.md
```
