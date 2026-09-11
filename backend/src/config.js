import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

dotenv.config();

const here = path.dirname(fileURLToPath(import.meta.url));

export const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  jwtSecret: process.env.JWT_SECRET || 'dev-only-secret-change-me',
  jwtTtl: process.env.JWT_TTL || '7d',
  databaseUrl: process.env.DATABASE_URL || '',
  dataFile: process.env.DATA_FILE || path.join(here, '..', 'data', 'db.json'),
  uploadsDir: process.env.UPLOADS_DIR || path.join(here, '..', 'uploads'),
  redisUrl: process.env.REDIS_URL || '',
  stripeSecret: process.env.STRIPE_SECRET || '',
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
  frontendOrigin: (process.env.FRONTEND_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean),
  isProd: process.env.NODE_ENV === 'production',
  // Bootstrap owners: these emails auto-promote to admin on first admin-area
  // hit (or run `npm run make-admin -- you@email.com`). Prefer make-admin.
  adminEmails: (process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
  // Complete-product mode: serve the plan folder (index.html, doer.html…)
  // from the same origin, so the site + API are one deployable unit.
  webDir: process.env.WEB_DIR || path.resolve(here, '..', '..'),
};
