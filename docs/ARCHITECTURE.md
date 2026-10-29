# Architecture & design decisions

## Components

| Part | Responsibility |
|---|---|
| **Reverse proxy** (Caddy/nginx) | TLS termination, certificates, WebSocket upgrades. Node never sees TLS. |
| **Server** (`server/`) | Routes by `Host`. `DOMAIN` serves the Express dashboard, API and CLI endpoint. `<id>.DOMAIN` goes to the tunnel. Holds tunnel state and request logs. |
| **CLI** (`cli/`) | Keeps one WebSocket open to the server, replays requests against `localhost`, prints logs, reconnects. |
| **Shared** (`shared/`) | Wire protocol, frame encoding, backpressure and header helpers. esbuild bundles it into each side, so the CLI publishes as a single file. |

Tunnel traffic never passes through Express middleware. The raw Node `http`
handler forwards it, so bodies stream untouched.

## Wire protocol

There is one WebSocket per tunnel: `wss://DOMAIN/_tunnelly/connect`.

- **Text frames** carry JSON control messages (see `shared/protocol.ts`).
- **Binary frames** carry body chunks: `[kind u8][idLen u8][request id][payload]`.

```
CLI                                   Server
 │── hello {version, localPort, resume?} ──▶│
 │◀── ready {tunnelId, publicUrl, sessionToken, resumed}
 │                                         │◀── GET https://abc.example.com/users
 │◀── request-start {id, method, path, headers}
 │◀── BODY frames (request body, if any)
 │◀── request-end {id}
 │      → http://localhost:3000/users
 │── response-start {id, status, headers} ─▶│
 │── BODY frames (response body) ──────────▶│ → streamed to the browser
 │── response-end {id} ────────────────────▶│
```

Other messages:

- `request-abort`: the browser went away, so the CLI cancels the local request.
- `response-error`: the local app is unreachable or failed. The server answers 502.
- `flow {id, paused}`: backpressure (see below).
- `ws-open` / `ws-accept` / `ws-reject` / `ws-close` and WS frames: forwarded WebSockets.
- `shutdown`: Ctrl+C. The server releases the tunnel immediately.
- `error {code}`: handshake rejections, with the codes `TUNNEL_ACTIVE`,
  `UNAUTHORIZED`, `UNSUPPORTED_VERSION`, `BAD_HELLO` and `HELLO_TIMEOUT`.

Every exchange carries a **request ID** (`req_` + 12 hex characters). It appears
in server logs, CLI logs, the dashboard and the `X-Tunnelly-Request-Id` response
header, so one request can be followed across every hop.

## Decisions

**WebSocket over TCP multiplexing (yamux, HTTP/2).**
WebSocket gets through every proxy and CDN. `ws` is the only runtime dependency,
and requests are multiplexed by ID with no extra library.

**Streaming instead of buffering.**
Bodies travel as chunks and are never assembled in memory. Backpressure works at two levels:

1. **Socket level.** When the WebSocket send buffer passes 4 MB, the source stream
   pauses until it drains below 1 MB (`shared/flow.ts`).
2. **Per request.** When the receiving side's destination is slow (`write()` returns
   false), it sends `flow {paused: true}` and the sender pauses that one request.

Limits: `MAX_REQUEST_BODY_MB` (413), and a 64 MB WebSocket message cap. Response
bodies have no size limit, since they stream.

**Idle timeout instead of a fixed timeout.**
`REQUEST_TIMEOUT_MS` restarts with every uploaded chunk and stops once the local
app begins responding. A slow 50 MB upload is fine, but a hung app gets a 504.
Long streaming responses (SSE, downloads) are never cut off.

**Heartbeats on both sides.**
The server pings every 15s and terminates a CLI that has been silent for 45s. The
CLI does the same in the other direction. This matters after a Wi-Fi drop, when
the TCP socket can look open for minutes while nothing gets through.

**Session resume instead of permanent URLs.**
On `ready`, the server issues a random 256-bit `sessionToken`. The token lives
only in the CLI's memory and is never logged or exposed by the API. After an
unexpected drop, the server marks the tunnel `DISCONNECTED` but keeps its hostname
reserved for `RESUME_GRACE_MS`. A reconnect that presents the token gets the same
URL back. If the server still believes the old socket is alive (half-open), the
stale socket is replaced. Any connection without the token is rejected while the
tunnel is active, so nobody can take it over by accident. After a server restart
the token is unknown, so the CLI gets a new URL and says so.

The grace period does **not** block new tunnels. Only a `CONNECTED` tunnel
causes a `TUNNEL_ACTIVE` rejection.

**One tunnel at a time.**
`TunnelManager` holds a single `active` tunnel. Supporting several later means
turning it into a `Map<subdomain, Tunnel>` and replacing the rejection with a
per-account limit. Routing already looks tunnels up by subdomain.

**In-memory request logs instead of PostgreSQL.**
Logs are a ring buffer of the last 1000 requests behind the `RequestLogStore`
interface. Persistence wasn't needed for V1. A Postgres-backed store can implement
the same interface later. Request bodies are never stored, and `Authorization`,
`Cookie`, `Set-Cookie` and `X-API-Key` are redacted in stored headers.

**Host header rewrite.**
The local app receives `Host: localhost:<port>`, because Vite, webpack and Next.js
reject unknown hosts by default. The public host goes in `X-Forwarded-Host`.

**Hop-by-hop headers.**
`Connection`, `Keep-Alive`, `Transfer-Encoding`, `Upgrade`, `TE`, `Trailer`,
`Proxy-*`, and any header that `Connection` nominates are stripped in both
directions. Everything else passes through unchanged, including `Content-Length`,
`Content-Encoding` and repeated `Set-Cookie` headers.

**Dashboard auth.**
A single `DASHBOARD_PASSWORD` protects the dashboard with HTTP Basic auth, which
needs no login page or sessions. The server refuses to start in production without it.

**No API keys.**
The optional `TUNNEL_CONNECT_TOKEN` is a single shared secret, not key
management. It exists because an open tunnel server lets anyone serve content on
your domain while your tunnel is idle.

**Dashboard without a build step.**
The dashboard is plain HTML, CSS and JS that polls `/api/status` and
`/api/requests` every 2 seconds. Polling is simpler than SSE and survives any proxy.

**The `tunnel` npm name.**
The name is taken by an unrelated library. The package is `tunnelly` with `tunnel`
and `tunnelly` bins. Its bin points at a committed shim (`cli/bin/tunnel.js`), so
npm can link it before the bundle has been built.

## Where future features plug in

| Future | Where |
|---|---|
| Accounts + API keys | Validate in `websocket/controlServer.ts` (the handshake already checks a token). Add `ownerId` to `Tunnel`. |
| Permanent subdomains | `TunnelManager.register`: pick the subdomain from the account instead of `newSubdomain()`. |
| Multiple tunnels | `TunnelManager.active` becomes a map. `findBySubdomain` already exists. |
| Teams / billing | Live entirely above the account layer. The tunnel core doesn't change. |
| Persistent logs | Implement `RequestLogStore` with PostgreSQL. |
