-- 005 (optional hardening): least-privilege role for the app server.
-- Your API is the ONLY database client (browsers never touch Postgres —
-- they go through Express, which enforces auth). This role gives the app
-- exactly what it needs and nothing else: no DDL, no DELETE, no superuser.
--
-- Run as the project owner, substituting a strong password:
--   psql $DATABASE_URL -v app_password='a-very-long-random-string' -f migrations/005_app_role.sql
-- Then use standin_app in the connection string instead of postgres.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'standin_app') THEN
    CREATE ROLE standin_app WITH LOGIN PASSWORD :'app_password';
  ELSE
    ALTER ROLE standin_app WITH LOGIN PASSWORD :'app_password';
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO standin_app;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM standin_app;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO standin_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE ON TABLES TO standin_app;
