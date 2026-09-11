import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { idempotency } from '../middleware/idempotency.js';
import { quoteJob } from '../lib/pricing.js';
import { publish } from '../lib/events.js';
import { enqueue } from '../lib/queue.js';

const postSchema = z.object({
  title: z.string().min(8).max(140),
  category: z.string().min(2).max(40),
  city: z.string().min(2).max(60),
  rush: z.boolean().optional().default(false),
  clientId: z.string().max(80).optional(),
});

const deliverSchema = z.object({
  videoUrl: z.string().url().max(500),
});

export function jobRoutes(store) {
  const r = Router();
  const auth = requireAuth(store);

  // Public live feed — cursor paginated so it stays fast at 1M+ rows.
  r.get('/feed', async (req, res, next) => {
    try {
      const { status = 'open', city, cursor, limit } = req.query;
      const out = await store.listFeed({
        status: String(status || 'open'),
        city: city ? String(city) : undefined,
        cursor: cursor ? String(cursor) : undefined,
        limit: limit ? parseInt(String(limit), 10) : 20,
      });
      res.json(out);
    } catch (e) { next(e); }
  });

  r.get('/mine', auth, async (req, res, next) => {
    try {
      res.json({ items: await store.listByUser(req.user.id) });
    } catch (e) { next(e); }
  });

  r.get('/:id', async (req, res, next) => {
    try {
      const job = await store.getJob(req.params.id);
      if (!job) return res.status(404).json({ error: { code: 'not_found', message: 'job not found' } });
      res.json({ job, ledger: await store.ledgerByJob(job.id) });
    } catch (e) { next(e); }
  });

  // Post a job — price computed server-side, escrow hold recorded.
  r.post('/', auth, idempotency(store), async (req, res, next) => {
    try {
      const body = postSchema.parse(req.body);
      const quote = quoteJob(body.category, body.rush);
      const job = await store.createJob({
        askerId: req.user.id,
        title: body.title,
        category: quote.category,
        label: quote.label,
        city: body.city,
        rush: quote.rush,
        total: quote.total,
        fee: quote.fee,
        doerShare: quote.doer,
        clientId: body.clientId,
      });
      publish('job.opened', { jobId: job.id, city: job.city, total: job.total });
      res.status(job.duplicate ? 200 : 201).json({ job, quote });
    } catch (e) { next(e); }
  });

  // Claim — only verified doers, never your own job, CAS-guarded.
  r.post('/:id/claim', auth, async (req, res, next) => {
    try {
      const doer = await store.getDoer(req.user.id);
      if (!doer || doer.status !== 'verified') {
        return res.status(403).json({ error: { code: 'not_verified', message: 'complete doer verification first' } });
      }
      const job = await store.transitionJob(req.params.id, 'open', (draft) => {
        if (draft.askerId === req.user.id) {
          const e = new Error('cannot claim your own job');
          e.status = 403; e.code = 'self_claim';
          throw e;
        }
        draft.status = 'claimed';
        draft.doerId = req.user.id;
      });
      publish('job.claimed', { jobId: job.id, doerId: req.user.id });
      res.json({ job });
    } catch (e) { next(e); }
  });

  // Deliver — the claiming doer attaches the finished video.
  r.post('/:id/deliver', auth, async (req, res, next) => {
    try {
      const body = deliverSchema.parse(req.body);
      const job = await store.transitionJob(req.params.id, 'claimed', (draft) => {
        if (draft.doerId !== req.user.id) {
          const e = new Error('only the claiming doer can deliver');
          e.status = 403; e.code = 'not_doer';
          throw e;
        }
        draft.status = 'delivered';
        draft.videoUrl = body.videoUrl;
      });
      publish('job.delivered', { jobId: job.id });
      enqueue('moderation.scan', { jobId: job.id, videoUrl: body.videoUrl });
      res.json({ job });
    } catch (e) { next(e); }
  });

  // Approve — the asker releases the 80% payout, platform keeps 20%.
  r.post('/:id/approve', auth, async (req, res, next) => {
    try {
      const current = await store.getJob(req.params.id);
      if (!current) return res.status(404).json({ error: { code: 'not_found', message: 'job not found' } });
      if (current.askerId !== req.user.id) {
        return res.status(403).json({ error: { code: 'not_asker', message: 'only the asker can approve' } });
      }
      const job = await store.transitionJob(req.params.id, 'delivered', (draft) => {
        draft.status = 'paid';
      });
      await store.appendLedger({ jobId: job.id, type: 'release', amount: job.doerShare, actor: job.doerId });
      await store.appendLedger({ jobId: job.id, type: 'fee', amount: job.fee, actor: 'platform' });
      publish('job.paid', { jobId: job.id, amount: job.doerShare });
      enqueue('payout.released', { jobId: job.id, doerId: job.doerId, amount: job.doerShare });
      res.json({ job });
    } catch (e) { next(e); }
  });

  // Cancel — asker refunds escrow while the job is still open.
  r.post('/:id/cancel', auth, async (req, res, next) => {
    try {
      const current = await store.getJob(req.params.id);
      if (!current) return res.status(404).json({ error: { code: 'not_found', message: 'job not found' } });
      if (current.askerId !== req.user.id) {
        return res.status(403).json({ error: { code: 'not_asker', message: 'only the asker can cancel' } });
      }
      const job = await store.transitionJob(req.params.id, 'open', (draft) => {
        draft.status = 'refunded';
      });
      await store.appendLedger({ jobId: job.id, type: 'refund', amount: job.total, actor: job.askerId });
      publish('job.refunded', { jobId: job.id });
      res.json({ job });
    } catch (e) { next(e); }
  });

  return r;
}
