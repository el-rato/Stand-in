// Store selector: Postgres when DATABASE_URL is set, otherwise the
// zero-dependency JSON store. Routes depend only on the interface.

import { config } from '../config.js';
import { createJsonStore } from './jsonStore.js';

export async function createStore() {
  if (config.databaseUrl) {
    const { createPostgresStore } = await import('./postgresStore.js');
    console.log('[store] using postgres');
    return createPostgresStore(config.databaseUrl);
  }
  // Serverless filesystems are read-only: the JSON store cannot persist there.
  if (process.env.VERCEL) {
    throw new Error('DATABASE_URL is required on Vercel — the JSON store cannot persist on serverless. See README deploy section.');
  }
  console.log('[store] using json file:', config.dataFile);
  return createJsonStore(config.dataFile);
}
