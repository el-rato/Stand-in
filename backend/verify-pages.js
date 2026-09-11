import fs from 'node:fs';

function checkPage(file, extraAnchors) {
  const html = fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const used = new Set([
    ...[...html.matchAll(/getElementById\("([^"]+)"/g)].map((m) => m[1]),
    ...[...html.matchAll(/\$\("#([A-Za-z]+)"/g)].map((m) => m[1]),
  ]);
  const missing = [...used].filter((u) => !ids.has(u));
  if (missing.length) { console.log(file + ' MISSING ids: ' + missing.join(', ')); process.exit(1); }
  const anchors = new Set([...html.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]).filter(Boolean));
  const dead = [...anchors].filter((a) => !ids.has(a));
  if (dead.length) { console.log(file + ' DEAD anchors: ' + dead.join(', ')); process.exit(1); }
  console.log(file + ' OK — ids:' + ids.size + ' refs:' + used.size + ' anchors:' + anchors.size);
}

checkPage('doer.html');
checkPage('orders.html');
checkPage('admin.html');
checkPage('index.html');

const index = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
for (const s of ['doer.html', 'orders.html', 'data-approve', 'navToggle', 'navMenu', 'remoteCache', 'loginForm']) {
  if (!index.includes(s)) { console.log('index.html missing: ' + s); process.exit(1); }
}
console.log('index.html wiring OK');
