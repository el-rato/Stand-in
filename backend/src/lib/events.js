// Fan-out hub for live marketplace events (job posted / claimed / delivered / paid).
// Single-process default. Scale path: replace the in-memory fan-out with
// Redis pub/sub (REDIS_URL) so every API replica streams every event.
// The SSE route is the only consumer, so the swap is one file.

import { EventEmitter } from 'node:events';
import { getRedis } from './redis.js';

const bus = new EventEmitter();
bus.setMaxListeners(1000);

export async function publish(type, payload = {}) {
  const event = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`, type, at: new Date().toISOString(), ...payload };
  const redis = getRedis();
  if (redis) {
    try { await (await redis).publish('standin:events', JSON.stringify(event)); }
    catch (err) {
      console.error('[events]', err.message);
      bus.emit('event', event);
    }
  } else bus.emit('event', event);
  return event;
}

export async function subscribe(handler) {
  const redis = getRedis();
  if (!redis) {
    bus.on('event', handler);
    return () => bus.off('event', handler);
  }
  const subscriber = (await redis).duplicate();
  subscriber.on('error', err => console.error('[redis:subscriber]', err.message));
  await subscriber.connect();
  await subscriber.subscribe('standin:events', message => {
    try { handler(JSON.parse(message)); }
    catch (err) { console.error('[events]', err.message); }
  });
  return () => subscriber.close();
}
