// Apply any SQL migration file to DATABASE_URL.
// Usage: npm run sql -- migrations/007_rls_lockdown.sql
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { default: dotenv } = await import('dotenv');
dotenv.config({ path: path.join(here, '..', '.env') });

const file = process.argv[2];
if (!file) {
  console.error('usage: npm run sql -- <migration-file>');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('[sql] DATABASE_URL is not set');
  process.exit(1);
}

let pg;
try { pg = require('pg'); }
catch { console.error('[sql] run `npm i pg` first'); process.exit(1); }

const sql = fs.readFileSync(path.resolve(file), 'utf8');
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  await client.query(sql);
  console.log(`[sql] applied ${file}`);
} catch (e) {
  console.error('[sql] FAILED:', e.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
