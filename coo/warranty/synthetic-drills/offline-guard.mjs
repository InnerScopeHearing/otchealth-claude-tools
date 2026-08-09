#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const sourceFiles = ['run-drills.mjs', 'drills.test.mjs', 'render-evidence.mjs'];
const banned = [
  /\bfetch\s*\(/,
  /https?:\/\//,
  /node:(?:http|https|net|tls|dgram|dns|child_process)/,
  /\b(?:axios|got|request|curl|wget)\b/,
  /(?:AFTERSHIP_API_KEY|SHOPIFY_ACCESS_TOKEN|INTERCOM_ACCESS_TOKEN|TWILIO_AUTH_TOKEN|SENDGRID_API_KEY)/
];
const findings = [];
for (const file of sourceFiles) {
  const text = fs.readFileSync(path.join(root, file), 'utf8');
  for (const pattern of banned) {
    if (pattern.test(text)) findings.push({ file, pattern: String(pattern) });
  }
}
const fixtures = JSON.parse(fs.readFileSync(path.join(root, 'fixtures.json'), 'utf8'));
const falseRequired = [
  'real_customer_data',
  'network_calls_permitted',
  'customer_contact_permitted',
  'provider_calls_permitted',
  'canonical_state_mutation_permitted',
  'authorization_consumption_permitted',
  'operational_gate_closure_permitted'
];
for (const key of falseRequired) {
  if (fixtures.controls[key] !== false) findings.push({ file: 'fixtures.json', control: key, value: fixtures.controls[key] });
}
if (findings.length) {
  console.error(JSON.stringify({ status: 'FAIL', findings }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ status: 'PASS', scanned_files: [...sourceFiles, 'fixtures.json'], banned_patterns: banned.length, authority_floor_verified: falseRequired.length }, null, 2));
