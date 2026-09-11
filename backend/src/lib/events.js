// Fan-out hub for live marketplace events (job posted / claimed / delivered / paid).
// Single-process default. Scale path: replace the in-memory fan-out with
// Redis pub/sub (REDIS_URL) so every API replica streams every event.
// The SSE route is the only consumer, so the swap is one file.

import { EventEmitter } from 'node:events';

const bus = new EventEmitter();
bus.setMaxListeners(1000);

let seq = 0;

export function publish(type, payload = {}) {
  seq += 1;
  const event = { seq, type, at: new Date().toISOString(), ...payload };
  bus.emit('event', event);
  return event;
}

export function subscribe(handler) {
  bus.on('event', handler);
  return () => bus.off('event', handler);
}
