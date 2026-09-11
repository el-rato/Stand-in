import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertProdConfig } from '../src/lib/guards.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'standin-test-'));
process.env.DATA_FILE = path.join(tmp, 'db.json');
process.env.JWT_SECRET = 'test-secret';
process.env.NODE_ENV = 'test';
process.env.ADMIN_EMAILS = 'ana@test.io';

const { app } = await import('../src/server.js');
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

after(() => new Promise((resolve) => server.close(resolve)));

test('production guard requires durable serverless services', () => {
  assert.throws(
    () => assertProdConfig({ VERCEL: '1', JWT_SECRET: 'x'.repeat(32), DATABASE_URL: 'postgres://configured' }),
    /REDIS_URL.*S3_BUCKET/
  );
});

async function api(method, p, { token, body, headers } = {}) {
  const res = await fetch(base + p, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(headers || {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

let asker, doer, jobId;

test('registers asker and doer', async () => {
  const a = await api('POST', '/api/v1/auth/register', { body: { name: 'Ana', email: 'ana@test.io', password: 'password123', city: 'Lisbon' } });
  assert.equal(a.status, 201);
  asker = a.json.token;
  const d = await api('POST', '/api/v1/auth/register', { body: { name: 'Ben', email: 'ben@test.io', password: 'password123', city: 'Berlin' } });
  assert.equal(d.status, 201);
  doer = d.json.token;
});

test('rejects bad login', async () => {
  const r = await api('POST', '/api/v1/auth/login', { body: { email: 'ana@test.io', password: 'wrong' } });
  assert.equal(r.status, 401);
});

test('verifies doer', async () => {
  const p = await api('POST', '/api/v1/doers/profile', { token: doer, body: { displayName: 'Ben', city: 'Berlin' } });
  assert.equal(p.status, 200);
  const v = await api('POST', '/api/v1/doers/verify', { token: doer });
  assert.equal(v.json.doer.status, 'verified');
});

test('posts a job with server-side pricing + idempotency', async () => {
  const key = 'test-key-1';
  const r1 = await api('POST', '/api/v1/jobs', {
    token: asker,
    headers: { 'Idempotency-Key': key },
    body: { title: 'Film snow on my street tonight please', category: 'place_check', city: 'Oslo', rush: true, clientId: 'c1' },
  });
  assert.equal(r1.status, 201);
  assert.equal(r1.json.job.total, 7); // 5 base + 2 rush, computed server-side
  jobId = r1.json.job.id;
  const r2 = await api('POST', '/api/v1/jobs', {
    token: asker,
    headers: { 'Idempotency-Key': key },
    body: { title: 'Film snow on my street tonight please', category: 'place_check', city: 'Oslo', rush: true, clientId: 'c1' },
  });
  assert.equal(r2.json.job.id, jobId); // replay returns original, no double charge
});

test('rejects client-invented pricing and bad category', async () => {
  const r = await api('POST', '/api/v1/jobs', { token: asker, body: { title: 'Do something vaguely described here', category: 'teleport', city: 'Oslo' } });
  assert.equal(r.status, 400);
});

test('feed contains the job', async () => {
  const r = await api('GET', '/api/v1/jobs/feed?limit=10');
  assert.equal(r.status, 200);
  assert.ok(r.json.items.some((j) => j.id === jobId));
});

test('blocks unverified claim, allows verified claim, blocks double claim', async () => {
  const bad = await api('POST', `/api/v1/jobs/${jobId}/claim`, { token: asker });
  assert.equal(bad.status, 403); // asker is not a verified doer
  const ok = await api('POST', `/api/v1/jobs/${jobId}/claim`, { token: doer });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.job.status, 'claimed');
  const dup = await api('POST', `/api/v1/jobs/${jobId}/claim`, { token: doer });
  assert.equal(dup.status, 409);
});

test('deliver then approve releases 80% payout', async () => {
  const d = await api('POST', `/api/v1/jobs/${jobId}/deliver`, { token: doer, body: { videoUrl: 'https://cdn.test/v/1.mp4' } });
  assert.equal(d.json.job.status, 'delivered');
  const a = await api('POST', `/api/v1/jobs/${jobId}/approve`, { token: asker });
  assert.equal(a.json.job.status, 'paid');
  const detail = await api('GET', `/api/v1/jobs/${jobId}`);
  const types = Object.fromEntries(detail.json.ledger.map((t) => [t.type, Number(t.amount)]));
  assert.equal(types.release, 5.6);
  assert.equal(types.fee, 1.4);
});

test('cancel refunds an open job, fails after payment', async () => {
  const p = await api('POST', '/api/v1/jobs', { token: asker, body: { title: 'Check if the bar line is short now', category: 'place_check', city: 'Berlin' } });
  const c = await api('POST', `/api/v1/jobs/${p.json.job.id}/cancel`, { token: asker });
  assert.equal(c.json.job.status, 'refunded');
  const late = await api('POST', `/api/v1/jobs/${jobId}/cancel`, { token: asker });
  assert.equal(late.status, 409);
});

test('plus checkout activates plan in demo mode', async () => {
  const r = await api('POST', '/api/v1/billing/plus/checkout', { token: asker, body: {} });
  assert.equal(r.json.plan, 'plus');
});

test('metrics summary works', async () => {
  const r = await api('GET', '/api/v1/metrics/summary');
  assert.equal(r.status, 200);
  assert.ok(r.json.paidToday >= 5.6);
});

test('health endpoints report the initialized store', async () => {
  const root = await api('GET', '/');
  const health = await api('GET', '/health');
  assert.equal(root.status, 200);
  assert.equal(root.json.service, 'standin-api');
  assert.equal(health.status, 200);
  assert.equal(health.json.store, 'json');
});

test('reports, admin APIs, and payouts use complete store contracts', async () => {
  const report = await api('POST', '/api/v1/reports', {
    body: { type: 'contact', subject: 'Partnership request', message: 'Please contact our marketplace team.' },
  });
  assert.equal(report.status, 201);

  const overview = await api('GET', '/api/v1/admin/overview', { token: asker });
  const reports = await api('GET', '/api/v1/admin/reports', { token: asker });
  const users = await api('GET', '/api/v1/admin/users', { token: asker });
  assert.equal(overview.status, 200);
  assert.equal(overview.json.stats.users, 2);
  assert.equal(reports.json.items.length, 1);
  assert.equal(users.json.items.length, 2);

  const payout = await api('POST', '/api/v1/payouts/request', { token: doer, body: {} });
  const mine = await api('GET', '/api/v1/payouts/mine', { token: doer });
  assert.equal(payout.status, 201);
  assert.equal(payout.json.payout.status, 'queued');
  assert.equal(mine.json.available, 0);
  assert.equal(mine.json.payouts.length, 1);
});

test('local and Vercel entry points share one Express app and store', async () => {
  const appModule = await import('../src/app.js');
  const serverModule = await import('../src/server.js');
  const vercelModule = await import('../../api/index.js');
  assert.equal(typeof appModule.default, 'function');
  assert.equal(serverModule.app, appModule.default);
  assert.equal(serverModule.store, appModule.store);
  assert.equal(vercelModule.default, appModule.default);
  assert.equal(vercelModule.config.api.bodyParser, false);
});
