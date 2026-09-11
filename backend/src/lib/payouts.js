// Payout engine: who can be paid, how much, exactly once.
// Money flow: asker pays → escrow hold → approve releases 80% to the doer's
// BALANCE (ledger) → payout moves balance to the doer's bank via Stripe
// Connect (or records a queued IOU in demo mode for the Friday batch).
// The claim step is atomic per store so concurrent requests can't double-pay.

export const MIN_PAYOUT = 5; // $5 floor — below this, transfer fees eat the payout
const ACTIVE = ['processing', 'transferred', 'queued'];

export async function availableBalance(store, doerId) {
  const [released, used] = await Promise.all([
    store.sumReleasedByDoer(doerId),
    store.sumPayoutsByDoer(doerId),
  ]);
  return Math.round((released - used) * 100) / 100;
}

export async function requestPayout(store, { stripe, userId }) {
  const doer = await store.getDoer(userId);
  if (!doer || doer.status !== 'verified') {
    const e = new Error('complete doer verification first');
    e.status = 403; e.code = 'not_verified';
    throw e;
  }
  const avail = await availableBalance(store, userId);
  if (avail < MIN_PAYOUT) {
    const e = new Error(`minimum payout is $${MIN_PAYOUT} (available $${avail})`);
    e.status = 400; e.code = 'below_minimum';
    throw e;
  }
  // Atomic debit: rechecks balance under lock (PG) / single-thread (JSON).
  const payout = await store.createPayout({ doerId: userId, amount: avail });

  if (stripe && doer.stripeAccountId && !doer.stripeAccountId.startsWith('acct_demo_')) {
    try {
      const transfer = await stripe.transfers.create({
        amount: Math.round(avail * 100),
        currency: 'usd',
        destination: doer.stripeAccountId,
        metadata: { payoutId: payout.id, userId },
      });
      return store.setPayoutStatus(payout.id, 'transferred', transfer.id);
    } catch (err) {
      await store.setPayoutStatus(payout.id, 'failed');
      const e = new Error('transfer failed: ' + err.message);
      e.status = 502; e.code = 'transfer_failed';
      throw e;
    }
  }
  // Demo mode (or Connect not finished): recorded IOU, settled in the batch.
  return store.setPayoutStatus(payout.id, 'queued');
}
