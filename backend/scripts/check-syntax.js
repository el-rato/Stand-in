// Syntax-gate for every inline <script> in the product pages.
// Catches the class of bug no DOM checker sees: a single stray brace that
// silently kills all interactivity. Usage: npm run syntax
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pages = ['index.html', 'doer.html', 'orders.html', 'admin.html'];
let bad = 0;

for (const page of pages) {
  const html = fs.readFileSync(path.join(here, '..', '..', page), 'utf8');
  const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
  if (!blocks.length) { console.log(`SKIP ${page} (no inline scripts)`); continue; }
  blocks.forEach((m, i) => {
    try {
      new vm.Script(m[1], { filename: `${page}#${i}` });
      console.log(`OK   ${page}#${i} (${m[1].length} chars)`);
    } catch (e) {
      bad += 1;
      console.log(`FAIL ${page}#${i}: ${e.message}`);
    }
  });
}
console.log(bad ? `[syntax] ${bad} broken block(s)` : '[syntax] all inline scripts parse');
process.exitCode = bad ? 1 : 0;
