#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const evidenceDir = path.join(root, 'evidence');
const receiptFiles = fs.readdirSync(evidenceDir)
  .filter((name) => /^aftership-s0-.*\.json$/.test(name))
  .map((name) => {
    const receipt = JSON.parse(fs.readFileSync(path.join(evidenceDir, name), 'utf8'));
    return { name, receipt };
  })
  .sort((a, b) => String(a.receipt.observed_at).localeCompare(String(b.receipt.observed_at)));

let consecutiveClean = 0;
for (const entry of [...receiptFiles].reverse()) {
  if (entry.receipt.overall !== 'PASS') break;
  consecutiveClean += 1;
}

const result = {
  receipt_count: receiptFiles.length,
  receipts: receiptFiles.map(({ name, receipt }) => ({
    file: name,
    observed_at: receipt.observed_at,
    overall: receipt.overall,
    failed_s0_count: receipt.failed_s0?.length ?? 0,
    failed_s1_count: receipt.failed_s1?.length ?? 0,
    unassigned_notification_owner_count: receipt.unassigned_notification_owners?.length ?? 0
  })),
  consecutive_clean_receipts: consecutiveClean,
  required_consecutive_clean_receipts: 2,
  clean_receipt_gate_satisfied: consecutiveClean >= 2,
  latest_status: receiptFiles.at(-1)?.receipt.overall ?? 'NO_RECEIPT',
  launch_decision: 'NO_AUTOMATIC_LAUNCH_AUTHORITY'
};
console.log(JSON.stringify(result, null, 2));
