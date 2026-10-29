# Tunnelly

Expose your local app on your own URL:

```bash
npx tunnel 3000
```

```
  ✓ Connected to Tunnelly

  Local:   http://localhost:3000
  Public:  https://tunnelly.yoni-tad.com

  Status:  ● Connected

  14:02:11  GET     /                      200    24ms    4.2 KB
  14:02:12  POST    /api/login             201    83ms    1.1 KB
```

V1 is deliberately small: **one server, one URL, one tunnel at a time**, no accounts.

| URL | What |
|---|---|
| `https://tunnelly.yoni-tad.com/…` | Your local app (whatever is running behind `npx tunnel`) |
| `https://tunnelly.yoni-tad.com/_tunnelly/` | Dashboard: status and request logs (password protected) |

## Deploy (Dokploy)

1. **DNS:** add an `A` record `tunnelly` → your Dokploy server's IP.
2. **Dokploy → Create Application**
   - Source: your Git repo, branch `main`.
   - Build type: **Dockerfile** (path `./Dockerfile`).
3. **Environment** tab:
   ```
   PUBLIC_URL=https://tunnelly.yoni-tad.com
   DASHBOARD_PASSWORD=<something long>
   ```
4. **Domains** tab: host `tunnelly.yoni-tad.com`, container port **4000**, HTTPS on,
   certificate **Let's Encrypt**.
5. **Deploy.** Open `https://tunnelly.yoni-tad.com/_tunnelly/health` and it should show `{"ok":true}`.

Dokploy's Traefik handles HTTPS and WebSockets for you; nothing else to configure.
Every `git push` can redeploy (enable Auto Deploy in Dokploy). Running CLIs
reconnect on their own.

## Use the CLI

Once, in this repo on your laptop:

```bash
npm install
TUNNELLY_SERVER=https://tunnelly.yoni-tad.com npm run build -w cli
```

This bakes your server URL into the CLI, so after that no flags or config are needed.
Pick how you want to run it:

- **In this repo:** `npx tunnel 3000`
- **Anywhere on this computer:** `npm i -g ./cli`, then `tunnel 3000`
- **Any computer, zero setup:** `npm publish -w cli` once, then `npx tunnelly 3000`.
  The CLI's npm package is named `tunnelly` because the name `tunnel` is taken on npm.

Options: `--server <url>`, `--host <host>` (default `localhost`), `--skip-check`,
`--debug`, `--help`.

## How it works

```
Browser → https://tunnelly.yoni-tad.com → Traefik (HTTPS) → Tunnelly server
                                                                 │ WebSocket
                                                                 ▼
                                                   npx tunnel 3000 → localhost:3000
```

- The CLI opens a WebSocket to the server; the server streams each request through it.
  The CLI calls `http://localhost:3000` and streams the response back.
- Every request gets an ID (`req_…`), shown in the CLI, on the dashboard, and in the
  `X-Tunnelly-Request-Id` response header.
- **Reconnects:** if your network drops, the CLI reconnects with backoff (1s, 2s, 4s … max 30s).
- **Ctrl+C** frees the tunnel immediately.
- **One tunnel at a time:** a second CLI gets `✗ A tunnel is already active.`
- WebSockets (e.g. hot reload) are forwarded too.
- Your app receives `Host: localhost:<port>` (dev servers like Vite require it); the
  public host is in `X-Forwarded-Host`.
- Paths starting with `/_tunnelly/` belong to Tunnelly and are not forwarded.

## Local development

```bash
npm install
npm run dev              # Tunnelly server  → http://localhost:4000
npm run local-app        # test app         → http://localhost:3000
npm run cli -- 3000      # CLI from source  → public URL http://localhost:4000
```

Then open <http://localhost:4000> to see the test app through the tunnel, and
<http://localhost:4000/_tunnelly/> for the dashboard. No `.env` is needed locally.

The test app has `GET /`, `GET|POST /api/test`, `/slow?ms=3000`, `/headers`,
`/large?mb=10` and a WebSocket echo at `/ws`.

```bash
npm test          # unit + end-to-end tests
npm run typecheck
```

## Settings

| Variable | Default | |
|---|---|---|
| `PUBLIC_URL` | `http://localhost:4000` | Your public URL. |
| `DASHBOARD_PASSWORD` | (required in production) | Dashboard login, any username. |
| `TUNNEL_CONNECT_TOKEN` | off | Optional: CLI must send it (`TUNNELLY_TOKEN` env or `--token`). Without it, anyone who finds your server can use it while your tunnel is off. |
| `REQUEST_TIMEOUT_MS` | `60000` | 504 if your app is silent this long. |
| `MAX_REQUEST_BODY_MB` | `50` | Bigger uploads get 413. |
| `PORT` | `4000` | Container port. |

## Troubleshooting

| You see | Fix |
|---|---|
| `✗ Cannot connect to localhost:3000` | Start your app first (or `--host 127.0.0.1`, or `--skip-check`). |
| `✗ Unable to connect to Tunnelly server` | Check `https://tunnelly.yoni-tad.com/_tunnelly/health` and the Dokploy logs. Run the CLI with `--debug` to see which server it uses. |
| `✗ A tunnel is already active.` | Stop the other CLI. If that machine went offline, the tunnel frees itself within about 3 minutes. |
| Browser shows **No tunnel running** (503) | The server works; start `npx tunnel 3000`. |
| Browser shows **Tunnel offline** (502) | The CLI is reconnecting. |
| Browser shows **Local application unavailable** (502) | The tunnel is up but your app stopped. |
| Certificate or HTTPS error | Check that the DNS `A` record points at the Dokploy server, and the domain's HTTPS / Let's Encrypt setting in Dokploy. |

More detail: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
