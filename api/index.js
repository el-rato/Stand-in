// Vercel serverless entry: the same Express app + store as local dev.
// Requires DATABASE_URL (serverless filesystems can't persist the JSON store).
import { createStore } from '../backend/src/store/index.js';
import { createApp } from '../backend/src/app.js';
import { assertProdConfig } from '../backend/src/lib/guards.js';

assertProdConfig(process.env);
const store = await createStore();
const app = createApp(store);

export default app;

// Let Express parse bodies itself (needed for the Stripe raw-body webhook).
export const config = { api: { bodyParser: false } };
