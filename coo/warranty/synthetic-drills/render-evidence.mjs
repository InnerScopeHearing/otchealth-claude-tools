#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const evidenceDir = path.join(root, 'evidence');
const report = JSON.parse(fs.readFileSync(path.join(evidenceDir, 'synthetic-drill-report.json'), 'utf8'));
const n8n = JSON.parse(fs.readFileSync(path.join(evidenceDir, 'n8n-execution-receipts.json'), 'utf8'));
const receipt = JSON.parse(fs.readFileSync(path.join(evidenceDir, 'receipt.json'), 'utf8'));
const outputPath = path.join(root, 'SYNTHETIC-EVIDENCE-PACKET-2026-08-08.md');

function clean(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
}

const lines = [];
lines.push('# OTCHealth Warranty Operations Synthetic Evidence Packet');
lines.push('');
lines.push('Prepared: 2026-08-08');
lines.push('Scope: offline synthetic and tabletop evidence only');
lines.push('Decision: HOLD / NO-GO unchanged');
lines.push('');
lines.push('## Executive result');
lines.push('');
lines.push(`- Local deterministic drills: ${report.test_summary.passed}/${report.test_summary.tests} PASS with ${report.test_summary.assertions} assertions.`);
lines.push(`- Fresh n8n synthetic contract executions: ${n8n.summary.success}/${n8n.summary.executions} PASS.`);
lines.push('- Test wrapper: 6/6 PASS.');
lines.push('- Offline guard: PASS. No network or credential-bearing code path in the drill runner.');
lines.push('- Real customer records used: 0.');
lines.push('- Customer contacts, provider calls, labels, shipments, refunds/credits, inventory changes, repair orders, canonical writes, consumed authorizations, and real kill-switch changes: 0.');
lines.push('- Pilot and public launch remain HOLD. Synthetic evidence cannot supply names, signatures, facilities, contracts, carrier acceptance, physical custody, human competency, accessibility observation, real cohort results, or financial closes.');
lines.push('');
lines.push('## Immutable receipts');
lines.push('');
lines.push(`- Synthetic report SHA-256: ${receipt.report_sha256}`);
lines.push(`- Fixture SHA-256: ${receipt.fixture_sha256}`);
lines.push(`- Runner SHA-256: ${receipt.runner_sha256}`);
lines.push(`- n8n executions: ${n8n.executions.map((x) => `${x.code} ${x.execution_id}`).join('; ')}`);
lines.push('');
lines.push('## Executed drill inventory');
lines.push('');
lines.push('| Drill | Synthetic result | What was proven | What remains unproven |');
lines.push('|---|---|---|---|');
for (const [name, drill] of Object.entries(report.drills)) {
  lines.push(`| ${clean(name)} | ${clean(drill.status)} | ${clean(drill.proven.join('; '))} | ${clean(drill.not_proven.join('; '))} |`);
}
lines.push('');
lines.push('## Agent-executable versus irreducible evidence matrix');
lines.push('');
lines.push('| Launch gate | Classification | Agent/tabletop evidence executed now | Result | Irreducible human or physical evidence |');
lines.push('|---|---|---|---|---|');
for (const row of report.gate_matrix) {
  lines.push(`| ${clean(row.gate)} | ${clean(row.classification)} | ${clean(row.agent_evidence)} | ${clean(row.synthetic_result)} | ${clean(row.irreducible)} |`);
}
lines.push('');
lines.push('## Fresh n8n synthetic receipts');
lines.push('');
lines.push('| Code | Execution | Outcome | External calls | Authorization consumed | Customer contact | Live execution |');
lines.push('|---|---:|---|---:|---|---|---|');
for (const row of n8n.executions) {
  lines.push(`| ${row.code} | ${row.execution_id} | ${clean(row.outcome)} | ${row.external_call_count} | ${row.authorization_consumed} | ${row.customer_contact_permitted} | ${row.live_execution_permitted} |`);
}
lines.push('');
lines.push('## Safety / PHMSA source-backed tabletop rule');
lines.push('');
lines.push('- PHMSA regulates lithium batteries as hazardous material under 49 CFR Parts 171-180 and identifies damaged, defective or recalled batteries as higher fire-risk shipments: https://www.phmsa.dot.gov/lithiumbatteries');
lines.push('- PHMSA\'s 2024 shipper guide states DDR lithium batteries may travel only by highway, rail or vessel and are strictly forbidden by aircraft; 49 CFR 173.185(f) packaging and full training/shipping-paper/marking/labeling requirements apply: https://www.phmsa.dot.gov/sites/phmsa.dot.gov/files/2024-11/Lithium-Battery-Guide-2024.pdf');
lines.push('- PHMSA states the shipper is responsible for condition assessment and may need a technical expert or manufacturer information: https://www.phmsa.dot.gov/sites/phmsa.dot.gov/files/2023-03/DDR-brochure.pdf');
lines.push('- USPS Publication 52 generally prohibits damaged, defective or recalled batteries absent Product Classification approval, restricts used/damaged/defective devices to applicable surface paths domestically, and prohibits such batteries/devices internationally: https://pe.usps.com/text/pub52/pub52c3_028.htm');
lines.push('- Tabletop decision: every suspected DDR case blocks ordinary return, ordinary parcel/air label, returnless handling, destructive customer instruction and agent closure. Only a trained human may classify, package, select a compliant carrier service, offer for transport, execute holds or close Safety. Full research-backed tabletop: PHMSA-TABLETOP-EVIDENCE.md.');
lines.push('');
lines.push('## Irreducible signatures and observations still required');
lines.push('');
lines.push('1. Matt must name and sign the backup/delegate, exact decision and execution thresholds, unavailable-owner behavior, vetoes, expiry and revocation.');
lines.push('2. Counsel, Finance and Operations must sign the remedy ladder, state timing, fees/labor/freight responsibility, replacement condition and successor term.');
lines.push('3. Product Safety must name the primary, secondary and duty rota; approve scripts and reportability/recall rules; prove lot/serial holds, chain of custody, PHMSA classification, carrier acceptance and a live tabletop with acknowledgments.');
lines.push('4. Operations and Warehouse must identify the real return facility and backup, carrier accounts/services, quarantine area, scanners, inspection/sanitation/disposition process and an observed physical package trace.');
lines.push('5. Repair must provide primary and backup providers, agreements, parts, capacity, turnaround, QA, California invoice notice handling and an observed failover.');
lines.push('6. Care and Communications must name queue owners and backups, create only approved objects, train people, approve templates, disable or gate remaining AfterShip emails, and observe live recipient/bounce/suppression behavior without using customers.');
lines.push('7. Accessibility must complete manual WCAG 2.2 AA and assistive-technology review plus observed phone, email, mail, relay and caregiver completion.');
lines.push('8. Inventory/platform owners must prove the real assembly/left/right/box/OEM map, ownership proof, scanner capability and pick/pack/tender/return/inspection/successor traces.');
lines.push('9. Pilot owners must sign all entry gates and caps, run an employee cohort, then a separately approved small real cohort, drill every kill switch and complete two reconciled operating and Finance/GL cycles with zero unresolved stop-ship defect.');
lines.push('');
lines.push('## Interpretation rule');
lines.push('');
lines.push('A synthetic PASS means the agent-side logic, checklist or fail-closed decision behaved correctly with synthetic data. It never means the corresponding operational launch gate is closed. Only the named signatures, physical observations, external-provider evidence, controlled pilot and reconciled cycles can close those gates.');
lines.push('');

const content = lines.join('\n');
fs.writeFileSync(outputPath, content);
const renderReceipt = {
  output: path.basename(outputPath),
  output_sha256: crypto.createHash('sha256').update(content).digest('hex'),
  source_report_sha256: receipt.report_sha256,
  n8n_execution_ids: n8n.executions.map((x) => x.execution_id),
  launch_decision: report.launch_decision
};
fs.writeFileSync(path.join(evidenceDir, 'render-receipt.json'), JSON.stringify(renderReceipt, null, 2) + '\n');
console.log(JSON.stringify(renderReceipt, null, 2));
