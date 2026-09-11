// wafLite: application-level request firewall (defense in depth — the first
// wall is Vercel Firewall / Cloudflare in front of production; this catches
// scanner probes and hostile query strings at the app edge everywhere).
// Conservative by design: it only ever inspects path + query string, never
// JSON bodies (job titles legitimately contain quotes and punctuation).

const BLOCKED_PATHS = [
  /\.env(\.|$)/i, /\.git\//i, /\.svn\//i, /\.aws\//i, /\.ssh\//i,
  /wp-admin/i, /wp-login/i, /phpmyadmin/i, /server-status/i,
  /actuator/i, /\.php$/i, /\/\.well-known\/security\.txt$/i,
];

const HOSTILE_QUERY = [
  /union\s+select/i, /information_schema/i, /;\s*drop\s+table/i,
  /benchmark\s*\(/i, /sleep\s*\(\s*\d/i, /<script/i, /onerror\s*=/i,
];

export function wafLite(req, res, next) {
  const raw = req.originalUrl || req.url || '';
  const path = raw.split('?')[0];
  if (BLOCKED_PATHS.some((re) => re.test(path))) {
    console.warn(`[waf] scanner probe blocked: ${req.ip || '?'} ${path.slice(0, 120)}`);
    // Indistinguishable from a missing page — give scanners nothing.
    return res.status(404).json({ error: { code: 'not_found', message: 'unknown endpoint' } });
  }
  if (raw.includes('\0')) {
    return res.status(400).json({ error: { code: 'bad_request', message: 'invalid request' } });
  }
  if (raw.length > 2048) {
    return res.status(414).json({ error: { code: 'uri_too_long', message: 'request too long' } });
  }
  const q = raw.includes('?') ? raw.slice(raw.indexOf('?') + 1) : '';
  if (q) {
    let decoded = q;
    try { decoded = decodeURIComponent(q); } catch { /* keep raw */ }
    if (HOSTILE_QUERY.some((re) => re.test(decoded))) {
      console.warn(`[waf] hostile query blocked: ${req.ip || '?'} ${decoded.slice(0, 160)}`);
      return res.status(403).json({ error: { code: 'blocked', message: 'request blocked' } });
    }
  }
  next();
}
