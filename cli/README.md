# tunnelly

Share your local app on your own HTTPS URL.

```bash
npm i -g tunnelly
tunnelly 3000
```

```
  ✓ Connected to Tunnelly

  Local:   http://localhost:3000
  Public:  https://tunnelly.yoni-tad.com

  Status:  ● Connected

  14:02:11  GET     /                200    24ms    4.2 KB
  14:02:12  POST    /api/login       201    83ms    1.1 KB
```

Open the public URL from any device and it reaches your app on `localhost:3000`.
Press **Ctrl+C** to stop.

You can also run it without installing: `npx tunnelly@latest 3000`.

## Options

```
tunnelly <port> [options]

  --server <url>   Tunnelly server (default: https://tunnelly.yoni-tad.com)
  --host <host>    Local host to forward to (default: localhost)
  --token <token>  Connect token, if the server requires one
  --skip-check     Start even if nothing is listening on the port yet
  --debug          Show detailed errors
  -v, --version    Show version
```

Environment variables: `TUNNELLY_SERVER`, `TUNNELLY_TOKEN`, `TUNNELLY_DEBUG=1`.

## Good to know

- One tunnel at a time. A second one is refused until the first one stops.
- If your internet drops, the CLI reconnects by itself.
- WebSockets work, so hot reload (Vite, Next.js) works through the tunnel.
- Your app receives `Host: localhost:<port>`. The public host is in `X-Forwarded-Host`.
- Requests appear in the terminal and on the dashboard at `<server>/_tunnelly/`.

## Troubleshooting

- **`Connecting to http://localhost:4000`** means you have an old version. Run
  `npm i -g tunnelly@latest`. The first line shows the version, for example `(v1.0.2)`.
- **`Cannot connect to localhost:3000`**: start your app first, or check the port.
- **`A tunnel is already active`**: stop the other `tunnelly` (Ctrl+C).
- **A shell alias called `tunnel`** takes priority over this package's `tunnel`
  command. Use `tunnelly` instead.

## Run your own server

The server is open source: <https://github.com/yoni-tad/tunnelly>.
Deploy it (Docker / Dokploy), then point the CLI at it with `--server https://your-domain`.

MIT License
