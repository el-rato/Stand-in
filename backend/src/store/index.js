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
  console.log('[store] using json file:', config.dataFile);
  return createJsonStore(config.dataFile);
}
