import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { signToken } from '../middleware/auth.js';

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
      if (!user || !(await bcrypt.compare(body.password, user.passHash))) {
        return res.status(401).json({ error: { code: 'bad_credentials', message: 'wrong email or password' } });
      }
      res.json({ token: signToken(user), user: safe(user) });
    } catch (e) { next(e); }
  });

  return r;
}

function safe(u) {
  return { id: u.id, name: u.name, email: u.email, city: u.city, plan: u.plan, role: u.role || 'user', createdAt: u.createdAt };
}
