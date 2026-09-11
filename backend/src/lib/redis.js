import { createClient } from 'redis';
import { RedisStore } from 'rate-limit-redis';
import { config } from '../config.js';

let clientPromise;

export function getRedis() {
  if (!config.redisUrl) return null;
  if (!clientPromise) {
    const client = createClient({ url: config.redisUrl });
    client.on('error', err => console.error('[redis]', err.message));
    clientPromise = client.connect().then(() => client);
  }
  return clientPromise;
}

export function rateLimitStore(prefix) {
  if (!config.redisUrl) return undefined;
  return new RedisStore({
    prefix: `standin:${prefix}:`,
    sendCommand: async (...args) => (await getRedis()).sendCommand(args),
  });
}
