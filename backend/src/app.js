import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { errorHandler } from './middleware/errors.js';
import { wafLite } from './middleware/waf.js';
import { authRoutes } from './routes/auth.js';
import { jobRoutes } from './routes/jobs.js';
import { doerRoutes } from './routes/doers.js';
import { billingRoutes, businessRoutes } from './routes/billing.js';
import { adminRoutes } from './routes/admin.js';
import { reportRoutes } from './routes/reports.js';
import { payoutRoutes, adminPayoutRoutes } from './routes/payouts.js';
import { miscRoutes } from './routes/misc.js';
import openapi from './openapi.json' with { type: 'json' };

export function createApp(store) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  // Helmet defaults would kill the product: `script-src 'self'` blocks every
  // inline <script> (the whole frontend runs on them) and the image/font
  // CDNs. Explicit policy: same-origin + the CDNs the pages actually use.
  // HSTS only in production: on localhost it would force-upgrade later
  // plain-http dev visits to https and brick them.
  app.use(helmet({
    crossOriginResourcePolicy: false,
    hsts: config.isProd ? undefined : false,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdnjs.cloudflare.com'],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://api.fontshare.com', 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https:', 'data:'],
        imgSrc: ["'self'", 'https:', 'data:', 'blob:'],
        connectSrc: ["'self'", 'http://localhost:*', 'ws://localhost:*'],
        frameAncestors: ["'self'"],
        baseUri: ["'self'"],
        objectSrc: ["'none'"],
      },
    },
  }));
  app.use(cors({ origin: config.frontendOrigin.length ? config.frontendOrigin : true }));
  app.use(morgan(config.isProd ? 'combined' : 'dev'));
  app.use(wafLite); // scanner probes + hostile query strings die here

  // Stripe webhook needs the raw body — mount before express.json().
  app.use('/api/v1/billing/webhook', express.raw({ type: 'application/json' }));
  app.use(express.json({ limit: '256kb' }));
  app.use('/uploads', express.static(config.uploadsDir));

  const noLimit = process.env.RATE_LIMIT_DISABLED === '1'; // load/attack scripts only, never prod
  const authLimiter = rateLimit({ windowMs: 60_000, max: 20 });
  const writeLimiter = rateLimit({ windowMs: 60_000, max: 120 });
  const adminLimiter = rateLimit({ windowMs: 60_000, max: 120 });
  const maybe = (limiter) => (noLimit ? ((_req, _res, next) => next()) : limiter);

  app.get('/health', (_req, res) => res.json({ ok: true, store: store.kind }));
  app.get('/ready', (_req, res) => res.json({ ok: true }));
  app.get('/api/openapi.json', (_req, res) => res.json(openapi));
  app.get('/api/docs', (_req, res) => {
    const rows = Object.entries(openapi.paths)
      .map(([p, ops]) => Object.entries(ops)
        .map(([m, o]) => `<tr><td><b>${m.toUpperCase()}</b></td><td><code>${p}</code></td><td>${o.summary || ''}</td></tr>`).join(''))
      .join('');
    res.send(`<!doctype html><html><head><meta charset="utf-8"><title>STANDIN API docs</title>
      <style>body{font-family:system-ui,sans-serif;max-width:900px;margin:40px auto;padding:0 20px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ddd;padding:8px;font-size:14px}</style>
      </head><body><h1>STANDIN API ${openapi.info.version}</h1>
      <p>Full machine-readable spec: <a href="/api/openapi.json">openapi.json</a></p>
      <table><tr><th>Method</th><th>Path</th><th>What</th></tr>${rows}</table></body></html>`);
  });

  app.use('/api/v1/auth', maybe(authLimiter), authRoutes(store));
  app.use('/api/v1/jobs', maybe(writeLimiter), jobRoutes(store));
  app.use('/api/v1/doers', maybe(writeLimiter), doerRoutes(store));
  app.use('/api/v1/billing', billingRoutes(store, config));
  app.use('/api/v1/business', businessRoutes(store));
  app.use('/api/v1/admin', maybe(adminLimiter), adminRoutes(store));
  app.use('/api/v1/admin', maybe(adminLimiter), adminPayoutRoutes(store));
  app.use('/api/v1/reports', maybe(writeLimiter), reportRoutes(store));
  app.use('/api/v1', maybe(writeLimiter), payoutRoutes(store, config));
  app.use('/api/v1', miscRoutes(store, config));

  // Same-origin frontend: one process serves product + API.
  // Backend internals are never exposed through this mount.
  if (fs.existsSync(path.join(config.webDir, 'index.html'))) {
    app.use((req, res, next) => {
      if (req.path === '/backend' || req.path.startsWith('/backend/') || req.path.startsWith('/node_modules')) {
        return res.status(404).end();
      }
      next();
    });
    app.use(express.static(config.webDir, { dotfiles: 'deny', index: 'index.html' }));
  }

  app.use('/api', (_req, res) => res.status(404).json({ error: { code: 'not_found', message: 'unknown endpoint' } }));
  app.use(errorHandler);
  return app;
}
