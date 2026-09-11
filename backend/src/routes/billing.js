import { Router } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { idempotency } from '../middleware/idempotency.js';
import { sha256 } from '../lib/util.js';

const checkoutSchema = z.object({
  paymentMethodId: z.string().max(120).optional(),
});

const salesSchema = z.object({
  email: z.string().email().max(120),
  company: z.string().min(2).max(120),
});

export function billingRoutes(store, config) {
  const r = Router();
  const auth = requireAuth(store);

  // Standin+ subscription. Demo mode activates instantly so the frontend
  // flow works with zero keys. With STRIPE_SECRET set, this creates a real
  // PaymentIntent and the plan flips on in /webhook.
  r.post('/plus/checkout', auth, idempotency(store), async (req, res, next) => {
    try {
      checkoutSchema.parse(req.body);
      if (!config.stripeSecret) {
        await store.setPlan(req.user.id, 'plus');
        return res.json({ plan: 'plus', mode: 'demo', message: 'Standin+ active (demo, no charge)' });
      }
      const { default: Stripe } = await import('stripe');
      const stripe = new Stripe(config.stripeSecret);
      const intent = await stripe.paymentIntents.create({
        amount: 1200,
        currency: 'usd',
        metadata: { userId: req.user.id, plan: 'plus' },
      });
      res.json({ plan: 'pending', mode: 'stripe', clientSecret: intent.client_secret });
    } catch (e) { next(e); }
  });

  // Stripe webhook — flips the plan when payment succeeds.
  // NOTE: this route must receive the RAW body; see app.js wiring.
  r.post('/webhook', async (req, res) => {
    try {
      if (!config.stripeSecret) return res.json({ ok: true, mode: 'demo' });
      const sig = req.headers['stripe-signature'];
      const { default: Stripe } = await import('stripe');
      const stripe = new Stripe(config.stripeSecret);
      const event = stripe.webhooks.constructEvent(req.body, sig, config.stripeWebhookSecret);
      if (event.type === 'payment_intent.succeeded') {
        const userId = event.data.object.metadata?.userId;
        if (userId) await store.setPlan(userId, 'plus');
      }
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: { code: 'bad_webhook', message: e.message } });
    }
  });

  r.post('/sales', async (req, res, next) => {
    try {
      const body = salesSchema.parse(req.body);
      res.status(201).json({ ok: true, message: `Demo link queued for ${body.email}` });
    } catch (e) { next(e); }
  });

  return r;
}

export function businessRoutes(store) {
  const r = Router();
  const auth = requireAuth(store);

  r.get('/keys', auth, async (req, res, next) => {
    try {
      res.json({ items: await store.listApiKeys(req.user.id) });
    } catch (e) { next(e); }
  });

  r.post('/keys', auth, async (req, res, next) => {
    try {
      const schema = z.object({ name: z.string().min(2).max(60) });
      const body = schema.parse(req.body);
      const raw = `sk_live_${crypto.randomBytes(24).toString('hex')}`;
      const row = await store.createApiKey({
        userId: req.user.id,
        name: body.name,
        hash: sha256(raw),
        prefix: raw.slice(0, 12),
      });
      // Raw key is shown ONCE — never stored or logged.
      res.status(201).json({ key: raw, meta: row });
    } catch (e) { next(e); }
  });

  return r;
}
