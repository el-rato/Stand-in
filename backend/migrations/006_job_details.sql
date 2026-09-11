-- 006: customizable job details + stored moderation verdict.
-- Apply with: psql $DATABASE_URL -f migrations/006_job_details.sql

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '';
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS deadline TEXT NOT NULL DEFAULT 'asap';
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS video_length TEXT NOT NULL DEFAULT '1:30';
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS moderation JSONB NOT NULL DEFAULT '{}';
