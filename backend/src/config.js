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
};
