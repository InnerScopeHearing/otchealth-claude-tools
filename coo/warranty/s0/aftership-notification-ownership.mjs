#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const expectedPath = path.resolve(process.argv[2] ?? path.join(root, 'aftership-expected.json'));
const outputPath = path.resolve(process.argv[3] ?? path.join(root, 'evidence', 'notification-ownership-2026-08-08.json'));
const expected = JSON.parse(fs.readFileSync(expectedPath, 'utf8'));
const owners = expected.notification_ownership;
const controls = expected.notification_controls;

const exact = {
  daily_s0_monitor_owner: 'CRO',
  daily_s0_monitor_backup: 'CTO via independent notification channel',
  ordinary_transactional_content_owner: 'COO/Care',
  ordinary_transactional_release_owner: 'COO',
  adverse_or_rejection_release_owner: 'Matt only via two independent notification channels; CLO reviews; no agent decision',
  safety_or_recall_release_owner: 'Matt only via two independent notification channels; COO+CLO monitor/escalate; no agent closure',
  wrong_recipient_incident_owner: 'CTO/Security; notify Matt via two independent notification channels'
};

const checks = [];
function check(id, pass, observed, required) {
  checks.push({ id, pass: Boolean(pass), observed, required });
}
for (const [key, required] of Object.entries(exact)) {
  check(`OWNER_${key.toUpperCase()}`, owners[key] === required, owners[key], required);
}
check('NO_UNASSIGNED_ROLE', !Object.values(exact).some((value) => /UNASSIGNED/i.test(value)) && !Object.keys(exact).some((key) => /UNASSIGNED/i.test(String(owners[key]))), exact, 'all seven assigned');
check('SOLO_OPERATOR_CORRECTION', controls.solo_operator_correction_ref === 'cro__20260724-012-a418', controls.solo_operator_correction_ref, 'cro__20260724-012-a418');
check('ONLY_HUMAN_IS_MATT', controls.only_human_authority === 'Matt', controls.only_human_authority, 'Matt');
check('BACKUP_IS_CHANNEL_NOT_EMPLOYEE', /independent notification channel.*not another employee/i.test(controls.backup_definition), controls.backup_definition, 'independent channel/monitor, not employee');
check('TWO_CHANNEL_MINIMUM', controls.minimum_independent_channels_for_matt_alert === 2, controls.minimum_independent_channels_for_matt_alert, 2);
check('OUTBOUND_DISABLED', controls.outbound_notifications_enabled === false, controls.outbound_notifications_enabled, false);
check('COPY_RECIPIENT_TESTS_REQUIRED', Array.isArray(controls.outbound_unlock_requires) && controls.outbound_unlock_requires.length >= 4, controls.outbound_unlock_requires, 'copy, recipient, dedupe/suppression and release checks');
check('NO_AGENT_ADVERSE_SAFETY_DECISION', controls.agents_may_make_adverse_or_safety_decision === false, controls.agents_may_make_adverse_or_safety_decision, false);
check('NO_AGENT_SAFETY_RECALL_CLOSURE', controls.agents_may_close_safety_or_recall === false, controls.agents_may_close_safety_or_recall, false);
check('SUBSTANTIVE_GATES_STAY_OPEN', controls.substantive_safety_legal_staffing_gates_closed === false, controls.substantive_safety_legal_staffing_gates_closed, false);

const failed = checks.filter((item) => !item.pass);
const report = {
  report_type: 'aftership_notification_ownership_only',
  evaluated_at: new Date().toISOString(),
  source_ref: controls.solo_operator_correction_ref,
  runtime_probe_performed: false,
  public_domain_readback_performed: false,
  outbound_notifications_sent: 0,
  configuration_writes: 0,
  roles_assigned: Object.keys(exact).length,
  role_registry: Object.fromEntries(Object.keys(exact).map((key) => [key, owners[key]])),
  controls,
  checks,
  passed: checks.length - failed.length,
  failed: failed.length,
  status: failed.length ? 'FAIL' : 'PASS_OWNERSHIP_ONLY',
  substantive_safety_legal_staffing_gates_closed: false,
  outbound_notifications_enabled: false
};
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({
  status: report.status,
  roles_assigned: report.roles_assigned,
  checks_passed: report.passed,
  checks_failed: report.failed,
  outbound_notifications_enabled: report.outbound_notifications_enabled,
  substantive_gates_closed: report.substantive_safety_legal_staffing_gates_closed,
  output: outputPath
}, null, 2));
if (failed.length) process.exit(1);
