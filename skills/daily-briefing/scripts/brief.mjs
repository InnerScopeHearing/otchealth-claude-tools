#!/usr/bin/env node
// brief.mjs — assemble the one daily briefing a solo operator needs: the cash
// number, the top levers, and the credit flags. Reads a cash.manifest (defaults to
// the example until a live one exists) + the grant tracker.
// Run: node brief.mjs [path/to/cash.manifest.json]
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const cashPath = process.argv[2] || join(repo, 'dream-team', 'schemas', 'cash.manifest.example.json');
const m = JSON.parse(readFileSync(cashPath, 'utf8'));

const usd = (n) => '$' + (n || 0).toLocaleString();
const today = new Date().toISOString().slice(0, 10);

console.log(`\n=== OTCHealth DAILY BRIEFING — ${today} ===`);
console.log(`North star: ${m.northStar.goal}`);
const s = m.scoreboard || {};
console.log(`\nSCOREBOARD`);
console.log(`  Cash in bank: ${usd(s.cashInBankUSD)} | Revenue MTD: ${usd(s.revenueMTDUSD)} | last 7d: ${usd(s.revenueLast7dUSD)}`);
console.log(`  Burn/mo: ${usd(s.monthlyBurnUSD)} | Runway: ${s.runwayMonths ?? '?'} mo`);
for (const t of m.triggers || []) console.log(`  Trigger ${t.name}: ${t.progress} (${t.condition})`);

const order = { live: 0, building: 1, blocked: 2, idle: 3, done: 4 };
const levers = [...(m.levers || [])].sort((a, b) => (a.timeToCashDays || 999) - (b.timeToCashDays || 999));
console.log(`\nTOP CASH LEVERS (by time-to-cash)`);
for (const l of levers.slice(0, 5)) {
  console.log(`  [${(l.status || '?').padEnd(8)}] ~${String(l.timeToCashDays ?? '?').padStart(3)}d  ${l.name}`);
  console.log(`            owner: ${l.owner} | pipeline ${usd(l.pipelineUSD)} | realized ${usd(l.realizedUSD)}`);
  if (l.blocker) console.log(`            blocker: ${l.blocker}`);
  if (l.complianceGate && l.complianceGate !== 'na') console.log(`            compliance: ${l.complianceGate}`);
}

// fold in the grant flags
try {
  const { grants } = JSON.parse(readFileSync(join(repo, 'skills', 'grant-tracker', 'grants.json'), 'utf8'));
  const now = new Date();
  const dleft = (g) => { const e = new Date(g.added); e.setMonth(e.getMonth() + (g.termMonths || 0)); return Math.round((e - now) / 86400000); };
  const soon = grants.filter((g) => g.status === 'active' && dleft(g) <= 60);
  console.log(`\nCREDITS`);
  console.log(`  Active grants: ${grants.filter((g) => g.status === 'active').length}` + (soon.length ? ` | EXPIRING <=60d: ${soon.map((g) => g.name).join(', ')}` : ' | none expiring <=60d'));
} catch { /* grants optional */ }

console.log(`\nNEXT: pull the highest-velocity unblocked lever. Human unlocks gate the big pool (FDA registration + Stripe).`);
console.log(`(cash source: ${cashPath.replace(repo + '/', '')})\n`);
