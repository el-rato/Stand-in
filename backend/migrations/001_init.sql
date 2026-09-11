-- STANDIN postgres schema. Apply with: psql $DATABASE_URL -f migrations/001_init.sql

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  pass_hash TEXT NOT NULL,
  city TEXT NOT NULL DEFAULT '',
  plan TEXT NOT NULL DEFAULT 'free',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS doer_profiles (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  display_name TEXT,
  city TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  asker_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  label TEXT NOT NULL,
  city TEXT NOT NULL,
  rush BOOLEAN NOT NULL DEFAULT FALSE,
  total NUMERIC(10,2) NOT NULL,
  fee NUMERIC(10,2) NOT NULL,
  doer_share NUMERIC(10,2) NOT NULL,
  client_id TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  doer_id TEXT REFERENCES users(id),
  video_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (asker_id, client_id)
);
CREATE INDEX IF NOT EXISTS idx_jobs_feed ON jobs (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_city ON jobs (city, status);

CREATE TABLE IF NOT EXISTS ledger (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  type TEXT NOT NULL, -- hold | release | refund | fee
  amount NUMERIC(10,2) NOT NULL,
  actor TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ledger_job ON ledger (job_id);
CREATE INDEX IF NOT EXISTS idx_ledger_release ON ledger (type, created_at) WHERE type = 'release';

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS idempotency (
  key TEXT PRIMARY KEY,
  response JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
