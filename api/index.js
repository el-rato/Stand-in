let appPromise;

async function getApp() {
  appPromise ??= Promise.resolve().then(async () => {
    const [{ createStore }, { createApp }, { assertProdConfig }] = await Promise.all([
      import('../backend/src/store/index.js'),
      import('../backend/src/app.js'),
      import('../backend/src/lib/guards.js'),
    ]);
    assertProdConfig(process.env);
    const store = await createStore();
    return createApp(store);
  });
  return appPromise;
}

export default async function handler(req, res) {
  if (req.url === '/ready') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.end(JSON.stringify({ ok: true, runtime: 'node' }));
  }

  try {
    const app = await getApp();
    return app(req, res);
  } catch (error) {
    console.error('[standin-api] startup failed:', error);
    if (!res.headersSent) {
      res.statusCode = 503;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.end(JSON.stringify({
        ok: false,
        error: 'service_unavailable',
        reason: error?.code === 'ERR_MODULE_NOT_FOUND' ? 'dependency_missing' : 'startup_failed',
      }));
    }
    return res.end();
  }
}

// Let Express parse bodies itself (needed for the Stripe raw-body webhook).
export const config = { api: { bodyParser: false } };
