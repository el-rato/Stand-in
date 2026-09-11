// Assert RLS is enabled on every app table (Supabase badges should read
// RESTRICTED, not UNRESTRICTED). Usage: npm run check:rls
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { default: dotenv } = await import('dotenv');
dotenv.config({ path: path.join(here, '..', '.env') });

const expected = ['users', 'doer_profiles', 'jobs', 'ledger', 'api_keys', 'payouts', 'reports', 'idempotency'];
let pg;
try { pg = require('pg'); }
catch { console.error('[check:rls] run `npm i pg` first'); process.exit(1); }

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  const { rows } = await client.query(
    `SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname='public' AND tablename = ANY($1)`,
    [expected]
  );
  const found = Object.fromEntries(rows.map((r) => [r.tablename, r.rowsecurity]));
  let bad = 0;
  for (const t of expected) {
    const ok = found[t] === true;
    if (!ok) bad += 1;
    console.log(`${ok ? 'RESTRICTED' : 'MISSING/OPEN'}  ${t}`);
  }
  console.log(bad ? `[check:rls] ${bad} table(s) need lockdown — run migrations/007_rls_lockdown.sql` : '[check:rls] all app tables locked down');
  process.exitCode = bad ? 1 : 0;
} finally {
  await client.end();
}
