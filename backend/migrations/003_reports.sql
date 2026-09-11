-- 003: user reports (safety / contact). Apply with: psql $DATABASE_URL -f migrations/003_reports.sql

CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL, -- safety | contact
  subject TEXT NOT NULL,
  message TEXT NOT NULL,
  contact TEXT NOT NULL DEFAULT '',
  job_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_reports_type ON reports (type, created_at DESC);
