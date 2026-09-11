/* STANDIN api-bridge — live-backend layer for the product pages.
 * Same-origin when served by the API, localhost fallback for file:// use.
 * Every call degrades to null/false when the backend is unreachable, and
 * callers keep their local demo state as the fallback. No build step.
 */
(function () {
  // Broken-image safety net (CDN blocked, offline, dead seed): swap any
  // failed <img> for a branded tile so layout never collapses into holes.
  var PLACEHOLDER = 'data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600">' +
    '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0" stop-color="#1a1a17"/><stop offset="1" stop-color="#3a3a32"/>' +
    '</linearGradient></defs>' +
    '<rect width="600" height="600" fill="url(#g)"/>' +
    '<circle cx="300" cy="270" r="54" fill="#D8FF3E"/>' +
    '<text x="300" y="380" font-family="sans-serif" font-size="34" font-weight="bold" fill="#FFF8EC" text-anchor="middle">STANDIN</text>' +
    '</svg>'
  );
  document.addEventListener('error', function (e) {
    var t = e.target;
    if (t && t.tagName === 'IMG' && t.src !== PLACEHOLDER) { t.src = PLACEHOLDER; }
  }, true);
  // Images that failed before this script ran (parser-inserted <img>).
  function sweepBroken() {
    document.querySelectorAll('img').forEach(function (img) {
      if (img.complete && img.naturalWidth === 0 && img.src !== PLACEHOLDER) { img.src = PLACEHOLDER; }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', sweepBroken);
  else sweepBroken();

  function defaultBase() {
    try {
      var saved = localStorage.getItem('standin_api_base');
      if (saved) return saved;
      if (typeof location !== 'undefined' && String(location.protocol).indexOf('http') === 0) return location.origin;
    } catch (e) {}
    return 'http://localhost:3001';
  }
  var BASE = defaultBase();

  function getToken() { try { return localStorage.getItem('standin_jwt'); } catch (e) { return null; } }
  function setToken(t) { try { t ? localStorage.setItem('standin_jwt', t) : localStorage.removeItem('standin_jwt'); } catch (e) {} }
  function getUser() { try { return JSON.parse(localStorage.getItem('standin_user') || 'null'); } catch (e) { return null; } }
  function setUser(u) { try { u ? localStorage.setItem('standin_user', JSON.stringify(u)) : localStorage.removeItem('standin_user'); } catch (e) {} }

  async function healthy() {
    try {
      var ctl = new AbortController();
      var t = setTimeout(function () { ctl.abort(); }, 1500);
      var r = await fetch(BASE + '/health', { signal: ctl.signal });
      clearTimeout(t);
      return r.ok;
    } catch (e) { return false; }
  }

  async function api(path, opts) {
    opts = opts || {};
    var headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    var tok = opts.token || getToken();
    if (tok) headers.Authorization = 'Bearer ' + tok;
    var res = await fetch(BASE + path, { method: opts.method || 'GET', headers: headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
    var json = await res.json().catch(function () { return {}; });
    return { status: res.status, ok: res.ok, json: json };
  }

  async function register(input) {
    var r = await api('/api/v1/auth/register', { method: 'POST', body: input });
    if (r.ok) { setToken(r.json.token); setUser(r.json.user); }
    return r;
  }
  async function login(input) {
    var r = await api('/api/v1/auth/login', { method: 'POST', body: input });
    if (r.ok) { setToken(r.json.token); setUser(r.json.user); }
    return r;
  }
  function logout() { setToken(null); setUser(null); }
  function session() {
    var u = getUser();
    return u && getToken() ? { mode: 'backend', user: u } : { mode: 'none', user: null };
  }

  // Anonymous device account so first-time visitors can post before registering.
  async function ensureDevice() {
    var tok = getToken();
    if (tok) return tok;
    var device = null;
    try {
      device = localStorage.getItem('standin_device_id');
      if (!device) { device = 'device-' + Math.random().toString(36).slice(2, 10); localStorage.setItem('standin_device_id', device); }
    } catch (e) { return null; }
    var email = device + '@device.local';
    var password = 'dev-' + device + '-x';
    var reg = await api('/api/v1/auth/register', { body: { name: 'Guest', email: email, password: password, city: 'Berlin' } });
    if (reg.status === 409) {
      var lin = await api('/api/v1/auth/login', { body: { email: email, password: password } });
      if (!lin.ok) return null;
      setToken(lin.json.token); setUser(lin.json.user);
      return lin.json.token;
    }
    if (reg.ok) { setToken(reg.json.token); setUser(reg.json.user); return reg.json.token; }
    return null;
  }

  function priceToCategory(price) {
    var map = { 3: 'wake_roast', 4: 'hype', 5: 'place_check', 6: 'pitch', 9: 'proposal', 14: 'queue' };
    if (map[price]) return { category: map[price], rush: false };
    if (map[price - 2]) return { category: map[price - 2], rush: true };
    return { category: 'place_check', rush: false };
  }

  // Mirror a locally-created job. Backend reprices + scans authoritatively.
  // Returns {ok, job?, error?} — callers must honor rejections (422 scan).
  async function pushJob(local) {
    if (!(await healthy())) return { ok: false, offline: true };
    var tok = getToken() || (await ensureDevice());
    if (!tok) return { ok: false, offline: true };
    var q = priceToCategory(local.price);
    var body = { title: local.title, category: q.category, city: local.city, rush: q.rush, clientId: local.id };
    if (local.description) body.description = local.description;
    if (local.deadline) body.deadline = local.deadline;
    if (local.videoLength) body.videoLength = local.videoLength;
    var r = await api('/api/v1/jobs', {
      method: 'POST', token: tok,
      headers: { 'Idempotency-Key': 'web-' + local.id },
      body: body,
    });
    if (!r.ok) return { ok: false, status: r.status, error: (r.json.error && (r.json.error.message || r.json.error.code)) || 'rejected' };
    return { ok: true, job: r.json.job, quote: r.json.quote };
  }

  async function hydrate() {
    if (!(await healthy())) return [];
    var r = await api('/api/v1/jobs/feed?limit=20');
    return r.ok ? r.json.items || [] : [];
  }

  async function mine() {
    var tok = getToken();
    if (!tok || !(await healthy())) return null;
    var r = await api('/api/v1/jobs/mine', { token: tok });
    return r.ok ? r.json.items || [] : null;
  }

  // The human already passed the product verification gate; mirror it so
  // this account can claim on the backend. Idempotent — safe to repeat.
  async function ensureVerified(name, city) {
    var tok = getToken() || (await ensureDevice());
    if (!tok) return false;
    await api('/api/v1/doers/profile', { method: 'POST', token: tok, body: { displayName: name || 'Doer', city: city || 'Berlin' } });
    var v = await api('/api/v1/doers/verify', { method: 'POST', token: tok, body: {} });
    return v.ok;
  }

  async function claimRemote(backendId) {
    var tok = getToken();
    if (!tok) return null;
    var r = await api('/api/v1/jobs/' + backendId + '/claim', { method: 'POST', token: tok });
    return r.ok ? r.json : null;
  }
  async function deliverRemote(backendId, videoUrl) {
    var tok = getToken();
    if (!tok) return null;
    var r = await api('/api/v1/jobs/' + backendId + '/deliver', { method: 'POST', token: tok, body: { videoUrl: videoUrl } });
    return r.ok ? r.json : null;
  }
  async function approveRemote(backendId) {
    var tok = getToken();
    if (!tok) return null;
    var r = await api('/api/v1/jobs/' + backendId + '/approve', { method: 'POST', token: tok });
    return r.ok ? r.json : null;
  }
  async function cancelRemote(backendId) {
    var tok = getToken();
    if (!tok) return null;
    var r = await api('/api/v1/jobs/' + backendId + '/cancel', { method: 'POST', token: tok });
    return r.ok ? r.json : null;
  }

  // Real file delivery: presigned-style upload, returns a public URL.
  async function upload(file) {
    var tok = getToken() || (await ensureDevice());
    if (!tok) return null;
    var pre = await api('/api/v1/uploads/presign', { method: 'POST', token: tok, body: {} });
    if (!pre.ok) return null;
    var put = await fetch(BASE + pre.json.uploadUrl, { method: 'PUT', headers: { Authorization: 'Bearer ' + tok }, body: file });
    if (!put.ok) return null;
    return BASE + pre.json.publicUrl;
  }

  // Live marketplace events with graceful absence when unreachable.
  function sse(onEvent) {
    try {
      var src = new EventSource(BASE + '/api/v1/stream');
      src.addEventListener('job.opened', function (e) { onEvent('job.opened', JSON.parse(e.data)); });
      src.addEventListener('job.claimed', function (e) { onEvent('job.claimed', JSON.parse(e.data)); });
      src.addEventListener('job.paid', function (e) { onEvent('job.paid', JSON.parse(e.data)); });
      src.onerror = function () {};
      return src;
    } catch (e) { return null; }
  }

  window.StandinBridge = {
    BASE: BASE, healthy: healthy, api: api,
    register: register, login: login, logout: logout, session: session,
    pushJob: pushJob, hydrate: hydrate, mine: mine,
    ensureVerified: ensureVerified,
    claimRemote: claimRemote, deliverRemote: deliverRemote,
    approveRemote: approveRemote, cancelRemote: cancelRemote,
    upload: upload, sse: sse,
  };
})();
