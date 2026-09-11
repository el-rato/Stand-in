import { createStore } from '../backend/src/store/index.js';
import { createApp } from '../backend/src/app.js';
import { assertProdConfig } from '../backend/src/lib/guards.js';

let appPromise;

async function getApp() {
  appPromise ??= Promise.resolve().then(async () => {
    assertProdConfig(process.env);
    const store = await createStore();
    return createApp(store);
  });
  return appPromise;
}

export default async function handler(req, res) {
  try {
    const app = await getApp();
    return app(req, res);
  } catch (error) {
    console.error('[standin-api] startup failed:', error);
    if (!res.headersSent) {
      res.statusCode = 503;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.end(JSON.stringify({ ok: false, error: 'service_unavailable' }));
    }
    return res.end();
  }
}

// Let Express parse bodies itself (needed for the Stripe raw-body webhook).
export const config = { api: { bodyParser: false } };
