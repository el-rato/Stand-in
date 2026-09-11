// One-command move from the local JSON store into Postgres (Supabase).
// Applies schema migrations 001-004 + 006, then upserts every row.
// Safe to re-run: tables are IF NOT EXISTS, rows are ON CONFLICT DO NOTHING.
// Usage: npm run migrate:pg [--db ./data/db.json]
// Needs DATABASE_URL in env (or backend/.env). 005_app_role is intentionally
// skipped — it needs a password you choose; see its header.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));

// Load backend/.env like the server does (dotenv only fills unset vars,
// so a real environment DATABASE_URL still wins).
const { default: dotenv } = await import('dotenv');
dotenv.config({ path: path.join(here, '..', '.env') });
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const dbUrl = process.env.DATABASE_URL || '';
if (!dbUrl) {
  console.error('[migrate] DATABASE_URL is not set — add it to backend/.env first');
  process.exit(1);
}
const jsonPath = path.resolve(flag('--db', path.join(here, '..', 'data', 'db.json')));
if (!fs.existsSync(jsonPath)) {
  console.error(`[migrate] no JSON store at ${jsonPath} — nothing to move`);
  process.exit(1);
}

let pg;
try { pg = require('pg'); }
catch { console.error('[migrate] run `npm i pg` first'); process.exit(1); }

const db = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
const client = new pg.Client({ connectionString: dbUrl });
await client.connect();

try {
  // 1. Schema (005 skipped: needs your chosen password — see its header).
  for (const f of ['001_init.sql', '002_roles.sql', '003_reports.sql', '004_payouts.sql', '006_job_details.sql', '007_rls_lockdown.sql']) {
    const sql = fs.readFileSync(path.join(here, '..', 'migrations', f), 'utf8');
    await client.query(sql);
    console.log(`[migrate] schema ${f} OK`);
  }

  // 2. Data — every insert is idempotent.
  await client.query('BEGIN');
  let users = 0, doers = 0, jobs = 0, ledger = 0, keys = 0, payouts = 0, reports = 0;
  for (const u of db.users || []) {
    await client.query(
      `INSERT INTO users (id, name, email, pass_hash, city, plan, role, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING`,
      [u.id, u.name, u.email, u.passHash, u.city || '', u.plan || 'free', u.role || 'user', u.createdAt || new Date().toISOString()]
    );
    users += 1;
  }
  for (const d of db.doers || []) {
    await client.query(
      `INSERT INTO doer_profiles (user_id, display_name, city, status, stripe_account_id, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (user_id) DO NOTHING`,
      [d.userId, d.displayName || null, d.city || null, d.status || 'pending', d.stripeAccountId || null, d.createdAt || new Date().toISOString(), d.updatedAt || new Date().toISOString()]
    );
    doers += 1;
  }
  for (const j of db.jobs || []) {
    await client.query(
      `INSERT INTO jobs (id, asker_id, title, category, label, city, rush, total, fee, doer_share, client_id, description, deadline, video_length, moderation, status, doer_id, video_url, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) ON CONFLICT (id) DO NOTHING`,
      [j.id, j.askerId, j.title, j.category, j.label, j.city, !!j.rush, j.total, j.fee, j.doerShare, j.clientId || null,
        j.description || '', j.deadline || 'asap', j.videoLength || '1:30', JSON.stringify(j.moderation || { score: 0, flags: [] }),
        j.status, j.doerId || null, j.videoUrl || null, j.createdAt || new Date().toISOString(), j.updatedAt || new Date().toISOString()]
    );
    jobs += 1;
  }
  for (const t of db.ledger || []) {
    await client.query(
      `INSERT INTO ledger (id, job_id, type, amount, actor, created_at)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING`,
      [t.id, t.jobId, t.type, t.amount, t.actor || null, t.at || new Date().toISOString()]
    );
    ledger += 1;
  }
  for (const k of db.apiKeys || []) {
    await client.query(
      `INSERT INTO api_keys (id, user_id, name, hash, prefix, created_at)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING`,
      [k.id, k.userId, k.name, k.hash, k.prefix, k.createdAt || new Date().toISOString()]
    );
    keys += 1;
  }
  for (const p of db.payouts || []) {
    await client.query(
      `INSERT INTO payouts (id, doer_id, amount, status, transfer_id, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`,
      [p.id, p.doerId, p.amount, p.status, p.transferId || null, p.at || new Date().toISOString(), p.updatedAt || new Date().toISOString()]
    );
    payouts += 1;
  }
  for (const r of db.reports || []) {
    await client.query(
      `INSERT INTO reports (id, type, subject, message, contact, job_id, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`,
      [r.id, r.type, r.subject, r.message, r.contact || '', r.jobId || null, r.at || new Date().toISOString()]
    );
    reports += 1;
  }
  await client.query('COMMIT');
  console.log(`[migrate] rows moved — users:${users} doers:${doers} jobs:${jobs} ledger:${ledger} keys:${keys} payouts:${payouts} reports:${reports}`);
  console.log('[migrate] done. Passwords moved as hashes, so every login still works.');
} catch (e) {
  try { await client.query('ROLLBACK'); } catch { /* ignore */ }
  console.error('[migrate] FAILED:', e.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
