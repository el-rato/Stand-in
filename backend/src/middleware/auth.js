import jwt from 'jsonwebtoken';
import { config } from '../config.js';

export function signToken(user) {
  return jwt.sign({ sub: user.id, email: user.email }, config.jwtSecret, { expiresIn: config.jwtTtl });
}

export function requireAuth(store) {
  return async (req, res, next) => {
    try {
      const header = req.headers.authorization || '';
      const token = header.startsWith('Bearer ') ? header.slice(7) : null;
      if (!token) return res.status(401).json({ error: { code: 'unauthorized', message: 'missing bearer token' } });
      // Pinned algorithm: never accept alg:none or foreign algos (confusion attacks).
      const claims = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
      const user = await store.findUserById(claims.sub);
      if (!user) return res.status(401).json({ error: { code: 'unauthorized', message: 'unknown user' } });
      req.user = user;
      next();
    } catch {
      return res.status(401).json({ error: { code: 'unauthorized', message: 'invalid or expired token' } });
    }
  };
}

// Owners only. Emails in ADMIN_EMAILS auto-promote on first admin-area hit
// (bootstrap path); otherwise use `npm run make-admin`.
export function requireAdmin(store) {
  const auth = requireAuth(store);
  return (req, res, next) => auth(req, res, async () => {
    try {
      if (req.user.role !== 'admin' && config.adminEmails.includes((req.user.email || '').toLowerCase())) {
        req.user = await store.setRole(req.user.id, 'admin');
      }
      if (req.user.role !== 'admin') {
        return res.status(403).json({ error: { code: 'forbidden', message: 'admin only' } });
      }
      next();
    } catch (e) { next(e); }
  });
}
