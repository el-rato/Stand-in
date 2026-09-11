// Vercel and local development share the app and store initialized in app.js.
// Production configuration is validated there before creating the store.
export { default } from '../backend/src/app.js';

// Let Express parse bodies itself (needed for the Stripe raw-body webhook).
export const config = { api: { bodyParser: false } };
