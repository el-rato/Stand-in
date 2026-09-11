import { config } from './config.js';
import { assertProdConfig } from './lib/guards.js';
import { createStore } from './store/index.js';
import { createApp } from './app.js';

assertProdConfig(process.env);
const store = await createStore();
const app = createApp(store);

if (process.env.NODE_ENV !== 'test') {
  app.listen(config.port, () => {
    console.log(`[standin-api] listening on :${config.port} (store=${store.kind})`);
  });
}

export { app, store };
