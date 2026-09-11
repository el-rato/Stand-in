import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Faithful browser-sequence simulation: boots a FRESH dev server and replays
// exactly what index.html + api-bridge.js do on login.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'standin-repro-'));
const server = spawn('node', ['src/server.js'], {
  cwd: new URL('.', import.meta.url),
  env: { ...process.env, PORT: '3104', DATA_FILE: path.join(tmp, 'db.json'), JWT_SECRET: 'repro-secret', DATABASE_URL: '' },
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const B = 'http://localhost:3104';
let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (extra !== undefined ? ' → ' + extra : ''));
  if (!cond) failures += 1;
}

try {
  await wait(2500);

  // 1. What headers does the served page carry? (helmet CSP blocks CDNs?)
  const home = await fetch(B + '/');
  const csp = home.headers.get('content-security-policy');
  check('page served', home.ok);
  check('csp allows inline scripts', !!csp && csp.includes("'unsafe-inline'"), csp || '(none)');
  check('csp allows cdn scripts', !!csp && csp.includes('cdnjs.cloudflare.com'));
  check('csp allows network images', !!csp && csp.includes('img-src') && csp.includes('https:'));
  const homeText = await home.text();
  check('page pulls local css', homeText.includes('styles.css'));

  // 2. Bridge healthy() equivalent.
  const health = await fetch(B + '/health').then((r) => r.json());
  check('healthy', health.ok === true);

  // 3. Bridge register() equivalent (exact shape the form sends).
  const reg = await fetch(B + '/api/v1/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Repro', email: 'repro@test.io', password: 'password123', city: 'Berlin' }),
  });
  const regJson = await reg.json();
  check('register 201 + token + user', reg.status === 201 && !!regJson.token && regJson.user?.email === 'repro@test.io', reg.status);

  // 4. Bridge login() equivalent.
  const login = await fetch(B + '/api/v1/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'repro@test.io', password: 'password123' }),
  });
  const loginJson = await login.json();
  check('login 200 + token + user', login.status === 200 && !!loginJson.token && !!loginJson.user, login.status);
  const token = loginJson.token;

  // 5. Authenticated call the frontend makes right after (my jobs / mine).
  if (token) {
    const mine = await fetch(B + '/api/v1/jobs/mine', { headers: { Authorization: 'Bearer ' + token } });
    check('authed /jobs/mine', mine.status === 200, mine.status);
    const me = await fetch(B + '/api/v1/doers/me', { headers: { Authorization: 'Bearer ' + token } });
    check('authed /doers/me', me.status === 200, me.status);
  }
} finally {
  server.kill();
}
console.log(failures ? `REPRO: ${failures} failing step(s) — bug reproduced` : 'REPRO: backend contract fully green — bug is frontend-side');
process.exit(failures ? 1 : 0);
