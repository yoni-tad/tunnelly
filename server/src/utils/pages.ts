import type { ServerResponse } from 'node:http';

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Minimal error page shown to browsers when the tunnel can't serve a request. */
export function sendErrorPage(res: ServerResponse, status: number, title: string, detail: string, requestId?: string): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${status} · ${escape(title)}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0d1117;color:#c9d1d9;font:15px/1.6 ui-sans-serif,system-ui,sans-serif}
main{max-width:520px;padding:24px}h1{font-size:18px;margin:0 0 8px;color:#f0f6fc}code{font:13px ui-monospace,SFMono-Regular,Menlo,monospace;color:#8b949e}</style></head>
<body><main><code>Tunnelly · ${status}</code><h1>${escape(title)}</h1><p>${escape(detail)}</p>${
    requestId ? `<code>${escape(requestId)}</code>` : ''
  }</main></body></html>`;
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...(requestId ? { 'x-tunnelly-request-id': requestId } : {}),
  });
  res.end(body);
}
