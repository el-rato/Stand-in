import { Router } from 'express';
import { z } from 'zod';
import { publish } from '../lib/events.js';

const reportSchema = z.object({
  type: z.enum(['safety', 'contact']),
  subject: z.string().min(4).max(120),
  message: z.string().min(10).max(2000),
  contact: z.string().max(120).optional().default(''),
  jobId: z.string().max(80).optional(),
});

// Public inbox: anyone can file a safety report or contact message.
// Rate-limited with the writes bucket; owners read via /api/v1/admin/reports.
export function reportRoutes(store) {
  const r = Router();

  r.post('/', async (req, res, next) => {
    try {
      const body = reportSchema.parse(req.body);
      const report = await store.createReport(body);
      publish('report.filed', { reportId: report.id, type: report.type });
      res.status(201).json({ report: { id: report.id, type: report.type } });
    } catch (e) { next(e); }
  });

  return r;
}
