export function errorHandler(err, req, res, _next) {
  if (err?.issues) {
    // zod validation error
    return res.status(400).json({ error: { code: 'validation', message: 'invalid request', details: err.issues } });
  }
  const status = err?.status || 500;
  const code = err?.code || 'internal';
  if (status >= 500) console.error('[api]', err);
  res.status(status).json({ error: { code, message: err?.message || 'internal error' } });
}
