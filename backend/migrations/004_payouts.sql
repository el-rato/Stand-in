-- 004: Stripe Connect accounts + payout runs. Apply with: psql $DATABASE_URL -f migrations/004_payouts.sql

ALTER TABLE doer_profiles ADD COLUMN IF NOT EXISTS stripe_account_id TEXT;

CREATE TABLE IF NOT EXISTS payouts (
  id TEXT PRIMARY KEY,
  doer_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount NUMERIC(10,2) NOT NULL,
  status TEXT NOT NULL DEFAULT 'processing', -- processing | transferred | queued | failed
  transfer_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_payouts_doer ON payouts (doer_id);
