import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import pg from 'pg';
import { createClient } from 'redis';
import { S3Client, HeadBucketCommand } from '@aws-sdk/client-s3';
import { assertProdConfig } from '../src/lib/guards.js';

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(here, '..', '.env') });
let failed = false;
try {
  assertProdConfig({ ...process.env, NODE_ENV: 'production', VERCEL: '1' });
  console.log('PASS production environment variables');
} catch (error) {
  failed = true;
  console.error('FAIL production environment variables:', error.message);
}

const requiredTables = ['users', 'doer_profiles', 'jobs', 'ledger', 'api_keys', 'idempotency', 'reports', 'payouts'];
if (process.env.DATABASE_URL) {
  const database = new pg.Client({ connectionString: process.env.DATABASE_URL });
  try {
    await database.connect();
    const { rows } = await database.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name = ANY($1::text[])`,
      [requiredTables]
    );
    const found = new Set(rows.map(row => row.table_name));
    const missing = requiredTables.filter(name => !found.has(name));
    if (missing.length) throw new Error(`database migrations missing tables: ${missing.join(', ')}`);
    const role = await database.query(
      `SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='role'`
    );
    if (!role.rowCount) throw new Error('database migration missing users.role');
    console.log('PASS database schema');
  } catch (error) {
    failed = true;
    console.error('FAIL database schema:', error.message);
  } finally {
    await database.end().catch(() => {});
  }
}

if (process.env.REDIS_URL) {
  const redis = createClient({ url: process.env.REDIS_URL });
  redis.on('error', () => {});
  try {
    await redis.connect();
    await redis.ping();
    console.log('PASS Redis');
  } catch (error) {
    failed = true;
    console.error('FAIL Redis:', error.message);
  } finally {
    if (redis.isOpen) await redis.close();
  }
}

if (process.env.S3_BUCKET) {
  try {
    const s3 = new S3Client({ region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1' });
    await s3.send(new HeadBucketCommand({ Bucket: process.env.S3_BUCKET }));
    console.log('PASS S3 bucket');
  } catch (error) {
    failed = true;
    console.error('FAIL S3 bucket:', error.message);
  }
}

if (failed) process.exitCode = 1;
else console.log('PASS production dependencies');
