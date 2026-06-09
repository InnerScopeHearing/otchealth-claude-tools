#!/usr/bin/env node
// track.mjs — grant/credit burn tracker. Flags grants that are expiring soon (so
// none lapse unused) and surfaces HOLD/declined ones (so none get instrumented by
// mistake). Run: node track.mjs [path/to/grants.json]
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const path = process.argv[2] || join(here, '..', 'grants.json');
const { grants } = JSON.parse(readFileSync(path, 'utf8'));

const now = new Date();
const daysLeft = (g) => {
  if (!g.added || !g.termMonths) return null;
  const exp = new Date(g.added);
  exp.setMonth(exp.getMonth() + g.termMonths);
  return Math.round((exp - now) / 86400000);
};

console.log(`\nGRANT / CREDIT TRACKER  (as of ${now.toISOString().slice(0, 10)})\n`);
const rows = grants.map((g) => ({ ...g, dleft: daysLeft(g) }));
for (const g of rows) {
  const exp = g.dleft == null ? '   n/a' : `${String(g.dleft).padStart(4)}d`;
  const tag = g.status === 'active' ? ' ' : g.status === 'hold' ? '~' : g.status === 'pending' ? '?' : 'x';
  console.log(`  [${tag}] ${g.name.padEnd(20)} ${String(g.value).padEnd(20)} expires ${exp}  ${g.lane}`);
}

const soon = rows.filter((g) => g.status === 'active' && g.dleft != null && g.dleft <= 60);
const idleHolds = rows.filter((g) => g.status === 'hold');
const declined = rows.filter((g) => g.status === 'declined');

console.log('\nFLAGS');
console.log(soon.length ? `  EXPIRING <=60d (use or lose): ${soon.map((g) => `${g.name} (${g.dleft}d)`).join(', ')}` : '  No active grant expires within 60 days.');
if (idleHolds.length) console.log(`  ON HOLD (decide before expiry): ${idleHolds.map((g) => `${g.name} (${g.dleft}d)`).join(', ')}`);
if (declined.length) console.log(`  DECLINED (do not instrument): ${declined.map((g) => g.name).join(', ')}`);
console.log(`\n  Active grants: ${rows.filter((g) => g.status === 'active').length} | total tracked: ${rows.length}\n`);
