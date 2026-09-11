// Load + race stress test: throughput/latency of the hot paths and an
// exactly-once claim race (N doers pounce on 1 job — exactly 1 must win).
// Spins a throwaway server with rate limits off (test-only switch).
// Run: npm run stress. Exit non-zero on any violated assertion.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'standin-stress-'));
// Fixed throwaway port: never collides with a dev server on :3001.
const PORT = 3102;
const server = spawn('node', ['src/server.js'], {
  cwd: new URL('.', import.meta.url),
  env: { ...process.env, PORT: String(PORT), DATA_FILE: path.join(tmp, 'db.json'), JWT_SECRET: 'stress-secret',
    DATABASE_URL: '', // hermetic: never touch a real DB even if backend/.env sets one
    RATE_LIMIT_DISABLED: '1' },
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const B = 'http://localhost:' + PORT;
let failures = 0;

async function req(method, p, { token, body } = {}) {
  const t0 = performance.now();
  const res = await fetch(B + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const ms = performance.now() - t0;
  let json = null;
  try { json = await res.json(); } catch { /* ignore */ }
  return { status: res.status, ms, json };
}

async function pool(tasks, concurrency) {
  const results = new Array(tasks.length);
  let i = 0;
  async function worker() {
    while (i < tasks.length) {
      const n = i++;
      try { results[n] = { ok: true, ...(await tasks[n]()) }; }
      catch (e) { results[n] = { ok: false, ms: 0, status: 'ERR', error: e.message }; }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

function summarize(name, results, expectOk = true) {
  const ok = results.filter((r) => r.ok && r.status >= 200 && r.status < 300);
  const ms = results.map((r) => r.ms).sort((a, b) => a - b);
  const q = (p) => ms[Math.min(ms.length - 1, Math.floor(p * ms.length))];
  const total = ms.reduce((s, v) => s + v, 0);
  console.log(`${name}: n=${results.length} ok=${ok.length} req/s=${(results.length / (total / 1000)).toFixed(0)} p50=${q(0.5).toFixed(1)}ms p95=${q(0.95).toFixed(1)}ms max=${q(1).toFixed(1)}ms`);
  if (expectOk && ok.length !== results.length) {
    failures += 1;
    console.log(`  ASSERT FAIL: ${results.length - ok.length} non-2xx`);
  }
  return { ok, results };
}

try {
  await wait(2500);

  // Setup: 1 asker + 12 verified doers.
  const asker = (await req('POST', '/api/v1/auth/register', { body: { name: 'Load', email: 'load@test.io', password: 'password123', city: 'Berlin' } })).json.token;
  const doers = [];
  for (let i = 0; i < 12; i++) {
    const r = await req('POST', '/api/v1/auth/register', { body: { name: 'D' + i, email: `d${i}@test.io`, password: 'password123', city: 'Berlin' } });
    await req('POST', '/api/v1/doers/profile', { token: r.json.token, body: { displayName: 'D' + i, city: 'Berlin' } });
    await req('POST', '/api/v1/doers/verify', { token: r.json.token });
    doers.push(r.json.token);
  }
  console.log('setup: 1 asker + 12 verified doers');

  // A. feed read throughput.
  summarize('A feed reads (c=20)', await pool(
    Array.from({ length: 400 }, () => () => req('GET', '/api/v1/jobs/feed?limit=20')), 20
  ));

  // B. job post throughput.
  let n = 0;
  const posted = summarize('B job posts (c=10)', await pool(
    Array.from({ length: 120 }, () => () => req('POST', '/api/v1/jobs', {
      token: asker,
      headers: undefined,
      body: { title: `Stress job number ${n++} needing coverage here`, category: 'place_check', city: 'Berlin', clientId: 'stress-' + n },
    })), 10
  ));

  // C. claim race: 12 doers pounce on ONE open job — exactly one wins.
  const raceJob = (await req('POST', '/api/v1/jobs', {
    token: asker, body: { title: 'Race target job for exactly-once proof', category: 'place_check', city: 'Berlin', clientId: 'race-1' },
  })).json.job.id;
  const race = await pool(doers.map((t) => () => req('POST', `/api/v1/jobs/${raceJob}/claim`, { token: t })), 12);
  const wins = race.filter((r) => r.ok && r.status === 200).length;
  const conflicts = race.filter((r) => r.status === 409).length;
  console.log(`C claim race: wins=${wins} conflicts=${conflicts}`);
  if (wins !== 1 || conflicts !== race.length - 1) { failures += 1; console.log('  ASSERT FAIL: claim was not exactly-once'); }

  // D. full lifecycle throughput (claim→deliver→approve across many jobs).
  const lifecycle = await pool(posted.ok.slice(0, 30).map((p, i) => async () => {
    const id = p.json.job.id;
    const t = doers[i % doers.length];
    const t0 = performance.now();
    const c = await req('POST', `/api/v1/jobs/${id}/claim`, { token: t });
    if (c.status !== 200) return { status: c.status, ms: performance.now() - t0 };
    const d = await req('POST', `/api/v1/jobs/${id}/deliver`, { token: t, body: { videoUrl: 'https://cdn.test/v.mp4' } });
    if (d.status !== 200) return { status: d.status, ms: performance.now() - t0 };
    const a = await req('POST', `/api/v1/jobs/${id}/approve`, { token: asker });
    return { status: a.status, ms: performance.now() - t0 };
  }), 5);
  summarize('D lifecycles paid (c=5)', lifecycle);
} finally {
  server.kill();
}
console.log(failures ? `\nSTRESS: ${failures} violated assertion(s)` : '\nSTRESS: all assertions held');
process.exit(failures ? 1 : 0);
