import { sha256 } from '../lib/util.js';

// B2B authentication: X-Api-Key header. Keys are stored hashed (sha256);
// the raw key is shown once at creation, like Stripe/GitHub.
export function requireApiKey(store) {
  return async (req, res, next) => {
    const raw = req.headers['x-api-key'];
    if (!raw) return res.status(401).json({ error: { code: 'unauthorized', message: 'missing X-Api-Key' } });
    const row = await store.findApiKeyByHash(sha256(String(raw)));
    if (!row) return res.status(401).json({ error: { code: 'unauthorized', message: 'invalid api key' } });
    req.apiKey = row;
    next();
  };
}
