// Seed a lived-in marketplace: two users, one verified doer, and jobs in
// every pipeline stage. Run: npm run seed. Safe to re-run (skips existing).
import bcrypt from 'bcryptjs';
import { createStore } from './src/store/index.js';
import { quoteJob } from './src/lib/pricing.js';

const store = await createStore();

async function user(name, email, city) {
  const found = await store.findUserByEmail(email);
  if (found) return found;
  return store.createUser({ name, email, passHash: await bcrypt.hash('password123', 10), city });
}

const ana = await user('Ana', 'ana@seed.io', 'Lisbon');
const ben = await user('Ben', 'ben@seed.io', 'Berlin');
await store.upsertDoer(ben.id, { displayName: 'Ben', city: 'Berlin', status: 'verified' });

async function job(askerId, title, category, city, rush, clientId) {
  const existing = (await store.listByUser(askerId)).find((j) => j.clientId === clientId);
  if (existing) return existing;
  const q = quoteJob(category, rush);
  return store.createJob({
    askerId, title, category: q.category, label: q.label, city,
    rush: q.rush, total: q.total, fee: q.fee, doerShare: q.doer, clientId,
  });
}

const j1 = await job(ana.id, 'Film the Alfama sunrise over the rooftops, 40 seconds', 'place_check', 'Lisbon', false, 'seed-open-1');
const j2 = await job(ana.id, 'Wake-up roast call before my 7AM flight, be brutal', 'wake_roast', 'Lisbon', true, 'seed-open-2');
const j3 = await job(ana.id, 'Check if the Berghain line is under an hour right now', 'place_check', 'Berlin', false, 'seed-claimed-1');
const j4 = await job(ana.id, 'Ten hype videos before my driving test on Friday', 'hype', 'Lagos', false, 'seed-paid-1');

for (const [j, from, fn] of [
  [j3, 'open', (d) => { d.status = 'claimed'; d.doerId = ben.id; }],
  [j4, 'open', (d) => { d.status = 'claimed'; d.doerId = ben.id; }],
]) {
  try { await store.transitionJob(j.id, from, fn); } catch { /* already staged */ }
}
try {
  await store.transitionJob(j4.id, 'claimed', (d) => { d.status = 'delivered'; d.videoUrl = 'https://demo.standin/video/seed-paid-1'; });
  await store.transitionJob(j4.id, 'delivered', (d) => { d.status = 'paid'; });
  await store.appendLedger({ jobId: j4.id, type: 'release', amount: j4.doerShare, actor: ben.id });
  await store.appendLedger({ jobId: j4.id, type: 'fee', amount: j4.fee, actor: 'platform' });
} catch { /* already staged */ }

console.log(`[seed] store=${store.kind} users=ana@seed.io,ben@seed.io (password123) jobs=open:2 pipeline:2`);
console.log(`[seed] open jobs: ${j1.id}, ${j2.id}`);
