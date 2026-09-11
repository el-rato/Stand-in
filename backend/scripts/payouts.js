// Friday payout batch: pay every verified doer with available balance.
// Usage: node scripts/payouts.js [--min 5] [--execute]
// Without --execute this only REPORTS who would be paid (safe default —
// real money never moves unless you say so). Without STRIPE_SECRET there is
// nothing to transfer: the run reports balances that stay as queued IOUs.
// Schedule weekly, e.g. cron: 0 9 * * 5 /usr/bin/node /path/to/backend/scripts/payouts.js --execute
import { createStore } from '../src/store/index.js';
import { requestPayout, MIN_PAYOUT } from '../src/lib/payouts.js';
import { config } from '../src/config.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const min = parseFloat(flag('--min', String(MIN_PAYOUT))) || MIN_PAYOUT;
const execute = args.includes('--execute');

const store = await createStore();
let stripe = null;
if (config.stripeSecret) {
  const { default: Stripe } = await import('stripe');
  stripe = new Stripe(config.stripeSecret);
}

const cands = await store.payoutCandidates(min);
console.log(`[payouts] ${cands.length} doers with ≥ $${min} available (store=${store.kind}, stripe=${stripe ? 'live' : 'demo'}, execute=${execute})`);
if (!execute) {
  for (const c of cands) console.log(`[payouts] would pay ${c.displayName}: $${c.available}`);
  console.log('[payouts] dry run — re-run with --execute to move money');
  process.exit(0);
}

let paid = 0, failed = 0, total = 0;
for (const c of cands) {
  try {
    const p = await requestPayout(store, { stripe, userId: c.userId });
    paid += 1; total = Math.round((total + p.amount) * 100) / 100;
    console.log(`[payouts] ${c.displayName} $${p.amount} → ${p.status}`);
  } catch (e) {
    failed += 1;
    console.log(`[payouts] SKIP ${c.displayName}: ${e.message}`);
  }
}
console.log(`[payouts] done: ${paid} paid ($${total}), ${failed} skipped`);
