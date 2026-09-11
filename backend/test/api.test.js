import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'standin-test-'));
process.env.DATA_FILE = path.join(tmp, 'db.json');
process.env.JWT_SECRET = 'test-secret';
process.env.NODE_ENV = 'test';
process.env.ADMIN_EMAILS = 'boss@test.io';
// Hermetic suite: blanking beats deleting — dotenv (loaded at import) only
// fills variables that are unset, so this locks the suite onto temp JSON
// even when backend/.env points at a real database.
process.env.DATABASE_URL = '';

const { app } = await import('../src/server.js');
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

after(() => new Promise((resolve) => server.close(resolve)));

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

test('logs in successfully with token + user', async () => {
  const r = await api('POST', '/api/v1/auth/login', { body: { email: 'ana@test.io', password: 'password123' } });
  assert.equal(r.status, 200);
  assert.ok(r.json.token);
  assert.equal(r.json.user.email, 'ana@test.io');
  const me = await api('GET', '/api/v1/jobs/mine', { token: r.json.token });
  assert.equal(me.status, 200);
});

test('password change needs current, then new works and old dies', async () => {
  const login = await api('POST', '/api/v1/auth/login', { body: { email: 'ana@test.io', password: 'password123' } });
  const tok = login.json.token;
  const wrong = await api('POST', '/api/v1/auth/password', { token: tok, body: { currentPassword: 'nope', newPassword: 'newpassword1' } });
  assert.equal(wrong.status, 401);
  const short = await api('POST', '/api/v1/auth/password', { token: tok, body: { currentPassword: 'password123', newPassword: 'short' } });
  assert.equal(short.status, 400);
  const ok = await api('POST', '/api/v1/auth/password', { token: tok, body: { currentPassword: 'password123', newPassword: 'newpassword1' } });
  assert.equal(ok.json.ok, true);
  const oldDead = await api('POST', '/api/v1/auth/login', { body: { email: 'ana@test.io', password: 'password123' } });
  assert.equal(oldDead.status, 401);
  const newWorks = await api('POST', '/api/v1/auth/login', { body: { email: 'ana@test.io', password: 'newpassword1' } });
  assert.equal(newWorks.status, 200);
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

test('admin area rejects anonymous and non-owners', async () => {
  const anon = await api('GET', '/api/v1/admin/overview');
  assert.equal(anon.status, 401);
  const user = await api('GET', '/api/v1/admin/overview', { token: asker });
  assert.equal(user.status, 403);
});

test('owner bootstrap, stats, moderation, roles', async () => {  const reg = await api('POST', '/api/v1/auth/register', { body: { name: 'Boss', email: 'boss@test.io', password: 'password123', city: 'Berlin' } });
  assert.equal(reg.status, 201);
  const boss = reg.json.token;
  const over = await api('GET', '/api/v1/admin/overview', { token: boss });
  assert.equal(over.status, 200);
  assert.ok(over.json.stats.users >= 3);
  assert.ok('openJobs' in over.json.stats);
  const p = await api('POST', '/api/v1/jobs', { token: asker, body: { title: 'Admin moderation target job here', category: 'place_check', city: 'Berlin' } });
  const mod = await api('POST', `/api/v1/admin/jobs/${p.json.job.id}/cancel`, { token: boss });
  assert.equal(mod.json.job.status, 'refunded');
  const users = await api('GET', '/api/v1/admin/users?q=ana', { token: boss });
  assert.ok(users.json.items.some((u) => u.email === 'ana@test.io' && !('passHash' in u)));
  const selfDemote = await api('POST', `/api/v1/admin/users/${reg.json.user.id}/role`, { token: boss, body: { role: 'user' } });
  assert.equal(selfDemote.status, 400);
  const ledger = await api('GET', '/api/v1/admin/ledger?limit=5', { token: boss });
  assert.ok(ledger.json.items.length > 0);
});

test('prod guard rejects weak secrets, passes dev', async () => {
  const { assertProdConfig } = await import('../src/lib/guards.js');
  assert.throws(() => assertProdConfig({ NODE_ENV: 'production', JWT_SECRET: 'short' }), /JWT_SECRET/);
  assert.throws(() => assertProdConfig({ VERCEL: '1', JWT_SECRET: '' }), /JWT_SECRET/);
  assert.throws(() => assertProdConfig({ VERCEL: '1', JWT_SECRET: 'a'.repeat(40) }), /DATABASE_URL/);
  assertProdConfig({ NODE_ENV: 'test', JWT_SECRET: '' });
  assertProdConfig({ NODE_ENV: 'production', JWT_SECRET: 'b'.repeat(40), DATABASE_URL: 'postgres://x' });
});

test('waf blocks scanners, hostile queries, long urls', async () => {
  const env = await api('GET', '/.env');
  assert.equal(env.status, 404);
  assert.ok(env.json.error);
  const wp = await api('GET', '/wp-admin/');
  assert.equal(wp.status, 404);
  const long = await api('GET', '/api/v1/jobs/feed?' + 'x'.repeat(2100));
  assert.equal(long.status, 414);
  const badCursor = await api('GET', '/api/v1/jobs/feed?cursor=' + 'y'.repeat(201));
  assert.equal(badCursor.status, 400);
});

test('waf blocks hostile query strings for admins too', async () => {
  const bossLogin = await api('POST', '/api/v1/auth/login', { body: { email: 'boss@test.io', password: 'password123' } });
  const hostile = await api('GET', '/api/v1/admin/users?q=<script>alert(1)</script>', { token: bossLogin.json.token });
  assert.equal(hostile.status, 403);
  assert.equal(hostile.json.error.code, 'blocked');
});

test('unknown-email login fails closed with same shape', async () => {
  const r = await api('POST', '/api/v1/auth/login', { body: { email: 'nobody@test.io', password: 'password123' } });
  assert.equal(r.status, 401);
  assert.equal(r.json.error.code, 'bad_credentials');
});

test('admin export snapshots users and jobs', async () => {  const bossLogin = await api('POST', '/api/v1/auth/login', { body: { email: 'boss@test.io', password: 'password123' } });
  const bossTok = bossLogin.json.token;
  const exp = await api('GET', '/api/v1/admin/export', { token: bossTok });
  assert.equal(exp.status, 200);
  assert.ok(Array.isArray(exp.json.users) && exp.json.users.length > 0);
  assert.ok(Array.isArray(exp.json.jobs) && exp.json.jobs.length > 0);
  assert.ok(exp.json.users.every((u) => !('passHash' in u)));
  const denied = await api('GET', '/api/v1/admin/export', { token: asker });
  assert.equal(denied.status, 403);
});

test('reports: public filing validates, admin reads, users blocked', async () => {
  const bad = await api('POST', '/api/v1/reports', { body: { type: 'safety', subject: 'x', message: 'short' } });
  assert.equal(bad.status, 400);
  const badType = await api('POST', '/api/v1/reports', { body: { type: 'spam', subject: 'Valid subject here', message: 'A long enough message body here' } });
  assert.equal(badType.status, 400);
  const filed = await api('POST', '/api/v1/reports', { body: { type: 'safety', subject: 'Doer asked for my address', message: 'During the handoff they requested my home address in chat', contact: 'ask@pen.io' } });
  assert.equal(filed.status, 201);
  assert.ok(filed.json.report.id);
  const bossLogin = await api('POST', '/api/v1/auth/login', { body: { email: 'boss@test.io', password: 'password123' } });
  const inbox = await api('GET', '/api/v1/admin/reports?type=safety', { token: bossLogin.json.token });
  assert.ok(inbox.json.items.some((r) => r.subject === 'Doer asked for my address'));
  const blocked = await api('GET', '/api/v1/admin/reports', { token: asker });
  assert.equal(blocked.status, 403);
});

test('payouts: connect, minimum, earn, cash out once, never twice', async () => {
  const ra = await api('POST', '/api/v1/auth/register', { body: { name: 'Rich', email: 'rich@test.io', password: 'password123', city: 'Paris' } });
  const rw = await api('POST', '/api/v1/auth/register', { body: { name: 'Work', email: 'work@test.io', password: 'password123', city: 'Paris' } });
  const wt = rw.json.token;
  const noConnect = await api('POST', '/api/v1/doers/connect', { token: ra.json.token });
  assert.equal(noConnect.status, 403); // asker is not a verified doer
  await api('POST', '/api/v1/doers/profile', { token: wt, body: { displayName: 'Work', city: 'Paris' } });
  await api('POST', '/api/v1/doers/verify', { token: wt });
  const conn = await api('POST', '/api/v1/doers/connect', { token: wt });
  assert.equal(conn.json.connected, true);
  const low = await api('POST', '/api/v1/payouts/request', { token: wt });
  assert.equal(low.status, 400); // $0 < $5 floor
  const job = await api('POST', '/api/v1/jobs', { token: ra.json.token, body: { title: 'Payout test proposal filming job', category: 'proposal', city: 'Paris' } });
  await api('POST', `/api/v1/jobs/${job.json.job.id}/claim`, { token: wt });
  await api('POST', `/api/v1/jobs/${job.json.job.id}/deliver`, { token: wt, body: { videoUrl: 'https://cdn.test/p.mp4' } });
  await api('POST', `/api/v1/jobs/${job.json.job.id}/approve`, { token: ra.json.token });
  const mine = await api('GET', '/api/v1/payouts/mine', { token: wt });
  assert.equal(mine.json.available, 7.2);
  const out = await api('POST', '/api/v1/payouts/request', { token: wt });
  assert.equal(out.status, 201);
  assert.equal(out.json.payout.amount, 7.2);
  assert.equal(out.json.payout.status, 'queued'); // demo mode: no STRIPE_SECRET
  const again = await api('POST', '/api/v1/payouts/request', { token: wt });
  assert.equal(again.status, 400); // balance consumed — no double pay
});

test('admin sees payouts', async () => {
  const bossLogin = await api('POST', '/api/v1/auth/login', { body: { email: 'boss@test.io', password: 'password123' } });
  const all = await api('GET', '/api/v1/admin/payouts', { token: bossLogin.json.token });
  assert.ok(all.json.items.some((p) => p.amount === 7.2));
});

test('moderation blocks violating posts with reasons', async () => {
  const richLogin = await api('POST', '/api/v1/auth/login', { body: { email: 'rich@test.io', password: 'password123' } });
  const tok = richLogin.json.token;
  const sex = await api('POST', '/api/v1/jobs', { token: tok, body: { title: 'Discreet escort needed tonight downtown', category: 'place_check', city: 'Berlin' } });
  assert.equal(sex.status, 422);
  assert.equal(sex.json.error.code, 'sexual_content');
  const contact = await api('POST', '/api/v1/jobs', { token: tok, body: { title: 'Film my street party tonight please', category: 'place_check', city: 'Berlin', description: 'Call +1 555 123 4567 to arrange the details' } });
  assert.equal(contact.status, 422);
  assert.equal(contact.json.error.code, 'contact_info');
  const meet = await api('POST', '/api/v1/jobs', { token: tok, body: { title: 'Hang out together this evening', category: 'place_check', city: 'Berlin', description: 'Come over to my place around midnight' } });
  assert.equal(meet.status, 422);
  assert.equal(meet.json.error.code, 'private_meetup');
  const link = await api('POST', '/api/v1/jobs', { token: tok, body: { title: 'Check this busy market street', category: 'place_check', city: 'Berlin', description: 'Details at https://evil.test/x please' } });
  assert.equal(link.status, 422);
  assert.equal(link.json.error.code, 'offplatform');
});

test('moderation flags weird posts but lets legit ones through with details', async () => {
  const richLogin = await api('POST', '/api/v1/auth/login', { body: { email: 'rich@test.io', password: 'password123' } });
  const tok = richLogin.json.token;
  const weird = await api('POST', '/api/v1/jobs', { token: tok, body: { title: 'AMAZING DEAL FREE MONEY CLICK NOWWWWWWW', category: 'place_check', city: 'Berlin' } });
  assert.equal(weird.status, 201);
  assert.ok(weird.json.job.moderation.flags.length > 0);
  const legit = await api('POST', '/api/v1/jobs', {
    token: tok,
    body: { title: 'Film the proposal at the Eiffel Tower at dusk', category: 'proposal', city: 'Paris', description: 'Be near the south pillar by 8pm, capture the moment quietly', deadline: '24h', videoLength: '1:30' },
  });
  assert.equal(legit.status, 201);
  assert.deepEqual(legit.json.job.moderation.flags, []);
  assert.equal(legit.json.job.description, 'Be near the south pillar by 8pm, capture the moment quietly');
  assert.equal(legit.json.job.deadline, '24h');
  assert.equal(legit.json.job.videoLength, '1:30');
});
