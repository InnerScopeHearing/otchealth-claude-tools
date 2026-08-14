#!/usr/bin/env node
/**
 * xero-census — size the phantom-duplicate population across orgs and a full year WITHOUT the
 * caller paging millions of bytes.
 *
 * WHY: the 2026-08-14 CFO census of ONE month (HearingAssist Dec-2022 ACCPAY) found 113 objects
 * representing 25 distinct bills, i.e. 49 phantom duplicates, 13 bills existing as FOUR objects
 * each. Establishing that required reading every object by hand, which is why only one month had
 * been censused. This walks the population server-side and emits ONLY the grouping:
 *
 *     (Reference, count, [objectIDs], [statuses], [UpdatedDateUTC])
 *
 * READ-ONLY. This tool never writes, voids, or deletes anything. Removal runs under the CFO's own
 * control (reverse, never void) and is deliberately not implemented here.
 *
 * USAGE
 *   node census.mjs --org hearingassist --type ACCPAY --from 2022-01-01 --to 2022-12-31
 *   node census.mjs --org innd --collection CreditNotes --type ACCPAYCREDIT --from 2022-01-01 --to 2022-12-31
 *   node census.mjs --org hearingassist --from 2022-01-01 --to 2022-12-31 --out census-ha-2022.json
 *
 *   --org         hearingassist | innd | otchealth | personal   (required)
 *   --collection  Invoices (default) | BankTransactions | CreditNotes | ManualJournals
 *   --type        Xero Type filter, e.g. ACCPAY / ACCPAYCREDIT   (optional)
 *   --from/--to   inclusive date bounds, YYYY-MM-DD              (optional but recommended)
 *   --min-count   only report references with at least N objects (default 2 = duplicates only)
 *   --all         report every reference, not just duplicates    (same as --min-count 1)
 *   --out         write full JSON here; stdout always gets the summary
 *
 * Auth goes through the gateway's cfo lane (the gateway is the sole Xero consumer since the
 * 2026-07-16 guardGatewayOwnedOrg hardening), so this needs no Xero token of its own.
 */
import { mintToken } from '../gateway-connect/connect.mjs';
import fs from 'node:fs';

const argv = process.argv.slice(2);
const arg = (name, dflt = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : (argv.includes(`--${name}`) ? true : dflt);
};

const ORG = arg('org');
const COLLECTION = arg('collection', 'Invoices');
const TYPE = arg('type', null);
const FROM = arg('from', null);
const TO = arg('to', null);
const OUT = arg('out', null);
const MIN_COUNT = arg('all') ? 1 : parseInt(arg('min-count', '2'), 10);

if (!ORG) {
  console.error('usage: node census.mjs --org <org> [--collection Invoices] [--type ACCPAY] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--min-count 2] [--out file.json]');
  process.exit(2);
}

const ID_FIELD = {
  Invoices: 'InvoiceID',
  BankTransactions: 'BankTransactionID',
  CreditNotes: 'CreditNoteID',
  ManualJournals: 'ManualJournalID',
}[COLLECTION];
if (!ID_FIELD) { console.error(`unsupported --collection ${COLLECTION}`); process.exit(2); }

/** Xero's `where` predicate. Dates use its DateTime(y,m,d) literal form. */
function buildWhere() {
  const parts = [];
  if (TYPE) parts.push(`Type=="${TYPE}"`);
  const d = (s) => { const [y, m, dd] = s.split('-').map(Number); return `DateTime(${y},${m},${dd})`; };
  if (FROM) parts.push(`Date>=${d(FROM)}`);
  if (TO) parts.push(`Date<=${d(TO)}`);
  return parts.join(' && ');
}

async function gateway(token, tool, args) {
  const r = await fetch('https://mcp.otchealth.app/mcp', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name: tool, arguments: args } }),
  });
  const text = (await r.text()).replace(/^event:.*$/gm, '').replace(/^data: /gm, '').trim();
  const last = text.split('\n').filter(Boolean).pop() || '{}';
  const j = JSON.parse(last);
  if (j.error) throw new Error(`${tool}: ${JSON.stringify(j.error).slice(0, 300)}`);
  return j.result?.structuredContent?.result ?? j.result?.structuredContent ?? {};
}

(async () => {
  const token = await mintToken('cfo');
  const where = buildWhere();
  console.log(`xero-census | org=${ORG} collection=${COLLECTION}${TYPE ? ` type=${TYPE}` : ''} ${FROM || ''}..${TO || ''}`);
  if (where) console.log(`  where: ${where}`);

  // Page until Xero stops returning a full page. Xero's accounting list pages are 100 objects.
  const rows = [];
  for (let page = 1; ; page++) {
    const res = await gateway(token, 'xero_get', {
      org: ORG, path: `/${COLLECTION}`, params: { ...(where ? { where } : {}), page: String(page) },
    });
    const body = res.body ?? res;
    const arr = Object.values(body || {}).find((v) => Array.isArray(v)) || [];
    for (const o of arr) {
      rows.push({
        ref: String(o.Reference ?? o.InvoiceNumber ?? o.CreditNoteNumber ?? '(no-reference)'),
        id: String(o[ID_FIELD] ?? ''),
        status: String(o.Status ?? ''),
        updated: String(o.UpdatedDateUTC ?? ''),
        contact: String(o.Contact?.Name ?? ''),
        total: o.Total ?? null,
      });
    }
    process.stdout.write(`\r  page ${page}: ${rows.length} objects read`);
    if (arr.length < 100) break;
  }
  process.stdout.write('\n');

  const byRef = new Map();
  for (const r of rows) {
    if (!byRef.has(r.ref)) byRef.set(r.ref, []);
    byRef.get(r.ref).push(r);
  }
  const groups = [...byRef.entries()]
    .map(([reference, objs]) => ({
      reference,
      count: objs.length,
      contact: objs[0].contact,
      total: objs[0].total,
      objectIDs: objs.map((o) => o.id),
      statuses: objs.map((o) => o.status),
      updatedDateUTC: objs.map((o) => o.updated),
      // Distinct write waves: the census's key tell was two UpdatedDateUTC clusters per group.
      writeDays: [...new Set(objs.map((o) => o.updated.slice(0, 10)).filter(Boolean))].sort(),
    }))
    .filter((g) => g.count >= MIN_COUNT)
    .sort((a, b) => b.count - a.count);

  const phantom = groups.reduce((n, g) => n + (g.count - 1), 0);
  console.log(`\n  objects read        : ${rows.length}`);
  console.log(`  distinct references : ${byRef.size}`);
  console.log(`  groups >= ${MIN_COUNT}        : ${groups.length}`);
  console.log(`  PHANTOM DUPLICATES  : ${phantom}  (objects beyond the first in each group)`);
  const waves = new Set(groups.flatMap((g) => g.writeDays));
  console.log(`  write days observed : ${[...waves].sort().join(', ') || '(none)'}`);
  console.log('\n  worst groups:');
  for (const g of groups.slice(0, 15)) {
    console.log(`    ${String(g.count).padStart(2)}x  ${g.reference.padEnd(22)} ${String(g.total ?? '').padStart(12)}  ${g.contact.slice(0, 28).padEnd(28)} waves=${g.writeDays.join(',')}`);
  }
  if (OUT) { fs.writeFileSync(OUT, JSON.stringify({ org: ORG, collection: COLLECTION, type: TYPE, from: FROM, to: TO, where, objectsRead: rows.length, distinctReferences: byRef.size, phantomDuplicates: phantom, groups }, null, 2)); console.log(`\n  full grouping written to ${OUT}`); }
})().catch((e) => { console.error('census failed:', e.message); process.exit(1); });
