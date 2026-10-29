// Tunnelly dashboard — plain JS, polls the JSON API every 2 seconds.
(() => {
  const $ = (id) => document.getElementById(id);
  const POLL_MS = 2000;

  let tunnel = null;
  let requests = [];
  let selectedId = null;

  const fmtBytes = (n) => {
    if (n < 1024) return `${n} B`;
    const units = ['KB', 'MB', 'GB'];
    let v = n / 1024, i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(1)} ${units[i]}`;
  };
  const fmtMs = (ms) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`);
  const fmtUptime = (ms) => {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const pad = (x) => String(x).padStart(2, '0');
    return h ? `${pad(h)}h ${pad(m)}m` : `${pad(m)}m ${pad(sec)}s`;
  };
  const fmtTime = (t) => new Date(t).toLocaleTimeString([], { hour12: false });
  const statusClass = (code) => `s${String(code)[0]}`;
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  async function getJson(url) {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`${res.status}`);
    return res.json();
  }

  function renderTunnel() {
    const t = tunnel;
    const status = t ? t.status : 'DISCONNECTED';
    $('status').textContent = t ? status[0] + status.slice(1).toLowerCase() : 'No tunnel';
    $('status-dot').className = `dot ${status}`;
    $('status-sub').textContent = !t
      ? 'Run npx tunnel <port>'
      : status === 'DISCONNECTED' && t.disconnectedAt
        ? `since ${fmtTime(t.disconnectedAt)}`
        : t.lastHeartbeatAt ? `heartbeat ${Math.max(0, Math.round((Date.now() - t.lastHeartbeatAt) / 1000))}s ago` : '';
    $('tunnel-id').textContent = t ? t.id : '';

    const link = $('public-url');
    if (t) { link.textContent = t.publicUrl; link.href = t.publicUrl; } else { link.textContent = '—'; link.removeAttribute('href'); }
    $('copy-url').hidden = !t;

    $('local').textContent = t ? `http://localhost:${t.localPort}` : '—';
    const live = t && status === 'CONNECTED' && t.connectedAt;
    $('uptime').textContent = live ? fmtUptime(Date.now() - t.connectedAt) : '—';
    $('reconnects').textContent = t && t.reconnects ? `${t.reconnects} reconnect${t.reconnects === 1 ? '' : 's'}` : '';
    $('requests').textContent = t ? t.requestCount.toLocaleString() : '—';
    $('bandwidth').textContent = t ? fmtBytes(t.bytesIn + t.bytesOut) : '—';
    $('bandwidth-split').textContent = t ? `↓ ${fmtBytes(t.bytesIn)}  ↑ ${fmtBytes(t.bytesOut)}` : '';
  }

  function renderRows() {
    const q = $('filter').value.trim().toLowerCase();
    const visible = q
      ? requests.filter((r) => `${r.method} ${r.path} ${r.status}`.toLowerCase().includes(q))
      : requests;
    $('rows').innerHTML = visible.map((r) => `
      <tr data-id="${esc(r.id)}" class="${r.id === selectedId ? 'selected' : ''}">
        <td class="muted">${fmtTime(r.startedAt)}</td>
        <td class="m">${esc(r.method)}</td>
        <td class="path" title="${esc(r.path)}">${esc(r.path)}${r.error ? `<span class="err">${esc(r.error)}</span>` : ''}</td>
        <td class="num ${statusClass(r.status)}">${r.status}</td>
        <td class="num">${fmtMs(r.durationMs)}</td>
        <td class="num muted">${fmtBytes(r.responseBytes)}</td>
      </tr>`).join('');
    $('empty').hidden = visible.length > 0;
    if (!visible.length && requests.length) $('empty').textContent = 'No requests match the filter.';
    else $('empty').textContent = 'No requests yet. Open your public URL to see traffic here.';
  }

  function headerBlock(headers) {
    const entries = Object.entries(headers || {});
    if (!entries.length) return '<pre class="headers muted">(none)</pre>';
    return `<pre class="headers">${entries
      .map(([k, v]) => `<span class="hn">${esc(k)}</span>: ${esc(Array.isArray(v) ? v.join(', ') : v)}`)
      .join('\n')}</pre>`;
  }

  async function showDetail(id) {
    selectedId = id;
    renderRows();
    try {
      const r = await getJson(`api/requests/${encodeURIComponent(id)}`);
      if (selectedId !== id) return;
      $('detail-title').textContent = `${r.method} ${r.path}`;
      $('detail-body').innerHTML = `
        <dl class="kv">
          <dt>Status</dt><dd class="${statusClass(r.status)}">${r.status}${r.error ? ` · ${esc(r.error)}` : ''}</dd>
          <dt>Duration</dt><dd>${fmtMs(r.durationMs)}</dd>
          <dt>Time</dt><dd>${new Date(r.startedAt).toLocaleString()}</dd>
          <dt>Request size</dt><dd>${fmtBytes(r.requestBytes)}</dd>
          <dt>Response size</dt><dd>${fmtBytes(r.responseBytes)}</dd>
          <dt>Client IP</dt><dd>${esc(r.clientIp || '—')}</dd>
          <dt>Request ID</dt><dd>${esc(r.id)}</dd>
        </dl>
        <h4>Request headers</h4>${headerBlock(r.requestHeaders)}
        <h4>Response headers</h4>${headerBlock(r.responseHeaders)}`;
      $('detail').hidden = false;
      document.querySelector('.layout').classList.add('with-detail');
    } catch {
      $('detail-title').textContent = 'Request no longer available';
      $('detail-body').innerHTML = '';
      $('detail').hidden = false;
    }
  }

  function hideDetail() {
    selectedId = null;
    $('detail').hidden = true;
    document.querySelector('.layout').classList.remove('with-detail');
    renderRows();
  }

  async function poll() {
    try {
      const [status, list] = await Promise.all([getJson('api/status'), getJson('api/requests?limit=300')]);
      tunnel = status.tunnel;
      requests = list.requests;
      $('server-domain').textContent = status.server.publicUrl;
      renderTunnel();
      renderRows();
    } catch {
      $('status').textContent = 'Server unreachable';
      $('status-dot').className = 'dot DISCONNECTED';
    } finally {
      setTimeout(poll, POLL_MS);
    }
  }

  $('rows').addEventListener('click', (e) => {
    const row = e.target.closest('tr[data-id]');
    if (row) showDetail(row.dataset.id);
  });
  $('detail-close').addEventListener('click', hideDetail);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideDetail(); });
  $('filter').addEventListener('input', renderRows);
  $('copy-url').addEventListener('click', async () => {
    if (!tunnel) return;
    try {
      await navigator.clipboard.writeText(tunnel.publicUrl);
      $('copy-url').textContent = 'Copied';
      setTimeout(() => ($('copy-url').textContent = 'Copy'), 1200);
    } catch { /* clipboard unavailable (http) */ }
  });
  setInterval(renderTunnel, 1000); // keep "connected for" ticking between polls

  poll();
})();
