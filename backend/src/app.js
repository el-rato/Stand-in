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

import { createStore } from './store/index.js';
import { assertProdConfig } from './lib/guards.js';


export function createApp(store) {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  // --------------------------------------------------
  // Security
  // --------------------------------------------------

  app.use(
    helmet({
      crossOriginResourcePolicy: false,

      hsts: config.isProd ? undefined : false,

      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],

          scriptSrc: [
            "'self'",
            "'unsafe-inline'",
            'https://cdnjs.cloudflare.com',
          ],

          styleSrc: [
            "'self'",
            "'unsafe-inline'",
            'https://api.fontshare.com',
            'https://fonts.googleapis.com',
          ],

          fontSrc: [
            "'self'",
            'https:',
            'data:',
          ],

          imgSrc: [
            "'self'",
            'https:',
            'data:',
            'blob:',
          ],

          connectSrc: config.isProd
            ? ["'self'", 'https:', 'wss:']
            : [
                "'self'",
                'http://localhost:*',
                'ws://localhost:*',
                'https:',
                'wss:',
              ],

          frameAncestors: ["'self'"],
          baseUri: ["'self'"],
          objectSrc: ["'none'"],
        },
      },
    })
  );

  // --------------------------------------------------
  // CORS
  // --------------------------------------------------

  app.use(
    cors({
      origin: config.frontendOrigin?.length
        ? config.frontendOrigin
        : true,

      credentials: true,
    })
  );

  // --------------------------------------------------
  // Logging + WAF
  // --------------------------------------------------

  app.use(morgan(config.isProd ? 'combined' : 'dev'));

  app.use(wafLite);

  // --------------------------------------------------
  // Stripe webhook
  //
  // MUST be before express.json() because Stripe
  // signature verification requires the raw body.
  // --------------------------------------------------

  app.use(
    '/api/v1/billing/webhook',
    express.raw({
      type: 'application/json',
    })
  );

  // --------------------------------------------------
  // JSON parser
  // --------------------------------------------------

  app.use(
    express.json({
      limit: '256kb',
    })
  );

  // --------------------------------------------------
  // Uploads
  // --------------------------------------------------

  if (config.uploadsDir) {
    app.use(
      '/uploads',
      express.static(config.uploadsDir)
    );
  }

  // --------------------------------------------------
  // Rate limiting
  // --------------------------------------------------

  const noLimit =
    !config.isProd &&
    process.env.RATE_LIMIT_DISABLED === '1';

  const authLimiter = rateLimit({
    windowMs: 60_000,
    max: 20,
  });

  const writeLimiter = rateLimit({
    windowMs: 60_000,
    max: 120,
  });

  const adminLimiter = rateLimit({
    windowMs: 60_000,
    max: 120,
  });

  const maybe = (limiter) =>
    noLimit
      ? (_req, _res, next) => next()
      : limiter;

  // --------------------------------------------------
  // Health
  // --------------------------------------------------

  app.get('/', (_req, res) => {
    res.json({
      ok: true,
      service: 'standin-api',
    });
  });

  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      store: store?.kind ?? 'unknown',
    });
  });

  app.get('/ready', (_req, res) => {
    res.json({
      ok: true,
    });
  });

  // --------------------------------------------------
  // OpenAPI
  // --------------------------------------------------

  app.get('/api/openapi.json', (_req, res) => {
    res.json(openapi);
  });

  app.get('/api/docs', (_req, res) => {
    const rows = Object.entries(openapi.paths)
      .map(([routePath, operations]) =>
        Object.entries(operations)
          .map(
            ([method, operation]) => `
              <tr>
                <td><b>${method.toUpperCase()}</b></td>
                <td><code>${routePath}</code></td>
                <td>${operation.summary || ''}</td>
              </tr>
            `
          )
          .join('')
      )
      .join('');

    res.send(`
      <!doctype html>
      <html>
        <head>
          <meta charset="utf-8">

          <title>STANDIN API docs</title>

          <style>
            body {
              font-family: system-ui, sans-serif;
              max-width: 900px;
              margin: 40px auto;
              padding: 0 20px;
            }

            table {
              border-collapse: collapse;
              width: 100%;
            }

            td,
            th {
              border: 1px solid #ddd;
              padding: 8px;
              font-size: 14px;
            }
          </style>
        </head>

        <body>
          <h1>STANDIN API ${openapi.info.version}</h1>

          <p>
            Full machine-readable spec:
            <a href="/api/openapi.json">
              openapi.json
            </a>
          </p>

          <table>
            <tr>
              <th>Method</th>
              <th>Path</th>
              <th>What</th>
            </tr>

            ${rows}
          </table>
        </body>
      </html>
    `);
  });

  // --------------------------------------------------
  // API routes
  // --------------------------------------------------

  app.use(
    '/api/v1/auth',
    maybe(authLimiter),
    authRoutes(store)
  );

  app.use(
    '/api/v1/jobs',
    maybe(writeLimiter),
    jobRoutes(store)
  );

  app.use(
    '/api/v1/doers',
    maybe(writeLimiter),
    doerRoutes(store)
  );

  app.use(
    '/api/v1/billing',
    billingRoutes(store, config)
  );

  app.use(
    '/api/v1/business',
    businessRoutes(store)
  );

  app.use(
    '/api/v1/admin',
    maybe(adminLimiter),
    adminRoutes(store)
  );

  app.use(
    '/api/v1/admin',
    maybe(adminLimiter),
    adminPayoutRoutes(store)
  );

  app.use(
    '/api/v1/reports',
    maybe(writeLimiter),
    reportRoutes(store)
  );

  app.use(
    '/api/v1',
    maybe(writeLimiter),
    payoutRoutes(store, config)
  );

  app.use(
    '/api/v1',
    miscRoutes(store, config)
  );

  // --------------------------------------------------
  // Frontend
  // --------------------------------------------------

  if (
    config.webDir &&
    fs.existsSync(
      path.join(config.webDir, 'index.html')
    )
  ) {
    app.use((req, res, next) => {
      if (
        req.path === '/backend' ||
        req.path.startsWith('/backend/') ||
        req.path.startsWith('/node_modules')
      ) {
        return res.status(404).end();
      }

      next();
    });

    app.use(
      express.static(config.webDir, {
        dotfiles: 'deny',
        index: 'index.html',
      })
    );
  }

  // --------------------------------------------------
  // API 404
  // --------------------------------------------------

  app.use('/api', (_req, res) => {
    res.status(404).json({
      error: {
        code: 'not_found',
        message: 'unknown endpoint',
      },
    });
  });

  // --------------------------------------------------
  // Error handler
  // --------------------------------------------------

  app.use(errorHandler);

  return app;
}


// ====================================================
// Vercel entry point
// ====================================================

assertProdConfig(process.env);
const store = await createStore();

const app = createApp(store);

// Vercel requires the Express app/server as default export.
export { store };
export default app;