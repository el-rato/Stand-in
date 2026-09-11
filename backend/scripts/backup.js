// Daily-backup helper for the JSON store (local dev / single VPS).
// Copies data/db.json to a timestamped snapshot with rotation.
// Usage: node scripts/backup.js [--dir <dir>] [--keep 14]
// Schedule daily, e.g. Windows Task Scheduler:
//   schtasks /create /tn "StandinBackup" /tr "node C:\path\to\backend\scripts\backup.js" /sc daily /st 02:00
// or cron: 0 2 * * * /usr/bin/node /path/to/backend/scripts/backup.js
// Postgres (production): use the .github/workflows/daily-backup.yml pg_dump
// job plus your provider's point-in-time recovery instead of this script.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const dir = path.resolve(flag('--dir', path.join(here, '..', 'backups')));
const keep = Math.max(1, parseInt(flag('--keep', '14'), 10) || 14);
const src = path.resolve(config.dataFile);

if (!fs.existsSync(src)) {
  console.error(`[backup] nothing to back up — ${src} does not exist yet`);
  process.exit(1);
}
fs.mkdirSync(dir, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const dest = path.join(dir, `standin-db-${stamp}.json`);
fs.copyFileSync(src, dest);

// Rotation: keep the newest `keep` snapshots.
const snaps = fs.readdirSync(dir)
  .filter((f) => f.startsWith('standin-db-') && f.endsWith('.json'))
  .sort();
while (snaps.length > keep) {
  const old = snaps.shift();
  fs.unlinkSync(path.join(dir, old));
  console.log(`[backup] rotated out ${old}`);
}

const size = fs.statSync(dest).size;
console.log(`[backup] wrote ${dest} (${size} bytes, keeping ${keep})`);
console.log(`[backup] restore with: copy "${dest}" over ${src} while the server is stopped`);
