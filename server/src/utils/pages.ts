import type { ServerResponse } from 'node:http';
import { APP_PREFIX } from '../../../shared/protocol.js';

/**
 * What a visitor sees when the tunnel can't serve their request.
 *
 * Every "down" page uses 503: Cloudflare (and some other proxies) replace an
 * origin's 502/504 responses with their own error page, hiding this one.
 */
export interface DownPage {
  status: number;
  /** Short machine-ish label, also used in request logs ("Gateway timeout"). */
  label: string;
  /** Friendly headline for visitors. */
  title: string;
  detail: string;
  /** Steps for the developer. `backticks` render as code. */
  steps: string[];
  /** Reload automatically (only for GET/HEAD) — the app appears once it's back. */
  autoRetry?: boolean;
}

// ── The situations ──────────────────────────────────────────────────────────

export const downPages = {
  noTunnel: (): DownPage => ({
    status: 503,
    label: 'No tunnel running',
    title: 'Nobody’s home right now',
    detail: 'The tunnel is closed — the Tunnelly CLI on the developer’s computer isn’t running.',
    steps: [
      'Start your app locally (for example on port 3000).',
      'Run `npx tunnelly 3000` and keep the terminal open.',
      'This page reloads by itself once the tunnel is back.',
    ],
    autoRetry: true,
  }),

  reconnecting: (): DownPage => ({
    status: 503,
    label: 'Tunnel offline',
    title: 'Lost the connection to the developer’s computer',
    detail: 'The Tunnelly CLI dropped off — usually the internet went away for a moment. It reconnects automatically.',
    steps: [
      'Check that the computer running the CLI is online.',
      'Watch the CLI — it shows `Reconnecting…` and then `Reconnected`.',
      'If the CLI was closed, run `npx tunnelly 3000` again.',
    ],
    autoRetry: true,
  }),

  disconnected: (): DownPage => ({ ...downPages.reconnecting(), label: 'Tunnel disconnected' }),

  localDown: (port: number): DownPage => ({
    status: 503,
    label: 'Local application unavailable',
    title: 'The app on the other end isn’t running',
    detail: `The tunnel is up, but nothing answered on localhost:${port}.`,
    steps: [
      `Start your app on port ${port}.`,
      `Check it responds: \`curl http://localhost:${port}\``,
      'Different port? Stop the CLI and run `npx tunnelly <port>`.',
    ],
    autoRetry: true,
  }),

  localError: (port: number, message: string): DownPage => ({
    status: 503,
    label: 'Local application error',
    title: 'The app hit a problem',
    detail: `The connection to localhost:${port} broke while answering: ${message}`,
    steps: ['Check your app’s terminal for errors or a crash.', 'Reload this page once it’s fixed.'],
  }),

  invalidResponse: (message: string): DownPage => ({
    status: 503,
    label: 'Invalid response from local application',
    title: 'The app sent something unexpected',
    detail: `Its response couldn’t be passed on: ${message}`,
    steps: ['Check the response headers your app sends for this route.'],
  }),

  timeout: (port: number, seconds: number): DownPage => ({
    status: 503,
    label: 'Gateway timeout',
    title: 'The app is taking too long',
    detail: `localhost:${port} didn’t answer within ${seconds} seconds.`,
    steps: [
      'Check your app’s logs for a stuck or very slow request.',
      'Expecting slow responses? Raise `REQUEST_TIMEOUT_MS` on the server.',
    ],
  }),

  tooLarge: (limitBytes: number): DownPage => ({
    status: 413,
    label: 'Request body too large',
    title: 'That upload is too big',
    detail: `The tunnel accepts up to ${Math.round(limitBytes / 1024 / 1024)} MB per request.`,
    steps: ['Raise `MAX_REQUEST_BODY_MB` on the server if you need bigger uploads.'],
  }),
};

// ── Rendering ───────────────────────────────────────────────────────────────

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const withCode = (s: string) => escape(s).replace(/`([^`]+)`/g, '<code>$1</code>');

/** Sad little tunnel-digging mole whose helmet lamp went out. */
const MASCOT = `<svg class="mascot" viewBox="0 0 160 150" role="img" aria-label="A sad mole in a hard hat">
  <ellipse cx="80" cy="132" rx="66" ry="13" fill="var(--hole)"/>
  <path d="M36 134V84a44 44 0 0 1 88 0v50z" fill="var(--fur)"/>
  <ellipse cx="80" cy="127" rx="24" ry="8" fill="var(--belly)"/>
  <path d="M46 58a34 28 0 0 1 68 0z" fill="var(--hat)"/>
  <rect x="40" y="56" width="80" height="8" rx="4" fill="var(--hat-dark)"/>
  <circle cx="80" cy="44" r="7" fill="var(--lamp)" stroke="var(--hat-dark)" stroke-width="2.5"/>
  <path d="M54 77l13-5M106 77l-13-5" stroke="var(--ink)" stroke-width="3" stroke-linecap="round"/>
  <circle cx="64" cy="84" r="5" fill="var(--ink)"/><circle cx="96" cy="84" r="5" fill="var(--ink)"/>
  <circle cx="65.6" cy="82.4" r="1.6" fill="#fff"/><circle cx="97.6" cy="82.4" r="1.6" fill="#fff"/>
  <path class="tear" d="M60 92q-5 7 0 10q5-3 0-10z" fill="var(--tear)"/>
  <ellipse cx="80" cy="96" rx="7.5" ry="5.5" fill="var(--nose)"/>
  <path d="M71 109q9-7 18 0" fill="none" stroke="var(--ink)" stroke-width="3" stroke-linecap="round"/>
  <ellipse cx="50" cy="131" rx="12" ry="7" fill="var(--paw)"/><ellipse cx="110" cy="131" rx="12" ry="7" fill="var(--paw)"/>
</svg>`;

function renderHtml(page: DownPage, requestId: string | undefined, autoRetry: boolean): string {
  const steps = page.steps.map((s) => `<li>${withCode(s)}</li>`).join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(page.title)} · Tunnelly</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--border:#e3e6eb;--text:#454d58;--strong:#14181f;--muted:#7a8390;--accent:#2f6fde;--code-bg:#eef1f5;
--hole:#2b2f36;--fur:#8a7a6c;--belly:#b9aa9b;--paw:#d9a3a8;--nose:#e98fa2;--ink:#20232a;--hat:#f2b84b;--hat-dark:#c98f22;--lamp:#9aa1aa;--tear:#5aa9f0}
@media (prefers-color-scheme:dark){:root{--bg:#0b0e13;--card:#11151c;--border:#232a35;--text:#c3cad3;--strong:#f2f5f8;--muted:#7d8794;--accent:#58a6ff;--code-bg:#1a212b;--hole:#05070a;--lamp:#5c636c}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px 16px;background:var(--bg);color:var(--text);font:15px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{width:100%;max-width:480px;text-align:center}
.mascot{width:170px;height:auto;display:block;margin:0 auto 12px}
.tear{animation:drip 2.4s ease-in infinite}
@keyframes drip{0%,55%{transform:translateY(0);opacity:1}100%{transform:translateY(14px);opacity:0}}
@media (prefers-reduced-motion:reduce){.tear{animation:none}}
.eyebrow{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted);letter-spacing:.02em}
h1{margin:6px 0 8px;font-size:22px;line-height:1.3;color:var(--strong)}
.detail{margin:0 0 22px}
.card{text-align:left;background:var(--card);border:1px solid var(--border);border-radius:10px;padding:16px 18px}
.card h2{margin:0 0 8px;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--muted)}
ol{margin:0;padding-left:20px}li{margin:4px 0}
code{font:13px ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--code-bg);color:var(--strong);padding:1px 6px;border-radius:4px;white-space:nowrap}
.foot{margin-top:16px;font-size:13px;color:var(--muted);display:flex;flex-wrap:wrap;gap:6px 14px;justify-content:center}
.foot a{color:var(--accent);text-decoration:none}.foot a:hover{text-decoration:underline}
.foot .id{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
</style></head>
<body><main>
${MASCOT}
<div class="eyebrow">${page.status} · ${escape(page.label)}</div>
<h1>${escape(page.title)}</h1>
<p class="detail">${withCode(page.detail)}</p>
<section class="card"><h2>If you’re the developer</h2><ol>${steps}</ol></section>
<div class="foot">
${autoRetry ? '<span id="retry">Checking again in 5s…</span>' : ''}
${requestId ? `<span class="id">${escape(requestId)}</span>` : ''}
<a href="${APP_PREFIX}/">Dashboard</a>
</div>
</main>
${
  autoRetry
    ? `<script>let s=5;const el=document.getElementById('retry');const t=setInterval(()=>{s--;if(s<=0){clearInterval(t);location.reload()}else el.textContent='Checking again in '+s+'s…'},1000)</script>`
    : ''
}
</body></html>`;
}

/**
 * Answer with a "down" page: friendly HTML for browsers, JSON for API clients.
 * If the response already started, the connection is simply cut.
 */
export function sendDownPage(res: ServerResponse, page: DownPage, requestId?: string): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const req = res.req;
  const accept = String(req?.headers.accept ?? '');
  const wantsJson = accept.includes('application/json') && !accept.includes('text/html');
  const method = req?.method ?? 'GET';
  const autoRetry = Boolean(page.autoRetry) && (method === 'GET' || method === 'HEAD');

  const body = wantsJson
    ? JSON.stringify({ error: page.label, message: page.detail, status: page.status, ...(requestId ? { requestId } : {}) })
    : renderHtml(page, requestId, autoRetry);

  res.writeHead(page.status, {
    'content-type': wantsJson ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...(page.status === 503 ? { 'retry-after': '5' } : {}), // all down pages
    ...(requestId ? { 'x-tunnelly-request-id': requestId } : {}),
  });
  res.end(body);
}
