import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { requireAuth, signToken } from '../middleware/auth.js';

const registerSchema = z.object({
  name: z.string().min(2).max(60),
  email: z.string().email().max(120),
  password: z.string().min(8).max(100),
  city: z.string().max(60).optional().default(''),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

// Burned on unknown emails so missing accounts take as long as real ones —
// otherwise response timing reveals which emails are registered.
const DUMMY_HASH = bcrypt.hashSync('standin-missing-user-dummy', 10);

export function authRoutes(store) {
  const r = Router();

  r.post('/register', async (req, res, next) => {
    try {
      const body = registerSchema.parse(req.body);
      const passHash = await bcrypt.hash(body.password, 10);
      const user = await store.createUser({
        name: body.name,
        email: body.email.toLowerCase(),
        passHash,
        city: body.city,
      });
      res.status(201).json({ token: signToken(user), user: safe(user) });
    } catch (e) { next(e); }
  });

  r.post('/login', async (req, res, next) => {
    try {
      const body = loginSchema.parse(req.body);
      const user = await store.findUserByEmail(body.email.toLowerCase());
      const ok = user
        ? await bcrypt.compare(body.password, user.passHash)
        : await bcrypt.compare(body.password, DUMMY_HASH);
      if (!user || !ok) {
        return res.status(401).json({ error: { code: 'bad_credentials', message: 'wrong email or password' } });
      }
      res.json({ token: signToken(user), user: safe(user) });
    } catch (e) { next(e); }
  });

  // Change password — proves the current one, sets a new 8+ character one.
  r.post('/password', requireAuth(store), async (req, res, next) => {
    try {
      const body = z.object({
        currentPassword: z.string().min(1).max(100),
        newPassword: z.string().min(8).max(100),
      }).parse(req.body);
      const user = await store.findUserByEmail(req.user.email);
      if (!user || !(await bcrypt.compare(body.currentPassword, user.passHash))) {
        return res.status(401).json({ error: { code: 'bad_credentials', message: 'current password is wrong' } });
      }
      await store.setPassword(user.id, await bcrypt.hash(body.newPassword, 10));
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  return r;
}

function safe(u) {
  return { id: u.id, name: u.name, email: u.email, city: u.city, plan: u.plan, createdAt: u.createdAt };
}
