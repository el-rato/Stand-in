/* STANDIN api-bridge — optional live-backend layer for index.html.
 * If the API (default http://localhost:3001) is reachable, job posts are
 * mirrored to it and the live feed hydrates from it. If not, everything
 * silently falls back to the page's local demo state. No build step.
 */
(function () {
  var BASE = localStorage.getItem('standin_api_base') || 'http://localhost:3001';

  function priceToCategory(price) {
    var map = { 3: 'wake_roast', 4: 'hype', 5: 'place_check', 6: 'pitch', 9: 'proposal', 14: 'queue' };
    if (map[price]) return { category: map[price], rush: false };
    if (map[price - 2]) return { category: map[price - 2], rush: true };
    return { category: 'place_check', rush: false };
  }

  async function healthy() {
    try {
      var ctl = new AbortController();
      var t = setTimeout(function () { ctl.abort(); }, 1500);
      var r = await fetch(BASE + '/health', { signal: ctl.signal });
      clearTimeout(t);
      return r.ok;
    } catch (e) { return false; }
  }

  async function ensureDevice() {
    var tok = null;
    try { tok = localStorage.getItem('standin_api_token'); } catch (e) {}
    if (tok) return tok;
    var device = null;
    try {
      device = localStorage.getItem('standin_device_id');
      if (!device) {
        device = 'device-' + Math.random().toString(36).slice(2, 10);
        localStorage.setItem('standin_device_id', device);
      }
    } catch (e) { return null; }
    // Demo provisioning: one device account. Production uses real auth UI.
    var email = device + '@device.local';
    var password = 'dev-' + device + '-x';
    var reg = await fetch(BASE + '/api/v1/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Guest', email: email, password: password, city: 'Berlin' }),
    });
    if (reg.status === 409) {
      var login = await fetch(BASE + '/api/v1/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email, password: password }),
      });
      if (!login.ok) return null;
      tok = (await login.json()).token;
    } else if (reg.ok) {
      tok = (await reg.json()).token;
    } else {
      return null;
    }
    try { localStorage.setItem('standin_api_token', tok); } catch (e) {}
    return tok;
  }

  // Mirror a locally-created job to the backend. Backend reprices
  // authoritatively from category — its total wins on mismatch.
  async function pushJob(local) {
    if (!(await healthy())) return null;
    var tok = await ensureDevice();
    if (!tok) return null;
    var q = priceToCategory(local.price);
    var res = await fetch(BASE + '/api/v1/jobs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + tok,
        'Idempotency-Key': 'web-' + local.id,
      },
      body: JSON.stringify({ title: local.title, category: q.category, city: local.city, rush: q.rush, clientId: local.id }),
    });
    if (!res.ok) return null;
    return res.json();
  }

  // Pull open jobs the backend knows about that this device hasn't seen.
  async function hydrate() {
    if (!(await healthy())) return [];
    var res = await fetch(BASE + '/api/v1/jobs/feed?limit=20');
    if (!res.ok) return [];
    return (await res.json()).items || [];
  }

  window.StandinBridge = { BASE: BASE, healthy: healthy, pushJob: pushJob, hydrate: hydrate };
})();
