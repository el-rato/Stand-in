import { Router } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { requestPayout, availableBalance, MIN_PAYOUT } from '../lib/payouts.js';

// Doer money: Stripe Connect onboarding + balance + payout requests.
// Without STRIPE_SECRET everything runs in demo mode (queued IOUs with
// identical balance math) so the product flow works end to end for free.
export function payoutRoutes(store, config) {
  const r = Router();
  const auth = requireAuth(store);

  async function stripeClient() {
    if (!config.stripeSecret) return null;
    const { default: Stripe } = await import('stripe');
    return new Stripe(config.stripeSecret);
  }
  function baseUrl(req) {
    return (config.frontendOrigin[0] || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  }

  // Start / resume Connect Express onboarding. Returns a Stripe URL in
  // production, or an instant demo connection locally.
  r.post('/doers/connect', auth, async (req, res, next) => {
    try {
      const doer = await store.getDoer(req.user.id);
      if (!doer || doer.status !== 'verified') {
        return res.status(403).json({ error: { code: 'not_verified', message: 'complete doer verification first' } });
      }
      const stripe = await stripeClient();
      if (!stripe) {
        await store.upsertDoer(req.user.id, { stripeAccountId: `acct_demo_${req.user.id}` });
        return res.json({ mode: 'demo', connected: true });
      }
      let accountId = doer.stripeAccountId;
      if (!accountId || accountId.startsWith('acct_demo_')) {
        const account = await stripe.accounts.create({
          type: 'express',
          country: 'US',
          email: req.user.email,
          capabilities: { transfers: { requested: true } },
          metadata: { userId: req.user.id },
        });
        accountId = account.id;
        await store.upsertDoer(req.user.id, { stripeAccountId: accountId });
      }
      const link = await stripe.accountLinks.create({
        account: accountId,
        refresh_url: `${baseUrl(req)}/doer.html`,
        return_url: `${baseUrl(req)}/doer.html?connected=1`,
        type: 'account_onboarding',
      });
      res.json({ mode: 'stripe', connected: false, url: link.url });
    } catch (e) { next(e); }
  });

  r.get('/doers/connect/status', auth, async (req, res, next) => {
    try {
      const doer = await store.getDoer(req.user.id);
      const id = doer?.stripeAccountId || null;
      res.json({ connected: !!id, demo: id ? id.startsWith('acct_demo_') : false });
    } catch (e) { next(e); }
  });

  r.get('/payouts/mine', auth, async (req, res, next) => {
    try {
      const [payouts, available] = await Promise.all([
        store.listPayoutsByDoer(req.user.id),
        availableBalance(store, req.user.id),
      ]);
      res.json({ payouts, available, minimum: MIN_PAYOUT });
    } catch (e) { next(e); }
  });

  // Cash out the full available balance (floor $5). Transfers immediately
  // when Connect is live, otherwise records a queued IOU for the batch.
  r.post('/payouts/request', auth, async (req, res, next) => {
    try {
      const stripe = await stripeClient();
      const payout = await requestPayout(store, { stripe, userId: req.user.id });
      res.status(201).json({ payout });
    } catch (e) { next(e); }
  });

  return r;
}

export function adminPayoutRoutes(store) {
  const r = Router();
  r.use(requireAdmin(store));
  r.get('/payouts', async (req, res, next) => {
    try {
      const { limit } = req.query;
      res.json({ items: await store.listAllPayouts(limit ? parseInt(String(limit), 10) : 50) });
    } catch (e) { next(e); }
  });
  return r;
}
