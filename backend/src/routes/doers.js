import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { publish } from '../lib/events.js';
import { enqueue } from '../lib/queue.js';

const profileSchema = z.object({
  displayName: z.string().min(2).max(60),
  city: z.string().min(2).max(60),
});

export function doerRoutes(store) {
  const r = Router();
  const auth = requireAuth(store);

  r.get('/me', auth, async (req, res, next) => {
    try {
      res.json({ doer: await store.getDoer(req.user.id) });
    } catch (e) { next(e); }
  });

  r.post('/profile', auth, async (req, res, next) => {
    try {
      const body = profileSchema.parse(req.body);
      const doer = await store.upsertDoer(req.user.id, {
        displayName: body.displayName,
        city: body.city,
        status: 'pending',
      });
      res.json({ doer });
    } catch (e) { next(e); }
  });

  r.post('/verify', auth, async (req, res, next) => {
    try {
      const existing = await store.getDoer(req.user.id);
      if (!existing) {
        return res.status(400).json({ error: { code: 'no_profile', message: 'create a doer profile first' } });
      }
      const doer = await store.upsertDoer(req.user.id, { status: 'verified' });
      publish('doer.verified', { userId: req.user.id });
      enqueue('verification.completed', { userId: req.user.id });
      res.json({ doer });
    } catch (e) { next(e); }
  });

  return r;
}
