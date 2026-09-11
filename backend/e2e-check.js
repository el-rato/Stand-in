import { spawn } from 'node:child_process';

const server = spawn('node', ['src/server.js'], { cwd: new URL('.', import.meta.url), env: { ...process.env, PORT: '3103' } });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const B = 'http://localhost:3103';

async function ready(retries = 30) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(B + '/health');
      if (r.ok) return;
    } catch {}
    await wait(500);
  }
  throw new Error('server never came up on ' + B);
}

try {
  await ready();
  const home = await fetch(B + '/');
  const homeText = await home.text();
  console.log('serves index: ' + (home.ok && homeText.includes('STANDIN')));
  console.log('index uses local css: ' + homeText.includes('styles.css'));
  const css = await fetch(B + '/styles.css');
  const cssText = await css.text();
  console.log('serves styles.css: ' + (css.ok && cssText.includes('.flex')));
  const blocked = await fetch(B + '/backend/src/app.js');
  console.log('blocks internals: ' + (blocked.status === 404));
  const doer = await fetch(B + '/doer.html');
  console.log('serves doer: ' + (doer.ok && (await doer.text()).includes('Doer HQ')));
  const feed = await fetch(B + '/api/v1/jobs/feed?limit=10').then((r) => r.json());
  console.log('seeded open jobs in feed: ' + feed.items.length);
} finally {
  server.kill();
}
