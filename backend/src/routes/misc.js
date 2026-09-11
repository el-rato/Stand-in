import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { requireAuth } from '../middleware/auth.js';
import { subscribe } from '../lib/events.js';
import { newId } from '../lib/util.js';

// Realtime (SSE) + metrics + S3 presigned uploads in production.

export function miscRoutes(store, config) {
  const r = Router();

  r.get('/stream', async (req, res, next) => {
    try {
      const off = await subscribe((event) => {
        res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      });
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write('retry: 3000\n: connected\n\n');
      const beat = setInterval(() => res.write(': ping\n\n'), 20000);
      const recycle = setTimeout(() => res.end(), 240000);
      req.on('close', () => { clearInterval(beat); clearTimeout(recycle); off(); });
    } catch (e) {
      next(e);
    }
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

  r.post('/uploads/presign', requireAuth(store), async (req, res, next) => {
    const id = `${newId('v')}.mp4`;
    try {
      if (config.s3Bucket) {
        const [{ S3Client, PutObjectCommand }, { getSignedUrl }] = await Promise.all([
          import('@aws-sdk/client-s3'),
          import('@aws-sdk/s3-request-presigner'),
        ]);
        const key = `uploads/${id}`;
        const client = new S3Client({ region: config.s3Region });
        const uploadUrl = await getSignedUrl(client, new PutObjectCommand({
          Bucket: config.s3Bucket,
          Key: key,
          ContentType: 'video/mp4',
        }), { expiresIn: 900 });
        const base = config.s3PublicBaseUrl || `https://${config.s3Bucket}.s3.${config.s3Region}.amazonaws.com`;
        return res.json({ uploadUrl, publicUrl: `${base}/${key}` });
      }
      if (config.isVercel) {
        return res.status(503).json({ error: { code: 'storage_unavailable', message: 'S3 storage is not configured' } });
      }
      res.json({ uploadUrl: `/api/v1/uploads/${id}`, publicUrl: `/uploads/${id}` });
    } catch (e) { next(e); }
  });

  r.put('/uploads/:id', requireAuth(store), (req, res, next) => {
    try {
      if (config.s3Bucket || config.isVercel) {
        return res.status(405).json({ error: { code: 'direct_upload_required', message: 'use the presigned upload URL' } });
      }
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
