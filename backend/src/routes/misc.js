import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { requireAuth } from '../middleware/auth.js';
import { subscribe } from '../lib/events.js';
import { newId } from '../lib/util.js';

// Realtime (SSE) + metrics + local uploads (presigned-style).
// Scale path: uploads move to S3 presigned POSTs; this route keeps the
// same response shape ({ uploadUrl, publicUrl }) so clients don't change.

export function miscRoutes(store, config) {
  const r = Router();

  r.get('/stream', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(`: connected\n\n`);
    const off = subscribe((event) => {
      res.write(`event: ${event.type}\n`);
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    const beat = setInterval(() => res.write(`: ping\n\n`), 25000);
    req.on('close', () => { clearInterval(beat); off(); });
  });

  r.get('/metrics/summary', async (req, res, next) => {
    try {
      const since = new Date();
      since.setUTCHours(0, 0, 0, 0);
      const [paidToday, openJobs] = await Promise.all([
        store.sumReleasedSince(since.toISOString()),
        store.countOpen(),
      ]);
      res.json({ paidToday, openJobs, feeBps: 2000, currency: 'USD' });
    } catch (e) { next(e); }
  });

  r.post('/uploads/presign', requireAuth(store), (req, res) => {
    const id = `${newId('v')}.mp4`;
    res.json({
      uploadUrl: `/api/v1/uploads/${id}`,
      publicUrl: `/uploads/${id}`,
      note: 'local demo storage — swap for S3 presigned URLs in production',
    });
  });

  r.put('/uploads/:id', requireAuth(store), (req, res, next) => {
    try {
      const safe = path.basename(req.params.id);
      fs.mkdirSync(config.uploadsDir, { recursive: true });
      const dest = path.join(config.uploadsDir, safe);
      const ws = fs.createWriteStream(dest);
      req.pipe(ws);
      ws.on('finish', () => res.json({ publicUrl: `/uploads/${safe}` }));
      ws.on('error', next);
    } catch (e) { next(e); }
  });

  return r;
}
