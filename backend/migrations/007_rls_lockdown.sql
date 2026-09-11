-- 007: RLS lockdown as defense in depth.
-- Supabase flags every table without RLS as UNRESTRICTED. In this product
-- only the API touches Postgres (never browsers), so RLS was never the
-- enforcement layer — but turning it ON with an app-only policy is strictly
-- better: if anyone ever exposes a table via the Data API or grants anon
-- access by accident, anonymous callers still see zero rows (no policy
-- covers them = deny by default).
--
-- Safe to apply: the table owner (postgres, which runs migrations) bypasses
-- RLS entirely, so the running app is unaffected. If you use the 005
-- standin_app role, it gets an explicit full-access policy below.
-- Re-run any time; uses IF NOT EXISTS-style guards throughout.

DO $$
DECLARE
  t TEXT;
  has_app BOOLEAN;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'standin_app') INTO has_app;
  FOREACH t IN ARRAY ARRAY['users', 'doer_profiles', 'jobs', 'ledger', 'api_keys', 'payouts', 'reports', 'idempotency']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS app_full_access ON %I', t);
    IF has_app THEN
      EXECUTE format('CREATE POLICY app_full_access ON %I FOR ALL TO standin_app USING (true) WITH CHECK (true)', t);
    END IF;
  END LOOP;
END $$;
