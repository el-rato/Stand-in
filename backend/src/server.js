import { config } from './config.js';
import app, { store } from './app.js';

if (process.env.NODE_ENV !== 'test') {
  app.listen(config.port, () => {
    console.log(`[standin-api] listening on :${config.port} (store=${store.kind})`);
  });
}

export { app, store };
