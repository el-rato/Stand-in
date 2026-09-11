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
      const claims = jwt.verify(token, config.jwtSecret);
      const user = await store.findUserById(claims.sub);
      if (!user) return res.status(401).json({ error: { code: 'unauthorized', message: 'unknown user' } });
      req.user = user;
      next();
    } catch {
      return res.status(401).json({ error: { code: 'unauthorized', message: 'invalid or expired token' } });
    }
  };
}
