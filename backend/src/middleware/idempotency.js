// Idempotency for money-moving POSTs (jobs, checkout).
// Client sends `Idempotency-Key: <uuid>`; replays return the original
// response without double-charging. Single-process map + store persistence.
// Scale path: move this to Redis with TTL.

export function idempotency(store) {
  return async (req, res, next) => {
    const key = req.headers['idempotency-key'];
    if (!key || typeof key !== 'string') return next();
    const namespaced = `${req.user ? req.user.id : 'anon'}:${key}`;
    const hit = await store.idemGet(namespaced);
    if (hit) return res.status(hit.status).json(hit.body);
    const json = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode < 500) {
        store.idemSet(namespaced, { status: res.statusCode, body }).catch(() => {});
      }
      return json(body);
    };
    next();
  };
}
