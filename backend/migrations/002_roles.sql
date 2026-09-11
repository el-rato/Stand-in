-- 002: admin roles. Apply with: psql $DATABASE_URL -f migrations/002_roles.sql

ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user';
CREATE INDEX IF NOT EXISTS idx_users_role ON users (role);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs (status);
