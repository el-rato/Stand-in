import { Router } from 'express';
import { z } from 'zod';
import { requireAdmin } from '../middleware/auth.js';
import { publish } from '../lib/events.js';

// Owner operations: platform stats, moderation, roles, money trail.
// Every route sits behind requireAdmin (role check + ADMIN_EMAILS bootstrap).
export function adminRoutes(store) {
  const r = Router();
  r.use(requireAdmin(store));

  r.get('/overview', async (req, res, next) => {
    try {
      const stats = await store.platformStats();
      res.json({ stats, feeBps: 2000, currency: 'USD', store: store.kind });
    } catch (e) { next(e); }
  });

  r.get('/jobs', async (req, res, next) => {
    try {
      const { cursor, limit } = req.query;
      const status = req.query.status ? String(req.query.status) : undefined;
      if (status && !['open', 'claimed', 'delivered', 'paid', 'refunded'].includes(status)) {
        return res.status(400).json({ error: { code: 'bad_status', message: 'unknown status' } });
      }
      res.json(await store.listAllJobs({
        status: status ? String(status) : undefined,
        cursor: cursor ? String(cursor) : undefined,
        limit: limit ? parseInt(String(limit), 10) : 20,
      }));
    } catch (e) { next(e); }
  });

  // Moderate: refund an open job, or release a claimed job back to the pool.
  r.post('/jobs/:id/cancel', async (req, res, next) => {
    try {
      const current = await store.getJob(req.params.id);
      if (!current) return res.status(404).json({ error: { code: 'not_found', message: 'job not found' } });
      if (current.status === 'open') {
        const job = await store.transitionJob(current.id, 'open', (d) => { d.status = 'refunded'; });
        await store.appendLedger({ jobId: job.id, type: 'refund', amount: job.total, actor: job.askerId });
        publish('job.refunded', { jobId: job.id, by: 'admin' });
        return res.json({ job });
      }
      if (current.status === 'claimed') {
        const job = await store.transitionJob(current.id, 'claimed', (d) => { d.status = 'open'; d.doerId = null; });
        publish('job.reopened', { jobId: job.id, by: 'admin' });
        return res.json({ job });
      }
      return res.status(409).json({ error: { code: 'bad_transition', message: `cannot moderate a ${current.status} job` } });
    } catch (e) { next(e); }
  });

  r.get('/users', async (req, res, next) => {
    try {
      const { q, limit } = req.query;
      res.json({ items: await store.listUsers({ q: q ? String(q) : '', limit: limit ? parseInt(String(limit), 10) : 50 }) });
    } catch (e) { next(e); }
  });

  r.post('/users/:id/role', async (req, res, next) => {
    try {
      const body = z.object({ role: z.enum(['user', 'admin']) }).parse(req.body);
      if (req.params.id === req.user.id && body.role !== 'admin') {
        return res.status(400).json({ error: { code: 'self_demote', message: 'cannot remove your own admin access' } });
      }
      res.json({ user: await store.setRole(req.params.id, body.role) });
    } catch (e) { next(e); }
  });

  r.get('/ledger', async (req, res, next) => {
    try {
      const { limit } = req.query;
      res.json({ items: await store.recentLedger(limit ? parseInt(String(limit), 10) : 50) });
    } catch (e) { next(e); }
  });

  r.get('/reports', async (req, res, next) => {
    try {
      const { type, limit } = req.query;
      const t = type ? String(type) : undefined;
      if (t && !['safety', 'contact'].includes(t)) {
        return res.status(400).json({ error: { code: 'bad_type', message: 'unknown report type' } });
      }
      res.json({ items: await store.listReports({ type: t, limit: limit ? parseInt(String(limit), 10) : 50 }) });
    } catch (e) { next(e); }
  });

  // Full snapshot download for backups / audits (admin only).
  r.get('/export', async (req, res, next) => {
    try {
      const [stats, users] = await Promise.all([
        store.platformStats(),
        store.listUsers({ q: '', limit: 5000 }),
      ]);
      const jobs = [];
      let cursor;
      do {
        const page = await store.listAllJobs({ cursor, limit: 50 });
        jobs.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor && jobs.length < 10000);
      const ledger = await store.recentLedger(5000);
      res.set('Content-Disposition', `attachment; filename="standin-export-${new Date().toISOString().slice(0, 10)}.json"`);
      res.json({ exportedAt: new Date().toISOString(), stats, users, jobs, ledger });
    } catch (e) { next(e); }
  });

  return r;
}
