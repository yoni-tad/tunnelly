# Deploying Tunnelly to a VPS

This guide takes a fresh Ubuntu 22.04/24.04 (or Debian 12) VPS to a working
`https://<random>.example.com` tunnel. Replace `example.com` with your domain
throughout. Plan on about 20 minutes.

```
                DNS: example.com, *.example.com → VPS
                             │
                             ▼
                ┌──────────────────────────┐
                │ VPS                      │
                │  Caddy  :80 / :443       │  TLS (Let's Encrypt), WebSocket upgrades
                │    │                     │
                │    ▼ 127.0.0.1:4000      │
                │  Tunnelly (systemd)      │
                └────┬─────────────────────┘
                     │ WebSocket (wss://example.com/_tunnelly/connect)
                     ▼
                Your laptop: npx tunnel 3000 → localhost:3000
```

## 1. Create the VPS

Any provider works (Hetzner, DigitalOcean, Vultr, Lightsail…). The smallest
instance is plenty: Tunnelly uses about 50 MB of RAM. Note the public IPv4 (and IPv6).

Open only SSH, HTTP and HTTPS:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80,443/tcp
sudo ufw enable
```

Port 4000 stays closed. Node listens on `127.0.0.1` and only Caddy talks to it.

## 2. Install Node.js

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git
node -v    # v22.x
```

## 3. Clone the project

```bash
sudo useradd --system --home /opt/tunnelly --shell /usr/sbin/nologin tunnelly
sudo git clone <your-repo-url> /opt/tunnelly
```

## 4. Configure environment variables

```bash
cd /opt/tunnelly
sudo cp .env.example .env
sudo nano .env
```

Set at least:

```ini
DOMAIN=example.com
SERVER_URL=https://example.com
PORT=4000
HOST=127.0.0.1
NODE_ENV=production
DASHBOARD_PASSWORD=<a long random string>     # openssl rand -base64 24
```

Optionally set `TUNNEL_CONNECT_TOKEN=<random>`. It stops anyone else from opening
a tunnel on your domain while yours is idle. If you set it, the CLI needs
`TUNNELLY_TOKEN` set to the same value.

```bash
sudo chown -R tunnelly:tunnelly /opt/tunnelly
sudo chmod 600 /opt/tunnelly/.env
```

## 5. Install dependencies and build

```bash
cd /opt/tunnelly
sudo -u tunnelly npm ci
sudo -u tunnelly npm run build
```

This produces `server/dist/server.js` and `cli/dist/index.js`. The CLI build has
`SERVER_URL` baked in.

## 6. Run the server with systemd

```bash
sudo cp deploy/tunnelly.service /etc/systemd/system/tunnelly.service
sudo systemctl daemon-reload
sudo systemctl enable --now tunnelly

systemctl status tunnelly
journalctl -u tunnelly -f            # [INFO] Server started on 127.0.0.1:4000
curl -s http://127.0.0.1:4000/healthz   # {"ok":true}
```

If you prefer PM2, run these instead of the systemd steps:

```bash
sudo npm i -g pm2
cd /opt/tunnelly && pm2 start server/dist/server.js --name tunnelly
pm2 save && pm2 startup
```

## 7. Configure wildcard DNS

At your DNS provider, create:

| Type | Name | Value |
|---|---|---|
| A | `example.com` (`@`) | VPS IPv4 |
| A | `*.example.com` (`*`) | VPS IPv4 |
| AAAA (optional) | `@` and `*` | VPS IPv6 |

On Cloudflare, set both records to **DNS only** (grey cloud).

To keep the apex for a website, use `DOMAIN=tunnel.example.com` with
records `tunnel` and `*.tunnel` instead.

Verify the records:

```bash
dig +short example.com
dig +short test123.example.com    # both → your VPS IP
```

## 8. Configure Caddy and HTTPS

### Option A (recommended): wildcard certificate via DNS-01

Install Caddy from its official repository
(see <https://caddyserver.com/docs/install#debian-ubuntu-raspbian>):

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

Add your DNS provider's plugin. This example uses Cloudflare; other providers are listed at
<https://github.com/caddy-dns>:

```bash
sudo caddy add-package github.com/caddy-dns/cloudflare
sudo apt-mark hold caddy      # stop apt upgrades from replacing the custom binary
```

Create a Cloudflare API token (**My Profile → API Tokens → Edit zone DNS**,
limited to your zone) and give it to Caddy:

```bash
sudo systemctl edit caddy
```

```ini
[Service]
Environment=CLOUDFLARE_API_TOKEN=your-token-here
```

Install the config:

```bash
sudo cp /opt/tunnelly/deploy/Caddyfile /etc/caddy/Caddyfile
sudo sed -i 's/example\.com/YOUR-DOMAIN/g; s/you@YOUR-DOMAIN/you@your-email.com/' /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile        # double-check domain + email
caddy validate --config /etc/caddy/Caddyfile
sudo systemctl restart caddy
journalctl -u caddy -f                # watch for "certificate obtained successfully"
```

### Option B: no DNS plugin (on-demand certificates)

Use `deploy/Caddyfile.on-demand` with a stock Caddy instead. Each new tunnel
hostname gets its own certificate on first visit, which takes a few seconds once.
Let's Encrypt allows 50 certificates per domain per week.

### Option C: nginx

See `deploy/nginx.conf`. Get a wildcard certificate with certbot and a DNS plugin:

```bash
sudo apt install -y nginx certbot python3-certbot-dns-cloudflare
sudo certbot certonly --dns-cloudflare --dns-cloudflare-credentials /root/.secrets/cloudflare.ini \
  -d example.com -d '*.example.com'
sudo cp /opt/tunnelly/deploy/nginx.conf /etc/nginx/conf.d/tunnelly.conf   # edit the domain
sudo nginx -t && sudo systemctl reload nginx
```

### Required for any proxy: WebSocket upgrades

The CLI's control connection is a WebSocket. A proxy that doesn't forward
`Upgrade: websocket` breaks every tunnel. Caddy forwards upgrades automatically.
nginx needs the `Upgrade`/`Connection` headers and `proxy_http_version 1.1`, which
are already in `deploy/nginx.conf`. The proxy must also preserve the `Host` header,
because Tunnelly routes by hostname.

## 9. Test the tunnel

From your laptop:

```bash
curl https://example.com/healthz                     # {"ok":true}

# in one terminal
npm run local-app                                    # or any app on :3000
# in another
TUNNELLY_SERVER=https://example.com npx tunnel 3000
```

Open the printed `https://xxxxxxxx.example.com` from your phone. The request
should appear in the CLI and on the dashboard at `https://example.com`.
The dashboard asks for `DASHBOARD_PASSWORD`; any username works.

Test reconnects by turning Wi-Fi off for about 10 seconds. The CLI shows
`Disconnected` and `Reconnecting…`, then `Reconnected`, usually on the same URL.

## 10. Make `npx` work from any computer

See [README → Using it from any computer](../README.md#using-it-from-any-computer).
In short: build the CLI with your server URL baked in, then publish it to npm.

```bash
TUNNELLY_SERVER=https://example.com npm run build -w cli
npm publish -w cli
# anywhere: npx tunnelly 3000
```

## Updating

```bash
cd /opt/tunnelly
sudo -u tunnelly git pull
sudo -u tunnelly npm ci
sudo -u tunnelly npm run build
sudo systemctl restart tunnelly
```

Active CLIs see `server restarting` and reconnect with a new URL.
